import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const importRouter = Router();
importRouter.use(requireAuth);

// Minimal CSV parser (handles quoted fields and commas inside quotes).
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

/**
 * Bulk-import metric records from a CSV.
 *
 * Expected columns (header row, case-insensitive):
 *   athleteEmail | athleteId  (one is required to match the athlete)
 *   metricKey                 (must exist in the metric catalog)
 *   value                     (number)
 *   recordedAt                (optional ISO date)
 *   source                    (optional; defaults to CSV)
 *
 * Body: raw CSV text (Content-Type: text/csv or text/plain).
 */
importRouter.post(
  "/metrics-csv",
  requireRole("ADMIN", "COACH"),
  async (req: AuthedRequest, res) => {
    const csv = typeof req.body === "string" ? req.body : req.body?.csv;
    if (!csv || typeof csv !== "string") {
      return res.status(400).json({ error: "Send raw CSV text or { csv: \"...\" }" });
    }

    const rows = parseCsv(csv);
    const orgId = req.auth!.orgId;
    const metricTypes = await prisma.metricType.findMany();
    const byKey = new Map(metricTypes.map((m) => [m.key.toLowerCase(), m]));

    const errors: { row: number; reason: string }[] = [];
    const toCreate: { athleteId: string; metricTypeId: string; value: number; recordedAt: Date; source: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = lowerKeys(rows[i]);
      const mt = byKey.get((r.metrickey || "").toLowerCase());
      if (!mt) { errors.push({ row: i + 2, reason: `Unknown metricKey "${r.metrickey}"` }); continue; }

      let athlete = null;
      if (r.athleteid) {
        athlete = await prisma.athlete.findUnique({ where: { id: r.athleteid } });
      } else if (r.athleteemail) {
        const u = await prisma.user.findUnique({ where: { email: r.athleteemail }, include: { athlete: true } });
        athlete = u?.athlete ?? null;
      }
      if (!athlete || athlete.orgId !== orgId) {
        errors.push({ row: i + 2, reason: "Athlete not found in your org" });
        continue;
      }

      const value = Number(r.value);
      if (Number.isNaN(value)) { errors.push({ row: i + 2, reason: `Invalid value "${r.value}"` }); continue; }

      toCreate.push({
        athleteId: athlete.id,
        metricTypeId: mt.id,
        value,
        recordedAt: r.recordedat ? new Date(r.recordedat) : new Date(),
        source: (r.source || "CSV").toUpperCase(),
      });
    }

    if (toCreate.length) await prisma.metricRecord.createMany({ data: toCreate });
    res.json({ imported: toCreate.length, failed: errors.length, errors });
  }
);

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

// ---------------------------------------------------------------------------
// VBT session import (GymAware app CSV export, cloud subscription not needed).
// Header names vary across app versions, so columns are auto-detected from
// aliases and the caller can dry-run (?dryRun=1) to preview matching before
// anything is written. Writes: a completed imported session per athlete+day
// (set logs incl. mean/peak velocity), and — when a session contains 2+
// distinct loads for a lift — a refreshed load-velocity e1RM profile (with a
// PR feed post if it beats the athlete's prior best).
// ---------------------------------------------------------------------------
import { pureDate, today, tzOffsetFromReq } from "../daytime";
import { e1rmFromLoadVelocity, mvtForExercise } from "../prescription";
import { maybeE1rmPR } from "../feed";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_ALIASES: Record<string, string[]> = {
  athlete: ["athlete", "athletename", "name", "user", "lifter"],
  exercise: ["exercise", "movement", "lift", "exercisename"],
  date: ["date", "sessiondate", "day", "timestamp", "datetime", "time"],
  set: ["set", "setnumber", "setno", "setidx"],
  rep: ["rep", "repnumber", "repno"],
  reps: ["reps", "repcount", "totalreps"],
  loadKg: ["load", "loadkg", "weight", "weightkg", "kg", "mass", "masskg"],
  loadLb: ["loadlb", "loadlbs", "weightlb", "weightlbs", "lb", "lbs", "pounds"],
  meanVelocity: ["meanvelocity", "meanvelocityms", "avgvelocity", "averagevelocity", "mv", "meanvel", "velocity", "velocityms", "meanconvelocity", "meanconcentricvelocity"],
  peakVelocity: ["peakvelocity", "peakvelocityms", "pv", "peakvel", "maxvelocity"],
};

function detectColumns(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const n = norm(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (!map[field] && aliases.includes(n)) map[field] = h;
    }
  }
  return map;
}

// "2026-07-06", "7/6/2026", "07/06/26", or a full timestamp → yyyy-mm-dd.
function parseDay(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const s = raw.trim();
  // (plain test, not the isDayString guard — its `is string` narrowing would
  // make the false branch `never`)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const yyyy = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${yyyy}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return fallback;
}

interface ImportedSet {
  setNumber: number;
  reps: number | null;
  loadKg: number | null;
  velocity: number | null;      // mean of the set's rep mean-velocities
  peakVelocity: number | null;  // max across the set
  repRows: number;
}

importRouter.post("/vbt-csv", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const csv = typeof req.body === "string" ? req.body : req.body?.csv;
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ error: 'Send raw CSV text or { csv: "..." }' });
  }
  const dryRun = req.query.dryRun === "1";
  const forcedAthleteId = req.query.athleteId ? String(req.query.athleteId) : null;
  const defaultDay = today(tzOffsetFromReq(req));

  const rows = parseCsv(csv);
  if (rows.length === 0) return res.status(400).json({ error: "CSV has no data rows" });
  const cols = detectColumns(Object.keys(rows[0]));
  if (!cols.exercise || (!cols.meanVelocity && !cols.loadKg && !cols.loadLb)) {
    return res.status(400).json({
      error: "Could not detect required columns (need at least exercise + load or velocity)",
      detected: cols,
      headers: Object.keys(rows[0]),
    });
  }

  // Roster lookup: "first last" and "last, first", case-insensitive.
  const roster = await prisma.athlete.findMany({ where: { orgId: req.auth!.orgId } });
  const byName = new Map<string, (typeof roster)[number]>();
  for (const a of roster) {
    byName.set(`${a.firstName} ${a.lastName}`.toLowerCase(), a);
    byName.set(`${a.lastName}, ${a.firstName}`.toLowerCase(), a);
  }
  const forced = forcedAthleteId ? roster.find((a) => a.id === forcedAthleteId) : null;
  if (forcedAthleteId && !forced) return res.status(404).json({ error: "athleteId not found in your org" });

  const skipped: { row: number; reason: string }[] = [];
  // athleteId → day → exercise name (as written) → setNumber → accumulating set
  const grouped = new Map<string, Map<string, Map<string, Map<number, ImportedSet>>>>();
  const athleteById = new Map(roster.map((a) => [a.id, a]));

  rows.forEach((r, i) => {
    const rowNo = i + 2; // 1-based + header
    const athlete = forced ?? (cols.athlete ? byName.get((r[cols.athlete] || "").toLowerCase()) : undefined);
    if (!athlete) {
      skipped.push({ row: rowNo, reason: cols.athlete ? `Unknown athlete "${r[cols.athlete]}"` : "No athlete column — pass ?athleteId= to assign all rows" });
      return;
    }
    const exercise = (r[cols.exercise] || "").trim();
    if (!exercise) { skipped.push({ row: rowNo, reason: "Missing exercise" }); return; }

    const day = parseDay(cols.date ? r[cols.date] : undefined, defaultDay);
    const setNumber = cols.set && r[cols.set] !== "" ? Number(r[cols.set]) : 1;
    if (!Number.isFinite(setNumber) || setNumber < 1) { skipped.push({ row: rowNo, reason: `Bad set number "${r[cols.set]}"` }); return; }

    let loadKg: number | null = null;
    if (cols.loadKg && r[cols.loadKg] !== "") loadKg = Number(r[cols.loadKg]);
    else if (cols.loadLb && r[cols.loadLb] !== "") loadKg = Number(r[cols.loadLb]) * 0.45359237;
    if (loadKg != null && !Number.isFinite(loadKg)) loadKg = null;
    if (loadKg != null) loadKg = Math.round(loadKg * 100) / 100;

    const mv = cols.meanVelocity && r[cols.meanVelocity] !== "" ? Number(r[cols.meanVelocity]) : null;
    const pv = cols.peakVelocity && r[cols.peakVelocity] !== "" ? Number(r[cols.peakVelocity]) : null;
    const repsExplicit = cols.reps && r[cols.reps] !== "" ? Number(r[cols.reps]) : null;

    const perAthlete = grouped.get(athlete.id) ?? new Map();
    grouped.set(athlete.id, perAthlete);
    const perDay = perAthlete.get(day) ?? new Map();
    perAthlete.set(day, perDay);
    const perEx = perDay.get(exercise) ?? new Map();
    perDay.set(exercise, perEx);
    const set = perEx.get(setNumber) ?? { setNumber, reps: null, loadKg: null, velocity: null, peakVelocity: null, repRows: 0 };

    // Per-rep rows aggregate into the set; per-set rows pass through.
    set.repRows += 1;
    if (loadKg != null) set.loadKg = loadKg;
    if (repsExplicit != null && Number.isFinite(repsExplicit)) set.reps = repsExplicit;
    else if (cols.rep) set.reps = set.repRows;
    if (mv != null && Number.isFinite(mv)) {
      set.velocity = set.velocity == null ? mv : (set.velocity * (set.repRows - 1) + mv) / set.repRows;
    }
    if (pv != null && Number.isFinite(pv)) set.peakVelocity = Math.max(set.peakVelocity ?? 0, pv);
    perEx.set(setNumber, set);
  });

  // Preview payload (also returned after a real import).
  const sessions = [...grouped.entries()].map(([athleteId, perDay]) => {
    const a = athleteById.get(athleteId)!;
    return [...perDay.entries()].map(([day, perEx]) => ({
      athleteId,
      athlete: `${a.firstName} ${a.lastName}`,
      date: day,
      exercises: [...perEx.entries()].map(([name, sets]) => ({
        exercise: name,
        sets: [...sets.values()].sort((x, y) => x.setNumber - y.setNumber),
      })),
    }));
  }).flat();

  if (dryRun) {
    return res.json({ dryRun: true, detected: cols, sessions, skipped, wouldImportSets: sessions.reduce((n, s) => n + s.exercises.reduce((m, e) => m + e.sets.length, 0), 0) });
  }

  // Resolve or create exercises by name (org-scoped, case-insensitive).
  const orgExercises = await prisma.exercise.findMany({ where: { orgId: req.auth!.orgId } });
  const exByName = new Map(orgExercises.map((e) => [e.name.toLowerCase(), e]));
  async function resolveExercise(name: string) {
    const found = exByName.get(name.toLowerCase());
    if (found) return found;
    const created = await prisma.exercise.create({
      data: { orgId: req.auth!.orgId, name, category: "IMPORTED", description: "Created by VBT import" },
    });
    exByName.set(name.toLowerCase(), created);
    return created;
  }

  let setCount = 0;
  const maxUpdates: { athlete: string; exercise: string; e1rmKg: number }[] = [];

  for (const session of sessions) {
    // 12:00Z lands on the session's calendar day for any real-world offset.
    const completedAt = new Date(pureDate(session.date).getTime() + 12 * 3600 * 1000);
    const workout = await prisma.workout.create({
      data: {
        orgId: req.auth!.orgId,
        name: `GymAware Import — ${session.date}`,
        description: "Imported VBT session (device CSV)",
        createdById: req.auth!.userId,
        blocks: {
          create: [{
            name: "A. Imported",
            order: 0,
            items: {
              create: await Promise.all(session.exercises.map(async (ex, i) => ({
                exerciseId: (await resolveExercise(ex.exercise)).id,
                order: i,
                sets: ex.sets.length,
                reps: ex.sets[0]?.reps ? String(ex.sets[0].reps) : null,
                notes: "Imported from GymAware",
              }))),
            },
          }],
        },
      },
      include: { blocks: { include: { items: true } } },
    });
    const assignment = await prisma.workoutAssignment.create({
      data: { workoutId: workout.id, athleteId: session.athleteId, assignedDate: pureDate(session.date), status: "COMPLETED", completedAt },
    });

    for (const [i, ex] of session.exercises.entries()) {
      const item = workout.blocks[0].items[i];
      for (const s of ex.sets) {
        await prisma.setLog.create({
          data: {
            assignmentId: assignment.id, workoutItemId: item.id, setNumber: s.setNumber,
            reps: s.reps, loadKg: s.loadKg, velocity: s.velocity != null ? Math.round(s.velocity * 1000) / 1000 : null,
            peakVelocity: s.peakVelocity, completed: true,
          },
        });
        setCount += 1;
      }

      // Load-velocity profile: needs 2+ distinct loads with mean velocities.
      const points = ex.sets
        .filter((s) => s.loadKg != null && s.velocity != null)
        .map((s) => ({ loadKg: s.loadKg!, velocity: s.velocity! }));
      const distinctLoads = new Set(points.map((p) => p.loadKg));
      if (distinctLoads.size >= 2) {
        const exercise = exByName.get(ex.exercise.toLowerCase())!;
        const e1rm = e1rmFromLoadVelocity(points, mvtForExercise(exercise));
        if (e1rm != null && e1rm > 0) {
          const rounded = Math.round(e1rm * 10) / 10;
          const max = await prisma.maxProfile.create({
            data: {
              athleteId: session.athleteId, exerciseId: exercise.id, e1rmKg: rounded,
              method: "VBT_LV", source: "IMPORT", lvJson: JSON.stringify(points),
              notes: `GymAware import ${session.date}`,
            },
          });
          await maybeE1rmPR(session.athleteId, exercise, rounded, max.id).catch(() => {});
          maxUpdates.push({ athlete: session.athlete, exercise: exercise.name, e1rmKg: rounded });
        }
      }
    }
  }

  res.status(201).json({ imported: { sessions: sessions.length, sets: setCount }, maxUpdates, skipped, detected: cols });
});
