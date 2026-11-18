/**
 * Marketing queue: approved wins whose family gave marketing consent, each with ready-to-copy
 * caption drafts from fixed templates. Staff copy the text and post it themselves; the Hub posts
 * nothing anywhere and calls no outside service. "Mark as posted" is a note of what staff did.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, MARKETING_CHANNELS, people, winMarketingPosts, wins, type MarketingChannel, type MarketingConsentState } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { communityRoster } from "@/lib/community/display-name";
import { communityOrg } from "@/lib/community/settings";
import { todayLocal } from "@/lib/time";
import { actorOf } from "./access";
import { captionDrafts, CHANNEL_LABEL, mentionsLastName, WIN_TYPE_LABEL } from "./shared";
import { winForViewer } from "./wins";

export type PostNote = { channel: MarketingChannel; postedOn: string };
export type QueueItem = {
  winId: string;
  personId: string;
  /** Staff-only label so staff know whose family to talk to. Never part of a caption. */
  athleteName: string;
  /** The only name a caption uses. */
  displayName: string;
  headline: string;
  detail: string | null;
  typeLabel: string;
  sport: string;
  occurredOn: string;
  consent: MarketingConsentState;
  consentAt: Date | null;
  asked: boolean;
  /** An approved photo exists (level c covers it). */
  photo: boolean;
  captions: { label: string; text: string }[];
  posts: PostNote[];
};
export type TakeDownItem = { winId: string; athleteName: string; headline: string; reason: string; posts: PostNote[] };

export type MarketingQueue = { ready: QueueItem[]; needConsent: QueueItem[]; takeDown: TakeDownItem[] };

/**
 * `ready`: approved + marketing consent given + a visible display name. Nothing else can be in
 * it. `needConsent`: approved wins that could be asked about. `takeDown`: wins staff marked as
 * posted whose consent was later withdrawn, or that were removed or hidden.
 */
export async function marketingQueue(tx: Tx, v: Viewer, opts: { today?: string } = {}): Promise<MarketingQueue> {
  assertCan(v, "wins.marketing");
  const org = await communityOrg(tx, v.orgId);
  const today = opts.today ?? todayLocal(org.tz);
  const roster = await communityRoster(tx, v.orgId, { today, defaultMode: org.settings.defaultDisplayMode });
  const posts = await tx.select().from(winMarketingPosts).where(eq(winMarketingPosts.orgId, v.orgId)).orderBy(desc(winMarketingPosts.postedOn));
  const postsBy = new Map<string, PostNote[]>();
  for (const p of posts) postsBy.set(p.winId, [...(postsBy.get(p.winId) ?? []), { channel: p.channel, postedOn: p.postedOn }]);
  const postedIds = [...postsBy.keys()];
  const rows = await tx
    .select({ w: wins, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, active: athletes.active })
    .from(wins)
    .innerJoin(athletes, eq(athletes.id, wins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(wins.orgId, v.orgId), postedIds.length ? or(eq(wins.status, "approved"), inArray(wins.id, postedIds)) : eq(wins.status, "approved")))
    .orderBy(desc(wins.occurredOn), desc(wins.approvedAt))
    .limit(400);
  const out: MarketingQueue = { ready: [], needConsent: [], takeDown: [] };
  for (const r of rows) {
    const w = r.w;
    const athleteName = `${r.preferred ?? r.first} ${r.last}`;
    const displayName = roster.get(w.athleteId)?.displayName ?? null;
    const wPosts = postsBy.get(w.id) ?? [];
    const usable = w.status === "approved" && r.active && !!displayName && !mentionsLastName(`${w.headline} ${w.detail ?? ""}`, r.last);
    if (wPosts.length && !(usable && w.marketingConsent === "granted")) {
      const reason = w.status === "removed" ? "The win was removed" : w.marketingConsent !== "granted" ? "The family withdrew marketing consent" : "The athlete is now hidden from other families";
      out.takeDown.push({ winId: w.id, athleteName, headline: w.headline, reason, posts: wPosts });
      continue;
    }
    if (!usable) continue;
    const item: QueueItem = {
      winId: w.id,
      personId: r.personId,
      athleteName,
      displayName: displayName!,
      headline: w.headline,
      detail: w.detail,
      typeLabel: WIN_TYPE_LABEL[w.type],
      sport: w.sport,
      occurredOn: w.occurredOn,
      consent: w.marketingConsent,
      consentAt: w.marketingConsentAt,
      asked: !!w.consentRequestedAt,
      photo: !!w.photoObjectId && !!w.photoApprovedAt,
      captions: [],
      posts: wPosts,
    };
    if (w.marketingConsent === "granted") out.ready.push({ ...item, captions: captionDrafts({ displayName: displayName!, headline: w.headline, type: w.type, sport: w.sport, orgName: org.name }) });
    else out.needConsent.push(item);
  }
  return out;
}

/** Note that staff posted a consented win somewhere. Re-checks consent at the moment of marking. */
export async function markPosted(tx: Tx, v: Viewer, input: { winId: string; channel: string; postedOn: string }, opts: { today?: string } = {}): Promise<void> {
  assertCan(v, "wins.marketing");
  const { win, access } = await winForViewer(tx, v, input.winId, opts.today);
  if (win.status !== "approved" || win.marketingConsent !== "granted" || !access.displayName) throw new UserError("This win does not have marketing consent, so it should not be posted.");
  if (!MARKETING_CHANNELS.includes(input.channel as MarketingChannel)) throw new UserError("Choose where it was posted.", { channel: "Required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.postedOn)) throw new UserError("Use a valid date.", { postedOn: "Required" });
  if (input.postedOn > access.today) throw new UserError("The posted date cannot be in the future.", { postedOn: "In the future" });
  if (input.postedOn < win.occurredOn) throw new UserError("The posted date cannot be before the win itself.", { postedOn: "Too early" });
  const channel = input.channel as MarketingChannel;
  const inserted = await tx.insert(winMarketingPosts).values({ orgId: v.orgId, winId: win.id, channel, postedOn: input.postedOn, markedBy: v.userId }).onConflictDoNothing().returning({ id: winMarketingPosts.id });
  if (inserted.length) await audit(tx, actorOf(v), "wins.marketing.posted", "win", win.id, { summary: `Marked as posted on ${CHANNEL_LABEL[channel]} (${input.postedOn}). Posted by staff outside the Hub.`, after: { channel, postedOn: input.postedOn } });
}

/** Staff took an outside post down after consent was withdrawn: clear the notes so it leaves the list. */
export async function markTakenDown(tx: Tx, v: Viewer, winId: string): Promise<void> {
  assertCan(v, "wins.marketing");
  const { win } = await winForViewer(tx, v, winId);
  const rows = await tx.select().from(winMarketingPosts).where(and(eq(winMarketingPosts.orgId, v.orgId), eq(winMarketingPosts.winId, win.id)));
  if (!rows.length) return;
  await tx.delete(winMarketingPosts).where(inArray(winMarketingPosts.id, rows.map((r) => r.id)));
  await audit(tx, actorOf(v), "wins.marketing.taken_down", "win", win.id, { summary: "Staff confirmed outside posts were taken down", before: { posts: rows.map((r) => ({ channel: r.channel, postedOn: r.postedOn })) } });
}
