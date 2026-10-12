import { createHash, randomUUID } from "node:crypto";
import Papa from "papaparse";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  athletes,
  exercises,
  externalIds,
  groupMembers,
  groups,
  importBatches,
  people,
  setLogs,
  trainingPlanBlocks,
  vbtReadings,
  workoutItems,
  workouts,
} from "@/db/schema";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, canOnAthlete, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { todayLocal } from "@/lib/time";
import { actor, athleteNames, num, TrainingError } from "./common";
import { adherence } from "./formulas";
import { e1rmPoints } from "./maxes";
import { manageableGroupIds } from "./assignments";

export async function athleteWorkouts(tx: Tx, v: Viewer, athleteId: string, range: { from?: string; to?: string } = {}) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  return tx
    .select()
    .from(workouts)
    .where(
      and(
        eq(workouts.orgId, v.orgId),
        eq(workouts.athleteId, athleteId),
        range.from ? gte(workouts.scheduledDate, range.from) : undefined,
        range.to ? lte(workouts.scheduledDate, range.to) : undefined,
      ),
    )
    .orderBy(desc(workouts.scheduledDate));
}

export async function athleteAdherence(tx: Tx, v: Viewer, athleteId: string, range: { from?: string; to?: string } = {}, today = todayLocal()) {
  const ws = await athleteWorkouts(tx, v, athleteId, range);
  return adherence(ws, today);
}

/** e1RM series per lift for charts (Epley v1, reps 1–10, completed working sets). */
export async function e1rmSeries(tx: Tx, v: Viewer, athleteId: string, exerciseId: string, range: { from?: string; to?: string } = {}) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const pts = await e1rmPoints(tx, v.orgId, [athleteId], { since: range.from, exerciseIds: [exerciseId] });
  const byDate = new Map<string, { date: string; e1rm: number; unit: string; detail: string }>();
  for (const p of pts) {
    if (range.to && p.date > range.to) continue;
    const k = `${p.date}:${p.unit}`;
    if (!byDate.has(k) || byDate.get(k)!.e1rm < p.e1rm) byDate.set(k, { date: p.date, e1rm: p.e1rm, unit: p.unit, detail: `${p.load} ${p.unit} × ${p.reps}` });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Exercises the athlete has e1RM data or maxes for (chart picker). */
export async function liftsWithData(tx: Tx, v: Viewer, athleteId: string) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const pts = await e1rmPoints(tx, v.orgId, [athleteId]);
  const ids = [...new Set(pts.map((p) => p.exerciseId))];
  if (!ids.length) return [];
  return tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(inArray(exercises.id, ids)).orderBy(asc(exercises.name));
}

async function groupForReport(tx: Tx, v: Viewer, groupId: string) {
  const [g] = await tx.select().from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, v.orgId)));
  if (!g) throw new TrainingError("Group not found.");
  const ok = await manageableGroupIds(tx, v);
  if (ok !== "all" && !ok.includes(groupId)) throw new AuthzError("You can only report on groups you coach.");
  const members = await tx.select({ id: groupMembers.athleteId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const ids = members.map((m) => m.id).filter((id) => scope === "all" || scope.includes(id));
  return { group: g, athleteIds: ids };
}

/** Group report: adherence per athlete and best e1RM on the main lifts in a date range. */
export async function groupReport(tx: Tx, v: Viewer, groupId: string, range: { from: string; to: string }, today = todayLocal()) {
  const { group, athleteIds } = await groupForReport(tx, v, groupId);
  const names = await athleteNames(tx, v.orgId, athleteIds);
  const ws = athleteIds.length
    ? await tx
        .select({ athleteId: workouts.athleteId, scheduledDate: workouts.scheduledDate, status: workouts.status, sessionRpe: workouts.sessionRpe, durationMinutes: workouts.durationMinutes })
        .from(workouts)
        .where(and(eq(workouts.orgId, v.orgId), inArray(workouts.athleteId, athleteIds), gte(workouts.scheduledDate, range.from), lte(workouts.scheduledDate, range.to)))
    : [];
  const pts = await e1rmPoints(tx, v.orgId, athleteIds, { since: range.from });
  const inRange = pts.filter((p) => p.date <= range.to);
  const exIds = [...new Set(inRange.map((p) => p.exerciseId))];
  const exRows = exIds.length ? await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(inArray(exercises.id, exIds)) : [];
  const counts = new Map<string, number>();
  for (const p of inRange) counts.set(p.exerciseId, (counts.get(p.exerciseId) ?? 0) + 1);
  const topLifts = exRows.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).slice(0, 4);
  const rows = athleteIds
    .map((id) => {
      const mine = ws.filter((w) => w.athleteId === id);
      const adh = adherence(mine, today);
      const best: Record<string, { value: number; unit: string } | null> = {};
      for (const l of topLifts) {
        const ps = inRange.filter((p) => p.athleteId === id && p.exerciseId === l.id);
        const top = ps.reduce<(typeof ps)[number] | null>((acc, p) => (!acc || p.e1rm > acc.e1rm ? p : acc), null);
        best[l.id] = top ? { value: top.e1rm, unit: top.unit } : null;
      }
      const load = mine.reduce((s, w) => s + (w.sessionRpe != null && w.durationMinutes != null ? w.sessionRpe * w.durationMinutes : 0), 0);
      return { athleteId: id, name: names.get(id) ?? "Athlete", ...adh, best, sessionLoad: load };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { group, rows, topLifts };
}

const OPT_IN_KEY = "trainingLeaderboardOptIn";

export async function leaderboardOptIn(tx: Tx, orgId: string, athleteId: string): Promise<boolean> {
  const [r] = await tx.select({ cf: people.customFields }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  return r?.cf?.[OPT_IN_KEY] === true;
}

/** Leaderboard participation is opt-in by the athlete (or a guardian with training access). */
export async function setLeaderboardOptIn(tx: Tx, v: Viewer, athleteId: string, optIn: boolean) {
  if (v.role !== "athlete" && v.role !== "guardian") throw new AuthzError("Only the athlete or their guardian can change leaderboard participation.");
  if (!(await canOnAthlete(tx, v, athleteId, "training.read"))) throw new AuthzError();
  const [a] = await tx.select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, athleteId));
  await tx
    .update(people)
    .set({ customFields: sql`coalesce(${people.customFields}, '{}'::jsonb) || ${JSON.stringify({ [OPT_IN_KEY]: optIn })}::jsonb` })
    .where(eq(people.id, a.personId));
  await audit(tx, actor(v), "training.leaderboard.opt_in", "athlete", athleteId, { after: { optIn } });
}

/** Group leaderboard on one lift: best e1RM in range, opted-in athletes only, per unit (never mixed). */
export async function leaderboard(tx: Tx, v: Viewer, groupId: string, exerciseId: string, range: { from: string; to: string }) {
  const { athleteIds } = await groupForReport(tx, v, groupId);
  const opted: string[] = [];
  for (const id of athleteIds) if (await leaderboardOptIn(tx, v.orgId, id)) opted.push(id);
  const pts = (await e1rmPoints(tx, v.orgId, opted, { since: range.from, exerciseIds: [exerciseId] })).filter((p) => p.date <= range.to);
  const names = await athleteNames(tx, v.orgId, opted);
  const best = new Map<string, (typeof pts)[number]>();
  for (const p of pts) if (!best.has(p.athleteId) || best.get(p.athleteId)!.e1rm < p.e1rm) best.set(p.athleteId, p);
  return {
    optedInCount: opted.length,
    eligibleCount: athleteIds.length,
    rows: [...best.values()].map((p) => ({ athleteId: p.athleteId, name: names.get(p.athleteId) ?? "Athlete", e1rm: p.e1rm, unit: p.unit, date: p.date, detail: `${p.load} ${p.unit} × ${p.reps}` })).sort((a, b) => (a.unit === b.unit ? b.e1rm - a.e1rm : a.unit.localeCompare(b.unit))),
  };
}

const csvCell = (x: unknown) => {
  if (x == null) return "";
  let s = String(x);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/** CSV export of workouts or set logs for athletes the viewer may read (staff: scope; families: own). */
export async function exportCsv(tx: Tx, v: Viewer, kind: "workouts" | "sets", f: { athleteId?: string; groupId?: string; from?: string; to?: string }) {
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  if (scope !== "all" && !scope.length) throw new AuthzError();
  if (f.athleteId && scope !== "all" && !scope.includes(f.athleteId)) throw new AuthzError();
  const conds = [eq(workouts.orgId, v.orgId), athleteScopeFilter(scope, workouts.athleteId)];
  if (f.athleteId) conds.push(eq(workouts.athleteId, f.athleteId));
  if (f.groupId) conds.push(sql`${workouts.athleteId} in (select ${groupMembers.athleteId} from ${groupMembers} where ${groupMembers.groupId} = ${f.groupId})`);
  if (f.from) conds.push(gte(workouts.scheduledDate, f.from));
  if (f.to) conds.push(lte(workouts.scheduledDate, f.to));
  const ws = await tx.select().from(workouts).where(and(...conds)).orderBy(asc(workouts.scheduledDate));
  const names = await athleteNames(tx, v.orgId, ws.map((w) => w.athleteId));
  let csv: string;
  let count: number;
  if (kind === "workouts") {
    csv = toCsv(
      ["workout_id", "athlete", "date", "title", "status", "session_rpe", "duration_min", "srpe_load_au", "completed_at", "coach_reviewed"],
      ws.map((w) => [w.id, names.get(w.athleteId), w.scheduledDate, w.title, w.status, w.sessionRpe, w.durationMinutes, w.sessionRpe != null && w.durationMinutes != null ? w.sessionRpe * w.durationMinutes : null, w.completedAt?.toISOString(), w.coachReviewedAt ? "yes" : "no"]),
    );
    count = ws.length;
  } else {
    const rows = ws.length
      ? await tx
          .select({ log: setLogs, wid: workoutItems.workoutId, ex: exercises.name, block: workoutItems.blockLabel })
          .from(setLogs)
          .innerJoin(workoutItems, eq(workoutItems.id, setLogs.workoutItemId))
          .innerJoin(exercises, eq(exercises.id, sql`coalesce(${workoutItems.substitutedExerciseId}, ${workoutItems.exerciseId})`))
          .where(inArray(workoutItems.workoutId, ws.map((w) => w.id)))
          .orderBy(asc(workoutItems.workoutId), asc(workoutItems.sortOrder), asc(setLogs.setIndex))
      : [];
    const wMap = new Map(ws.map((w) => [w.id, w]));
    csv = toCsv(
      ["workout_id", "athlete", "date", "block", "exercise", "set", "side", "warmup", "reps", "load", "load_unit", "rpe", "duration_s", "distance_m", "completed", "logged_via"],
      rows.map((r) => {
        const w = wMap.get(r.wid)!;
        return [r.wid, names.get(w.athleteId), w.scheduledDate, r.block, r.ex, r.log.setIndex + 1, r.log.side, r.log.isWarmup ? "yes" : "no", r.log.reps, num(r.log.load), r.log.loadUnit, num(r.log.rpe), num(r.log.durationS), num(r.log.distanceM), r.log.completed ? "yes" : "no", r.log.loggedVia];
      }),
    );
    count = rows.length;
  }
  await audit(tx, actor(v), "training.export", "export", null, { summary: `Exported ${count} ${kind} rows as CSV`, after: f });
  return csv;
}

// ---------------------------------------------------------------------------------------
// VBT CSV import. Provenance: every reading carries the import batch (file name + checksum).
// No device connectivity is claimed — this is a file import only.
// ---------------------------------------------------------------------------------------

const vbtRow = z.object({
  athlete: z.string().trim().min(1),
  exercise: z.string().trim().min(1),
  timestamp: z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)), "Unreadable timestamp"),
  load: z.coerce.number().min(0).max(5000).nullable(),
  unit: z.enum(["lb", "kg"]).nullable(),
  rep: z.coerce.number().int().min(1).max(100).nullable(),
  mean_velocity: z.coerce.number().min(0).max(10).nullable(),
  peak_velocity: z.coerce.number().min(0).max(15).nullable(),
  power: z.coerce.number().min(0).max(20000).nullable(),
  device: z.string().trim().max(80).nullable(),
});

const pick = (r: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) {
    const v = r[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
};

export type VbtImportResult = { batchId: string; imported: number; duplicates: number; errors: { row: number; message: string }[] };

export async function importVbtCsv(tx: Tx, v: Viewer, file: { name: string; text: string }): Promise<VbtImportResult> {
  assertCan(v, "training.manage");
  if (file.text.length > 5_000_000) throw new TrainingError("File too large (5 MB max).");
  const parsed = Papa.parse<Record<string, string>>(file.text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_") });
  if (!parsed.data.length) throw new TrainingError("No rows found. Expected a header row with athlete, exercise, timestamp, load, unit, rep, mean_velocity, peak_velocity, power, device.");
  const checksum = createHash("sha256").update(file.text).digest("hex");
  const batchId = randomUUID();

  const scope = await accessibleAthleteIds(tx, v, "training.write");
  const exRows = await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(eq(exercises.orgId, v.orgId));
  const exByName = new Map(exRows.map((e) => [e.name.toLowerCase(), e.id]));
  const peopleRows = await tx
    .select({ athleteId: athletes.id, email: people.email })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(athletes.orgId, v.orgId));
  const byEmail = new Map<string, string[]>();
  for (const p of peopleRows) if (p.email) byEmail.set(p.email.toLowerCase(), [...(byEmail.get(p.email.toLowerCase()) ?? []), p.athleteId]);
  const ext = await tx.select().from(externalIds).where(and(eq(externalIds.orgId, v.orgId), eq(externalIds.localEntityType, "athlete")));
  const byExt = new Map(ext.map((e) => [e.sourceId, e.localId]));

  const errors: VbtImportResult["errors"] = [];
  const values: (typeof vbtReadings.$inferInsert)[] = [];
  parsed.data.forEach((r, i) => {
    const rowNo = i + 2;
    const res = vbtRow.safeParse({
      athlete: pick(r, "athlete_external_id", "external_id", "athlete_id", "athlete_email", "email", "athlete") ?? "",
      exercise: pick(r, "exercise", "exercise_name") ?? "",
      timestamp: pick(r, "timestamp", "performed_at", "date") ?? "",
      load: pick(r, "load", "weight"),
      unit: pick(r, "unit", "load_unit")?.toLowerCase() ?? null,
      rep: pick(r, "rep", "rep_number"),
      mean_velocity: pick(r, "mean_velocity", "mean_velocity_ms", "mean_velocity_m_s"),
      peak_velocity: pick(r, "peak_velocity", "peak_velocity_ms", "peak_velocity_m_s"),
      power: pick(r, "power", "mean_power", "power_w"),
      device: pick(r, "device"),
    });
    if (!res.success) return errors.push({ row: rowNo, message: res.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
    const d = res.data;
    if (d.load != null && !d.unit) return errors.push({ row: rowNo, message: "Load given without unit (lb or kg); not converted or guessed." });
    const key = d.athlete.toLowerCase();
    const matches = byExt.has(d.athlete) ? [byExt.get(d.athlete)!] : byEmail.get(key) ?? [];
    if (matches.length !== 1) return errors.push({ row: rowNo, message: matches.length ? "Email matches more than one athlete" : `No athlete with external id or email "${d.athlete}"` });
    const athleteId = matches[0];
    if (scope !== "all" && !scope.includes(athleteId)) return errors.push({ row: rowNo, message: "Athlete is outside your coaching scope" });
    const exerciseId = exByName.get(d.exercise.toLowerCase());
    if (!exerciseId) return errors.push({ row: rowNo, message: `Unknown exercise "${d.exercise}" (must match the exercise library name)` });
    const performedAt = new Date(d.timestamp);
    const sourceRecordId = `vbtcsv:${v.orgId}:${createHash("sha256").update([athleteId, exerciseId, performedAt.toISOString(), d.rep ?? "", d.load ?? ""].join("|")).digest("hex").slice(0, 32)}`;
    values.push({
      orgId: v.orgId,
      athleteId,
      exerciseId,
      performedAt,
      load: d.load != null ? String(d.load) : null,
      loadUnit: d.unit,
      repNumber: d.rep,
      meanVelocityMs: d.mean_velocity,
      peakVelocityMs: d.peak_velocity,
      meanPowerW: d.power,
      device: d.device,
      importBatchId: batchId,
      sourceRecordId,
    });
  });
  let imported = 0;
  if (values.length) {
    const ins = await tx.insert(vbtReadings).values(values).onConflictDoNothing({ target: vbtReadings.sourceRecordId }).returning({ id: vbtReadings.id });
    imported = ins.length;
  }
  await tx.insert(importBatches).values({
    id: batchId,
    orgId: v.orgId,
    source: "generic_csv",
    entityType: "vbt_readings",
    status: "committed",
    originalFilename: file.name.slice(0, 200),
    checksum,
    stats: { rows: parsed.data.length, imported, duplicates: values.length - imported, errors: errors.length },
    limitations: "Imported file (VBT export). No device connectivity; values as exported by the device software.",
    createdBy: v.userId,
    committedAt: new Date(),
    committedBy: v.userId,
  });
  await audit(tx, actor(v), "training.vbt.import", "import_batch", batchId, { summary: `VBT CSV ${file.name}: ${imported} imported, ${values.length - imported} duplicates, ${errors.length} errors` });
  return { batchId, imported, duplicates: values.length - imported, errors };
}

export async function recentVbt(tx: Tx, v: Viewer, athleteId: string, limit = 20) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  return tx
    .select({ r: vbtReadings, exerciseName: exercises.name, fileName: importBatches.originalFilename })
    .from(vbtReadings)
    .leftJoin(exercises, eq(exercises.id, vbtReadings.exerciseId))
    .leftJoin(importBatches, eq(importBatches.id, vbtReadings.importBatchId))
    .where(and(eq(vbtReadings.orgId, v.orgId), eq(vbtReadings.athleteId, athleteId)))
    .orderBy(desc(vbtReadings.performedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------------------
// Annual plan (season blocks)
// ---------------------------------------------------------------------------------------

const blockInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["off_season", "pre_season", "in_season", "post_season", "transition"]),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    focus: z.string().trim().max(300).nullable().optional(),
    groupId: z.string().uuid().nullable().optional(),
    athleteId: z.string().uuid().nullable().optional(),
    programId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.endDate >= b.startDate, "End date must be on or after start date")
  .refine((b) => !!b.groupId !== !!b.athleteId, "Choose exactly one group or athlete");

export async function listPlanBlocks(tx: Tx, v: Viewer) {
  assertCan(v, "training.manage");
  const groupsOk = await manageableGroupIds(tx, v);
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const rows = await tx.select().from(trainingPlanBlocks).where(eq(trainingPlanBlocks.orgId, v.orgId)).orderBy(asc(trainingPlanBlocks.startDate));
  return rows.filter((b) => (b.groupId ? groupsOk === "all" || groupsOk.includes(b.groupId) : scope === "all" || scope.includes(b.athleteId!)));
}

export async function createPlanBlock(tx: Tx, v: Viewer, raw: z.input<typeof blockInput>) {
  assertCan(v, "training.manage");
  const b = blockInput.parse(raw);
  if (b.athleteId) await requireOnAthlete(tx, v, b.athleteId, "training.write");
  if (b.groupId) {
    const ok = await manageableGroupIds(tx, v);
    if (ok !== "all" && !ok.includes(b.groupId)) throw new AuthzError("You can only plan for groups you coach.");
  }
  const [row] = await tx.insert(trainingPlanBlocks).values({ orgId: v.orgId, ...b, groupId: b.groupId ?? null, athleteId: b.athleteId ?? null, programId: b.programId ?? null, focus: b.focus ?? null }).returning();
  await audit(tx, actor(v), "training.plan.create", "training_plan_block", row.id, { summary: `${b.kind} block ${b.name} ${b.startDate}–${b.endDate}`, after: b });
  return row;
}

export async function deletePlanBlock(tx: Tx, v: Viewer, id: string) {
  const visible = await listPlanBlocks(tx, v);
  const b = visible.find((x) => x.id === id);
  if (!b) throw new TrainingError("Block not found.");
  await tx.delete(trainingPlanBlocks).where(eq(trainingPlanBlocks.id, id));
  await audit(tx, actor(v), "training.plan.delete", "training_plan_block", id, { before: b });
}
