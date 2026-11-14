/**
 * Derive-and-upsert engagement state from rows other modules already write.
 *
 * Nothing here is called from another module's write path: `refreshEngagement` reads attendance,
 * workouts, check-in DATES, maxes, forms and goals, then inserts whatever XP events and badges are
 * missing. Unique keys make it safe to run on every page load, repeatedly, and concurrently.
 *
 * These functions take an org id, not a viewer: callers must have checked the viewer's access to
 * the athlete first (see ./access.ts). Health VALUES are never read: only the fact and date of a
 * check-in.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { BAR_SPEED_SOURCE } from "@/lib/training/vbt";
import type { Tx } from "@/db";
import { anywhereCompletions, athleteBadges, athleteGoals, athletes, bookings, formRequests, maxes, membershipHolds, memberships, organizations, questionnaireResponses, scheduleSessions, sessionCheckins, workouts, xpEvents, type XpKind } from "@/db/schema";
import { DEFAULT_TZ, addDaysYmd, fmt, localToUtc, localYmd, todayLocal } from "@/lib/time";
import { EARLY_BIRD_BEFORE_HOUR, STREAK_MILESTONES, evaluateBadges, type BadgeStats } from "./badges";
import { evaluateGoals } from "./goals";
import { levelFor, type LevelInfo } from "./levels";
import { detectPrs, type PrEvent } from "./prs";
import { engagementSettingsOf, type EngagementSettings } from "./settings";
import { computeStreak, type HoldRange, type StreakResult } from "./streaks";

export type Activity = {
  attended: { bookingId: string; startsAt: Date }[];
  workouts: { id: string; completedAt: Date; localDate: string }[];
  /** Finished On Your Own sessions (anywhere module). They count toward the weekly streak. */
  onYourOwn: { id: string; completedAt: Date; localDate: string }[];
  /** One entry per facility-local date with at least one submitted check-in. No answers. */
  checkinDays: { forDate: string; submittedAt: Date }[];
  /** Session check-ins (ready check / after check): which booking and phase, and when. No answers. */
  sessionCheckins: { bookingId: string; phase: "pre" | "post"; at: Date }[];
  prs: PrEvent[];
  holds: HoldRange[];
  goalsAchieved: { id: string; achievedAt: Date }[];
  formsSigned: { id: string; completedAt: Date }[];
};

/** Everything the streak, XP and badge rules need for one athlete. Org-scoped. */
export async function loadActivity(tx: Tx, orgId: string, athleteId: string, tz = DEFAULT_TZ): Promise<Activity> {
  const attended = await tx
    .select({ bookingId: bookings.id, startsAt: scheduleSessions.startsAt })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, orgId), eq(bookings.athleteId, athleteId), eq(bookings.status, "attended")))
    .orderBy(asc(scheduleSessions.startsAt));
  const done = await tx
    .select({ id: workouts.id, completedAt: workouts.completedAt, scheduledDate: workouts.scheduledDate })
    .from(workouts)
    .where(and(eq(workouts.orgId, orgId), eq(workouts.athleteId, athleteId), eq(workouts.status, "completed")));
  const own = await tx
    .select({ id: anywhereCompletions.id, completedAt: anywhereCompletions.completedAt, localDate: anywhereCompletions.localDate })
    .from(anywhereCompletions)
    .where(and(eq(anywhereCompletions.orgId, orgId), eq(anywhereCompletions.athleteId, athleteId)));
  const checkins = await tx
    .select({ forDate: questionnaireResponses.forDate, submittedAt: sql<Date>`min(${questionnaireResponses.submittedAt})`.mapWith(questionnaireResponses.submittedAt) })
    .from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.orgId, orgId), eq(questionnaireResponses.athleteId, athleteId)))
    .groupBy(questionnaireResponses.forDate);
  const sessionChecks = await tx
    .select({ bookingId: sessionCheckins.bookingId, phase: sessionCheckins.phase, at: sessionCheckins.createdAt })
    .from(sessionCheckins)
    .where(and(eq(sessionCheckins.orgId, orgId), eq(sessionCheckins.athleteId, athleteId)));
  const maxRows = await tx
    .select({ id: maxes.id, exerciseId: maxes.exerciseId, value: maxes.value, unit: maxes.unit, kind: maxes.kind, recordedOn: maxes.recordedOn, createdAt: maxes.createdAt })
    .from(maxes)
    // Bar-speed estimates earn no PR, XP or recap line: they are a coaching aid, not a lift.
    .where(and(eq(maxes.orgId, orgId), eq(maxes.athleteId, athleteId), ne(maxes.source, BAR_SPEED_SOURCE)));
  const holdRows = await tx
    .select({ start: membershipHolds.startDate, end: membershipHolds.endDate })
    .from(membershipHolds)
    .innerJoin(memberships, eq(memberships.id, membershipHolds.membershipId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.athleteId, athleteId), eq(membershipHolds.kind, "hold")));
  const goals = await tx
    .select({ id: athleteGoals.id, achievedAt: athleteGoals.achievedAt })
    .from(athleteGoals)
    .where(and(eq(athleteGoals.orgId, orgId), eq(athleteGoals.athleteId, athleteId), eq(athleteGoals.status, "achieved")));
  const forms = await tx
    .select({ id: formRequests.id, completedAt: formRequests.completedAt })
    .from(formRequests)
    .where(and(eq(formRequests.orgId, orgId), eq(formRequests.athleteId, athleteId), eq(formRequests.status, "completed"), eq(formRequests.source, "teamwork")));
  return {
    attended: attended.map((a) => ({ bookingId: a.bookingId, startsAt: a.startsAt })),
    workouts: done.map((w) => {
      const completedAt = w.completedAt ?? localToUtc(w.scheduledDate, "12:00", tz);
      return { id: w.id, completedAt, localDate: w.completedAt ? localYmd(w.completedAt, tz) : w.scheduledDate };
    }),
    onYourOwn: own,
    checkinDays: checkins.map((c) => ({ forDate: c.forDate, submittedAt: c.submittedAt })),
    sessionCheckins: sessionChecks,
    prs: detectPrs(maxRows.map((m) => ({ ...m, value: Number(m.value) }))),
    holds: holdRows,
    goalsAchieved: goals.filter((g): g is { id: string; achievedAt: Date } => !!g.achievedAt).sort((a, b) => a.achievedAt.getTime() - b.achievedAt.getTime()),
    formsSigned: forms.filter((f): f is { id: string; completedAt: Date } => !!f.completedAt),
  };
}

export function streakFromActivity(a: Activity, today: string, tz = DEFAULT_TZ): StreakResult {
  return computeStreak({
    activeDates: [...a.attended.map((x) => localYmd(x.startsAt, tz)), ...a.workouts.map((w) => w.localDate), ...a.onYourOwn.map((o) => o.localDate)],
    holds: a.holds,
    today,
    milestones: STREAK_MILESTONES,
  });
}

type Org = { settings: EngagementSettings; tz: string };
async function orgContext(tx: Tx, orgId: string): Promise<Org> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: engagementSettingsOf(o?.settings), tz: o?.tz ?? DEFAULT_TZ };
}

async function athleteRow(tx: Tx, orgId: string, athleteId: string) {
  const [a] = await tx.select({ id: athletes.id, isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  return a ?? null;
}

type Candidate = { kind: XpKind; sourceType: string; sourceId: string; key: string; occurredAt: Date };

/** The XP events the athlete's history currently justifies (pure given the activity). */
export function xpCandidates(a: Activity, athleteId: string, tz = DEFAULT_TZ): Candidate[] {
  return [
    ...a.attended.map((x): Candidate => ({ kind: "session_attended", sourceType: "booking", sourceId: x.bookingId, key: `session:${x.bookingId}`, occurredAt: x.startsAt })),
    ...a.workouts.map((w): Candidate => ({ kind: "workout_completed", sourceType: "workout", sourceId: w.id, key: `workout:${w.id}`, occurredAt: w.completedAt })),
    ...a.onYourOwn.map((o): Candidate => ({ kind: "on_your_own_completed", sourceType: "anywhere_completion", sourceId: o.id, key: `own:${o.id}`, occurredAt: o.completedAt })),
    // One award per day however many questionnaires were answered. The key holds the date only.
    ...a.checkinDays.map((c): Candidate => ({ kind: "wellness_checkin", sourceType: "checkin_day", sourceId: c.forDate, key: `checkin:${athleteId}:${c.forDate}`, occurredAt: c.submittedAt })),
    // Session check-ins reuse the check-in kind and points. One award per booking and phase, ever:
    // corrections, a second person completing a section, and re-submissions change nothing.
    ...a.sessionCheckins.map((c): Candidate => ({ kind: "wellness_checkin", sourceType: "session_checkin", sourceId: `${c.bookingId}:${c.phase}`, key: `session_checkin:${c.bookingId}:${c.phase}`, occurredAt: c.at })),
    ...a.prs.map((p): Candidate => ({ kind: "pr_set", sourceType: "max", sourceId: p.maxId, key: `pr:${p.maxId}`, occurredAt: localToUtc(p.recordedOn, "12:00", tz) })),
    ...a.goalsAchieved.map((g): Candidate => ({ kind: "goal_achieved", sourceType: "athlete_goal", sourceId: g.id, key: `goal:${g.id}`, occurredAt: g.achievedAt })),
    ...a.formsSigned.map((f): Candidate => ({ kind: "form_signed", sourceType: "form_request", sourceId: f.id, key: `form:${f.id}`, occurredAt: f.completedAt })),
  ];
}

/**
 * Idempotent XP backfill: inserts a ledger row for every qualifying source row that has none.
 * Returns the number of rows inserted. Points come from the org's settings at award time.
 */
export async function syncXp(tx: Tx, orgId: string, athleteId: string, pre?: { activity?: Activity; org?: Org }): Promise<number> {
  const athlete = await athleteRow(tx, orgId, athleteId);
  if (!athlete) return 0;
  const org = pre?.org ?? (await orgContext(tx, orgId));
  if (!org.settings.levelsEnabled) return 0;
  const activity = pre?.activity ?? (await loadActivity(tx, orgId, athleteId, org.tz));
  const candidates = xpCandidates(activity, athleteId, org.tz);
  if (!candidates.length) return 0;
  const have = new Set(
    (await tx.select({ key: xpEvents.idempotencyKey }).from(xpEvents).where(and(eq(xpEvents.orgId, orgId), eq(xpEvents.athleteId, athleteId)))).map((r) => r.key),
  );
  const missing = candidates.filter((c) => !have.has(c.key));
  if (!missing.length) return 0;
  const inserted = await tx
    .insert(xpEvents)
    .values(missing.map((c) => ({ orgId, athleteId, kind: c.kind, points: org.settings.xp[c.kind], sourceType: c.sourceType, sourceId: c.sourceId, idempotencyKey: c.key, occurredAt: c.occurredAt, isDemo: athlete.isDemo })))
    .onConflictDoNothing({ target: [xpEvents.orgId, xpEvents.idempotencyKey] })
    .returning({ id: xpEvents.id });
  return inserted.length;
}

async function badgeStats(tx: Tx, orgId: string, athleteId: string, activity: Activity, today: string, tz: string): Promise<BadgeStats> {
  const streak = streakFromActivity(activity, today, tz);
  const forms = await tx.execute(sql`
    select count(*)::int as required,
           count(*) filter (where done.completed_at is not null)::int as signed,
           max(done.completed_at) as last_at
    from form_templates ft
    left join lateral (
      select max(fr.completed_at) as completed_at
      from form_requests fr join form_template_versions v on v.id = fr.template_version_id
      where fr.org_id = ${orgId} and fr.athlete_id = ${athleteId} and v.template_id = ft.id and fr.status = 'completed'
        and (fr.expires_at is null or fr.expires_at > now())
    ) done on true
    where ft.org_id = ${orgId} and ft.active and ft.required_for_booking`);
  const f = forms.rows[0] as { required: number; signed: number; last_at: string | Date | null } | undefined;
  const formsCompleteAt = f && f.required > 0 && f.signed === f.required && f.last_at ? new Date(f.last_at) : null;
  const mems = await tx.select({ status: memberships.status, startDate: memberships.startDate }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.athleteId, athleteId)));
  const live = mems.some((m) => ["active", "trialing", "on_hold", "past_due"].includes(m.status));
  const firstStart = mems.filter((m) => m.status !== "pending").map((m) => m.startDate).sort()[0];
  const anniversary = firstStart ? `${Number(firstStart.slice(0, 4)) + 1}${firstStart.slice(4)}` : null;
  const reached: Record<number, Date> = {};
  // Dated to the end of the week that completed the run (never in the future).
  const now = new Date();
  for (const [n, week] of Object.entries(streak.reached)) {
    const at = localToUtc(addDaysYmd(week, 6), "12:00", tz);
    reached[Number(n)] = at > now ? now : at;
  }
  return {
    sessionTimes: activity.attended.map((x) => x.startsAt),
    earlyBirdTimes: activity.attended.filter((x) => Number(fmt(x.startsAt, "H", tz)) < EARLY_BIRD_BEFORE_HOUR).map((x) => x.startsAt),
    streakReached: reached,
    prTimes: activity.prs.map((p) => localToUtc(p.recordedOn, "12:00", tz)),
    goalTimes: activity.goalsAchieved.map((g) => g.achievedAt),
    formsCompleteAt,
    anniversaryAt: live && anniversary && anniversary <= today ? localToUtc(anniversary, "12:00", tz) : null,
  };
}

/** Idempotent badge awarding. Returns the keys newly awarded by this call. */
export async function syncBadges(tx: Tx, orgId: string, athleteId: string, opts: { today?: string; activity?: Activity; org?: Org } = {}): Promise<string[]> {
  const athlete = await athleteRow(tx, orgId, athleteId);
  if (!athlete) return [];
  const org = opts.org ?? (await orgContext(tx, orgId));
  if (!org.settings.badgesEnabled) return [];
  const today = opts.today ?? todayLocal(org.tz);
  const activity = opts.activity ?? (await loadActivity(tx, orgId, athleteId, org.tz));
  const earned = evaluateBadges(await badgeStats(tx, orgId, athleteId, activity, today, org.tz));
  if (!earned.length) return [];
  const have = new Set(
    (await tx.select({ key: athleteBadges.badgeKey }).from(athleteBadges).where(and(eq(athleteBadges.orgId, orgId), eq(athleteBadges.athleteId, athleteId), inArray(athleteBadges.badgeKey, earned.map((e) => e.key))))).map((r) => r.key),
  );
  const missing = earned.filter((e) => !have.has(e.key));
  if (!missing.length) return [];
  const rows = await tx
    .insert(athleteBadges)
    .values(missing.map((e) => ({ orgId, athleteId, badgeKey: e.key, earnedAt: e.earnedAt, source: e.source, isDemo: athlete.isDemo })))
    .onConflictDoNothing({ target: [athleteBadges.athleteId, athleteBadges.badgeKey] })
    .returning({ key: athleteBadges.badgeKey });
  return rows.map((r) => r.key);
}

export type EngagementState = {
  settings: EngagementSettings;
  streak: StreakResult;
  /** Null when levels are turned off for the organization. */
  level: LevelInfo | null;
  /** Null when badges are turned off. Newest first. */
  badges: { key: string; earnedAt: Date }[] | null;
  /** Most recent attended session or completed workout. */
  lastActivityAt: Date | null;
  activity: Activity;
};

/**
 * Bring goals, XP and badges up to date for one athlete, then return the current state.
 * Order matters: goals are auto-achieved first so their XP and badge land in the same pass.
 */
export async function refreshEngagement(tx: Tx, orgId: string, athleteId: string, opts: { today?: string } = {}): Promise<EngagementState | null> {
  if (!(await athleteRow(tx, orgId, athleteId))) return null;
  const org = await orgContext(tx, orgId);
  const today = opts.today ?? todayLocal(org.tz);
  await evaluateGoals(tx, orgId, athleteId);
  const activity = await loadActivity(tx, orgId, athleteId, org.tz);
  await syncXp(tx, orgId, athleteId, { activity, org });
  await syncBadges(tx, orgId, athleteId, { today, activity, org });
  return readEngagement(tx, orgId, athleteId, { today, activity, org });
}

/** Read-only state (no writes). */
export async function readEngagement(tx: Tx, orgId: string, athleteId: string, opts: { today?: string; activity?: Activity; org?: Org } = {}): Promise<EngagementState> {
  const org = opts.org ?? (await orgContext(tx, orgId));
  const today = opts.today ?? todayLocal(org.tz);
  const activity = opts.activity ?? (await loadActivity(tx, orgId, athleteId, org.tz));
  let level: LevelInfo | null = null;
  if (org.settings.levelsEnabled) {
    const [r] = await tx.select({ total: sql<number>`coalesce(sum(${xpEvents.points}), 0)::int` }).from(xpEvents).where(and(eq(xpEvents.orgId, orgId), eq(xpEvents.athleteId, athleteId)));
    level = levelFor(r?.total ?? 0);
  }
  const badges = org.settings.badgesEnabled
    ? (await tx.select({ key: athleteBadges.badgeKey, earnedAt: athleteBadges.earnedAt }).from(athleteBadges).where(and(eq(athleteBadges.orgId, orgId), eq(athleteBadges.athleteId, athleteId)))).sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
    : null;
  const times = [...activity.attended.map((x) => x.startsAt.getTime()), ...activity.workouts.map((w) => w.completedAt.getTime()), ...activity.onYourOwn.map((o) => o.completedAt.getTime())];
  return { settings: org.settings, streak: streakFromActivity(activity, today, org.tz), level, badges, lastActivityAt: times.length ? new Date(Math.max(...times)) : null, activity };
}
