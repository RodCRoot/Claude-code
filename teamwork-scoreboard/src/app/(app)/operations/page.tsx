import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  ensureTaskInstances,
  getTasksFor,
  getOverdueTasks,
  taskCompletionPct,
} from "@/lib/tasks";
import { todayStr, resolvePeriod } from "@/lib/periods";
import { addAdhocTask } from "@/app/actions/team";
import { TaskChecklist } from "@/components/task-checklist";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Progress,
  Button,
  Input,
  Select,
  Field,
} from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata = { title: "Operations Checklist" };

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const sp = await searchParams;
  ensureTaskInstances();

  const canComplete = me.permissions.includes("complete_tasks");
  const canManage = me.permissions.includes("manage_tasks");
  const today = todayStr();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const view = ["daily", "weekly", "monthly", "overdue"].includes(sp.view ?? "")
    ? (sp.view as string)
    : "daily";

  const all = getTasksFor(date).filter((t) => t.category === "operations");
  const bySub = (subs: string[]) => all.filter((t) => subs.includes(t.subcategory ?? ""));
  const dailyTasks = bySub(["daily"]);
  const weekPeriod = resolvePeriod("weekly", new Date(date + "T00:00:00"));
  const weeklyTasks = getOpenInRange("weekly", weekPeriod.start, weekPeriod.end);
  const monthPeriod = resolvePeriod("monthly", new Date(date + "T00:00:00"));
  const monthlyTasks = getOpenInRange("monthly", monthPeriod.start, monthPeriod.end);
  const overdue = getOverdueTasks().filter((t) => t.category === "operations");

  function getOpenInRange(sub: string, start: string, end: string) {
    // weekly/monthly instances are generated on their template day; show all in range
    const rows = [];
    for (const t of getAllInRange(start, end)) {
      if (t.subcategory === sub) rows.push(t);
    }
    return rows;
  }
  function getAllInRange(start: string, end: string) {
    const seen = new Map<number, ReturnType<typeof getTasksFor>[number]>();
    // sample each day (ranges are at most a month)
    const d = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (d <= endD) {
      for (const t of getTasksFor(d.toISOString().slice(0, 10))) {
        if (t.category === "operations") seen.set(t.id, t);
      }
      d.setDate(d.getDate() + 1);
    }
    return [...seen.values()];
  }

  const weekPct = taskCompletionPct("operations", weekPeriod.start, weekPeriod.end);

  const tabs = [
    { key: "daily", label: `Daily (${dailyTasks.filter((t) => t.status === "open").length} open)` },
    { key: "weekly", label: `Weekly (${weeklyTasks.filter((t) => t.status === "open").length})` },
    { key: "monthly", label: `Monthly (${monthlyTasks.filter((t) => t.status === "open").length})` },
    { key: "overdue", label: `Overdue (${overdue.length})` },
  ];

  const current =
    view === "daily" ? dailyTasks : view === "weekly" ? weeklyTasks : view === "monthly" ? monthlyTasks : overdue;

  return (
    <>
      <PageHeader
        kicker="Operations"
        title="Operating Checklist"
        subtitle="Recurring daily, weekly, and monthly tasks. Instances generate automatically from templates."
        actions={
          <div className="no-print flex items-center gap-2">
            <Badge variant={weekPct.pct !== null && weekPct.pct >= 90 ? "green" : "yellow"}>
              Week: {weekPct.pct === null ? "—" : `${Math.round(weekPct.pct)}%`} complete
            </Badge>
            {canManage && (
              <Link href="/admin/tasks" className="text-sm font-medium text-brand-600 hover:underline">
                Edit templates →
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-edge">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={`/operations?view=${t.key}&date=${date}`}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold",
                view === t.key ? "bg-brand-600 text-white" : "bg-surface-2 text-ink-2 hover:bg-surface-3"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        {view === "daily" && (
          <form method="get" action="/operations" className="flex items-center gap-2">
            <input type="hidden" name="view" value="daily" />
            <Input type="date" name="date" defaultValue={date} className="w-40" />
            <Button size="sm" variant="secondary" type="submit">Go</Button>
          </form>
        )}
      </div>

      <Card>
        <CardHeader
          kicker={view === "daily" ? date : view}
          title={
            view === "daily"
              ? "Daily operating tasks"
              : view === "weekly"
              ? `Weekly tasks — ${weekPeriod.label}`
              : view === "monthly"
              ? `Monthly tasks — ${monthPeriod.label}`
              : "Past-due tasks"
          }
        />
        <CardBody>
          <Progress
            pct={
              current.length
                ? (current.filter((t) => t.status === "done").length / current.length) * 100
                : null
            }
            className="mb-3"
          />
          <TaskChecklist tasks={current} showDue={view === "overdue"} canComplete={canComplete} />
        </CardBody>
      </Card>

      {canManage && (
        <Card className="mt-4">
          <CardHeader kicker="One-off" title="Add a task" />
          <CardBody>
            <form action={addAdhocTask} className="grid gap-3 sm:grid-cols-4">
              <Field label="Task">
                <Input name="title" required placeholder="e.g. Fix squat rack #2" />
              </Field>
              <Field label="Category">
                <Select name="category" defaultValue="operations">
                  <option value="operations">Operations</option>
                  <option value="cleaning">Cleaning</option>
                  <option value="marketing">Marketing</option>
                </Select>
              </Field>
              <Field label="Due date">
                <Input type="date" name="dueDate" defaultValue={today} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" className="w-full">Add task</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}
    </>
  );
}
