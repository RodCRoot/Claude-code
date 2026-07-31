import { and, eq, sql } from "drizzle-orm";
import { addDays, format, getDaysInMonth, getISODay } from "date-fns";
import { db } from "@/db";
import { taskTemplates, tasks } from "@/db/schema";
import { todayStr } from "./periods";
import { safePct } from "./calc";

/** Is a recurring template due on the given date? */
export function templateDueOn(
  t: {
    recurrence: string;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
  },
  date: Date
): boolean {
  const isoDay = getISODay(date); // 1 = Monday .. 7 = Sunday
  const dom = date.getDate();
  const dim = getDaysInMonth(date);
  const clamp = (d: number | null, fallback: number) =>
    Math.min(d ?? fallback, dim);
  switch (t.recurrence) {
    case "daily":
      return true;
    case "weekly":
      return isoDay === (t.dayOfWeek ?? 1);
    case "monthly":
      return dom === clamp(t.dayOfMonth, 1);
    case "quarterly":
      return [1, 4, 7, 10].includes(date.getMonth() + 1) && dom === clamp(t.dayOfMonth, 1);
    default:
      return false;
  }
}

/**
 * Idempotently create task instances for every active template due within the
 * last `catchUpDays` days through today. Uniqueness on (template_id, due_date)
 * makes this safe to call on every page load and from a cron endpoint.
 */
export function ensureTaskInstances(now: Date = new Date(), catchUpDays = 7): number {
  const templates = db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.active, 1))
    .all();
  let created = 0;
  const nowIso = now.toISOString();
  for (let i = catchUpDays; i >= 0; i--) {
    const date = addDays(now, -i);
    const dueDate = format(date, "yyyy-MM-dd");
    for (const t of templates) {
      if (!templateDueOn(t, date)) continue;
      const res = db
        .insert(tasks)
        .values({
          templateId: t.id,
          title: t.title,
          category: t.category,
          subcategory: t.subcategory,
          dueDate,
          assignedRole: t.assignedRole,
          assignedUserId: t.assignedUserId,
          requiresApproval: t.requiresApproval,
          createdAt: nowIso,
          demo: 0,
        })
        .onConflictDoNothing()
        .run();
      created += res.changes;
    }
  }
  return created;
}

export interface TaskRow {
  id: number;
  title: string;
  category: string;
  subcategory: string | null;
  dueDate: string;
  status: string;
  assignedRole: string | null;
  assignedUserId: number | null;
  assigneeName: string | null;
  completedAt: string | null;
  completedLate: number;
  requiresApproval: number;
  proofNote: string | null;
}

export function getTasksFor(dueDate: string, category?: string): TaskRow[] {
  return db.all<TaskRow>(sql`
    SELECT t.id, t.title, t.category, t.subcategory, t.due_date AS dueDate,
           t.status, t.assigned_role AS assignedRole, t.assigned_user_id AS assignedUserId,
           u.name AS assigneeName, t.completed_at AS completedAt,
           t.completed_late AS completedLate, t.requires_approval AS requiresApproval,
           t.proof_note AS proofNote
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_user_id
    WHERE t.due_date = ${dueDate}
      ${category ? sql`AND t.category = ${category}` : sql``}
    ORDER BY t.category, t.subcategory, t.id
  `);
}

export function getOverdueTasks(now: Date = new Date()): TaskRow[] {
  const today = todayStr(now);
  return db.all<TaskRow>(sql`
    SELECT t.id, t.title, t.category, t.subcategory, t.due_date AS dueDate,
           t.status, t.assigned_role AS assignedRole, t.assigned_user_id AS assignedUserId,
           u.name AS assigneeName, t.completed_at AS completedAt,
           t.completed_late AS completedLate, t.requires_approval AS requiresApproval,
           t.proof_note AS proofNote
    FROM tasks t LEFT JOIN users u ON u.id = t.assigned_user_id
    WHERE t.status = 'open' AND t.due_date < ${today}
    ORDER BY t.due_date ASC LIMIT 100
  `);
}

export function completeTask(
  taskId: number,
  userId: number,
  proofNote?: string,
  proofUrl?: string
): void {
  const t = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!t) return;
  const now = new Date();
  const late = format(now, "yyyy-MM-dd") > t.dueDate ? 1 : 0;
  db.update(tasks)
    .set({
      status: "done",
      completedAt: now.toISOString(),
      completedByUserId: userId,
      completedLate: late,
      proofNote: proofNote || t.proofNote,
      proofUrl: proofUrl || t.proofUrl,
    })
    .where(eq(tasks.id, taskId))
    .run();
}

export function reopenTask(taskId: number): void {
  db.update(tasks)
    .set({ status: "open", completedAt: null, completedByUserId: null, completedLate: 0 })
    .where(and(eq(tasks.id, taskId)))
    .run();
}

/** Completion % of cleaning tasks due today (facility readiness). */
export function facilityReadiness(now: Date = new Date()): {
  pct: number | null;
  done: number;
  total: number;
} {
  const today = todayStr(now);
  const row = db.get<{ total: number; done: number }>(sql`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks WHERE category = 'cleaning' AND due_date = ${today}
  `);
  const total = row?.total ?? 0;
  const done = row?.done ?? 0;
  return { pct: safePct(done, total), done, total };
}

/** Completion % for a category and date range. */
export function taskCompletionPct(
  category: string,
  start: string,
  end: string
): { pct: number | null; done: number; total: number } {
  const row = db.get<{ total: number; done: number }>(sql`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks WHERE category = ${category}
      AND due_date >= ${start} AND due_date <= ${end}
  `);
  const total = row?.total ?? 0;
  const done = row?.done ?? 0;
  return { pct: safePct(done, total), done, total };
}
