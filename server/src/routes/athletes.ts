import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { getAthleteRating } from "../rating";
import { repMaxTo1rm, e1rmFromLoadVelocity, mvtForExercise } from "../prescription";
import { buildToday } from "../today";
import { maybeE1rmPR } from "../feed";

export const athletesRouter = Router();
athletesRouter.use(requireAuth);

// Confirm the caller may view this athlete (same org; athletes only themselves).
// Returns the athlete or null.
async function authorizeAthlete(req: AuthedRequest, athleteId: string) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) return null;
  if (req.auth!.role === "ATHLETE" && req.auth!.athleteId !== athlete.id) return null;
  return athlete;
}

// List athletes in the caller's org. Athletes only see themselves.
athletesRouter.get("/", async (req: AuthedRequest, res) => {
  const { role, orgId, athleteId } = req.auth!;
  const where =
    role === "ATHLETE" ? { id: athleteId ?? "__none__" } : { orgId };
  const athletes = await prisma.athlete.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  res.json({ athletes });
});

const athleteSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  sex: z.enum(["M", "F"]),
  birthDate: z.string(), // ISO date
  sport: z.string().min(1),
  position: z.string().optional(),
  gradYear: z.number().int().optional(),
  heightCm: z.number().optional(),
  weightKg: z.number().optional(),
});

athletesRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = athleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const athlete = await prisma.athlete.create({
    data: {
      ...parsed.data,
      birthDate: new Date(parsed.data.birthDate),
      orgId: req.auth!.orgId,
    },
  });
  res.status(201).json({ athlete });
});

athletesRouter.get("/:id", async (req: AuthedRequest, res) => {
  const athlete = await prisma.athlete.findUnique({
    where: { id: req.params.id },
    include: {
      metrics: { include: { metricType: true }, orderBy: { recordedAt: "desc" } },
      assignments: { include: { workout: true }, orderBy: { assignedDate: "desc" } },
    },
  });
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  if (req.auth!.role === "ATHLETE" && req.auth!.athleteId !== athlete.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json({ athlete });
});

// The athlete's rating card across all metrics.
athletesRouter.get("/:id/rating", async (req: AuthedRequest, res) => {
  const athlete = await prisma.athlete.findUnique({ where: { id: req.params.id } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  if (req.auth!.role === "ATHLETE" && req.auth!.athleteId !== athlete.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(await getAthleteRating(req.params.id));
});

// Longitudinal history as a spreadsheet: every metric record plus e1RM maxes.
athletesRouter.get("/:id/export.csv", async (req: AuthedRequest, res) => {
  const athlete = await prisma.athlete.findUnique({ where: { id: req.params.id } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  if (req.auth!.role === "ATHLETE" && req.auth!.athleteId !== athlete.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const [records, maxes] = await Promise.all([
    prisma.metricRecord.findMany({
      where: { athleteId: athlete.id },
      include: { metricType: { select: { name: true, unit: true } } },
      orderBy: { recordedAt: "asc" },
    }),
    prisma.maxProfile.findMany({
      where: { athleteId: athlete.id },
      include: { exercise: { select: { name: true } } },
      orderBy: { recordedAt: "asc" },
    }),
  ]);
  const esc = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows: unknown[][] = [
    ["Date", "Kind", "Measure", "Value", "Unit", "Notes"],
    ...records.map((r) => [r.recordedAt.toISOString().slice(0, 10), "Metric", r.metricType.name, r.value, r.metricType.unit, r.notes ?? ""]),
    ...maxes.map((m) => [m.recordedAt.toISOString().slice(0, 10), "Max (e1RM)", m.exercise.name, m.e1rmKg, "kg", m.method]),
  ];
  const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${athlete.firstName}-${athlete.lastName}-progress.csv"`);
  res.send(csv);
});

// A self-contained, printable progress report: profile, rating card, per-metric
// history (for sparklines), and workout compliance.
athletesRouter.get("/:id/report", async (req: AuthedRequest, res) => {
  const athlete = await prisma.athlete.findUnique({
    where: { id: req.params.id },
    include: { org: { select: { name: true } } },
  });
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  if (req.auth!.role === "ATHLETE" && req.auth!.athleteId !== athlete.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [rating, records, assignments] = await Promise.all([
    getAthleteRating(req.params.id),
    prisma.metricRecord.findMany({
      where: { athleteId: req.params.id },
      include: { metricType: { select: { key: true } } },
      orderBy: { recordedAt: "asc" },
    }),
    prisma.workoutAssignment.findMany({
      where: { athleteId: req.params.id },
      include: { workout: { select: { name: true } } },
      orderBy: { assignedDate: "desc" },
    }),
  ]);

  // Group records into per-metric series keyed by metric key.
  const history: Record<string, { value: number; recordedAt: Date; source: string }[]> = {};
  for (const r of records) {
    (history[r.metricType.key] ||= []).push({ value: r.value, recordedAt: r.recordedAt, source: r.source });
  }

  const completed = assignments.filter((a) => a.status === "COMPLETED").length;
  const compliance = {
    total: assignments.length,
    completed,
    inProgress: assignments.filter((a) => a.status === "IN_PROGRESS").length,
    notStarted: assignments.filter((a) => a.status === "ASSIGNED").length,
    completionRate: assignments.length ? Math.round((completed / assignments.length) * 100) : 0,
    recent: assignments.slice(0, 8).map((a) => ({
      name: a.workout.name,
      status: a.status,
      assignedDate: a.assignedDate,
      completedAt: a.completedAt,
    })),
  };

  res.json({
    athlete: {
      id: athlete.id,
      firstName: athlete.firstName,
      lastName: athlete.lastName,
      sex: athlete.sex,
      sport: athlete.sport,
      position: athlete.position,
      gradYear: athlete.gradYear,
      heightCm: athlete.heightCm,
      weightKg: athlete.weightKg,
      orgName: athlete.org.name,
    },
    rating,
    history,
    compliance,
    generatedAt: new Date().toISOString(),
  });
});

// Coach (or the athlete) view of an athlete's "Today" screen.
athletesRouter.get("/:id/today", async (req: AuthedRequest, res) => {
  const athlete = await authorizeAthlete(req, req.params.id);
  if (!athlete) return res.status(404).json({ error: "Athlete not found" });
  const data = await buildToday(req.params.id);
  res.json(data);
});

// --- Max / e1RM profiles ----------------------------------------------------

// An athlete's max history (most recent first), with the exercise name.
athletesRouter.get("/:id/maxes", async (req: AuthedRequest, res) => {
  const athlete = await authorizeAthlete(req, req.params.id);
  if (!athlete) return res.status(404).json({ error: "Athlete not found" });
  const maxes = await prisma.maxProfile.findMany({
    where: { athleteId: req.params.id },
    include: { exercise: { select: { id: true, name: true } } },
    orderBy: { recordedAt: "desc" },
  });
  res.json({ maxes });
});

// Create a max via one of three methods:
//  - DIRECT:  { exerciseId, e1rmKg }
//  - rep-max: { exerciseId, repWeightKg, reps, method: "EPLEY"|"BRZYCKI" }
//  - VBT:     { exerciseId, lvPoints: [{loadKg, velocity}], method: "VBT_LV" }
const maxSchema = z.object({
  exerciseId: z.string(),
  e1rmKg: z.number().positive().optional(),
  repWeightKg: z.number().positive().optional(),
  reps: z.number().int().min(1).max(20).optional(),
  lvPoints: z.array(z.object({ loadKg: z.number().positive(), velocity: z.number().positive() })).optional(),
  method: z.enum(["DIRECT", "EPLEY", "BRZYCKI", "VBT_LV"]).optional(),
  recordedAt: z.string().optional(),
  notes: z.string().optional(),
});

athletesRouter.post("/:id/maxes", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const athlete = await authorizeAthlete(req, req.params.id);
  if (!athlete) return res.status(404).json({ error: "Athlete not found" });
  const parsed = maxSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { exerciseId, e1rmKg, repWeightKg, reps, lvPoints, method, recordedAt, notes } = parsed.data;

  const exercise = await prisma.exercise.findUnique({ where: { id: exerciseId } });
  if (!exercise || exercise.orgId !== req.auth!.orgId) {
    return res.status(400).json({ error: "Unknown exercise" });
  }

  let e1rm: number | null = null;
  let resolvedMethod = method || "DIRECT";
  let lvJson: string | null = null;

  if (lvPoints && lvPoints.length >= 2) {
    e1rm = e1rmFromLoadVelocity(lvPoints, mvtForExercise(exercise));
    resolvedMethod = "VBT_LV";
    lvJson = JSON.stringify(lvPoints);
    if (e1rm == null) return res.status(400).json({ error: "Load-velocity points don't yield a valid 1RM (velocity must fall as load rises)." });
  } else if (repWeightKg != null && reps != null) {
    e1rm = repMaxTo1rm(repWeightKg, reps, method === "BRZYCKI" ? "BRZYCKI" : "EPLEY");
    resolvedMethod = method === "BRZYCKI" ? "BRZYCKI" : "EPLEY";
  } else if (e1rmKg != null) {
    e1rm = e1rmKg;
    resolvedMethod = "DIRECT";
  } else {
    return res.status(400).json({ error: "Provide e1rmKg, a rep-max (repWeightKg+reps), or lvPoints." });
  }

  const max = await prisma.maxProfile.create({
    data: {
      athleteId: req.params.id,
      exerciseId,
      e1rmKg: Math.round(e1rm! * 10) / 10,
      method: resolvedMethod,
      source: resolvedMethod === "VBT_LV" ? "VBT" : "MANUAL",
      lvJson,
      notes: notes ?? (repWeightKg != null && reps != null ? `${repWeightKg}kg x ${reps}` : null),
      recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    },
  });
  await maybeE1rmPR(req.params.id, { id: exercise.id, name: exercise.name }, max.e1rmKg, max.id).catch(() => {});
  res.status(201).json({ max });
});

// Delete a max (coach/admin, org-scoped).
athletesRouter.delete("/maxes/:maxId", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const max = await prisma.maxProfile.findUnique({
    where: { id: req.params.maxId },
    include: { athlete: { select: { orgId: true } } },
  });
  if (!max || max.athlete.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Max not found" });
  await prisma.maxProfile.delete({ where: { id: req.params.maxId } });
  res.status(204).end();
});
