"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { Tx } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, UserError, type ActionState } from "@/lib/actions";
import type { Viewer } from "@/lib/authz/policy";
import { reviewBodyReport, submitBodyReport } from "@/lib/science/bodymap";
import { assignHabit, checkinHabit, createHabit } from "@/lib/science/habits";
import { createMetric, createTestType, recordTestSession, setKpiTarget, setTrialExcluded } from "@/lib/science/kpis";
import { deleteActivity, logActivity } from "@/lib/science/load";
import { createDraftReport, editReport, setReportStatus } from "@/lib/science/reports";
import { updateScienceSettings } from "@/lib/science/settings";
import { addManualObservation, importWearableCsv } from "@/lib/science/wearables";
import { saveQuestionnaire, submitResponse } from "@/lib/science/wellness";

const s = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};
const opt = (fd: FormData, k: string) => s(fd, k).trim() || null;

async function run<T>(fn: (tx: Tx, v: Viewer) => Promise<T>): Promise<T> {
  const v = await requireViewer();
  const out = await db.transaction((tx) => fn(tx, v));
  revalidatePath("/science", "layout");
  revalidatePath("/performance", "layout");
  return out;
}

export const saveQuestionnaireAction = safeAction(async (_p: ActionState, fd: FormData) => {
  let payload: unknown;
  try {
    payload = JSON.parse(s(fd, "payload"));
  } catch {
    throw new UserError("The questionnaire could not be read. Please try again.");
  }
  const res = await run((tx, v) => saveQuestionnaire(tx, v, payload as Parameters<typeof saveQuestionnaire>[2]));
  return { ok: true, message: res.newVersion ? `Saved as version ${res.version}. Earlier responses keep their original version.` : "Saved (questions unchanged, no new version).", data: { id: res.id } };
});

export const submitCheckinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const raw = formToObject(fd);
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (k.startsWith("q_")) answers[k.slice(2)] = Array.isArray(v) ? v[0] : v;
  const res = await run((tx, v) => submitResponse(tx, v, { athleteId: s(fd, "athleteId"), questionnaireId: s(fd, "questionnaireId"), forDate: opt(fd, "forDate") ?? undefined, answers, note: opt(fd, "note") }));
  return { ok: true, message: res.readiness.score === null ? "Check-in saved." : `Check-in saved. Teamwork readiness (tw_readiness_v1): ${Math.round(res.readiness.score)}/100.` };
});

export const submitBodyReportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const res = await run((tx, v) =>
    submitBodyReport(tx, v, { athleteId: s(fd, "athleteId"), view: s(fd, "view") as "front", region: s(fd, "region"), side: s(fd, "side") as "left", kind: s(fd, "kind") as "pain", severity: Number(s(fd, "severity")), note: opt(fd, "note") }),
  );
  return { ok: true, message: res.taskId ? "Saved. A coach will review this report." : "Saved." };
});

export const reviewBodyReportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => reviewBodyReport(tx, v, { reportId: s(fd, "reportId"), status: s(fd, "status") as "reviewed", note: opt(fd, "note") }));
  return { ok: true, message: "Review saved." };
});

export const createHabitAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => createHabit(tx, v, { name: s(fd, "name"), description: opt(fd, "description"), targetValue: opt(fd, "targetValue") as unknown as number, targetUnit: opt(fd, "targetUnit"), frequency: s(fd, "frequency") as "daily" }));
  return { ok: true, message: "Habit created." };
});

export const assignHabitAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const target = s(fd, "target");
  const [kind, id] = target.split(":");
  await run((tx, v) => assignHabit(tx, v, { habitId: s(fd, "habitId"), athleteId: kind === "athlete" ? id : null, groupId: kind === "group" ? id : null, startDate: s(fd, "startDate"), endDate: opt(fd, "endDate") }));
  return { ok: true, message: "Habit assigned." };
});

export const habitCheckinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => checkinHabit(tx, v, { habitId: s(fd, "habitId"), athleteId: s(fd, "athleteId"), forDate: s(fd, "forDate"), status: s(fd, "status") as "done", value: opt(fd, "value") as unknown as number, note: opt(fd, "note") }));
  return { ok: true, message: "Checked in." };
});

export const createMetricAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => createMetric(tx, v, { key: s(fd, "key"), name: s(fd, "name"), unit: s(fd, "unit"), higherIsBetter: s(fd, "higherIsBetter") as "true", category: s(fd, "category") as "other", definedBy: s(fd, "definedBy") as "teamwork_manual", precision: s(fd, "precision") || "2", description: opt(fd, "description") }));
  return { ok: true, message: "Metric created." };
});

export const createTestTypeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => createTestType(tx, v, { key: s(fd, "key"), name: s(fd, "name"), vendor: s(fd, "vendor") as "teamwork", protocol: opt(fd, "protocol"), trialSelection: s(fd, "trialSelection") as "best" }));
  return { ok: true, message: "Test type created." };
});

export const recordTestAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const values: { metricId: string; trialNumber: number; value: number | null; unit: string }[] = [];
  for (let row = 0; row < 3; row++) {
    const metricId = s(fd, `metric_${row}`);
    if (!metricId) continue;
    const unit = s(fd, `unit_${row}`).trim();
    for (let t = 1; t <= 3; t++) {
      const raw = s(fd, `v_${row}_${t}`).trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UserError(`Trial ${t} value "${raw}" is not a number.`);
      values.push({ metricId, trialNumber: t, value: n, unit });
    }
  }
  await run((tx, v) => recordTestSession(tx, v, { athleteId: s(fd, "athleteId"), testTypeId: s(fd, "testTypeId"), date: s(fd, "date"), time: s(fd, "time") || "12:00", notes: opt(fd, "notes"), values }));
  return { ok: true, message: `Saved ${values.length} trial value(s).` };
});

export const setTargetAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const [kind, id] = s(fd, "target").split(":");
  await run((tx, v) =>
    setKpiTarget(tx, v, { metricDefinitionId: s(fd, "metricDefinitionId"), athleteId: kind === "athlete" ? id : null, groupId: kind === "group" ? id : null, baselineValue: opt(fd, "baselineValue") as unknown as number, baselineDate: opt(fd, "baselineDate"), targetValue: s(fd, "targetValue") as unknown as number, goalDate: opt(fd, "goalDate"), trialSelection: s(fd, "trialSelection") as "best" }),
  );
  return { ok: true, message: "Target saved." };
});

export const toggleTrialAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const excluded = s(fd, "excluded") === "true";
  await run((tx, v) => setTrialExcluded(tx, v, { trialId: s(fd, "trialId"), excluded, reason: opt(fd, "reason") }));
  return { ok: true, message: excluded ? "Trial excluded." : "Trial included." };
});

export const logActivityAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => logActivity(tx, v, { athleteId: s(fd, "athleteId"), activityDate: s(fd, "activityDate"), kind: s(fd, "kind") as "practice", durationMinutes: opt(fd, "durationMinutes") as unknown as number, sessionRpe: opt(fd, "sessionRpe") as unknown as number, notes: opt(fd, "notes") }));
  return { ok: true, message: "Saved." };
});

export const deleteActivityAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => deleteActivity(tx, v, s(fd, "id")));
  return { ok: true, message: "Deleted." };
});

export const importWearablesAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) throw new UserError("Choose a CSV file.", { file: "Required" });
  if (file.size > 2_000_000) throw new UserError("File is larger than 2 MB.");
  const csvText = await file.text();
  const dryRun = s(fd, "dryRun") === "on";
  const res = await run((tx, v) =>
    importWearableCsv(tx, v, {
      csvText,
      filename: file.name,
      provider: s(fd, "provider") || "csv",
      dryRun,
      mapping: { date: s(fd, "col_date"), athlete: s(fd, "col_athlete"), athleteMatch: s(fd, "athleteMatch") as "email", metric: s(fd, "col_metric"), value: s(fd, "col_value"), unit: s(fd, "col_unit") },
    }),
  );
  const errs = res.rows.filter((r) => r.errors.length).slice(0, 8).map((r) => `Row ${r.row}: ${r.errors.join("; ")}`);
  const head = dryRun ? `Preview: ${res.valid} of ${res.total} rows valid. Nothing was saved.` : `Imported ${res.inserted} new observation(s); ${"duplicates" in res ? res.duplicates : 0} duplicate(s) skipped; ${res.total - res.valid} invalid.`;
  return { ok: true, message: [head, ...errs].join("\n") };
});

export const manualWearableAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => addManualObservation(tx, v, { athleteId: s(fd, "athleteId"), metricKey: s(fd, "metricKey"), observedOn: s(fd, "observedOn"), value: s(fd, "value") as unknown as number, quality: s(fd, "quality") as "measured" }));
  return { ok: true, message: "Saved." };
});

export const createReportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const r = await run((tx, v) => createDraftReport(tx, v, { athleteId: s(fd, "athleteId"), periodStart: s(fd, "periodStart"), periodEnd: s(fd, "periodEnd") }));
  redirect(`/science/reports/${r.id}`);
});

export const editReportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const on = (k: string) => s(fd, `sec_${k}`) === "on";
  await run((tx, v) =>
    editReport(tx, v, { id: s(fd, "id"), coachSummary: opt(fd, "coachSummary"), sections: { kpis: on("kpis"), strength: on("strength"), habits: on("habits"), attendance: on("attendance"), wellness: on("wellness") }, refresh: s(fd, "refresh") === "on" }),
  );
  return { ok: true, message: "Saved as draft." };
});

export const reportStatusAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const to = s(fd, "to") as "approved" | "shared" | "draft";
  await run((tx, v) => setReportStatus(tx, v, { id: s(fd, "id"), to }));
  return { ok: true, message: to === "shared" ? "Shared with the family." : to === "approved" ? "Approved. Share it when ready." : "Returned to draft." };
});

export const updateSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) =>
    updateScienceSettings(tx, v, { sorenessReviewThreshold: s(fd, "sorenessReviewThreshold"), acwrMinCoveragePct: s(fd, "acwrMinCoveragePct"), acwrAlertHigh: s(fd, "acwrAlertHigh"), acwrAlertLow: s(fd, "acwrAlertLow"), readinessFlagBelow: s(fd, "readinessFlagBelow") }),
  );
  return { ok: true, message: "Thresholds saved." };
});
