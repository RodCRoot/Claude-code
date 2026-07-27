import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { BENCHMARK_LEVELS } from "../constants";

export const benchmarksRouter = Router();
benchmarksRouter.use(requireAuth);

// List all benchmark rows with their metric, for review/editing.
benchmarksRouter.get("/", async (_req, res) => {
  const benchmarks = await prisma.benchmark.findMany({
    include: { metricType: { select: { key: true, name: true, unit: true } } },
    orderBy: [{ metricTypeId: "asc" }, { sport: "asc" }, { position: "asc" }],
  });
  res.json({ benchmarks });
});

const upsertSchema = z.object({
  metricKey: z.string(),
  sport: z.string().nullish(),
  position: z.string().nullish(),
  sex: z.enum(["M", "F"]).nullish(),
  ageMin: z.number().int().nullish(),
  ageMax: z.number().int().nullish(),
  level: z.enum(BENCHMARK_LEVELS).default("ELITE"),
  mean: z.number(),
  sd: z.number().nullish(),
  sourceName: z.string().nullish(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullish(),
  notes: z.string().nullish(),
});

// Create or update a benchmark (coaches/admins). Adjust norms without redeploys.
benchmarksRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { metricKey, ...rest } = parsed.data;
  const metricType = await prisma.metricType.findUnique({ where: { key: metricKey } });
  if (!metricType) return res.status(400).json({ error: "Unknown metric key" });

  const benchmark = await prisma.benchmark.create({
    data: {
      metricTypeId: metricType.id,
      sport: rest.sport ?? null,
      position: rest.position ?? null,
      sex: rest.sex ?? null,
      ageMin: rest.ageMin ?? null,
      ageMax: rest.ageMax ?? null,
      level: rest.level,
      mean: rest.mean,
      sd: rest.sd ?? null,
      sourceName: rest.sourceName ?? null,
      confidence: rest.confidence ?? null,
      notes: rest.notes ?? null,
    },
  });
  res.status(201).json({ benchmark });
});

benchmarksRouter.delete("/:id", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  await prisma.benchmark.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});
