import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, bodyRegionReports, tasks } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, AuthzError, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { actorOf, responsibleCoach, scienceSettings, scopedAthletes } from "./access";
import { isValidSpot, needsReview } from "./body-regions";

export const bodyReportInput = z.object({
  athleteId: z.string().uuid(),
  view: z.enum(["front", "back"]),
  region: z.string().min(1).max(40),
  side: z.enum(["left", "right", "center"]),
  kind: z.enum(["soreness", "pain"]),
  severity: z.coerce.number().int().min(0, "0–10").max(10, "0–10"),
  note: z.string().trim().max(500).optional().nullable(),
});

/**
 * Record a self-reported soreness/pain spot. Pain (any severity) or soreness at/above the
 * configured threshold creates ONE coach review task (dedupe key per report).
 */
export async function submitBodyReport(tx: Tx, v: Viewer, raw: z.input<typeof bodyReportInput>, now = new Date()) {
  const input = bodyReportInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "health.write");
  if (!isValidSpot(input.view, input.region, input.side)) throw new UserError("That body region/side combination isn't valid for this view.", { region: "Invalid region" });
  const settings = await scienceSettings(tx, v.orgId);
  const [report] = await tx
    .insert(bodyRegionReports)
    .values({ orgId: v.orgId, athleteId: input.athleteId, view: input.view, region: input.region, side: input.side, kind: input.kind, severity: input.severity, note: input.note || null, reportedAt: now, reportedBy: v.userId })
    .returning();
  let taskId: string | null = null;
  if (needsReview(input.kind, input.severity, settings.sorenessReviewThreshold)) {
    const assignee = await responsibleCoach(tx, v.orgId, input.athleteId);
    const [t] = await tx
      .insert(tasks)
      .values({
        orgId: v.orgId,
        // Tasks are visible to all staff (incl. operations, who lack health access), so the
        // title/description stay generic; the details live behind health.review in the queue.
        title: "Review a body-map self-report",
        description: "Open Sports Science → Body map review queue. Self-reported, not a diagnosis.",
        relatedPersonId: (await tx.select({ p: athletes.personId }).from(athletes).where(eq(athletes.id, input.athleteId)))[0]?.p ?? null,
        assigneeUserId: assignee,
        relatedType: "body_region_report",
        relatedId: report.id,
        priority: input.kind === "pain" || input.severity >= 8 ? "high" : "normal",
        source: "science.body_map",
        dedupeKey: `body_review:${report.id}`,
        createdBy: v.userId,
      })
      .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
      .returning({ id: tasks.id });
    taskId = t?.id ?? null;
    if (taskId) await tx.update(bodyRegionReports).set({ reviewTaskId: taskId }).where(eq(bodyRegionReports.id, report.id));
  } else {
    // Below threshold soreness doesn't need review; mark it so it never sits in the queue.
    await tx.update(bodyRegionReports).set({ reviewStatus: "reviewed", reviewNote: "Below review threshold (auto)" }).where(eq(bodyRegionReports.id, report.id));
  }
  await audit(tx, actorOf(v), "science.body_report.create", "body_region_report", report.id, { summary: `Body map ${input.kind} report${taskId ? " → review task" : ""}` });
  return { id: report.id, taskId };
}

export async function bodyHistory(tx: Tx, v: Viewer, athleteId: string, sinceDays = 90, now = new Date()) {
  await requireOnAthlete(tx, v, athleteId, "health.read");
  return tx
    .select()
    .from(bodyRegionReports)
    .where(and(eq(bodyRegionReports.athleteId, athleteId), eq(bodyRegionReports.orgId, v.orgId), gte(bodyRegionReports.reportedAt, new Date(now.getTime() - sinceDays * 86_400_000))))
    .orderBy(desc(bodyRegionReports.reportedAt));
}

/** Open review items (new / follow-up) for athletes the viewer can review. */
export async function reviewQueue(tx: Tx, v: Viewer) {
  const ids = await accessibleAthleteIds(tx, v, "health.review");
  if (ids !== "all" && !ids.length) return [];
  const rows = await tx
    .select()
    .from(bodyRegionReports)
    .where(and(eq(bodyRegionReports.orgId, v.orgId), athleteScopeFilter(ids, bodyRegionReports.athleteId), inArray(bodyRegionReports.reviewStatus, ["new", "follow_up"])))
    .orderBy(desc(bodyRegionReports.reportedAt));
  const names = new Map((await scopedAthletes(tx, v, "health.review", { includeInactive: true })).map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, athleteName: names.get(r.athleteId) ?? "Athlete" }));
}

/** Exported for dashboards. */
export async function reviewQueueCount(tx: Tx, v: Viewer): Promise<number> {
  const ids = await accessibleAthleteIds(tx, v, "health.review");
  if (ids !== "all" && !ids.length) return 0;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bodyRegionReports)
    .where(and(eq(bodyRegionReports.orgId, v.orgId), athleteScopeFilter(ids, bodyRegionReports.athleteId), inArray(bodyRegionReports.reviewStatus, ["new", "follow_up"])));
  return r?.n ?? 0;
}

export const reviewInput = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["reviewed", "follow_up", "referred_out"]),
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function reviewBodyReport(tx: Tx, v: Viewer, raw: z.input<typeof reviewInput>, now = new Date()) {
  const input = reviewInput.parse(raw);
  const [r] = await tx.select().from(bodyRegionReports).where(and(eq(bodyRegionReports.id, input.reportId), eq(bodyRegionReports.orgId, v.orgId))).for("update");
  if (!r) throw new AuthzError();
  await requireOnAthlete(tx, v, r.athleteId, "health.review");
  if ((input.status === "follow_up" || input.status === "referred_out") && !input.note) throw new UserError("Add a note describing the follow-up or referral.", { note: "Required for follow-up / referral" });
  await tx.update(bodyRegionReports).set({ reviewStatus: input.status, reviewedBy: v.userId, reviewedAt: now, reviewNote: input.note || null }).where(eq(bodyRegionReports.id, r.id));
  if (r.reviewTaskId) {
    const done = input.status !== "follow_up";
    await tx
      .update(tasks)
      .set(done ? { status: "done", completedAt: now, completedBy: v.userId } : { status: "in_progress" })
      .where(and(eq(tasks.id, r.reviewTaskId), eq(tasks.orgId, v.orgId)));
  }
  await audit(tx, actorOf(v), "science.body_report.review", "body_region_report", r.id, { summary: `Body map report marked ${input.status}`, before: { status: r.reviewStatus }, after: { status: input.status } });
}
