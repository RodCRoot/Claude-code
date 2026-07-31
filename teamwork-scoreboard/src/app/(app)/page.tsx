import Link from "next/link";
import { sql } from "drizzle-orm";
import { format } from "date-fns";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { getAttentionItems } from "@/lib/attention";
import { getAtRiskAthletes } from "@/lib/kpi";
import { getTasksFor, getOverdueTasks, facilityReadiness } from "@/lib/tasks";
import { todayStr } from "@/lib/periods";
import { formatValue } from "@/lib/calc";
import { completeTaskAction } from "@/app/actions/team";
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  ButtonLink,
  Button,
  Progress,
  PageHeader,
} from "@/components/ui";

export const metadata = { title: "Today" };

function count(q: ReturnType<typeof sql>): number {
  return db.get<{ v: number }>(q)?.v ?? 0;
}

export default async function TodayPage() {
  const user = await requireUser("view_dashboard");
  const canFinance = user.permissions.includes("view_financials");
  const now = new Date();
  const today = todayStr(now);
  const nowIso = now.toISOString();

  const activeAthletes = count(sql`SELECT COUNT(*) AS v FROM athletes WHERE status = 'active'`);
  const sessionsToday = db.all<{ id: number; time: string; name: string; capacity: number; coach: string | null; attended: number }>(sql`
    SELECT cs.id, cs.time, cs.name, cs.capacity, u.name AS coach,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id = cs.id AND a.status = 'attended') AS attended
    FROM class_sessions cs LEFT JOIN users u ON u.id = cs.coach_user_id
    WHERE cs.date = ${today} ORDER BY cs.time
  `);
  const attendanceToday = count(
    sql`SELECT COUNT(*) AS v FROM attendance WHERE date = ${today} AND status = 'attended'`
  );
  const uncontactedLeads = db.all<{ id: number; name: string; source: string; created_at: string }>(sql`
    SELECT id, name, source, created_at FROM leads
    WHERE first_contacted_at IS NULL AND stage NOT IN ('lost','member')
    ORDER BY created_at ASC LIMIT 8
  `);
  const apptsToConfirm = db.all<{ id: number; who: string; scheduled_at: string; type_key: string }>(sql`
    SELECT ap.id, COALESCE(l.name, a2.name, '—') AS who, ap.scheduled_at, ap.type_key
    FROM appointments ap
    LEFT JOIN leads l ON l.id = ap.lead_id
    LEFT JOIN athletes a2 ON a2.id = ap.athlete_id
    WHERE ap.status = 'scheduled' AND ap.confirmed = 0 AND ap.scheduled_at >= ${nowIso}
    ORDER BY ap.scheduled_at ASC LIMIT 8
  `);
  const onboardingDue = db.all<{ id: number; name: string; pending: number; start_date: string }>(sql`
    SELECT a.id, a.name, a.start_date, COUNT(*) AS pending
    FROM athlete_onboarding ao JOIN athletes a ON a.id = ao.athlete_id
    WHERE ao.status = 'pending' AND a.status = 'active'
    GROUP BY a.id ORDER BY a.start_date DESC LIMIT 8
  `);
  const atRisk = getAtRiskAthletes(now).filter((a) => !a.contactedInLast14).slice(0, 8);
  const failedPayments = canFinance
    ? db.all<{ id: number; who: string | null; amount: number; date: string }>(sql`
        SELECT p.id, a.name AS who, p.amount, p.date
        FROM payments p LEFT JOIN athletes a ON a.id = p.athlete_id
        WHERE p.status = 'failed' AND p.date >= date(${today}, '-30 days')
        ORDER BY p.date DESC LIMIT 8
      `)
    : [];
  const tasksToday = getTasksFor(today);
  const overdue = getOverdueTasks(now);
  const cleaning = facilityReadiness(now);
  const month = today.slice(0, 7);
  const marketingDue = db.all<{ id: number; pillar: string; name: string; status: string }>(sql`
    SELECT id, pillar, name, status FROM marketing_items
    WHERE month = ${month} AND status IN ('planned','in_progress')
    ORDER BY pillar, sort_order LIMIT 8
  `);
  const lastSync = db.get<{ name: string; last_sync_at: string | null; last_sync_status: string | null }>(sql`
    SELECT name, last_sync_at, last_sync_status FROM connectors
    WHERE last_sync_at IS NOT NULL ORDER BY last_sync_at DESC LIMIT 1
  `);
  const attention = getAttentionItems({ includeSensitive: canFinance }, now);

  const openTasksToday = tasksToday.filter((t) => t.status === "open");
  const myTasksToday = openTasksToday.filter(
    (t) => t.assignedUserId === user.id || t.assignedRole === user.roleName || (!t.assignedUserId && !t.assignedRole)
  );

  const tiles: { label: string; value: string; href: string; sub?: string }[] = [
    { label: "Active athletes", value: String(activeAthletes), href: "/athletes" },
    { label: "Sessions today", value: String(sessionsToday.length), href: "/scoreboard/sessions_delivered" },
    { label: "Check-ins today", value: String(attendanceToday), href: "/scoreboard/attendance_count" },
    { label: "Leads to contact", value: String(uncontactedLeads.length), href: "/leads?filter=uncontacted" },
    ...(canFinance
      ? [{ label: "Failed payments (30d)", value: String(failedPayments.length), href: "/scoreboard/failed_payments" }]
      : []),
    {
      label: "Facility readiness",
      value: cleaning.pct === null ? "—" : `${Math.round(cleaning.pct)}%`,
      href: "/facility",
      sub: `${cleaning.done}/${cleaning.total} cleaning tasks`,
    },
  ];

  return (
    <>
      <PageHeader
        kicker={format(now, "EEEE, MMMM d, yyyy")}
        title={`Today at Teamwork`}
        subtitle={`Welcome back, ${user.name.split(" ")[0]}. Here's where the business stands right now.`}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            <ButtonLink href="/leads#add" size="sm">+ Lead</ButtonLink>
            <ButtonLink href="/athletes#add" size="sm" variant="secondary">+ Athlete</ButtonLink>
            <ButtonLink href="/athletes?filter=at_risk" size="sm" variant="secondary">Log outreach</ButtonLink>
            <ButtonLink href="/team" size="sm" variant="secondary">Weekly score</ButtonLink>
            <ButtonLink href="/reports/new" size="sm" variant="secondary">5-15</ButtonLink>
            <ButtonLink href="/data" size="sm" variant="outline">Run sync</ButtonLink>
            <ButtonLink href="/data/import" size="sm" variant="outline">Import CSV</ButtonLink>
          </div>
        }
      />

      {/* What needs attention */}
      <Card className="mb-6 border-l-4 border-l-brand-600">
        <CardHeader
          kicker="Attention engine"
          title="What Needs Attention"
          action={
            <Badge variant={attention.length === 0 ? "green" : attention.some((a) => a.severity === "red") ? "red" : "yellow"}>
              {attention.length === 0 ? "All clear" : `${attention.length} item${attention.length > 1 ? "s" : ""}`}
            </Badge>
          }
        />
        <CardBody>
          {attention.length === 0 ? (
            <p className="text-sm text-ink-2">
              Nothing is on fire. Leads are being contacted, tasks are current, and no
              data sources report errors.
            </p>
          ) : (
            <ul className="divide-y divide-edge/60">
              {attention.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-start gap-3 py-2.5 hover:bg-surface-3/40"
                  >
                    <span
                      className={`mt-1 inline-block size-2.5 shrink-0 rounded-full ${
                        item.severity === "red" ? "bg-bad" : "bg-warn"
                      }`}
                    />
                    <span>
                      <span className="block text-sm font-medium">{item.title}</span>
                      <span className="block text-xs text-ink-3">{item.detail}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Stat tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href}>
            <Card className="h-full px-4 py-3 transition-colors hover:border-brand-600/50">
              <div className="kicker">{t.label}</div>
              <div className="stat-figure mt-1 text-3xl font-bold">{t.value}</div>
              {t.sub ? <div className="mt-0.5 text-xs text-ink-3">{t.sub}</div> : null}
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Today's sessions */}
        <Card>
          <CardHeader kicker="Schedule" title="Today's Sessions" />
          <CardBody>
            {sessionsToday.length === 0 ? (
              <p className="text-sm text-ink-3">No sessions scheduled today.</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {sessionsToday.map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-2">
                    <span>
                      <span className="font-semibold tabular-nums">{s.time}</span>{" "}
                      <span className="font-medium">{s.name}</span>
                      {s.coach ? <span className="text-ink-3"> · {s.coach}</span> : null}
                    </span>
                    <Badge variant={s.attended >= s.capacity * 0.7 ? "green" : "neutral"}>
                      {s.attended}/{s.capacity}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Tasks due today */}
        <Card>
          <CardHeader
            kicker="Checklists"
            title="Tasks Due Today"
            action={
              <div className="flex gap-2">
                {overdue.length > 0 ? (
                  <Link href="/operations?view=overdue">
                    <Badge variant="red">{overdue.length} overdue</Badge>
                  </Link>
                ) : null}
                <Badge variant="neutral">
                  {tasksToday.filter((t) => t.status === "done").length}/{tasksToday.length} done
                </Badge>
              </div>
            }
          />
          <CardBody>
            {myTasksToday.length === 0 ? (
              <p className="text-sm text-ink-3">
                Everything due today is complete. See <Link className="underline" href="/operations">Operations</Link> for the full checklist.
              </p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {myTasksToday.slice(0, 8).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      <span className="font-medium">{t.title}</span>
                      <span className="ml-2 text-xs uppercase tracking-wide text-ink-3">
                        {t.category}
                      </span>
                    </span>
                    <form action={completeTaskAction}>
                      <input type="hidden" name="taskId" value={t.id} />
                      <Button size="sm" variant="outline">Done</Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <Progress
                pct={tasksToday.length ? (tasksToday.filter((t) => t.status === "done").length / tasksToday.length) * 100 : null}
                status="none"
              />
            </div>
          </CardBody>
        </Card>

        {/* Leads requiring contact */}
        <Card>
          <CardHeader
            kicker="Demand"
            title="New Leads Requiring Contact"
            action={<ButtonLink href="/leads?filter=uncontacted" size="sm" variant="ghost">All →</ButtonLink>}
          />
          <CardBody>
            {uncontactedLeads.length === 0 ? (
              <p className="text-sm text-ink-3">Every lead has received first contact. 💪</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {uncontactedLeads.map((l) => (
                  <li key={l.id} className="flex items-center justify-between py-2">
                    <Link href={`/leads?lead=${l.id}`} className="font-medium hover:underline">
                      {l.name}
                    </Link>
                    <span className="text-xs text-ink-3">
                      {l.source} · {l.created_at.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Appointments to confirm */}
        <Card>
          <CardHeader kicker="Conversion" title="Appointments to Confirm" />
          <CardBody>
            {apptsToConfirm.length === 0 ? (
              <p className="text-sm text-ink-3">All upcoming appointments are confirmed.</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {apptsToConfirm.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <span className="font-medium">{a.who}</span>
                    <span className="text-xs text-ink-3">
                      {a.type_key.replace(/_/g, " ")} · {a.scheduled_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Onboarding */}
        <Card>
          <CardHeader
            kicker="Client experience"
            title="Athletes in Onboarding"
            action={<ButtonLink href="/onboarding" size="sm" variant="ghost">Pipeline →</ButtonLink>}
          />
          <CardBody>
            {onboardingDue.length === 0 ? (
              <p className="text-sm text-ink-3">No open onboarding steps.</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {onboardingDue.map((o) => (
                  <li key={o.id} className="flex items-center justify-between py-2">
                    <Link href={`/onboarding/${o.id}`} className="font-medium hover:underline">
                      {o.name}
                    </Link>
                    <Badge variant="yellow">{o.pending} steps left</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* At-risk outreach */}
        <Card>
          <CardHeader
            kicker="Retention"
            title="At-Risk Athletes Needing Outreach"
            action={<ButtonLink href="/athletes?filter=at_risk" size="sm" variant="ghost">All →</ButtonLink>}
          />
          <CardBody>
            {atRisk.length === 0 ? (
              <p className="text-sm text-ink-3">No at-risk athletes without recent outreach.</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {atRisk.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <Link href={`/athletes?athlete=${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <span className="text-xs text-ink-3">{a.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Failed payments (financial permission only) */}
        {canFinance && (
          <Card>
            <CardHeader kicker="Financial" title="Declined Payments Requiring Action" />
            <CardBody>
              {failedPayments.length === 0 ? (
                <p className="text-sm text-ink-3">No failed payments in the last 30 days.</p>
              ) : (
                <ul className="divide-y divide-edge/60 text-sm">
                  {failedPayments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-2">
                      <span className="font-medium">{p.who ?? "Unknown account"}</span>
                      <span className="text-xs text-ink-3">
                        {formatValue(p.amount, "currency")} · {p.date}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {/* Marketing due + sync status */}
        <Card>
          <CardHeader
            kicker="Marketing"
            title="Marketing Actions This Month"
            action={<ButtonLink href="/marketing" size="sm" variant="ghost">Plan →</ButtonLink>}
          />
          <CardBody>
            {marketingDue.length === 0 ? (
              <p className="text-sm text-ink-3">Every marketing action this month is done (or none planned).</p>
            ) : (
              <ul className="divide-y divide-edge/60 text-sm">
                {marketingDue.map((m) => (
                  <li key={m.id} className="flex items-center justify-between py-2">
                    <span className="font-medium">{m.name}</span>
                    <Badge variant={m.status === "in_progress" ? "yellow" : "neutral"}>
                      {m.pillar.replace(/_/g, " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex items-center justify-between rounded-lg bg-surface-3/60 px-3 py-2 text-xs">
              <span className="text-ink-2">
                Latest sync:{" "}
                {lastSync
                  ? `${lastSync.name} · ${lastSync.last_sync_at?.slice(0, 16).replace("T", " ")} (${lastSync.last_sync_status})`
                  : "no syncs recorded yet"}
              </span>
              <Link href="/data" className="font-semibold text-brand-600 hover:underline">
                Data & Sync →
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
