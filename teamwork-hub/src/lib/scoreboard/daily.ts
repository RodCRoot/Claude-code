import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { paymentExceptions } from "@/lib/billing/reconciliation";
import { weeklyCap } from "@/lib/member-ops/common";
import { EXCEPTION_LABELS, membershipAuditSweep, type AuditResult } from "@/lib/member-ops/membership-audit";
import { retentionRadar, type RadarResult } from "@/lib/retention/radar";
import { addDaysYmd, isoWeekday, startOfWeekYmd } from "@/lib/time";
import { AUTOPAY_READY_SQL, expiringCards } from "@/lib/billing/payment-methods";
import {
  activeOn,
  addMonths,
  bookingProgram,
  continuesEarlier,
  cutoff,
  dayEnd,
  dayStart,
  invoiceFilter,
  membershipCtes,
  monthEnd,
  monthStart,
  num,
  rowsOf,
  sessionLoc,
  settledBefore,
  trialOn,
  ymdOf,
  type Ctx,
  type Row,
} from "./core";

/**
 * Daily scoreboard. Every headline number is the count (or sum) of the rows returned by ONE
 * query, and the "list behind it" page runs that same query, so a number and its list cannot
 * disagree. `day` is the facility-local date a number is taken "as of".
 */

export type MetricRow = {
  ref_kind: "person" | "membership" | "invoice" | "lead" | "session" | "request" | "link" | null;
  ref_id: string | null;
  name: string;
  detail: string | null;
  amount_minor: number | null;
  day: string | null;
  athlete_id: string | null;
  grp: string | null;
};

export type MetricGroup = "Members" | "Leads and sales" | "Attendance" | "Money owed" | "Revenue" | "Holds and risk" | "Membership checks" | "Needs a decision";

type ChangeSpec =
  | "stock"
  | { none: string }
  | { label: (c: Ctx) => string; plus: (c: Ctx) => SQL; minus?: (c: Ctx) => SQL };

export type MetricDef = {
  key: string;
  label: string;
  group: MetricGroup;
  kind: "count" | "money";
  version: number;
  definition: string;
  /** How the location / program filter applies, in words. */
  filterNote: string;
  dims: { location: boolean; program: boolean };
  /** Headline counts distinct athletes instead of rows (the row count is shown beside it). */
  people?: boolean;
  /** What the summed amount of a COUNT metric means, e.g. "per month at plan price". Unset = the amount is not shown. */
  amountLabel?: string;
  /** Show a per-`grp` breakdown under the headline. */
  breakdown?: boolean;
  rows?: (c: Ctx, day: string) => SQL;
  list?: (c: Ctx, shared: Shared) => Promise<MetricRow[]>;
  change: ChangeSpec;
};

export type MetricValue = {
  key: string;
  label: string;
  group: MetricGroup;
  kind: "count" | "money";
  /** Null when the metric cannot be attributed under the active filter (see `na`). */
  value: number | null;
  rowCount: number | null;
  people: number | null;
  amountMinor: number | null;
  amountLabel: string | null;
  na: string | null;
  change: number | null;
  changeLabel: string;
  breakdown: { label: string; count: number; amountMinor: number | null }[];
};

const STD = sql`ref_kind, ref_id, name, detail, amount_minor, day, athlete_id, grp`;
const t = (c: Ctx) => sql`${c.tz}`;
const localDate = (c: Ctx, col: string) => sql`(${sql.raw(col)} at time zone ${c.tz})::date`;

// ---------------------------------------------------------------------------
// Row queries
// ---------------------------------------------------------------------------

const activeMemberRows = (c: Ctx, d: string) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name, ms.product as detail, ms.monthly_minor as amount_minor, ms.start_date as day, ms.athlete_id, ms.product as grp
  from ms where ${activeOn("ms", d)} and not ${trialOn("ms", d)}`;

const trialRows = (c: Ctx, d: string) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name, ms.product || ' (trial)' as detail, null::bigint as amount_minor, ms.start_date as day, ms.athlete_id, 'Trial membership' as grp
  from ms where ${activeOn("ms", d)} and ${trialOn("ms", d)}
    and not exists (select 1 from allmx o where o.athlete_id = ms.athlete_id and ${activeOn("o", d)} and not ${trialOn("o", d)})
  ${
    c.filtered
      ? sql``
      : sql`union all
  select 'person', a.person_id, p.first_name || ' ' || p.last_name, 'Trial pass: ' || tp.credits || ' sessions, expires ' || to_char(tp.expires_at at time zone ${t(c)}, 'Mon DD'), null::bigint, ${localDate(c, "tp.created_at")}, tp.athlete_id, 'Trial pass'
  from trial_passes tp join athletes a on a.id = tp.athlete_id join people p on p.id = a.person_id
  where tp.org_id = ${c.orgId} and tp.created_at < ${cutoff(c, d)} and tp.expires_at >= ${cutoff(c, d)}
    and not exists (select 1 from allmx o where o.athlete_id = tp.athlete_id and ${activeOn("o", d)})`
  }`;

const leadRows = (c: Ctx, where: SQL) => sql`
  select 'lead' as ref_kind, l.id as ref_id, p.first_name || ' ' || p.last_name as name,
    coalesce(ls.label, l.stage) || coalesce(' · ' || l.source, '') as detail, null::bigint as amount_minor, ${localDate(c, "l.created_at")} as day, null::uuid as athlete_id,
    coalesce(ls.label, l.stage) as grp, coalesce(ls.sort_order, 999) as sort_order
  from leads l join people p on p.id = l.person_id
  left join lead_stages ls on ls.org_id = l.org_id and ls.key = l.stage
  where l.org_id = ${c.orgId} and ${where}`;
const leadOpen = sql`l.converted_at is null and l.stage not in ('won','lost') and not coalesce(ls.is_won, false) and not coalesce(ls.is_lost, false)`;

const assessmentRows = (c: Ctx, d: string) => sql`
  select 'lead' as ref_kind, l.id as ref_id, p.first_name || ' ' || p.last_name as name,
    s.title || ' at ' || to_char(s.starts_at at time zone ${t(c)}, 'FMHH12:MI AM') as detail, null::bigint as amount_minor, ${localDate(c, "s.starts_at")} as day, null::uuid as athlete_id,
    case when exists (select 1 from bookings b join athletes a on a.id = b.athlete_id where b.session_id = s.id and a.person_id = l.person_id and b.status in ('booked','attended','no_show'))
         then 'Lead with a matching booking' else 'Lead with NO matching booking' end as grp
  from leads l join people p on p.id = l.person_id join schedule_sessions s on s.id = l.assessment_session_id
  where l.org_id = ${c.orgId} and s.status <> 'cancelled' and s.starts_at >= ${dayStart(c, d)} and s.starts_at < ${dayEnd(c, d)} ${sessionLoc(c)}
  union all
  select 'session', s.id, p.first_name || ' ' || p.last_name, s.title || ' at ' || to_char(s.starts_at at time zone ${t(c)}, 'FMHH12:MI AM'), null::bigint, ${localDate(c, "s.starts_at")}, b.athlete_id, 'Booked athlete (no lead record)'
  from bookings b join schedule_sessions s on s.id = b.session_id join service_types st on st.id = s.service_type_id
  join athletes a on a.id = b.athlete_id join people p on p.id = a.person_id
  where b.org_id = ${c.orgId} and st.kind = 'assessment' and s.status <> 'cancelled' and b.status in ('booked','attended','no_show')
    and s.starts_at >= ${dayStart(c, d)} and s.starts_at < ${dayEnd(c, d)} ${sessionLoc(c)}
    and not exists (select 1 from leads l where l.assessment_session_id = s.id and l.person_id = a.person_id)`;

/** New memberships sold with a start date in [from, to]: not a trial product, not a continuation. Shared with the monthly table. */
export const soldRows = (c: Ctx, from: string, to: string) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name, ms.product as detail, ms.monthly_minor as amount_minor, ms.start_date as day, ms.athlete_id, ms.product as grp
  from ms where ms.start_date >= ${from} and ms.start_date <= ${to} and not ms.trial_product and not ${continuesEarlier(c, "ms")}`;

const bookingRows = (c: Ctx, from: string, to: string, statuses: string[]) => sql`
  select 'session' as ref_kind, s.id as ref_id, p.first_name || ' ' || p.last_name as name,
    s.title || ' · ' || to_char(s.starts_at at time zone ${t(c)}, 'FMHH12:MI AM') as detail, null::bigint as amount_minor, ${localDate(c, "s.starts_at")} as day, b.athlete_id, s.title as grp
  from bookings b join schedule_sessions s on s.id = b.session_id join athletes a on a.id = b.athlete_id join people p on p.id = a.person_id
  where b.org_id = ${c.orgId} and s.status <> 'cancelled' and b.status in (${sql.join(statuses.map((x) => sql`${x}`), sql`, `)})
    and s.starts_at >= ${dayStart(c, from)} and s.starts_at < ${dayEnd(c, to)} ${sessionLoc(c)} ${bookingProgram(c)}`;

const BUCKETS = sql`case when d.days <= 30 then '1 to 30 days' when d.days <= 60 then '31 to 60 days' when d.days <= 90 then '61 to 90 days' else 'Over 90 days' end`;
export const AGING_ORDER = ["1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"];

/**
 * Unpaid balance of invoices past their due date as of day `d`: issued by then, not draft / void /
 * uncollectible, still open now or paid only after the cut-off, due before `d`, balance > 0.
 */
const pastDueRows = (c: Ctx, d: string) => {
  const at = cutoff(c, d);
  return sql`
  select 'invoice' as ref_kind, d.id as ref_id, d.payer as name, d.number || ' · due ' || to_char(d.due_date, 'Mon DD, YYYY') || ' · ' || d.days || ' days past due' as detail,
    d.balance as amount_minor, d.due_date as day, null::uuid as athlete_id, ${BUCKETS} as grp
  from (
    select i.id, i.number, pa.name as payer, i.due_date, (${d}::date - i.due_date)::int as days, (i.total_minor - ${settledBefore(at)})::bigint as balance
    from invoices i join payer_accounts pa on pa.id = i.payer_account_id
    where i.org_id = ${c.orgId} and i.status not in ('draft','void','uncollectible') and coalesce(i.issued_at, i.created_at) < ${at}
      and (i.status = 'open' or i.paid_at >= ${at}) and i.due_date < ${d} ${invoiceFilter(c)}) d
  where d.balance > 0`;
};

/**
 * Bills due from `d` through `d` + 14 days: unpaid balances of open invoices due in the window,
 * plus each membership's next scheduled bill in the window that has no invoice yet. The scheduled
 * part follows the family bill preview (`scheduledBills`): active or trialing, billed by Teamwork
 * or a connected provider, not ending or cancelling on or before the bill date, no hold over it.
 */
const billsDueRows = (c: Ctx, d: string) => {
  const to = addDaysYmd(d, 14);
  return sql`
  select 'invoice' as ref_kind, x.id as ref_id, x.payer as name, x.number || ' · due ' || to_char(x.due_date, 'Mon DD') as detail, x.balance as amount_minor, x.due_date as day, null::uuid as athlete_id, 'Open invoice' as grp
  from (
    select i.id, i.number, pa.name as payer, i.due_date, (i.total_minor - ${settledBefore(cutoff(c, d))})::bigint as balance
    from invoices i join payer_accounts pa on pa.id = i.payer_account_id
    where i.org_id = ${c.orgId} and i.status = 'open' and i.due_date >= ${d} and i.due_date <= ${to} ${invoiceFilter(c)}) x
  where x.balance > 0
  union all
  select 'membership', ms.id, ms.name, ms.product || ' · scheduled ' || to_char(ms.next_bill_date, 'Mon DD'), ms.period_minor, ms.next_bill_date, ms.athlete_id, 'Scheduled membership bill'
  from ms
  where ms.status in ('active','trialing') and ms.billing_provider in ('manual','stripe','paypal')
    and ms.next_bill_date >= ${d} and ms.next_bill_date <= ${to}
    and (ms.cancel_at is null or ms.cancel_at > ms.next_bill_date) and (ms.end_date is null or ms.end_date > ms.next_bill_date)
    and not exists (select 1 from membership_holds h where h.membership_id = ms.id and h.start_date <= ms.next_bill_date and h.end_date >= ms.next_bill_date)
    and not exists (select 1 from invoices i where i.membership_id = ms.id and i.period_start = ms.next_bill_date and i.status <> 'void')`;
};

const txnFilter = (c: Ctx) => (c.filtered ? sql`and t.invoice_id in (select i.id from invoices i where i.membership_id in (select id from ms))` : sql``);

const failedRows = (c: Ctx, from: string, to: string) => sql`
  select 'invoice' as ref_kind, pa.invoice_id as ref_id, py.name, i.number || ' · ' || pa.provider || coalesce(' · ' || pa.failure_message, '') as detail, pa.amount_minor, ${localDate(c, "pa.created_at")} as day, null::uuid as athlete_id, pa.provider as grp
  from payment_attempts pa join invoices i on i.id = pa.invoice_id join payer_accounts py on py.id = i.payer_account_id
  where pa.org_id = ${c.orgId} and pa.status = 'failed' and pa.created_at >= ${dayStart(c, from)} and pa.created_at < ${dayEnd(c, to)} ${invoiceFilter(c)}
  union all
  select 'invoice', t.invoice_id, py.name, coalesce(i.number, 'No invoice') || ' · ' || t.provider, t.amount_minor, ${localDate(c, "t.occurred_at")}, null::uuid, t.provider
  from transactions t left join invoices i on i.id = t.invoice_id left join payer_accounts py on py.id = t.payer_account_id
  where t.org_id = ${c.orgId} and t.status = 'failed' and t.kind = 'charge' and t.payment_attempt_id is null
    and t.occurred_at >= ${dayStart(c, from)} and t.occurred_at < ${dayEnd(c, to)} ${txnFilter(c)}`;

/** Settled money in, by settlement time. Same rule as the "Collected revenue (settled)" report. Shared with the monthly and money views. */
export const collectedRows = (c: Ctx, fromInstant: string, toInstant: string) => sql`
  select 'invoice' as ref_kind, t.invoice_id as ref_id, coalesce(py.name, 'No payer') as name, coalesce(i.number, 'No invoice') || ' · ' || t.provider || ' · ' || t.verification as detail,
    t.amount_minor, ${localDate(c, "coalesce(t.settled_at, t.occurred_at)")} as day, null::uuid as athlete_id, t.provider as grp
  from transactions t left join invoices i on i.id = t.invoice_id left join payer_accounts py on py.id = t.payer_account_id
  where t.org_id = ${c.orgId} and t.status = 'settled' and t.kind in ('charge','manual_payment')
    and coalesce(t.settled_at, t.occurred_at) >= ${fromInstant} and coalesce(t.settled_at, t.occurred_at) < ${toInstant} ${txnFilter(c)}`;

/** Invoices issued in the window, excluding drafts and voids. Same rule as the "Invoiced (billed)" report total. */
export const billedRows = (c: Ctx, fromInstant: string, toInstant: string) => sql`
  select 'invoice' as ref_kind, i.id as ref_id, pa.name, i.number || ' · ' || i.status || ' · ' || i.source as detail, i.total_minor as amount_minor, ${localDate(c, "coalesce(i.issued_at, i.created_at)")} as day, null::uuid as athlete_id, i.source as grp
  from invoices i join payer_accounts pa on pa.id = i.payer_account_id
  where i.org_id = ${c.orgId} and i.status not in ('draft','void') and coalesce(i.issued_at, i.created_at) >= ${fromInstant} and coalesce(i.issued_at, i.created_at) < ${toInstant} ${invoiceFilter(c)}`;

/**
 * Projected recurring revenue for the calendar month after `d`, net of holds. One row per
 * membership that is active on `d`, has a recurring price and is billed by Teamwork or a connected
 * provider. Amount = monthly-equivalent net price x (days of next month the membership is running
 * and not on hold) / (days in next month).
 */
export const projectedRows = (c: Ctx, d: string) => {
  const a = addMonths(monthStart(d), 1);
  const b = monthEnd(a);
  return sql`
  select 'membership' as ref_kind, x.id as ref_id, x.name,
    x.product || ' · ' || x.bill_days || ' of ' || x.month_days || ' days' || case when x.hold_days > 0 then ' (' || x.hold_days || ' on hold)' else '' end as detail,
    round(x.monthly_minor * x.bill_days::numeric / x.month_days)::bigint as amount_minor, x.start_date as day, x.athlete_id, x.product as grp
  from (
    select y.*, greatest(0, y.run_days - least(y.run_days, y.raw_hold_days))::int as bill_days, least(y.run_days, y.raw_hold_days)::int as hold_days
    from (
      select ms.*, (${b}::date - ${a}::date + 1)::int as month_days,
        greatest(0, least(${b}::date, coalesce(ms.ended_on, ms.cancel_at, ${b}::date + 1) - 1) - greatest(${a}::date, ms.start_date) + 1)::int as run_days,
        coalesce((select sum(greatest(0, least(h.end_date, ${b}::date) - greatest(h.start_date, ${a}::date) + 1)) from membership_holds h
                  where h.membership_id = ms.id and h.end_date >= ${a} and h.start_date <= ${b}), 0)::int as raw_hold_days
      from ms
      where ${activeOn("ms", d)} and not ms.trial_product and ms.monthly_minor is not null and ms.billing_provider in ('manual','stripe','paypal')
        and not (ms.status = 'on_hold' and not exists (select 1 from membership_holds h where h.membership_id = ms.id and h.start_date <= ${d} and h.end_date >= ${d}))) y) x
  where x.bill_days > 0`;
};

const holdRows = (c: Ctx, d: string, endingWithin: number | null) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name,
    ms.product || ' · ' || case when h.kind = 'in_season' then 'in-season pause' else 'hold' end || ' ' || to_char(h.start_date, 'Mon DD') || ' to ' || to_char(h.end_date, 'Mon DD, YYYY') as detail,
    ms.monthly_minor as amount_minor, h.end_date as day, ms.athlete_id, case when h.kind = 'in_season' then 'In-season pause' else 'Family hold' end as grp
  from membership_holds h join ms on ms.id = h.membership_id
  where h.start_date <= ${d} and h.end_date >= ${d} and ${activeOn("ms", d)} and h.created_at < ${cutoff(c, d)}
    ${endingWithin == null ? sql`` : sql`and h.end_date <= ${addDaysYmd(d, endingWithin)}`}`;

const cohortRows = (c: Ctx, d: string) => sql`
  select 'person' as ref_kind, x.person_id as ref_id, x.name, x.product || ' · last visit ' || coalesce(to_char(x.last_visit, 'Mon DD'), 'never') || ' (' || x.days || ' days ago)' as detail,
    x.monthly_minor as amount_minor, x.last_visit as day, x.athlete_id, null::text as grp
  from (
    select distinct on (ms.athlete_id) ms.athlete_id, ms.person_id, ms.name, ms.product, ms.monthly_minor, lv.last_visit,
      (${d}::date - coalesce(lv.last_visit, (select min(o.start_date) from allmx o where o.athlete_id = ms.athlete_id)))::int as days
    from ms
    left join lateral (
      select max(${localDate(c, "s.starts_at")}) as last_visit from bookings b join schedule_sessions s on s.id = b.session_id
      where b.athlete_id = ms.athlete_id and b.status = 'attended' and s.starts_at < ${cutoff(c, d)}) lv on true
    where ${activeOn("ms", d)} and not ${trialOn("ms", d)} and ms.status <> 'on_hold'
      and not exists (select 1 from membership_holds h join allmx o on o.id = h.membership_id where o.athlete_id = ms.athlete_id and h.start_date <= ${d} and h.end_date >= ${d})
    order by ms.athlete_id, ms.monthly_minor desc nulls last) x
  where x.days >= ${c.settings.thresholds.cohortMinDays} and x.days <= ${c.settings.thresholds.cohortMaxDays}`;

/**
 * "Autopay off": Teamwork-invoiced and NOT charged automatically, i.e. autopay is switched off or there is no
 * active saved payment method to charge. Same rule as autopayOffMembershipIds in billing/payment-methods.ts.
 * Autopay state has no history, so past days use today's state.
 */
const autopayOffRows = (c: Ctx, d: string) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name,
    ms.product || case when (select m.autopay from memberships m where m.id = ms.id) then ' · autopay is on but no active saved payment method' else ' · autopay is off: each bill is paid by the family or at the front desk' end as detail,
    ms.monthly_minor as amount_minor, ms.next_bill_date as day, ms.athlete_id, ms.product as grp
  from ms where ${activeOn("ms", d)} and not ${trialOn("ms", d)} and ms.billing_provider = 'manual'
    and not exists (select 1 from memberships m where m.id = ms.id and ${AUTOPAY_READY_SQL})`;

const expiringRows = (c: Ctx, d: string) => sql`
  select 'membership' as ref_kind, ms.id as ref_id, ms.name, ms.product || ' · ends ' || to_char(coalesce(ms.end_date, ms.cancel_at), 'Mon DD, YYYY') as detail, ms.monthly_minor as amount_minor, coalesce(ms.end_date, ms.cancel_at) as day, ms.athlete_id, ms.product as grp
  from ms where ${activeOn("ms", d)} and not ${trialOn("ms", d)} and coalesce(ms.end_date, ms.cancel_at) >= ${d} and coalesce(ms.end_date, ms.cancel_at) <= ${addDaysYmd(d, 30)}`;

const duplicateRows = (c: Ctx, d: string) => sql`
  select 'person' as ref_kind, x.person_id as ref_id, x.name, x.n || ' active memberships: ' || x.plans as detail, null::bigint as amount_minor, null::date as day, x.athlete_id, null::text as grp
  from (
    select o.athlete_id, o.person_id, o.name, count(*)::int as n, string_agg(o.product, '; ' order by o.start_date) as plans, bool_or(o.id in (select id from ms)) as in_filter
    from allmx o
    where ${activeOn("o", d)} and not ${trialOn("o", d)}
      and not exists (select 1 from membership_holds h where h.membership_id = o.id and h.kind = 'in_season' and h.start_date <= ${d} and h.end_date >= ${d})
    group by 1, 2, 3 having count(*) > 1) x
  where x.in_filter`;

const requestRows = (c: Ctx, d: string) => sql`
  select 'request' as ref_kind, r.id as ref_id, coalesce(rp.first_name || ' ' || rp.last_name, 'Unknown requester') as name,
    replace(r.type, '_', ' ') || ' request sent ' || to_char(r.sent_on, 'Mon DD') || coalesce(': ' || left(r.summary, 80), '') as detail, null::bigint as amount_minor, r.sent_on as day, null::uuid as athlete_id, 'Open member request' as grp
  from member_requests r left join people rp on rp.id = r.requester_person_id
  where r.org_id = ${c.orgId} and not r.suggested and r.created_at < ${cutoff(c, d)}
    and (r.status in ('new','in_progress') or (r.resolved_at is not null and r.resolved_at >= ${cutoff(c, d)}))
    ${c.filtered ? sql`and exists (select 1 from member_request_athletes ra join ms on ms.athlete_id = ra.athlete_id where ra.request_id = r.id and ${activeOn("ms", d)})` : sql``}`;

// ---------------------------------------------------------------------------
// Rule-based lists that reuse other modules (computed in code, not SQL)
// ---------------------------------------------------------------------------

export type Shared = { tx: Tx; v: Viewer; athleteIds: () => Promise<string[] | undefined>; radar: () => Promise<RadarResult>; audit: () => Promise<AuditResult> };

function shared(tx: Tx, v: Viewer, c: Ctx): Shared {
  let ids: Promise<string[] | undefined> | null = null;
  let radar: Promise<RadarResult> | null = null;
  let sweep: Promise<AuditResult> | null = null;
  const athleteIds = () =>
    (ids ??= c.filtered
      ? rowsOf<{ athlete_id: string }>(tx, sql`with ${membershipCtes(c)} select distinct athlete_id from ms where ${activeOn("ms", c.today)}`).then((r) => r.map((x) => x.athlete_id))
      : Promise.resolve(undefined));
  return {
    tx,
    v,
    athleteIds,
    radar: () => (radar ??= athleteIds().then((a) => retentionRadar(tx, v, { today: c.today, athleteIds: a }))),
    audit: () => (sweep ??= athleteIds().then((a) => (a && !a.length ? emptyAudit(c) : membershipAuditSweep(tx, c.orgId, { today: c.today, athleteIds: a })))),
  };
}
const emptyAudit = (c: Ctx) => ({ asOf: c.today, exceptions: [], skipped: [], screened: { memberships: 0, live: 0, billed: 0, athletes: 0, requests: 0, payers: 0 } }) as unknown as AuditResult;

async function atRiskList(_c: Ctx, s: Shared): Promise<MetricRow[]> {
  const r = await s.radar();
  return r.rows
    .filter((x) => x.level === "at_risk")
    .map((x) => ({ ref_kind: "person", ref_id: x.personId, name: x.name, detail: `${x.plan} · ${x.signals.map((g) => g.label).join(", ")}`, amount_minor: x.valueAtRiskMinor, day: null, athlete_id: x.athleteId, grp: null }));
}

/** Window of the "Saved cards expiring" tile, in days. The follow-ups card uses the same number. */
export const CARDS_EXPIRING_DAYS = 60;

/** `expiringCards()` as scoreboard rows: one row per saved card, linking to the payer's payment methods. */
async function cardsExpiringList(c: Ctx, s: Shared): Promise<MetricRow[]> {
  const cards = await expiringCards(s.tx, c.orgId, { today: c.today, withinDays: CARDS_EXPIRING_DAYS });
  return cards.map((x) => ({
    ref_kind: "link",
    ref_id: `/billing/payment-methods?payer=${x.payerAccountId}`,
    name: x.payerName,
    detail: `${x.label} · ${x.autopayMemberships ? `autopay for ${x.autopayMemberships} membership${x.autopayMemberships === 1 ? "" : "s"}` : "not used for autopay"}${x.isDefault ? " · default method" : ""}`,
    amount_minor: null,
    day: x.expiresOn,
    athlete_id: null,
    grp: null,
  }));
}

/** Conflict types from the membership audit shown under "Needs a decision" (the rest have their own tile). */
const DECISION_TYPES = ["unsigned_docs_billed", "hold_no_end", "in_season_no_end", "hold_over_cap", "in_season_over_cap", "request_billed_anyway", "family_discount_missing", "commitment_renewed", "commitment_locked", "dormant_billed", "failing_card"];
const UNRECONCILED = ["amount_mismatch", "pending_too_long", "webhook_problem", "refund_blocked", "dispute_open", "invoice_mismatch"];

async function overLimitList(_c: Ctx, s: Shared): Promise<MetricRow[]> {
  const a = await s.audit();
  return a.exceptions
    .filter((e) => e.type === "over_cap_usage")
    .map((e) => ({ ref_kind: e.personId ? "person" : null, ref_id: e.personId, name: e.athleteNames, detail: e.detail, amount_minor: e.impactMinor, day: null, athlete_id: e.athleteIds[0] ?? null, grp: null }));
}

async function underHalfList(c: Ctx, s: Shared): Promise<MetricRow[]> {
  const weeks = c.settings.thresholds.underuseWeeks;
  const to = addDaysYmd(startOfWeekYmd(c.today), -1); // last full week's Sunday
  const from = addDaysYmd(to, -(weeks * 7 - 1));
  const rows = await rowsOf<Row>(
    s.tx,
    sql`with ${membershipCtes(c)}
        select ms.id, ms.athlete_id, ms.person_id, ms.name, ms.product, ms.monthly_minor, ms.classes_per_week, ms.unlimited, ms.interval, ms.interval_count, ms.credits_per_period,
          (select count(*)::int from bookings b join schedule_sessions s on s.id = b.session_id
            where b.athlete_id = ms.athlete_id and b.status = 'attended' and s.starts_at >= ${dayStart(c, from)} and s.starts_at < ${dayEnd(c, to)}) as visits
        from ms
        where ${activeOn("ms", c.today)} and not ${trialOn("ms", c.today)} and ms.start_date <= ${from} and ms.status <> 'on_hold'
          and not exists (select 1 from membership_holds h where h.membership_id = ms.id and h.end_date >= ${from} and h.start_date <= ${c.today})
        order by ms.name`,
  );
  const out: MetricRow[] = [];
  for (const r of rows) {
    const cap = r.classes_per_week != null ? Number(r.classes_per_week) : weeklyCap({ productName: String(r.product), creditsPerPeriod: r.credits_per_period == null ? null : Number(r.credits_per_period), unlimited: !!r.unlimited, interval: r.interval as "month", intervalCount: Number(r.interval_count) });
    if (!cap) continue;
    const paidFor = cap * weeks;
    const visits = num(r.visits);
    if (visits * 2 >= paidFor) continue;
    out.push({ ref_kind: "person", ref_id: String(r.person_id), name: String(r.name), detail: `${r.product}: ${visits} of ${paidFor} visits in the last ${weeks} full weeks (${cap}/week plan)`, amount_minor: r.monthly_minor == null ? null : Number(r.monthly_minor), day: null, athlete_id: String(r.athlete_id), grp: null });
  }
  return out;
}

async function decisionList(c: Ctx, s: Shared): Promise<MetricRow[]> {
  const out = (await rowsOf<MetricRow>(s.tx, sql`with ${membershipCtes(c)}, r as (${requestRows(c, c.today)}) select ${STD} from r order by day`)).map((r) => ({ ...r, day: ymdOf(r.day) }));
  const a = await s.audit();
  for (const e of a.exceptions) {
    if (!DECISION_TYPES.includes(e.type)) continue;
    out.push({ ref_kind: e.personId ? "person" : null, ref_id: e.personId, name: e.athleteNames, detail: `${e.detail} ${e.recommendation}`, amount_minor: e.impactMinor, day: null, athlete_id: e.athleteIds[0] ?? null, grp: `Conflict: ${EXCEPTION_LABELS[e.type]}` });
  }
  if (!c.filtered) {
    for (const p of await paymentExceptions(s.tx, c.orgId, { today: c.today })) {
      if (!UNRECONCILED.includes(p.kind)) continue;
      out.push({ ref_kind: "link", ref_id: p.href, name: p.title, detail: p.detail, amount_minor: null, day: null, athlete_id: null, grp: "Unreconciled payment item" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const BOTH = { location: true, program: true };
const MEMBERSHIP_FILTER = "Program = the membership's plan. Location = the membership's location scope covers it (a membership valid at every location counts at each).";
const SESSION_FILTER = "Location = the session's location. Program = only athletes holding that plan on the session's day.";
const INVOICE_FILTER = "With a filter on, only invoices tied to a membership in the filtered set are counted (shop, drop-in and camp invoices have no membership and drop out).";
const LEAD_FILTER = "Leads store neither a location nor a program, so this number is withheld while a filter is on.";
const yday = (c: Ctx) => addDaysYmd(c.today, -1);
const WEEKDAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const iso = (d: Date) => d.toISOString();
const hoursAgo = (c: Ctx, h: number) => iso(new Date(c.now.getTime() - h * 3_600_000));

export const DAILY_METRICS: MetricDef[] = [
  {
    key: "active_members",
    amountLabel: "per month at plan price",
    label: "Active members",
    group: "Members",
    kind: "count",
    version: 1,
    people: true,
    definition:
      "People = distinct athletes with at least one active, non-trial membership today; memberships = those membership rows. A membership is active on a day when it has started, is not pending, and has not ended (it ends on its end date, else its cancel date, else the day it was marked cancelled or expired: the Retention saves report's rule). Members on hold or past due are still members. Differences from other screens: the Active memberships report still counts a membership ON its end date and goes by status; the retention radar also counts trial members. This page counts trials separately.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: activeMemberRows,
    change: "stock",
  },
  {
    key: "active_trials",
    label: "Active trial clients",
    group: "Members",
    kind: "count",
    version: 1,
    people: true,
    definition:
      "Athletes whose only active membership today is a trial (a trial product, or a plan still inside its trial days), plus athletes with an unexpired trial pass and no active membership. Trial passes carry no plan or location, so they are left out while a filter is on.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    breakdown: true,
    rows: trialRows,
    change: "stock",
  },
  {
    key: "new_leads_24h",
    label: "New leads, last 24 hours",
    group: "Leads and sales",
    kind: "count",
    version: 1,
    definition: "Lead records created in the 24 hours before the page was loaded, whatever their stage now.",
    filterNote: LEAD_FILTER,
    dims: { location: false, program: false },
    rows: (c) => sql`select ${STD} from (${leadRows(c, sql`l.created_at >= ${hoursAgo(c, 24)} and l.created_at < ${iso(c.now)}`)}) q`,
    change: { label: () => "vs the 24 hours before", plus: (c) => leadRows(c, sql`l.created_at >= ${hoursAgo(c, 24)} and l.created_at < ${iso(c.now)}`), minus: (c) => leadRows(c, sql`l.created_at >= ${hoursAgo(c, 48)} and l.created_at < ${hoursAgo(c, 24)}`) },
  },
  {
    key: "open_pipeline",
    label: "Open pipeline",
    group: "Leads and sales",
    kind: "count",
    version: 1,
    breakdown: true,
    definition: "Leads that are not converted and not in a won or lost stage, by their current stage. Same rule as the Leads page's open view.",
    filterNote: LEAD_FILTER,
    dims: { location: false, program: false },
    rows: (c) => sql`select ${STD} from (${leadRows(c, leadOpen)}) q`,
    change: { none: "Stage history is not stored, so yesterday's pipeline cannot be rebuilt." },
  },
  {
    key: "leads_no_followup",
    label: "Leads with no follow-up logged",
    group: "Leads and sales",
    kind: "count",
    version: 1,
    definition:
      "Open leads (see Open pipeline) with no contact logged through \"Mark contacted\" on the lead. A task or note on the lead does not count as a follow-up. The staff dashboard's \"uncontacted\" tile is narrower: only leads still in the New stage for over 48 hours.",
    filterNote: LEAD_FILTER,
    dims: { location: false, program: false },
    rows: (c) => sql`select ${STD} from (${leadRows(c, sql`${leadOpen} and l.last_contacted_at is null`)}) q`,
    change: { none: "Stage history is not stored, so yesterday's count cannot be rebuilt." },
  },
  {
    key: "assessments_today",
    label: "Assessments and consults today",
    group: "Leads and sales",
    kind: "count",
    version: 1,
    breakdown: true,
    definition:
      "Everyone scheduled into today's sessions: each lead linked to a session today (and whether a booking for the same person exists on that session), plus each athlete booked into an assessment-type session today with no lead record. A lead with no matching booking will not appear on the coach's roster.",
    filterNote: "Location = the session's location. Assessments are not tied to a plan, so this is withheld while a program filter is on.",
    dims: { location: true, program: false },
    rows: assessmentRows,
    change: { none: "A schedule for one day; there is no day-over-day change." },
  },
  {
    key: "sold_mtd",
    amountLabel: "per month at plan price",
    label: "Memberships sold, month to date",
    group: "Leads and sales",
    kind: "count",
    version: 1,
    definition:
      "Memberships whose start date is in this month up to today, excluding trial products and excluding plan changes / rebuilds (the athlete had another membership still running within the rebuild window before this one started). Counted on the start date, not the day it was keyed in. The Retention report counts every new membership row, including rebuilds.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: (c, d) => soldRows(c, monthStart(d), d),
    change: { label: () => "started yesterday", plus: (c) => soldRows(c, yday(c), yday(c)) },
  },
  {
    key: "attendance_yesterday",
    label: "Attendance yesterday",
    group: "Attendance",
    kind: "count",
    version: 1,
    definition: "Bookings marked attended (checked in) for non-cancelled sessions that started yesterday, facility time. Same rule as the Attendance report's attended column.",
    filterNote: SESSION_FILTER,
    dims: BOTH,
    rows: (c) => bookingRows(c, yday(c), yday(c), ["attended"]),
    change: { label: (c) => `vs last ${WEEKDAY[isoWeekday(yday(c))]}`, plus: (c) => bookingRows(c, yday(c), yday(c), ["attended"]), minus: (c) => bookingRows(c, addDaysYmd(c.today, -8), addDaysYmd(c.today, -8), ["attended"]) },
  },
  {
    key: "no_shows_yesterday",
    label: "No-shows yesterday",
    group: "Attendance",
    kind: "count",
    version: 1,
    definition: "Bookings marked no-show for non-cancelled sessions that started yesterday. Late cancellations are not included (the No-shows report lists both).",
    filterNote: SESSION_FILTER,
    dims: BOTH,
    rows: (c) => bookingRows(c, yday(c), yday(c), ["no_show"]),
    change: { label: (c) => `vs last ${WEEKDAY[isoWeekday(yday(c))]}`, plus: (c) => bookingRows(c, yday(c), yday(c), ["no_show"]), minus: (c) => bookingRows(c, addDaysYmd(c.today, -8), addDaysYmd(c.today, -8), ["no_show"]) },
  },
  {
    key: "bookings_today",
    label: "Bookings today",
    group: "Attendance",
    kind: "count",
    version: 1,
    definition: "Booked, attended and no-show bookings on today's non-cancelled sessions (waitlisted and cancelled bookings are not counted). The class table shows the same bookings per class against capacity; \"fill\" matches the Utilization report's fill rate.",
    filterNote: SESSION_FILTER,
    dims: BOTH,
    rows: (c) => bookingRows(c, c.today, c.today, ["booked", "attended", "no_show"]),
    change: { label: (c) => `vs last ${WEEKDAY[isoWeekday(c.today)]}`, plus: (c) => bookingRows(c, c.today, c.today, ["booked", "attended", "no_show"]), minus: (c) => bookingRows(c, addDaysYmd(c.today, -7), addDaysYmd(c.today, -7), ["booked", "attended", "no_show"]) },
  },
  {
    key: "past_due",
    label: "Past due",
    group: "Money owed",
    kind: "money",
    version: 1,
    breakdown: true,
    definition:
      "Unpaid balance (invoice total minus settled payments) of open invoices whose due date is before today. Aging = days past the due date, in four buckets that add up to the total because every past-due invoice falls in exactly one. The Receivables report lists ALL open invoices, including ones not due yet, so its total is larger. Pending payments do not reduce a balance.",
    filterNote: INVOICE_FILTER,
    dims: BOTH,
    rows: pastDueRows,
    change: "stock",
  },
  {
    key: "bills_due_14",
    label: "Bills due in the next 14 days",
    group: "Money owed",
    kind: "money",
    version: 1,
    breakdown: true,
    definition:
      "Unpaid balances of open invoices due from today through 14 days from now, plus each membership's next scheduled bill in that window that has no invoice yet (same rules as the family bill preview: active or trialing, billed by Teamwork or a connected provider, not ending first, no hold over the bill date). Scheduled bills are the plan price after its discount.",
    filterNote: MEMBERSHIP_FILTER + " " + INVOICE_FILTER,
    dims: BOTH,
    rows: billsDueRows,
    change: { none: "Forward-looking; there is no day-over-day change." },
  },
  {
    key: "failed_payments_mtd",
    amountLabel: "attempted",
    label: "Failed payments, month to date",
    group: "Money owed",
    kind: "count",
    version: 1,
    definition: "Payment attempts that failed this month, plus failed charges recorded without an attempt. One row per failed attempt, so a card that failed twice counts twice. The dollar figure is the sum of the attempted amounts, not money lost.",
    filterNote: INVOICE_FILTER,
    dims: BOTH,
    rows: (c, d) => failedRows(c, monthStart(d), d),
    change: { label: () => "failed yesterday", plus: (c) => failedRows(c, yday(c), yday(c)) },
  },
  {
    key: "holds_active",
    amountLabel: "per month at plan price, paused",
    label: "Holds active",
    group: "Holds and risk",
    kind: "count",
    version: 1,
    breakdown: true,
    definition: "Hold records covering today on memberships that are active today: family holds and in-season pauses, shown separately. A membership marked on hold at a payment provider with no hold record here is not listed.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: (c, d) => holdRows(c, d, null),
    change: "stock",
  },
  {
    key: "holds_ending_7",
    label: "Holds ending within 7 days",
    group: "Holds and risk",
    kind: "count",
    version: 1,
    definition: "Active holds (see Holds active) whose end date is today through 7 days from now.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: (c, d) => holdRows(c, d, 7),
    change: "stock",
  },
  {
    key: "at_risk",
    amountLabel: "estimated monthly value at risk",
    label: "At-risk members",
    group: "Holds and risk",
    kind: "count",
    version: 1,
    definition:
      "Members the retention radar marks At risk right now. This is the radar's own result (one high-weight signal, or enough watch signals; thresholds in Settings, Retention), not a second definition. The dollar figure is the radar's estimated monthly value at risk.",
    filterNote: "The radar is run for athletes with an active membership in the filtered set.",
    dims: BOTH,
    list: atRiskList,
    change: { none: "The radar is computed live and stores no history." },
  },
  {
    key: "slipping_cohort",
    amountLabel: "per month at plan price",
    label: "Slipping: last visit 10 to 25 days ago",
    group: "Holds and risk",
    kind: "count",
    version: 1,
    definition:
      "Active, non-trial members who are not on hold and whose last attended session was between the cohort's day limits ago (10 to 25 by default; never-attended members count from their first membership start). This is the group worth a call before they go quiet. It is a cohort by days since last visit, not a risk level: the radar's No recent visit signal starts at the membership policy's attendance gap.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: cohortRows,
    change: "stock",
  },
  {
    key: "collected_mtd",
    label: "Collected, month to date",
    group: "Revenue",
    kind: "money",
    version: 1,
    definition: "Settled charges and manual payments with a settlement time in this month, facility time. Gross: refunds and processor fees are not subtracted. Pending money is not counted. Same rule as the Collected revenue report.",
    filterNote: INVOICE_FILTER,
    dims: BOTH,
    rows: (c, d) => collectedRows(c, dayStart(c, monthStart(d)), cutoff(c, d)),
    change: { label: () => "collected yesterday", plus: (c) => collectedRows(c, dayStart(c, yday(c)), dayEnd(c, yday(c))) },
  },
  {
    key: "collected_last_month",
    label: "Collected last month (final)",
    group: "Revenue",
    kind: "money",
    version: 1,
    definition: "Collected (same rule as month to date) for the whole previous calendar month.",
    filterNote: INVOICE_FILTER,
    dims: BOTH,
    rows: (c, d) => collectedRows(c, dayStart(c, addMonths(monthStart(d), -1)), dayStart(c, monthStart(d))),
    change: { none: "A closed month does not change." },
  },
  {
    key: "billed_mtd",
    label: "Billed this month",
    group: "Revenue",
    kind: "money",
    version: 1,
    definition: "Total of invoices issued this month, excluding drafts and voided invoices. Billed is not collected. Same rule as the Invoiced report's total.",
    filterNote: INVOICE_FILTER,
    dims: BOTH,
    rows: (c, d) => billedRows(c, dayStart(c, monthStart(d)), cutoff(c, d)),
    change: { label: () => "billed yesterday", plus: (c) => billedRows(c, dayStart(c, yday(c)), dayEnd(c, yday(c))) },
  },
  {
    key: "projected_next_month",
    label: "Projected recurring revenue, next month",
    group: "Revenue",
    kind: "money",
    version: 1,
    definition:
      "For every membership active today that is billed by Teamwork or a connected provider: its monthly-equivalent price after discount, multiplied by the share of next month's days it is running and not on hold. A membership on hold all of next month adds nothing; one that ends or is scheduled to cancel mid-month adds only its days. Memberships billed by Zen Planner and trial products are excluded, like the Active memberships report's scheduled revenue. It is a projection of billing, not a forecast of collections, and assumes no new sales or cancellations.",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: projectedRows,
    change: "stock",
  },
  {
    key: "cards_expiring",
    label: "Saved cards expiring within 60 days",
    group: "Membership checks",
    kind: "count",
    version: 1,
    definition:
      "Active saved cards whose expiry month ends on or before 60 days from today, soonest first. A card is good through the last day of its expiry month, so a card expiring this month is listed until that day and one that has already lapsed stays listed until it is replaced or removed. One row per card, with whether autopay for a membership depends on it. Bank accounts do not expire and are not listed. Cards kept only in Zen Planner or on a Stripe or PayPal subscription are not visible to the Hub. The date shown is the last day the card works.",
    filterNote: "A card belongs to a payer account, not to a location or a program, so this number is withheld while a filter is on.",
    dims: { location: false, program: false },
    list: cardsExpiringList,
    change: { none: "Card expiry is read live; no history is stored." },
  },
  {
    key: "autopay_off",
    amountLabel: "per month at plan price",
    label: "Memberships with autopay off",
    group: "Membership checks",
    kind: "count",
    version: 2,
    definition:
      "Active, non-trial memberships invoiced by Teamwork where nothing will be charged automatically: autopay is switched off for the membership, or it is on but the payer has no active saved card or bank account to charge. Memberships on a Stripe or PayPal subscription charge themselves and are not listed. Memberships billed by Zen Planner or set to no billing are not listed: the Hub cannot see whether a card is on file there. (Version 1 listed every Teamwork-invoiced membership, because saved payment methods did not exist yet.)",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: autopayOffRows,
    change: { none: "Autopay history is not stored." },
  },
  {
    key: "expiring_30",
    amountLabel: "per month at plan price",
    label: "Memberships expiring in 30 days",
    group: "Membership checks",
    kind: "count",
    version: 1,
    definition: "Active, non-trial memberships with an end date or a scheduled cancellation date from today through 30 days from now. Commitment end dates are not expirations (the membership continues month to month).",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    rows: expiringRows,
    change: "stock",
  },
  {
    key: "duplicates",
    label: "People with more than one active membership",
    group: "Membership checks",
    kind: "count",
    version: 1,
    definition: "Athletes holding two or more active, non-trial memberships today (possible duplicates). A regular plan paused for an in-season plan is not counted as a second membership.",
    filterNote: "Shown when at least one of the athlete's memberships is in the filtered set; the count of memberships is across all plans.",
    dims: BOTH,
    rows: duplicateRows,
    change: "stock",
  },
  {
    key: "over_limit",
    label: "Attending above the plan's weekly limit",
    group: "Membership checks",
    kind: "count",
    version: 1,
    definition: "The membership audit's \"Using more than the plan allows\" exceptions: the athlete averaged more visits per week than the plan allows over the last 8 weeks and was above the limit in at least 5 of them. Unlimited plans have no limit.",
    filterNote: "The audit is run for athletes with an active membership in the filtered set.",
    dims: BOTH,
    list: overLimitList,
    change: { none: "The audit is computed live and stores no history." },
  },
  {
    key: "under_half",
    label: "Attending under half of the plan",
    group: "Membership checks",
    kind: "count",
    version: 1,
    definition:
      "Active, non-trial memberships with a weekly visit allowance that were active and not on hold for all of the last full weeks looked at (4 by default), where attended visits are fewer than half of allowance x weeks. Unlimited plans and plans with no weekly allowance are skipped. The membership audit's \"Billed while not attending\" is stricter (no visits at all for the dormant period).",
    filterNote: MEMBERSHIP_FILTER,
    dims: BOTH,
    list: underHalfList,
    change: { none: "Recomputed from the last full weeks; no day-over-day change." },
  },
  {
    key: "decisions",
    label: "Needs a decision",
    group: "Needs a decision",
    kind: "count",
    version: 1,
    breakdown: true,
    definition:
      "Three kinds of open item: confirmed member requests that are new or in progress (unconfirmed keyword suggestions are not counted); unreconciled payment items from Billing, Reconciliation (amount mismatches, payments pending too long, webhook problems, blocked refunds, open disputes, invoices that disagree with the ledger); and conflicts the membership audit detects (for example billed while unsigned documents block booking, a hold with no end date, a missing family discount).",
    filterNote: "Requests and conflicts follow the athlete's membership. Unreconciled payment items are not tied to a plan or location and are left out while a filter is on.",
    dims: BOTH,
    list: decisionList,
    change: { none: "A work list; open it to see what is waiting." },
  },
];

export const dailyMetric = (key: string) => DAILY_METRICS.find((m) => m.key === key);

function notApplicable(def: MetricDef, c: Ctx): string | null {
  if (c.filter.locationId && !def.dims.location) return "Not available with a location filter";
  if (c.filter.productId && !def.dims.program) return "Not available with a program filter";
  return null;
}

async function agg(tx: Tx, c: Ctx, rows: SQL) {
  const [r] = await rowsOf<Row>(tx, sql`with ${membershipCtes(c)}, r as (${rows}) select count(*)::int as n, count(distinct athlete_id)::int as people, sum(amount_minor)::bigint as amount from r`);
  return { n: num(r.n), people: num(r.people), amount: r.amount == null ? null : Number(r.amount) };
}

const headline = (def: MetricDef, a: { n: number; people: number; amount: number | null }) => (def.kind === "money" ? (a.amount ?? 0) : def.people ? a.people : a.n);

/** The rows behind one metric (the "list behind it"). */
export async function metricRows(tx: Tx, v: Viewer, c: Ctx, key: string, limit = 1000): Promise<{ def: MetricDef; rows: MetricRow[]; na: string | null } | null> {
  const def = dailyMetric(key);
  if (!def) return null;
  const na = notApplicable(def, c);
  if (na) return { def, rows: [], na };
  if (def.list) return { def, rows: (await def.list(c, shared(tx, v, c))).slice(0, limit), na: null };
  const rows = await rowsOf<MetricRow>(tx, sql`with ${membershipCtes(c)}, r as (${def.rows!(c, c.today)}) select ${STD} from r order by grp nulls last, day nulls last, name limit ${limit}`);
  return { def, rows: rows.map((r) => ({ ...r, amount_minor: r.amount_minor == null ? null : Number(r.amount_minor), day: ymdOf(r.day) })), na: null };
}

export async function metricValue(tx: Tx, c: Ctx, def: MetricDef, sh: Shared): Promise<MetricValue> {
  const base = { key: def.key, label: def.label, group: def.group, kind: def.kind, amountLabel: def.amountLabel ?? null };
  const na = notApplicable(def, c);
  if (na) return { ...base, value: null, rowCount: null, people: null, amountMinor: null, na, change: null, changeLabel: "", breakdown: [] };
  let a: { n: number; people: number; amount: number | null };
  let breakdown: MetricValue["breakdown"] = [];
  if (def.list) {
    const rows = await def.list(c, sh);
    const amounts = rows.filter((r) => r.amount_minor != null);
    a = { n: rows.length, people: new Set(rows.map((r) => r.athlete_id).filter(Boolean)).size, amount: amounts.length ? amounts.reduce((s, r) => s + (r.amount_minor ?? 0), 0) : null };
    if (def.breakdown) {
      const by = new Map<string, { count: number; amount: number | null }>();
      for (const r of rows) {
        const g = by.get(r.grp ?? "Other") ?? { count: 0, amount: null };
        g.count++;
        if (r.amount_minor != null) g.amount = (g.amount ?? 0) + r.amount_minor;
        by.set(r.grp ?? "Other", g);
      }
      breakdown = [...by].map(([label, g]) => ({ label, count: g.count, amountMinor: g.amount }));
    }
  } else {
    const rows = def.rows!(c, c.today);
    a = await agg(tx, c, rows);
    if (def.breakdown) {
      const g = await rowsOf<Row>(tx, sql`with ${membershipCtes(c)}, r as (${rows}) select coalesce(grp, 'Other') as grp, count(*)::int as n, sum(amount_minor)::bigint as amount from r group by 1 order by 1`);
      breakdown = g.map((x) => ({ label: String(x.grp), count: num(x.n), amountMinor: x.amount == null ? null : Number(x.amount) }));
      if (def.key === "past_due") breakdown = AGING_ORDER.map((label) => breakdown.find((b) => b.label === label) ?? { label, count: 0, amountMinor: 0 });
    }
  }
  let change: number | null = null;
  let changeLabel = "";
  if (def.change === "stock") {
    const y = addDaysYmd(c.today, -1);
    const [end, start] = [await agg(tx, c, def.rows!(c, y)), await agg(tx, c, def.rows!(c, addDaysYmd(y, -1)))];
    change = headline(def, end) - headline(def, start);
    changeLabel = "during yesterday";
  } else if ("none" in def.change) {
    changeLabel = def.change.none;
  } else {
    const plus = headline({ ...def, people: false }, await agg(tx, c, def.change.plus(c)));
    const minus = def.change.minus ? headline({ ...def, people: false }, await agg(tx, c, def.change.minus(c))) : 0;
    change = plus - minus;
    changeLabel = def.change.label(c);
  }
  return { ...base, value: headline(def, a), rowCount: a.n, people: a.people, amountMinor: a.amount, na: null, change, changeLabel, breakdown };
}

export type ClassToday = { id: string; title: string; startsAt: Date; location: string | null; coach: string | null; capacity: number; booked: number; checkedIn: number; waitlisted: number };

/** Today's non-cancelled sessions with bookings against capacity (same booking rule as the "Bookings today" number). */
export async function classesToday(tx: Tx, c: Ctx): Promise<ClassToday[]> {
  const count = (statuses: SQL) => sql`(select count(*)::int from bookings b where b.session_id = s.id and b.status in (${statuses}) ${bookingProgram(c)})`;
  const rows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select s.id, s.title, s.starts_at, l.name as location, u.display_name as coach, s.capacity,
          ${count(sql`'booked','attended','no_show'`)} as booked, ${count(sql`'attended'`)} as checked_in, ${count(sql`'waitlisted'`)} as waitlisted
        from schedule_sessions s left join locations l on l.id = s.location_id left join users u on u.id = s.coach_user_id
        where s.org_id = ${c.orgId} and s.status <> 'cancelled' and s.starts_at >= ${dayStart(c, c.today)} and s.starts_at < ${dayEnd(c, c.today)} ${sessionLoc(c)}
        order by s.starts_at, s.title`,
  );
  return rows.map((r) => ({ id: String(r.id), title: String(r.title), startsAt: new Date(r.starts_at as string), location: (r.location as string) ?? null, coach: (r.coach as string) ?? null, capacity: num(r.capacity), booked: num(r.booked), checkedIn: num(r.checked_in), waitlisted: num(r.waitlisted) }));
}

export type LocationCount = { name: string; people: number; memberships: number };

/**
 * Active members by where their membership is valid: one row per single-location scope, plus
 * "Multiple / all locations" for plans valid at several or all. Every active membership falls in
 * exactly one row, so memberships add up to the total (a person holding plans in two rows is
 * counted as a person in both).
 */
export async function activeByLocation(tx: Tx, c: Ctx): Promise<LocationCount[]> {
  const rows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select case when jsonb_array_length(ms.loc_scope) = 1 then coalesce((select l.name from locations l where l.id::text = ms.loc_scope->>0), 'Unknown location') else 'Multiple / all locations' end as name,
          count(distinct ms.athlete_id)::int as people, count(*)::int as memberships
        from ms where ${activeOn("ms", c.today)} and not ${trialOn("ms", c.today)}
        group by 1 order by (case when jsonb_array_length(min(ms.loc_scope::text)::jsonb) = 1 then 0 else 1 end), 1`,
  );
  return rows.map((r) => ({ name: String(r.name), people: num(r.people), memberships: num(r.memberships) }));
}

export type DailyScoreboard = { metrics: Record<string, MetricValue>; order: string[]; classes: ClassToday[]; byLocation: LocationCount[]; decisions: MetricRow[]; atRiskValueMinor: number | null; tookMs: number };

export async function dailyScoreboard(tx: Tx, v: Viewer, c: Ctx): Promise<DailyScoreboard> {
  const t0 = Date.now();
  const sh = shared(tx, v, c);
  const metrics: Record<string, MetricValue> = {};
  for (const def of DAILY_METRICS) metrics[def.key] = await metricValue(tx, c, def, sh);
  const classes = await classesToday(tx, c);
  const byLocation = await activeByLocation(tx, c);
  const decisions = await decisionList(c, sh);
  return { metrics, order: DAILY_METRICS.map((d) => d.key), classes, byLocation, decisions, atRiskValueMinor: metrics.at_risk.amountMinor, tookMs: Date.now() - t0 };
}
