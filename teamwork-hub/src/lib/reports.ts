import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { OrgCapability } from "@/lib/authz/policy";
import { localDayBounds } from "@/lib/time";

export type ReportColumn = { key: string; label: string; kind?: "money" | "int" | "pct" | "date" | "datetime" | "text" };
export type ReportRange = { from: string; to: string; tz: string };
export type ReportResult = { rows: Record<string, unknown>[]; summary?: { label: string; value: string | number; kind?: ReportColumn["kind"] }[]; notes?: string[] };

export type ReportDef = {
  key: string;
  title: string;
  category: "Memberships" | "Attendance" | "Money" | "Retention" | "Staff";
  /** Plain-language definition shown with the report. */
  definition: string;
  cap: OrgCapability;
  columns: ReportColumn[];
  run: (tx: Tx, orgId: string, r: ReportRange) => Promise<ReportResult>;
};

type Row = Record<string, unknown>;
const q = async (tx: Tx, s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
const bounds = (r: ReportRange) => {
  const start = localDayBounds(r.from, r.tz).start.toISOString();
  const end = localDayBounds(r.to, r.tz).end.toISOString();
  return { start, end };
};
const n = (v: unknown) => (v == null ? 0 : Number(v));

export const REPORTS: ReportDef[] = [
  {
    key: "active-memberships",
    title: "Active memberships",
    category: "Memberships",
    definition:
      "Memberships whose status is active, trialing, on hold, or past due on the end date, grouped by product. 'Scheduled recurring revenue' is the monthly-equivalent list price of those memberships — money expected to be billed, NOT money collected. Memberships billed by Zen Planner (imported) are shown separately and excluded from scheduled revenue.",
    cap: "reports.financial",
    columns: [
      { key: "product", label: "Product" },
      { key: "billing", label: "Billed by" },
      { key: "active", label: "Active", kind: "int" },
      { key: "on_hold", label: "On hold", kind: "int" },
      { key: "past_due", label: "Past due", kind: "int" },
      { key: "monthly_minor", label: "Scheduled recurring / month", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const rows = await q(
        tx,
        sql`select p.name as product, m.billing_provider as billing,
              count(*) filter (where m.status in ('active','trialing'))::int as active,
              count(*) filter (where m.status = 'on_hold')::int as on_hold,
              count(*) filter (where m.status = 'past_due')::int as past_due,
              coalesce(sum(case when m.billing_provider <> 'external_zenplanner' and m.status in ('active','trialing','past_due') then
                case pv.interval when 'month' then pv.price_minor / pv.interval_count
                                 when 'week' then round(pv.price_minor * 52.0 / 12 / pv.interval_count)
                                 when 'year' then round(pv.price_minor / 12.0 / pv.interval_count) else 0 end else 0 end),0)::bigint as monthly_minor
            from memberships m join product_versions pv on pv.id = m.product_version_id join products p on p.id = pv.product_id
            where m.org_id = ${orgId} and m.start_date <= ${r.to} and (m.end_date is null or m.end_date >= ${r.to})
              and m.status in ('active','trialing','on_hold','past_due')
            group by p.name, m.billing_provider order by p.name`,
      );
      const total = rows.reduce((s, x) => s + n(x.monthly_minor), 0);
      return { rows, summary: [{ label: "Scheduled recurring revenue / month (not collected)", value: total, kind: "money" }, { label: "Active memberships", value: rows.reduce((s, x) => s + n(x.active), 0) }] };
    },
  },
  {
    key: "attendance",
    title: "Attendance by service",
    category: "Attendance",
    definition:
      "Bookings for sessions that started in the date range, by service type. Attended = checked in or marked attended. No-show and late-cancel follow each session type's cancellation policy. Cancelled-in-time bookings are not counted as attendance.",
    cap: "reports.operational",
    columns: [
      { key: "service", label: "Service" },
      { key: "sessions", label: "Sessions", kind: "int" },
      { key: "booked", label: "Booked", kind: "int" },
      { key: "attended", label: "Attended", kind: "int" },
      { key: "no_show", label: "No-show", kind: "int" },
      { key: "late_cancel", label: "Late cancel", kind: "int" },
      { key: "attendance_rate", label: "Attended ÷ (attended + no-show)", kind: "pct" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select st.name as service, count(distinct s.id)::int as sessions,
              count(b.id) filter (where b.status in ('booked','attended','no_show'))::int as booked,
              count(b.id) filter (where b.status = 'attended')::int as attended,
              count(b.id) filter (where b.status = 'no_show')::int as no_show,
              count(b.id) filter (where b.status = 'late_cancelled')::int as late_cancel
            from schedule_sessions s join service_types st on st.id = s.service_type_id
            left join bookings b on b.session_id = s.id
            where s.org_id = ${orgId} and s.starts_at >= ${start} and s.starts_at < ${end} and s.status <> 'cancelled'
            group by st.name order by st.name`,
      );
      for (const x of rows) x.attendance_rate = n(x.attended) + n(x.no_show) ? n(x.attended) / (n(x.attended) + n(x.no_show)) : null;
      return { rows, summary: [{ label: "Attended visits", value: rows.reduce((s, x) => s + n(x.attended), 0) }, { label: "No-shows", value: rows.reduce((s, x) => s + n(x.no_show), 0) }] };
    },
  },
  {
    key: "utilization",
    title: "Session utilization",
    category: "Attendance",
    definition: "For non-cancelled sessions in the range: fill rate = booked (incl. attended/no-show) ÷ capacity; show-up rate = attended ÷ capacity. Grouped by coach and service.",
    cap: "reports.operational",
    columns: [
      { key: "coach", label: "Coach" },
      { key: "service", label: "Service" },
      { key: "sessions", label: "Sessions", kind: "int" },
      { key: "capacity", label: "Capacity", kind: "int" },
      { key: "booked", label: "Booked", kind: "int" },
      { key: "attended", label: "Attended", kind: "int" },
      { key: "fill_rate", label: "Fill rate", kind: "pct" },
      { key: "show_rate", label: "Attended ÷ capacity", kind: "pct" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select coalesce(u.display_name, 'Unassigned') as coach, st.name as service, count(*)::int as sessions, sum(s.capacity)::int as capacity,
              sum((select count(*) from bookings b where b.session_id = s.id and b.status in ('booked','attended','no_show')))::int as booked,
              sum((select count(*) from bookings b where b.session_id = s.id and b.status = 'attended'))::int as attended
            from schedule_sessions s join service_types st on st.id = s.service_type_id left join users u on u.id = s.coach_user_id
            where s.org_id = ${orgId} and s.starts_at >= ${start} and s.starts_at < ${end} and s.status <> 'cancelled'
            group by 1, 2 order by 1, 2`,
      );
      for (const x of rows) {
        x.fill_rate = n(x.capacity) ? n(x.booked) / n(x.capacity) : null;
        x.show_rate = n(x.capacity) ? n(x.attended) / n(x.capacity) : null;
      }
      return { rows };
    },
  },
  {
    key: "no-shows",
    title: "No-shows & late cancellations",
    category: "Attendance",
    definition: "Athletes with at least one no-show or late cancellation for sessions starting in the range.",
    cap: "reports.operational",
    columns: [
      { key: "athlete", label: "Athlete" },
      { key: "no_show", label: "No-shows", kind: "int" },
      { key: "late_cancel", label: "Late cancels", kind: "int" },
      { key: "last_at", label: "Most recent", kind: "datetime" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      return {
        rows: await q(
          tx,
          sql`select p.first_name || ' ' || p.last_name as athlete,
                count(*) filter (where b.status = 'no_show')::int as no_show,
                count(*) filter (where b.status = 'late_cancelled')::int as late_cancel,
                max(s.starts_at) as last_at
              from bookings b join schedule_sessions s on s.id = b.session_id join athletes a on a.id = b.athlete_id join people p on p.id = a.person_id
              where b.org_id = ${orgId} and b.status in ('no_show','late_cancelled') and s.starts_at >= ${start} and s.starts_at < ${end}
              group by 1 order by 2 desc, 3 desc`,
        ),
      };
    },
  },
  {
    key: "receivables",
    title: "Receivables & aging",
    category: "Money",
    definition:
      "Open invoices and their unpaid balance as of today (invoice total minus SETTLED payments). Pending payments (e.g. bank transfers still clearing) are shown separately and do not reduce the balance. Aging is days past the due date.",
    cap: "reports.financial",
    columns: [
      { key: "number", label: "Invoice" },
      { key: "payer", label: "Payer" },
      { key: "due_date", label: "Due", kind: "date" },
      { key: "days_past_due", label: "Days past due", kind: "int" },
      { key: "total_minor", label: "Total", kind: "money" },
      { key: "settled_minor", label: "Settled", kind: "money" },
      { key: "pending_minor", label: "Pending (not settled)", kind: "money" },
      { key: "balance_minor", label: "Balance", kind: "money" },
    ],
    run: async (tx, orgId) => {
      const rows = await q(
        tx,
        sql`select i.number, pa.name as payer, i.due_date, greatest(0, current_date - i.due_date)::int as days_past_due, i.total_minor,
              coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment')),0)::bigint as settled_minor,
              coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'pending'),0)::bigint as pending_minor
            from invoices i join payer_accounts pa on pa.id = i.payer_account_id
            where i.org_id = ${orgId} and i.status = 'open' order by i.due_date nulls last`,
      );
      for (const x of rows) x.balance_minor = n(x.total_minor) - n(x.settled_minor);
      const bucket = (lo: number, hi: number) => rows.filter((x) => n(x.days_past_due) >= lo && n(x.days_past_due) <= hi).reduce((s, x) => s + n(x.balance_minor), 0);
      return {
        rows,
        summary: [
          { label: "Total receivable", value: rows.reduce((s, x) => s + n(x.balance_minor), 0), kind: "money" },
          { label: "Current", value: bucket(0, 0), kind: "money" },
          { label: "1–30 days", value: bucket(1, 30), kind: "money" },
          { label: "31–60 days", value: bucket(31, 60), kind: "money" },
          { label: "61–90 days", value: bucket(61, 90), kind: "money" },
          { label: "90+ days", value: bucket(91, 100000), kind: "money" },
          { label: "Pending, not settled", value: rows.reduce((s, x) => s + n(x.pending_minor), 0), kind: "money" },
        ],
      };
    },
  },
  {
    key: "collections",
    title: "Collected revenue (settled)",
    category: "Money",
    definition:
      "Money actually settled in the range (by settlement time), by provider and verification. 'Provider verified' came from a verified processor webhook; 'staff attested' is cash/check/personal Venmo/Zelle recorded by staff. Pending money is listed separately and NOT counted as collected. Refunds and fees are shown as their own lines.",
    cap: "reports.financial",
    columns: [
      { key: "provider", label: "Provider" },
      { key: "kind", label: "Type" },
      { key: "verification", label: "Verification" },
      { key: "status", label: "Status" },
      { key: "count", label: "Count", kind: "int" },
      { key: "amount_minor", label: "Amount", kind: "money" },
      { key: "fee_minor", label: "Processor fees", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select provider, kind, verification, status, count(*)::int as count, sum(amount_minor)::bigint as amount_minor, sum(fee_minor)::bigint as fee_minor
            from transactions
            where org_id = ${orgId} and (
              (status = 'settled' and coalesce(settled_at, occurred_at) >= ${start} and coalesce(settled_at, occurred_at) < ${end})
              or (status = 'pending' and occurred_at < ${end}))
            group by 1,2,3,4 order by status desc, provider`,
      );
      const settled = rows.filter((x) => x.status === "settled" && ["charge", "manual_payment"].includes(String(x.kind)));
      const refunds = rows.filter((x) => x.status === "settled" && String(x.kind) === "refund");
      return {
        rows,
        summary: [
          { label: "Collected (settled payments)", value: settled.reduce((s, x) => s + n(x.amount_minor), 0), kind: "money" },
          { label: "…of which staff-attested", value: settled.filter((x) => x.verification === "staff_attested").reduce((s, x) => s + n(x.amount_minor), 0), kind: "money" },
          { label: "Refunds (settled)", value: refunds.reduce((s, x) => s + n(x.amount_minor), 0), kind: "money" },
          { label: "Processor fees", value: rows.filter((x) => x.status === "settled").reduce((s, x) => s + n(x.fee_minor), 0), kind: "money" },
          { label: "Pending — not collected", value: rows.filter((x) => x.status === "pending").reduce((s, x) => s + n(x.amount_minor), 0), kind: "money" },
        ],
      };
    },
  },
  {
    key: "invoiced",
    title: "Invoiced (billed)",
    category: "Money",
    definition: "Invoices issued in the range by status. Billed is not the same as collected — see Collected revenue for settled money.",
    cap: "reports.financial",
    columns: [
      { key: "status", label: "Status" },
      { key: "source", label: "Source" },
      { key: "count", label: "Invoices", kind: "int" },
      { key: "total_minor", label: "Billed", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select status, source, count(*)::int as count, sum(total_minor)::bigint as total_minor from invoices
            where org_id = ${orgId} and coalesce(issued_at, created_at) >= ${start} and coalesce(issued_at, created_at) < ${end} and status <> 'draft'
            group by 1,2 order by 1,2`,
      );
      return { rows, summary: [{ label: "Total billed (excl. void)", value: rows.filter((x) => x.status !== "void").reduce((s, x) => s + n(x.total_minor), 0), kind: "money" }] };
    },
  },
  {
    key: "refunds-disputes",
    title: "Refunds & disputes",
    category: "Money",
    definition: "Refund requests and processor disputes created in the range. Refunds blocked because a provider isn't configured are listed with that status.",
    cap: "reports.financial",
    columns: [
      { key: "type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "reason", label: "Reason" },
      { key: "amount_minor", label: "Amount", kind: "money" },
      { key: "created_at", label: "Created", kind: "datetime" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      return {
        rows: await q(
          tx,
          sql`select 'refund' as type, status, reason, amount_minor, created_at from refunds where org_id = ${orgId} and created_at >= ${start} and created_at < ${end}
              union all
              select 'dispute', status, reason, amount_minor, created_at from disputes where org_id = ${orgId} and created_at >= ${start} and created_at < ${end}
              order by created_at desc`,
        ),
      };
    },
  },
  {
    key: "payouts",
    title: "Payouts",
    category: "Money",
    definition: "Processor payouts to the bank account recorded from provider webhooks, by arrival date.",
    cap: "reports.financial",
    columns: [
      { key: "provider", label: "Provider" },
      { key: "provider_payout_id", label: "Payout id" },
      { key: "status", label: "Status" },
      { key: "arrival_date", label: "Arrival", kind: "date" },
      { key: "amount_minor", label: "Amount", kind: "money" },
    ],
    run: async (tx, orgId, r) => ({
      rows: await q(tx, sql`select provider, provider_payout_id, status, arrival_date, amount_minor from payouts where org_id = ${orgId} and (arrival_date is null or arrival_date between ${r.from} and ${r.to}) order by arrival_date desc nulls first`),
    }),
  },
  {
    key: "credits",
    title: "Package credits",
    category: "Memberships",
    definition: "Active session-credit balances per athlete: available, reserved for upcoming bookings, and credits expiring within 30 days of the end date. Balances come from the credit ledger.",
    cap: "reports.financial",
    columns: [
      { key: "athlete", label: "Athlete" },
      { key: "available", label: "Available", kind: "int" },
      { key: "reserved", label: "Reserved", kind: "int" },
      { key: "expiring_30d", label: "Expiring ≤30 days", kind: "int" },
      { key: "next_expiry", label: "Next expiry", kind: "datetime" },
    ],
    run: async (tx, orgId, r) => {
      const end = localDayBounds(r.to, r.tz).end.toISOString();
      return {
        rows: await q(
          tx,
          sql`select p.first_name || ' ' || p.last_name as athlete, sum(cb.available)::int as available, sum(cb.reserved)::int as reserved,
                sum(case when cb.expires_at is not null and cb.expires_at < (${end}::timestamptz + interval '30 days') then cb.available else 0 end)::int as expiring_30d,
                min(cb.expires_at) filter (where cb.available > 0) as next_expiry
              from credit_buckets cb join athletes a on a.id = cb.athlete_id join people p on p.id = a.person_id
              where cb.org_id = ${orgId} and cb.status = 'active'
              group by 1 having sum(cb.available) + sum(cb.reserved) > 0 order by 1`,
        ),
      };
    },
  },
  {
    key: "renewals",
    title: "Upcoming renewals & cancellations",
    category: "Memberships",
    definition: "Teamwork-billed memberships whose next bill date or scheduled cancellation falls in the range. Zen Planner-billed (imported) memberships never renew here.",
    cap: "reports.financial",
    columns: [
      { key: "athlete", label: "Athlete" },
      { key: "product", label: "Product" },
      { key: "status", label: "Status" },
      { key: "next_bill_date", label: "Next bill", kind: "date" },
      { key: "cancel_at", label: "Cancels", kind: "date" },
      { key: "price_minor", label: "Price", kind: "money" },
    ],
    run: async (tx, orgId, r) => ({
      rows: await q(
        tx,
        sql`select p.first_name || ' ' || p.last_name as athlete, pr.name as product, m.status, m.next_bill_date, m.cancel_at, pv.price_minor
            from memberships m join athletes a on a.id = m.athlete_id join people p on p.id = a.person_id
            join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
            where m.org_id = ${orgId} and m.billing_provider <> 'external_zenplanner'
              and ((m.next_bill_date between ${r.from} and ${r.to}) or (m.cancel_at between ${r.from} and ${r.to}))
            order by coalesce(m.next_bill_date, m.cancel_at)`,
      ),
    }),
  },
  {
    key: "retention",
    title: "Retention",
    category: "Retention",
    definition:
      "Of athletes who attended at least once in the 60 days before the start date, how many attended at least once during the range. Membership churn = memberships cancelled/expired in the range ÷ memberships active at the start date.",
    cap: "reports.operational",
    columns: [
      { key: "metric", label: "Metric" },
      { key: "value", label: "Value" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const [a] = await q(
        tx,
        sql`with base as (
              select distinct b.athlete_id from bookings b join schedule_sessions s on s.id = b.session_id
              where b.org_id = ${orgId} and b.status = 'attended' and s.starts_at >= (${start}::timestamptz - interval '60 days') and s.starts_at < ${start}),
            kept as (
              select distinct b.athlete_id from bookings b join schedule_sessions s on s.id = b.session_id
              where b.org_id = ${orgId} and b.status = 'attended' and s.starts_at >= ${start} and s.starts_at < ${end} and b.athlete_id in (select athlete_id from base))
            select (select count(*) from base)::int as base, (select count(*) from kept)::int as kept`,
      );
      const [m] = await q(
        tx,
        sql`select
              (select count(*) from memberships where org_id = ${orgId} and start_date < ${r.from} and (end_date is null or end_date >= ${r.from}) and status <> 'pending')::int as active_start,
              (select count(*) from membership_events me join memberships m on m.id = me.membership_id where m.org_id = ${orgId} and me.type in ('cancelled','expired','cancel') and me.created_at >= ${start} and me.created_at < ${end})::int as churned`,
      );
      const rate = n(a.base) ? n(a.kept) / n(a.base) : null;
      const churn = n(m.active_start) ? n(m.churned) / n(m.active_start) : null;
      return {
        rows: [
          { metric: "Athletes active in prior 60 days", value: n(a.base) },
          { metric: "…who attended during range", value: n(a.kept) },
          { metric: "Attendance retention", value: rate == null ? "not calculable (no base)" : `${Math.round(rate * 1000) / 10}%` },
          { metric: "Memberships active at start", value: n(m.active_start) },
          { metric: "Cancelled/expired in range", value: n(m.churned) },
          { metric: "Membership churn", value: churn == null ? "not calculable" : `${Math.round(churn * 1000) / 10}%` },
        ],
      };
    },
  },
  {
    key: "staff-activity",
    title: "Staff activity",
    category: "Staff",
    definition: "Audited actions per staff member in the range (from the append-only audit log), plus sessions they coached.",
    cap: "reports.operational",
    columns: [
      { key: "staff", label: "Staff" },
      { key: "role", label: "Role" },
      { key: "actions", label: "Audited actions", kind: "int" },
      { key: "check_ins", label: "Check-ins recorded", kind: "int" },
      { key: "sessions_coached", label: "Sessions coached", kind: "int" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      return {
        rows: await q(
          tx,
          sql`select u.display_name as staff, u.role,
                (select count(*) from audit_events ae where ae.actor_user_id = u.id and ae.created_at >= ${start} and ae.created_at < ${end})::int as actions,
                (select count(*) from audit_events ae where ae.actor_user_id = u.id and ae.action like '%check%in%' and ae.created_at >= ${start} and ae.created_at < ${end})::int as check_ins,
                (select count(*) from schedule_sessions s where s.coach_user_id = u.id and s.status <> 'cancelled' and s.starts_at >= ${start} and s.starts_at < ${end})::int as sessions_coached
              from users u where u.org_id = ${orgId} and u.role in ('owner','admin','operations','coach') order by u.display_name`,
        ),
      };
    },
  },
];

export function reportByKey(key: string) {
  return REPORTS.find((r) => r.key === key);
}

export function toCsv(columns: ReportColumn[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    // Neutralize spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = columns.map((c) => esc(c.kind === "money" ? `${c.label} (USD)` : c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => (c.kind === "money" && r[c.key] != null ? (Number(r[c.key]) / 100).toFixed(2) : esc(r[c.key]))).join(","));
  return [header, ...body].join("\n") + "\n";
}
