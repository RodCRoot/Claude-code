import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { todayStr } from "@/lib/periods";
import {
  PageHeader,
  Card,
  CardBody,
  Badge,
  Progress,
  Table,
} from "@/components/ui";

export const metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  await requireUser("view_dashboard");
  const today = todayStr();

  const rows = db.all<{
    id: number;
    name: string;
    guardian: string | null;
    start_date: string;
    program: string | null;
    lead_source: string | null;
    staff: string | null;
    total: number;
    done: number;
    overdue: number;
  }>(sql`
    SELECT a.id, a.name, a.guardian_name AS guardian, a.start_date, a.program,
      a.lead_source, u.name AS staff,
      COUNT(CASE WHEN ao.status != 'na' THEN 1 END) AS total,
      COUNT(CASE WHEN ao.status = 'done' THEN 1 END) AS done,
      COUNT(CASE WHEN ao.status = 'pending'
        AND date(a.start_date, '+' || os.due_offset_days || ' days') < ${today} THEN 1 END) AS overdue
    FROM athletes a
    JOIN athlete_onboarding ao ON ao.athlete_id = a.id
    JOIN onboarding_steps os ON os.id = ao.step_id
    LEFT JOIN users u ON u.id = a.assigned_user_id
    WHERE a.status = 'active'
    GROUP BY a.id
    HAVING COUNT(CASE WHEN ao.status = 'pending' THEN 1 END) > 0
       OR a.start_date > date(${today}, '-30 days')
    ORDER BY a.start_date DESC
  `);

  const inProgress = rows.filter((r) => r.done < r.total);
  const complete = rows.filter((r) => r.done >= r.total && r.total > 0);
  const avgPct =
    rows.length > 0
      ? Math.round(
          (rows.reduce((a, r) => a + (r.total ? r.done / r.total : 0), 0) / rows.length) * 100
        )
      : null;

  return (
    <>
      <PageHeader
        kicker="New-athlete onboarding"
        title="Onboarding Pipeline"
        subtitle="Every new athlete works through the same welcome checklist. Edit the steps in Admin → Onboarding Steps."
        actions={
          <div className="flex gap-2">
            <Badge variant="neutral">{inProgress.length} in progress</Badge>
            <Badge variant={avgPct !== null && avgPct >= 90 ? "green" : "yellow"}>
              {avgPct === null ? "—" : `${avgPct}% avg completion`}
            </Badge>
          </div>
        }
      />

      <Card>
        <CardBody className="pt-4">
          <Table
            columns={[
              "Athlete",
              "Parent/guardian",
              "Started",
              "Days in",
              "Program",
              "Owner",
              "Progress",
              "Status",
            ]}
            rows={[...inProgress, ...complete].map((r) => {
              const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
              const daysIn = Math.floor(
                (new Date(today).getTime() - new Date(r.start_date).getTime()) / 86400000
              );
              return [
                <Link key="n" href={`/onboarding/${r.id}`} className="font-semibold text-brand-600 hover:underline">
                  {r.name}
                </Link>,
                r.guardian ?? "—",
                r.start_date,
                daysIn,
                r.program ?? "—",
                r.staff ?? "unassigned",
                <div key="p" className="w-32">
                  <Progress pct={pct} status={pct === 100 ? "green" : r.overdue > 0 ? "red" : "yellow"} />
                  <span className="text-[11px] text-ink-3">
                    {r.done}/{r.total} steps
                  </span>
                </div>,
                pct === 100 ? (
                  <Badge key="s" variant="green">Fully onboarded</Badge>
                ) : r.overdue > 0 ? (
                  <Badge key="s" variant="red">{r.overdue} overdue</Badge>
                ) : (
                  <Badge key="s" variant="yellow">In progress</Badge>
                ),
              ];
            })}
            empty="No athletes currently in onboarding. New athletes appear here automatically."
          />
        </CardBody>
      </Card>
    </>
  );
}
