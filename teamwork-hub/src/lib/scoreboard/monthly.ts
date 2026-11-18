import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { retentionRadar } from "@/lib/retention/radar";
import {
  activeOn,
  addMonths,
  continuedLater,
  continuesEarlier,
  isTrialPlan,
  membershipCtes,
  monthLabel,
  monthStart,
  num,
  rowsOf,
  trialOn,
  ymdOf,
  type Ctx,
  type Row,
} from "./core";

/**
 * Monthly scoreboard (the funnel). One row per metric, one column per calendar month, all in
 * facility-local time. Point-in-time rows are taken on the month's last day, or today for the
 * month in progress. Every value is aggregated in SQL from the same membership CTEs as the daily page.
 */

export type MonthlyRowKind = "int" | "pct" | "money" | "decimal";
export type MonthlyRowDef = {
  key: string;
  label: string;
  kind: MonthlyRowKind;
  /** Which direction is good, for comparing with the ideal. */
  better: "higher" | "lower";
  version: number;
  definition: string;
  dims: { location: boolean; program: boolean };
  /** Indented under the previous row. */
  sub?: boolean;
  /** No ideal can be set (derived or informational). */
  noTarget?: boolean;
};

const BOTH = { location: true, program: true };

export const MONTHLY_ROWS: MonthlyRowDef[] = [
  { key: "leads", label: "Leads", kind: "int", better: "higher", version: 1, dims: { location: false, program: false }, definition: "Lead records created in the month. Leads store neither a location nor a program, so this row is withheld while a filter is on." },
  {
    key: "showed",
    label: "Showed consults / assessments",
    kind: "int",
    better: "higher",
    version: 1,
    dims: { location: true, program: false },
    definition:
      "Distinct people who showed up in the month: an attended booking on an assessment-type session, or a lead whose linked assessment session was in the month and whose stage is Assessment Done or won. The CRM keeps only a lead's current stage, so a lead who showed and was later marked Lost is not counted unless a booking was checked in. Location = the session's location; withheld while a program filter is on.",
  },
  { key: "trials_sold", label: "New trials sold", kind: "int", better: "higher", version: 1, dims: BOTH, definition: "Memberships that started in the month on a trial product or a plan with trial days, plus trial passes issued in the month (passes carry no plan or location and are left out while a filter is on)." },
  {
    key: "sold",
    label: "New memberships sold",
    kind: "int",
    better: "higher",
    version: 1,
    dims: BOTH,
    definition: "Memberships whose start date is in the month, excluding trial products and excluding plan changes / rebuilds (the athlete had another membership still running within the rebuild window before it started). Same rule as the daily page's month-to-date number.",
  },
  { key: "close_rate", label: "Close rate", kind: "pct", better: "higher", version: 1, dims: { location: true, program: false }, definition: "New memberships sold divided by showed consults / assessments in the same month. Blank when nobody showed. A sale can follow a consult from an earlier month, so a single month can exceed 100%." },
  { key: "holds_processed", label: "Holds processed", kind: "int", better: "lower", version: 1, dims: BOTH, definition: "Family hold records created in the month (the month staff keyed the hold, not the month it covers). In-season pauses are not holds here." },
  {
    key: "lost",
    label: "Cancellations processed: real losses",
    kind: "int",
    better: "lower",
    version: 1,
    dims: BOTH,
    definition:
      "Non-trial memberships that ended in the month (end date, else cancel date, else the day marked ended) where the athlete has no other membership still running on that day and none starting within the rebuild window after it. The Retention report's membership churn counts every cancelled or expired membership, including plan changes.",
  },
  {
    key: "plan_changes",
    label: "Plan changes / rebuilds (not losses)",
    kind: "int",
    better: "lower",
    version: 1,
    dims: BOTH,
    sub: true,
    noTarget: true,
    definition: "Memberships that ended in the month but were continued by another membership of the same athlete (still running, or starting within the rebuild window), plus plan changes made in place on one membership. These are never counted as losses.",
  },
  { key: "net_growth", label: "Net growth (sold minus lost)", kind: "int", better: "higher", version: 1, dims: BOTH, noTarget: true, definition: "New memberships sold minus real losses in the month. Plan changes and rebuilds count on neither side." },
  { key: "active", label: "Active clients", kind: "int", better: "higher", version: 1, dims: BOTH, definition: "Distinct athletes with an active, non-trial membership on the month's last day (today for the current month). Same rule as the daily page's Active members." },
  { key: "active_trials", label: "Active trial clients", kind: "int", better: "higher", version: 1, dims: BOTH, definition: "Distinct athletes whose only active membership on that day is a trial, plus athletes with an unexpired trial pass and no membership (passes are left out while a filter is on)." },
  {
    key: "trial_conversion",
    label: "Trial conversion",
    kind: "pct",
    better: "higher",
    version: 1,
    dims: BOTH,
    definition:
      "Of trials that ended in the month, the share that converted. A trial product converts when the athlete starts a non-trial membership no later than the conversion window after the trial ended; a plan with trial days converts when the membership is still running the day its trial days end. Trial passes are not included (the Trial pass conversion report covers them). Blank when no trial ended.",
  },
  { key: "on_hold", label: "Clients on hold", kind: "int", better: "lower", version: 1, dims: BOTH, definition: "Distinct athletes with an active membership under a family hold on the month's last day (today for the current month, where memberships marked on hold without a hold record are included too). They are still counted in Active clients." },
  { key: "at_risk", label: "At-risk clients", kind: "int", better: "lower", version: 1, dims: BOTH, definition: "The retention radar's At risk count. The radar is computed live and stores no history, so only the current month has a value; past months show not recorded." },
  { key: "avg_attendance", label: "Average session attendance", kind: "decimal", better: "higher", version: 1, dims: BOTH, definition: "Attended bookings divided by sessions run, for non-cancelled group sessions (capacity over 1) that started in the month and are already in the past. With a program filter only that program's athletes are counted." },
  { key: "visits", label: "Total visits", kind: "int", better: "higher", version: 1, dims: BOTH, definition: "Attended bookings on non-cancelled sessions that started in the month, any service type. Same rule as the Attendance report's attended total." },
  {
    key: "arpm",
    label: "Average revenue per member",
    kind: "money",
    better: "higher",
    version: 1,
    dims: BOTH,
    definition: "Money collected in the month on membership invoices (settled charges and manual payments on invoices tied to a membership) divided by Active clients for that month. Gross of refunds and fees. Shop, drop-in and camp revenue is not included. For the month in progress this is month to date.",
  },
  {
    key: "loe",
    label: "Length of engagement (months)",
    kind: "decimal",
    better: "higher",
    version: 1,
    dims: BOTH,
    definition:
      "Average whole months from an athlete's first non-trial membership start to that month's last day for athletes still active, or to their last membership end for athletes who have left. Everyone who has ever been a member is included. The retention radar's average tenure covers current members only, so it reads differently.",
  },
];

export const TARGET_KEYS = MONTHLY_ROWS.filter((r) => !r.noTarget).map((r) => r.key);

export type MonthColumn = { month: string; label: string; partial: boolean; values: Record<string, number | null> };
export type MonthlyScoreboard = { months: MonthColumn[]; rows: MonthlyRowDef[]; targets: Record<string, number>; na: Record<string, string>; bottleneck: Bottleneck; bottleneckMonth: MonthColumn | null };

function naFor(def: MonthlyRowDef, c: Ctx): string | null {
  if (c.filter.locationId && !def.dims.location) return "Not available with a location filter";
  if (c.filter.productId && !def.dims.program) return "Not available with a program filter";
  return null;
}

export async function monthlyScoreboard(tx: Tx, v: Viewer, c: Ctx, opts: { months?: number } = {}): Promise<MonthlyScoreboard> {
  const count = Math.min(24, Math.max(2, opts.months ?? 6));
  const last = monthStart(c.today);
  const first = addMonths(last, -(count - 1));
  const tz = sql`${c.tz}`;
  const locS = c.filter.locationId ? sql`and s.location_id = ${c.filter.locationId}` : sql``;
  const progB = c.filter.productId ? sql`and exists (select 1 from ms where ms.athlete_id = b.athlete_id and ${activeOn("ms", sql`(s.starts_at at time zone ${tz})::date`)})` : sql``;
  const txnF = c.filtered ? sql`and i.membership_id in (select id from ms)` : sql``;
  const conv = c.settings.thresholds.trialConversionDays;
  const unfiltered = !c.filtered;

  const rows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)},
      mo as (
        select g::date as m0, (g + interval '1 month')::date as m1, least((g + interval '1 month' - interval '1 day')::date, ${c.today}::date) as asof,
          (g::date::timestamp at time zone ${tz}) as t0, ((g + interval '1 month')::date::timestamp at time zone ${tz}) as t1
        from generate_series(${first}::date, ${last}::date, interval '1 month') g),
      first_start as (select athlete_id, min(start_date) as first_start, max(ended_on) as last_end, bool_or(ended_on is null) as open_ended from ms where not trial_product group by athlete_id)
      select mo.m0,
        (select count(*)::int from leads l where l.org_id = ${c.orgId} and l.created_at >= mo.t0 and l.created_at < mo.t1) as leads,
        (select count(distinct x.person_id)::int from (
            select a.person_id from bookings b join schedule_sessions s on s.id = b.session_id join service_types st on st.id = s.service_type_id join athletes a on a.id = b.athlete_id
            where b.org_id = ${c.orgId} and st.kind = 'assessment' and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at >= mo.t0 and s.starts_at < mo.t1 ${locS}
            union
            select l.person_id from leads l join schedule_sessions s on s.id = l.assessment_session_id left join lead_stages ls on ls.org_id = l.org_id and ls.key = l.stage
            where l.org_id = ${c.orgId} and s.status <> 'cancelled' and s.starts_at >= mo.t0 and s.starts_at < mo.t1 ${locS}
              and (l.stage = 'assessment_done' or l.converted_at is not null or coalesce(ls.is_won, false))) x) as showed,
        (select count(*)::int from ms where ${isTrialPlan("ms")} and ms.start_date >= mo.m0 and ms.start_date < mo.m1 and ms.start_date <= ${c.today})
          + ${unfiltered ? sql`(select count(*)::int from trial_passes tp where tp.org_id = ${c.orgId} and tp.created_at >= mo.t0 and tp.created_at < mo.t1)` : sql`0`} as trials_sold,
        (select count(*)::int from ms where ms.start_date >= mo.m0 and ms.start_date < mo.m1 and ms.start_date <= ${c.today} and not ms.trial_product and not ${continuesEarlier(c, "ms")}) as sold,
        (select count(*)::int from membership_holds h join ms on ms.id = h.membership_id where h.kind = 'hold' and h.created_at >= mo.t0 and h.created_at < mo.t1) as holds_processed,
        (select count(*)::int from ms where not ms.trial_product and ms.ended_on >= mo.m0 and ms.ended_on < mo.m1 and ms.ended_on <= ${c.today} and not ${continuedLater(c, "ms")}) as lost,
        (select count(*)::int from ms where not ms.trial_product and ms.ended_on >= mo.m0 and ms.ended_on < mo.m1 and ms.ended_on <= ${c.today} and ${continuedLater(c, "ms")})
          + (select count(*)::int from membership_events e join ms on ms.id = e.membership_id where e.type = 'plan_changed' and e.created_at >= mo.t0 and e.created_at < mo.t1) as plan_changes,
        (select count(distinct ms.athlete_id)::int from ms where ${activeOn("ms", sql`mo.asof`)} and not ${trialOn("ms", sql`mo.asof`)}) as active,
        (select count(distinct ms.athlete_id)::int from ms where ${activeOn("ms", sql`mo.asof`)} and ${trialOn("ms", sql`mo.asof`)}
            and not exists (select 1 from allmx o where o.athlete_id = ms.athlete_id and ${activeOn("o", sql`mo.asof`)} and not ${trialOn("o", sql`mo.asof`)}))
          + ${
            unfiltered
              ? sql`(select count(distinct tp.athlete_id)::int from trial_passes tp where tp.org_id = ${c.orgId} and tp.created_at < least(mo.t1, ${c.now.toISOString()}::timestamptz) and tp.expires_at >= least(mo.t1, ${c.now.toISOString()}::timestamptz)
                    and not exists (select 1 from allmx o where o.athlete_id = tp.athlete_id and ${activeOn("o", sql`mo.asof`)}))`
              : sql`0`
          } as active_trials,
        (select count(*)::int from ms where ms.trial_product and ms.ended_on >= mo.m0 and ms.ended_on < mo.m1 and ms.ended_on <= ${c.today})
          + (select count(*)::int from ms where not ms.trial_product and ms.trial_days > 0 and ms.trial_until >= mo.m0 and ms.trial_until < mo.m1 and ms.trial_until <= ${c.today}) as trials_ended,
        (select count(*)::int from ms where ms.trial_product and ms.ended_on >= mo.m0 and ms.ended_on < mo.m1 and ms.ended_on <= ${c.today}
            and exists (select 1 from allmx o where o.athlete_id = ms.athlete_id and not o.trial_product and o.start_date >= ms.start_date and o.start_date <= ms.ended_on + ${conv}::int))
          + (select count(*)::int from ms where not ms.trial_product and ms.trial_days > 0 and ms.trial_until >= mo.m0 and ms.trial_until < mo.m1 and ms.trial_until <= ${c.today}
              and (ms.ended_on is null or ms.ended_on > ms.trial_until)) as trials_converted,
        (select count(distinct ms.athlete_id)::int from ms where ${activeOn("ms", sql`mo.asof`)}
            and (exists (select 1 from membership_holds h where h.membership_id = ms.id and h.kind = 'hold' and h.start_date <= mo.asof and h.end_date >= mo.asof)
                 or (mo.asof = ${c.today}::date and ms.status = 'on_hold'))) as on_hold,
        (select count(*)::int from schedule_sessions s where s.org_id = ${c.orgId} and s.status <> 'cancelled' and s.capacity > 1 and s.starts_at >= mo.t0 and s.starts_at < least(mo.t1, ${c.now.toISOString()}::timestamptz) ${locS}) as group_sessions,
        (select count(*)::int from bookings b join schedule_sessions s on s.id = b.session_id
          where b.org_id = ${c.orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.capacity > 1 and s.starts_at >= mo.t0 and s.starts_at < least(mo.t1, ${c.now.toISOString()}::timestamptz) ${locS} ${progB}) as group_attended,
        (select count(*)::int from bookings b join schedule_sessions s on s.id = b.session_id
          where b.org_id = ${c.orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at >= mo.t0 and s.starts_at < mo.t1 ${locS} ${progB}) as visits,
        (select coalesce(sum(t.amount_minor), 0)::bigint from transactions t join invoices i on i.id = t.invoice_id
          where t.org_id = ${c.orgId} and t.status = 'settled' and t.kind in ('charge','manual_payment') and i.membership_id is not null
            and coalesce(t.settled_at, t.occurred_at) >= mo.t0 and coalesce(t.settled_at, t.occurred_at) < mo.t1 ${txnF}) as membership_collected,
        (select avg(greatest(0, (extract(year from age(e.e, e.s)) * 12 + extract(month from age(e.e, e.s)))))::numeric(10,1)
          from (select fs.first_start as s, case when fs.open_ended or fs.last_end > mo.asof then mo.asof else fs.last_end end as e from first_start fs where fs.first_start <= mo.asof) e) as loe
      from mo order by mo.m0`,
  );

  const na: Record<string, string> = {};
  for (const def of MONTHLY_ROWS) {
    const why = naFor(def, c);
    if (why) na[def.key] = why;
  }
  let atRiskNow: number | null = null;
  if (!na.at_risk) {
    const ids = c.filtered ? (await rowsOf<{ athlete_id: string }>(tx, sql`with ${membershipCtes(c)} select distinct athlete_id from ms where ${activeOn("ms", c.today)}`)).map((r) => r.athlete_id) : undefined;
    atRiskNow = (await retentionRadar(tx, v, { today: c.today, athleteIds: ids })).summary.atRisk;
  }

  const months: MonthColumn[] = rows.map((r) => {
    const month = ymdOf(r.m0)!;
    const active = num(r.active);
    const showed = num(r.showed);
    const values: Record<string, number | null> = {
      leads: num(r.leads),
      showed,
      trials_sold: num(r.trials_sold),
      sold: num(r.sold),
      close_rate: showed ? num(r.sold) / showed : null,
      holds_processed: num(r.holds_processed),
      lost: num(r.lost),
      plan_changes: num(r.plan_changes),
      net_growth: num(r.sold) - num(r.lost),
      active,
      active_trials: num(r.active_trials),
      trial_conversion: num(r.trials_ended) ? num(r.trials_converted) / num(r.trials_ended) : null,
      on_hold: num(r.on_hold),
      at_risk: month === last ? atRiskNow : null,
      avg_attendance: num(r.group_sessions) ? Math.round((num(r.group_attended) / num(r.group_sessions)) * 10) / 10 : null,
      visits: num(r.visits),
      arpm: active ? Math.round(num(r.membership_collected) / active) : null,
      loe: r.loe == null ? null : Number(r.loe),
    };
    for (const k of Object.keys(na)) values[k] = null;
    // Raw numerator of `arpm`, kept so other tabs can re-aggregate without rounding drift (not a displayed row).
    values._membership_collected = num(r.membership_collected);
    return { month, label: monthLabel(month), partial: month === last, values };
  });

  // The read-out uses the last COMPLETE month (a month in progress would always look short).
  const bottleneckMonth = months.length > 1 ? months[months.length - 2] : null;
  return { months, rows: MONTHLY_ROWS, targets: c.settings.targets, na, bottleneck: bottleneck(bottleneckMonth?.values ?? {}, c.settings.targets, na), bottleneckMonth };
}

// ---------------------------------------------------------------------------
// "Where is the bottleneck?" A rule of thumb, never more than that.
// ---------------------------------------------------------------------------

export type BottleneckStep = { key: string; label: string; actual: number | null; target: number | null; status: "met" | "short" | "no_target" | "no_data" };
export type Bottleneck = {
  /** Null when no rule could be evaluated. */
  stage: "leads" | "consults" | "sales" | "retention" | "none" | null;
  headline: string;
  /** The rule that fired, in words, with the numbers it used. */
  rule: string;
  steps: BottleneckStep[];
};

export const BOTTLENECK_RULES: { stage: string; rule: string }[] = [
  { stage: "Leads", rule: "Leads are under the ideal: not enough people are coming in, so look at marketing and referrals first." },
  { stage: "Consults", rule: "Leads are at the ideal but showed consults are under it: look at follow-up speed, booking and the show rate." },
  { stage: "Sales", rule: "Consults are at the ideal but new memberships sold are under it: look at the consult itself, the offer and the close." },
  { stage: "Retention", rule: "Sales are at the ideal but active clients are under it, or more were lost than sold: look at retention (losses, holds, at-risk members)." },
  { stage: "None", rule: "Every step with an ideal met it: no bottleneck by these rules." },
];

/**
 * Walks the chain leads -> consults -> sales -> clients -> retention and reports the FIRST step
 * that is under its ideal. A step with no ideal, or with no value under the current filter, is
 * skipped and named. Pure function (tested directly).
 */
export function bottleneck(values: Record<string, number | null>, targets: Record<string, number>, na: Record<string, string> = {}): Bottleneck {
  const step = (key: string, label: string): BottleneckStep => {
    const actual = values[key] ?? null;
    const raw = targets[key];
    const target = raw == null ? null : key === "close_rate" || key === "trial_conversion" ? raw / 100 : raw;
    const status = na[key] || actual == null ? "no_data" : target == null ? "no_target" : actual >= target ? "met" : "short";
    return { key, label, actual, target: raw ?? null, status };
  };
  const steps = [step("leads", "Leads"), step("showed", "Showed consults"), step("sold", "New memberships sold"), step("active", "Active clients")];
  const [leads, showed, sold, active] = steps;
  const fmt = (s: BottleneckStep) => `${s.actual ?? "no value"} against an ideal of ${s.target ?? "none set"}`;
  const evaluated = steps.filter((s) => s.status === "met" || s.status === "short");
  if (!evaluated.length) {
    return { stage: null, headline: "Set an ideal for leads, consults, sales and active clients to get a read-out.", rule: "No rule could run: no step has both a value and an ideal.", steps };
  }
  if (leads.status === "short") return { stage: "leads", headline: "Top of the funnel: not enough leads.", rule: `Rule: leads under the ideal (${fmt(leads)}). ${BOTTLENECK_RULES[0].rule}`, steps };
  if (showed.status === "short") return { stage: "consults", headline: "Follow-up and show rate.", rule: `Rule: leads are not short, but showed consults are under the ideal (${fmt(showed)}). ${BOTTLENECK_RULES[1].rule}`, steps };
  if (sold.status === "short") return { stage: "sales", headline: "Sales: consults are not turning into memberships.", rule: `Rule: consults are not short, but new memberships sold are under the ideal (${fmt(sold)}). ${BOTTLENECK_RULES[2].rule}`, steps };
  const net = values.net_growth ?? null;
  if (active.status === "short" || (net != null && net < 0)) {
    const why = active.status === "short" ? `active clients are under the ideal (${fmt(active)})` : `more memberships were lost than sold (net growth ${net})`;
    return { stage: "retention", headline: "Retention: sales are being offset by losses.", rule: `Rule: sales are not short, but ${why}. ${BOTTLENECK_RULES[3].rule}`, steps };
  }
  return { stage: "none", headline: "No bottleneck by these rules.", rule: `Rule: ${BOTTLENECK_RULES[4].rule}`, steps };
}
