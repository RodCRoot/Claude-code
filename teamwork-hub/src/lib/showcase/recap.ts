/**
 * Monthly Progress Recap (docs/modules/showcase.md → Monthly recap).
 *
 * One page per athlete per facility-local month, assembled from rows other modules already
 * write: attendance, logged workouts, PRs, badges, goals, test results and upcoming bookings.
 * Wellness, body map and every other health value are never read here.
 *
 * While a month is open the numbers are computed live. Finalizing writes them once into
 * `monthly_recaps.snapshot` under a versioned calculation key; after that a database trigger
 * refuses any change, so a later attendance correction or a new test never rewrites a month a
 * family has already read.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athleteBadges, athletes, exercises, monthlyRecaps, organizations, people, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, accessibleAthleteIds, athleteCapabilities, athleteScopeFilter, can, isStaff, type Viewer } from "@/lib/authz/policy";
import { badgeDef } from "@/lib/engagement/badges";
import { listGoals } from "@/lib/engagement/goals";
import { loadActivity, streakFromActivity } from "@/lib/engagement/sync";
import { isNum } from "@/lib/science/formulas";
import { athleteMetricSeries } from "@/lib/science/kpis";
import { DEFAULT_TZ, addDaysYmd, localDayBounds, localYmd, todayLocal } from "@/lib/time";
import { cleanPlainText, isShareableMetric } from "./allowlist";
import { systemViewer } from "./catalog";
import { showcaseSettingsOf, type ShowcaseSettings } from "./settings";

/** Bump the suffix when a number on the recap changes meaning. Old snapshots keep their key. */
export const RECAP_CALC_KEY = "tw_recap_v1";
export const MAX_COACH_NOTE = 1200;
/** The Athlete Home notice for a finished recap shows for this many days. */
export const RECAP_NOTICE_DAYS = 21;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m: unknown): m is string => typeof m === "string" && MONTH.test(m);
export const monthOf = (ymd: string) => ymd.slice(0, 7);

export function monthBounds(month: string): { start: string; end: string; days: number } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`, days };
}
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
/** First facility-local day on which a month's recap is finalized. */
export function finalizeOn(month: string, graceDays: number): string {
  return addDaysYmd(monthBounds(month).end, graceDays + 1);
}
/** Sessions the plan allows in a month: weekly cap times the month's length in weeks, rounded. Pure. */
export function plannedForMonth(classesPerWeek: number | null, daysInMonth: number): number | null {
  if (classesPerWeek === null || classesPerWeek <= 0) return null;
  return Math.round((classesPerWeek * daysInMonth) / 7);
}

export type RecapSnapshot = {
  calcKey: string;
  month: string;
  period: { start: string; end: string };
  /** Facility-local date the numbers run through (the month's last day once it has ended). */
  asOf: string;
  generatedAt: string;
  athleteFirstName: string;
  /** Visible with profile access. */
  sessions: { attended: number; missed: number; planPerWeek: number | null; planned: number | null; stillBooked: number };
  /** Coaching data: visible with training access only. */
  training: {
    workoutsCompleted: number;
    workoutsPlanned: number;
    streak: { current: number; best: number };
    prs: { exercise: string; value: number; unit: string; date: string; gain: number | null; basis: string }[];
    badges: { key: string; name: string; earnedOn: string }[];
    tests: {
      metric: string;
      unit: string;
      precision: number;
      testName: string;
      date: string;
      value: number;
      /** The comparable result before it (same test, protocol, source and unit), if any. */
      previous: { value: number; date: string } | null;
      change: number | null;
      higherIsBetter: boolean | null;
      /** Earlier results measured a different way, never compared. */
      notCompared: number;
    }[];
  };
  goals: {
    title: string;
    status: "active" | "achieved";
    targetDate: string | null;
    achievedInMonth: boolean;
    /** Measured progress: stripped for viewers without training access. */
    measured: { label: string; target: string; current: string | null; pct: number | null } | null;
  }[];
  next: { month: string; bookedCount: number; bookings: { title: string; startsAt: string }[]; goalsDue: { title: string; targetDate: string }[] };
};

type Row = Record<string, unknown>;
const q = async <T = Row>(tx: Tx, s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as T[];

/** Assemble the full recap for a month. Org-scoped; callers check the viewer first. */
export async function computeRecap(tx: Tx, orgId: string, athleteId: string, month: string, opts: { today?: string; tz?: string; now?: Date } = {}): Promise<RecapSnapshot | null> {
  const tz = opts.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz);
  const { start, end, days } = monthBounds(month);
  const asOf = today < end ? today : end;
  const [who] = await q<{ first: string }>(tx, sql`select coalesce(p.preferred_name, p.first_name) as first from athletes a join people p on p.id = a.person_id where a.id = ${athleteId} and a.org_id = ${orgId}`);
  if (!who) return null;
  const from = localDayBounds(start, tz).start.toISOString();
  const to = localDayBounds(end, tz).end.toISOString();

  const [att] = await q<{ attended: number; missed: number; booked: number }>(
    tx,
    sql`select count(*) filter (where b.status = 'attended')::int as attended,
               count(*) filter (where b.status = 'no_show')::int as missed,
               count(*) filter (where b.status = 'booked' and s.status <> 'cancelled')::int as booked
        from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.athlete_id = ${athleteId} and s.starts_at >= ${from} and s.starts_at < ${to}`,
  );
  const [plan] = await q<{ cap: number | null }>(
    tx,
    sql`select pv.classes_per_week as cap from memberships m join product_versions pv on pv.id = m.product_version_id
        where m.org_id = ${orgId} and m.athlete_id = ${athleteId} and m.start_date <= ${end} and (m.end_date is null or m.end_date >= ${start})
          and m.status not in ('cancelled','expired') order by m.start_date desc limit 1`,
  );
  const [wo] = await q<{ done: number; planned: number }>(
    tx,
    sql`select count(*) filter (where status = 'completed')::int as done, count(*) filter (where status <> 'skipped')::int as planned
        from workouts where org_id = ${orgId} and athlete_id = ${athleteId} and scheduled_date >= ${start} and scheduled_date <= ${end}`,
  );

  const activity = await loadActivity(tx, orgId, athleteId, tz);
  const streak = streakFromActivity(activity, asOf, tz);
  const monthPrs = activity.prs.filter((p) => p.recordedOn >= start && p.recordedOn <= end);
  const names = monthPrs.length ? await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.id, monthPrs.map((p) => p.exerciseId)))) : [];

  const badgeRows = await tx
    .select({ key: athleteBadges.badgeKey, earnedAt: athleteBadges.earnedAt })
    .from(athleteBadges)
    .where(and(eq(athleteBadges.orgId, orgId), eq(athleteBadges.athleteId, athleteId), gte(athleteBadges.earnedAt, new Date(from)), lt(athleteBadges.earnedAt, new Date(to))));

  const series = await athleteMetricSeries(tx, systemViewer(orgId), athleteId, { to: end });
  const tests: RecapSnapshot["training"]["tests"] = [];
  for (const s of series) {
    if (!isShareableMetric(s.metric)) continue;
    const valued = s.points.filter((p) => isNum(p.value));
    const idx = valued.findLastIndex((p) => p.date >= start && p.date <= end);
    if (idx < 0) continue;
    const cur = valued[idx];
    const prev = idx > 0 ? valued[idx - 1] : null;
    tests.push({
      metric: s.metric.name,
      unit: s.metric.unit,
      precision: s.metric.precision,
      testName: cur.testTypeName,
      date: cur.date,
      value: cur.value!,
      previous: prev ? { value: prev.value!, date: prev.date } : null,
      change: prev ? cur.value! - prev.value! : null,
      higherIsBetter: s.metric.higherIsBetter,
      notCompared: s.excludedPoints.length,
    });
  }

  const goalViews = await listGoals(tx, systemViewer(orgId), athleteId, { today: asOf, status: ["active", "achieved"] });
  const goals: RecapSnapshot["goals"] = [];
  for (const g of goalViews) {
    const achievedOn = g.achievedAt ? localYmd(g.achievedAt, tz) : null;
    const achievedInMonth = g.status === "achieved" && !!achievedOn && achievedOn >= start && achievedOn <= end;
    if (g.status === "achieved" && !achievedInMonth) continue;
    if (localYmd(g.createdAt, tz) > end) continue;
    goals.push({
      title: g.title,
      status: g.status === "achieved" ? "achieved" : "active",
      targetDate: g.targetDate,
      achievedInMonth,
      measured: g.link
        ? { label: g.link.label, target: `${g.link.targetValue} ${g.link.targetUnit}`, current: g.progress && isNum(g.progress.current) ? `${g.progress.current} ${g.link.targetUnit}` : null, pct: g.progress?.pct ?? null }
        : null,
    });
  }

  const nextMonth = shiftMonth(month, 1);
  const nb = monthBounds(nextMonth);
  const upcoming = await q<{ title: string; starts_at: string | Date }>(
    tx,
    sql`select s.title, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.athlete_id = ${athleteId} and b.status = 'booked' and s.status <> 'cancelled'
          and s.starts_at >= ${localDayBounds(nb.start, tz).start.toISOString()} and s.starts_at < ${localDayBounds(nb.end, tz).end.toISOString()}
        order by s.starts_at`,
  );

  return {
    calcKey: RECAP_CALC_KEY,
    month,
    period: { start, end },
    asOf,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    athleteFirstName: who.first,
    sessions: { attended: att?.attended ?? 0, missed: att?.missed ?? 0, planPerWeek: plan?.cap ?? null, planned: plannedForMonth(plan?.cap ?? null, days), stillBooked: att?.booked ?? 0 },
    training: {
      workoutsCompleted: wo?.done ?? 0,
      workoutsPlanned: wo?.planned ?? 0,
      streak: { current: streak.current, best: streak.best },
      prs: monthPrs.map((p) => ({ exercise: names.find((n) => n.id === p.exerciseId)?.name ?? "Exercise", value: p.value, unit: p.unit, date: p.recordedOn, gain: p.unit === p.previousUnit ? Number((p.value - p.previous).toFixed(2)) : null, basis: p.basis })),
      badges: badgeRows.flatMap((b) => (badgeDef(b.key) ? [{ key: b.key, name: badgeDef(b.key)!.name, earnedOn: localYmd(b.earnedAt, tz) }] : [])).sort((a, b) => a.earnedOn.localeCompare(b.earnedOn)),
      tests,
    },
    goals,
    next: {
      month: nextMonth,
      bookedCount: upcoming.length,
      bookings: upcoming.slice(0, 5).map((u) => ({ title: u.title, startsAt: new Date(u.starts_at).toISOString() })),
      goalsDue: goalViews.filter((g) => g.status === "active" && g.targetDate && g.targetDate >= nb.start && g.targetDate <= nb.end).map((g) => ({ title: g.title, targetDate: g.targetDate! })),
    },
  };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export type RecapAccess = { canView: boolean; canSeeTraining: boolean; canWriteNote: boolean; settings: ShowcaseSettings; tz: string; firstMonth: string | null };

/**
 * profile.read → the recap exists for you (sessions, goal titles, what is booked next).
 * training.read → workouts, streak, PRs, badges, tests, measured goal progress and the coach note.
 * A payer-only adult holds neither, so sees nothing. Coaches write notes for assigned athletes only.
 */
export async function recapAccess(tx: Tx, v: Viewer, athleteId: string): Promise<RecapAccess> {
  const caps = await athleteCapabilities(tx, v, athleteId);
  const [row] = await tx
    .select({ settings: organizations.settings, tz: organizations.timezone, createdAt: athletes.createdAt })
    .from(athletes)
    .innerJoin(organizations, eq(organizations.id, athletes.orgId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  const settings = showcaseSettingsOf(row?.settings);
  const tz = row?.tz ?? DEFAULT_TZ;
  let firstMonth: string | null = null;
  if (row && caps.has("profile.read")) {
    const [f] = await q<{ first: string | Date | null }>(tx, sql`select min(s.starts_at) as first from bookings b join schedule_sessions s on s.id = b.session_id where b.org_id = ${v.orgId} and b.athlete_id = ${athleteId} and b.status = 'attended'`);
    const created = localYmd(row.createdAt, tz);
    const firstYmd = f?.first ? localYmd(new Date(f.first), tz) : created;
    firstMonth = monthOf(firstYmd < created ? firstYmd : created);
  }
  return {
    canView: !!row && caps.has("profile.read") && (isStaff(v) || settings.recapEnabled),
    canSeeTraining: caps.has("training.read"),
    canWriteNote: isStaff(v) && can(v, "training.manage") && caps.has("training.write"),
    settings,
    tz,
    firstMonth,
  };
}

/** Remove what this viewer may not see. Sections become null, never zeros. */
export function filterRecap(s: RecapSnapshot, canSeeTraining: boolean): Omit<RecapSnapshot, "training"> & { training: RecapSnapshot["training"] | null } {
  if (canSeeTraining) return s;
  return { ...s, training: null, goals: s.goals.map((g) => ({ ...g, measured: null })) };
}

// ---------------------------------------------------------------------------
// Finalize (snapshot once)
// ---------------------------------------------------------------------------

export type Recap = typeof monthlyRecaps.$inferSelect;

async function ensureRecapRow(tx: Tx, orgId: string, athleteId: string, month: string): Promise<Recap> {
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  if (!a) throw new AuthzError();
  await tx.insert(monthlyRecaps).values({ orgId, athleteId, month, status: "open", calcKey: RECAP_CALC_KEY, isDemo: a.isDemo }).onConflictDoNothing({ target: [monthlyRecaps.orgId, monthlyRecaps.athleteId, monthlyRecaps.month] });
  const [row] = await tx.select().from(monthlyRecaps).where(and(eq(monthlyRecaps.orgId, orgId), eq(monthlyRecaps.athleteId, athleteId), eq(monthlyRecaps.month, month))).for("update");
  return row;
}

/**
 * Freeze a month. Idempotent and safe under concurrency (row lock; a finalized row is returned
 * as it is). Only months that have ended can be finalized. Creates the in-app notice; sends nothing.
 */
export async function finalizeRecap(tx: Tx, orgId: string, athleteId: string, month: string, via: "job" | "on_demand" | "staff" | "seed", opts: { today?: string; tz?: string; now?: Date; actor?: Viewer } = {}): Promise<Recap> {
  if (!isMonth(month)) throw new UserError("Unknown month.");
  const tz = opts.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz);
  if (today <= monthBounds(month).end) throw new UserError("That month has not ended yet.");
  const row = await ensureRecapRow(tx, orgId, athleteId, month);
  if (row.status === "final") return row;
  const now = opts.now ?? new Date();
  const snapshot = await computeRecap(tx, orgId, athleteId, month, { today, tz, now });
  if (!snapshot) throw new AuthzError();
  const [done] = await tx
    .update(monthlyRecaps)
    .set({ status: "final", snapshot, calcKey: snapshot.calcKey, finalizedAt: now, finalizedVia: via, noticeAt: now, updatedAt: now })
    .where(eq(monthlyRecaps.id, row.id))
    .returning();
  await audit(tx, { orgId, actorUserId: opts.actor?.userId ?? null, actorRole: opts.actor?.role ?? "system" }, "recap.finalize", "monthly_recap", done.id, {
    summary: `${monthLabel(month)} recap finalized (${via.replace("_", " ")}), calculation ${snapshot.calcKey}`,
  });
  return done;
}

// ---------------------------------------------------------------------------
// Family view
// ---------------------------------------------------------------------------

export type RecapView = {
  athleteId: string;
  month: string;
  /** "final": frozen. "in_progress": the month is still running. "closing": ended, final on `finalOn`. */
  state: "final" | "in_progress" | "closing";
  finalOn: string;
  finalizedAt: Date | null;
  calcKey: string;
  recap: ReturnType<typeof filterRecap>;
  /** Null when blank, or when the viewer has no training access. */
  coachNote: { text: string; by: string | null } | null;
  access: RecapAccess;
};

/**
 * One month for one athlete, as this viewer may see it. Returns null for a month outside the
 * athlete's time at the gym or in the future. A month whose grace period has passed is finalized
 * on this read if the monthly job has not done it yet.
 */
export async function viewRecap(tx: Tx, v: Viewer, athleteId: string, month: string, opts: { today?: string; now?: Date } = {}): Promise<RecapView | null> {
  const access = await recapAccess(tx, v, athleteId);
  if (!access.canView) throw new AuthzError();
  if (!isMonth(month)) return null;
  const today = opts.today ?? todayLocal(access.tz, opts.now);
  if (month > monthOf(today) || (access.firstMonth && month < access.firstMonth)) return null;
  const finalOn = finalizeOn(month, access.settings.recapGraceDays);
  let [row] = await tx.select().from(monthlyRecaps).where(and(eq(monthlyRecaps.orgId, v.orgId), eq(monthlyRecaps.athleteId, athleteId), eq(monthlyRecaps.month, month)));
  if (row?.status !== "final" && today >= finalOn) row = await finalizeRecap(tx, v.orgId, athleteId, month, "on_demand", { today, tz: access.tz, now: opts.now });

  let snapshot: RecapSnapshot | null;
  if (row?.status === "final") snapshot = row.snapshot as RecapSnapshot;
  else snapshot = await computeRecap(tx, v.orgId, athleteId, month, { today, tz: access.tz, now: opts.now });
  if (!snapshot) return null;

  let coachNote: RecapView["coachNote"] = null;
  if (access.canSeeTraining && row?.coachNote) {
    const [u] = row.coachNoteBy ? await tx.select({ name: users.displayName }).from(users).where(eq(users.id, row.coachNoteBy)) : [];
    coachNote = { text: row.coachNote, by: u?.name ?? null };
  }
  return {
    athleteId,
    month,
    state: row?.status === "final" ? "final" : month === monthOf(today) ? "in_progress" : "closing",
    finalOn,
    finalizedAt: row?.finalizedAt ?? null,
    calcKey: row?.status === "final" ? row.calcKey : RECAP_CALC_KEY,
    recap: filterRecap(snapshot, access.canSeeTraining),
    coachNote,
    access,
  };
}

export type RecapMonthRow = { month: string; label: string; state: "final" | "in_progress" | "closing"; isNew: boolean };

/** Months a family can open, newest first (up to 12). */
export async function listRecapMonths(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string; now?: Date } = {}): Promise<RecapMonthRow[]> {
  const access = await recapAccess(tx, v, athleteId);
  if (!access.canView) throw new AuthzError();
  const now = opts.now ?? new Date();
  const today = opts.today ?? todayLocal(access.tz, now);
  const current = monthOf(today);
  const rows = await tx.select({ month: monthlyRecaps.month, status: monthlyRecaps.status, noticeAt: monthlyRecaps.noticeAt }).from(monthlyRecaps).where(and(eq(monthlyRecaps.orgId, v.orgId), eq(monthlyRecaps.athleteId, athleteId)));
  const out: RecapMonthRow[] = [];
  for (let m = current, i = 0; i < 12 && (!access.firstMonth || m >= access.firstMonth); m = shiftMonth(m, -1), i++) {
    const r = rows.find((x) => x.month === m);
    const final = r?.status === "final";
    out.push({ month: m, label: monthLabel(m), state: final ? "final" : m === current ? "in_progress" : "closing", isNew: final && !!r?.noticeAt && now.getTime() - r.noticeAt.getTime() < RECAP_NOTICE_DAYS * 86_400_000 });
  }
  return out;
}

/** For Athlete Home: this month's link and, when one was finalized recently, the in-app notice. Null without access. */
export async function recapNotice(tx: Tx, v: Viewer, athleteId: string, opts: { now?: Date } = {}): Promise<{ current: string; currentLabel: string; ready: { month: string; label: string } | null } | null> {
  const access = await recapAccess(tx, v, athleteId);
  if (!access.canView || isStaff(v)) return null;
  const now = opts.now ?? new Date();
  const current = monthOf(todayLocal(access.tz, now));
  const [r] = await tx
    .select({ month: monthlyRecaps.month })
    .from(monthlyRecaps)
    .where(and(eq(monthlyRecaps.orgId, v.orgId), eq(monthlyRecaps.athleteId, athleteId), eq(monthlyRecaps.status, "final"), gte(monthlyRecaps.noticeAt, new Date(now.getTime() - RECAP_NOTICE_DAYS * 86_400_000))))
    .orderBy(sql`${monthlyRecaps.month} desc`)
    .limit(1);
  return { current, currentLabel: monthLabel(current), ready: r ? { month: r.month, label: monthLabel(r.month) } : null };
}

// ---------------------------------------------------------------------------
// Coach queue
// ---------------------------------------------------------------------------

/** Coach note for an open month. Assigned coach, owner or admin. Blank clears it. Locked once final. */
export async function saveCoachNote(tx: Tx, v: Viewer, input: { athleteId: string; month: string; note: string }, opts: { today?: string } = {}): Promise<Recap> {
  const access = await recapAccess(tx, v, input.athleteId);
  if (!access.canWriteNote) throw new AuthzError();
  if (!isMonth(input.month)) throw new UserError("Unknown month.");
  const today = opts.today ?? todayLocal(access.tz);
  if (input.month > monthOf(today)) throw new UserError("That month has not started yet.");
  const note = cleanPlainText(String(input.note ?? ""));
  if (note.length > MAX_COACH_NOTE) throw new UserError(`Keep the note to ${MAX_COACH_NOTE} characters or fewer.`, { note: "Too long" });
  const row = await ensureRecapRow(tx, v.orgId, input.athleteId, input.month);
  if (row.status === "final") throw new UserError("That month's recap is final, so the note can no longer change.");
  const [saved] = await tx
    .update(monthlyRecaps)
    .set({ coachNote: note || null, coachNoteBy: note ? v.userId : null, coachNoteAt: note ? new Date() : null, updatedAt: new Date() })
    .where(eq(monthlyRecaps.id, row.id))
    .returning();
  // The note text is not copied into the audit log; who and when is enough.
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, note ? "recap.note.save" : "recap.note.clear", "monthly_recap", saved.id, { summary: `${monthLabel(input.month)} coach note ${note ? "saved" : "cleared"} (${note.length} characters)` });
  return saved;
}

/** Staff may close a finished month early (for example once every note is written). */
export async function finalizeRecapByStaff(tx: Tx, v: Viewer, athleteId: string, month: string, opts: { today?: string } = {}): Promise<Recap> {
  const access = await recapAccess(tx, v, athleteId);
  if (!access.canWriteNote) throw new AuthzError();
  return finalizeRecap(tx, v.orgId, athleteId, month, "staff", { today: opts.today, tz: access.tz, actor: v });
}

export type RecapQueueRow = { athleteId: string; name: string; attended: number; workouts: number; note: string | null; noteAt: Date | null; state: "final" | "open" };
export type RecapQueue = { month: string; label: string; finalOn: string; ended: boolean; rows: RecapQueueRow[] };

/** Coach queue for one month: active athletes in the viewer's coaching scope, with their note. */
export async function coachRecapQueue(tx: Tx, v: Viewer, month: string, opts: { today?: string } = {}): Promise<RecapQueue> {
  if (!isStaff(v) || !can(v, "training.manage")) throw new AuthzError();
  if (!isMonth(month)) throw new UserError("Unknown month.");
  const [org] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, v.orgId));
  const tz = org?.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz);
  const { start, end } = monthBounds(month);
  const ids = await accessibleAthleteIds(tx, v, "training.write");
  const list = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(ids, athletes.id)))
    .orderBy(people.lastName, people.firstName);
  const from = localDayBounds(start, tz).start.toISOString();
  const to = localDayBounds(end, tz).end.toISOString();
  const att = await q<{ athlete_id: string; n: number }>(
    tx,
    sql`select b.athlete_id, count(*)::int as n from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${v.orgId} and b.status = 'attended' and s.starts_at >= ${from} and s.starts_at < ${to} group by 1`,
  );
  const wos = await q<{ athlete_id: string; n: number }>(tx, sql`select athlete_id, count(*)::int as n from workouts where org_id = ${v.orgId} and status = 'completed' and scheduled_date >= ${start} and scheduled_date <= ${end} group by 1`);
  const recaps = await tx.select().from(monthlyRecaps).where(and(eq(monthlyRecaps.orgId, v.orgId), eq(monthlyRecaps.month, month)));
  const rows = list
    .map((a): RecapQueueRow => {
      const r = recaps.find((x) => x.athleteId === a.id);
      return { athleteId: a.id, name: `${a.first} ${a.last}`, attended: att.find((x) => x.athlete_id === a.id)?.n ?? 0, workouts: wos.find((x) => x.athlete_id === a.id)?.n ?? 0, note: r?.coachNote ?? null, noteAt: r?.coachNoteAt ?? null, state: r?.status === "final" ? "final" : "open" };
    })
    // Athletes who trained this month first; nobody is hidden.
    .sort((a, b) => Number(b.attended + b.workouts > 0) - Number(a.attended + a.workouts > 0));
  return { month, label: monthLabel(month), finalOn: finalizeOn(month, showcaseSettingsOf(org?.settings).recapGraceDays), ended: today > end, rows };
}

// ---------------------------------------------------------------------------
// Monthly job
// ---------------------------------------------------------------------------

/**
 * Finalize last month's recap for every active athlete who trained in it, once the grace period
 * has passed. Idempotent: run it daily. It only writes recap rows (and with them the in-app
 * notice). It sends no email, SMS or push.
 */
export async function runMonthlyRecaps(tx: Tx, orgId: string, opts: { today?: string; now?: Date } = {}): Promise<{ month: string; finalized: number; skipped: "disabled" | "grace" | null }> {
  const [org] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  const settings = showcaseSettingsOf(org?.settings);
  const tz = org?.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz, opts.now);
  const month = shiftMonth(monthOf(today), -1);
  if (!settings.recapEnabled) return { month, finalized: 0, skipped: "disabled" };
  if (today < finalizeOn(month, settings.recapGraceDays)) return { month, finalized: 0, skipped: "grace" };
  const { start, end } = monthBounds(month);
  const from = localDayBounds(start, tz).start.toISOString();
  const to = localDayBounds(end, tz).end.toISOString();
  const due = await q<{ id: string }>(
    tx,
    sql`select a.id from athletes a
        where a.org_id = ${orgId} and a.active
          and not exists (select 1 from monthly_recaps r where r.org_id = a.org_id and r.athlete_id = a.id and r.month = ${month} and r.status = 'final')
          and (exists (select 1 from bookings b join schedule_sessions s on s.id = b.session_id where b.athlete_id = a.id and b.status = 'attended' and s.starts_at >= ${from} and s.starts_at < ${to})
            or exists (select 1 from workouts w where w.athlete_id = a.id and w.status = 'completed' and w.scheduled_date >= ${start} and w.scheduled_date <= ${end})
            or exists (select 1 from test_sessions t where t.athlete_id = a.id and t.tested_at >= ${from} and t.tested_at < ${to})
            or exists (select 1 from monthly_recaps r where r.org_id = a.org_id and r.athlete_id = a.id and r.month = ${month}))
        order by a.id`,
  );
  for (const a of due) await finalizeRecap(tx, orgId, a.id, month, "job", { today, tz, now: opts.now });
  return { month, finalized: due.length, skipped: null };
}
