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
  athleteIds: z.array(z.string()).min(1),
  dueDate: z.string().optional(),
});

// Assign a workout to one or more athletes.
workoutsRouter.post("/:id/assign", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const workout = await prisma.workout.findUnique({ where: { id: req.params.id } });
  if (!workout || workout.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Workout not found" });
  }
  await prisma.workoutAssignment.createMany({
    data: parsed.data.athleteIds.map((athleteId) => ({
      workoutId: workout.id,
      athleteId,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    })),
  });
  res.status(201).json({ assigned: parsed.data.athleteIds.length });
});
