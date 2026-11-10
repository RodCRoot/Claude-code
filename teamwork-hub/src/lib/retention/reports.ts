import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { localDayBounds } from "@/lib/time";
import type { ReportDef, ReportRange, ReportResult } from "@/lib/reports";
import { OUTCOME_LABEL, reasonLabel, retentionSettingsFrom, tenureMonths } from "./common";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";

type Row = Record<string, unknown>;
const q = async (tx: Tx, s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const bounds = (r: ReportRange) => ({ start: localDayBounds(r.from, r.tz).start.toISOString(), end: localDayBounds(r.to, r.tz).end.toISOString() });
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export const TENURE_COHORTS: { label: string; min: number; max: number }[] = [
  { label: "0–2 months", min: 0, max: 2 },
  { label: "3–5 months", min: 3, max: 5 },
  { label: "6–11 months", min: 6, max: 11 },
  { label: "12+ months", min: 12, max: Infinity },
];

/**
 * Per-athlete membership facts for the range. A membership "ends on" its end date, else (when
 * cancelled / expired with no end date) its cancel date, else the day it was marked ended. An
 * athlete is a member on day D when any non-pending membership started on/before D and has not
 * ended by D.
 */
export async function churnFacts(tx: Tx, orgId: string, r: Pick<ReportRange, "from" | "to" | "tz">) {
  const rows = await q(
    tx,
    sql`with ms as (
          select m.athlete_id, m.start_date, pr.name as plan, pv.price_minor,
            case when m.end_date is not null then m.end_date
                 when m.status in ('cancelled','expired') then coalesce(m.cancel_at, (m.updated_at at time zone ${r.tz})::date) end as ended_on
          from memberships m join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
          where m.org_id = ${orgId} and m.status <> 'pending')
        select athlete_id, min(start_date) as first_start,
          bool_or(start_date < ${r.from} and (ended_on is null or ended_on > ${r.from})) as at_start,
          bool_or(start_date <= ${r.to} and (ended_on is null or ended_on > ${r.to})) as at_end,
          max(ended_on) filter (where ended_on <= ${r.to}) as last_end,
          (array_agg(plan order by price_minor desc) filter (where start_date < ${r.from} and (ended_on is null or ended_on > ${r.from})))[1] as plan_at_start
        from ms group by athlete_id`,
  );
  return rows.map((x) => ({
    athleteId: x.athlete_id as string,
    firstStart: ymd(x.first_start)!,
    atStart: !!x.at_start,
    atEnd: !!x.at_end,
    lastEnd: ymd(x.last_end),
    planAtStart: (x.plan_at_start as string) ?? null,
  }));
}

const D = {
  outcomes: "Save-log entries (Log outcome on the retention radar) created in the range, by outcome. $ = sum of each entry's value-at-risk estimate when it was logged (monthly plan price after discounts; blank when logged by staff without billing access).",
  reasons: "Save-log entries with outcome Lost created in the range, by reason code. 'No outcome logged' = athletes who churned in the range (see churn) with no Lost entry in the range.",
  cohort: "Members at start = athletes with a membership on the From date that started before it. Ended = of those, athletes with no membership at the end of the To date. Churn = ended ÷ members at start. Tenure cohort = whole months from the athlete's first membership start to the From date.",
  plan: "Same churn calculation, grouped by the athlete's highest-priced plan on the From date.",
  tenure: "Average whole months from an athlete's first membership start: to the To date for current members, and to their last membership end for athletes who churned in the range.",
};

export const RETENTION_REPORTS: ReportDef[] = [
  {
    key: "retention-saves",
    title: "Retention: saves, losses and churn",
    category: "Retention",
    definition:
      "Saves and losses come from the save log (outcomes staff logged on the retention radar in the range). Churn counts ATHLETES, not memberships: members at start = athletes with a membership on the From date; ended = those with no membership at the end of the To date; churn = ended ÷ members at start, shown overall, by tenure cohort and by plan. Average tenure is in whole months from the athlete's first membership start. Dollar figures are the value-at-risk estimates recorded when the outcome was logged, not collected or lost revenue. The last column states how each row is computed.",
    cap: "retention.manage",
    columns: [
      { key: "section", label: "Section" },
      { key: "group", label: "Group" },
      { key: "count", label: "Count", kind: "int" },
      { key: "members_start", label: "Members at start", kind: "int" },
      { key: "ended", label: "Ended", kind: "int" },
      { key: "churn_rate", label: "Churn", kind: "pct" },
      { key: "avg_tenure_months", label: "Avg tenure (months)" },
      { key: "value_minor", label: "Est. monthly value", kind: "money" },
      { key: "how", label: "How it is computed" },
    ],
    run: async (tx, orgId, r): Promise<ReportResult> => {
      const { start, end } = bounds(r);
      const actions = await q(
        tx,
        sql`select outcome, reason_code, count(*)::int as n, sum(value_at_risk_minor)::bigint as value_minor, count(distinct athlete_id)::int as athletes
            from retention_actions where org_id = ${orgId} and created_at >= ${start} and created_at < ${end} group by outcome, reason_code`,
      );
      const lostAthletes = new Set(
        (await q(tx, sql`select distinct athlete_id from retention_actions where org_id = ${orgId} and outcome = 'lost' and created_at >= ${start} and created_at < ${end}`)).map((x) => x.athlete_id as string),
      );
      const facts = await churnFacts(tx, orgId, r);
      const base = facts.filter((f) => f.atStart);
      const churned = base.filter((f) => !f.atEnd);
      const rows: Row[] = [];
      for (const o of ["saved", "still_at_risk", "lost"] as const) {
        const xs = actions.filter((a) => a.outcome === o);
        const vals = xs.filter((a) => a.value_minor != null);
        rows.push({ section: "Outcomes logged", group: OUTCOME_LABEL[o], count: xs.reduce((s, a) => s + Number(a.n), 0), value_minor: vals.length ? vals.reduce((s, a) => s + Number(a.value_minor), 0) : null, how: D.outcomes });
      }
      for (const a of actions.filter((x) => x.outcome === "lost").sort((x, y) => Number(y.n) - Number(x.n))) {
        rows.push({ section: "Losses by reason", group: reasonLabel(a.reason_code as string), count: Number(a.n), value_minor: a.value_minor == null ? null : Number(a.value_minor), how: D.reasons });
      }
      const unlogged = churned.filter((f) => !lostAthletes.has(f.athleteId)).length;
      if (unlogged) rows.push({ section: "Losses by reason", group: "No outcome logged", count: unlogged, how: D.reasons });
      const churnRow = (section: string, group: string, xs: typeof base, how: string): Row => {
        const ended = xs.filter((f) => !f.atEnd).length;
        return { section, group, members_start: xs.length, ended, churn_rate: xs.length ? ended / xs.length : null, how };
      };
      rows.push(churnRow("Churn", "All members", base, D.cohort));
      for (const c of TENURE_COHORTS) {
        const xs = base.filter((f) => {
          const t = tenureMonths(f.firstStart, r.from);
          return t >= c.min && t <= c.max;
        });
        rows.push(churnRow("Churn by tenure cohort", c.label, xs, D.cohort));
      }
      for (const plan of [...new Set(base.map((f) => f.planAtStart ?? "Unknown plan"))].sort()) {
        rows.push(churnRow("Churn by plan", plan, base.filter((f) => (f.planAtStart ?? "Unknown plan") === plan), D.plan));
      }
      const current = facts.filter((f) => f.atEnd);
      const tenCurrent = avg(current.map((f) => tenureMonths(f.firstStart, r.to)));
      const tenChurned = avg(churned.filter((f) => f.lastEnd).map((f) => tenureMonths(f.firstStart, f.lastEnd!)));
      rows.push({ section: "Average tenure", group: "Current members", count: current.length, avg_tenure_months: tenCurrent, how: D.tenure });
      rows.push({ section: "Average tenure", group: "Churned in range", count: churned.length, avg_tenure_months: tenChurned, how: D.tenure });
      const n = (o: string) => actions.filter((a) => a.outcome === o).reduce((s, a) => s + Number(a.n), 0);
      return {
        rows,
        summary: [
          { label: "Saves logged", value: n("saved") },
          { label: "Losses logged", value: n("lost") },
          { label: "Athlete churn", value: base.length ? `${Math.round((churned.length / base.length) * 1000) / 10}% (${churned.length} of ${base.length})` : "not calculable" },
          { label: "Avg tenure, current members", value: tenCurrent == null ? "no members" : `${tenCurrent} months` },
        ],
      };
    },
  },
  {
    key: "session-feedback",
    title: "Session feedback averages",
    category: "Retention",
    definition:
      "Average 1–5 rating that athletes and parents left after attended sessions that started in the range, by coach and by class. Low ratings = responses at or below the follow-up threshold in Settings. Only averages and counts: no names and no comments. A coach sees only their own sessions, and an average is shown to a coach only once it has the minimum number of responses set in Settings, so a single family is never identifiable.",
    cap: "feedback.report",
    columns: [
      { key: "section", label: "Level" },
      { key: "name", label: "Coach / class" },
      { key: "responses", label: "Responses", kind: "int" },
      { key: "avg_rating", label: "Average rating (1–5)" },
      { key: "low", label: "Low ratings", kind: "int" },
      { key: "attended", label: "Attended bookings", kind: "int" },
      { key: "response_rate", label: "Responses ÷ attended", kind: "pct" },
    ],
    run: async (tx, orgId, r): Promise<ReportResult> => {
      const { start, end } = bounds(r);
      const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
      const s = retentionSettingsFrom(org?.settings);
      const coachOnly = r.viewer?.role === "coach" ? r.viewer.userId : null;
      const mine = coachOnly ? sql`and s.coach_user_id = ${coachOnly}` : sql``;
      const agg = (by: ReturnType<typeof sql>, name: ReturnType<typeof sql>) => sql`
        select ${name} as name, count(sf.id)::int as responses, avg(sf.rating)::float8 as avg_rating,
          count(sf.id) filter (where sf.rating <= ${s.lowRatingThreshold})::int as low, count(b.id)::int as attended
        from bookings b join schedule_sessions s on s.id = b.session_id
          left join users u on u.id = s.coach_user_id
          left join session_feedback sf on sf.booking_id = b.id
        where b.org_id = ${orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at >= ${start} and s.starts_at < ${end} ${mine}
        group by ${by} having count(sf.id) > 0 order by 1`;
      const shape = (section: string) => (x: Row): Row => {
        const n = Number(x.responses);
        const hide = !!coachOnly && n < s.anonymityMinResponses;
        return {
          section,
          name: x.name,
          responses: n,
          avg_rating: hide ? `not shown (fewer than ${s.anonymityMinResponses} responses)` : Number(x.avg_rating).toFixed(2),
          low: hide ? null : Number(x.low),
          attended: Number(x.attended),
          response_rate: Number(x.attended) ? n / Number(x.attended) : null,
        };
      };
      const coaches = (await q(tx, agg(sql`u.id, u.display_name`, sql`coalesce(u.display_name, 'No coach')`))).map(shape("Coach"));
      const classes = (await q(tx, agg(sql`s.title`, sql`s.title`))).map(shape("Class"));
      const total = coaches.reduce((a, c) => a + Number(c.responses), 0);
      return {
        rows: [...coaches, ...classes],
        summary: [{ label: "Responses", value: total }],
        notes: coachOnly ? ["Showing your own sessions only."] : [],
      };
    },
  },
];
