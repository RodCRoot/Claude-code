/**
 * Journey completion reporting, by month. The three `...ByMonth` functions take an organization id
 * and plain options (no viewer) so another page, such as an owner scoreboard, can call them after
 * doing its own permission check. `journeyCompletionReport` is the permission-checked entry point
 * this module's own page uses.
 *
 * Months are facility-local calendar months, newest last. Counts are of what was generated: a
 * step that was never created (older than the backfill window) is not in any number.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { todayLocal } from "@/lib/time";
import { journeyContext } from "./sync";
import { addMonthsYmd } from "./templates";

const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];

export type MonthOpts = { today: string; tz: string; months?: number };
const monthList = (today: string, months: number) => Array.from({ length: months }, (_, i) => addMonthsYmd(`${today.slice(0, 7)}-01`, i - (months - 1)).slice(0, 7));

export type OnboardingMonth = { month: string; started: number; completed: number; closed: number; inProgress: number; completionRatePercent: number | null; avgDaysToComplete: number | null };

/** Onboarding journeys by the month they started: how many finished, and how many days it took on average. */
export async function onboardingCompletionByMonth(tx: Tx, orgId: string, o: MonthOpts): Promise<OnboardingMonth[]> {
  const months = monthList(o.today, o.months ?? 6);
  const rows = await rowsOf<{ month: string; started: number; completed: number; closed: number; avg_days: string | null }>(
    tx,
    sql`select to_char(j.started_on, 'YYYY-MM') as month, count(*)::int as started,
          count(*) filter (where j.status = 'completed')::int as completed,
          count(*) filter (where j.status = 'closed')::int as closed,
          avg(((j.completed_at at time zone ${o.tz})::date - j.started_on)) filter (where j.status = 'completed') as avg_days
        from journeys j where j.org_id = ${orgId} and j.kind = 'onboarding' and j.started_on >= ${months[0] + "-01"}::date group by 1`,
  );
  const by = new Map(rows.map((r) => [r.month, r]));
  return months.map((month) => {
    const r = by.get(month);
    const started = Number(r?.started ?? 0);
    const completed = Number(r?.completed ?? 0);
    const closed = Number(r?.closed ?? 0);
    return { month, started, completed, closed, inProgress: started - completed - closed, completionRatePercent: started ? Math.round((completed / started) * 100) : null, avgDaysToComplete: r?.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10 };
  });
}

export type TouchpointMonth = { month: string; due: number; onTime: number; late: number; overdue: number; skipped: number; onTimePercent: number | null };

/**
 * Touchpoint steps by the month they were due (only those due up to today): done on or before the
 * due date, done late, still open past the due date, or skipped.
 */
export async function touchpointTimelinessByMonth(tx: Tx, orgId: string, o: MonthOpts): Promise<TouchpointMonth[]> {
  const months = monthList(o.today, o.months ?? 6);
  const rows = await rowsOf<{ month: string; due: number; on_time: number; late: number; overdue: number; skipped: number }>(
    tx,
    sql`select to_char(js.due_on, 'YYYY-MM') as month, count(*)::int as due,
          count(*) filter (where t.status = 'done' and (t.completed_at at time zone ${o.tz})::date <= js.due_on)::int as on_time,
          count(*) filter (where t.status = 'done' and (t.completed_at at time zone ${o.tz})::date > js.due_on)::int as late,
          count(*) filter (where t.status in ('open','in_progress') and js.due_on < ${o.today}::date)::int as overdue,
          count(*) filter (where t.status = 'cancelled')::int as skipped
        from journey_steps js join tasks t on t.id = js.task_id
        where js.org_id = ${orgId} and js.kind = 'touchpoints' and js.due_on >= ${months[0] + "-01"}::date and js.due_on <= ${o.today}::date group by 1`,
  );
  const by = new Map(rows.map((r) => [r.month, r]));
  return months.map((month) => {
    const r = by.get(month);
    const n = (k: "due" | "on_time" | "late" | "overdue" | "skipped") => Number(r?.[k] ?? 0);
    const judged = n("on_time") + n("late") + n("overdue");
    return { month, due: n("due"), onTime: n("on_time"), late: n("late"), overdue: n("overdue"), skipped: n("skipped"), onTimePercent: judged ? Math.round((n("on_time") / judged) * 100) : null };
  });
}

export type MilestoneMonth = { month: string; reached: number; recognised: number; missed: number; waiting: number; recognisedPercent: number | null };

/**
 * Visit-milestone "recognise this" steps by the month they were due: recognised (done), missed
 * (skipped, or still open after the due date) and waiting (open, not due yet).
 */
export async function milestoneRecognitionByMonth(tx: Tx, orgId: string, o: MonthOpts): Promise<MilestoneMonth[]> {
  const months = monthList(o.today, o.months ?? 6);
  const rows = await rowsOf<{ month: string; reached: number; recognised: number; missed: number }>(
    tx,
    sql`select to_char(js.due_on, 'YYYY-MM') as month, count(*)::int as reached,
          count(*) filter (where t.status = 'done')::int as recognised,
          count(*) filter (where t.status = 'cancelled' or (t.status in ('open','in_progress') and js.due_on < ${o.today}::date))::int as missed
        from journey_steps js join tasks t on t.id = js.task_id
        where js.org_id = ${orgId} and js.kind = 'visit_milestones' and js.due_on >= ${months[0] + "-01"}::date group by 1`,
  );
  const by = new Map(rows.map((r) => [r.month, r]));
  return months.map((month) => {
    const r = by.get(month);
    const reached = Number(r?.reached ?? 0);
    const recognised = Number(r?.recognised ?? 0);
    const missed = Number(r?.missed ?? 0);
    return { month, reached, recognised, missed, waiting: reached - recognised - missed, recognisedPercent: recognised + missed ? Math.round((recognised / (recognised + missed)) * 100) : null };
  });
}

/** Owner / admin: the three tables for the journey report page. */
export async function journeyCompletionReport(tx: Tx, v: Viewer, opts: { today?: string; months?: number } = {}) {
  assertCan(v, "journey.report");
  const { tz } = await journeyContext(tx, v.orgId);
  const o = { today: opts.today ?? todayLocal(tz), tz, months: opts.months ?? 6 };
  return {
    today: o.today,
    onboarding: await onboardingCompletionByMonth(tx, v.orgId, o),
    touchpoints: await touchpointTimelinessByMonth(tx, v.orgId, o),
    milestones: await milestoneRecognitionByMonth(tx, v.orgId, o),
  };
}
