import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { computeTargets } from "../prescription";
import { latestMaxesByExercise } from "../maxprofiles";

export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

// Bounds [00:00, next-00:00) for a yyyy-mm-dd day string.
function dayRange(dateStr: string): [Date, Date] {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

// Copy every session scheduled on one day to one or more other days — the
// "duplicate a day's workout" time-saver coaches expect. Re-creates the same
// workout×athlete assignments (status reset to ASSIGNED), skipping any that
// already exist on a target day so re-pasting is idempotent.
const copyDaySchema = z.object({
  fromDate: z.string(),
  toDates: z.array(z.string()).min(1),
});
assignmentsRouter.post("/copy-day", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = copyDaySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const orgId = req.auth!.orgId;

  const [from, fromEnd] = dayRange(parsed.data.fromDate);
  const source = await prisma.workoutAssignment.findMany({
    where: { assignedDate: { gte: from, lt: fromEnd }, athlete: { orgId } },
    select: { workoutId: true, athleteId: true, dueDate: true },
  });
  if (source.length === 0) return res.status(400).json({ error: "Nothing scheduled on that day to copy" });

  let created = 0;
  for (const dateStr of parsed.data.toDates) {
    const [to, toEnd] = dayRange(dateStr);
    // Existing (workout,athlete) pairs already on the target day → skip them.
    const existing = await prisma.workoutAssignment.findMany({
      where: { assignedDate: { gte: to, lt: toEnd }, athlete: { orgId } },
      select: { workoutId: true, athleteId: true },
    });
    const seen = new Set(existing.map((e) => `${e.workoutId}:${e.athleteId}`));
    const rows = source
      .filter((s) => !seen.has(`${s.workoutId}:${s.athleteId}`))
      .map((s) => ({ workoutId: s.workoutId, athleteId: s.athleteId, assignedDate: to, dueDate: s.dueDate }));
    if (rows.length) {
      await prisma.workoutAssignment.createMany({ data: rows });
      created += rows.length;
    }
  }
  res.status(201).json({ created, sourceSessions: source.length, targetDays: parsed.data.toDates.length });
});

// Ensure the caller may touch this assignment (the assigned athlete, or a
// coach/admin in the same org). Returns the assignment or null.
async function authorizeAssignment(req: AuthedRequest, assignmentId: string) {
  const assignment = await prisma.workoutAssignment.findUnique({
    where: { id: assignmentId },
    include: { athlete: true },
  });
  if (!assignment) return null;
  if (assignment.athlete.orgId !== req.auth!.orgId) return null;
  const isOwner = req.auth!.role === "ATHLETE" && req.auth!.athleteId === assignment.athleteId;
  const isStaff = req.auth!.role === "COACH" || req.auth!.role === "ADMIN";
  return isOwner || isStaff ? assignment : null;
}

// List the caller's assignments. Athletes see their own; staff can pass
// ?athleteId= to view a specific athlete's.
assignmentsRouter.get("/", async (req: AuthedRequest, res) => {
  const { role, orgId, athleteId } = req.auth!;
  let targetAthleteId = role === "ATHLETE" ? athleteId : String(req.query.athleteId || "");
  const where: Record<string, unknown> = targetAthleteId
    ? { athleteId: targetAthleteId }
    : { athlete: { orgId } };

  const assignments = await prisma.workoutAssignment.findMany({
    where,
    include: {
      workout: { select: { id: true, name: true, description: true } },
      _count: { select: { setLogs: true } },
    },
    orderBy: [{ status: "asc" }, { assignedDate: "desc" }],
  });
  res.json({ assignments });
});

// Calendar view: assignments within a date range (by assignedDate). Athletes
// see their own; staff see the whole org (optionally one athlete via ?athleteId).
assignmentsRouter.get("/calendar", async (req: AuthedRequest, res) => {
  const { role, orgId, athleteId } = req.auth!;
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 21 * 864e5);
  const targetAthleteId = role === "ATHLETE" ? athleteId : (req.query.athleteId ? String(req.query.athleteId) : "");

  const where: Record<string, unknown> = {
    assignedDate: { gte: from, lte: to },
    ...(targetAthleteId ? { athleteId: targetAthleteId } : { athlete: { orgId } }),
  };
  const assignments = await prisma.workoutAssignment.findMany({
    where,
    include: {
      workout: { select: { id: true, name: true } },
      athlete: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { assignedDate: "asc" },
  });
  res.json({
    assignments: assignments.map((a) => ({
      id: a.id,
      date: a.assignedDate.toISOString().slice(0, 10),
      status: a.status,
      workout: a.workout,
      athlete: { id: a.athlete.id, name: `${a.athlete.firstName} ${a.athlete.lastName}` },
    })),
  });
});

// Full assignment: the workout structure plus any logs the athlete has entered.
assignmentsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const ok = await authorizeAssignment(req, req.params.id);
  if (!ok) return res.status(404).json({ error: "Assignment not found" });

  const assignment = await prisma.workoutAssignment.findUnique({
    where: { id: req.params.id },
    include: {
      workout: {
        include: {
          blocks: {
            orderBy: { order: "asc" },
            include: { items: { orderBy: { order: "asc" }, include: { exercise: true } } },
          },
        },
      },
      setLogs: true,
    },
  });

  // Attach per-set targets computed from this athlete's current maxes.
  const maxes = await latestMaxesByExercise(ok.athleteId);
  const withTargets = assignment && {
    ...assignment,
    workout: {
      ...assignment.workout,
      blocks: assignment.workout.blocks.map((b) => ({
        ...b,
        items: b.items.map((it) => ({
          ...it,
          targets: computeTargets(it, maxes[it.exerciseId] ?? null),
        })),
      })),
    },
  };
  res.json({ assignment: withTargets });
});

const logSchema = z.object({
  logs: z.array(
    z.object({
      workoutItemId: z.string(),
      setNumber: z.number().int().min(1),
      reps: z.number().int().optional(),
      loadKg: z.number().optional(),
      rpe: z.number().optional(),
      velocity: z.number().optional(),
      peakVelocity: z.number().optional(),
      completed: z.boolean().default(true),
      notes: z.string().optional(),
    })
  ),
});

// Upsert a batch of set logs and flip the assignment to IN_PROGRESS.
assignmentsRouter.post("/:id/logs", async (req: AuthedRequest, res) => {
  const ok = await authorizeAssignment(req, req.params.id);
  if (!ok) return res.status(404).json({ error: "Assignment not found" });
  const parsed = logSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  for (const l of parsed.data.logs) {
    await prisma.setLog.upsert({
      where: {
        assignmentId_workoutItemId_setNumber: {
          assignmentId: req.params.id,
          workoutItemId: l.workoutItemId,
          setNumber: l.setNumber,
        },
      },
      create: { assignmentId: req.params.id, ...l },
      update: { reps: l.reps, loadKg: l.loadKg, rpe: l.rpe, velocity: l.velocity, peakVelocity: l.peakVelocity, completed: l.completed, notes: l.notes },
    });
  }

  if (ok.status === "ASSIGNED") {
    await prisma.workoutAssignment.update({
      where: { id: req.params.id },
      data: { status: "IN_PROGRESS" },
    });
  }
  res.json({ saved: parsed.data.logs.length });
});

// Mark the whole assignment complete.
assignmentsRouter.post("/:id/complete", async (req: AuthedRequest, res) => {
  const ok = await authorizeAssignment(req, req.params.id);
  if (!ok) return res.status(404).json({ error: "Assignment not found" });
  await prisma.workoutAssignment.update({
    where: { id: req.params.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  res.json({ ok: true });
});
