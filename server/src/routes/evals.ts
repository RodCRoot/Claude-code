import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { pureDate, isDayString, today, tzOffsetFromReq } from "../daytime";
import { maybeMetricPR } from "../feed";

// Evaluations: reusable testing protocols run as dated sessions. Every entered
// value writes through to MetricRecord (source EVAL), so the rating engine,
// leaderboards, trends and PR feed all see eval results with no extra wiring.
export const evalsRouter = Router();
evalsRouter.use(requireAuth);
evalsRouter.use(requireRole("ADMIN", "COACH"));

// --- Protocols ---------------------------------------------------------------

const protocolSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  metricTypeIds: z.array(z.string()).min(1).max(12),
});

evalsRouter.post("/protocols", async (req: AuthedRequest, res) => {
  const parsed = protocolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const found = await prisma.metricType.findMany({ where: { id: { in: parsed.data.metricTypeIds } } });
  if (found.length !== parsed.data.metricTypeIds.length) return res.status(400).json({ error: "Unknown metric in protocol" });

  const protocol = await prisma.evalProtocol.create({
    data: {
      orgId: req.auth!.orgId,
      name: parsed.data.name,
      description: parsed.data.description,
      createdById: req.auth!.userId,
      items: { create: parsed.data.metricTypeIds.map((metricTypeId, i) => ({ metricTypeId, order: i })) },
    },
    include: { items: { include: { metricType: true }, orderBy: { order: "asc" } } },
  });
  res.status(201).json({ protocol });
});

evalsRouter.get("/protocols", async (req: AuthedRequest, res) => {
  const protocols = await prisma.evalProtocol.findMany({
    where: { orgId: req.auth!.orgId },
    include: {
      items: { include: { metricType: { select: { id: true, name: true, unit: true } } }, orderBy: { order: "asc" } },
      _count: { select: { sessions: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({ protocols });
});

// --- Sessions ------------------------------------------------------------------

const sessionSchema = z.object({
  protocolId: z.string(),
  date: z.string().refine(isDayString, "yyyy-mm-dd expected").optional(),
  notes: z.string().max(500).optional(),
});

evalsRouter.post("/sessions", async (req: AuthedRequest, res) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const protocol = await prisma.evalProtocol.findUnique({ where: { id: parsed.data.protocolId } });
  if (!protocol || protocol.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Protocol not found" });

  const session = await prisma.evalSession.create({
    data: {
      protocolId: protocol.id,
      date: pureDate(parsed.data.date ?? today(tzOffsetFromReq(req))),
      notes: parsed.data.notes,
      createdById: req.auth!.userId,
    },
  });
  res.status(201).json({ session });
});

evalsRouter.get("/sessions", async (req: AuthedRequest, res) => {
  const sessions = await prisma.evalSession.findMany({
    where: { protocol: { orgId: req.auth!.orgId }, ...(req.query.protocolId ? { protocolId: String(req.query.protocolId) } : {}) },
    include: { protocol: { select: { id: true, name: true } }, _count: { select: { results: true } } },
    orderBy: { date: "desc" },
    take: 50,
  });
  res.json({ sessions });
});

// A session's entry grid: protocol columns + every result already recorded.
evalsRouter.get("/sessions/:id", async (req: AuthedRequest, res) => {
  const session = await prisma.evalSession.findUnique({
    where: { id: req.params.id },
    include: {
      protocol: { include: { items: { include: { metricType: { select: { id: true, name: true, unit: true } } }, orderBy: { order: "asc" } } } },
      results: { select: { athleteId: true, metricTypeId: true, value: true } },
    },
  });
  if (!session || session.protocol.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Session not found" });
  res.json({ session });
});

// Upsert a batch of results. Each value also creates/updates its linked
// MetricRecord so the whole analytics stack sees it; new bests hit the feed.
const resultsSchema = z.object({
  results: z.array(z.object({
    athleteId: z.string(),
    metricTypeId: z.string(),
    value: z.number().finite(),
  })).min(1).max(500),
});

evalsRouter.post("/sessions/:id/results", async (req: AuthedRequest, res) => {
  const parsed = resultsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const session = await prisma.evalSession.findUnique({
    where: { id: req.params.id },
    include: { protocol: { include: { items: true } } },
  });
  if (!session || session.protocol.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Session not found" });

  const allowedMetrics = new Set(session.protocol.items.map((i) => i.metricTypeId));
  const athleteIds = [...new Set(parsed.data.results.map((r) => r.athleteId))];
  const validAthletes = new Set(
    (await prisma.athlete.findMany({ where: { id: { in: athleteIds }, orgId: req.auth!.orgId }, select: { id: true } })).map((a) => a.id)
  );
  const metricTypes = new Map(
    (await prisma.metricType.findMany({ where: { id: { in: [...allowedMetrics] } } })).map((m) => [m.id, m])
  );

  let saved = 0;
  for (const r of parsed.data.results) {
    if (!allowedMetrics.has(r.metricTypeId) || !validAthletes.has(r.athleteId)) continue;

    const existing = await prisma.evalResult.findUnique({
      where: { sessionId_athleteId_metricTypeId: { sessionId: session.id, athleteId: r.athleteId, metricTypeId: r.metricTypeId } },
    });

    if (existing) {
      await prisma.evalResult.update({ where: { id: existing.id }, data: { value: r.value } });
      if (existing.metricRecordId) {
        await prisma.metricRecord.update({ where: { id: existing.metricRecordId }, data: { value: r.value } });
      }
    } else {
      const record = await prisma.metricRecord.create({
        data: {
          athleteId: r.athleteId,
          metricTypeId: r.metricTypeId,
          value: r.value,
          source: "EVAL",
          recordedAt: session.date,
          notes: `Testing: ${session.protocol.name}`,
        },
      });
      await prisma.evalResult.create({
        data: { sessionId: session.id, athleteId: r.athleteId, metricTypeId: r.metricTypeId, value: r.value, metricRecordId: record.id },
      });
      const mt = metricTypes.get(r.metricTypeId);
      if (mt) await maybeMetricPR(r.athleteId, mt, r.value, record.id).catch(() => {});
    }
    saved += 1;
  }
  res.json({ saved });
});
