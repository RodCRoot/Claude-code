import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { ReportRange, ReportResult } from "@/lib/reports";
import { formatMoney } from "@/lib/money";
import { addDaysYmd, fmtDate, localDayBounds, startOfWeekYmd } from "@/lib/time";

/**
 * Chart data for reports where a trend or comparison helps. Each chart is a small, typed
 * dataset plus a plain-language summary; the page renders it with a data table so the
 * chart is never the only way to read the numbers. CSV exports are unaffected.
 */
export type ChartUnit = "count" | "usd_minor" | "pct";
export type ReportChart = {
  title: string;
  /** Human-readable unit line, e.g. "Bookings per week". */
  unitLabel: string;
  unit: ChartUnit;
  /** "stacked" columns (parts of a whole), "grouped" columns (side-by-side comparison), "bars" (horizontal ranking). */
  layout: "stacked" | "grouped" | "bars";
  xLabel: string;
  series: { key: string; label: string }[];
  data: ({ x: string; label: string } & Record<string, number | string | null>)[];
  summary: string;
  note?: string;
};

type Row = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** Monday-start weeks covering [from, to]; first/last may be partial. */
export function weeksInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = startOfWeekYmd(from); w <= to; w = addDaysYmd(w, 7)) out.push(w);
  return out;
}

const weekLabel = (w: string) => `Wk of ${fmtDate(w).replace(/, \d{4}$/, "")}`;

/** Bucket per-local-day rows ({day, ...metrics}) into Monday weeks, filling empty weeks with 0. */
export function bucketByWeek<M extends string>(from: string, to: string, rows: Row[], metrics: readonly M[]): ({ x: string; label: string } & Record<M, number>)[] {
  const weeks = weeksInRange(from, to);
  const acc = new Map(weeks.map((w) => [w, Object.fromEntries(metrics.map((m) => [m, 0])) as Record<M, number>]));
  for (const r of rows) {
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    const b = acc.get(startOfWeekYmd(day));
    if (!b) continue;
    for (const m of metrics) b[m] += n(r[m]);
  }
  return weeks.map((w) => ({ x: w, label: weekLabel(w), ...acc.get(w)! }));
}

const rangeNote = (r: ReportRange) => {
  const first = startOfWeekYmd(r.from) !== r.from;
  const last = addDaysYmd(startOfWeekYmd(r.to), 6) !== r.to;
  return first || last ? "Weeks start on Monday; the first and/or last week only include days inside the selected range." : "Weeks start on Monday.";
};

export async function attendanceByWeek(tx: Tx, orgId: string, r: ReportRange): Promise<ReportChart> {
  const start = localDayBounds(r.from, r.tz).start.toISOString();
  const end = localDayBounds(r.to, r.tz).end.toISOString();
  const rows = (
    await tx.execute(sql`
      select (s.starts_at at time zone ${r.tz})::date::text as day,
        count(b.id) filter (where b.status = 'attended')::int as attended,
        count(b.id) filter (where b.status = 'no_show')::int as no_show,
        count(b.id) filter (where b.status = 'late_cancelled')::int as late_cancel
      from schedule_sessions s left join bookings b on b.session_id = s.id
      where s.org_id = ${orgId} and s.starts_at >= ${start} and s.starts_at < ${end} and s.status <> 'cancelled'
        ${r.locationId ? sql`and s.location_id = ${r.locationId}` : sql``}
      group by 1`)
  ).rows as Row[];
  const data = bucketByWeek(r.from, r.to, rows, ["attended", "no_show", "late_cancel"]);
  const att = data.reduce((s, d) => s + d.attended, 0);
  const ns = data.reduce((s, d) => s + d.no_show, 0);
  const lc = data.reduce((s, d) => s + d.late_cancel, 0);
  const top = [...data].sort((a, b) => b.attended - a.attended)[0];
  return {
    title: "Attendance by week",
    unitLabel: "Bookings per week",
    unit: "count",
    layout: "stacked",
    xLabel: "Week",
    series: [
      { key: "attended", label: "Attended" },
      { key: "no_show", label: "No-show" },
      { key: "late_cancel", label: "Late cancel" },
    ],
    data,
    summary:
      att + ns + lc === 0
        ? `No attended, no-show, or late-cancelled bookings across ${data.length} week${data.length === 1 ? "" : "s"}.`
        : `${att.toLocaleString()} attended visits, ${ns.toLocaleString()} no-shows and ${lc.toLocaleString()} late cancels across ${data.length} weeks. Busiest week: ${top.label} with ${top.attended.toLocaleString()} attended.`,
    note: rangeNote(r),
  };
}

export async function collectionsByWeek(tx: Tx, orgId: string, r: ReportRange): Promise<ReportChart> {
  const start = localDayBounds(r.from, r.tz).start.toISOString();
  const end = localDayBounds(r.to, r.tz).end.toISOString();
  const rows = (
    await tx.execute(sql`
      select (coalesce(settled_at, occurred_at) at time zone ${r.tz})::date::text as day, sum(amount_minor)::bigint as settled, 0::bigint as pending
        from transactions
        where org_id = ${orgId} and status = 'settled' and kind in ('charge','manual_payment')
          and coalesce(settled_at, occurred_at) >= ${start} and coalesce(settled_at, occurred_at) < ${end}
        group by 1
      union all
      select (occurred_at at time zone ${r.tz})::date::text, 0, sum(amount_minor)::bigint
        from transactions
        where org_id = ${orgId} and status = 'pending' and kind in ('charge','manual_payment') and occurred_at >= ${start} and occurred_at < ${end}
        group by 1`)
  ).rows as Row[];
  const data = bucketByWeek(r.from, r.to, rows, ["settled", "pending"]);
  const settled = data.reduce((s, d) => s + d.settled, 0);
  const pending = data.reduce((s, d) => s + d.pending, 0);
  const top = [...data].sort((a, b) => b.settled - a.settled)[0];
  return {
    title: "Settled vs pending payments by week",
    unitLabel: "US dollars per week",
    unit: "usd_minor",
    layout: "grouped",
    xLabel: "Week",
    series: [
      { key: "settled", label: "Settled (collected)" },
      { key: "pending", label: "Pending (not collected)" },
    ],
    data,
    summary:
      settled + pending === 0
        ? "No settled or pending payments in this range."
        : `${formatMoney(settled)} settled and ${formatMoney(pending)} still pending across ${data.length} weeks.${settled ? ` Highest settled week: ${top.label} (${formatMoney(top.settled)}).` : ""}`,
    note: `${rangeNote(r)} Settled payments are placed in the week they settled; pending payments in the week they were initiated (pending payments started before the range appear in the totals above, not in this chart).`,
  };
}

export const AGING_BUCKETS = [
  { key: "current", label: "Current", lo: 0, hi: 0 },
  { key: "d1_30", label: "1–30 days", lo: 1, hi: 30 },
  { key: "d31_60", label: "31–60 days", lo: 31, hi: 60 },
  { key: "d61_90", label: "61–90 days", lo: 61, hi: 90 },
  { key: "d90", label: "90+ days", lo: 91, hi: Infinity },
] as const;

/** Unpaid balance by days past due, from the receivables rows. Invoices with no due date count as current. */
export function receivablesAging(result: ReportResult): ReportChart {
  const data = AGING_BUCKETS.map((b) => ({
    x: b.key,
    label: b.label,
    balance: result.rows.filter((x) => n(x.days_past_due) >= b.lo && n(x.days_past_due) <= b.hi).reduce((s, x) => s + n(x.balance_minor), 0),
  }));
  const total = data.reduce((s, d) => s + d.balance, 0);
  const over60 = data.filter((d) => d.x === "d61_90" || d.x === "d90").reduce((s, d) => s + d.balance, 0);
  const top = [...data].sort((a, b) => b.balance - a.balance)[0];
  return {
    title: "Receivables aging",
    unitLabel: "Unpaid balance, US dollars",
    unit: "usd_minor",
    layout: "grouped",
    xLabel: "Days past due",
    series: [{ key: "balance", label: "Unpaid balance" }],
    data,
    summary: total === 0 ? "No unpaid balance on open invoices." : `${formatMoney(total)} unpaid in total; the largest share is ${top.label.toLowerCase()} (${formatMoney(top.balance)}). ${formatMoney(over60)} is more than 60 days past due.`,
    note: "As of today, regardless of the date range. Pending payments do not reduce the balance until they settle.",
  };
}

/** Fill rate (booked ÷ capacity) per coach, summed across services, highest first. */
export function utilizationByCoach(result: ReportResult): ReportChart {
  const by = new Map<string, { capacity: number; booked: number; sessions: number }>();
  for (const x of result.rows) {
    const k = String(x.coach);
    const cur = by.get(k) ?? { capacity: 0, booked: 0, sessions: 0 };
    cur.capacity += n(x.capacity);
    cur.booked += n(x.booked);
    cur.sessions += n(x.sessions);
    by.set(k, cur);
  }
  const data = [...by.entries()]
    .map(([coach, v]) => ({ x: coach, label: coach, fill_rate: v.capacity ? v.booked / v.capacity : null, sessions: v.sessions }))
    .sort((a, b) => (b.fill_rate ?? -1) - (a.fill_rate ?? -1));
  const rated = data.filter((d) => d.fill_rate != null);
  return {
    title: "Fill rate by coach",
    unitLabel: "Booked ÷ capacity, percent",
    unit: "pct",
    layout: "bars",
    xLabel: "Coach",
    series: [{ key: "fill_rate", label: "Fill rate" }],
    data,
    summary:
      rated.length === 0
        ? "No sessions with capacity in this range."
        : rated.length === 1
          ? `${rated[0].label}: ${pct(rated[0].fill_rate!)} filled across ${rated[0].sessions} sessions.`
          : `Highest fill rate: ${rated[0].label} (${pct(rated[0].fill_rate!)}). Lowest: ${rated[rated.length - 1].label} (${pct(rated[rated.length - 1].fill_rate!)}).`,
    note: "Coaches with no capacity recorded show no bar (not 0%).",
  };
}

/** Chart for a report key, or null when the report has none. */
export async function chartFor(key: string, tx: Tx, orgId: string, r: ReportRange, result: ReportResult): Promise<ReportChart | null> {
  switch (key) {
    case "attendance":
      return attendanceByWeek(tx, orgId, r);
    case "collections":
      return collectionsByWeek(tx, orgId, r);
    case "receivables":
      return receivablesAging(result);
    case "utilization":
      return utilizationByCoach(result);
    default:
      return null;
  }
}
