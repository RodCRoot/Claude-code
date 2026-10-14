import Link from "next/link";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { people, tasks, users } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { PeopleTabs } from "@/components/people-tabs";
import { fmt } from "@/lib/time";
import { createTaskAction, setTaskStatusAction } from "../actions";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ who?: string; status?: string }> }) {
  const v = await requireStaff();
  const sp = await searchParams;
  // Coaches only see their own tasks.
  const who = v.role === "coach" ? "me" : sp.who ?? "me";
  const status = sp.status === "done" ? ["done"] : ["open", "in_progress"];
  const rows = await db
    .select({ t: tasks, assignee: users.displayName, pFirst: people.firstName, pLast: people.lastName })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeUserId))
    .leftJoin(people, eq(people.id, tasks.relatedPersonId))
    .where(
      and(
        eq(tasks.orgId, v.orgId),
        inArray(tasks.status, status as ("open" | "done")[]),
        who === "me" ? eq(tasks.assigneeUserId, v.userId) : who === "unassigned" ? sql`${tasks.assigneeUserId} is null` : sql`true`,
      ),
    )
    .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt))
    .limit(200);
  const staffUsers = await db.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]))).orderBy(asc(users.displayName));
  const now = new Date();
  const filters = v.role === "coach" ? [["me", "Mine"]] : [["me", "Mine"], ["all", "Everyone"], ["unassigned", "Unassigned"]];

  return (
    <>
      <PageHeader kicker="People" title="Tasks & follow-ups" description="Manual tasks plus those created by automations, body-map reviews, and imports." />
      <PeopleTabs current="tasks" showLeads={can(v, "crm.manage")} showRequests={can(v, "people.manage") || can(v, "crm.manage")} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={sp.status === "done" ? "Completed" : "Open"}
            action={
              <nav aria-label="Task filters" className="flex flex-wrap gap-2 text-sm">
                {filters.map(([k, label]) => (
                  <Link key={k} href={`/people/tasks?who=${k}${sp.status ? `&status=${sp.status}` : ""}`} aria-current={who === k ? "true" : undefined} className={`rounded-full border px-3 py-1 ${who === k ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}>
                    {label}
                  </Link>
                ))}
                <Link href={`/people/tasks?who=${who}${sp.status === "done" ? "" : "&status=done"}`} className="rounded-full border border-edge px-3 py-1">
                  {sp.status === "done" ? "Show open" : "Show completed"}
                </Link>
              </nav>
            }
          />
          <CardBody>
            {rows.length === 0 ? (
              <EmptyState title="Nothing to do here">No tasks match this filter.</EmptyState>
            ) : (
              <Table caption="Tasks">
                <thead>
                  <tr>
                    <Th>Task</Th>
                    <Th>About</Th>
                    <Th>Assignee</Th>
                    <Th>Due</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ t, assignee, pFirst, pLast }) => (
                    <tr key={t.id}>
                      <Td>
                        <div className="font-medium">{t.title}</div>
                        <div className="flex gap-1 text-xs text-ink-3">
                          {t.source !== "manual" ? <Badge>{t.source}</Badge> : null}
                          {t.priority === "high" ? <Badge variant="red">high</Badge> : null}
                        </div>
                      </Td>
                      <Td>{t.relatedPersonId ? <Link className="hover:underline" href={`/people/${t.relatedPersonId}`}>{`${pFirst} ${pLast}`}</Link> : "—"}</Td>
                      <Td>{assignee ?? "Unassigned"}</Td>
                      <Td className={t.dueAt && t.dueAt < now && t.status !== "done" ? "font-medium text-bad" : ""}>{t.dueAt ? fmt(t.dueAt, "MMM d, h:mm a") : "—"}</Td>
                      <Td align="right">
                        {t.status !== "done" ? (
                          <form action={setTaskStatusAction}>
                            <input type="hidden" name="taskId" value={t.id} />
                            <input type="hidden" name="status" value="done" />
                            <button className="min-h-9 rounded-lg border border-edge px-3 text-xs font-medium hover:bg-surface-2" type="submit">
                              Done
                            </button>
                          </form>
                        ) : (
                          <span className="text-xs text-ink-3">{t.completedAt ? fmt(t.completedAt, "MMM d") : ""}</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="New task" />
          <CardBody>
            <ActionForm action={createTaskAction} className="space-y-3" resetOnSuccess>
              <Field label="Title" htmlFor="nt-title">
                <Input id="nt-title" name="title" required />
              </Field>
              <Field label="Details" htmlFor="nt-desc">
                <Input id="nt-desc" name="description" />
              </Field>
              <Field label="Due" htmlFor="nt-due">
                <Input id="nt-due" name="dueAt" type="datetime-local" />
              </Field>
              <Field label="Assign to" htmlFor="nt-assignee">
                <Select id="nt-assignee" name="assigneeUserId" defaultValue={v.userId} disabled={v.role === "coach"}>
                  {staffUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority" htmlFor="nt-priority">
                <Select id="nt-priority" name="priority" defaultValue="normal">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </Select>
              </Field>
              <SubmitButton size="sm">Create task</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
