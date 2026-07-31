import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { todayStr } from "@/lib/periods";
import { toggleOnboardingStep } from "@/app/actions/crm";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Progress,
  Button,
} from "@/components/ui";

export default async function AthleteOnboardingPage({
  params,
}: {
  params: Promise<{ athleteId: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const canEdit = me.permissions.includes("edit_records");
  const { athleteId: raw } = await params;
  const athleteId = parseInt(raw, 10);
  if (!Number.isFinite(athleteId)) notFound();

  const athlete = db.get<{
    id: number;
    name: string;
    guardian_name: string | null;
    start_date: string;
    program: string | null;
    lead_source: string | null;
    staff: string | null;
  }>(sql`
    SELECT a.id, a.name, a.guardian_name, a.start_date, a.program, a.lead_source,
      u.name AS staff
    FROM athletes a LEFT JOIN users u ON u.id = a.assigned_user_id
    WHERE a.id = ${athleteId}
  `);
  if (!athlete) notFound();

  const steps = db.all<{
    step_id: number;
    name: string;
    description: string | null;
    due_offset_days: number;
    status: string;
    completed_at: string | null;
    completed_by: string | null;
    sort_order: number;
  }>(sql`
    SELECT os.id AS step_id, os.name, os.description, os.due_offset_days,
      COALESCE(ao.status, 'pending') AS status, ao.completed_at,
      u.name AS completed_by, os.sort_order
    FROM onboarding_steps os
    LEFT JOIN athlete_onboarding ao
      ON ao.step_id = os.id AND ao.athlete_id = ${athleteId}
    LEFT JOIN users u ON u.id = ao.completed_by_user_id
    WHERE os.active = 1
    ORDER BY os.sort_order, os.id
  `);

  const today = todayStr();
  const required = steps.filter((s) => s.status !== "na");
  const done = required.filter((s) => s.status === "done");
  const pct = required.length ? Math.round((done.length / required.length) * 100) : 0;
  const daysIn = Math.floor(
    (new Date(today).getTime() - new Date(athlete.start_date).getTime()) / 86400000
  );

  return (
    <>
      <PageHeader
        kicker="Onboarding"
        title={athlete.name}
        subtitle={`${athlete.guardian_name ? `Parent: ${athlete.guardian_name} · ` : ""}Started ${athlete.start_date} (${daysIn} days ago) · ${athlete.program ?? "no program"} · Owner: ${athlete.staff ?? "unassigned"}`}
        actions={
          <div className="flex items-center gap-2">
            {pct === 100 ? (
              <Badge variant="green">Fully onboarded</Badge>
            ) : (
              <Badge variant="yellow">{required.length - done.length} steps left</Badge>
            )}
            <Link href="/onboarding" className="text-sm font-medium text-brand-600 hover:underline">
              ← Pipeline
            </Link>
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <div className="flex items-center gap-3">
          <span className="stat-figure text-3xl font-bold">{pct}%</span>
          <div className="flex-1">
            <Progress pct={pct} status={pct === 100 ? "green" : "yellow"} />
            <p className="mt-1 text-xs text-ink-3">
              {done.length} of {required.length} required steps complete
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader kicker="Checklist" title="Onboarding steps" />
        <CardBody>
          <ul className="divide-y divide-edge/60">
            {steps.map((s) => {
              const dueDate = new Date(
                new Date(athlete.start_date + "T00:00:00").getTime() +
                  s.due_offset_days * 86400000
              )
                .toISOString()
                .slice(0, 10);
              const overdue = s.status === "pending" && dueDate < today;
              return (
                <li key={s.step_id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <form action={toggleOnboardingStep} className="flex flex-1 items-center gap-3">
                    <input type="hidden" name="athleteId" value={athleteId} />
                    <input type="hidden" name="stepId" value={s.step_id} />
                    {canEdit ? (
                      <Button
                        variant={s.status === "done" ? "secondary" : "outline"}
                        size="sm"
                        className="size-7 shrink-0 rounded-md p-0"
                        title={s.status === "done" ? "Mark pending" : "Mark done"}
                        name="target"
                        value={s.status === "done" ? "pending" : "done"}
                      >
                        {s.status === "done" ? "✓" : ""}
                      </Button>
                    ) : (
                      <span className="inline-flex size-7 items-center justify-center rounded-md border border-edge text-xs">
                        {s.status === "done" ? "✓" : ""}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          s.status === "done"
                            ? "text-sm text-ink-3 line-through"
                            : s.status === "na"
                            ? "text-sm text-ink-3 italic"
                            : "text-sm font-medium"
                        }
                      >
                        {s.name}
                      </span>
                      {s.description ? (
                        <span className="block text-xs text-ink-3">{s.description}</span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {s.status === "na" && <Badge variant="neutral">N/A</Badge>}
                      {overdue && <Badge variant="red">due {dueDate}</Badge>}
                      {s.status === "done" && s.completed_at ? (
                        <span className="text-[11px] text-ink-3">
                          {s.completed_by ?? ""} · {s.completed_at.slice(0, 10)}
                        </span>
                      ) : null}
                      {canEdit && s.status !== "na" && s.status !== "done" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          name="target"
                          value="na"
                        >
                          N/A
                        </Button>
                      ) : null}
                    </span>
                  </form>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
