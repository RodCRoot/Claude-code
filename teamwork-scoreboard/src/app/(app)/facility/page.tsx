import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  ensureTaskInstances,
  getTasksFor,
  facilityReadiness,
  taskCompletionPct,
} from "@/lib/tasks";
import { todayStr, resolvePeriod } from "@/lib/periods";
import { TaskChecklist } from "@/components/task-checklist";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Progress,
  Badge,
} from "@/components/ui";

export const metadata = { title: "Facility Readiness" };

export default async function FacilityPage() {
  const me = await requireUser("view_dashboard");
  ensureTaskInstances();
  const canComplete = me.permissions.includes("complete_tasks");
  const today = todayStr();
  const now = new Date();

  const todayCleaning = getTasksFor(today, "cleaning");
  const opening = todayCleaning.filter((t) => t.subcategory === "opening");
  const during = todayCleaning.filter((t) => t.subcategory === "daily");
  const closing = todayCleaning.filter((t) => t.subcategory === "closing");

  const week = resolvePeriod("weekly", now);
  const month = resolvePeriod("monthly", now);
  const weeklyCleaning = collectRange(week.start, week.end, "weekly");
  const monthlyCleaning = collectRange(month.start, month.end, "monthly");

  function collectRange(start: string, end: string, sub: string) {
    const seen = new Map<number, ReturnType<typeof getTasksFor>[number]>();
    const d = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (d <= endD) {
      for (const t of getTasksFor(d.toISOString().slice(0, 10), "cleaning")) {
        if (t.subcategory === sub) seen.set(t.id, t);
      }
      d.setDate(d.getDate() + 1);
    }
    return [...seen.values()];
  }

  const readiness = facilityReadiness(now);
  const weekPct = taskCompletionPct("cleaning", week.start, week.end);

  const sections: { title: string; kicker: string; tasks: typeof todayCleaning }[] = [
    { title: "Opening checklist", kicker: "Today", tasks: opening },
    { title: "Daily cleaning", kicker: "Today", tasks: during },
    { title: "Closing checklist", kicker: "Today", tasks: closing },
    { title: "Weekly deep clean", kicker: week.label, tasks: weeklyCleaning },
    { title: "Monthly facility & equipment", kicker: month.label, tasks: monthlyCleaning },
  ];

  return (
    <>
      <PageHeader
        kicker="Facility"
        title="Cleaning & Facility Readiness"
        subtitle="A clean, ready floor is part of the product. Optional proof notes/photo links on every item."
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={
                readiness.pct === null ? "neutral" : readiness.pct >= 90 ? "green" : readiness.pct >= 60 ? "yellow" : "red"
              }
            >
              Today: {readiness.pct === null ? "no tasks" : `${Math.round(readiness.pct)}% ready`}
            </Badge>
            <Badge variant="neutral">
              Week: {weekPct.pct === null ? "—" : `${Math.round(weekPct.pct)}%`}
            </Badge>
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <div className="kicker mb-1">Facility readiness today</div>
        <div className="flex items-center gap-3">
          <span className="stat-figure text-3xl font-bold">
            {readiness.pct === null ? "—" : `${Math.round(readiness.pct)}%`}
          </span>
          <div className="flex-1">
            <Progress
              pct={readiness.pct}
              status={
                readiness.pct === null ? "none" : readiness.pct >= 90 ? "green" : readiness.pct >= 60 ? "yellow" : "red"
              }
            />
            <p className="mt-1 text-xs text-ink-3">
              {readiness.done} of {readiness.total} cleaning tasks complete today
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((s) => (
          <Card key={s.title} className={s.title.includes("Monthly") ? "lg:col-span-2" : undefined}>
            <CardHeader
              kicker={s.kicker}
              title={s.title}
              action={
                <Badge variant="neutral">
                  {s.tasks.filter((t) => t.status === "done").length}/{s.tasks.length}
                </Badge>
              }
            />
            <CardBody>
              <TaskChecklist tasks={s.tasks} canComplete={canComplete} />
            </CardBody>
          </Card>
        ))}
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Edit the cleaning templates (items, days, assignments) in{" "}
        <Link href="/admin/tasks" className="underline">Admin → Task Templates</Link>.
      </p>
    </>
  );
}
