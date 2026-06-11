import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, AuthedRequest } from "../auth";

export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

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
  res.json({ assignment });
});

const logSchema = z.object({
  logs: z.array(
    z.object({
      workoutItemId: z.string(),
      setNumber: z.number().int().min(1),
      reps: z.number().int().optional(),
      loadKg: z.number().optional(),
      rpe: z.number().optional(),
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
      update: { reps: l.reps, loadKg: l.loadKg, rpe: l.rpe, completed: l.completed, notes: l.notes },
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
