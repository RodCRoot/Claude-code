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
