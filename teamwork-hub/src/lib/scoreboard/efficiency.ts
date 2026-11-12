import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { timeEntries } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { calculatePayroll, canManagePayroll, staffMembers } from "@/lib/payroll/service";
import { addDaysYmd, localDayBounds } from "@/lib/time";
import { addMonths, bookingProgram, dayEnd, dayStart, membershipCtes, monthEnd, monthLabel, monthStart, num, rowsOf, sessionLoc, type Ctx, type Row } from "./core";

/**
 * Schedule and payroll efficiency.
 *  - Slot utilisation: one row per weekly time slot (weekday + local start time + class title +
 *    location) over a chosen number of past weeks.
 *  - Payroll: coaching hours and payroll cost per month from the payroll module's own calculation,
 *    as a percent of collected revenue. Missing payroll data is "not available", never 0.
 */

export const SLOT_DEFINITION = {
  key: "slot_utilisation",
  label: "Slot utilisation",
  version: 1,
  definition:
    "One row per weekly slot: weekday, facility-local start time, class title and location. Counts non-cancelled group sessions (class or semi-private, capacity over 1) that started in the period and are already in the past. Average attendance = attended bookings / sessions run. Utilisation = attended / capacity (the Utilization report calls this \"attended / capacity\"; its fill rate uses bookings instead and is shown here as Booked). A slot is CONSISTENTLY FULL when at least the consistency share of its sessions were at or above the full threshold, and CONSISTENTLY UNDER when at least that share were below the under-used threshold; slots with too few sessions are not flagged. The thresholds are starting points you can change, not industry norms. A flag is a prompt to look, not a decision.",
  filterNote: "Location = the session's location. With a program filter only that program's athletes are counted against the full capacity.",
};

export const PAYROLL_DEFINITION = {
  key: "payroll_percent",
  label: "Coaching hours and payroll cost",
  version: 1,
  definition:
    "Per calendar month, from the payroll module's calculation for that month: clocked hours and gross pay (hours x each person's pay rate on the day, before the withholding estimate). Coaching hours are the hours of staff whose role is Coach; payroll cost is gross pay for all staff. Payroll % = gross pay / collected revenue for the month (settled payments, same rule as the Collected revenue report). \"Not available\" means no time-clock entries exist for the month; \"incomplete\" means some hours have no pay rate, so the cost is understated. The month in progress is month to date. Estimates for open shifts are not included.",
  filterNote: "Payroll is not split by location or program, so this table is withheld while a filter is on.",
};

export type SlotRow = {
  weekday: number;
  startTime: string;
  title: string;
  location: string;
  sessions: number;
  capacity: number;
  booked: number;
  attended: number;
  avgAttendance: number;
  utilisation: number | null;
  fillRate: number | null;
  fullSessions: number;
  underSessions: number;
  flag: "full" | "under" | null;
  flagText: string | null;
};

export const SLOT_WEEKS = [4, 8, 12, 26] as const;

export async function slotUtilisation(tx: Tx, c: Ctx, opts: { weeks?: number } = {}): Promise<{ rows: SlotRow[]; from: string; to: string; weeks: number }> {
  const weeks = (SLOT_WEEKS as readonly number[]).includes(opts.weeks ?? 8) ? (opts.weeks ?? 8) : 8;
  const th = c.settings.thresholds;
  const to = addDaysYmd(c.today, -1);
  const from = addDaysYmd(c.today, -weeks * 7);
  const cnt = (statuses: string) => sql`(select count(*)::int from bookings b where b.session_id = s.id and b.status in (${sql.raw(statuses)}) ${bookingProgram(c)})`;
  const rows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)},
      ss as (
        select extract(isodow from (s.starts_at at time zone ${c.tz}))::int as weekday, to_char(s.starts_at at time zone ${c.tz}, 'HH24:MI') as start_time,
          s.title, coalesce(l.name, 'No location') as location, s.capacity,
          ${cnt("'booked','attended','no_show'")} as booked, ${cnt("'attended'")} as attended
        from schedule_sessions s join service_types st on st.id = s.service_type_id left join locations l on l.id = s.location_id
        where s.org_id = ${c.orgId} and s.status <> 'cancelled' and st.kind in ('class','semi_private') and s.capacity > 1
          and s.starts_at >= ${dayStart(c, from)} and s.starts_at < ${dayEnd(c, to)} ${sessionLoc(c)})
      select weekday, start_time, title, location, count(*)::int as sessions, sum(capacity)::int as capacity, sum(booked)::int as booked, sum(attended)::int as attended,
        count(*) filter (where attended * 100 >= capacity * ${th.slotFullPercent}::int)::int as full_sessions,
        count(*) filter (where attended * 100 < capacity * ${th.slotUnderPercent}::int)::int as under_sessions
      from ss group by 1, 2, 3, 4 order by 1, 2, 3, 4`,
  );
  return {
    from,
    to,
    weeks,
    rows: rows.map((r) => {
      const sessions = num(r.sessions);
      const capacity = num(r.capacity);
      const full = num(r.full_sessions);
      const under = num(r.under_sessions);
      const enough = sessions >= th.slotMinSessions;
      const flag = enough && full * 100 >= sessions * th.slotConsistencyPercent ? ("full" as const) : enough && under * 100 >= sessions * th.slotConsistencyPercent ? ("under" as const) : null;
      return {
        weekday: num(r.weekday),
        startTime: String(r.start_time),
        title: String(r.title),
        location: String(r.location),
        sessions,
        capacity,
        booked: num(r.booked),
        attended: num(r.attended),
        avgAttendance: Math.round((num(r.attended) / sessions) * 10) / 10,
        utilisation: capacity ? num(r.attended) / capacity : null,
        fillRate: capacity ? num(r.booked) / capacity : null,
        fullSessions: full,
        underSessions: under,
        flag,
        flagText:
          flag === "full"
            ? `Consistently full: ${full} of ${sessions} sessions at ${th.slotFullPercent}% or more. Consider adding capacity.`
            : flag === "under"
              ? `Consistently under ${th.slotUnderPercent}%: ${under} of ${sessions} sessions. Consider combining with another slot.`
              : null,
      };
    }),
  };
}

export type PayrollMonth = {
  month: string;
  label: string;
  partial: boolean;
  /** "ok" | "none" (no time-clock entries) | "incomplete" (some hours have no pay rate). */
  status: "ok" | "none" | "incomplete";
  coachingHours: number | null;
  totalHours: number | null;
  grossMinor: number | null;
  collectedMinor: number;
  percent: number | null;
};

export type PayrollEfficiency = { access: "ok" | "restricted" | "filtered"; months: PayrollMonth[] };

/** Collected (settled) per month, unfiltered. Keyed by month start. */
async function collectedByMonth(tx: Tx, c: Ctx, first: string, last: string): Promise<Map<string, number>> {
  const rows = await rowsOf<Row>(
    tx,
    sql`select date_trunc('month', coalesce(settled_at, occurred_at) at time zone ${c.tz})::date as m, sum(amount_minor)::bigint as amount
        from transactions where org_id = ${c.orgId} and status = 'settled' and kind in ('charge','manual_payment')
          and coalesce(settled_at, occurred_at) >= ${dayStart(c, first)} and coalesce(settled_at, occurred_at) < ${dayEnd(c, monthEnd(last))}
        group by 1`,
  );
  return new Map(rows.map((r) => [String(r.m).slice(0, 10), num(r.amount)]));
}

/**
 * Payroll per month through the payroll module (`calculatePayroll`), so the hours and dollars are
 * exactly what Payroll shows for the same dates. Needs payroll access; without it the caller gets
 * `restricted` and no figures.
 */
export async function payrollByMonth(tx: Tx, v: Viewer, c: Ctx, opts: { months?: number } = {}): Promise<PayrollEfficiency> {
  if (!(await canManagePayroll(tx, v))) return { access: "restricted", months: [] };
  if (c.filtered) return { access: "filtered", months: [] };
  const count = Math.min(24, Math.max(2, opts.months ?? 6));
  const last = monthStart(c.today);
  const first = addMonths(last, -(count - 1));
  const collected = await collectedByMonth(tx, c, first, last);
  const coaches = new Set((await staffMembers(tx, c.orgId)).filter((s) => s.role === "coach").map((s) => s.userId));
  const months: PayrollMonth[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) {
    const to = m === last ? c.today : monthEnd(m);
    const [has] = await tx
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(and(eq(timeEntries.orgId, c.orgId), isNull(timeEntries.voidedAt), gte(timeEntries.clockIn, localDayBounds(m, c.tz).start), lt(timeEntries.clockIn, localDayBounds(to, c.tz).end)))
      .limit(1);
    const col = collected.get(m) ?? 0;
    const base = { month: m, label: monthLabel(m), partial: m === last, collectedMinor: col };
    if (!has) {
      months.push({ ...base, status: "none", coachingHours: null, totalHours: null, grossMinor: null, percent: null });
      continue;
    }
    const res = await calculatePayroll(tx, v, { from: m, to, now: c.now });
    const incomplete = res.employees.some((e) => e.incomplete);
    const gross = res.combined.actual.grossMinor;
    months.push({
      ...base,
      status: incomplete ? "incomplete" : "ok",
      coachingHours: res.employees.filter((e) => coaches.has(e.userId)).reduce((s, e) => s + e.actual.hoursHundredths, 0) / 100,
      totalHours: res.combined.actual.hoursHundredths / 100,
      grossMinor: gross,
      percent: col > 0 ? gross / col : null,
    });
  }
  return { access: "ok", months };
}
