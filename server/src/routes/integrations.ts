import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { adapters, getAdapter } from "../integrations";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);
integrationsRouter.use(requireRole("ADMIN", "COACH"));

// List available device integrations and whether each is configured.
integrationsRouter.get("/", (_req, res) => {
  res.json({
    integrations: adapters.map((a) => ({
      key: a.key,
      name: a.name,
      configured: a.configured(),
      credentialEnv: a.credentialEnv,
    })),
  });
});

const syncSchema = z.object({
  sample: z.boolean().optional(),
  since: z.string().optional(),
});

// Pull results from a provider and store them as metric records. Idempotent:
// records already imported (matched by the provider's external id) are skipped.
integrationsRouter.post("/:provider/sync", async (req: AuthedRequest, res) => {
  const adapter = getAdapter(req.params.provider);
  if (!adapter) return res.status(404).json({ error: "Unknown integration" });
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { sample, since } = parsed.data;

  let external;
  try {
    external = await adapter.fetch({ sample, since: since ? new Date(since) : undefined });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  // Build lookup tables for matching to our roster + metric catalog.
  const orgId = req.auth!.orgId;
  const athletes = await prisma.athlete.findMany({
    where: { orgId },
    select: { id: true, firstName: true, lastName: true },
  });
  const athleteByName = new Map(athletes.map((a) => [`${a.firstName} ${a.lastName}`.toLowerCase(), a.id]));
  const metricTypes = await prisma.metricType.findMany({ select: { id: true, key: true } });
  const metricByKey = new Map(metricTypes.map((m) => [m.key, m.id]));

  // Existing external ids for this provider (dedupe).
  const existing = await prisma.metricRecord.findMany({
    where: { athleteId: { in: athletes.map((a) => a.id) }, source: adapter.key },
    select: { rawJson: true },
  });
  const seen = new Set<string>();
  for (const r of existing) {
    try {
      const id = r.rawJson ? JSON.parse(r.rawJson).externalId : null;
      if (id) seen.add(id);
    } catch { /* ignore malformed */ }
  }

  let created = 0,
    skipped = 0,
    unmatchedAthlete = 0,
    unknownMetric = 0;
  const unmatchedNames = new Set<string>();

  for (const rec of external) {
    if (seen.has(rec.externalId)) { skipped++; continue; }
    const athleteId = athleteByName.get(rec.athleteName.toLowerCase());
    if (!athleteId) { unmatchedAthlete++; unmatchedNames.add(rec.athleteName); continue; }
    const metricTypeId = metricByKey.get(rec.metricKey);
    if (!metricTypeId) { unknownMetric++; continue; }

    await prisma.metricRecord.create({
      data: {
        athleteId,
        metricTypeId,
        value: rec.value,
        source: adapter.key,
        recordedAt: new Date(rec.recordedAt),
        rawJson: JSON.stringify({ externalId: rec.externalId, payload: rec.raw }),
      },
    });
    seen.add(rec.externalId);
    created++;
  }

  res.json({
    provider: adapter.key,
    mode: sample ? "sample" : adapter.configured() ? "live" : "sample",
    fetched: external.length,
    created,
    skipped,
    unmatchedAthlete,
    unknownMetric,
    unmatchedNames: [...unmatchedNames],
  });
});
