import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { METRIC_SOURCES } from "../constants";

export const metricsRouter = Router();
metricsRouter.use(requireAuth);

// Catalog of measurable metric types.
metricsRouter.get("/types", async (_req, res) => {
  const types = await prisma.metricType.findMany({ orderBy: { name: "asc" } });
  res.json({ types });
});

const recordSchema = z.object({
  athleteId: z.string(),
  metricKey: z.string(),
  value: z.number(),
  recordedAt: z.string().optional(),
  source: z.enum(METRIC_SOURCES).default("MANUAL"),
  notes: z.string().optional(),
});

// Add a single metric record (manual entry / device sync).
metricsRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = recordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { athleteId, metricKey, value, recordedAt, source, notes } = parsed.data;

  const [athlete, metricType] = await Promise.all([
    prisma.athlete.findUnique({ where: { id: athleteId } }),
    prisma.metricType.findUnique({ where: { key: metricKey } }),
  ]);
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  if (!metricType) return res.status(400).json({ error: "Unknown metric key" });

  const record = await prisma.metricRecord.create({
    data: {
      athleteId,
      metricTypeId: metricType.id,
      value,
      source,
      notes,
      recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    },
  });
  res.status(201).json({ record });
});

// Time series for one athlete + metric (for dashboard charts).
metricsRouter.get("/series", async (req: AuthedRequest, res) => {
  const athleteId = String(req.query.athleteId || "");
  const metricKey = String(req.query.metricKey || "");
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) {
    return res.status(404).json({ error: "Athlete not found" });
  }
  const metricType = await prisma.metricType.findUnique({ where: { key: metricKey } });
  if (!metricType) return res.status(400).json({ error: "Unknown metric key" });

  const records = await prisma.metricRecord.findMany({
    where: { athleteId, metricTypeId: metricType.id },
    orderBy: { recordedAt: "asc" },
    select: { value: true, recordedAt: true, source: true },
  });
  res.json({ metric: metricType, records });
});
