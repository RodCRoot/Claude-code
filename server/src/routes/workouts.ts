import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const workoutsRouter = Router();
workoutsRouter.use(requireAuth);

const itemSchema = z.object({
  exerciseId: z.string(),
  sets: z.number().int().optional(),
  reps: z.string().optional(),
  load: z.string().optional(),
  tempo: z.string().optional(),
  restSec: z.number().int().optional(),
  notes: z.string().optional(),
  // VBT prescription
  prescribeBy: z.enum(["PCT", "VELOCITY", "ZONE", "RPE", "TEXT"]).optional(),
  targetPctE1rm: z.number().positive().max(2).optional(),
  targetVelocity: z.number().positive().max(3).optional(),
  velocityZone: z.enum(["STRENGTH", "STRENGTH_SPEED", "SPEED_STRENGTH", "SPEED"]).optional(),
});

const blockSchema = z.object({
  name: z.string().min(1),
  items: z.array(itemSchema),
});

const workoutSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  blocks: z.array(blockSchema),
});

// List workouts in the org.
workoutsRouter.get("/", async (req: AuthedRequest, res) => {
  const workouts = await prisma.workout.findMany({
    where: { orgId: req.auth!.orgId },
    include: { _count: { select: { blocks: true, assignments: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ workouts });
});

// Create a full workout (blocks + items) in one call.
workoutsRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = workoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const workout = await prisma.workout.create({
    data: {
      orgId: req.auth!.orgId,
      name: d.name,
      description: d.description,
      createdById: req.auth!.userId,
      blocks: {
        create: d.blocks.map((b, bi) => ({
          name: b.name,
          order: bi,
          items: {
            create: b.items.map((it, ii) => ({
              exerciseId: it.exerciseId,
              order: ii,
              sets: it.sets,
              reps: it.reps,
              load: it.load,
              tempo: it.tempo,
              restSec: it.restSec,
              notes: it.notes,
              prescribeBy: it.prescribeBy,
              targetPctE1rm: it.targetPctE1rm,
              targetVelocity: it.targetVelocity,
              velocityZone: it.velocityZone,
            })),
          },
        })),
      },
    },
    include: { blocks: { include: { items: { include: { exercise: true } } } } },
  });
  res.status(201).json({ workout });
});

workoutsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const workout = await prisma.workout.findUnique({
    where: { id: req.params.id },
    include: {
      blocks: {
        orderBy: { order: "asc" },
        include: { items: { orderBy: { order: "asc" }, include: { exercise: true } } },
      },
    },
  });
  if (!workout || workout.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Workout not found" });
  }
  res.json({ workout });
});

const assignSchema = z.object({
  athleteIds: z.array(z.string()).optional(),
  groupId: z.string().optional(),
  assignedDate: z.string().optional(),
  dates: z.array(z.string()).optional(), // multiple dates → recurring schedule
  dueDate: z.string().optional(),
}).refine((d) => (d.athleteIds && d.athleteIds.length > 0) || d.groupId, {
  message: "Provide athleteIds or a groupId",
});

// Assign a workout to athletes and/or an entire group, on an optional date.
workoutsRouter.post("/:id/assign", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const workout = await prisma.workout.findUnique({ where: { id: req.params.id } });
  if (!workout || workout.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Workout not found" });
  }

  // Resolve the target athlete set (explicit ids ∪ group members), org-scoped.
  const ids = new Set(parsed.data.athleteIds ?? []);
  if (parsed.data.groupId) {
    const group = await prisma.group.findUnique({
      where: { id: parsed.data.groupId },
      include: { memberships: { select: { athleteId: true } } },
    });
    if (!group || group.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Group not found" });
    for (const m of group.memberships) ids.add(m.athleteId);
  }
  if (ids.size === 0) return res.status(400).json({ error: "No athletes to assign" });

  // Keep only athletes in this org.
  const valid = await prisma.athlete.findMany({
    where: { id: { in: [...ids] }, orgId: req.auth!.orgId },
    select: { id: true },
  });

  // One or many session dates (recurring schedule).
  const dates = parsed.data.dates?.length
    ? parsed.data.dates.map((d) => new Date(d))
    : [parsed.data.assignedDate ? new Date(parsed.data.assignedDate) : new Date()];
  const dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;

  const rows = valid.flatMap((a) => dates.map((assignedDate) => ({ workoutId: workout.id, athleteId: a.id, assignedDate, dueDate })));
  await prisma.workoutAssignment.createMany({ data: rows });
  res.status(201).json({ assigned: rows.length, athletes: valid.length, sessions: dates.length });
});
