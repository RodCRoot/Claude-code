import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { getScoreboard, getAtRiskAthletes, computeMetric, getActiveMetrics } from "@/lib/kpi";
import { getAttentionItems } from "@/lib/attention";
import { resolvePeriod, lastNWeekStarts, todayStr } from "@/lib/periods";
import { formatValue } from "@/lib/calc";
import { getSetting } from "@/lib/settings";
import { PrintButton } from "@/components/print-button";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
} from "@/components/ui";

export const metadata = { title: "Weekly Owner Summary" };

export default async function SummaryPage() {
  const me = await requireUser("review_reports");
  const includeSensitive = me.permissions.includes("view_financials");
  const now = new Date();
  const week = resolvePeriod("weekly", now);
  const month = resolvePeriod("monthly", now);

  const groups = getScoreboard(week, includeSensitive, now);
  const flat = Object.values(groups).flat();
  const withGoals = flat.filter((r) => r.value !== null && r.goal !== null && r.attainment !== null);
  const ahead = withGoals
    .filter((r) => r.status === "green")
    .sort((a, b) => (b.attainment ?? 0) - (a.attainment ?? 0));
  const behind = withGoals
    .filter((r) => r.status === "red")
    .sort((a, b) => (a.attainment ?? 0) - (b.attainment ?? 0));
  const watch = withGoals.filter((r) => r.status === "yellow");

  // Staff accountability
  const [lastWeek] = lastNWeekStarts(2, now);
  const staff = db.all<{ id: number; name: string }>(sql`
    SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1 AND r.permissions LIKE '%submit_scorecard%'
  `);
  const missingScorecards = staff.filter(
    (s) => !db.get(sql`SELECT id FROM scorecard_weeks WHERE user_id = ${s.id} AND week_start = ${lastWeek} AND submitted_at IS NOT NULL`)
  );
  const missing515s = staff.filter(
    (s) => !db.get(sql`SELECT id FROM reports_515 WHERE user_id = ${s.id} AND week_start = ${lastWeek} AND submitted_at IS NOT NULL`)
  );
  const overdueByPerson = db.all<{ name: string | null; n: number }>(sql`
    SELECT u.name, COUNT(*) AS n FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_user_id
    WHERE t.status = 'open' AND t.due_date < ${todayStr(now)}
    GROUP BY t.assigned_user_id ORDER BY n DESC
  `);

  const atRisk = getAtRiskAthletes(now);

  // Revenue & membership movement (financial permission gated)
  const allMetrics = getActiveMetrics(includeSensitive);
  const metricByKey = (k: string) => allMetrics.find((m) => m.key === k);
  const pick = (k: string, p = month) => {
    const m = metricByKey(k);
    return m ? computeMetric(m, p, now) : null;
  };
  const mrr = includeSensitive ? pick("mrr") : null;
  const collected = includeSensitive ? pick("collected_revenue") : null;
  const target = Number(getSetting("monthly_revenue_target"));
  const netGrowth = pick("net_growth");
  const newMembers = pick("new_memberships");
  const cancels = pick("cancellations");

  // Marketing performance this month
  const mk = todayStr(now).slice(0, 7);
  const mkStats = db.get<{ total: number; done: number }>(sql`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM marketing_items WHERE month = ${mk}
  `);
  const activeCampaign = db.get<{ name: string; leads_generated: number; enrollments: number; revenue: number }>(sql`
    SELECT name, leads_generated, enrollments, revenue FROM campaigns
    WHERE status = 'active' ORDER BY start_date DESC LIMIT 1
  `);

  // Five recommended priorities — rule-based, each tied to observed data.
  const priorities: { title: string; why: string }[] = [];
  const attention = getAttentionItems({ includeSensitive, includeKpis: false }, now);
  const staleLeads = attention.find((a) => a.id === "stale_leads");
  if (staleLeads) {
    priorities.push({
      title: `Contact the ${staleLeads.count} waiting lead${staleLeads.count > 1 ? "s" : ""} first thing`,
      why: "Leads are past the configured response-time goal (fact).",
    });
  }
  const uncontactedAtRisk = atRisk.filter((a) => !a.contactedInLast14);
  if (uncontactedAtRisk.length > 0) {
    priorities.push({
      title: `Personal outreach to ${uncontactedAtRisk.length} at-risk athlete${uncontactedAtRisk.length > 1 ? "s" : ""}`,
      why: "No outreach logged in 14 days for these athletes (fact); retention risk if unaddressed (interpretation).",
    });
  }
  for (const r of behind.slice(0, 3)) {
    priorities.push({
      title: `Close the gap on “${r.metric.name}” (${Math.round(r.attainment ?? 0)}% of goal)`,
      why: `Actual ${formatValue(r.value, r.metric.unit)} vs goal ${formatValue(r.goal, r.metric.unit)} this week (fact).`,
    });
  }
  if (missingScorecards.length + missing515s.length > 0) {
    priorities.push({
      title: "Collect missing scorecards and 5-15s at the team meeting",
      why: `${missingScorecards.length} scorecard(s) and ${missing515s.length} 5-15(s) missing for last week (fact).`,
    });
  }
  const failed = includeSensitive ? pick("failed_payments", month) : null;
  if (failed && failed.value !== null && failed.value > 0) {
    priorities.push({
      title: `Recover ${failed.value} failed payment${failed.value > 1 ? "s" : ""}`,
      why: "Failed payments this month have not been recovered (fact).",
    });
  }
  const topPriorities = priorities.slice(0, 5);

  return (
    <>
      <PageHeader
        kicker={`Owner summary · ${week.label}`}
        title="Weekly Owner Summary"
        subtitle="Everything below is computed from the data in this app. Facts are labeled as facts; anything else is marked as interpretation."
        actions={<PrintButton label="Print / save PDF" />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="print-block border-l-4 border-l-ok">
          <CardHeader kicker="Ahead of goal" title="Biggest wins" />
          <CardBody>
            {ahead.length === 0 ? (
              <p className="text-sm text-ink-3">No KPIs at or above goal this week.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {ahead.slice(0, 6).map((r) => (
                  <li key={r.metric.key} className="flex items-center justify-between">
                    <span className="font-medium">{r.metric.name}</span>
                    <span className="text-ink-2">
                      {formatValue(r.value, r.metric.unit)} vs {formatValue(r.goal, r.metric.unit)} goal{" "}
                      <Badge variant="green">{Math.round(r.attainment!)}%</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="print-block border-l-4 border-l-bad">
          <CardHeader
            kicker="Behind goal"
            title="KPIs needing attention"
            action={watch.length > 0 ? <Badge variant="yellow">{watch.length} on watch</Badge> : undefined}
          />
          <CardBody>
            {behind.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing materially below goal. 🎯</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {behind.slice(0, 6).map((r) => (
                  <li key={r.metric.key} className="flex items-center justify-between">
                    <span className="font-medium">{r.metric.name}</span>
                    <span className="text-ink-2">
                      {formatValue(r.value, r.metric.unit)} vs {formatValue(r.goal, r.metric.unit)}{" "}
                      <Badge variant="red">{Math.round(r.attainment!)}%</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="print-block">
          <CardHeader kicker="Team" title="Staff accountability" />
          <CardBody className="space-y-2 text-sm">
            <p>
              Missing scorecards (last week):{" "}
              {missingScorecards.length === 0 ? (
                <Badge variant="green">none</Badge>
              ) : (
                <span className="font-medium">{missingScorecards.map((s) => s.name).join(", ")}</span>
              )}
            </p>
            <p>
              Missing 5-15s (last week):{" "}
              {missing515s.length === 0 ? (
                <Badge variant="green">none</Badge>
              ) : (
                <span className="font-medium">{missing515s.map((s) => s.name).join(", ")}</span>
              )}
            </p>
            <div>
              Overdue tasks by person:{" "}
              {overdueByPerson.length === 0 ? (
                <Badge variant="green">none</Badge>
              ) : (
                <ul className="mt-1 list-inside list-disc text-ink-2">
                  {overdueByPerson.map((o, i) => (
                    <li key={i}>
                      {o.name ?? "Unassigned"}: {o.n}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>

        <Card className="print-block">
          <CardHeader kicker="Retention" title="At-risk clients" />
          <CardBody>
            {atRisk.length === 0 ? (
              <p className="text-sm text-ink-3">No athletes currently flagged at risk.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {atRisk.slice(0, 8).map((a) => (
                  <li key={a.id} className="flex items-center justify-between">
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-ink-3">
                      {a.reason} · {a.contactedInLast14 ? "outreach done" : "no outreach"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="print-block">
          <CardHeader kicker="Money & membership" title="Revenue and membership movement" />
          <CardBody className="grid grid-cols-2 gap-3 text-sm">
            {includeSensitive ? (
              <>
                <div className="rounded-lg bg-surface-3/60 px-3 py-2">
                  <div className="kicker">MRR (current)</div>
                  <div className="stat-figure text-xl font-bold">
                    {formatValue(mrr?.value ?? null, "currency", { compact: true })}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-3/60 px-3 py-2">
                  <div className="kicker">Collected MTD vs target</div>
                  <div className="stat-figure text-xl font-bold">
                    {formatValue(collected?.value ?? null, "currency", { compact: true })}
                    <span className="text-sm font-normal text-ink-3"> / {formatValue(target, "currency", { compact: true })}</span>
                  </div>
                </div>
              </>
            ) : (
              <p className="col-span-2 text-ink-3">Financial detail hidden for your role.</p>
            )}
            <div className="rounded-lg bg-surface-3/60 px-3 py-2">
              <div className="kicker">Net growth (month)</div>
              <div className="stat-figure text-xl font-bold">{formatValue(netGrowth?.value ?? null, "count")}</div>
            </div>
            <div className="rounded-lg bg-surface-3/60 px-3 py-2">
              <div className="kicker">New / canceled</div>
              <div className="stat-figure text-xl font-bold">
                {formatValue(newMembers?.value ?? null, "count")} / {formatValue(cancels?.value ?? null, "count")}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card className="print-block">
          <CardHeader kicker="Marketing" title="Marketing performance" />
          <CardBody className="space-y-2 text-sm">
            <p>
              Monthly plan: {mkStats?.done ?? 0} of {mkStats?.total ?? 0} actions done (fact).
            </p>
            {activeCampaign ? (
              <p>
                Active offer “{activeCampaign.name}”: {activeCampaign.leads_generated} leads,{" "}
                {activeCampaign.enrollments} enrollments,{" "}
                {formatValue(activeCampaign.revenue, "currency", { compact: true })} attributed (fact).
              </p>
            ) : (
              <p className="text-ink-3">No active deadline-driven campaign right now.</p>
            )}
          </CardBody>
        </Card>

        <Card className="print-block border-l-4 border-l-brand-600 lg:col-span-2">
          <CardHeader
            kicker="Suggested — derived from the data above"
            title="Five priorities for the coming week"
          />
          <CardBody>
            {topPriorities.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing urgent surfaced from the data. Keep executing the standard playbook.
              </p>
            ) : (
              <ol className="list-inside list-decimal space-y-2 text-sm">
                {topPriorities.map((p, i) => (
                  <li key={i}>
                    <span className="font-semibold">{p.title}</span>
                    <span className="block pl-5 text-xs text-ink-3">{p.why}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-[11px] text-ink-3">
              These are rule-based suggestions computed from current records — not
              generated guesses. Each cites the observation behind it.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
