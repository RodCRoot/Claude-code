import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { ReportDef, ReportRange } from "@/lib/reports";
import { localDayBounds } from "@/lib/time";
import { OFFER_LABEL } from "./offers";

type Row = Record<string, unknown>;
const q = async (tx: Tx, s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
const n = (v: unknown) => (v == null ? 0 : Number(v));
const bounds = (r: ReportRange) => ({ start: localDayBounds(r.from, r.tz).start.toISOString(), end: localDayBounds(r.to, r.tz).end.toISOString() });
const pct = (a: number, b: number) => (b ? a / b : null);

/** Growth reports, appended to the shared report registry (src/lib/reports.ts). */
export const GROWTH_REPORTS: ReportDef[] = [
  {
    key: "growth-referrals",
    title: "Referrals funnel",
    category: "Growth",
    definition:
      "Referrals whose inquiry arrived in the date range, per referring family. Referred = a lead with that family's code that passed the attribution rules. Started = the lead was converted to an athlete. Earned = the earning rule in Settings → Growth was met (first paid invoice above $0, or days active). Not counted = blocked by a rule (self-referral, same household, already a member family, already referred). Rewards are counted by their current status; a reward is only issued after staff approve it.",
    cap: "reports.financial",
    columns: [
      { key: "referrer", label: "Referring family" },
      { key: "referred", label: "Referred", kind: "int" },
      { key: "started", label: "Started", kind: "int" },
      { key: "earned", label: "Earned", kind: "int" },
      { key: "not_counted", label: "Not counted", kind: "int" },
      { key: "rewards_pending", label: "Rewards pending", kind: "int" },
      { key: "rewards_approved", label: "Rewards approved", kind: "int" },
      { key: "credit_approved_minor", label: "Account credit approved", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select pa.name as referrer,
              count(*) filter (where rf.status <> 'rejected')::int as referred,
              count(*) filter (where rf.status in ('started','earned'))::int as started,
              count(*) filter (where rf.status = 'earned')::int as earned,
              count(*) filter (where rf.status = 'rejected')::int as not_counted,
              coalesce(sum((select count(*) from referral_rewards rw where rw.referral_id = rf.id and rw.status = 'pending')),0)::int as rewards_pending,
              coalesce(sum((select count(*) from referral_rewards rw where rw.referral_id = rf.id and rw.status = 'approved')),0)::int as rewards_approved,
              coalesce(sum((select coalesce(sum(rw.amount_minor),0) from referral_rewards rw where rw.referral_id = rf.id and rw.status = 'approved' and rw.kind = 'account_credit')),0)::bigint as credit_approved_minor
            from referrals rf join payer_accounts pa on pa.id = rf.referrer_payer_account_id
            where rf.org_id = ${orgId} and rf.created_at >= ${start} and rf.created_at < ${end}
            group by pa.name order by started desc, referred desc, pa.name`,
      );
      const referred = rows.reduce((s, x) => s + n(x.referred), 0);
      const started = rows.reduce((s, x) => s + n(x.started), 0);
      const earned = rows.reduce((s, x) => s + n(x.earned), 0);
      return {
        rows,
        summary: [
          { label: "Referred", value: referred },
          { label: "Started", value: started },
          { label: "Earned", value: earned },
          { label: "Referred → started", value: pct(started, referred) ?? "n/a", kind: pct(started, referred) == null ? "text" : "pct" },
        ],
      };
    },
  },
  {
    key: "growth-shop-sales",
    title: "Shop sales by item",
    category: "Growth",
    definition:
      "Family Shop orders placed in the date range, by item. Ordered = invoices created at shop checkout (billed, not collected). Paid = those invoices that are now PAID, which only happens after a verified provider payment or a staff-recorded offline payment. Open = still awaiting payment. Voided orders are listed separately and excluded from the dollar columns.",
    cap: "reports.financial",
    columns: [
      { key: "item", label: "Item" },
      { key: "orders", label: "Orders", kind: "int" },
      { key: "paid", label: "Paid", kind: "int" },
      { key: "open", label: "Open", kind: "int" },
      { key: "voided", label: "Voided", kind: "int" },
      { key: "ordered_minor", label: "Ordered (billed)", kind: "money" },
      { key: "paid_minor", label: "Paid (settled)", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select p.name as item, count(*)::int as orders,
              count(*) filter (where i.status = 'paid')::int as paid,
              count(*) filter (where i.status = 'open')::int as open,
              count(*) filter (where i.status in ('void','uncollectible'))::int as voided,
              coalesce(sum(i.total_minor) filter (where i.status in ('open','paid')),0)::bigint as ordered_minor,
              coalesce(sum(i.total_minor) filter (where i.status = 'paid'),0)::bigint as paid_minor
            from shop_orders o join invoices i on i.id = o.invoice_id join products p on p.id = o.product_id
            where o.org_id = ${orgId} and o.created_at >= ${start} and o.created_at < ${end}
            group by p.name order by ordered_minor desc, p.name`,
      );
      return {
        rows,
        summary: [
          { label: "Orders", value: rows.reduce((s, x) => s + n(x.orders), 0) },
          { label: "Ordered (billed, not collected)", value: rows.reduce((s, x) => s + n(x.ordered_minor), 0), kind: "money" },
          { label: "Paid (settled)", value: rows.reduce((s, x) => s + n(x.paid_minor), 0), kind: "money" },
        ],
      };
    },
  },
  {
    key: "growth-offers",
    title: "Suggestions shown, followed and dismissed",
    category: "Growth",
    definition:
      "Family-facing suggestions in the date range, by rule. Shown = a suggestion was displayed to a family member (counted once per person, athlete, rule and day). Followed = the person used the suggestion's button (it does not mean they bought anything). Dismissed = the person chose Not now. Staff tasks = follow-up tasks staff created from the Opportunities list. Rates use Shown as the base.",
    cap: "reports.financial",
    columns: [
      { key: "rule", label: "Rule" },
      { key: "shown", label: "Shown", kind: "int" },
      { key: "accepted", label: "Followed", kind: "int" },
      { key: "dismissed", label: "Dismissed", kind: "int" },
      { key: "accept_rate", label: "Followed ÷ shown", kind: "pct" },
      { key: "dismiss_rate", label: "Dismissed ÷ shown", kind: "pct" },
      { key: "staff_tasks", label: "Staff tasks", kind: "int" },
    ],
    run: async (tx, orgId, r) => {
      const raw = await q(
        tx,
        sql`select offer_key,
              count(*) filter (where event = 'shown')::int as shown,
              count(*) filter (where event = 'accepted')::int as accepted,
              count(*) filter (where event = 'dismissed')::int as dismissed,
              count(*) filter (where event = 'task_created')::int as staff_tasks
            from offer_events where org_id = ${orgId} and day >= ${r.from} and day <= ${r.to}
            group by offer_key order by shown desc`,
      );
      const rows = raw.map((x) => ({
        ...x,
        rule: OFFER_LABEL[x.offer_key as keyof typeof OFFER_LABEL] ?? String(x.offer_key),
        accept_rate: pct(n(x.accepted), n(x.shown)),
        dismiss_rate: pct(n(x.dismissed), n(x.shown)),
      }));
      const sum = (k: string) => raw.reduce((s, x) => s + n(x[k]), 0);
      return { rows, summary: [{ label: "Shown", value: sum("shown") }, { label: "Followed", value: sum("accepted") }, { label: "Dismissed", value: sum("dismissed") }] };
    },
  },
  {
    key: "growth-trial-passes",
    title: "Trial pass conversion",
    category: "Growth",
    definition:
      "Trial passes issued in the date range. Sessions used = credits from the pass that were booked or attended (granted minus still available). Converted = the lead was converted to an athlete after the pass was issued. Joined = the athlete has a membership that started on or after the day the pass was issued. A pass with no lead (issued to a person directly) can count as Joined but not Converted.",
    cap: "reports.financial",
    columns: [
      { key: "issued_at", label: "Issued", kind: "datetime" },
      { key: "person", label: "For" },
      { key: "reason", label: "Reason" },
      { key: "credits", label: "Sessions", kind: "int" },
      { key: "used", label: "Sessions used", kind: "int" },
      { key: "expires_at", label: "Expires", kind: "datetime" },
      { key: "converted", label: "Converted" },
      { key: "joined", label: "Joined" },
    ],
    run: async (tx, orgId, r) => {
      const { start, end } = bounds(r);
      const rows = await q(
        tx,
        sql`select tp.created_at as issued_at, p.first_name || ' ' || p.last_name as person, tp.reason, tp.credits,
              (tp.credits - coalesce(cb.available, tp.credits))::int as used, tp.expires_at,
              case when l.converted_at is not null and l.converted_at >= tp.created_at then 'Yes' else 'No' end as converted,
              case when exists (select 1 from memberships m where m.athlete_id = tp.athlete_id and m.created_at >= tp.created_at) then 'Yes' else 'No' end as joined
            from trial_passes tp join people p on p.id = tp.person_id
              left join credit_buckets cb on cb.id = tp.credit_bucket_id left join leads l on l.id = tp.lead_id
            where tp.org_id = ${orgId} and tp.created_at >= ${start} and tp.created_at < ${end}
            order by tp.created_at desc`,
      );
      const converted = rows.filter((x) => x.converted === "Yes").length;
      const joined = rows.filter((x) => x.joined === "Yes").length;
      return {
        rows,
        summary: [
          { label: "Passes issued", value: rows.length },
          { label: "Converted", value: converted },
          { label: "Joined", value: joined },
          { label: "Joined ÷ issued", value: pct(joined, rows.length) ?? "n/a", kind: pct(joined, rows.length) == null ? "text" : "pct" },
        ],
      };
    },
  },
];
