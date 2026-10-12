import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { progressReports } from "@/db/schema";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, canOnAthlete, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { actorOf, scopedAthletes } from "./access";
import { isNum, mean } from "./formulas";
import { habitSummaries } from "./habits";
import { athleteMetricSeries, attendanceKpi, strengthPrs } from "./kpis";
import { readinessByDate } from "./wellness";

export type ReportSections = { kpis: boolean; strength: boolean; habits: boolean; attendance: boolean; wellness: boolean };
export const DEFAULT_SECTIONS: ReportSections = { kpis: true, strength: true, habits: true, attendance: true, wellness: false };

export type ReportSnapshot = {
  generatedAt: string;
  period: { start: string; end: string };
  kpis: { metric: string; unit: string; source: string; precision: number; higherIsBetter: boolean | null; latest: number | null; latestDate: string | null; baseline: number | null; target: number | null; changePct: number | null; sessions: number }[];
  strength: { exercise: string; value: number; unit: string; date: string; method: string; prInPeriod: boolean }[];
  habits: { name: string; adherencePct: number | null; expected: number; done: number; partial: number; missed: number; noCheckin: number; streak: number }[];
  attendance: { attended: number; noShow: number; ratePct: number | null } | null;
  /** Present only if the author had health.read when the snapshot was taken. */
  wellness: { respondedDays: number; periodDays: number; meanReadiness: number | null; formula: "tw_readiness_v1" } | null;
};

export type ReportContent = { sections: ReportSections; snapshot: ReportSnapshot };

export async function assembleSnapshot(tx: Tx, v: Viewer, athleteId: string, start: string, end: string): Promise<ReportSnapshot> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const series = await athleteMetricSeries(tx, v, athleteId, { from: start, to: end });
  const prs = await strengthPrs(tx, v, athleteId, { from: start, to: end });
  const habits = await habitSummaries(tx, v, athleteId, start, end);
  const att = await attendanceKpi(tx, v, athleteId, start, end);
  const readiness = await readinessByDate(tx, v, athleteId, start, end);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return {
    generatedAt: new Date().toISOString(),
    period: { start, end },
    kpis: series
      .filter((s) => s.points.length)
      .map((s) => ({
        metric: s.metric.name,
        unit: s.metric.unit,
        source: s.metric.definedBy,
        precision: s.metric.precision,
        higherIsBetter: s.metric.higherIsBetter,
        latest: s.latest?.value ?? null,
        latestDate: s.latest?.date ?? null,
        baseline: s.baseline?.value ?? null,
        target: s.target?.value ?? null,
        changePct: s.changePct,
        sessions: s.points.length,
      })),
    strength: prs.map((p) => ({ exercise: p.exercise, value: p.best.value, unit: p.best.unit, date: p.best.date, method: p.best.method, prInPeriod: p.prInPeriod })),
    habits: habits.map((h) => ({ name: h.habit.name, adherencePct: h.adherence.adherencePct, expected: h.adherence.expected, done: h.adherence.done, partial: h.adherence.partial, missed: h.adherence.missed, noCheckin: h.adherence.noCheckin, streak: h.streak })),
    attendance: att.attended + att.noShow > 0 ? { attended: att.attended, noShow: att.noShow, ratePct: att.ratePct } : null,
    wellness: readiness
      ? { respondedDays: readiness.size, periodDays: days, meanReadiness: mean([...readiness.values()]), formula: "tw_readiness_v1" }
      : null,
  };
}

async function staffCanManage(tx: Tx, v: Viewer, athleteId: string) {
  assertCan(v, "science.manage");
  await requireOnAthlete(tx, v, athleteId, "training.write");
}

export const draftInput = z
  .object({ athleteId: z.string().uuid(), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .refine((x) => x.periodEnd >= x.periodStart, "Period end must be after start");

export async function createDraftReport(tx: Tx, v: Viewer, raw: z.input<typeof draftInput>) {
  const input = draftInput.parse(raw);
  await staffCanManage(tx, v, input.athleteId);
  const snapshot = await assembleSnapshot(tx, v, input.athleteId, input.periodStart, input.periodEnd);
  const content: ReportContent = { sections: DEFAULT_SECTIONS, snapshot };
  const [r] = await tx
    .insert(progressReports)
    .values({ orgId: v.orgId, athleteId: input.athleteId, periodStart: input.periodStart, periodEnd: input.periodEnd, content, includeWellness: false, status: "draft", createdBy: v.userId })
    .returning();
  await audit(tx, actorOf(v), "science.report.draft", "progress_report", r.id, { summary: `Draft progress report ${input.periodStart}–${input.periodEnd}` });
  return r;
}

async function loadReport(tx: Tx, v: Viewer, id: string) {
  const [r] = await tx.select().from(progressReports).where(and(eq(progressReports.id, id), eq(progressReports.orgId, v.orgId))).for("update");
  if (!r) throw new AuthzError();
  return r;
}

export const editInput = z.object({
  id: z.string().uuid(),
  coachSummary: z.string().trim().max(4000).optional().nullable(),
  sections: z.object({ kpis: z.boolean(), strength: z.boolean(), habits: z.boolean(), attendance: z.boolean(), wellness: z.boolean() }),
  refresh: z.boolean().default(false),
});

/** Edit summary/sections. Any edit to an approved (not yet shared) report returns it to draft. */
export async function editReport(tx: Tx, v: Viewer, raw: z.input<typeof editInput>) {
  const input = editInput.parse(raw);
  const r = await loadReport(tx, v, input.id);
  await staffCanManage(tx, v, r.athleteId);
  if (r.status === "shared") throw new UserError("Shared reports are frozen. Create a new report instead.");
  const old = r.content as ReportContent;
  let snapshot = old.snapshot;
  if (input.refresh) snapshot = await assembleSnapshot(tx, v, r.athleteId, r.periodStart, r.periodEnd);
  if (input.sections.wellness) {
    if (!(await canOnAthlete(tx, v, r.athleteId, "health.read"))) throw new UserError("You need health access to include wellness.");
    if (!snapshot.wellness) snapshot = await assembleSnapshot(tx, v, r.athleteId, r.periodStart, r.periodEnd);
  }
  const content: ReportContent = { sections: input.sections, snapshot };
  await tx.update(progressReports).set({ content, coachSummary: input.coachSummary || null, includeWellness: input.sections.wellness, status: "draft", approvedBy: null, approvedAt: null }).where(eq(progressReports.id, r.id));
  await audit(tx, actorOf(v), "science.report.edit", "progress_report", r.id, { before: { status: r.status, sections: old.sections }, after: { status: "draft", sections: input.sections, refreshed: input.refresh } });
}

export async function setReportStatus(tx: Tx, v: Viewer, input: { id: string; to: "approved" | "shared" | "draft" }, now = new Date()) {
  const r = await loadReport(tx, v, input.id);
  await staffCanManage(tx, v, r.athleteId);
  const ok = (r.status === "draft" && input.to === "approved") || (r.status === "approved" && (input.to === "shared" || input.to === "draft"));
  if (!ok) throw new UserError(`A ${r.status} report can't move to ${input.to}.`);
  if (input.to === "approved" && !r.coachSummary) throw new UserError("Add a coach summary before approving.");
  await tx
    .update(progressReports)
    .set(input.to === "approved" ? { status: "approved", approvedBy: v.userId, approvedAt: now } : input.to === "draft" ? { status: "draft", approvedBy: null, approvedAt: null } : { status: "shared" })
    .where(eq(progressReports.id, r.id));
  await audit(tx, actorOf(v), `science.report.${input.to}`, "progress_report", r.id, { before: { status: r.status }, after: { status: input.to } });
}

/** Staff list (training.read scope). */
export async function listReportsForStaff(tx: Tx, v: Viewer) {
  if (!isStaff(v)) return [];
  const ids = await accessibleAthleteIds(tx, v, "training.read");
  const rows = await tx.select().from(progressReports).where(and(eq(progressReports.orgId, v.orgId), athleteScopeFilter(ids, progressReports.athleteId))).orderBy(desc(progressReports.createdAt));
  const names = new Map((await scopedAthletes(tx, v, "training.read", { includeInactive: true })).map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, athleteName: names.get(r.athleteId) ?? "Athlete" }));
}

/** Families/athletes: shared reports only, for athletes they can read training for. */
export async function sharedReportsFor(tx: Tx, v: Viewer, athleteIds: string[]) {
  const ids = await accessibleAthleteIds(tx, v, "training.read");
  const allowed = ids === "all" ? athleteIds : athleteIds.filter((a) => ids.includes(a));
  if (!allowed.length) return [];
  return tx
    .select()
    .from(progressReports)
    .where(and(eq(progressReports.orgId, v.orgId), inArray(progressReports.athleteId, allowed), eq(progressReports.status, "shared")))
    .orderBy(desc(progressReports.periodEnd));
}

export type ReportView = {
  report: typeof progressReports.$inferSelect;
  sections: ReportSections;
  snapshot: ReportSnapshot;
  /** Wellness is shown only if the report includes it AND this viewer holds health.read. */
  showWellness: boolean;
  canManage: boolean;
};

/** A single report as the viewer is allowed to see it. Non-staff only ever see shared reports. */
export async function viewReport(tx: Tx, v: Viewer, id: string): Promise<ReportView | null> {
  const [r] = await tx.select().from(progressReports).where(and(eq(progressReports.id, id), eq(progressReports.orgId, v.orgId)));
  if (!r) return null;
  if (!(await canOnAthlete(tx, v, r.athleteId, "training.read"))) return null;
  const canManage = isStaff(v) && (await canOnAthlete(tx, v, r.athleteId, "training.write"));
  if (r.status !== "shared" && !canManage) return null;
  const content = r.content as ReportContent;
  const showWellness = content.sections.wellness && r.includeWellness && (await canOnAthlete(tx, v, r.athleteId, "health.read"));
  const snapshot = { ...content.snapshot, wellness: showWellness ? content.snapshot.wellness : null };
  return { report: r, sections: content.sections, snapshot, showWellness, canManage };
}

export const fmtNum = (v: number | null | undefined, digits = 2) => (isNum(v) ? v.toFixed(digits) : "—");
