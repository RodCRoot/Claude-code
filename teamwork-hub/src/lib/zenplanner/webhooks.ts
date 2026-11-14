import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { integrations, zpWebhookEvents, type ZpWebhookFeed } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { createBatch, validateBatch } from "@/lib/imports/batches";
import { missingRequired } from "@/lib/imports/mapping";
import { getSchema } from "@/lib/imports/schemas";
import { webhookOrg } from "@/lib/messaging/inbound";

/**
 * Receiver for Zen Planner's three outbound webhook feeds (People, Class Sessions,
 * Attendance / RSVP), for the transition period.
 *
 * WHAT IS UNVERIFIED: Zen Planner's webhook screen takes a URL, an Account ID and a Shared
 * Secret. How the secret is presented (a header, a query value, or a signature over the body) and
 * the payload shape are not documented in the account map and have never been observed. So this
 * receiver accepts the shared secret as a header or a query value (configurable), stores each
 * delivery for inspection, and does NOT claim to verify an HMAC signature. Check the first real
 * delivery on Settings → Integrations before relying on it.
 *
 * It only ever receives. Nothing here calls Zen Planner or writes anything back to it.
 */
export const ZP_FEEDS: { feed: ZpWebhookFeed; label: string; schemaId: string | null }[] = [
  { feed: "people", label: "People", schemaId: "zenplanner.person_grid" },
  { feed: "class-sessions", label: "Class Sessions", schemaId: null },
  { feed: "attendance", label: "Attendance / RSVP", schemaId: "zenplanner.attendance_grid" },
];

export const ZP_WEBHOOK_SECRET_ENV = "ZENPLANNER_WEBHOOK_SECRET";
const MAX_BODY_BYTES = 1024 * 1024;

export type ZpWebhookConfig = {
  enabled: boolean;
  /** Where Zen Planner presents the shared secret. */
  secretIn: "header" | "query";
  /** Header or query parameter name carrying the secret. */
  secretName: string;
  /** Optional: reject deliveries that state a different Account ID. */
  accountId: string | null;
  /** Deliveries allowed per feed per minute. */
  perMinute: number;
};

export const DEFAULT_ZP_WEBHOOK_CONFIG: ZpWebhookConfig = { enabled: false, secretIn: "header", secretName: "x-zp-shared-secret", accountId: null, perMinute: 120 };

export function zpWebhookConfigFrom(config: Record<string, unknown> | null | undefined): ZpWebhookConfig {
  const w = ((config ?? {}).webhooks ?? {}) as Partial<ZpWebhookConfig>;
  return {
    enabled: w.enabled === true,
    secretIn: w.secretIn === "query" ? "query" : "header",
    secretName: typeof w.secretName === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(w.secretName) ? w.secretName : w.secretIn === "query" ? "secret" : DEFAULT_ZP_WEBHOOK_CONFIG.secretName,
    accountId: typeof w.accountId === "string" && w.accountId.trim() ? w.accountId.trim().slice(0, 100) : null,
    perMinute: Number.isInteger(w.perMinute) && (w.perMinute as number) > 0 && (w.perMinute as number) <= 6000 ? (w.perMinute as number) : DEFAULT_ZP_WEBHOOK_CONFIG.perMinute,
  };
}

export async function zpWebhookConfig(tx: Tx | DB, orgId: string): Promise<ZpWebhookConfig> {
  const [row] = await tx.select({ config: integrations.config }).from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "zenplanner")));
  return zpWebhookConfigFrom(row?.config);
}

export async function saveZpWebhookConfig(tx: Tx, v: Viewer, input: Partial<ZpWebhookConfig>) {
  assertCan(v, "integrations.manage");
  const [row] = await tx.select().from(integrations).where(and(eq(integrations.orgId, v.orgId), eq(integrations.provider, "zenplanner"))).for("update");
  const before = zpWebhookConfigFrom(row?.config);
  if (input.secretName != null && !/^[A-Za-z0-9_-]{1,64}$/.test(input.secretName)) throw new UserError("The header or parameter name may only contain letters, digits, dashes and underscores.", { secretName: "Letters, digits, - and _ only" });
  const next = zpWebhookConfigFrom({ webhooks: { ...before, ...input } });
  if (next.enabled && !process.env[ZP_WEBHOOK_SECRET_ENV]) throw new UserError(`Set the ${ZP_WEBHOOK_SECRET_ENV} server variable before turning the receiver on.`);
  if (row) await tx.update(integrations).set({ config: { ...row.config, webhooks: next } }).where(eq(integrations.id, row.id));
  else await tx.insert(integrations).values({ orgId: v.orgId, provider: "zenplanner", status: "not_configured", config: { webhooks: next } });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.webhook_config", "organization", v.orgId, {
    summary: `Zen Planner webhook receiver ${next.enabled ? "on" : "off"} (secret as ${next.secretIn} "${next.secretName}")`,
    before,
    after: next,
  });
  return next;
}

/** Constant-time comparison (hashing first so length differences leak nothing). */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const SENSITIVE_KEY = /pass(word)?|secret|token|ssn|social.?security|card|cvv|cvc|routing|account.?(number|no)|bank|autopay.?account|medic|allerg|special.?needs|health|diagnos/i;

/** Remove obviously sensitive fields (credentials, payment details, health) before a payload is stored. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, 2000).map((x) => redactPayload(x, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[removed]" : redactPayload(val, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}…`;
  return value;
}

/** Per-process fixed window. Good enough to blunt a runaway sender or secret guessing; not a distributed limiter. */
const windows = new Map<string, { start: number; n: number }>();
export function rateOk(key: string, perMinute: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, n: 1 });
    return true;
  }
  w.n++;
  return w.n <= perMinute;
}
export function resetRateLimits() {
  windows.clear();
}

export type ZpWebhookRequest = { feed: string; raw: string; headers: Headers; url: string; orgSlug?: string | null };
export type ZpWebhookResponse = { status: number; body: Record<string, unknown> };

/** The records inside a delivery: an array, or an object wrapping one, or a single record. */
export function recordsOf(payload: unknown): Record<string, unknown>[] {
  const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (Array.isArray(payload)) return payload.filter(isRec);
  if (!isRec(payload)) return [];
  for (const k of ["data", "records", "items", "people", "persons", "attendance", "attendances", "sessions", "classSessions", "results"]) {
    const v = payload[k];
    if (Array.isArray(v)) return v.filter(isRec);
    if (isRec(v) && k === "data") return [v];
  }
  return [payload];
}

export async function ingestZpWebhook(db: DB, req: ZpWebhookRequest): Promise<ZpWebhookResponse> {
  const def = ZP_FEEDS.find((f) => f.feed === req.feed);
  if (!def) return { status: 404, body: { error: "Unknown feed" } };
  const org = await webhookOrg(db as unknown as Tx, req.orgSlug);
  if (!org) return { status: 404, body: { error: "Not found" } };
  const cfg = await zpWebhookConfig(db, org.id);
  // Off by default: behave as if the route did not exist, and store nothing.
  if (!cfg.enabled) return { status: 404, body: { error: "Not found" } };
  const expected = process.env[ZP_WEBHOOK_SECRET_ENV];
  if (!expected) return { status: 503, body: { error: "Receiver not configured" } };
  if (!rateOk(`${org.id}:${def.feed}`, cfg.perMinute)) return { status: 429, body: { error: "Too many requests" } };

  const url = new URL(req.url);
  const provided = cfg.secretIn === "query" ? url.searchParams.get(cfg.secretName) : req.headers.get(cfg.secretName);
  if (!secretMatches(provided, expected)) return { status: 401, body: { error: "Unauthorized" } };
  if (Buffer.byteLength(req.raw, "utf8") > MAX_BODY_BYTES) return { status: 413, body: { error: "Payload too large" } };

  let payload: unknown;
  try {
    payload = JSON.parse(req.raw);
  } catch {
    return { status: 400, body: { error: "Body is not JSON" } };
  }
  if (cfg.accountId) {
    const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    const stated = req.headers.get("x-zp-account-id") ?? url.searchParams.get("accountId") ?? (typeof p.accountId === "string" ? p.accountId : typeof p.AccountId === "string" ? p.AccountId : null);
    if (stated && stated !== cfg.accountId) return { status: 401, body: { error: "Unauthorized" } };
  }
  const dedupeKey = createHash("sha256").update(def.feed).update("\u0001").update(req.raw).digest("hex");
  const records = recordsOf(payload);
  const inserted = await db
    .insert(zpWebhookEvents)
    .values({
      orgId: org.id,
      feed: def.feed,
      dedupeKey,
      payload: redactPayload(payload),
      status: def.schemaId ? "received" : "stored",
      records: records.length,
      note: def.schemaId ? null : "No import for this feed yet; kept for inspection only.",
    })
    .onConflictDoNothing()
    .returning({ id: zpWebhookEvents.id });
  // A redelivery of the same body is acknowledged and changes nothing.
  return { status: 200, body: { ok: true, duplicate: inserted.length === 0 } };
}

export type ZpFeedStatus = { feed: ZpWebhookFeed; label: string; path: string; total: number; last24h: number; waiting: number; lastReceivedAt: Date | null; importable: boolean };

export async function zpWebhookStatus(tx: Tx | DB, v: Viewer): Promise<ZpFeedStatus[]> {
  assertCan(v, "integrations.manage");
  const since = new Date(Date.now() - 86_400_000);
  const rows = await tx
    .select({
      feed: zpWebhookEvents.feed,
      total: sql<number>`count(*)::int`,
      last24h: sql<number>`count(*) filter (where ${gte(zpWebhookEvents.receivedAt, since)})::int`,
      waiting: sql<number>`count(*) filter (where ${zpWebhookEvents.status} = 'received')::int`,
      last: sql<Date | null>`max(${zpWebhookEvents.receivedAt})`,
    })
    .from(zpWebhookEvents)
    .where(eq(zpWebhookEvents.orgId, v.orgId))
    .groupBy(zpWebhookEvents.feed);
  return ZP_FEEDS.map((f) => {
    const r = rows.find((x) => x.feed === f.feed);
    return { feed: f.feed, label: f.label, path: `/api/webhooks/zenplanner/${f.feed}`, total: r?.total ?? 0, last24h: r?.last24h ?? 0, waiting: r?.waiting ?? 0, lastReceivedAt: r?.last ? new Date(r.last) : null, importable: !!f.schemaId };
  });
}

export async function recentZpWebhookEvents(tx: Tx | DB, v: Viewer, limit = 10) {
  assertCan(v, "integrations.manage");
  return tx.select().from(zpWebhookEvents).where(eq(zpWebhookEvents.orgId, v.orgId)).orderBy(desc(zpWebhookEvents.receivedAt)).limit(limit);
}

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Flatten one level of nesting ("person": { "firstName": … } → "firstName") without overwriting top-level keys. */
function flat(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (!(k2 in out) && (v2 === null || typeof v2 !== "object")) out[k2] = v2;
    } else if (Array.isArray(v)) out[k] = v.filter((x) => x === null || typeof x !== "object").join("; ");
    else out[k] = v;
  }
  return out;
}

/**
 * Turn the waiting deliveries of one feed into a normal Import Center batch (same presets,
 * identity review, coverage confirmation, commit and revert as a CSV upload). Never auto-commits.
 */
export async function stageZpWebhookEvents(tx: Tx, v: Viewer, feed: string): Promise<{ batchId: string; events: number; records: number; validated: boolean }> {
  assertCan(v, "imports.manage");
  const def = ZP_FEEDS.find((f) => f.feed === feed);
  if (!def?.schemaId) throw new UserError("That feed has no import yet; its deliveries are kept for inspection only.");
  const events = await tx
    .select()
    .from(zpWebhookEvents)
    .where(and(eq(zpWebhookEvents.orgId, v.orgId), eq(zpWebhookEvents.feed, def.feed), eq(zpWebhookEvents.status, "received")))
    .orderBy(asc(zpWebhookEvents.receivedAt))
    .limit(2000)
    .for("update");
  const records = events.flatMap((e) => recordsOf(e.payload)).map(flat);
  if (!records.length) throw new UserError("Nothing is waiting for that feed.");
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))].filter((h) => !SENSITIVE_KEY.test(h));
  const csv = [headers.map(csvCell).join(","), ...records.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { batch } = await createBatch(tx, v, { filename: `zenplanner-webhook-${def.feed}-${stamp}.csv`, bytes: new TextEncoder().encode(csv), schemaId: def.schemaId });
  await tx.update(zpWebhookEvents).set({ status: "staged", importBatchId: batch.id }).where(inArray(zpWebhookEvents.id, events.map((e) => e.id)));
  // Validate straight away when the payload's field names were recognized; otherwise staff map the columns first.
  const validated = missingRequired(getSchema(def.schemaId), batch.mapping).length === 0;
  if (validated) await validateBatch(tx, v, batch.id);
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.webhook_staged", "import_batch", batch.id, {
    summary: `Staged ${events.length} Zen Planner ${def.label} webhook deliver${events.length === 1 ? "y" : "ies"} (${records.length} records) for review`,
  });
  return { batchId: batch.id, events: events.length, records: records.length, validated };
}
