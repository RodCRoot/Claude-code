/**
 * Read models for Athlete Home (/today for athletes and guardians) and the coach's Engagement
 * strip. Every section is gated by the viewer's capabilities on the athlete (./access.ts, which
 * defers to policy.ts): a section the viewer may not see is returned as null, never as zeros.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { exercises } from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { questionnairesForAthlete } from "@/lib/science/wellness";
import { DEFAULT_TZ, addDaysYmd, localDayBounds, startOfWeekYmd, todayLocal } from "@/lib/time";
import { engagementAccess, type EngagementAccess } from "./access";
import { badgeDef, type BadgeDef } from "./badges";
import { listGoals, type GoalView } from "./goals";
import type { LevelInfo } from "./levels";
import { refreshEngagement } from "./sync";
import type { StreakResult } from "./streaks";

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];

export type EarnedBadgeView = { def: BadgeDef; earnedAt: Date };

export type EngagementStrip = {
  /** Null when levels are off for the organization. */
  level: LevelInfo | null;
  streak: StreakResult;
  /** Null when badges are off. Newest first. */
  badges: EarnedBadgeView[] | null;
  lastActivityAt: Date | null;
};

/**
 * Level, streak, badges and last activity for one athlete (coaching data: needs training.read).
 * Brings XP, badges and auto-achieved goals up to date first. Throws AuthzError when the viewer
 * may not see the athlete's training.
 */
export async function engagementStrip(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string } = {}): Promise<EngagementStrip> {
  const access = await engagementAccess(tx, v, athleteId);
  if (!access.canSeeTraining) throw new AuthzError();
  const state = await refreshEngagement(tx, v.orgId, athleteId, opts);
  if (!state) throw new AuthzError();
  return stripOf(state);
}

function stripOf(state: NonNullable<Awaited<ReturnType<typeof refreshEngagement>>>): EngagementStrip {
  return {
    level: state.level,
    streak: state.streak,
    badges: state.badges ? state.badges.flatMap((b) => (badgeDef(b.key) ? [{ def: badgeDef(b.key)!, earnedAt: b.earnedAt }] : [])) : null,
    lastActivityAt: state.lastActivityAt,
  };
}

export type ChecklistItem = { key: string; label: string; done: boolean; href: string | null; hint: string | null };

export type AthleteHome = {
  athleteId: string;
  firstName: string;
  access: EngagementAccess;
  today: string;
  /** Workouts scheduled today. Null without training access. */
  workouts: { id: string; title: string; status: string }[] | null;
  nextSession: { id: string; title: string; startsAt: Date; endsAt: Date; coach: string | null } | null;
  upcomingCount: number;
  canBook: boolean;
  engagement: EngagementStrip | null;
  week: {
    weekStart: string;
    attended: number;
    booked: number;
    /** The plan's classes per week, when the plan has a cap. */
    weeklyCap: number | null;
    /** Null without training access. */
    workoutsLogged: number | null;
    workoutsPlanned: number | null;
  };
  /** Newest first. Null without training access. */
  prs: { exercise: string; value: number; unit: string; recordedOn: string; gain: number | null }[] | null;
  /** Active goals. Null without profile access. */
  goals: GoalView[] | null;
  /** Only whether a check-in is due and done today. Null without health access. Never any answer. */
  wellness: { due: boolean; done: boolean } | null;
  /** "What's next" for new athletes; empty when everything is done. */
  checklist: ChecklistItem[];
};

/** Everything Athlete Home shows for one athlete, filtered to what this viewer may see. */
export async function athleteHome(tx: Tx, v: Viewer, athleteId: string, opts: { tz?: string; today?: string; now?: Date } = {}): Promise<AthleteHome> {
  const tz = opts.tz ?? DEFAULT_TZ;
  const today = opts.today ?? todayLocal(tz);
  const now = opts.now ?? new Date();
  const access = await engagementAccess(tx, v, athleteId, today);
  if (!access.canSeeGoals) throw new AuthzError();
  const [who] = await rows<{ first: string; dob: string | null; sport: string | null }>(
    tx,
    sql`select coalesce(p.preferred_name, p.first_name) as first, p.date_of_birth as dob, a.sport
        from athletes a join people p on p.id = a.person_id where a.id = ${athleteId} and a.org_id = ${v.orgId}`,
  );
  if (!who) throw new AuthzError();

  const state = access.canSeeTraining ? await refreshEngagement(tx, v.orgId, athleteId, { today }) : null;

  const workouts = access.canSeeTraining
    ? await rows<{ id: string; title: string; status: string }>(tx, sql`select id, title, status from workouts where org_id = ${v.orgId} and athlete_id = ${athleteId} and scheduled_date = ${today} order by created_at`)
    : null;

  const upcoming = await rows<{ id: string; title: string; starts_at: string | Date; ends_at: string | Date; coach: string | null }>(
    tx,
    sql`select s.id, s.title, s.starts_at, s.ends_at, u.display_name as coach
        from bookings b join schedule_sessions s on s.id = b.session_id left join users u on u.id = s.coach_user_id
        where b.org_id = ${v.orgId} and b.athlete_id = ${athleteId} and b.status = 'booked' and s.status <> 'cancelled' and s.ends_at > ${now.toISOString()}
        order by s.starts_at limit 20`,
  );

  const weekStart = startOfWeekYmd(today);
  const from = localDayBounds(weekStart, tz).start.toISOString();
  const to = localDayBounds(addDaysYmd(weekStart, 7), tz).start.toISOString();
  const [wk] = await rows<{ attended: number; booked: number }>(
    tx,
    sql`select count(*) filter (where b.status = 'attended')::int as attended, count(*) filter (where b.status = 'booked')::int as booked
        from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${v.orgId} and b.athlete_id = ${athleteId} and s.starts_at >= ${from} and s.starts_at < ${to}`,
  );
  const [plan] = await rows<{ cap: number | null }>(
    tx,
    sql`select pv.classes_per_week as cap from memberships m join product_versions pv on pv.id = m.product_version_id
        where m.org_id = ${v.orgId} and m.athlete_id = ${athleteId} and m.status in ('active','trialing') order by m.start_date desc limit 1`,
  );
  const [wo] = access.canSeeTraining
    ? await rows<{ logged: number; planned: number }>(
        tx,
        sql`select count(*) filter (where status = 'completed')::int as logged, count(*) filter (where status <> 'skipped')::int as planned
            from workouts where org_id = ${v.orgId} and athlete_id = ${athleteId} and scheduled_date >= ${weekStart} and scheduled_date <= ${addDaysYmd(weekStart, 6)}`,
      )
    : [null];

  let prs: AthleteHome["prs"] = null;
  if (state) {
    const latest = [...state.activity.prs].reverse().slice(0, 3);
    const names = latest.length ? await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(and(eq(exercises.orgId, v.orgId), inArray(exercises.id, latest.map((p) => p.exerciseId)))) : [];
    prs = latest.map((p) => ({ exercise: names.find((n) => n.id === p.exerciseId)?.name ?? "Exercise", value: p.value, unit: p.unit, recordedOn: p.recordedOn, gain: p.unit === p.previousUnit ? p.value - p.previous : null }));
  }

  const goals = await listGoals(tx, v, athleteId, { today, status: ["active"] });

  let wellness: AthleteHome["wellness"] = null;
  if (access.canSeeHealth) {
    const due = (await questionnairesForAthlete(tx, v, athleteId, today)).filter((q) => q.due);
    wellness = { due: due.length > 0, done: due.length > 0 && due.every((q) => q.response !== null) };
  }

  // --- "What's next" for new athletes ------------------------------------------------------
  const [c] = await rows<{ pending_forms: number; missing_required: number; any_booking: boolean; any_test: boolean; any_goal: boolean }>(
    tx,
    sql`select
          (select count(*)::int from form_requests fr where fr.org_id = ${v.orgId} and fr.athlete_id = ${athleteId} and fr.status in ('pending','partially_signed')) as pending_forms,
          (select count(*)::int from form_templates ft where ft.org_id = ${v.orgId} and ft.active and ft.required_for_booking and not exists (
             select 1 from form_requests fr join form_template_versions fv on fv.id = fr.template_version_id
             where fr.athlete_id = ${athleteId} and fv.template_id = ft.id and fr.status = 'completed' and (fr.expires_at is null or fr.expires_at > now()))) as missing_required,
          exists (select 1 from bookings b where b.org_id = ${v.orgId} and b.athlete_id = ${athleteId} and b.status in ('booked','attended','no_show')) as any_booking,
          (exists (select 1 from test_sessions t where t.org_id = ${v.orgId} and t.athlete_id = ${athleteId})
            or exists (select 1 from maxes m where m.org_id = ${v.orgId} and m.athlete_id = ${athleteId})) as any_test,
          exists (select 1 from athlete_goals g where g.org_id = ${v.orgId} and g.athlete_id = ${athleteId}) as any_goal`,
  );
  const canBook = access.caps.has("booking.create");
  const items: ChecklistItem[] = [
    { key: "profile", label: "Profile complete", done: !!who.dob && !!who.sport, href: "/messages", hint: "Birthday and sport on file. Message the front desk to update them." },
    { key: "forms", label: "Forms signed", done: c.pending_forms === 0 && c.missing_required === 0, href: "/documents", hint: access.caps.has("forms.sign") ? "Sign what is waiting in Documents." : "A parent or guardian signs these in Documents." },
    { key: "booked", label: "First session booked", done: c.any_booking, href: canBook ? `/schedule?athlete=${athleteId}` : null, hint: canBook ? "Pick a time that works." : null },
    ...(access.canSeeTraining ? [{ key: "baseline", label: "Baseline test recorded", done: c.any_test, href: null, hint: "Your coach records this at an assessment." }] : []),
    { key: "goal", label: "First goal set", done: c.any_goal, href: "/goals", hint: "Choose something to work toward." },
  ];

  const next = upcoming[0];
  return {
    athleteId,
    firstName: who.first,
    access,
    today,
    workouts,
    nextSession: next ? { id: next.id, title: next.title, startsAt: new Date(next.starts_at), endsAt: new Date(next.ends_at), coach: next.coach } : null,
    upcomingCount: upcoming.length,
    canBook,
    engagement: state ? stripOf(state) : null,
    week: { weekStart, attended: wk?.attended ?? 0, booked: wk?.booked ?? 0, weeklyCap: plan?.cap ?? null, workoutsLogged: wo?.logged ?? null, workoutsPlanned: wo?.planned ?? null },
    prs,
    goals,
    wellness,
    checklist: items.every((i) => i.done) ? [] : items,
  };
}

/** "in 3 hours", "tomorrow", "in 4 days": a friendly countdown to a session start. Pure. */
export function countdown(startsAt: Date, now: Date, startYmd: string, todayYmd: string): string {
  const ms = startsAt.getTime() - now.getTime();
  if (ms <= 0) return "happening now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (startYmd === todayYmd) {
    const h = Math.round(minutes / 60);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round((Date.UTC(+startYmd.slice(0, 4), +startYmd.slice(5, 7) - 1, +startYmd.slice(8, 10)) - Date.UTC(+todayYmd.slice(0, 4), +todayYmd.slice(5, 7) - 1, +todayYmd.slice(8, 10))) / 86_400_000);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}
