import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const exercisesRouter = Router();
exercisesRouter.use(requireAuth);

// List / search the exercise library for the caller's org.
exercisesRouter.get("/", async (req: AuthedRequest, res) => {
  const q = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();
  const exercises = await prisma.exercise.findMany({
    where: {
      orgId: req.auth!.orgId,
      ...(category ? { category } : {}),
      ...(q ? { name: { contains: q } } : {}),
    },
    orderBy: { name: "asc" },
  });
  res.json({ exercises: exercises.map(deserialize) });
});

const exerciseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  videoUrl: z.string().url().optional().or(z.literal("")),
  category: z.string().min(1),
  equipment: z.string().optional(),
  muscleGroups: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

exercisesRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = exerciseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  const exercise = await prisma.exercise.create({
    data: {
      orgId: req.auth!.orgId,
      name: d.name,
      description: d.description,
      videoUrl: d.videoUrl || null,
      category: d.category,
      equipment: d.equipment,
      muscleGroups: d.muscleGroups ? JSON.stringify(d.muscleGroups) : null,
      tags: d.tags ? JSON.stringify(d.tags) : null,
    },
  });
  res.status(201).json({ exercise: deserialize(exercise) });
});

exercisesRouter.get("/:id", async (req: AuthedRequest, res) => {
  const exercise = await prisma.exercise.findUnique({ where: { id: req.params.id } });
  if (!exercise || exercise.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Exercise not found" });
  }
  res.json({ exercise: deserialize(exercise) });
});

// Turn stored JSON-string list fields back into arrays for the client.
function deserialize<T extends { muscleGroups: string | null; tags: string | null }>(e: T) {
  return {
    ...e,
    muscleGroups: e.muscleGroups ? (JSON.parse(e.muscleGroups) as string[]) : [],
    tags: e.tags ? (JSON.parse(e.tags) as string[]) : [],
  };
}
