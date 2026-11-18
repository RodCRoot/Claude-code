/**
 * Athlete Showcase: draft, publish with consent, share by token, revoke (docs/modules/showcase.md).
 * Plain functions taking (tx, viewer, input); every one re-checks the viewer's scope over the
 * athlete id it is given (./access.ts → policy.ts).
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, organizations, people, showcaseConsents, showcaseViewDays, showcases, users, type ShowcaseConfig } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, accessibleAthleteIds, athleteScopeFilter, isAdmin, isStaff, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { showcaseAccess, type ShowcaseAccess } from "./access";
import { DEFAULT_SHOWCASE_CONFIG, SHOWCASE_POLICY_TEXT, SHOWCASE_POLICY_VERSION, TRAINING_SHOW_KEYS, ShowcaseInputError, canonicalConfig, describeConfig, sanitizeConfig, usesTrainingData } from "./allowlist";
import { buildCatalog, showcaseOrg } from "./catalog";
import { composeShowcase, type ShowcaseCatalog, type ShowcaseData } from "./compose";
import { EXPIRY_CHOICES, showcaseSettingsOf } from "./settings";
import { hashShareToken, isWellFormedToken, newShareToken } from "./token";

export type Showcase = typeof showcases.$inferSelect;
export type LinkState = "none" | "draft" | "live" | "expired";

const actorOf = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export function linkStateOf(row: Pick<Showcase, "status" | "tokenHash" | "expiresAt" | "revokedAt"> | null | undefined, now = new Date()): LinkState {
  if (!row) return "none";
  if (row.status !== "published" || !row.tokenHash || row.revokedAt) return "draft";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "live";
}

async function lockRow(tx: Tx, orgId: string, athleteId: string): Promise<Showcase | null> {
  const [row] = await tx.select().from(showcases).where(and(eq(showcases.orgId, orgId), eq(showcases.athleteId, athleteId))).for("update");
  return row ?? null;
}

/** The athlete's Showcase row, locked, created empty when missing. `fresh` = created just now. */
async function ensureRow(tx: Tx, v: Viewer, athleteId: string): Promise<Showcase & { fresh: boolean }> {
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const made = await tx
    .insert(showcases)
    .values({ orgId: v.orgId, athleteId, status: "draft", config: { ...DEFAULT_SHOWCASE_CONFIG, show: { ...DEFAULT_SHOWCASE_CONFIG.show } }, createdBy: v.userId, updatedBy: v.userId, isDemo: a.isDemo })
    .onConflictDoNothing({ target: showcases.athleteId })
    .returning({ id: showcases.id });
  const row = (await lockRow(tx, v.orgId, athleteId))!;
  return { ...row, fresh: made.length > 0 };
}

function parseStrict(raw: unknown): ShowcaseConfig {
  try {
    return sanitizeConfig(raw, { strict: true });
  } catch (e) {
    if (e instanceof ShowcaseInputError) throw new UserError(e.message, { [e.field]: e.message });
    throw e;
  }
}

const canonicalTraining = (c: ShowcaseConfig) => JSON.stringify([[...c.metricIds].sort(), [...c.exerciseIds].sort(), TRAINING_SHOW_KEYS.map((k) => c.show[k])]);

/**
 * Validates a posted config against the allowlist AND against what this athlete actually has.
 * An editor without training access cannot add, remove or change training items: whatever a
 * guardian with access chose before is carried over untouched.
 */
async function checkedConfig(tx: Tx, v: Viewer, athleteId: string, access: ShowcaseAccess, posted: ShowcaseConfig, existing: ShowcaseConfig | null): Promise<ShowcaseConfig> {
  const config: ShowcaseConfig = { ...posted, show: { ...posted.show } };
  const catalog = await buildCatalog(tx, v.orgId, athleteId, { includeTraining: access.canSeeTraining, tz: access.tz });
  if (!catalog) throw new AuthzError();
  if (!access.canSeeTraining) {
    if (usesTrainingData(posted) && (!existing || canonicalTraining(posted) !== canonicalTraining(existing))) {
      throw new UserError("Your account does not have training access for this athlete, so test results, lifts and training consistency cannot be changed from it. Ask the front desk or another guardian.");
    }
    config.metricIds = existing?.metricIds ?? [];
    config.exerciseIds = existing?.exerciseIds ?? [];
    for (const k of TRAINING_SHOW_KEYS) config.show[k] = existing?.show[k] ?? false;
    return config;
  }
  const metricOk = new Set((catalog.metrics ?? []).map((m) => m.id));
  const liftOk = new Set((catalog.lifts ?? []).map((l) => l.exerciseId));
  if (config.metricIds.some((id) => !metricOk.has(id))) throw new UserError("One of the chosen test results is not available for this athlete.", { metricIds: "Not available" });
  if (config.exerciseIds.some((id) => !liftOk.has(id))) throw new UserError("One of the chosen lifts is not available for this athlete.", { exerciseIds: "Not available" });
  if (config.show.relativeStrength && catalog.athlete.weightLb === null) config.show.relativeStrength = false;
  return config;
}

export type ShowcaseBuilderView = {
  access: ShowcaseAccess;
  row: Showcase | null;
  config: ShowcaseConfig;
  catalog: ShowcaseCatalog;
  link: LinkState;
  views: { total: number; last30: number };
  lastConsent: { at: Date; by: string; relationship: string; policyVersion: string } | null;
};

/** Everything the builder page needs. Families only (staff use `listPublishedShowcases`). */
export async function getShowcaseBuilder(tx: Tx, v: Viewer, athleteId: string, now = new Date()): Promise<ShowcaseBuilderView> {
  const access = await showcaseAccess(tx, v, athleteId);
  if (!access.canView || access.relationship === "staff") throw new AuthzError();
  const [row] = await tx.select().from(showcases).where(and(eq(showcases.orgId, v.orgId), eq(showcases.athleteId, athleteId)));
  const catalog = await buildCatalog(tx, v.orgId, athleteId, { includeTraining: access.canSeeTraining, tz: access.tz });
  if (!catalog) throw new AuthzError();
  let views = { total: 0, last30: 0 };
  let lastConsent: ShowcaseBuilderView["lastConsent"] = null;
  if (row) {
    const since = addDaysYmd(todayLocal(access.tz, now), -30);
    const [vw] = await tx
      .select({ total: sql<number>`coalesce(sum(${showcaseViewDays.views}), 0)::int`, last30: sql<number>`coalesce(sum(${showcaseViewDays.views}) filter (where ${showcaseViewDays.day} > ${since}), 0)::int` })
      .from(showcaseViewDays)
      .where(eq(showcaseViewDays.showcaseId, row.id));
    views = { total: vw?.total ?? 0, last30: vw?.last30 ?? 0 };
    const [c] = await tx
      .select({ at: showcaseConsents.createdAt, by: users.displayName, relationship: showcaseConsents.actorRelationship, policyVersion: showcaseConsents.policyVersion })
      .from(showcaseConsents)
      .innerJoin(users, eq(users.id, showcaseConsents.actorUserId))
      .where(and(eq(showcaseConsents.showcaseId, row.id), eq(showcaseConsents.kind, "granted")))
      .orderBy(desc(showcaseConsents.createdAt))
      .limit(1);
    lastConsent = c ?? null;
  }
  return { access, row: row ?? null, config: row ? sanitizeConfig(row.config) : { ...DEFAULT_SHOWCASE_CONFIG, show: { ...DEFAULT_SHOWCASE_CONFIG.show } }, catalog, link: linkStateOf(row, now), views, lastConsent };
}

/**
 * Save the draft. Anyone who may draft can call this (an athlete of the minimum age, a guardian).
 * If the Showcase is published and what it shows changes, it returns to draft and the link shows
 * the generic page until someone who may publish publishes again with fresh consent.
 */
export async function saveShowcaseDraft(tx: Tx, v: Viewer, athleteId: string, raw: unknown): Promise<{ row: Showcase; unpublished: boolean }> {
  const access = await showcaseAccess(tx, v, athleteId);
  if (!access.canDraft) throw new AuthzError(access.draftBlockedReason ?? undefined);
  const posted = parseStrict(raw);
  const before = await ensureRow(tx, v, athleteId);
  const config = await checkedConfig(tx, v, athleteId, access, posted, before.fresh ? null : sanitizeConfig(before.config));
  const changed = canonicalConfig(sanitizeConfig(before.config)) !== canonicalConfig(config);
  const unpublished = before.status === "published" && changed;
  const [row] = await tx
    .update(showcases)
    .set({ config, status: unpublished ? "draft" : before.status, updatedBy: v.userId, updatedAt: new Date() })
    .where(eq(showcases.id, before.id))
    .returning();
  await audit(tx, actorOf(v), unpublished ? "showcase.draft.unpublish" : "showcase.draft.save", "showcase", row.id, {
    summary: unpublished ? "Showcase changed after publishing: returned to draft until it is published again" : "Showcase draft saved",
    before: { status: before.status },
    after: { status: row.status, shows: describeConfig(config) },
  });
  return { row, unpublished };
}

/**
 * Publish with consent. Minors: a guardian. Adults: the athlete. Never staff. Records who agreed,
 * when, to exactly which fields, and under which policy text, in the append-only consent table.
 * Returns the share token ONLY when a new one was created (it is not stored and cannot be shown again).
 */
export async function publishShowcase(
  tx: Tx,
  v: Viewer,
  athleteId: string,
  input: { config: unknown; consent: boolean; expiryDays?: number | null },
  now = new Date(),
): Promise<{ row: Showcase; token: string | null }> {
  const access = await showcaseAccess(tx, v, athleteId);
  if (!access.canPublish) throw new AuthzError(access.publishBlockedReason ?? undefined);
  if (input.consent !== true) throw new UserError("Tick the consent box to publish.", { consent: "Required" });
  const days = input.expiryDays ?? access.settings.defaultExpiryDays;
  if (!(EXPIRY_CHOICES as readonly number[]).includes(days)) throw new UserError("Choose how long the link should work.", { expiryDays: "Choose one" });
  const posted = parseStrict(input.config);
  const before = await ensureRow(tx, v, athleteId);
  const config = await checkedConfig(tx, v, athleteId, access, posted, before.fresh ? null : sanitizeConfig(before.config));
  if (usesTrainingData(config) && !access.canSeeTraining) {
    throw new UserError("This Showcase includes test results or training numbers, and your account does not have training access for this athlete. A guardian with training access can publish it.");
  }
  // A revoke clears the hash, so publishing after a revoke always makes a new link.
  const token = before.tokenHash ? null : newShareToken();
  const expiresAt = days === 0 ? null : new Date(now.getTime() + days * 86_400_000);
  const [row] = await tx
    .update(showcases)
    .set({ config, status: "published", tokenHash: token ? hashShareToken(token) : before.tokenHash, publishedAt: now, publishedBy: v.userId, expiresAt, revokedAt: null, revokedBy: null, updatedBy: v.userId, updatedAt: now })
    .where(eq(showcases.id, before.id))
    .returning();
  await tx.insert(showcaseConsents).values({
    orgId: v.orgId,
    showcaseId: row.id,
    athleteId,
    kind: "granted",
    actorRelationship: access.relationship === "self" ? "self" : "guardian",
    actorUserId: v.userId,
    actorPersonId: v.personId,
    fields: config,
    policyVersion: SHOWCASE_POLICY_VERSION,
    policyText: SHOWCASE_POLICY_TEXT,
    expiresAt,
    isDemo: row.isDemo,
  });
  await audit(tx, actorOf(v), "showcase.publish", "showcase", row.id, {
    summary: `Showcase published by ${access.relationship === "self" ? "the athlete (adult)" : "a guardian"}${expiresAt ? `, link works for ${days} days` : ", no expiry"}`,
    before: { status: before.status },
    after: { status: "published", shows: describeConfig(config), policyVersion: SHOWCASE_POLICY_VERSION, newLink: !!token },
  });
  return { row, token };
}

/**
 * Turn the link off now. The token hash is erased, so the old link can never work again, even if
 * the Showcase is published later. Family (athlete or guardian) and owner/admin.
 */
export async function revokeShowcase(tx: Tx, v: Viewer, athleteId: string, now = new Date()): Promise<Showcase> {
  const access = await showcaseAccess(tx, v, athleteId);
  if (!access.canRevoke) throw new AuthzError();
  const before = await lockRow(tx, v.orgId, athleteId);
  if (!before) throw new UserError("There is no Showcase to turn off.");
  if (before.status !== "published" && !before.tokenHash) return before;
  const [row] = await tx.update(showcases).set({ status: "draft", tokenHash: null, revokedAt: now, revokedBy: v.userId, updatedBy: v.userId, updatedAt: now }).where(eq(showcases.id, before.id)).returning();
  await tx.insert(showcaseConsents).values({
    orgId: v.orgId,
    showcaseId: row.id,
    athleteId,
    kind: "withdrawn",
    actorRelationship: access.relationship === "staff" ? "staff" : access.relationship === "self" ? "self" : "guardian",
    actorUserId: v.userId,
    actorPersonId: v.personId,
    fields: sanitizeConfig(before.config),
    policyVersion: SHOWCASE_POLICY_VERSION,
    policyText: "Sharing turned off. The link no longer works.",
    isDemo: row.isDemo,
  });
  await audit(tx, actorOf(v), "showcase.revoke", "showcase", row.id, { summary: `Showcase link turned off by ${access.relationship === "staff" ? "staff" : access.relationship === "self" ? "the athlete" : "a guardian"}`, before: { status: before.status }, after: { status: "draft" } });
  return row;
}

/** Replace the link with a new one (the old one stops working at once). Same bar as publishing. */
export async function rotateShowcaseLink(tx: Tx, v: Viewer, athleteId: string): Promise<{ row: Showcase; token: string }> {
  const access = await showcaseAccess(tx, v, athleteId);
  if (!access.canPublish) throw new AuthzError(access.publishBlockedReason ?? undefined);
  const before = await lockRow(tx, v.orgId, athleteId);
  if (!before || before.status !== "published") throw new UserError("Publish the Showcase first.");
  const token = newShareToken();
  const [row] = await tx.update(showcases).set({ tokenHash: hashShareToken(token), updatedBy: v.userId, updatedAt: new Date() }).where(eq(showcases.id, before.id)).returning();
  await audit(tx, actorOf(v), "showcase.link.rotate", "showcase", row.id, { summary: "New Showcase link created; the previous link stopped working" });
  return { row, token };
}

/**
 * The public read. Unknown, malformed, revoked, expired, unpublished and switched-off all return
 * null, and the page shows one generic message for all of them. Nothing about the visitor is
 * stored: a hit adds one to that day's counter.
 */
export async function publicShowcase(tx: Tx, token: unknown, opts: { now?: Date; countView?: boolean } = {}): Promise<ShowcaseData | null> {
  if (!isWellFormedToken(token)) return null;
  const now = opts.now ?? new Date();
  const [hit] = await tx
    .select({ s: showcases, settings: organizations.settings, tz: organizations.timezone, personStatus: people.status })
    .from(showcases)
    .innerJoin(organizations, eq(organizations.id, showcases.orgId))
    .innerJoin(athletes, eq(athletes.id, showcases.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(showcases.tokenHash, hashShareToken(token)));
  if (!hit || linkStateOf(hit.s, now) !== "live") return null;
  if (!showcaseSettingsOf(hit.settings).enabled || hit.personStatus === "archived") return null;
  const today = todayLocal(hit.tz, now);
  const catalog = await buildCatalog(tx, hit.s.orgId, hit.s.athleteId, { includeTraining: true, today, tz: hit.tz });
  if (!catalog) return null;
  const org = await showcaseOrg(tx, hit.s.orgId);
  const data = composeShowcase(catalog, sanitizeConfig(hit.s.config), { name: org.name, primaryColor: org.primaryColor, logoPath: org.logoPath }, today);
  if (opts.countView !== false) {
    await tx
      .insert(showcaseViewDays)
      .values({ showcaseId: hit.s.id, orgId: hit.s.orgId, day: today, views: 1 })
      .onConflictDoUpdate({ target: [showcaseViewDays.showcaseId, showcaseViewDays.day], set: { views: sql`${showcaseViewDays.views} + 1` } });
  }
  return data;
}

/** The payload for the family's own preview and PDF: the saved config, private, never counted. */
export async function privateShowcaseData(tx: Tx, v: Viewer, athleteId: string, opts: { forPdf?: boolean } = {}): Promise<{ data: ShowcaseData; row: Showcase | null; access: ShowcaseAccess }> {
  const b = await getShowcaseBuilder(tx, v, athleteId);
  // A minor athlete may download the PDF only of what a guardian has agreed to share.
  if (opts.forPdf && !b.access.canPublish && b.link !== "live") throw new AuthzError("The PDF is available once a parent or guardian has published the Showcase.");
  const org = await showcaseOrg(tx, v.orgId);
  // The catalog only holds what this viewer may see, so a guardian without training access gets no numbers here.
  const data = composeShowcase(b.catalog, b.config, { name: org.name, primaryColor: org.primaryColor, logoPath: org.logoPath }, todayLocal(org.tz));
  return { data, row: b.row, access: b.access };
}

export type PublishedShowcaseRow = {
  id: string;
  athleteId: string;
  personId: string;
  athleteName: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  expiresAt: Date | null;
  link: LinkState;
  shows: string[];
  views30: number;
};

/** Staff: read-only list of published Showcases for athletes in the viewer's profile scope. */
export async function listPublishedShowcases(tx: Tx, v: Viewer, now = new Date()): Promise<PublishedShowcaseRow[]> {
  if (!isStaff(v)) throw new AuthzError();
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  const rows = await tx
    .select({ s: showcases, personId: people.id, first: people.firstName, last: people.lastName, by: users.displayName, tz: organizations.timezone })
    .from(showcases)
    .innerJoin(athletes, eq(athletes.id, showcases.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(organizations, eq(organizations.id, showcases.orgId))
    .leftJoin(users, eq(users.id, showcases.publishedBy))
    .where(and(eq(showcases.orgId, v.orgId), eq(showcases.status, "published"), athleteScopeFilter(ids, showcases.athleteId)))
    .orderBy(desc(showcases.publishedAt));
  if (!rows.length) return [];
  const since = addDaysYmd(todayLocal(rows[0].tz, now), -30);
  const counts = await tx
    .select({ id: showcaseViewDays.showcaseId, n: sql<number>`sum(${showcaseViewDays.views})::int` })
    .from(showcaseViewDays)
    .where(and(inArray(showcaseViewDays.showcaseId, rows.map((r) => r.s.id)), gte(showcaseViewDays.day, since)))
    .groupBy(showcaseViewDays.showcaseId);
  return rows.map((r) => ({
    id: r.s.id,
    athleteId: r.s.athleteId,
    personId: r.personId,
    athleteName: `${r.first} ${r.last}`,
    publishedAt: r.s.publishedAt,
    publishedBy: r.by,
    expiresAt: r.s.expiresAt,
    link: linkStateOf(r.s, now),
    shows: describeConfig(sanitizeConfig(r.s.config)).map((x) => x.replace(/ \(.*@.*\)$/, "")),
    views30: counts.find((c) => c.id === r.s.id)?.n ?? 0,
  }));
}

/** Owner/admin revoke by Showcase id (staff list). The id is re-checked against the viewer's org. */
export async function staffRevokeShowcase(tx: Tx, v: Viewer, showcaseId: string): Promise<Showcase> {
  if (!isAdmin(v)) throw new AuthzError();
  const [row] = await tx.select({ athleteId: showcases.athleteId }).from(showcases).where(and(eq(showcases.id, showcaseId), eq(showcases.orgId, v.orgId)));
  if (!row) throw new AuthzError();
  return revokeShowcase(tx, v, row.athleteId);
}
