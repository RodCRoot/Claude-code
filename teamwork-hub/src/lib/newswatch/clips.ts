/**
 * News clips: headlines the matcher tied to a watched person. A clip is a row in the Wins
 * module's "Leads to check" table (`win_leads`, kind "news").
 *
 * NOTHING IS SHOWN WITHOUT A PERSON'S APPROVAL. There is no automatic approval of any kind.
 *
 *   suggested --(any staff in scope: "our athlete")--> confirmed      (triage: shows nothing)
 *   suggested | confirmed --(an approver)--> approved                 (now it may be shown)
 *   suggested | confirmed --> not_ours (teaches the matcher) | ignored | rejected
 *   approved --(an approver)--> removed                               (taken down in one step)
 *
 * Approvers: owner and admin, plus operations and coaches when Settings allows (`mayApproveNews`).
 * A coach only ever sees and acts on clips about athletes they coach; alumni clips are open to
 * every staff member who reviews wins.
 *
 * An approved clip about a current athlete becomes an approved win of type "In the news" and
 * from then on follows the Wins rules: display names, the family's in-app and TV switches, the
 * hidden-athlete filter, separate marketing consent. An approved alumni clip is shown in the
 * alumni section straight from this table (alumni have no athlete record to hang a win on).
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { alumni, athletes, newsItems, newsNegatives, newsWatchAthletes, people, winLeads, wins, xpEvents, type NewsClipStatus, type NewsMatchLevel } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { communityRoster, type RosterEntry } from "@/lib/community/display-name";
import { communityOrg } from "@/lib/community/settings";
import { engagementSettingsOf } from "@/lib/engagement/settings";
import { fmt, todayLocal } from "@/lib/time";
import { winsAccess } from "@/lib/wins/access";
import { oneLine } from "@/lib/wins/shared";
import { checkWinText } from "@/lib/wins/wins";
import { linkKey, titleKey, type ParsedItem } from "./feed";
import { actorOf, mayApproveNews, newsOrg } from "./settings";
import { alumniDisplayName, clipSnippet, displayHeadline, normText, scoreMatch, sensitiveCheck, type WatchedPerson } from "./shared";

type Lead = typeof winLeads.$inferSelect;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING: NewsClipStatus[] = ["suggested", "confirmed"];
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Ingest (called by the job, and by the seed and tests with hand-made items)
// ---------------------------------------------------------------------------

export type IngestSource = { id: string | null; name: string; isDemo?: boolean };
export type IngestResult = { seen: number; matched: number; newClips: number };

/** "Sample Gazette (publisher feed)" is shown as "Sample Gazette". */
export const publicationOf = (item: ParsedItem, source: IngestSource) => (item.sourceName?.trim() || source.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || "News").slice(0, 120);

/**
 * Score every item against every watched person and store the ones that are at least "possible"
 * as suggested clips. Idempotent: the same article (same link, or the same headline from the same
 * publication within three days) is stored once, and a person gets one clip per article, ever,
 * whatever staff decided about it. Items that match nobody are not stored.
 */
export async function ingestItems(tx: Tx, orgId: string, source: IngestSource, items: ParsedItem[], watched: WatchedPerson[], opts: { now?: Date; maxAgeDays?: number; searchedFor?: { kind: "athlete" | "alumni"; id: string } | null } = {}): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const res: IngestResult = { seen: 0, matched: 0, newClips: 0 };
  const cutoff = now.getTime() - (opts.maxAgeDays ?? 30) * DAY;
  for (const item of items) {
    if (item.publishedAt && (item.publishedAt.getTime() < cutoff || item.publishedAt.getTime() > now.getTime() + 2 * DAY)) continue;
    res.seen++;
    const publication = publicationOf(item, source);
    const tKey = titleKey(item.headline, publication);
    const lKey = linkKey(item.link);
    const pubNorm = normText(publication);
    const hits = watched
      .map((p) => ({ p, m: scoreMatch(p, { headline: item.headline, snippet: item.snippet, publication: pubNorm, titleKey: tKey, searchedForThisPerson: !!opts.searchedFor && opts.searchedFor.kind === p.kind && opts.searchedFor.id === p.id }) }))
      .filter((h) => h.m.level !== "unlikely");
    if (!hits.length) continue;
    res.matched++;

    // The article: reuse a stored one when it is the same link, or the same headline and publication a few days apart.
    let [stored] = await tx.select().from(newsItems).where(and(eq(newsItems.orgId, orgId), eq(newsItems.linkKey, lKey)));
    if (!stored) {
      const sameTitle = await tx.select().from(newsItems).where(and(eq(newsItems.orgId, orgId), eq(newsItems.titleKey, tKey)));
      stored = sameTitle.find((s) => !s.publishedAt || !item.publishedAt || Math.abs(s.publishedAt.getTime() - item.publishedAt.getTime()) <= 3 * DAY) ?? stored;
    }
    if (!stored) {
      [stored] = await tx
        .insert(newsItems)
        .values({ orgId, sourceId: source.id, linkKey: lKey, titleKey: tKey, headline: item.headline, sourceName: publication, publishedAt: item.publishedAt, link: item.link, snippet: clipSnippet(item.snippet), isDemo: source.isDemo ?? false })
        .onConflictDoNothing()
        .returning();
      if (!stored) [stored] = await tx.select().from(newsItems).where(and(eq(newsItems.orgId, orgId), eq(newsItems.linkKey, lKey)));
    }
    const sens = sensitiveCheck(item.headline, item.snippet);
    for (const { p, m } of hits) {
      const who = p.kind === "athlete" ? { athleteId: p.id, alumniId: null } : { athleteId: null, alumniId: p.id };
      const [dup] = await tx
        .select({ id: winLeads.id })
        .from(winLeads)
        .where(and(eq(winLeads.orgId, orgId), eq(winLeads.newsItemId, stored.id), p.kind === "athlete" ? eq(winLeads.athleteId, p.id) : eq(winLeads.alumniId, p.id)));
      if (dup) continue;
      const made = await tx
        .insert(winLeads)
        .values({ orgId, kind: "news", note: stored.headline.slice(0, 300), sourceUrl: stored.link, ...who, status: "open", newsItemId: stored.id, newsStatus: "suggested", matchLevel: m.level as NewsMatchLevel, matchScore: m.score, matchReasons: m.reasons, sensitiveNote: sens.blocked ? `Mentions ${sens.blocked}` : sens.warning, isDemo: source.isDemo ?? false })
        .onConflictDoNothing()
        .returning({ id: winLeads.id });
      if (made.length) res.newClips++;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Reads for staff
// ---------------------------------------------------------------------------

export type ClipView = {
  id: string;
  person: "athlete" | "alumni";
  athleteId: string | null;
  alumniId: string | null;
  /** Athlete's person id, for a profile link. */
  personId: string | null;
  /** Full name: staff only. */
  personName: string;
  personDetail: string | null;
  headline: string;
  sourceName: string;
  publishedAt: Date | null;
  link: string;
  snippet: string | null;
  status: NewsClipStatus;
  matchLevel: NewsMatchLevel | null;
  reasons: string[];
  /** Warning label for the person who approves. */
  sensitiveNote: string | null;
  /** Set when the headline mentions a topic wins never mention: it cannot be approved. */
  blockedTopic: string | null;
  /** Still opted in / still on the watch list. */
  watched: boolean;
  /** What other families would see as the name; null when the athlete's name is hidden. */
  shownAs: string | null;
  winId: string | null;
  createdAt: Date;
  approvedAt: Date | null;
};

async function coachScope(tx: Tx, v: Viewer) {
  return accessibleAthleteIds(tx, v, "profile.read");
}

/**
 * News clips this staff member may see. Owner, admin and operations: all. A coach: clips about
 * athletes they coach, and alumni clips.
 */
export async function listClips(tx: Tx, v: Viewer, opts: { statuses?: NewsClipStatus[]; limit?: number; today?: string } = {}): Promise<ClipView[]> {
  assertCan(v, "wins.review");
  const scope = await coachScope(tx, v);
  const inScope = scope === "all" ? undefined : or(isNotNull(winLeads.alumniId), scope.length ? inArray(winLeads.athleteId, scope) : sql`false`);
  const rows = await tx
    .select({ l: winLeads, item: newsItems, first: people.firstName, preferred: people.preferredName, last: people.lastName, personId: people.id, aSport: athletes.sport, aSchool: athletes.school, optedIn: newsWatchAthletes.optedIn, alum: alumni, winStatus: wins.status })
    .from(winLeads)
    .innerJoin(newsItems, eq(newsItems.id, winLeads.newsItemId))
    .leftJoin(athletes, eq(athletes.id, winLeads.athleteId))
    .leftJoin(people, eq(people.id, athletes.personId))
    .leftJoin(newsWatchAthletes, eq(newsWatchAthletes.athleteId, winLeads.athleteId))
    .leftJoin(alumni, eq(alumni.id, winLeads.alumniId))
    .leftJoin(wins, eq(wins.id, winLeads.winId))
    .where(and(eq(winLeads.orgId, v.orgId), eq(winLeads.kind, "news"), inArray(winLeads.newsStatus, opts.statuses ?? PENDING), inScope))
    .orderBy(desc(winLeads.createdAt), desc(winLeads.id))
    .limit(opts.limit ?? 200);
  const roster = rows.some((r) => r.l.athleteId) ? await communityRoster(tx, v.orgId, opts.today ? { today: opts.today } : {}) : new Map<string, RosterEntry>();
  return rows.map((r) => {
    const isAthlete = !!r.l.athleteId;
    // A clip whose win was later removed through the Wins pages counts as taken down.
    const status: NewsClipStatus = r.l.newsStatus === "approved" && isAthlete && r.winStatus && r.winStatus !== "approved" ? "removed" : r.l.newsStatus!;
    return {
      id: r.l.id,
      person: isAthlete ? "athlete" : "alumni",
      athleteId: r.l.athleteId,
      alumniId: r.l.alumniId,
      personId: isAthlete ? r.personId : null,
      personName: isAthlete ? `${r.preferred ?? r.first} ${r.last}` : `${r.alum?.firstName ?? ""} ${r.alum?.lastName ?? ""}`.trim(),
      personDetail: isAthlete ? [r.aSport, r.aSchool].filter(Boolean).join(" · ") || null : [r.alum?.sport, r.alum?.college].filter(Boolean).join(" · ") || "Alumni",
      headline: r.item.headline,
      sourceName: r.item.sourceName,
      publishedAt: r.item.publishedAt,
      link: r.item.link,
      snippet: r.item.snippet,
      status,
      matchLevel: r.l.matchLevel,
      reasons: r.l.matchReasons ?? [],
      sensitiveNote: r.l.sensitiveNote,
      blockedTopic: sensitiveCheck(r.item.headline, null).blocked,
      watched: isAthlete ? r.optedIn === true : !!r.alum?.watch && !!r.alum.active,
      shownAs: isAthlete ? roster.get(r.l.athleteId!)?.displayName ?? null : r.alum ? alumniDisplayName(r.alum) : null,
      winId: r.l.winId,
      createdAt: r.l.createdAt,
      approvedAt: r.l.approvedAt,
    };
  });
}

/** How many clips wait for approval, for someone who can approve. Zero for everyone else. */
export async function pendingClipCount(tx: Tx, v: Viewer): Promise<{ canApprove: boolean; pending: number }> {
  if (!can(v, "wins.review")) return { canApprove: false, pending: 0 };
  const org = await newsOrg(tx, v.orgId);
  if (!org || !mayApproveNews(v, org.settings)) return { canApprove: false, pending: 0 };
  const scope = await coachScope(tx, v);
  const inScope = scope === "all" ? undefined : or(isNotNull(winLeads.alumniId), scope.length ? inArray(winLeads.athleteId, scope) : sql`false`);
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(winLeads).where(and(eq(winLeads.orgId, v.orgId), eq(winLeads.kind, "news"), inArray(winLeads.newsStatus, PENDING), inScope));
  return { canApprove: true, pending: r?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

type Loaded = { lead: Lead; item: typeof newsItems.$inferSelect };

async function clipForUpdate(tx: Tx, v: Viewer, clipId: string): Promise<Loaded> {
  assertCan(v, "wins.review");
  if (!uuidRe.test(clipId)) throw new AuthzError("Clip not found.");
  const [lead] = await tx.select().from(winLeads).where(and(eq(winLeads.id, clipId), eq(winLeads.orgId, v.orgId), eq(winLeads.kind, "news"))).for("update");
  if (!lead || !lead.newsItemId) throw new AuthzError("Clip not found.");
  if (lead.athleteId) {
    const scope = await coachScope(tx, v);
    if (scope !== "all" && !scope.includes(lead.athleteId)) throw new AuthzError("Clip not found.");
  }
  const [item] = await tx.select().from(newsItems).where(and(eq(newsItems.id, lead.newsItemId), eq(newsItems.orgId, v.orgId)));
  if (!item) throw new AuthzError("Clip not found.");
  return { lead, item };
}

async function requireApprover(tx: Tx, v: Viewer) {
  const org = await newsOrg(tx, v.orgId);
  if (!org || !mayApproveNews(v, org.settings)) throw new AuthzError("Only the owner, an admin, or staff the owner allowed in Settings can approve or take down news clips.");
  return org;
}

/**
 * Triage, open to every staff member who reviews wins (a coach: their athletes only).
 * "ours" only records that a person checked the match; it shows nothing to anyone.
 * "not_ours" closes the clip and teaches the matcher (see `news_negatives`).
 */
export async function triageClip(tx: Tx, v: Viewer, clipId: string, action: "ours" | "not_ours" | "ignore", opts: { term?: unknown; now?: Date } = {}): Promise<NewsClipStatus> {
  const { lead, item } = await clipForUpdate(tx, v, clipId);
  if (!PENDING.includes(lead.newsStatus!)) throw new UserError("This clip was already handled.");
  const now = opts.now ?? new Date();
  if (action === "ours") {
    if (lead.newsStatus === "confirmed") return "confirmed";
    await tx.update(winLeads).set({ newsStatus: "confirmed", triagedBy: v.userId, triagedAt: now }).where(eq(winLeads.id, lead.id));
    await audit(tx, actorOf(v), "newswatch.clip.confirm", "win_lead", lead.id, { summary: "News clip marked as our athlete (not shown until approved)", after: { athleteId: lead.athleteId, alumniId: lead.alumniId } });
    return "confirmed";
  }
  const next: NewsClipStatus = action === "not_ours" ? "not_ours" : "ignored";
  await tx.update(winLeads).set({ newsStatus: next, status: "dismissed", triagedBy: v.userId, triagedAt: now, closedBy: v.userId, closedAt: now }).where(eq(winLeads.id, lead.id));
  if (action === "not_ours") {
    const term = oneLine(opts.term).slice(0, 60);
    await tx.insert(newsNegatives).values({ orgId: v.orgId, athleteId: lead.athleteId, alumniId: lead.alumniId, newsItemId: item.id, titleKey: item.titleKey, publication: normText(item.sourceName), term: normText(term).length >= 3 ? term : null, createdBy: v.userId });
  }
  await audit(tx, actorOf(v), action === "not_ours" ? "newswatch.clip.not_ours" : "newswatch.clip.ignore", "win_lead", lead.id, { summary: action === "not_ours" ? "News clip marked as not our athlete" : "News clip ignored", after: { athleteId: lead.athleteId, alumniId: lead.alumniId, publication: item.sourceName } });
  return next;
}

/** An approver decides a pending clip should not be shared. */
export async function rejectClip(tx: Tx, v: Viewer, clipId: string, opts: { now?: Date } = {}): Promise<void> {
  await requireApprover(tx, v);
  const { lead } = await clipForUpdate(tx, v, clipId);
  if (!PENDING.includes(lead.newsStatus!)) throw new UserError("This clip was already handled.");
  const now = opts.now ?? new Date();
  await tx.update(winLeads).set({ newsStatus: "rejected", status: "dismissed", closedBy: v.userId, closedAt: now }).where(eq(winLeads.id, lead.id));
  await audit(tx, actorOf(v), "newswatch.clip.reject", "win_lead", lead.id, { summary: "News clip rejected: not shared", after: { athleteId: lead.athleteId, alumniId: lead.alumniId } });
}

/**
 * Approve a pending clip so it may be shown. Approvers only. Checked again at this moment: the
 * person is still watched, the headline does not touch a topic wins never mention, and (for a
 * current athlete) the name is not hidden. For a current athlete this creates the approved
 * "In the news" win; for an alumnus it marks the clip approved.
 */
export async function approveClip(tx: Tx, v: Viewer, clipId: string, opts: { now?: Date; today?: string } = {}): Promise<{ winId: string | null }> {
  await requireApprover(tx, v);
  const { lead, item } = await clipForUpdate(tx, v, clipId);
  if (!PENDING.includes(lead.newsStatus!)) throw new UserError("This clip was already handled.");
  const sens = sensitiveCheck(item.headline, null);
  if (sens.blocked) throw new UserError(`This headline mentions ${sens.blocked}. Health, injuries, body weight and school grades are never shared, so it cannot be approved. Reject it instead.`);
  const now = opts.now ?? new Date();
  let winId: string | null = null;
  if (lead.athleteId) {
    const [watch] = await tx.select({ optedIn: newsWatchAthletes.optedIn, sport: newsWatchAthletes.sport }).from(newsWatchAthletes).where(and(eq(newsWatchAthletes.orgId, v.orgId), eq(newsWatchAthletes.athleteId, lead.athleteId)));
    if (!watch?.optedIn) throw new UserError("News watch is no longer on for this athlete, so this clip cannot be shared.");
    const access = await winsAccess(tx, v, lead.athleteId, { today: opts.today });
    if (!access?.canReview) throw new AuthzError();
    if (!access.displayName) throw new UserError("This athlete's name is hidden from other families, so the clip cannot be shown. Reject it, or ask the family to change how the name appears.");
    const [a] = await tx.select({ sport: athletes.sport, first: people.firstName, preferred: people.preferredName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.id, lead.athleteId), eq(athletes.orgId, v.orgId)));
    // The headline as other families may read it: the full name becomes the first name.
    const shown = displayHeadline(item.headline, { firstName: a.first, preferredName: a.preferred, lastName: access.lastName }, access.firstName);
    let text: { headline: string; detail: string | null };
    try {
      text = checkWinText({ headline: shown }, access);
    } catch (e) {
      if (e instanceof UserError) throw new UserError(`This headline cannot be shown as it is: ${e.message}`);
      throw e;
    }
    const published = item.publishedAt ? todayLocal(access.org.tz, item.publishedAt) : access.today;
    const [win] = await tx
      .insert(wins)
      .values({
        orgId: v.orgId,
        athleteId: lead.athleteId,
        occurredOn: published > access.today ? access.today : published,
        sport: oneLine(watch.sport ?? a.sport ?? "").slice(0, 40) || "Sports",
        type: "in_the_news",
        headline: text.headline,
        sourceUrl: item.link,
        newsSource: item.sourceName,
        status: "approved",
        showInApp: true,
        showOnTv: true,
        submittedBy: v.userId,
        submittedAs: "staff",
        approvedAt: now,
        approvedBy: v.userId,
        isDemo: lead.isDemo,
      })
      .returning();
    winId = win.id;
    const eng = engagementSettingsOf(access.org.orgSettings);
    if (eng.levelsEnabled && eng.xp.win_approved > 0) {
      await tx
        .insert(xpEvents)
        .values({ orgId: v.orgId, athleteId: win.athleteId, kind: "win_approved", points: eng.xp.win_approved, sourceType: "win", sourceId: win.id, idempotencyKey: `win:${win.id}`, occurredAt: now, isDemo: win.isDemo })
        .onConflictDoNothing({ target: [xpEvents.orgId, xpEvents.idempotencyKey] });
    }
    await audit(tx, actorOf(v), "wins.approve", "win", win.id, { summary: "In the news win created from an approved news clip", after: { status: "approved", headline: win.headline, newsSource: win.newsSource, clipId: lead.id } });
  } else {
    const [alum] = await tx.select().from(alumni).where(and(eq(alumni.id, lead.alumniId!), eq(alumni.orgId, v.orgId)));
    if (!alum?.watch || !alum.active) throw new UserError("This alumnus is no longer on the watch list, so this clip cannot be shared.");
  }
  await tx.update(winLeads).set({ newsStatus: "approved", status: "converted", winId, approvedBy: v.userId, approvedAt: now, closedBy: v.userId, closedAt: now }).where(eq(winLeads.id, lead.id));
  await audit(tx, actorOf(v), "newswatch.clip.approve", "win_lead", lead.id, {
    summary: `News clip approved for the app and the gym TV by ${v.role}${lead.sensitiveNote ? " (it carried a warning label)" : ""}`,
    after: { athleteId: lead.athleteId, alumniId: lead.alumniId, winId, source: item.sourceName, matchLevel: lead.matchLevel, warning: lead.sensitiveNote },
  });
  return { winId };
}

export type BulkResult = { approved: number; skipped: { id: string; reason: string }[] };

/** Approve several selected clips. Each is checked on its own; one that cannot be approved is reported and the rest go on. */
export async function approveClips(tx: Tx, v: Viewer, clipIds: string[], opts: { now?: Date; today?: string } = {}): Promise<BulkResult> {
  await requireApprover(tx, v);
  const ids = [...new Set(clipIds.filter((id) => uuidRe.test(id)))].slice(0, 100);
  if (!ids.length) throw new UserError("Tick at least one clip first.");
  const out: BulkResult = { approved: 0, skipped: [] };
  for (const id of ids) {
    try {
      await tx.transaction((sp) => approveClip(sp, v, id, opts));
      out.approved++;
    } catch (e) {
      if (e instanceof UserError || e instanceof AuthzError) out.skipped.push({ id, reason: e.message });
      else throw e;
    }
  }
  return out;
}

async function takeDown(tx: Tx, v: Viewer, lead: Lead, reason: string, now: Date) {
  await tx.update(winLeads).set({ newsStatus: "removed", closedBy: v.userId, closedAt: now }).where(eq(winLeads.id, lead.id));
  if (lead.winId) {
    const [w] = await tx.select().from(wins).where(and(eq(wins.id, lead.winId), eq(wins.orgId, v.orgId))).for("update");
    if (w && w.status !== "removed") {
      await tx.update(wins).set({ status: "removed", removedAt: now, removedBy: v.userId, removedReason: reason.slice(0, 200), updatedAt: now }).where(eq(wins.id, w.id));
      await audit(tx, actorOf(v), "wins.remove", "win", w.id, { summary: `Win removed: ${reason}`, before: { status: w.status, headline: w.headline, marketingConsent: w.marketingConsent }, after: { status: "removed", reason } });
    }
  }
}

/** Take an approved clip down in one step (approvers). The win it created is removed with it. */
export async function removeClip(tx: Tx, v: Viewer, clipId: string, opts: { now?: Date } = {}): Promise<void> {
  await requireApprover(tx, v);
  const { lead } = await clipForUpdate(tx, v, clipId);
  if (lead.newsStatus === "removed") return;
  if (lead.newsStatus !== "approved") throw new UserError("Only an approved clip can be taken down.");
  await takeDown(tx, v, lead, "News clip taken down by staff", opts.now ?? new Date());
  await audit(tx, actorOf(v), "newswatch.clip.remove", "win_lead", lead.id, { summary: "Approved news clip taken down", after: { athleteId: lead.athleteId, alumniId: lead.alumniId, winId: lead.winId } });
}

/**
 * The opt-in was withdrawn, or an alumnus was taken off the watch list: close every unapproved
 * clip for that person and take down the approved ones. Called inside the same transaction.
 */
export async function closeClipsFor(tx: Tx, orgId: string, who: { athleteId?: string; alumniId?: string }, v: Viewer, reason: string, opts: { now?: Date } = {}): Promise<{ closed: number; takenDown: number }> {
  const now = opts.now ?? new Date();
  const mine = who.athleteId ? eq(winLeads.athleteId, who.athleteId) : eq(winLeads.alumniId, who.alumniId!);
  const rows = await tx.select().from(winLeads).where(and(eq(winLeads.orgId, orgId), eq(winLeads.kind, "news"), mine, inArray(winLeads.newsStatus, [...PENDING, "approved"]))).for("update");
  let closed = 0;
  let takenDown = 0;
  for (const lead of rows) {
    if (lead.newsStatus === "approved") {
      await takeDown(tx, v, lead, reason, now);
      takenDown++;
    } else {
      await tx.update(winLeads).set({ newsStatus: "withdrawn", status: "dismissed", closedBy: v.userId, closedAt: now }).where(eq(winLeads.id, lead.id));
      closed++;
    }
  }
  return { closed, takenDown };
}

// ---------------------------------------------------------------------------
// What families see
// ---------------------------------------------------------------------------

/** One line of "Teamwork alumni in college". No ids of people, never article text or an image. */
export type AlumniClip = { id: string; name: string; detail: string | null; headline: string; source: string; when: string; url: string };

async function approvedAlumniRows(tx: Tx, orgId: string, since: Date, limit: number) {
  return tx
    .select({ l: winLeads, item: newsItems, alum: alumni })
    .from(winLeads)
    .innerJoin(newsItems, eq(newsItems.id, winLeads.newsItemId))
    .innerJoin(alumni, eq(alumni.id, winLeads.alumniId))
    .where(and(eq(winLeads.orgId, orgId), eq(winLeads.kind, "news"), eq(winLeads.newsStatus, "approved"), isNotNull(winLeads.approvedBy), eq(alumni.active, true), eq(alumni.watch, true), gte(winLeads.approvedAt, since), lte(winLeads.approvedAt, new Date(Date.now() + DAY))))
    .orderBy(desc(sql`coalesce(${newsItems.publishedAt}, ${winLeads.approvedAt})`))
    .limit(limit);
}

function alumniLine(r: Awaited<ReturnType<typeof approvedAlumniRows>>[number], tz: string): AlumniClip {
  const name = alumniDisplayName(r.alum);
  return {
    id: r.l.id,
    name,
    detail: [r.alum.sport, r.alum.college].filter(Boolean).join(" · ") || null,
    headline: displayHeadline(r.item.headline, { firstName: r.alum.firstName, lastName: r.alum.lastName }, name, { keepLastName: r.alum.fullNameOk, max: 160 }),
    source: r.item.sourceName,
    when: fmt(r.item.publishedAt ?? r.l.approvedAt ?? r.l.createdAt, "MMM d", tz),
    url: r.item.link,
  };
}

/**
 * "Teamwork alumni in college": approved clips about alumni who are still on the watch list,
 * from the last year. Every signed-in family and staff member; never the kiosk. Empty when
 * community features are off.
 */
export async function alumniNewsFeed(tx: Tx, v: Viewer, opts: { limit?: number; now?: Date } = {}): Promise<AlumniClip[]> {
  if (v.role === "kiosk") throw new AuthzError();
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) return [];
  const rows = await approvedAlumniRows(tx, v.orgId, new Date((opts.now ?? new Date()).getTime() - 365 * DAY), opts.limit ?? 12);
  return rows.map((r) => alumniLine(r, org.tz));
}

/** Gym TV: approved alumni clips from the last 30 days. Name, headline and publication only; no link. */
export async function tvAlumniItems(tx: Tx, orgId: string, opts: { tz: string; now?: Date; limit?: number }): Promise<{ name: string; headline: string; label: string; sport: string; when: string }[]> {
  const rows = await approvedAlumniRows(tx, orgId, new Date((opts.now ?? new Date()).getTime() - 30 * DAY), opts.limit ?? 2);
  return rows.map((r) => {
    const line = alumniLine(r, opts.tz);
    return { name: line.name, headline: line.headline, label: "Alumni in the news", sport: line.source, when: line.when };
  });
}
