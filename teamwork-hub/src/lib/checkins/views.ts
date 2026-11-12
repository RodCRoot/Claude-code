import { and, asc, desc, eq, gte, inArray, lt, lte, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, bodyRegionReports, bookings, people, scheduleSessions, sessionCheckins, sessionFeedback, tasks, users, type CheckinAlertReason, type CheckinChip } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, athleteCapabilities, AuthzError, can, coachAthleteIds, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { retentionContext } from "@/lib/retention/common";
import { assertCanRunSession } from "@/lib/scheduling/common";
import { regionLabel } from "@/lib/science/body-regions";
import { srpeLoad } from "@/lib/science/formulas";
import { localDayBounds, localYmd } from "@/lib/time";
import { baselineV1, chipCounts, completionV1, farFromBaseline, intensityGapV1, meanOrNull, type Baseline } from "./baseline";
import { afterTarget, readyTarget } from "./core";
import { checkinSettings } from "./settings";

/**
 * Read side of session check-ins. One rule decides what a viewer gets, per athlete:
 * - health answers (readiness, sleep, soreness, tiredness, mood, stress, pain, the ready-check
 *   note): `health.read` on the athlete. Operations staff and a guardian without health access
 *   never receive them; they are left out of the returned objects, not just hidden;
 * - effort (session RPE, load): `training.read`;
 * - experience (likes, dislikes, rating, notes): the family always sees its own; owner, admin and
 *   operations see every response (`feedback.review`); a coach sees a named response only when
 *   the family ticked "show my coach" and otherwise only class totals.
 */
export type ExperienceAccess = "all" | "shared" | "none";
export type ReadAccess = { any: boolean; health: boolean; effort: boolean; experience: ExperienceAccess };

export async function checkinReadAccess(tx: Tx, v: Viewer, athleteId: string): Promise<ReadAccess> {
  const caps = await athleteCapabilities(tx, v, athleteId);
  if (!caps.has("profile.read")) return { any: false, health: false, effort: false, experience: "none" };
  const family = v.role === "athlete" || v.role === "guardian";
  return { any: true, health: caps.has("health.read"), effort: caps.has("training.read"), experience: family || can(v, "feedback.review") ? "all" : v.role === "coach" ? "shared" : "none" };
}

export const REASON_LABEL: Record<CheckinAlertReason, string> = {
  sharp_pain: "Sharp pain reported",
  hurt_no_location: "Says something hurts (no spot marked)",
  pain_two_sessions: "Something hurt two sessions in a row",
  soreness_above_baseline: "Soreness well above their usual",
  readiness_below_baseline: "Readiness well below their usual",
  disliked_comment: "Left a \"did not like\" comment",
};

const minutesOf = (s: { startsAt: Date; endsAt: Date }) => Math.max(1, Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000));

// ---------------------------------------------------------------------------
// Family: what is open right now
// ---------------------------------------------------------------------------

export type PendingCheckin = { bookingId: string; athleteId: string; athleteFirst: string; title: string; startsAt: Date; timezone: string; kind: "ready" | "after"; state: "open" | "editable"; href: string };

/** Ready checks and after checks the viewer can answer now, soonest first. Family roles only. */
export async function pendingCheckins(tx: Tx, v: Viewer, now = new Date(), opts: { athleteId?: string; limit?: number } = {}): Promise<PendingCheckin[]> {
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  if (ids === "all" || !ids.length) return [];
  const scope = opts.athleteId ? ids.filter((i) => i === opts.athleteId) : ids;
  if (!scope.length) return [];
  const settings = await checkinSettings(tx, v.orgId);
  const { settings: retention } = await retentionContext(tx, v.orgId);
  const from = new Date(now.getTime() - retention.feedbackEntryDays * 86_400_000);
  const to = new Date(now.getTime() + settings.preOpensHoursBefore * 3_600_000);
  const rows = await tx
    .select({ bookingId: bookings.id, athleteId: bookings.athleteId, status: bookings.status, first: people.firstName, preferred: people.preferredName, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, timezone: scheduleSessions.timezone })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(bookings.orgId, v.orgId), inArray(bookings.athleteId, scope), inArray(bookings.status, ["booked", "attended"]), ne(scheduleSessions.status, "cancelled"), gte(scheduleSessions.startsAt, from), lte(scheduleSessions.startsAt, to)))
    .orderBy(desc(scheduleSessions.startsAt))
    .limit(40);
  const out: PendingCheckin[] = [];
  for (const r of rows) {
    const base = { bookingId: r.bookingId, athleteId: r.athleteId, athleteFirst: r.preferred ?? r.first, title: r.title, startsAt: r.startsAt, timezone: r.timezone };
    if (settings.preEnabled && now.getTime() <= r.startsAt.getTime() + 3_600_000) {
      const t = await readyTarget(tx, v, r.bookingId, now);
      if (t.state === "open" || t.state === "editable") out.push({ ...base, kind: "ready", state: t.state, href: `/check-ins/${r.bookingId}/ready` });
    }
    if (settings.postEnabled && r.status === "attended" && now >= r.endsAt) {
      const t = await afterTarget(tx, v, r.bookingId, now);
      if (t.state !== "open") continue;
      const fresh = Object.values(t.sections).some((s) => s === "open") || t.rating === "open";
      // Offer it while something is still unanswered; a finished one stays reachable for corrections from the list page.
      if (fresh) out.push({ ...base, kind: "after", state: "open", href: `/check-ins/${r.bookingId}/after` });
      else if (Object.values(t.sections).some((s) => s === "editable")) out.push({ ...base, kind: "after", state: "editable", href: `/check-ins/${r.bookingId}/after` });
    }
  }
  const rank = (p: PendingCheckin) => (p.state === "open" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? b.startsAt.getTime() - a.startsAt.getTime() : a.kind === "ready" ? -1 : 1)).slice(0, opts.limit ?? 6);
}

// ---------------------------------------------------------------------------
// Coach: readiness strip on the session roster
// ---------------------------------------------------------------------------

export type SpotView = { label: string; kind: "ache" | "sharp"; severity: number };
export type ReadinessRow = {
  bookingId: string;
  athleteId: string;
  done: boolean;
  /** For viewers WITHOUT health access: something in the ready check is meant for the coach. */
  hasNote: boolean;
  /** Null without health access for this athlete, or when no ready check was answered. */
  health: null | {
    checkinId: string;
    readiness: number | null;
    readinessBaseline: Baseline;
    sleepQuality: number | null;
    sleepHours: number | null;
    soreness: number | null;
    sorenessBaseline: Baseline;
    fatigue: number | null;
    mood: number | null;
    hurt: boolean | null;
    spot: SpotView | null;
    note: string | null;
    reasons: CheckinAlertReason[];
    via: "app" | "kiosk" | "parent";
  };
};
export type SessionReadiness = {
  rows: ReadinessRow[];
  booked: number;
  answered: number;
  intendedRpe: number | null;
  /** After-check effort for this session (training data). */
  reported: { count: number; meanRpe: number | null };
  canSetIntended: boolean;
  anyHealth: boolean;
};

function spotView(r: { region: string; side: string; kind: "soreness" | "pain"; severity: number }): SpotView {
  return { label: regionLabel(r.region, r.side), kind: r.kind === "pain" ? "sharp" : "ache", severity: r.severity };
}

/** Per-athlete ready-check summary for one session. Staff only; health details only within the viewer's health scope. */
export async function sessionReadiness(tx: Tx, v: Viewer, sessionId: string): Promise<SessionReadiness | null> {
  if (!isStaff(v)) return null;
  const [s] = await tx.select().from(scheduleSessions).where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, v.orgId)));
  if (!s) return null;
  const settings = await checkinSettings(tx, v.orgId);
  const roster = await tx
    .select({ bookingId: bookings.id, athleteId: bookings.athleteId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, sessionId), eq(bookings.orgId, v.orgId), inArray(bookings.status, ["booked", "attended"])));
  const checks = await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.sessionId, sessionId), eq(sessionCheckins.orgId, v.orgId)));
  const pre = new Map(checks.filter((c) => c.phase === "pre").map((c) => [c.bookingId, c]));
  const healthIds = await accessibleAthleteIds(tx, v, "health.read");
  const trainIds = await accessibleAthleteIds(tx, v, "training.read");
  const sees = (ids: string[] | "all", a: string) => ids === "all" || ids.includes(a);
  const spots = checks.length ? await tx.select().from(bodyRegionReports).where(and(eq(bodyRegionReports.orgId, v.orgId), inArray(bodyRegionReports.sourceCheckinId, checks.map((c) => c.id)))).orderBy(asc(bodyRegionReports.reportedAt)) : [];
  const rows: ReadinessRow[] = [];
  const bopts = { windowDays: settings.baselineWindowDays, minAnswers: settings.baselineMinAnswers };
  for (const r of roster) {
    const c = pre.get(r.bookingId);
    const row: ReadinessRow = { bookingId: r.bookingId, athleteId: r.athleteId, done: !!c, hasNote: !!c && (!!c.note || c.hurt === true || c.alertReasons.length > 0), health: null };
    if (c && sees(healthIds, r.athleteId)) {
      const history = await tx
        .select({ at: scheduleSessions.startsAt, readiness: sessionCheckins.readiness, soreness: sessionCheckins.soreness })
        .from(sessionCheckins)
        .innerJoin(scheduleSessions, eq(scheduleSessions.id, sessionCheckins.sessionId))
        .where(and(eq(sessionCheckins.orgId, v.orgId), eq(sessionCheckins.athleteId, r.athleteId), eq(sessionCheckins.phase, "pre"), lt(scheduleSessions.startsAt, s.startsAt), gte(scheduleSessions.startsAt, new Date(s.startsAt.getTime() - settings.baselineWindowDays * 86_400_000))));
      const spot = spots.filter((x) => x.sourceCheckinId === c.id).pop();
      row.health = {
        checkinId: c.id,
        readiness: c.readiness,
        readinessBaseline: baselineV1(history.map((h) => ({ at: h.at, value: h.readiness })), s.startsAt, bopts),
        sleepQuality: c.sleepQuality,
        sleepHours: c.sleepHours,
        soreness: c.soreness,
        sorenessBaseline: baselineV1(history.map((h) => ({ at: h.at, value: h.soreness })), s.startsAt, bopts),
        fatigue: c.fatigue,
        mood: c.mood,
        hurt: c.hurt,
        spot: spot ? spotView(spot) : null,
        note: c.note,
        reasons: c.alertReasons,
        via: c.source === "kiosk" ? "kiosk" : c.loggedByParent ? "parent" : "app",
      };
    }
    rows.push(row);
  }
  const rpes = checks.filter((c) => c.phase === "post" && sees(trainIds, c.athleteId)).map((c) => c.rpe);
  return {
    rows,
    booked: roster.length,
    answered: rows.filter((r) => r.done).length,
    intendedRpe: s.intendedRpe,
    reported: { count: rpes.filter((x) => x !== null).length, meanRpe: meanOrNull(rpes, 1) },
    canSetIntended: can(v, "schedule.manage") || (v.role === "coach" && s.coachUserId === v.userId),
    anyHealth: healthIds === "all" || roster.some((r) => healthIds.includes(r.athleteId)),
  };
}

/** The coach's planned intensity for a session (optional). Schedule managers or the session's coach. */
export async function setIntendedRpe(tx: Tx, v: Viewer, input: { sessionId: string; intendedRpe: number | null }) {
  const [s] = await tx.select().from(scheduleSessions).where(and(eq(scheduleSessions.id, input.sessionId), eq(scheduleSessions.orgId, v.orgId))).for("update");
  if (!s) throw new AuthzError();
  assertCanRunSession(v, s);
  if (input.intendedRpe !== null && (!Number.isInteger(input.intendedRpe) || input.intendedRpe < 0 || input.intendedRpe > 10)) throw new UserError("Planned intensity is a whole number from 0 to 10.", { intendedRpe: "0 to 10" });
  if (s.intendedRpe === input.intendedRpe) return;
  await tx.update(scheduleSessions).set({ intendedRpe: input.intendedRpe }).where(eq(scheduleSessions.id, s.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "checkin.intended_rpe_set", "schedule_session", s.id, { summary: `Planned session intensity ${input.intendedRpe === null ? "cleared" : `set to ${input.intendedRpe} of 10`}`, before: { intendedRpe: s.intendedRpe }, after: { intendedRpe: input.intendedRpe } });
}

// ---------------------------------------------------------------------------
// Trends for one athlete
// ---------------------------------------------------------------------------

export type TrendPoint = {
  bookingId: string;
  sessionId: string;
  date: string;
  startsAt: Date;
  title: string;
  readyDone: boolean;
  afterDone: boolean;
  // health (null without access or when unanswered)
  readiness: number | null;
  sleepQuality: number | null;
  sleepHours: number | null;
  soreness: number | null;
  sorenessAfter: number | null;
  /** Next-day soreness for THIS session, reported in a later ready check. */
  nextDaySoreness: number | null;
  readinessBaseline: number | null;
  sorenessBaseline: number | null;
  spots: SpotView[];
  hurt: boolean | null;
  // effort
  rpe: number | null;
  minutes: number | null;
  load: number | null;
  intendedRpe: number | null;
  // experience
  rating: number | null;
  liked: CheckinChip[];
  disliked: CheckinChip[];
  nothingToChange: boolean | null;
};

export type AthleteTrends = {
  access: ReadAccess;
  from: string;
  to: string;
  points: TrendPoint[];
  attended: number;
  readyCount: number;
  afterCount: number;
  /** checkin_baseline_v1 as of now. */
  baselines: { readiness: Baseline; soreness: Baseline; sleepQuality: Baseline; rpe: Baseline } | null;
  minAnswers: number;
  painBySpot: { label: string; count: number; sharp: number; lastDate: string }[];
  sorenessResponse: { date: string; title: string; load: number | null; nextDaySoreness: number }[];
  liked: { key: string; label: string; count: number }[];
  disliked: { key: string; label: string; count: number }[];
};

/** Check-in history for one athlete over the last `days`, shaped by what the viewer may see. Throws when they may see nothing. */
export async function athleteCheckinTrends(tx: Tx, v: Viewer, athleteId: string, opts: { days?: number; now?: Date } = {}): Promise<AthleteTrends> {
  const access = await checkinReadAccess(tx, v, athleteId);
  if (!access.any) throw new AuthzError();
  const now = opts.now ?? new Date();
  const days = opts.days ?? 84;
  const settings = await checkinSettings(tx, v.orgId);
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await tx
    .select({ bookingId: bookings.id, status: bookings.status, sessionId: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, timezone: scheduleSessions.timezone, intendedRpe: scheduleSessions.intendedRpe })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, v.orgId), eq(bookings.athleteId, athleteId), eq(bookings.status, "attended"), gte(scheduleSessions.startsAt, since), lte(scheduleSessions.startsAt, now)))
    .orderBy(asc(scheduleSessions.startsAt));
  const ids = rows.map((r) => r.bookingId);
  const checks = ids.length ? await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.orgId, v.orgId), eq(sessionCheckins.athleteId, athleteId), inArray(sessionCheckins.bookingId, ids))) : [];
  const fbs = ids.length && access.experience !== "none" ? await tx.select().from(sessionFeedback).where(and(eq(sessionFeedback.orgId, v.orgId), inArray(sessionFeedback.bookingId, ids))) : [];
  const spotRows = access.health && checks.length ? await tx.select().from(bodyRegionReports).where(and(eq(bodyRegionReports.orgId, v.orgId), inArray(bodyRegionReports.sourceCheckinId, checks.map((c) => c.id)))) : [];
  // Next-day soreness is stored on the LATER ready check and points back at the session it is about.
  const nextDay = access.health
    ? await tx.select({ prior: sessionCheckins.priorBookingId, value: sessionCheckins.priorSoreness }).from(sessionCheckins).where(and(eq(sessionCheckins.orgId, v.orgId), eq(sessionCheckins.athleteId, athleteId), eq(sessionCheckins.phase, "pre")))
    : [];
  const nextDayBy = new Map(nextDay.filter((n) => n.prior && n.value !== null).map((n) => [n.prior!, n.value!]));
  const bopts = { windowDays: settings.baselineWindowDays, minAnswers: settings.baselineMinAnswers };
  const pre = new Map(checks.filter((c) => c.phase === "pre").map((c) => [c.bookingId, c]));
  const post = new Map(checks.filter((c) => c.phase === "post").map((c) => [c.bookingId, c]));
  const series = (pick: (c: (typeof checks)[number]) => number | null, m: typeof pre) => rows.map((r) => ({ at: r.startsAt, value: m.get(r.bookingId) ? pick(m.get(r.bookingId)!) : null }));
  const readinessSeries = series((c) => c.readiness, pre);
  const sorenessSeries = series((c) => c.soreness, pre);
  const sleepSeries = series((c) => c.sleepQuality, pre);
  const rpeSeries = series((c) => c.rpe, post);
  const shared = (c?: { tellCoach: boolean }) => access.experience === "all" || (access.experience === "shared" && !!c?.tellCoach);

  const points: TrendPoint[] = rows.map((r) => {
    const a = pre.get(r.bookingId);
    const b = post.get(r.bookingId);
    const fb = fbs.find((f) => f.bookingId === r.bookingId);
    const rpe = access.effort ? (b?.rpe ?? null) : null;
    const minutes = access.effort && b?.rpe != null ? (b.durationMinutes ?? minutesOf(r)) : null;
    const mySpots = spotRows.filter((x) => x.sourceCheckinId === a?.id || x.sourceCheckinId === b?.id).map(spotView);
    return {
      bookingId: r.bookingId,
      sessionId: r.sessionId,
      date: localYmd(r.startsAt, r.timezone),
      startsAt: r.startsAt,
      title: r.title,
      readyDone: !!a,
      afterDone: !!b,
      readiness: access.health ? (a?.readiness ?? null) : null,
      sleepQuality: access.health ? (a?.sleepQuality ?? null) : null,
      sleepHours: access.health ? (a?.sleepHours ?? null) : null,
      soreness: access.health ? (a?.soreness ?? null) : null,
      sorenessAfter: access.health ? (b?.soreness ?? null) : null,
      nextDaySoreness: access.health ? (nextDayBy.get(r.bookingId) ?? null) : null,
      readinessBaseline: access.health ? baselineV1(readinessSeries, r.startsAt, bopts).mean : null,
      sorenessBaseline: access.health ? baselineV1(sorenessSeries, r.startsAt, bopts).mean : null,
      spots: access.health ? mySpots : [],
      hurt: access.health ? (a?.hurt === true || b?.hurt === true ? true : a?.hurt === false || b?.hurt === false ? false : null) : null,
      rpe,
      minutes,
      load: srpeLoad(minutes, rpe),
      intendedRpe: access.effort ? r.intendedRpe : null,
      rating: fb && shared(fb) ? fb.rating : null,
      liked: b && shared(b) ? b.likedChips : [],
      disliked: b && shared(b) ? b.dislikedChips : [],
      nothingToChange: b && shared(b) ? b.nothingToChange : null,
    };
  });
  const painMap = new Map<string, { label: string; count: number; sharp: number; lastDate: string }>();
  for (const p of points)
    for (const s of p.spots) {
      const e = painMap.get(s.label) ?? { label: s.label, count: 0, sharp: 0, lastDate: p.date };
      e.count++;
      if (s.kind === "sharp") e.sharp++;
      if (p.date > e.lastDate) e.lastDate = p.date;
      painMap.set(s.label, e);
    }
  const end = new Date(now.getTime() + 1);
  return {
    access,
    from: localYmd(since),
    to: localYmd(now),
    points,
    attended: rows.length,
    readyCount: pre.size,
    afterCount: post.size,
    baselines: access.health || access.effort
      ? {
          readiness: baselineV1(access.health ? readinessSeries : [], end, bopts),
          soreness: baselineV1(access.health ? sorenessSeries : [], end, bopts),
          sleepQuality: baselineV1(access.health ? sleepSeries : [], end, bopts),
          rpe: baselineV1(access.effort ? rpeSeries : [], end, bopts),
        }
      : null,
    minAnswers: settings.baselineMinAnswers,
    painBySpot: [...painMap.values()].sort((a, b) => b.count - a.count),
    sorenessResponse: points.filter((p) => p.nextDaySoreness !== null).map((p) => ({ date: p.date, title: p.title, load: p.load, nextDaySoreness: p.nextDaySoreness! })),
    liked: chipCounts(points.map((p) => p.liked)),
    disliked: chipCounts(points.map((p) => p.disliked)),
  };
}

// ---------------------------------------------------------------------------
// Class / group view for coaches, and the owner report
// ---------------------------------------------------------------------------

export type ClassInsight = {
  key: string;
  title: string;
  slot: string;
  coach: string | null;
  sessions: number;
  attended: number;
  ready: number;
  after: number;
  readyRate: number | null;
  afterRate: number | null;
  meanRpe: number | null;
  intendedRpe: number | null;
  /** intensity_gap_v1 */
  gap: number | null;
  gapSessions: number;
  ratingCount: number;
  /** Null when hidden from a coach by the anonymity minimum, or no ratings. */
  meanRating: number | null;
  ratingHidden: boolean;
  liked: { key: string; label: string; count: number }[];
  disliked: { key: string; label: string; count: number }[];
  /** Chip totals are hidden from a coach below the anonymity minimum of after checks. */
  chipsHidden: boolean;
  nothingToChange: number;
  comments: { checkinId: string; date: string; kind: "liked" | "disliked"; text: string; athleteName: string | null }[];
};

type InsightScope = { from: string; to: string; tz: string; coachUserId?: string | null; groupBy?: "class" | "coach" };

/**
 * Check-in aggregates per class slot (title + weekday + start time) or per coach, for sessions that
 * started in the range. No health values. `coachUserId` narrows to one coach's sessions and turns
 * on the anonymity minimum (retention setting `anonymityMinResponses`) for ratings and chips.
 * Org-scoped helper: callers check the viewer's capability first.
 */
export async function checkinInsights(tx: Tx, orgId: string, scope: InsightScope, opts: { reviewer: boolean; minResponses: number; withComments?: boolean } = { reviewer: false, minResponses: 3 }): Promise<ClassInsight[]> {
  const start = localDayBounds(scope.from, scope.tz).start;
  const end = localDayBounds(scope.to, scope.tz).end;
  const rows = await tx
    .select({ bookingId: bookings.id, athleteId: bookings.athleteId, sessionId: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, timezone: scheduleSessions.timezone, coachUserId: scheduleSessions.coachUserId, coach: users.displayName, intendedRpe: scheduleSessions.intendedRpe })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .leftJoin(users, eq(users.id, scheduleSessions.coachUserId))
    .where(and(eq(bookings.orgId, orgId), eq(bookings.status, "attended"), ne(scheduleSessions.status, "cancelled"), gte(scheduleSessions.startsAt, start), lt(scheduleSessions.startsAt, end), scope.coachUserId ? eq(scheduleSessions.coachUserId, scope.coachUserId) : undefined));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.bookingId);
  const checks: (typeof sessionCheckins.$inferSelect)[] = [];
  const fbs: { bookingId: string; rating: number }[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    checks.push(...(await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.orgId, orgId), inArray(sessionCheckins.bookingId, chunk)))));
    fbs.push(...(await tx.select({ bookingId: sessionFeedback.bookingId, rating: sessionFeedback.rating }).from(sessionFeedback).where(and(eq(sessionFeedback.orgId, orgId), inArray(sessionFeedback.bookingId, chunk)))));
  }
  const pre = new Map(checks.filter((c) => c.phase === "pre").map((c) => [c.bookingId, c]));
  const post = new Map(checks.filter((c) => c.phase === "post").map((c) => [c.bookingId, c]));
  const rating = new Map(fbs.map((f) => [f.bookingId, f.rating]));
  const fmtSlot = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(d);
  const groups = new Map<string, { title: string; slot: string; coach: string | null; rows: typeof rows }>();
  for (const r of rows) {
    const slot = fmtSlot(r.startsAt, r.timezone);
    const key = scope.groupBy === "coach" ? `coach:${r.coachUserId ?? "none"}` : `${r.title}|${slot}`;
    const g = groups.get(key) ?? { title: scope.groupBy === "coach" ? (r.coach ?? "No coach") : r.title, slot: scope.groupBy === "coach" ? "" : slot, coach: r.coach, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const names = opts.withComments
    ? new Map((await tx.select({ id: athletes.id, first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.orgId, orgId))).map((a) => [a.id, `${a.first} ${a.last}`]))
    : new Map<string, string>();
  const out: ClassInsight[] = [];
  for (const [key, g] of groups) {
    const posts = g.rows.map((r) => post.get(r.bookingId)).filter((c): c is NonNullable<typeof c> => !!c);
    const ratings = g.rows.map((r) => rating.get(r.bookingId)).filter((x): x is number => x !== undefined);
    const bySession = new Map<string, { intended: number | null; reported: (number | null)[] }>();
    for (const r of g.rows) {
      const e = bySession.get(r.sessionId) ?? { intended: r.intendedRpe, reported: [] };
      e.reported.push(post.get(r.bookingId)?.rpe ?? null);
      bySession.set(r.sessionId, e);
    }
    const gap = intensityGapV1([...bySession.values()]);
    const ratingHidden = !opts.reviewer && ratings.length > 0 && ratings.length < opts.minResponses;
    const experience = posts.filter((c) => c.answeredBy.experience);
    const chipsHidden = !opts.reviewer && experience.length > 0 && experience.length < opts.minResponses;
    const comments: ClassInsight["comments"] = [];
    if (opts.withComments)
      for (const c of posts) {
        // A coach reads a comment only when the family chose to share it; reviewers read all.
        if (!opts.reviewer && !c.tellCoach) continue;
        const r = g.rows.find((x) => x.bookingId === c.bookingId)!;
        const base = { checkinId: c.id, date: localYmd(r.startsAt, r.timezone), athleteName: names.get(c.athleteId) ?? null };
        if (c.likedText) comments.push({ ...base, kind: "liked", text: c.likedText });
        if (c.dislikedText) comments.push({ ...base, kind: "disliked", text: c.dislikedText });
      }
    out.push({
      key,
      title: g.title,
      slot: g.slot,
      coach: g.coach,
      sessions: bySession.size,
      attended: g.rows.length,
      ready: g.rows.filter((r) => pre.has(r.bookingId)).length,
      after: posts.length,
      readyRate: completionV1(g.rows.filter((r) => pre.has(r.bookingId)).length, g.rows.length),
      afterRate: completionV1(posts.length, g.rows.length),
      meanRpe: meanOrNull(posts.map((c) => c.rpe), 1),
      intendedRpe: meanOrNull([...bySession.values()].map((s) => s.intended), 1),
      gap: gap.gap,
      gapSessions: gap.sessions,
      ratingCount: ratings.length,
      meanRating: ratingHidden ? null : meanOrNull(ratings, 2),
      ratingHidden,
      liked: chipsHidden ? [] : chipCounts(experience.map((c) => c.likedChips)),
      disliked: chipsHidden ? [] : chipCounts(experience.map((c) => c.dislikedChips)),
      chipsHidden,
      nothingToChange: chipsHidden ? 0 : experience.filter((c) => c.nothingToChange === true).length,
      comments: comments.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8),
    });
  }
  return out.sort((a, b) => b.attended - a.attended || a.title.localeCompare(b.title));
}

/** Class view for the signed-in staff member: a coach gets their own sessions; owner / admin / operations get all. */
export async function classInsightsFor(tx: Tx, v: Viewer, range: { from: string; to: string; tz: string }): Promise<ClassInsight[]> {
  if (!isStaff(v)) throw new AuthzError();
  const { settings } = await retentionContext(tx, v.orgId);
  const reviewer = can(v, "feedback.review");
  return checkinInsights(tx, v.orgId, { ...range, coachUserId: v.role === "coach" ? v.userId : null }, { reviewer, minResponses: settings.anonymityMinResponses, withComments: true });
}

/** Org-wide completion for dashboards (checkin_completion_v1). No names, no health values. */
export async function checkinCompletionSummary(tx: Tx, orgId: string, range: { from: string; to: string; tz: string }) {
  const rows = await checkinInsights(tx, orgId, { ...range, groupBy: "coach" }, { reviewer: true, minResponses: 0 });
  const attended = rows.reduce((a, r) => a + r.attended, 0);
  const ready = rows.reduce((a, r) => a + r.ready, 0);
  const after = rows.reduce((a, r) => a + r.after, 0);
  return { method: "checkin_completion_v1" as const, attended, ready, after, readyRate: completionV1(ready, attended), afterRate: completionV1(after, attended) };
}

// ---------------------------------------------------------------------------
// One response, and the alert list that feeds the follow-ups page
// ---------------------------------------------------------------------------

async function loadCheckin(tx: Tx, orgId: string, id: string) {
  const [r] = await tx
    .select({ c: sessionCheckins, session: scheduleSessions, first: people.firstName, last: people.lastName, personId: athletes.personId, coach: users.displayName })
    .from(sessionCheckins)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, sessionCheckins.sessionId))
    .innerJoin(athletes, eq(athletes.id, sessionCheckins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(users, eq(users.id, scheduleSessions.coachUserId))
    .where(and(eq(sessionCheckins.id, id), eq(sessionCheckins.orgId, orgId)));
  return r ?? null;
}

/** May this staff member read the experience answers of this response with the athlete's name? */
async function experienceVisible(tx: Tx, v: Viewer, c: { tellCoach: boolean; athleteId: string }, session: { coachUserId: string | null }): Promise<boolean> {
  if (can(v, "feedback.review")) return true;
  if (v.role !== "coach" || !c.tellCoach) return false;
  return session.coachUserId === v.userId || (await coachAthleteIds(tx, v)).includes(c.athleteId);
}

/** One response for staff, cut down to what they may see. Throws when that is nothing. */
export async function checkinDetail(tx: Tx, v: Viewer, id: string) {
  if (!isStaff(v)) throw new AuthzError();
  const r = await loadCheckin(tx, v.orgId, id);
  if (!r) throw new AuthzError();
  const caps = await athleteCapabilities(tx, v, r.c.athleteId);
  const health = caps.has("health.read");
  const effort = caps.has("training.read");
  const experience = await experienceVisible(tx, v, r.c, r.session);
  if (!health && !experience && !(effort && r.c.phase === "post")) throw new AuthzError();
  const spot = health ? (await tx.select().from(bodyRegionReports).where(eq(bodyRegionReports.sourceCheckinId, r.c.id)).orderBy(desc(bodyRegionReports.reportedAt)).limit(1))[0] : undefined;
  const [fb] = experience ? await tx.select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, r.c.bookingId)) : [];
  const c = r.c;
  return {
    id: c.id,
    phase: c.phase,
    athleteId: c.athleteId,
    // Without health access or a shared experience answer the name stays off (the effort number alone is not tied to a person here).
    athleteName: health || experience ? `${r.first} ${r.last}` : null,
    personId: health || experience ? r.personId : null,
    sessionId: r.session.id,
    sessionTitle: r.session.title,
    sessionStartsAt: r.session.startsAt,
    timezone: r.session.timezone,
    coachName: r.coach,
    questionSetVersion: c.questionSetVersion,
    via: (c.source === "kiosk" ? "kiosk" : c.loggedByParent ? "parent" : "app") as "kiosk" | "parent" | "app",
    health: health
      ? { readiness: c.readiness, sleepQuality: c.sleepQuality, sleepHours: c.sleepHours, soreness: c.soreness, fatigue: c.fatigue, mood: c.mood, stress: c.stress, priorSoreness: c.priorSoreness, hurt: c.hurt, hurtStartedInSession: c.hurtStartedInSession, spot: spot ? spotView(spot) : null, note: c.phase === "pre" ? c.note : null, reasons: c.alertReasons.filter((x) => x !== "disliked_comment"), prefilled: c.prefilled }
      : null,
    effort: effort && c.phase === "post" ? { rpe: c.rpe, minutes: c.durationMinutes, load: srpeLoad(c.durationMinutes, c.rpe), intendedRpe: r.session.intendedRpe } : null,
    experience: experience && c.phase === "post" ? { liked: c.likedChips, likedText: c.likedText, disliked: c.dislikedChips, dislikedText: c.dislikedText, nothingToChange: c.nothingToChange, note: c.note, tellCoach: c.tellCoach, rating: fb?.rating ?? null } : null,
    reviewTaskOpen: health && !!c.reviewTaskId && !c.reviewedAt,
    experienceTaskId: experience ? c.experienceTaskId : null,
    reviewedAt: c.reviewedAt,
    canReview: caps.has("health.review"),
  };
}

/** Mark the training alert on a check-in as looked at (closes its task). Needs `health.review` on the athlete. */
export async function reviewCheckin(tx: Tx, v: Viewer, id: string, now = new Date()) {
  const r = await loadCheckin(tx, v.orgId, id);
  if (!r) throw new AuthzError();
  const caps = await athleteCapabilities(tx, v, r.c.athleteId);
  if (!caps.has("health.review")) throw new AuthzError();
  if (r.c.reviewedAt) return;
  await tx.update(sessionCheckins).set({ reviewedAt: now, reviewedBy: v.userId }).where(eq(sessionCheckins.id, id));
  if (r.c.reviewTaskId) await tx.update(tasks).set({ status: "done", completedAt: now, completedBy: v.userId }).where(and(eq(tasks.id, r.c.reviewTaskId), eq(tasks.orgId, v.orgId), inArray(tasks.status, ["open", "in_progress"])));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "checkin.review", "session_checkin", id, { summary: "Session check-in marked as reviewed" });
}

/** Close the "did not like" follow-up. Roles that may read the response. */
export async function closeExperienceFollowUp(tx: Tx, v: Viewer, id: string, now = new Date()) {
  const r = await loadCheckin(tx, v.orgId, id);
  if (!r || !isStaff(v) || !(await experienceVisible(tx, v, r.c, r.session))) throw new AuthzError();
  if (!r.c.experienceTaskId) return;
  const done = await tx.update(tasks).set({ status: "done", completedAt: now, completedBy: v.userId }).where(and(eq(tasks.id, r.c.experienceTaskId), eq(tasks.orgId, v.orgId), inArray(tasks.status, ["open", "in_progress"]))).returning({ id: tasks.id });
  if (done.length) await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "checkin.experience_follow_up_done", "session_checkin", id, { summary: "Session feedback follow-up marked done" });
}

export type CheckinAlert = { taskId: string; checkinId: string; kind: "training" | "experience"; athleteName: string | null; sessionTitle: string; sessionStartsAt: Date; timezone: string; reasons: CheckinAlertReason[]; dueAt: Date | null };

/**
 * Open check-in alerts the viewer may act on, for the follow-ups page. Training alerts need
 * `health.review` on the athlete; experience alerts follow the "who may read the response" rule.
 * An unshared experience alert never carries the athlete's name for a coach (they do not get it at all).
 */
export async function openCheckinAlerts(tx: Tx, v: Viewer): Promise<CheckinAlert[]> {
  if (!isStaff(v)) return [];
  const rows = await tx
    .select({ task: tasks, c: sessionCheckins, session: scheduleSessions, first: people.firstName, last: people.lastName })
    .from(tasks)
    .innerJoin(sessionCheckins, eq(sessionCheckins.id, tasks.relatedId))
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, sessionCheckins.sessionId))
    .innerJoin(athletes, eq(athletes.id, sessionCheckins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(tasks.orgId, v.orgId), eq(tasks.source, "session_checkin"), eq(tasks.relatedType, "session_checkin"), inArray(tasks.status, ["open", "in_progress"])))
    .orderBy(asc(tasks.dueAt))
    .limit(200);
  if (!rows.length) return [];
  const reviewIds = await accessibleAthleteIds(tx, v, "health.review");
  const out: CheckinAlert[] = [];
  for (const r of rows) {
    const training = r.c.reviewTaskId === r.task.id;
    const base = { taskId: r.task.id, checkinId: r.c.id, sessionTitle: r.session.title, sessionStartsAt: r.session.startsAt, timezone: r.session.timezone, dueAt: r.task.dueAt, athleteName: `${r.first} ${r.last}` };
    if (training) {
      if (reviewIds === "all" || reviewIds.includes(r.c.athleteId)) out.push({ ...base, kind: "training", reasons: r.c.alertReasons.filter((x) => x !== "disliked_comment") });
    } else if (await experienceVisible(tx, v, r.c, r.session)) out.push({ ...base, kind: "experience", reasons: ["disliked_comment"] });
  }
  return out;
}

export { farFromBaseline };
