/**
 * News watch settings and sources (owner and admin). See docs/modules/newswatch.md.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { newsSources, NEWS_AUDIENCES, NEWS_SOURCE_KINDS, organizations } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { DEFAULT_TZ } from "@/lib/time";
import { cleanDomain, feedUrlProblem } from "./feed";
import { DAILY_CAP_MAX, DEFAULT_SOURCES, newsSettingsOf, SOURCE_NAME_MAX, SOURCE_URL_MAX, type NewsWatchSettings } from "./shared";

export const actorOf = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
export type NewsSource = typeof newsSources.$inferSelect;

export async function newsOrg(tx: Tx, orgId: string): Promise<{ settings: NewsWatchSettings; tz: string; orgSettings: Record<string, unknown> } | null> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return o ? { settings: newsSettingsOf(o.settings), tz: o.tz || DEFAULT_TZ, orgSettings: o.settings ?? {} } : null;
}

/**
 * Who may approve a news clip so that it can be shown: owner and admin always (`news.approve` in
 * policy.ts), plus operations and coaches when the owner switched that on in Settings. Triage
 * ("our athlete" / "not our athlete") is wider and never shows anything on its own.
 */
export function mayApproveNews(v: Viewer, s: NewsWatchSettings): boolean {
  if (can(v, "news.approve")) return true;
  if (v.role === "operations") return s.operationsMayApprove;
  if (v.role === "coach") return s.coachesMayApprove;
  return false;
}

export async function canApproveNews(tx: Tx, v: Viewer): Promise<boolean> {
  if (can(v, "news.approve")) return true;
  if (v.role !== "operations" && v.role !== "coach") return false;
  const org = await newsOrg(tx, v.orgId);
  return !!org && mayApproveNews(v, org.settings);
}

const flag = z.preprocess((x) => x === true || x === "on" || x === "true", z.boolean());

export const newsSettingsInput = z.object({
  enabled: flag,
  dailyRequestCap: z.coerce.number().int("Whole numbers only").min(1).max(DAILY_CAP_MAX),
  maxAgeDays: z.coerce.number().int("Whole numbers only").min(1).max(365),
  operationsMayApprove: flag,
  coachesMayApprove: flag,
});

/** Owner/admin only. Audited. */
export async function saveNewsSettings(tx: Tx, v: Viewer, raw: unknown): Promise<NewsWatchSettings> {
  assertCan(v, "settings.manage");
  const input = newsSettingsInput.parse(raw);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = newsSettingsOf(org.settings);
  const after: NewsWatchSettings = { ...input };
  await tx.update(organizations).set({ settings: { ...org.settings, newswatch: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "newswatch.settings_update", "organization", v.orgId, { summary: `News watch settings saved (${after.enabled ? "on" : "off"})`, before, after });
  return after;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const sourceInput = z.object({
  name: z.string().trim().min(2, "Give the source a name").max(SOURCE_NAME_MAX),
  kind: z.enum(NEWS_SOURCE_KINDS, { message: "Choose the kind of source" }),
  url: z.string().trim().min(1, "Add the feed address").max(SOURCE_URL_MAX),
  sites: z.string().optional(),
  audience: z.enum(NEWS_AUDIENCES).default("all"),
  enabled: flag.optional(),
  minIntervalMinutes: z.coerce.number().int("Whole minutes only").min(60, "At least 60 minutes").max(10080),
});

function cleanSource(raw: unknown) {
  const input = sourceInput.parse(raw);
  const bad = feedUrlProblem(input.url.replace("{query}", "x"));
  if (bad) throw new UserError(bad, { url: bad });
  let sites: string[] = [];
  if (input.kind === "search") {
    if (!input.url.includes("{query}")) throw new UserError("A news search address needs {query} where the search words go.", { url: "Add {query}" });
    const parts = (input.sites ?? "").split(/[\s,]+/).filter(Boolean);
    sites = [...new Set(parts.map((p) => cleanDomain(p)))].filter((d): d is string => !!d);
    if (parts.length !== sites.length || sites.length === 0) throw new UserError("List the publications as plain domains, such as example.com, separated by commas. A news search source must name at least one.", { sites: "Use plain domains" });
    if (sites.length > 10) throw new UserError("Up to 10 publications per source.", { sites: "Too many" });
  } else if (input.url.includes("{query}")) {
    throw new UserError("A publisher feed address has no {query} in it. Choose News search feed for that.", { url: "Remove {query}" });
  }
  return { name: input.name, kind: input.kind, url: input.url, sites, audience: input.audience, enabled: input.enabled ?? true, minIntervalMinutes: input.minIntervalMinutes };
}

export async function listSources(tx: Tx, v: Viewer): Promise<NewsSource[]> {
  assertCan(v, "settings.manage");
  return tx.select().from(newsSources).where(eq(newsSources.orgId, v.orgId)).orderBy(asc(newsSources.createdAt), asc(newsSources.name));
}

/**
 * Create the sample default sources once, for an organization that has none. Called from the
 * Settings page and the seed. Sources exist but nothing is read until News watch is switched on.
 */
export async function ensureDefaultSources(tx: Tx, orgId: string, opts: { isDemo?: boolean } = {}): Promise<number> {
  await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).for("update");
  const [any] = await tx.select({ id: newsSources.id }).from(newsSources).where(eq(newsSources.orgId, orgId)).limit(1);
  if (any) return 0;
  await tx.insert(newsSources).values(DEFAULT_SOURCES.map((s) => ({ orgId, ...s, audience: "all" as const, enabled: true, isDefault: true, isDemo: opts.isDemo ?? false })));
  return DEFAULT_SOURCES.length;
}

export async function addSource(tx: Tx, v: Viewer, raw: unknown): Promise<NewsSource> {
  assertCan(v, "settings.manage");
  const input = cleanSource(raw);
  const existing = await tx.select({ id: newsSources.id }).from(newsSources).where(eq(newsSources.orgId, v.orgId));
  if (existing.length >= 40) throw new UserError("Up to 40 sources. Delete one you no longer use first.");
  const [row] = await tx.insert(newsSources).values({ orgId: v.orgId, ...input, createdBy: v.userId }).returning();
  await audit(tx, actorOf(v), "newswatch.source.add", "news_source", row.id, { summary: `News source added: ${row.name}`, after: input });
  return row;
}

async function sourceForUpdate(tx: Tx, v: Viewer, id: string): Promise<NewsSource> {
  assertCan(v, "settings.manage");
  if (!z.string().uuid().safeParse(id).success) throw new AuthzError("Source not found.");
  const [row] = await tx.select().from(newsSources).where(and(eq(newsSources.id, id), eq(newsSources.orgId, v.orgId))).for("update");
  if (!row) throw new AuthzError("Source not found.");
  return row;
}

export async function updateSource(tx: Tx, v: Viewer, id: string, raw: unknown): Promise<NewsSource> {
  const before = await sourceForUpdate(tx, v, id);
  const input = cleanSource(raw);
  // A changed address starts with a clean slate: no backoff carried over from the old one.
  const reset = input.url !== before.url ? { consecutiveFailures: 0, backoffUntil: null, lastStatus: null, lastResult: null, lastFetchedAt: null } : {};
  const [row] = await tx.update(newsSources).set({ ...input, ...reset, updatedAt: new Date() }).where(eq(newsSources.id, before.id)).returning();
  await audit(tx, actorOf(v), "newswatch.source.update", "news_source", row.id, {
    summary: `News source changed: ${row.name}`,
    before: { name: before.name, kind: before.kind, url: before.url, sites: before.sites, audience: before.audience, enabled: before.enabled, minIntervalMinutes: before.minIntervalMinutes },
    after: input,
  });
  return row;
}

export async function setSourceEnabled(tx: Tx, v: Viewer, id: string, enabled: boolean): Promise<NewsSource> {
  const before = await sourceForUpdate(tx, v, id);
  if (before.enabled === enabled) return before;
  const [row] = await tx.update(newsSources).set({ enabled, ...(enabled ? { consecutiveFailures: 0, backoffUntil: null } : {}), updatedAt: new Date() }).where(eq(newsSources.id, before.id)).returning();
  await audit(tx, actorOf(v), "newswatch.source.toggle", "news_source", row.id, { summary: `News source switched ${enabled ? "on" : "off"}: ${row.name}` });
  return row;
}

export async function deleteSource(tx: Tx, v: Viewer, id: string): Promise<void> {
  const before = await sourceForUpdate(tx, v, id);
  await tx.delete(newsSources).where(eq(newsSources.id, before.id));
  await audit(tx, actorOf(v), "newswatch.source.delete", "news_source", before.id, { summary: `News source deleted: ${before.name}`, before: { name: before.name, url: before.url } });
}
