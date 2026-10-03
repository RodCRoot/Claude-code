// Shared device-sync core: pulls from a provider adapter, matches results to
// the org's roster + metric catalog, dedupes by the provider's external id,
// writes MetricRecords (celebrating PRs), and stamps the org's config.
// Used by the integrations API route and the hourly auto-sync scheduler.
import { prisma } from "./db";
import { DeviceAdapter, ProviderAuth } from "./integrations";
import { maybeMetricPR } from "./feed";

export interface SyncSummary {
  provider: string;
  mode: "live" | "sample";
  fetched: number;
  created: number;
  skipped: number;
  unmatchedAthlete: number;
  unknownMetric: number;
  errors: number;
  unmatchedNames: string[];
}

export async function runProviderSync(
  orgId: string,
  adapter: DeviceAdapter,
  opts: { sample?: boolean; since?: Date; auth?: ProviderAuth } = {}
): Promise<SyncSummary> {
  const live = !opts.sample && (!!opts.auth?.token || adapter.configured());
  const external = await adapter.fetch({ since: opts.since, sample: !live, auth: opts.auth });

  const athletes = await prisma.athlete.findMany({
    where: { orgId },
    select: { id: true, firstName: true, lastName: true },
  });
  const athleteByName = new Map(athletes.map((a) => [`${a.firstName} ${a.lastName}`.toLowerCase(), a.id]));
  const metricTypes = await prisma.metricType.findMany();
  const metricByKey = new Map(metricTypes.map((m) => [m.key, m]));

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

  const summary: SyncSummary = {
    provider: adapter.key, mode: live ? "live" : "sample",
    fetched: external.length, created: 0, skipped: 0,
    unmatchedAthlete: 0, unknownMetric: 0, errors: 0, unmatchedNames: [],
  };
  const unmatched = new Set<string>();

  for (const rec of external) {
    if (seen.has(rec.externalId)) { summary.skipped++; continue; }
    const athleteId = athleteByName.get(rec.athleteName.toLowerCase());
    if (!athleteId) { summary.unmatchedAthlete++; unmatched.add(rec.athleteName); continue; }
    const metric = metricByKey.get(rec.metricKey);
    if (!metric) { summary.unknownMetric++; continue; }

    try {
      const record = await prisma.metricRecord.create({
        data: {
          athleteId,
          metricTypeId: metric.id,
          value: rec.value,
          source: adapter.key,
          recordedAt: new Date(rec.recordedAt),
          rawJson: JSON.stringify({ externalId: rec.externalId, payload: rec.raw }),
        },
      });
      seen.add(rec.externalId);
      summary.created++;
      // Body mass isn't a performance PR; everything else can hit the feed.
      if (metric.key !== "body_mass") {
        await maybeMetricPR(athleteId, metric, rec.value, record.id).catch(() => {});
      }
    } catch (e) {
      summary.errors++;
      console.error(`Sync ${adapter.key} record ${rec.externalId} failed:`, e);
    }
  }
  summary.unmatchedNames = [...unmatched];
  return summary;
}

// Run a live sync for one org's stored provider config and stamp the result.
export async function syncFromConfig(configId: string): Promise<SyncSummary | null> {
  const cfg = await prisma.integrationConfig.findUnique({ where: { id: configId } });
  if (!cfg) return null;
  const { getAdapter } = await import("./integrations");
  const adapter = getAdapter(cfg.provider);
  if (!adapter) return null;
  const summary = await runProviderSync(cfg.orgId, adapter, {
    since: cfg.lastSyncAt ?? undefined,
    auth: { token: cfg.refreshToken, region: cfg.region },
  });
  await prisma.integrationConfig.update({
    where: { id: cfg.id },
    data: {
      lastSyncAt: new Date(),
      lastSyncNote: `${summary.created} new, ${summary.skipped} known, ${summary.unmatchedAthlete} unmatched`,
    },
  });
  return summary;
}

// Hourly auto-sync for every org that opted in. Fire-and-forget per config so
// one bad token never blocks the others. unref() keeps tests/CLIs exiting.
export function startAutoSync(intervalMs = 60 * 60_000) {
  const timer = setInterval(async () => {
    try {
      const configs = await prisma.integrationConfig.findMany({ where: { autoSync: true } });
      for (const cfg of configs) {
        syncFromConfig(cfg.id).catch((e) => console.error(`Auto-sync ${cfg.provider} (${cfg.orgId}):`, e.message));
      }
    } catch (e) {
      console.error("Auto-sync sweep failed:", (e as Error).message);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
