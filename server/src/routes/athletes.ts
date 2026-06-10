import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { getAthleteRating } from "../rating";

export const athletesRouter = Router();
athletesRouter.use(requireAuth);

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
