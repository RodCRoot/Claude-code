import { sql } from "drizzle-orm";
import { db } from "@/db";
import { metrics } from "@/db/schema";
import {
  safePct,
  safeDiv,
  goalAttainment,
  goalDiff,
  statusFor,
  pctChange,
  type Status,
} from "./calc";
import { type Period, previousPeriod, scaleGoal, todayStr } from "./periods";
import { getSetting } from "./settings";

/* ------------------------------------------------------------------ */
/* SQL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Count/scalar helper for raw SQL. */
function scalar(q: ReturnType<typeof sql>): number | null {
  const row = db.get<{ v: number | null }>(q);
  return row?.v ?? null;
}
function num(q: ReturnType<typeof sql>): number {
  return scalar(q) ?? 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive range condition on a date/timestamp text column. */
function between(col: string, p: Period) {
  // ISO strings sort lexicographically; appending end-of-day covers both
  // date-only (YYYY-MM-DD) and full-timestamp columns.
  if (!DATE_RE.test(p.start) || !DATE_RE.test(p.end)) {
    throw new Error(`Invalid period bounds: ${p.start}..${p.end}`);
  }
  return sql.raw(`${col} >= '${p.start}' AND ${col} <= '${p.end}T23:59:59.999'`);
}

/* ------------------------------------------------------------------ */
/* At-risk logic (shared with attention engine and Today page)         */
/* ------------------------------------------------------------------ */

export interface AtRiskAthlete {
  id: number;
  name: string;
  reason: string;
  lastAttendance: string | null;
  contactedInLast14: boolean;
}

export function getAtRiskAthletes(now: Date = new Date()): AtRiskAthlete[] {
  const days = getSetting("at_risk_days_without_attendance");
  const today = todayStr(now);
  const rows = db.all<{
    id: number;
    name: string;
    risk_override: string | null;
    last_att: string | null;
    contacted: number;
  }>(sql`
    SELECT a.id, a.name, a.risk_override,
      (SELECT MAX(att.date) FROM attendance att
        WHERE att.athlete_id = a.id AND att.status = 'attended') AS last_att,
      (SELECT COUNT(*) FROM outreach o
        WHERE o.athlete_id = a.id
          AND o.at >= date(${today}, '-14 days')) AS contacted
    FROM athletes a
    WHERE a.status = 'active'
  `);
  const out: AtRiskAthlete[] = [];
  for (const r of rows) {
    if (r.risk_override === "ok") continue;
    let reason: string | null = null;
    if (r.risk_override === "at_risk") {
      reason = "Manually flagged at risk";
    } else if (r.last_att === null) {
      reason = "No attendance on record";
    } else {
      const gap = Math.floor(
        (new Date(today).getTime() - new Date(r.last_att).getTime()) / 86400000
      );
      if (gap >= days) reason = `No attendance in ${gap} days`;
    }
    if (reason) {
      out.push({
        id: r.id,
        name: r.name,
        reason,
        lastAttendance: r.last_att,
        contactedInLast14: r.contacted > 0,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Metric computation registry                                         */
/* ------------------------------------------------------------------ */

function leadsBySource(source: string, p: Period): number {
  return num(
    sql`SELECT COUNT(*) AS v FROM leads WHERE source = ${source} AND ${between("created_at", p)}`
  );
}

function collectedRevenue(p: Period): number {
  return num(
    sql`SELECT COALESCE(SUM(amount),0) AS v FROM payments
        WHERE status IN ('paid','recovered') AND ${between("date", p)}`
  );
}

function revenueByCategory(cats: string[], p: Period): number {
  const list = cats.map((c) => `'${c}'`).join(",");
  return num(
    sql`SELECT COALESCE(SUM(amount),0) AS v FROM payments
        WHERE status IN ('paid','recovered')
          AND category IN (${sql.raw(list)}) AND ${between("date", p)}`
  );
}

function membersAtDate(dateStr: string): number {
  return num(
    sql`SELECT COUNT(*) AS v FROM memberships
        WHERE is_trial = 0 AND start_date < ${dateStr}
          AND (end_date IS NULL OR end_date >= ${dateStr})
          AND status != 'completed'`
  );
}

function newMemberships(p: Period): number {
  return num(
    sql`SELECT COUNT(*) AS v FROM memberships
        WHERE is_trial = 0 AND ${between("start_date", p)}`
  );
}
/**
 * Cancellations in a period. Prefers the imported drop report (already
 * deduplicated to one row per person per month); falls back to membership
 * records when no drop data has been imported yet.
 */
function cancellationsIn(p: Period, category?: string): number {
  const fromDrops = num(
    sql`SELECT COUNT(*) AS v FROM cancellations
        WHERE ${between("effective_date", p)}
        ${category ? sql`AND category = ${category}` : sql``}`
  );
  if (fromDrops > 0 || category) return fromDrops;
  return num(
    sql`SELECT COUNT(*) AS v FROM memberships
        WHERE status = 'canceled' AND end_date IS NOT NULL AND ${between("end_date", p)}`
  );
}
function reactivationsIn(p: Period): number {
  return num(
    sql`SELECT COUNT(*) AS v FROM athletes
        WHERE reactivated_at IS NOT NULL AND ${between("reactivated_at", p)}`
  );
}
function completedAppts(p: Period): number {
  return num(
    sql`SELECT COUNT(*) AS v FROM appointments
        WHERE status = 'completed' AND ${between("scheduled_at", p)}`
  );
}

/** Registry: metric key -> compute(period) -> value|null. */
const REGISTRY: Record<string, (p: Period, now: Date) => number | null> = {
  new_leads: (p) => num(sql`SELECT COUNT(*) AS v FROM leads WHERE ${between("created_at", p)}`),
  leads_referral: (p) => leadsBySource("referral", p),
  leads_reactivation: (p) => leadsBySource("reactivation", p),
  leads_community: (p) => leadsBySource("community", p),
  leads_website: (p) => leadsBySource("website", p),
  leads_paid_ads: (p) => leadsBySource("paid_ads", p),
  leads_organic_social: (p) => leadsBySource("organic_social", p),
  leads_other: (p) => leadsBySource("other", p),
  lead_response_time: (p) =>
    scalar(sql`SELECT AVG((julianday(first_contacted_at) - julianday(created_at)) * 1440) AS v
      FROM leads WHERE first_contacted_at IS NOT NULL AND ${between("created_at", p)}`),
  leads_contacted: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM leads
      WHERE first_contacted_at IS NOT NULL AND ${between("first_contacted_at", p)}`),
  pct_leads_contacted: (p) => {
    const created = num(sql`SELECT COUNT(*) AS v FROM leads WHERE ${between("created_at", p)}`);
    const contacted = num(sql`SELECT COUNT(*) AS v FROM leads
      WHERE first_contacted_at IS NOT NULL AND ${between("created_at", p)}`);
    return safePct(contacted, created);
  },
  appts_booked: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM appointments WHERE ${between("created_at", p)}`),
  booking_rate: (p) => {
    const qualified = num(
      sql`SELECT COUNT(*) AS v FROM leads WHERE qualified = 1 AND ${between("created_at", p)}`
    );
    const booked = num(
      sql`SELECT COUNT(*) AS v FROM appointments WHERE ${between("created_at", p)}`
    );
    return safePct(booked, qualified);
  },

  appts_scheduled: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM appointments WHERE ${between("scheduled_at", p)}`),
  show_rate: (p) => {
    const done = completedAppts(p);
    const noShow = num(
      sql`SELECT COUNT(*) AS v FROM appointments
          WHERE status = 'no_show' AND ${between("scheduled_at", p)}`
    );
    return safePct(done, done + noShow);
  },
  trials_started: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM memberships WHERE is_trial = 1 AND ${between("start_date", p)}`),
  new_memberships: (p) => newMemberships(p),
  lead_to_appt: (p) => {
    const created = num(sql`SELECT COUNT(*) AS v FROM leads WHERE ${between("created_at", p)}`);
    const reached = num(sql`SELECT COUNT(*) AS v FROM leads
      WHERE stage IN ('appointment_scheduled','appointment_completed','trial','member')
        AND ${between("created_at", p)}`);
    return safePct(reached, created);
  },
  appt_to_member: (p) => safePct(newMemberships(p), completedAppts(p)),
  trial_to_member: (p) => {
    const ended = num(sql`SELECT COUNT(*) AS v FROM memberships
      WHERE is_trial = 1 AND end_date IS NOT NULL AND ${between("end_date", p)}`);
    const converted = num(sql`SELECT COUNT(*) AS v FROM memberships m
      WHERE m.is_trial = 1 AND m.end_date IS NOT NULL AND ${between("m.end_date", p)}
        AND EXISTS (SELECT 1 FROM memberships f
          WHERE f.athlete_id = m.athlete_id AND f.is_trial = 0 AND f.start_date >= m.start_date)`);
    return safePct(converted, ended);
  },
  lead_to_member: (p) => {
    const created = num(sql`SELECT COUNT(*) AS v FROM leads WHERE ${between("created_at", p)}`);
    const members = num(sql`SELECT COUNT(*) AS v FROM leads
      WHERE stage = 'member' AND ${between("created_at", p)}`);
    return safePct(members, created);
  },

  active_athletes: () =>
    num(sql`SELECT COUNT(*) AS v FROM athletes WHERE status = 'active'`),
  new_athletes: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM athletes WHERE ${between("start_date", p)}`),
  cancellations: (p) => cancellationsIn(p),
  cancellations_controllable: (p) => cancellationsIn(p, "controllable"),
  cancellations_expected: (p) => cancellationsIn(p, "expected"),
  holds: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM memberships
        WHERE hold_start IS NOT NULL AND ${between("hold_start", p)}`),
  reactivations: (p) => reactivationsIn(p),
  net_growth: (p) => newMemberships(p) + reactivationsIn(p) - cancellationsIn(p),
  retention: (p) => {
    const base = membersAtDate(p.start);
    const churned = cancellationsIn(p);
    const churnPct = safePct(churned, base);
    return churnPct === null ? null : Math.round((100 - churnPct) * 10) / 10;
  },
  churn: (p) => safePct(cancellationsIn(p), membersAtDate(p.start)),
  avg_lifespan: () =>
    scalar(sql`SELECT AVG(julianday(end_date) - julianday(start_date)) AS v
      FROM memberships WHERE status = 'canceled' AND end_date IS NOT NULL AND is_trial = 0`),
  attendance_count: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM attendance WHERE status = 'attended' AND ${between("date", p)}`),
  sessions_delivered: (p, now) => {
    const today = todayStr(now);
    return num(sql`SELECT COUNT(*) AS v FROM class_sessions
      WHERE ${between("date", p)} AND date <= ${today}`);
  },
  no_shows: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM attendance WHERE status = 'no_show' AND ${between("date", p)}`),
  session_utilization: (p, now) => {
    const today = todayStr(now);
    const capacity = num(sql`SELECT COALESCE(SUM(capacity),0) AS v FROM class_sessions
      WHERE ${between("date", p)} AND date <= ${today}`);
    const attended = num(sql`SELECT COUNT(*) AS v FROM attendance a
      WHERE a.status = 'attended' AND a.session_id IS NOT NULL AND ${between("a.date", p)}`);
    return safePct(attended, capacity);
  },
  below_expected_attendance: (_p, now) => {
    const today = todayStr(now);
    return num(sql`SELECT COUNT(*) AS v FROM athletes a
      WHERE a.status = 'active'
        AND (SELECT COUNT(*) FROM attendance att
              WHERE att.athlete_id = a.id AND att.status = 'attended'
                AND att.date > date(${today}, '-7 days')) < a.expected_sessions_per_week`);
  },
  at_risk: (_p, now) => getAtRiskAthletes(now).length,
  at_risk_contacted: (p, now) => {
    const atRisk = getAtRiskAthletes(now);
    if (atRisk.length === 0) return 0;
    const ids = atRisk.map((a) => a.id).join(",");
    return num(sql`SELECT COUNT(DISTINCT athlete_id) AS v FROM outreach
      WHERE athlete_id IN (${sql.raw(ids)}) AND ${between("at", p)}`);
  },
  pct_at_risk_contacted: (p, now) => {
    const atRisk = getAtRiskAthletes(now);
    if (atRisk.length === 0) return null;
    const ids = atRisk.map((a) => a.id).join(",");
    const contacted = num(sql`SELECT COUNT(DISTINCT athlete_id) AS v FROM outreach
      WHERE athlete_id IN (${sql.raw(ids)}) AND ${between("at", p)}`);
    return safePct(contacted, atRisk.length);
  },
  onboarding_completion: (_p, now) => {
    const today = todayStr(now);
    const required = num(sql`SELECT COUNT(*) AS v FROM athlete_onboarding ao
      JOIN athletes a ON a.id = ao.athlete_id
      WHERE ao.status != 'na' AND a.start_date > date(${today}, '-60 days')`);
    const done = num(sql`SELECT COUNT(*) AS v FROM athlete_onboarding ao
      JOIN athletes a ON a.id = ao.athlete_id
      WHERE ao.status = 'done' AND a.start_date > date(${today}, '-60 days')`);
    return safePct(done, required);
  },

  mrr: () =>
    num(sql`SELECT COALESCE(SUM(monthly_rate),0) AS v FROM memberships
        WHERE status = 'active' AND is_trial = 0`),
  collected_revenue: (p) => collectedRevenue(p),
  failed_payments: (p) =>
    num(sql`SELECT COUNT(*) AS v FROM payments WHERE status = 'failed' AND ${between("date", p)}`),
  recovered_payments: (p) =>
    num(sql`SELECT COALESCE(SUM(amount),0) AS v FROM payments
        WHERE status = 'recovered' AND ${between("date", p)}`),
  revenue_per_athlete: (p) => {
    const active = num(sql`SELECT COUNT(*) AS v FROM athletes WHERE status = 'active'`);
    return safeDiv(collectedRevenue(p), active);
  },
  revenue_membership: (p) => revenueByCategory(["membership"], p),
  revenue_private: (p) => revenueByCategory(["private_training"], p),
  revenue_specialty: (p) => revenueByCategory(["specialty_program"], p),
  revenue_rental_other: (p) => revenueByCategory(["rental", "other"], p),
  mom_revenue_change: (p, now) => {
    const prev = previousPeriod(p, now);
    return pctChange(collectedRevenue(p), collectedRevenue(prev));
  },
  revenue_target_progress: (p) => {
    const target = getSetting("monthly_revenue_target");
    return safePct(collectedRevenue(p), Number(target));
  },
};

/* ------------------------------------------------------------------ */
/* Manual (kpi_values) aggregation fallback                            */
/* ------------------------------------------------------------------ */

function manualValue(
  metricId: number,
  unit: string,
  kind: string,
  p: Period
): { value: number | null; lastUpdated: string | null } {
  if (kind === "stock") {
    const row = db.get<{ value: number; created_at: string }>(
      sql`SELECT value, created_at FROM kpi_values WHERE metric_id = ${metricId}
          AND period_start <= ${p.end}
          ORDER BY period_start DESC, created_at DESC LIMIT 1`
    );
    return { value: row?.value ?? null, lastUpdated: row?.created_at ?? null };
  }
  const agg = unit === "percent" || unit === "minutes" || unit === "days" ? "AVG" : "SUM";
  const row = db.get<{ v: number | null; lu: string | null; n: number }>(
    sql`SELECT ${sql.raw(agg)}(value) AS v, MAX(created_at) AS lu, COUNT(*) AS n
        FROM kpi_values
        WHERE metric_id = ${metricId}
          AND period_start >= ${p.start} AND period_start <= ${p.end}`
  );
  return { value: row && row.n > 0 ? row.v : null, lastUpdated: row?.lu ?? null };
}

/* ------------------------------------------------------------------ */
/* Scoreboard assembly                                                 */
/* ------------------------------------------------------------------ */

export interface MetricRow {
  id: number;
  key: string;
  name: string;
  groupKey: string;
  definition: string | null;
  formula: string | null;
  sourceSystem: string | null;
  dataOwner: string | null;
  unit: string;
  direction: "up" | "down";
  frequency: string;
  kind: string;
  goal: number | null;
  redBelowPct: number;
  yellowBelowPct: number;
  autoCompute: number;
  sensitive: number;
  sortOrder: number;
}

export interface KpiResult {
  metric: MetricRow;
  value: number | null;
  goal: number | null; // scaled to the viewed period
  diff: number | null;
  attainment: number | null;
  status: Status;
  previous: number | null;
  trendPct: number | null;
  source: string;
  lastUpdated: string | null;
  isManualOverride: boolean;
}

export function getActiveMetrics(includeSensitive: boolean): MetricRow[] {
  const rows = db.select().from(metrics).all() as unknown as MetricRow[];
  return rows
    .filter((m) => (m as unknown as { active: number }).active === 1)
    .filter((m) => includeSensitive || !m.sensitive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export function computeMetric(
  metric: MetricRow,
  period: Period,
  now: Date = new Date()
): KpiResult {
  let value: number | null = null;
  let source = metric.sourceSystem ?? "Manual";
  let lastUpdated: string | null = null;
  let isManualOverride = false;

  // Manual entries always win when present for the exact period (override).
  const manual = manualValue(metric.id, metric.unit, metric.kind, period);

  if (metric.autoCompute && REGISTRY[metric.key]) {
    value = REGISTRY[metric.key](period, now);
    lastUpdated = new Date().toISOString();
    if (manual.value !== null && metric.kind !== "stock") {
      // an explicit manual entry for this period overrides the computed value
      value = manual.value;
      lastUpdated = manual.lastUpdated;
      source = "Manual override";
      isManualOverride = true;
    }
  } else {
    value = manual.value;
    lastUpdated = manual.lastUpdated;
    source = manual.value !== null ? "Manual entry" : source;
  }

  const scaledGoal = scaleGoal(metric.goal, metric.frequency, metric.kind, period);
  const attainment = goalAttainment(value, scaledGoal, metric.direction);
  const status = statusFor(attainment, metric.redBelowPct, metric.yellowBelowPct);
  const diff = goalDiff(value, scaledGoal, metric.direction);

  // Previous period for trend
  let previous: number | null = null;
  const prevP = previousPeriod(period, now);
  if (metric.autoCompute && REGISTRY[metric.key] && metric.kind !== "stock") {
    previous = REGISTRY[metric.key](prevP, now);
  } else if (metric.kind !== "stock") {
    previous = manualValue(metric.id, metric.unit, metric.kind, prevP).value;
  }
  const trendPct = pctChange(value, previous);

  return {
    metric,
    value,
    goal: scaledGoal,
    diff,
    attainment,
    status,
    previous,
    trendPct,
    source,
    lastUpdated,
    isManualOverride,
  };
}

export function getScoreboard(
  period: Period,
  includeSensitive: boolean,
  now: Date = new Date()
): Record<string, KpiResult[]> {
  const list = getActiveMetrics(includeSensitive);
  const groups: Record<string, KpiResult[]> = {};
  for (const m of list) {
    const r = computeMetric(m, period, now);
    (groups[m.groupKey] ??= []).push(r);
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Drill-down: the records behind a number                             */
/* ------------------------------------------------------------------ */

export interface DrillTable {
  columns: string[];
  rows: (string | number | null)[][];
  note?: string;
}

export function drillRecords(key: string, p: Period, now: Date = new Date()): DrillTable {
  const leadCols = ["Name", "Source", "Stage", "Created", "First contact"];
  const leadRows = (where: string) =>
    db
      .all<{ name: string; source: string; stage: string; c: string; f: string | null }>(
        sql`SELECT name, source, stage, substr(created_at,1,10) AS c,
              COALESCE(substr(first_contacted_at,1,16),'—') AS f
            FROM leads WHERE ${sql.raw(where)} AND ${between("created_at", p)}
            ORDER BY created_at DESC LIMIT 200`
      )
      .map((r) => [r.name, r.source, r.stage, r.c, r.f]);

  if (key === "new_leads" || key === "pct_leads_contacted" || key === "lead_to_appt" || key === "lead_to_member" || key === "lead_response_time" || key === "booking_rate") {
    return { columns: leadCols, rows: leadRows("1=1") };
  }
  if (key.startsWith("leads_") && key !== "leads_contacted") {
    const source = key.replace("leads_", "").replace("rental_other", "other");
    return { columns: leadCols, rows: leadRows(`source = '${source}'`) };
  }
  if (key === "leads_contacted") {
    const rows = db
      .all<{ name: string; source: string; stage: string; c: string; f: string | null }>(
        sql`SELECT name, source, stage, substr(created_at,1,10) AS c, substr(first_contacted_at,1,16) AS f
            FROM leads WHERE first_contacted_at IS NOT NULL AND ${between("first_contacted_at", p)}
            ORDER BY first_contacted_at DESC LIMIT 200`
      )
      .map((r) => [r.name, r.source, r.stage, r.c, r.f]);
    return { columns: leadCols, rows };
  }
  if (["appts_booked", "appts_scheduled", "show_rate", "appt_to_member"].includes(key)) {
    const rows = db
      .all<{ who: string; type_key: string; s: string; status: string; conf: number }>(
        sql`SELECT COALESCE(l.name, a2.name, 'Unknown') AS who, ap.type_key,
              substr(ap.scheduled_at,1,16) AS s, ap.status, ap.confirmed AS conf
            FROM appointments ap
            LEFT JOIN leads l ON l.id = ap.lead_id
            LEFT JOIN athletes a2 ON a2.id = ap.athlete_id
            WHERE ${between("ap.scheduled_at", p)}
            ORDER BY ap.scheduled_at DESC LIMIT 200`
      )
      .map((r) => [r.who, r.type_key, r.s, r.status, r.conf ? "yes" : "no"]);
    return { columns: ["Contact", "Type", "Scheduled", "Status", "Confirmed"], rows };
  }
  if (["cancellations", "cancellations_controllable", "cancellations_expected"].includes(key)) {
    const cat =
      key === "cancellations_controllable"
        ? "controllable"
        : key === "cancellations_expected"
        ? "expected"
        : null;
    const rows = db
      .all<{
        name: string;
        d: string;
        reason: string | null;
        sub: string | null;
        by: string | null;
        cat: string;
        dups: number;
      }>(
        sql`SELECT athlete_name AS name, effective_date AS d, drop_reason AS reason,
              sub_drop_reason AS sub, cancelled_by AS by, category AS cat,
              duplicate_rows AS dups
            FROM cancellations
            WHERE ${between("effective_date", p)}
            ${cat ? sql`AND category = ${cat}` : sql``}
            ORDER BY effective_date DESC LIMIT 200`
      )
      .map((r) => [
        r.name,
        r.d,
        r.reason ?? "—",
        r.sub ?? "—",
        r.cat,
        r.by ?? "—",
        r.dups > 1 ? `${r.dups} raw rows merged` : "",
      ]);
    return {
      columns: ["Athlete", "Effective", "Reason", "Sub-reason", "Category", "Cancelled by", "Duplicates"],
      rows,
      note:
        "One row per person per month — duplicate membership rows from the Zen Planner drop report are merged automatically. Reason categories are editable in Admin → Settings.",
    };
  }
  if (["new_memberships", "trials_started", "holds", "net_growth", "trial_to_member", "retention", "churn", "mrr", "avg_lifespan"].includes(key)) {
    const rows = db
      .all<{ name: string; plan: string; rate: number; status: string; sd: string; ed: string | null }>(
        sql`SELECT a.name, m.plan, m.monthly_rate AS rate, m.status, m.start_date AS sd, m.end_date AS ed
            FROM memberships m JOIN athletes a ON a.id = m.athlete_id
            ORDER BY m.start_date DESC LIMIT 200`
      )
      .map((r) => [r.name, r.plan, r.rate, r.status, r.sd, r.ed ?? "—"]);
    return {
      columns: ["Athlete", "Plan", "Rate", "Status", "Start", "End"],
      rows,
      note: "All memberships, newest first.",
    };
  }
  if (["active_athletes", "new_athletes", "reactivations", "below_expected_attendance"].includes(key)) {
    const rows = db
      .all<{ name: string; program: string | null; status: string; sd: string; exp: number }>(
        sql`SELECT name, program, status, start_date AS sd, expected_sessions_per_week AS exp
            FROM athletes ORDER BY start_date DESC LIMIT 200`
      )
      .map((r) => [r.name, r.program ?? "—", r.status, r.sd, r.exp]);
    return { columns: ["Athlete", "Program", "Status", "Start", "Expected/wk"], rows };
  }
  if (["at_risk", "at_risk_contacted", "pct_at_risk_contacted"].includes(key)) {
    const rows = getAtRiskAthletes(now).map((a) => [
      a.name,
      a.reason,
      a.lastAttendance ?? "never",
      a.contactedInLast14 ? "yes" : "no",
    ]);
    return { columns: ["Athlete", "Reason", "Last attendance", "Contacted (14d)"], rows };
  }
  if (["attendance_count", "no_shows", "session_utilization", "sessions_delivered"].includes(key)) {
    const rows = db
      .all<{ d: string; name: string; status: string }>(
        sql`SELECT att.date AS d, a.name, att.status
            FROM attendance att JOIN athletes a ON a.id = att.athlete_id
            WHERE ${between("att.date", p)}
            ORDER BY att.date DESC LIMIT 300`
      )
      .map((r) => [r.d, r.name, r.status]);
    return { columns: ["Date", "Athlete", "Status"], rows };
  }
  if (key.startsWith("revenue") || ["collected_revenue", "failed_payments", "recovered_payments", "mom_revenue_change", "revenue_target_progress", "revenue_per_athlete"].includes(key)) {
    const rows = db
      .all<{ d: string; who: string | null; amount: number; category: string; status: string }>(
        sql`SELECT p2.date AS d, a.name AS who, p2.amount, p2.category, p2.status
            FROM payments p2 LEFT JOIN athletes a ON a.id = p2.athlete_id
            WHERE ${between("p2.date", p)}
            ORDER BY p2.date DESC LIMIT 300`
      )
      .map((r) => [r.d, r.who ?? "—", r.amount, r.category, r.status]);
    return { columns: ["Date", "Athlete", "Amount", "Category", "Status"], rows };
  }
  if (key === "onboarding_completion") {
    const rows = db
      .all<{ name: string; total: number; done: number }>(
        sql`SELECT a.name,
              COUNT(*) AS total,
              SUM(CASE WHEN ao.status = 'done' THEN 1 ELSE 0 END) AS done
            FROM athlete_onboarding ao JOIN athletes a ON a.id = ao.athlete_id
            WHERE ao.status != 'na'
            GROUP BY a.id ORDER BY a.start_date DESC LIMIT 100`
      )
      .map((r) => [r.name, `${r.done}/${r.total}`, r.total > 0 ? Math.round((r.done / r.total) * 100) + "%" : "—"]);
    return { columns: ["Athlete", "Steps done", "Completion"], rows };
  }
  // Default: manual entry history
  const rows = db
    .all<{ ps: string; pe: string; value: number; source: string; note: string | null; by: string | null; at: string }>(
      sql`SELECT kv.period_start AS ps, kv.period_end AS pe, kv.value, kv.source,
            kv.source_note AS note, u.name AS by, substr(kv.created_at,1,16) AS at
          FROM kpi_values kv
          JOIN metrics mt ON mt.id = kv.metric_id
          LEFT JOIN users u ON u.id = kv.entered_by_user_id
          WHERE mt.key = ${key}
          ORDER BY kv.period_start DESC LIMIT 100`
    )
    .map((r) => [r.ps, r.pe, r.value, r.source, r.by ?? "—", r.note ?? "—", r.at]);
  return {
    columns: ["Period start", "Period end", "Value", "Source", "Entered by", "Note", "At"],
    rows,
    note: "Entry history for this metric.",
  };
}
