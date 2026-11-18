import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { importRows, integrations, rawSignals, syncRuns, trials } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { saveObject } from "@/lib/storage";
import { localYmd } from "@/lib/time";
import { commitBatch, confirmCoverage, createBatch, orgTimezone, validateBatch } from "@/lib/imports/batches";
import { splitHeaderUnit } from "@/lib/imports/normalize";
import { HAWKIN_ENV_VARS, HawkinClient, HawkinError, hawkinClientFromEnv, type HawkinAthlete, type HawkinTest } from "./client";
import { hawkinIntegration, SYNC_MODE_OPTION, SYNC_RUN_OPTION, SYNC_TO_OPTION } from "./checkpoint";

export type HawkinSyncOptions = { mode: "incremental" } | { mode: "historical"; from: Date; to: Date; chunkDays?: number };

export type HawkinSyncDeps = {
  client?: HawkinClient | null;
  now?: () => Date;
  /** Commit automatically when no row needs identity review (default: integration config autoCommit). */
  autoCommit?: boolean;
  /** Archive raw force-time curves for committed tests (default: integration config fetchForceTime). */
  fetchForceTime?: boolean;
};

export type HawkinSyncResult =
  | { status: "not_configured"; envVars: string[] }
  | {
      status: "succeeded" | "awaiting_review" | "failed" | "no_changes";
      syncRunId: string;
      batchId: string | null;
      fetched: number;
      kept: number;
      warnings: string[];
      error?: string;
    };

/** Top-level test keys that are not metrics. Anything else without a "(unit)" is reported. */
const NON_METRIC_KEYS = new Set(["id", "timestamp", "segment", "testType", "athlete", "active", "tags", "lastSyncTime", "lastTestTime", "external", "metrics", "teams", "groups", "createdAt", "updatedAt"]);

export type FlatRow = Record<string, unknown>;

/** Flatten one API test into the same column shape as a Hawkin Cloud CSV export. */
export function flattenTest(t: HawkinTest, athletesById: Map<string, HawkinAthlete>): { row: FlatRow; metricHeaders: string[]; unknownFields: string[] } {
  const a = (t.athlete && typeof t.athlete === "object" ? t.athlete : null) ?? (typeof t.athlete === "string" ? athletesById.get(t.athlete) : undefined);
  const known = a?.id ? (athletesById.get(String(a.id)) ?? a) : a;
  const row: FlatRow = {
    "Test ID": t.id,
    "Athlete ID": known?.id ?? null,
    Athlete: known?.name ?? null,
    "Athlete Active": known?.active ?? null,
    "Test Type": t.testType?.name ?? null,
    "Test Type ID": t.testType?.id ?? t.testType?.canonicalId ?? null,
    Timestamp: t.timestamp,
    Active: t.active ?? true,
    Segment: t.segment ?? null,
  };
  const metricHeaders: string[] = [];
  const unknownFields: string[] = [];
  if (Array.isArray(t.metrics)) {
    for (const m of t.metrics as { metricId?: string; metricLabel?: string; metricUnits?: string; metricValue?: unknown }[]) {
      const h = `${m.metricLabel ?? m.metricId}(${m.metricUnits ?? ""})`;
      row[h] = m.metricValue ?? null;
      metricHeaders.push(h);
    }
  }
  for (const [k, val] of Object.entries(t)) {
    if (NON_METRIC_KEYS.has(k)) continue;
    if (splitHeaderUnit(k)) {
      row[k] = val ?? null;
      metricHeaders.push(k);
    } else unknownFields.push(k);
  }
  row._payload = t;
  return { row, metricHeaders, unknownFields };
}

/** Compare metric fields against what we've seen before for each test type. */
export function detectSchemaChanges(
  flat: { row: FlatRow; metricHeaders: string[]; unknownFields: string[] }[],
  knownByType: Record<string, string[]>,
  vendorMetricLabels: Set<string> | null,
): { warnings: string[]; seenByType: Record<string, string[]> } {
  const warnings = new Set<string>();
  const seen: Record<string, Set<string>> = {};
  for (const f of flat) {
    const type = String(f.row["Test Type"] ?? "unknown");
    seen[type] ??= new Set();
    for (const h of f.metricHeaders) {
      seen[type].add(h);
      const known = knownByType[type];
      if (known && !known.includes(h)) warnings.add(`New metric field "${h}" for ${type} (not seen in earlier syncs).`);
      const label = splitHeaderUnit(h)?.label;
      if (vendorMetricLabels && label && vendorMetricLabels.size && !vendorMetricLabels.has(label.toLowerCase())) warnings.add(`Metric field "${h}" is not in Hawkin's /metrics dictionary.`);
    }
    for (const u of f.unknownFields) warnings.add(`Unrecognized field "${u}" (not imported; preserved in the trial's raw payload).`);
  }
  for (const [type, set] of Object.entries(seen)) {
    for (const h of knownByType[type] ?? []) if (!set.has(h)) warnings.add(`Expected metric field "${h}" missing for ${type}.`);
  }
  return { warnings: [...warnings], seenByType: Object.fromEntries(Object.entries(seen).map(([k, s]) => [k, [...s].sort()])) };
}

type Filters = { testTypeIds?: string[]; athleteIds?: string[]; teamIds?: string[]; groupIds?: string[] };

function idList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as { id?: unknown }).id) : String(x)));
  return [String(v)];
}

/**
 * Filters are applied here, in our backend, because the Hawkin API does not allow
 * syncFrom/syncTo together with athlete/team/group/test-type filters.
 */
export function filterTests(tests: HawkinTest[], f: Filters, athletesById: Map<string, HawkinAthlete>): HawkinTest[] {
  const any = f.testTypeIds?.length || f.athleteIds?.length || f.teamIds?.length || f.groupIds?.length;
  if (!any) return tests;
  return tests.filter((t) => {
    const aId = typeof t.athlete === "object" && t.athlete ? String(t.athlete.id) : String(t.athlete ?? "");
    const a = athletesById.get(aId) ?? (typeof t.athlete === "object" ? t.athlete : undefined);
    if (f.testTypeIds?.length && !f.testTypeIds.includes(String(t.testType?.id ?? "")) && !f.testTypeIds.includes(String(t.testType?.canonicalId ?? ""))) return false;
    if (f.athleteIds?.length && !f.athleteIds.includes(aId)) return false;
    if (f.teamIds?.length && !idList(a?.teams).some((x) => f.teamIds!.includes(x))) return false;
    if (f.groupIds?.length && !idList(a?.groups).some((x) => f.groupIds!.includes(x))) return false;
    return true;
  });
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

export function historicalWindows(from: Date, to: Date, chunkDays = 30): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const step = chunkDays * 86_400;
  for (let s = sec(from); s < sec(to); s += step) out.push({ from: s, to: Math.min(sec(to), s + step) });
  return out;
}

export async function runHawkinSync(db: DB, v: Viewer, opts: HawkinSyncOptions, deps: HawkinSyncDeps = {}): Promise<HawkinSyncResult> {
  assertCan(v, "imports.manage");
  const now = deps.now ?? (() => new Date());
  const client = deps.client === undefined ? hawkinClientFromEnv() : deps.client;
  const integ = await hawkinIntegration(db, v.orgId);
  if (!client) {
    await db.update(integrations).set({ status: "not_configured", lastCheckedAt: now() }).where(eq(integrations.id, integ.id));
    return { status: "not_configured", envVars: HAWKIN_ENV_VARS };
  }
  const cp = (integ.checkpoint ?? {}) as Record<string, unknown>;
  const config = (integ.config ?? {}) as Record<string, unknown>;
  let syncFrom: number | null = null;
  if (opts.mode === "incremental") {
    syncFrom = Number(cp.lastSyncTime ?? cp.historicalThrough ?? NaN);
    if (!Number.isFinite(syncFrom)) throw new UserError("No sync checkpoint yet. Run a historical import (date window) first.");
  } else if (!(opts.from < opts.to)) throw new UserError("Historical window: start must be before end.");
  const syncTo = sec(now());

  const [run] = await db
    .insert(syncRuns)
    .values({ orgId: v.orgId, provider: "hawkin", kind: opts.mode, status: "running", cursorBefore: cp })
    .returning({ id: syncRuns.id });

  try {
    const athletes = await client.athletes(true);
    const athletesById = new Map(athletes.map((a) => [String(a.id), a]));
    let vendorLabels: Set<string> | null = null;
    const warnings: string[] = [];
    try {
      const metrics = await client.metrics();
      vendorLabels = new Set(metrics.map((m) => String(m.label ?? m.metricLabel ?? m.name ?? "").toLowerCase()).filter(Boolean));
    } catch {
      warnings.push("Could not read Hawkin's /metrics dictionary; metric names were not cross-checked.");
    }

    let tests: HawkinTest[] = [];
    let lastSyncTime: number | null = null;
    if (opts.mode === "historical") {
      for (const w of historicalWindows(opts.from, opts.to, opts.chunkDays ?? 30)) {
        const r = await client.tests({ from: w.from, to: w.to, includeInactive: true });
        tests.push(...r.tests);
      }
    } else {
      const r = await client.tests({ syncFrom: syncFrom!, syncTo, includeInactive: true });
      tests = r.tests;
      lastSyncTime = r.lastSyncTime;
    }
    const fetched = tests.length;
    tests = filterTests(tests, (config.filters ?? {}) as Filters, athletesById);
    const flat = tests.map((t) => flattenTest(t, athletesById));
    const change = detectSchemaChanges(flat, (config.knownMetricFields ?? {}) as Record<string, string[]>, vendorLabels);
    warnings.push(...change.warnings);
    const inactiveAthletes = new Set(flat.filter((f) => f.row["Athlete Active"] === false).map((f) => String(f.row["Athlete ID"]))).size;
    const checkpointValue = opts.mode === "incremental" ? (lastSyncTime ?? syncTo) : sec(opts.to);
    const counts = { fetched, kept: tests.length, inactiveAthletes, warnings: warnings.length, athletes: athletes.length };

    if (!tests.length) {
      await db.transaction(async (tx) => {
        const next = { ...cp, ...(opts.mode === "incremental" ? { lastSyncTime: checkpointValue } : { historicalThrough: Math.max(Number(cp.historicalThrough ?? 0), checkpointValue) }) };
        await tx.update(integrations).set({ status: "connected", lastCheckedAt: now(), lastError: null, checkpoint: next }).where(eq(integrations.id, integ.id));
        await tx.update(syncRuns).set({ status: "succeeded", finishedAt: now(), counts, cursorAfter: { ...next, warnings } }).where(eq(syncRuns.id, run.id));
      });
      return { status: "no_changes", syncRunId: run.id, batchId: null, fetched, kept: 0, warnings };
    }

    const autoCommit = deps.autoCommit ?? config.autoCommit === true;
    const result = await db.transaction(async (tx) => {
      const bytes = new TextEncoder().encode(JSON.stringify(flat.map((f) => f.row)));
      const { batch } = await createBatch(tx, v, {
        filename: `hawkin-${opts.mode}-${new Date(syncTo * 1000).toISOString().replace(/[:.]/g, "-")}.json`,
        bytes,
        schemaId: "hawkin.api_tests",
        source: "hawkin_api",
        extraMapping: { [SYNC_TO_OPTION]: String(checkpointValue), [SYNC_MODE_OPTION]: opts.mode, [SYNC_RUN_OPTION]: run.id },
      });
      const stats = await validateBatch(tx, v, batch.id);
      const tz = await orgTimezone(tx, v.orgId);
      const coverage =
        opts.mode === "historical"
          ? { start: localYmd(opts.from, tz), end: localYmd(opts.to, tz) }
          : {
              start: localYmd(new Date(Math.min(...tests.map((t) => t.timestamp)) * 1000), tz),
              end: localYmd(new Date(Math.max(...tests.map((t) => t.timestamp)) * 1000), tz),
            };
      await confirmCoverage(tx, v, batch.id, coverage.start, coverage.end, opts.mode === "incremental" ? `Incremental sync of tests created or modified since ${new Date(syncFrom! * 1000).toISOString()}.` : `Historical window by test creation date.`);
      let committed = false;
      if (autoCommit && !stats.needs_review) {
        await commitBatch(tx, v, batch.id);
        committed = true;
      }
      await tx
        .update(syncRuns)
        .set({
          status: committed ? "succeeded" : "partial",
          finishedAt: now(),
          counts: { ...counts, needsReview: stats.needs_review ?? 0, invalid: stats.status_invalid ?? 0 },
          cursorAfter: { pendingCheckpoint: checkpointValue, warnings, ...(committed ? {} : { note: "Checkpoint advances when the import batch is committed." }) },
          importBatchId: batch.id,
        })
        .where(eq(syncRuns.id, run.id));
      await tx
        .update(integrations)
        .set({ status: "connected", lastCheckedAt: now(), lastError: null, config: { ...config, knownMetricFields: { ...((config.knownMetricFields as object) ?? {}), ...change.seenByType } } })
        .where(eq(integrations.id, integ.id));
      await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "hawkin.sync", "sync_run", run.id, {
        summary: `Hawkin ${opts.mode} sync: ${fetched} fetched, ${tests.length} kept, ${committed ? "committed" : "awaiting review"}`,
        after: { counts, warnings: warnings.slice(0, 50) },
      });
      return { batchId: batch.id, committed };
    });

    if (result.committed && (deps.fetchForceTime ?? config.fetchForceTime === true)) {
      const ft = await archiveForceTime(db, v, client, result.batchId);
      if (ft.failed) warnings.push(`${ft.failed} force-time file(s) could not be fetched.`);
    }
    return { status: result.committed ? "succeeded" : "awaiting_review", syncRunId: run.id, batchId: result.batchId, fetched, kept: tests.length, warnings };
  } catch (e) {
    const msg = e instanceof HawkinError || e instanceof UserError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
    await db.update(syncRuns).set({ status: "failed", finishedAt: now(), error: msg.slice(0, 1000) }).where(eq(syncRuns.id, run.id));
    await db.update(integrations).set({ status: "error", lastCheckedAt: now(), lastError: msg.slice(0, 1000) }).where(eq(integrations.id, integ.id));
    return { status: "failed", syncRunId: run.id, batchId: null, fetched: 0, kept: 0, warnings: [], error: msg };
  }
}

/**
 * Archive raw force-time curves (GET /api/v1/forcetime/{id}, documented as 1000 Hz) for trials
 * committed by a Hawkin API batch, as raw_signals + stored objects owned by that batch (so revert removes them).
 */
export async function archiveForceTime(db: DB, v: Viewer, client: HawkinClient, batchId: string) {
  assertCan(v, "imports.manage");
  const rows = await db.select().from(importRows).where(and(eq(importRows.batchId, batchId), eq(importRows.status, "committed")));
  let archived = 0;
  let failed = 0;
  for (const r of rows) {
    const trialIds = r.createdEntities.filter((c) => c.type === "trial").map((c) => c.id);
    if (!trialIds.length || !r.sourceRecordId || /^(syn|avg):/.test(r.sourceRecordId)) continue;
    let payload: Record<string, unknown>;
    try {
      payload = await client.forceTime(r.sourceRecordId);
    } catch {
      failed++;
      continue;
    }
    await db.transaction(async (tx: Tx) => {
      const [t] = await tx.select({ id: trials.id }).from(trials).where(inArray(trials.id, trialIds)).limit(1);
      if (!t) return;
      const series = Object.entries(payload).filter(([, val]) => Array.isArray(val)) as [string, unknown[]][];
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const obj = await saveObject(tx, { orgId: v.orgId, bytes, filename: `hawkin-forcetime-${r.sourceRecordId}.json`, mimeType: "application/json", kind: "raw_signal", uploadedBy: v.userId });
      const [rs] = await tx
        .insert(rawSignals)
        .values({
          orgId: v.orgId,
          trialId: t.id,
          objectId: obj.id,
          sampleRateHz: 1000,
          channels: series.map(([name]) => ({ name, unit: /force/i.test(name) ? "N" : /velocity/i.test(name) ? "m/s" : /power/i.test(name) ? "W" : /time/i.test(name) ? "s" : /displacement/i.test(name) ? "m" : "unknown" })),
          sampleCount: series.length ? Math.max(...series.map(([, a]) => a.length)) : null,
        })
        .returning({ id: rawSignals.id });
      await tx
        .update(importRows)
        .set({ createdEntities: [...r.createdEntities, { type: "raw_signal", id: rs.id }, { type: "stored_object", id: obj.id }] })
        .where(eq(importRows.id, r.id));
      archived++;
    });
  }
  return { archived, failed };
}

export async function hawkinOverview(tx: Tx, v: Viewer) {
  assertCan(v, "imports.manage");
  const integ = await hawkinIntegration(tx, v.orgId);
  const runs = await tx.select().from(syncRuns).where(and(eq(syncRuns.orgId, v.orgId), eq(syncRuns.provider, "hawkin"))).orderBy(desc(syncRuns.startedAt)).limit(10);
  return {
    configured: !!process.env.HAWKIN_REFRESH_TOKEN,
    envVars: HAWKIN_ENV_VARS,
    baseUrl: process.env.HAWKIN_API_BASE || "https://cloud.hawkindynamics.com/api",
    integration: { status: integ.status, lastCheckedAt: integ.lastCheckedAt, lastError: integ.lastError, checkpoint: integ.checkpoint, autoCommit: integ.config?.autoCommit === true, fetchForceTime: integ.config?.fetchForceTime === true },
    runs,
  };
}

export async function setHawkinOptions(tx: Tx, v: Viewer, input: { autoCommit: boolean; fetchForceTime: boolean }) {
  assertCan(v, "integrations.manage");
  const integ = await hawkinIntegration(tx, v.orgId);
  await tx
    .update(integrations)
    .set({ config: sql`${integrations.config} || ${JSON.stringify(input)}::jsonb` })
    .where(eq(integrations.id, integ.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "hawkin.options", "integration", integ.id, { before: integ.config, after: input });
}
