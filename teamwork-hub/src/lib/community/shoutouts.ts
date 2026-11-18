/**
 * Coach shoutouts: a short, staff-authored note of recognition for one athlete.
 * Visible to the athlete, their guardians and staff in scope; on the gym TV only under the
 * athlete's display name (never when hidden). No message is sent anywhere.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, communityShoutouts, SHOUTOUT_TEMPLATES, users, xpEvents, type ShoutoutTemplate } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { engagementSettingsOf } from "@/lib/engagement/settings";
import { lintBlockMessage, lintFamilyMessage } from "@/lib/messaging/family-style";
import { todayLocal } from "@/lib/time";
import { actorOf, communityOrg } from "./settings";
import { SHOUTOUT_LABEL, SHOUTOUT_NOTE_MAX } from "./shared";

export type ShoutoutView = { id: string; template: ShoutoutTemplate; headline: string; note: string | null; coach: string; createdAt: Date; canRemove: boolean };

/** Strip control characters and collapse whitespace: the note is one plain line. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/**
 * Post a shoutout. Staff only, for an athlete the staff member can see (coaches: assigned
 * athletes only). Counts against the author's daily limit (facility-local day). Awards XP once
 * through the engagement ledger when levels are on.
 */
export async function postShoutout(tx: Tx, v: Viewer, input: { athleteId: string; template: string; note?: unknown }, opts: { today?: string; now?: Date } = {}) {
  if (!isStaff(v)) throw new AuthzError("Only staff can post shoutouts.");
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) throw new UserError("Community features are turned off for this organization.");
  await requireOnAthlete(tx, v, input.athleteId, "profile.read");
  if (!SHOUTOUT_TEMPLATES.includes(input.template as ShoutoutTemplate)) throw new UserError("Pick what the shoutout is for.");
  const template = input.template as ShoutoutTemplate;
  const note = cleanNote(input.note);
  if (note && note.length > SHOUTOUT_NOTE_MAX) throw new UserError(`Keep the note to ${SHOUTOUT_NOTE_MAX} characters or fewer.`, { note: `Up to ${SHOUTOUT_NOTE_MAX} characters` });
  if (note) {
    const lint = lintFamilyMessage(note, { requireSignOff: false });
    if (lint.blocks.length) throw new UserError(lintBlockMessage(lint, "This shoutout").replace("can't be sent to families yet", "can't be posted yet"), { note: lint.blocks[0].message });
  }
  const today = opts.today ?? todayLocal(org.tz);
  // Serialize this author's posts for the day so two tabs cannot both slip under the limit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`community.shoutout:${v.userId}:${today}`}))`);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(communityShoutouts)
    .where(and(eq(communityShoutouts.orgId, v.orgId), eq(communityShoutouts.authorUserId, v.userId), eq(communityShoutouts.localDate, today)));
  if (n >= org.settings.shoutoutDailyLimit) throw new UserError(`You have reached today's limit of ${org.settings.shoutoutDailyLimit} shoutouts. More tomorrow.`);
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, input.athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const now = opts.now ?? new Date();
  const [row] = await tx
    .insert(communityShoutouts)
    .values({ orgId: v.orgId, athleteId: input.athleteId, authorUserId: v.userId, template, note, localDate: today, isDemo: a.isDemo, createdAt: now })
    .returning();
  const eng = engagementSettingsOf(org.orgSettings);
  if (eng.levelsEnabled) {
    await tx
      .insert(xpEvents)
      .values({ orgId: v.orgId, athleteId: input.athleteId, kind: "coach_shoutout", points: eng.xp.coach_shoutout, sourceType: "community_shoutout", sourceId: row.id, idempotencyKey: `shoutout:${row.id}`, occurredAt: now, isDemo: a.isDemo })
      .onConflictDoNothing({ target: [xpEvents.orgId, xpEvents.idempotencyKey] });
  }
  await audit(tx, actorOf(v), "community.shoutout.post", "community_shoutout", row.id, { summary: `Shoutout posted: ${SHOUTOUT_LABEL[template]}`, after: { athleteId: input.athleteId, template, note } });
  return row;
}

/**
 * Remove a shoutout (soft delete, audited). The author may remove their own; owner, admin and
 * operations may remove any. XP already awarded stays: the ledger is append-only.
 */
export async function removeShoutout(tx: Tx, v: Viewer, shoutoutId: string, opts: { reason?: string | null } = {}) {
  if (!isStaff(v)) throw new AuthzError();
  const [row] = await tx.select().from(communityShoutouts).where(and(eq(communityShoutouts.id, shoutoutId), eq(communityShoutouts.orgId, v.orgId))).for("update");
  if (!row) throw new AuthzError();
  if (row.authorUserId !== v.userId && !can(v, "people.manage")) throw new AuthzError("You can only remove shoutouts you posted.");
  if (row.removedAt) return row;
  const reason = opts.reason?.trim().slice(0, 200) || null;
  const [after] = await tx.update(communityShoutouts).set({ removedAt: new Date(), removedBy: v.userId }).where(eq(communityShoutouts.id, row.id)).returning();
  await audit(tx, actorOf(v), "community.shoutout.remove", "community_shoutout", row.id, {
    summary: `Shoutout removed${reason ? `: ${reason}` : ""}`,
    before: { athleteId: row.athleteId, authorUserId: row.authorUserId, template: row.template, note: row.note },
    after: { removed: true, reason },
  });
  return after;
}

/** Shoutouts for one athlete, newest first. Needs profile access (the athlete, a guardian, staff in scope). */
export async function shoutoutsForAthlete(tx: Tx, v: Viewer, athleteId: string, opts: { limit?: number } = {}): Promise<ShoutoutView[]> {
  await requireOnAthlete(tx, v, athleteId, "profile.read");
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) return [];
  const rows = await tx
    .select({ s: communityShoutouts, coach: users.displayName })
    .from(communityShoutouts)
    .innerJoin(users, eq(users.id, communityShoutouts.authorUserId))
    .where(and(eq(communityShoutouts.orgId, v.orgId), eq(communityShoutouts.athleteId, athleteId), isNull(communityShoutouts.removedAt)))
    .orderBy(desc(communityShoutouts.createdAt))
    .limit(opts.limit ?? 20);
  const manage = isStaff(v) && can(v, "people.manage");
  return rows.map(({ s, coach }) => ({ id: s.id, template: s.template, headline: SHOUTOUT_LABEL[s.template], note: s.note, coach, createdAt: s.createdAt, canRemove: manage || (isStaff(v) && s.authorUserId === v.userId) }));
}

/** How many shoutouts the viewer has left today (staff). */
export async function shoutoutsLeftToday(tx: Tx, v: Viewer, today?: string): Promise<{ left: number; limit: number; enabled: boolean }> {
  const org = await communityOrg(tx, v.orgId);
  const day = today ?? todayLocal(org.tz);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(communityShoutouts)
    .where(and(eq(communityShoutouts.orgId, v.orgId), eq(communityShoutouts.authorUserId, v.userId), eq(communityShoutouts.localDate, day)));
  return { left: Math.max(0, org.settings.shoutoutDailyLimit - n), limit: org.settings.shoutoutDailyLimit, enabled: org.settings.enabled };
}

/** Recent shoutouts for the TV board: raw rows only; the board resolves names and drops hidden athletes. */
export async function recentShoutoutRows(tx: Tx, orgId: string, since: Date, limit = 30) {
  return tx
    .select({ athleteId: communityShoutouts.athleteId, template: communityShoutouts.template, note: communityShoutouts.note, coach: users.displayName, createdAt: communityShoutouts.createdAt })
    .from(communityShoutouts)
    .innerJoin(users, eq(users.id, communityShoutouts.authorUserId))
    .where(and(eq(communityShoutouts.orgId, orgId), isNull(communityShoutouts.removedAt), gte(communityShoutouts.createdAt, since)))
    .orderBy(desc(communityShoutouts.createdAt))
    .limit(limit);
}
