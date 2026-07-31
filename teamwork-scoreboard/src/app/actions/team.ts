"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  scorecardEntries,
  scorecardWeeks,
  reports515,
  reportComments,
  kpiValues,
  metrics,
  tasks,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { completeTask, reopenTask } from "@/lib/tasks";
import { weekStartOf } from "@/lib/periods";

const now = () => new Date().toISOString();
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const int = (fd: FormData, k: string) => {
  const n = parseInt(str(fd, k), 10);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------- Weekly scorecard ------------------------- */

export async function saveScorecardWeek(formData: FormData) {
  const user = await requireUser("submit_scorecard");
  const targetUserId = int(formData, "userId") ?? user.id;
  // Only managers may enter numbers for someone else.
  if (targetUserId !== user.id && !user.permissions.includes("view_all_scorecards")) {
    return;
  }
  const weekStart = weekStartOf(str(formData, "weekStart") || now().slice(0, 10));
  const submit = formData.get("submit") === "1";

  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("metric_")) continue;
    const metricId = parseInt(key.slice(7), 10);
    const value = parseFloat(String(raw));
    if (!Number.isFinite(metricId)) continue;
    if (String(raw).trim() === "" || !Number.isFinite(value)) continue;
    db.insert(scorecardEntries)
      .values({
        scorecardMetricId: metricId,
        userId: targetUserId,
        weekStart,
        value,
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: [
          scorecardEntries.scorecardMetricId,
          scorecardEntries.userId,
          scorecardEntries.weekStart,
        ],
        set: { value, createdAt: now() },
      })
      .run();
  }

  const staffNote = str(formData, "staffNote");
  const existing = db
    .select()
    .from(scorecardWeeks)
    .where(
      and(eq(scorecardWeeks.userId, targetUserId), eq(scorecardWeeks.weekStart, weekStart))
    )
    .get();
  if (existing) {
    db.update(scorecardWeeks)
      .set({
        staffNote: staffNote || existing.staffNote,
        submittedAt: submit ? now() : existing.submittedAt,
      })
      .where(eq(scorecardWeeks.id, existing.id))
      .run();
  } else {
    db.insert(scorecardWeeks)
      .values({
        userId: targetUserId,
        weekStart,
        staffNote: staffNote || null,
        submittedAt: submit ? now() : null,
      })
      .run();
  }
  revalidatePath("/team");
  revalidatePath("/");
  // Submitting the weekly scoreboard prompts the 5-15 report.
  if (submit && targetUserId === user.id) {
    redirect(`/reports/new?week=${weekStart}&from=scorecard`);
  }
}

export async function ownerCommentScorecard(formData: FormData) {
  await requireUser("review_reports");
  const userId = int(formData, "userId");
  const weekStart = str(formData, "weekStart");
  const comment = str(formData, "ownerComment");
  if (!userId || !weekStart) return;
  const existing = db
    .select()
    .from(scorecardWeeks)
    .where(and(eq(scorecardWeeks.userId, userId), eq(scorecardWeeks.weekStart, weekStart)))
    .get();
  if (existing) {
    db.update(scorecardWeeks)
      .set({ ownerComment: comment })
      .where(eq(scorecardWeeks.id, existing.id))
      .run();
  } else {
    db.insert(scorecardWeeks)
      .values({ userId, weekStart, ownerComment: comment })
      .run();
  }
  revalidatePath("/team");
}

/* ----------------------------- 5-15 ----------------------------- */

export async function save515(formData: FormData) {
  const user = await requireUser("submit_scorecard");
  const weekStart = weekStartOf(str(formData, "weekStart") || now().slice(0, 10));
  const fields = {
    rating: int(formData, "rating"),
    wins: str(formData, "wins") || null,
    kpiWins: str(formData, "kpiWins") || null,
    commitmentsCompleted: str(formData, "commitmentsCompleted") || null,
    commitmentsMissed: str(formData, "commitmentsMissed") || null,
    challenges: str(formData, "challenges") || null,
    clientConcerns: str(formData, "clientConcerns") || null,
    facilityConcerns: str(formData, "facilityConcerns") || null,
    helpNeeded: str(formData, "helpNeeded") || null,
    nextPriorities: str(formData, "nextPriorities") || null,
    submittedAt: now(),
  };
  const existing = db
    .select()
    .from(reports515)
    .where(and(eq(reports515.userId, user.id), eq(reports515.weekStart, weekStart)))
    .get();
  if (existing) {
    db.update(reports515).set(fields).where(eq(reports515.id, existing.id)).run();
  } else {
    db.insert(reports515)
      .values({ userId: user.id, weekStart, ...fields })
      .run();
  }
  revalidatePath("/reports");
  revalidatePath("/");
}

export async function review515(formData: FormData) {
  await requireUser("review_reports");
  const id = int(formData, "reportId");
  if (!id) return;
  db.update(reports515)
    .set({
      managerResponse: str(formData, "managerResponse") || null,
      followUpActions: str(formData, "followUpActions") || null,
      managerStatus: "reviewed",
    })
    .where(eq(reports515.id, id))
    .run();
  revalidatePath("/reports");
}

export async function comment515(formData: FormData) {
  const user = await requireUser("submit_scorecard");
  const reportId = int(formData, "reportId");
  const body = str(formData, "body");
  if (!reportId || !body) return;
  db.insert(reportComments)
    .values({ reportId, userId: user.id, body, createdAt: now() })
    .run();
  revalidatePath("/reports");
}

/* ----------------------------- Tasks ----------------------------- */

export async function completeTaskAction(formData: FormData) {
  const user = await requireUser("complete_tasks");
  const id = int(formData, "taskId");
  if (!id) return;
  completeTask(id, user.id, str(formData, "proofNote") || undefined, str(formData, "proofUrl") || undefined);
  revalidatePath("/operations");
  revalidatePath("/facility");
  revalidatePath("/");
}

export async function reopenTaskAction(formData: FormData) {
  await requireUser("complete_tasks");
  const id = int(formData, "taskId");
  if (!id) return;
  reopenTask(id);
  revalidatePath("/operations");
  revalidatePath("/facility");
  revalidatePath("/");
}

export async function approveTaskAction(formData: FormData) {
  const user = await requireUser("manage_tasks");
  const id = int(formData, "taskId");
  if (!id) return;
  db.update(tasks).set({ approvedByUserId: user.id }).where(eq(tasks.id, id)).run();
  revalidatePath("/operations");
}

export async function addAdhocTask(formData: FormData) {
  const user = await requireUser("manage_tasks");
  const title = str(formData, "title");
  if (!title) return;
  db.insert(tasks)
    .values({
      title,
      category: str(formData, "category") || "operations",
      subcategory: str(formData, "subcategory") || null,
      dueDate: str(formData, "dueDate") || now().slice(0, 10),
      assignedUserId: int(formData, "assignedUserId"),
      createdAt: now(),
    })
    .run();
  void user;
  revalidatePath("/operations");
  revalidatePath("/");
}

/* ------------------------- Manual KPI entry ------------------------- */

export async function addKpiValue(formData: FormData) {
  const user = await requireUser("override_values");
  const metricKey = str(formData, "metricKey");
  const value = parseFloat(str(formData, "value"));
  const periodStart = str(formData, "periodStart");
  const periodEnd = str(formData, "periodEnd") || periodStart;
  if (!metricKey || !Number.isFinite(value) || !periodStart) return;
  const metric = db.select().from(metrics).where(eq(metrics.key, metricKey)).get();
  if (!metric) return;
  db.insert(kpiValues)
    .values({
      metricId: metric.id,
      periodStart,
      periodEnd,
      value,
      source: "manual",
      enteredByUserId: user.id,
      sourceNote: str(formData, "sourceNote") || null,
      overrideReason: str(formData, "overrideReason") || null,
      createdAt: now(),
    })
    .run();
  revalidatePath("/scoreboard");
  revalidatePath(`/scoreboard/${metricKey}`);
  revalidatePath("/");
}
