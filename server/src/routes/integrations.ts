import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { adapters, getAdapter } from "../integrations";
import { runProviderSync, syncFromConfig } from "../sync";
import { HAWKIN_REGIONS } from "../integrations/hawkin";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);
integrationsRouter.use(requireRole("ADMIN", "COACH"));

const maskToken = (t: string) => (t.length <= 8 ? "••••" : `${t.slice(0, 4)}…${t.slice(-4)}`);

// List available device integrations with this org's configuration status.
integrationsRouter.get("/", async (req: AuthedRequest, res) => {
  const configs = await prisma.integrationConfig.findMany({ where: { orgId: req.auth!.orgId } });
  const byProvider = new Map(configs.map((c) => [c.provider, c]));
  res.json({
    integrations: adapters.map((a) => {
      const cfg = byProvider.get(a.key);
      return {
        key: a.key,
        name: a.name,
        configured: !!cfg || a.configured(),
        region: cfg?.region ?? null,
        regions: a.key === "HAWKIN" ? Object.keys(HAWKIN_REGIONS) : [],
        tokenMasked: cfg ? maskToken(cfg.refreshToken) : null,
        autoSync: cfg?.autoSync ?? false,
        lastSyncAt: cfg?.lastSyncAt ?? null,
        lastSyncNote: cfg?.lastSyncNote ?? null,
      };
    }),
  });
});

// Save credentials/settings for a provider (token pasted in the UI).
const configSchema = z.object({
  refreshToken: z.string().min(8).optional(),
  region: z.string().optional(),
  autoSync: z.boolean().optional(),
});
integrationsRouter.put("/:provider/config", async (req: AuthedRequest, res) => {
  const adapter = getAdapter(req.params.provider);
  if (!adapter) return res.status(404).json({ error: "Unknown integration" });
  const parsed = configSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (d.region && adapter.key === "HAWKIN" && !HAWKIN_REGIONS[d.region]) {
    return res.status(400).json({ error: `Unknown region. Use one of: ${Object.keys(HAWKIN_REGIONS).join(", ")}` });
  }

  const existing = await prisma.integrationConfig.findUnique({
    where: { orgId_provider: { orgId: req.auth!.orgId, provider: adapter.key } },
  });
  if (!existing && !d.refreshToken) return res.status(400).json({ error: "refreshToken required" });

  const cfg = existing
    ? await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: {
          ...(d.refreshToken ? { refreshToken: d.refreshToken } : {}),
          ...(d.region ? { region: d.region } : {}),
          ...(d.autoSync !== undefined ? { autoSync: d.autoSync } : {}),
        },
      })
    : await prisma.integrationConfig.create({
        data: {
          orgId: req.auth!.orgId,
          provider: adapter.key,
          refreshToken: d.refreshToken!,
          region: d.region ?? "americas",
          autoSync: d.autoSync ?? true,
        },
      });
  res.json({ ok: true, tokenMasked: maskToken(cfg.refreshToken), region: cfg.region, autoSync: cfg.autoSync });
});

integrationsRouter.delete("/:provider/config", async (req: AuthedRequest, res) => {
  const adapter = getAdapter(req.params.provider);
  if (!adapter) return res.status(404).json({ error: "Unknown integration" });
  await prisma.integrationConfig.deleteMany({ where: { orgId: req.auth!.orgId, provider: adapter.key } });
  res.json({ ok: true });
});

// Pull results. Uses the org's stored config when present (incremental via
// lastSyncAt); `sample: true` demos the flow without credentials.
const syncSchema = z.object({
  sample: z.boolean().optional(),
  since: z.string().optional(),
});
integrationsRouter.post("/:provider/sync", async (req: AuthedRequest, res) => {
  const adapter = getAdapter(req.params.provider);
  if (!adapter) return res.status(404).json({ error: "Unknown integration" });
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { sample, since } = parsed.data;

  try {
    const cfg = await prisma.integrationConfig.findUnique({
      where: { orgId_provider: { orgId: req.auth!.orgId, provider: adapter.key } },
    });
    if (cfg && !sample) {
      // Honor an explicit `since`, else incremental from the last sync.
      if (since) {
        const summary = await runProviderSync(req.auth!.orgId, adapter, {
          since: new Date(since),
          auth: { token: cfg.refreshToken, region: cfg.region },
        });
        await prisma.integrationConfig.update({
          where: { id: cfg.id },
          data: { lastSyncAt: new Date(), lastSyncNote: `${summary.created} new, ${summary.skipped} known` },
        });
        return res.json(summary);
      }
      const summary = await syncFromConfig(cfg.id);
      return res.json(summary);
    }
    const summary = await runProviderSync(req.auth!.orgId, adapter, {
      sample,
      since: since ? new Date(since) : undefined,
    });
    res.json(summary);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
