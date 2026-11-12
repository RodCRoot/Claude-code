/**
 * Coach weekly scorecard. The four numbers are computed from rows other modules already write
 * (nothing is stored); the only stored part is the coach's short weekly reflection.
 *
 * - Session utilisation: live bookings (booked, attended, no-show) divided by capacity over the
 *   coach's non-cancelled sessions that started in the week.
 * - Client reach-outs logged: staff notes of category reach_out or check_in the coach wrote in the
 *   week (journey steps that record a conversation and "Log a reach-out" both write these).
 * - Client meetings / assessments held: the coach's sessions of kind Assessment in the week with
 *   at least one attended booking.
 * - Touchpoints on time: touchpoint steps due in the week that are assigned to the coach (or were
 *   completed by them): done on or before the due date, out of all that were due.
 *
 * Coaches see their own scorecard; `journey.report` (owner, admin) sees every coach's.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { coachReflections, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, can, isStaff, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, localDayBounds, startOfWeekYmd, todayLocal } from "@/lib/time";
import { journeyContext } from "./sync";
import type { ScorecardTargets } from "./templates";

const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];

export type Scorecard = {
  coachUserId: string;
  coachName: string;
  weekStart: string;
  weekEnd: string;
  sessions: number;
  /** Percent, or null when the coach had no sessions with capacity. */
  utilisationPercent: number | null;
  booked: number;
  capacity: number;
  reachOuts: number;
  meetings: number;
  touchpointsDue: number;
  touchpointsOnTime: number;
  /** Percent, or null when no touchpoint was due. */
  touchpointsOnTimePercent: number | null;
  targets: ScorecardTargets;
  reflection: { wentWell: string | null; stuck: string | null; helpNeeded: string | null; updatedAt: Date } | null;
};

/** Monday of the week containing `day` (or of this week). */
export function weekStartOf(day: string): string {
  return startOfWeekYmd(day);
}

function assertMaySee(v: Viewer, coachUserId: string) {
  if (!isStaff(v)) throw new AuthzError();
  if (coachUserId !== v.userId && !can(v, "journey.report")) throw new AuthzError("You can only see your own scorecard.");
}

/** Pure: percent or null. */
export const percent = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

async function compute(tx: Tx, orgId: string, tz: string, targets: ScorecardTargets, coach: { id: string; name: string }, weekStart: string): Promise<Scorecard> {
  const weekEnd = addDaysYmd(weekStart, 6);
  const from = localDayBounds(weekStart, tz).start.toISOString();
  const to = localDayBounds(weekEnd, tz).end.toISOString();
  const [s] = await rowsOf<{ sessions: number; capacity: number; booked: number; meetings: number }>(
    tx,
    sql`select count(*)::int as sessions, coalesce(sum(x.capacity), 0)::int as capacity, coalesce(sum(x.booked), 0)::int as booked,
          count(*) filter (where x.kind = 'assessment' and x.attended > 0)::int as meetings
        from (
          select s.id, s.capacity, st.kind,
            (select count(*) from bookings b where b.session_id = s.id and b.status in ('booked','attended','no_show')) as booked,
            (select count(*) from bookings b where b.session_id = s.id and b.status = 'attended') as attended
          from schedule_sessions s join service_types st on st.id = s.service_type_id
          where s.org_id = ${orgId} and s.coach_user_id = ${coach.id} and s.status <> 'cancelled' and s.starts_at >= ${from} and s.starts_at < ${to}
        ) x`,
  );
  const [n] = await rowsOf<{ n: number }>(
    tx,
    sql`select count(*)::int as n from notes where org_id = ${orgId} and author_user_id = ${coach.id} and category in ('reach_out','check_in') and created_at >= ${from} and created_at < ${to}`,
  );
  const [t] = await rowsOf<{ due: number; on_time: number }>(
    tx,
    sql`select count(*)::int as due,
          count(*) filter (where t.status = 'done' and (t.completed_at at time zone ${tz})::date <= js.due_on)::int as on_time
        from journey_steps js join tasks t on t.id = js.task_id
        where js.org_id = ${orgId} and js.kind = 'touchpoints' and t.status <> 'cancelled' and js.due_on >= ${weekStart} and js.due_on <= ${weekEnd}
          and (t.assignee_user_id = ${coach.id} or t.completed_by = ${coach.id})`,
  );
  const [r] = await tx.select().from(coachReflections).where(and(eq(coachReflections.orgId, orgId), eq(coachReflections.coachUserId, coach.id), eq(coachReflections.weekStart, weekStart)));
  return {
    coachUserId: coach.id,
    coachName: coach.name,
    weekStart,
    weekEnd,
    sessions: Number(s.sessions),
    booked: Number(s.booked),
    capacity: Number(s.capacity),
    utilisationPercent: percent(Number(s.booked), Number(s.capacity)),
    reachOuts: Number(n.n),
    meetings: Number(s.meetings),
    touchpointsDue: Number(t.due),
    touchpointsOnTime: Number(t.on_time),
    touchpointsOnTimePercent: percent(Number(t.on_time), Number(t.due)),
    targets,
    reflection: r ? { wentWell: r.wentWell, stuck: r.stuck, helpNeeded: r.helpNeeded, updatedAt: r.updatedAt } : null,
  };
}

/** One coach's scorecard for one week. */
export async function coachScorecard(tx: Tx, v: Viewer, opts: { coachUserId?: string; weekStart?: string } = {}): Promise<Scorecard> {
  const coachUserId = opts.coachUserId ?? v.userId;
  assertMaySee(v, coachUserId);
  const [u] = await tx.select({ id: users.id, name: users.displayName, role: users.role }).from(users).where(and(eq(users.id, coachUserId), eq(users.orgId, v.orgId)));
  if (!u || !["owner", "admin", "operations", "coach"].includes(u.role)) throw new AuthzError();
  const { tz, settings } = await journeyContext(tx, v.orgId);
  return compute(tx, v.orgId, tz, settings.targets, u, weekStartOf(opts.weekStart ?? todayLocal(tz)));
}

/** Every coach's scorecard for one week (owner, admin). */
export async function coachScorecards(tx: Tx, v: Viewer, opts: { weekStart?: string } = {}): Promise<Scorecard[]> {
  if (!can(v, "journey.report")) throw new AuthzError();
  const { tz, settings } = await journeyContext(tx, v.orgId);
  const weekStart = weekStartOf(opts.weekStart ?? todayLocal(tz));
  const coaches = await tx.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, v.orgId), eq(users.role, "coach"), sql`${users.disabledAt} is null`)).orderBy(users.displayName);
  const out: Scorecard[] = [];
  for (const c of coaches) out.push(await compute(tx, v.orgId, tz, settings.targets, c, weekStart));
  return out;
}

const reflectionSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wentWell: z.string().trim().max(1500).optional(),
  stuck: z.string().trim().max(1500).optional(),
  helpNeeded: z.string().trim().max(1500).optional(),
});

/** A staff member saves their OWN reflection for a week that has started (never someone else's). */
export async function saveReflection(tx: Tx, v: Viewer, raw: unknown) {
  if (!isStaff(v)) throw new AuthzError();
  const input = reflectionSchema.parse(raw);
  const { tz } = await journeyContext(tx, v.orgId);
  const weekStart = weekStartOf(input.weekStart);
  if (weekStart > todayLocal(tz)) throw new AuthzError("That week has not started yet.");
  const values = { wentWell: input.wentWell || null, stuck: input.stuck || null, helpNeeded: input.helpNeeded || null };
  const [row] = await tx
    .insert(coachReflections)
    .values({ orgId: v.orgId, coachUserId: v.userId, weekStart, ...values })
    .onConflictDoUpdate({ target: [coachReflections.orgId, coachReflections.coachUserId, coachReflections.weekStart], set: { ...values, updatedAt: new Date() } })
    .returning({ id: coachReflections.id });
  // The text itself stays out of the audit log; it is the coach's own words to the owner.
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "scorecard.reflection_save", "coach_reflection", row.id, { summary: `Weekly reflection saved for the week of ${weekStart}` });
  return { ok: true as const };
}
