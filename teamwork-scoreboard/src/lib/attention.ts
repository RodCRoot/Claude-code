import { sql } from "drizzle-orm";
import { subDays } from "date-fns";
import { db } from "@/db";
import { getSetting } from "./settings";
import { getAtRiskAthletes } from "./kpi";
import { todayStr, resolvePeriod, lastNWeekStarts, toDateStr } from "./periods";
import { getScoreboard } from "./kpi";

export interface AttentionItem {
  id: string;
  severity: "red" | "yellow";
  title: string;
  detail: string;
  href: string;
  count: number;
}

function count(q: ReturnType<typeof sql>): number {
  return db.get<{ v: number }>(q)?.v ?? 0;
}

/**
 * The accountability engine: derives everything that needs attention directly
 * from current data — nothing is cached, so it is always accurate.
 */
export function getAttentionItems(
  opts: { includeSensitive: boolean; includeKpis?: boolean },
  now: Date = new Date()
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const today = todayStr(now);
  const nowIso = now.toISOString();
  const responseGoalMin = getSetting("lead_response_goal_minutes");

  // 1. Leads past the response-time goal without first contact
  const staleLeads = count(sql`
    SELECT COUNT(*) AS v FROM leads
    WHERE first_contacted_at IS NULL AND stage NOT IN ('lost','member')
      AND (julianday(${nowIso}) - julianday(created_at)) * 1440 > ${responseGoalMin}
  `);
  if (staleLeads > 0) {
    items.push({
      id: "stale_leads",
      severity: "red",
      title: `${staleLeads} lead${staleLeads > 1 ? "s" : ""} past the ${responseGoalMin}-minute response goal`,
      detail: "New leads with no first contact logged.",
      href: "/leads?filter=uncontacted",
      count: staleLeads,
    });
  }

  // 2. Upcoming appointments not confirmed (next 48h)
  const unconfirmed = count(sql`
    SELECT COUNT(*) AS v FROM appointments
    WHERE status = 'scheduled' AND confirmed = 0
      AND scheduled_at >= ${nowIso}
      AND julianday(scheduled_at) - julianday(${nowIso}) <= 2
  `);
  if (unconfirmed > 0) {
    items.push({
      id: "unconfirmed_appts",
      severity: "yellow",
      title: `${unconfirmed} appointment${unconfirmed > 1 ? "s" : ""} in the next 48h not confirmed`,
      detail: "Confirm to protect show rate.",
      href: "/leads?tab=appointments",
      count: unconfirmed,
    });
  }

  // 3. Missed appointments in the last 7 days
  const missed = count(sql`
    SELECT COUNT(*) AS v FROM appointments
    WHERE status = 'no_show' AND scheduled_at >= ${toDateStr(subDays(now, 7))}
  `);
  if (missed > 0) {
    items.push({
      id: "missed_appts",
      severity: "yellow",
      title: `${missed} missed appointment${missed > 1 ? "s" : ""} this week`,
      detail: "Reschedule or follow up with each no-show.",
      href: "/leads?tab=appointments&filter=no_show",
      count: missed,
    });
  }

  // 4. Athletes with incomplete onboarding
  const incompleteOnboarding = count(sql`
    SELECT COUNT(DISTINCT ao.athlete_id) AS v FROM athlete_onboarding ao
    JOIN athletes a ON a.id = ao.athlete_id
    WHERE ao.status = 'pending' AND a.status = 'active'
  `);
  if (incompleteOnboarding > 0) {
    items.push({
      id: "incomplete_onboarding",
      severity: "yellow",
      title: `${incompleteOnboarding} athlete${incompleteOnboarding > 1 ? "s" : ""} with incomplete onboarding`,
      detail: "Open steps in the onboarding pipeline.",
      href: "/onboarding",
      count: incompleteOnboarding,
    });
  }

  // 5 & 6. At-risk athletes without recent outreach
  const atRisk = getAtRiskAthletes(now);
  const uncontacted = atRisk.filter((a) => !a.contactedInLast14);
  if (uncontacted.length > 0) {
    items.push({
      id: "at_risk_uncontacted",
      severity: "red",
      title: `${uncontacted.length} at-risk athlete${uncontacted.length > 1 ? "s" : ""} with no outreach in 14 days`,
      detail: uncontacted.slice(0, 3).map((a) => a.name).join(", ") + (uncontacted.length > 3 ? "…" : ""),
      href: "/athletes?filter=at_risk",
      count: uncontacted.length,
    });
  }

  // 7. Failed payments (last 30 days)
  if (opts.includeSensitive) {
    const failed = count(sql`
      SELECT COUNT(*) AS v FROM payments
      WHERE status = 'failed' AND date >= ${toDateStr(subDays(now, 30))}
    `);
    if (failed > 0) {
      items.push({
        id: "failed_payments",
        severity: "red",
        title: `${failed} failed payment${failed > 1 ? "s" : ""} in the last 30 days`,
        detail: "Contact accounts and retry billing.",
        href: "/scoreboard/failed_payments",
        count: failed,
      });
    }
  }

  // 8. Overdue tasks
  const overdue = count(sql`
    SELECT COUNT(*) AS v FROM tasks WHERE status = 'open' AND due_date < ${today}
  `);
  if (overdue > 0) {
    items.push({
      id: "overdue_tasks",
      severity: "yellow",
      title: `${overdue} operational task${overdue > 1 ? "s" : ""} past due`,
      detail: "Daily, weekly, or monthly checklist items not completed.",
      href: "/operations?view=overdue",
      count: overdue,
    });
  }

  // 9 & 10. Missing scoreboards / 5-15s for last week (staff who submit)
  const [lastWeek] = lastNWeekStarts(2, now);
  const staff = db.all<{ id: number; name: string }>(sql`
    SELECT u.id, u.name FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1 AND r.permissions LIKE '%submit_scorecard%'
  `);
  const missingScorecard = staff.filter(
    (s) =>
      !db.get(
        sql`SELECT id FROM scorecard_weeks
            WHERE user_id = ${s.id} AND week_start = ${lastWeek} AND submitted_at IS NOT NULL`
      )
  );
  if (missingScorecard.length > 0) {
    items.push({
      id: "missing_scorecards",
      severity: "yellow",
      title: `${missingScorecard.length} weekly scorecard${missingScorecard.length > 1 ? "s" : ""} not submitted for last week`,
      detail: missingScorecard.map((s) => s.name).join(", "),
      href: "/team",
      count: missingScorecard.length,
    });
  }
  const missing515 = staff.filter(
    (s) =>
      !db.get(
        sql`SELECT id FROM reports_515
            WHERE user_id = ${s.id} AND week_start = ${lastWeek} AND submitted_at IS NOT NULL`
      )
  );
  if (missing515.length > 0) {
    items.push({
      id: "missing_515",
      severity: "yellow",
      title: `${missing515.length} 5-15 report${missing515.length > 1 ? "s" : ""} missing for last week`,
      detail: missing515.map((s) => s.name).join(", "),
      href: "/reports",
      count: missing515.length,
    });
  }

  // 11. Marketing commitments still planned this month
  const month = today.slice(0, 7);
  const marketingPending = count(sql`
    SELECT COUNT(*) AS v FROM marketing_items
    WHERE month = ${month} AND status = 'planned'
  `);
  if (marketingPending > 0 && now.getDate() >= 10) {
    items.push({
      id: "marketing_pending",
      severity: "yellow",
      title: `${marketingPending} marketing action${marketingPending > 1 ? "s" : ""} not started this month`,
      detail: "Items on the monthly marketing plan still in “planned”.",
      href: "/marketing",
      count: marketingPending,
    });
  }

  // 12. KPIs materially below goal (red status, current week)
  if (opts.includeKpis !== false) {
    const period = resolvePeriod("weekly", now);
    const groups = getScoreboard(period, opts.includeSensitive, now);
    const reds = Object.values(groups)
      .flat()
      .filter((r) => r.status === "red" && r.value !== null && r.goal !== null);
    if (reds.length > 0) {
      items.push({
        id: "red_kpis",
        severity: "red",
        title: `${reds.length} KPI${reds.length > 1 ? "s" : ""} materially below goal this week`,
        detail: reds.slice(0, 4).map((r) => r.metric.name).join(", ") + (reds.length > 4 ? "…" : ""),
        href: "/scoreboard",
        count: reds.length,
      });
    }
  }

  // 13. Connectors that have stopped syncing
  const staleConnectors = db.all<{ name: string }>(sql`
    SELECT name FROM connectors
    WHERE status = 'ready' AND last_sync_at IS NOT NULL
      AND (julianday(${nowIso}) - julianday(last_sync_at)) * 1440 > sync_interval_minutes * 2
  `);
  if (staleConnectors.length > 0) {
    items.push({
      id: "stale_connectors",
      severity: "red",
      title: `${staleConnectors.length} data source${staleConnectors.length > 1 ? "s have" : " has"} stopped syncing`,
      detail: staleConnectors.map((c) => c.name).join(", "),
      href: "/data",
      count: staleConnectors.length,
    });
  }
  const errorConnectors = db.all<{ name: string }>(sql`
    SELECT name FROM connectors WHERE status = 'error'
  `);
  if (errorConnectors.length > 0) {
    items.push({
      id: "error_connectors",
      severity: "red",
      title: `Sync errors on ${errorConnectors.map((c) => c.name).join(", ")}`,
      detail: "See sync history for the error reason.",
      href: "/data",
      count: errorConnectors.length,
    });
  }

  const order = { red: 0, yellow: 1 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}
