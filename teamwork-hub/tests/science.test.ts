import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bodyRegionReports, questionnaireResponses, tasks, wearableObservations, workouts } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { scopedAthletes } from "@/lib/science/access";
import { bodyHistory, reviewBodyReport, reviewQueue, reviewQueueCount, submitBodyReport } from "@/lib/science/bodymap";
import { checkinHabit, habitSummaries } from "@/lib/science/habits";
import { athleteMetricSeries, recordTestSession } from "@/lib/science/kpis";
import { athleteLoad, loadEntries, logActivity } from "@/lib/science/load";
import { performanceSummary } from "@/lib/science/performance";
import { createDraftReport, editReport, setReportStatus, sharedReportsFor, viewReport } from "@/lib/science/reports";
import { importWearableCsv, wearableDashboard } from "@/lib/science/wearables";
import { completionGrid, getQuestionnaire, saveQuestionnaire, submitResponse, wellnessCompletionSummary } from "@/lib/science/wellness";
import { volumeReport } from "@/lib/science/volume";
import { localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const TODAY = "2026-03-02";
const NOW = localToUtc(TODAY, "12:00");
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let qid: string;

beforeAll(async () => {
  ctx = await seedOrg(TODAY);
  qid = ctx.extra.science.questionnaireId;
});
afterAll(closeTestDb);

const tx = () => testDb();

describe("permissions", () => {
  it("Jordan (guardian without health access) never receives Maya's body map or wellness", async () => {
    const jordan = await viewerFor(ctx, "jordan");
    await expect(bodyHistory(tx(), jordan, ctx.athletes.maya, 90, NOW)).rejects.toBeInstanceOf(AuthzError);
    const s = await performanceSummary(tx(), jordan, ctx.athletes.maya, TODAY);
    expect(s.health).toBeNull();
    expect(await scopedAthletes(tx(), jordan, "health.read")).toEqual([]);
    // …but Jordan does get training progress.
    expect(s.kpis.length).toBeGreaterThan(0);
    const alex = await viewerFor(ctx, "alex");
    expect((await performanceSummary(tx(), alex, ctx.athletes.maya, TODAY)).health).not.toBeNull();
  });

  it("Erin (operations) gets no wellness/body-map/wearable data, but can see training load", async () => {
    const erin = await viewerFor(ctx, "erin");
    expect(await scopedAthletes(tx(), erin, "health.read")).toEqual([]);
    expect((await wellnessCompletionSummary(tx(), erin, TODAY)).expected).toBe(0);
    expect(await reviewQueueCount(tx(), erin)).toBe(0);
    await expect(bodyHistory(tx(), erin, ctx.athletes.maya, 90, NOW)).rejects.toBeInstanceOf(AuthzError);
    await expect(wearableDashboard(tx(), erin, ctx.athletes.dana, "2026-02-01", TODAY)).rejects.toBeInstanceOf(AuthzError);
    expect((await performanceSummary(tx(), erin, ctx.athletes.maya, TODAY)).health).toBeNull();
    const load = await athleteLoad(tx(), erin, ctx.athletes.maya, TODAY);
    expect(load.readiness).toBeNull(); // no wellness overlay for ops
  });

  it("coach scope: Marcus sees HS athletes' wellness and review items, not Tess's youth athletes", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const grid = await completionGrid(tx(), marcus, qid, TODAY);
    const ids = grid!.rows.map((r) => r.athleteId);
    expect(ids).toContain(ctx.athletes.maya);
    expect(ids).not.toContain(ctx.athletes.eli);
    const q = await reviewQueue(tx(), marcus);
    expect(q.some((r) => r.athleteId === ctx.athletes.ava)).toBe(false);
    expect(q.some((r) => r.athleteId === ctx.athletes.maya)).toBe(true);
    const tess = await viewerFor(ctx, "tess");
    expect((await reviewQueue(tx(), tess)).some((r) => r.athleteId === ctx.athletes.ava)).toBe(true);
    await expect(athleteLoad(tx(), tess, ctx.athletes.maya, TODAY)).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("wellness", () => {
  it("missing response is shown as no_response with null readiness and no flags (never favorable)", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const grid = await completionGrid(tx(), marcus, qid, TODAY);
    const leo = grid!.rows.find((r) => r.athleteId === ctx.athletes.leo)!;
    expect(leo.status).toBe("no_response");
    expect(leo.readiness.score).toBeNull();
    expect(leo.flags).toEqual([]);
    const sum = await wellnessCompletionSummary(tx(), marcus, TODAY);
    expect(sum.noResponse).toBeGreaterThanOrEqual(3); // maya, leo, zoe unanswered today
    expect(sum.answered + sum.partial + sum.noResponse).toBe(sum.expected);
  });

  it("athlete submits today's check-in; past dates and other athletes are refused", async () => {
    const maya = await viewerFor(ctx, "maya");
    const answers = { sleep_hours: 7.5, sleep_quality: 4, fatigue: 2, soreness: 2, stress: 2, mood: 4, readiness: 8 };
    const res = await submitResponse(tx(), maya, { athleteId: ctx.athletes.maya, questionnaireId: qid, answers }, NOW);
    expect(res.readiness.score).not.toBeNull();
    await expect(submitResponse(tx(), maya, { athleteId: ctx.athletes.maya, questionnaireId: qid, forDate: "2026-02-27", answers }, NOW)).rejects.toBeInstanceOf(UserError);
    await expect(submitResponse(tx(), maya, { athleteId: ctx.athletes.eli, questionnaireId: qid, answers }, NOW)).rejects.toBeInstanceOf(AuthzError);
    await expect(submitResponse(tx(), maya, { athleteId: ctx.athletes.maya, questionnaireId: qid, answers: { ...answers, soreness: null } }, NOW)).rejects.toBeInstanceOf(UserError);
    const jordan = await viewerFor(ctx, "jordan");
    await expect(submitResponse(tx(), jordan, { athleteId: ctx.athletes.maya, questionnaireId: qid, answers }, NOW)).rejects.toBeInstanceOf(AuthzError);
  });

  it("editing questions creates a new version; existing responses keep theirs", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const before = (await getQuestionnaire(tx(), marcus, qid))!;
    const res = await saveQuestionnaire(tx(), marcus, {
      id: qid,
      name: before.name,
      frequency: "daily",
      groupIds: before.schedule.groupIds,
      flagRules: before.schedule.flagRules,
      questions: [...before.questions.map((q) => ({ ...q, required: q.required ?? false })), { key: "hydration", label: "Hydration", kind: "scale", min: 1, max: 5, polarity: "higher_better", required: false }],
    });
    expect(res.newVersion).toBe(true);
    expect(res.version).toBe(before.version + 1);
    const old = await tx().select().from(questionnaireResponses).where(eq(questionnaireResponses.versionId, before.versionId));
    expect(old.length).toBeGreaterThan(50);
    // Schedule-only change doesn't create a version.
    const after = (await getQuestionnaire(tx(), marcus, qid))!;
    const res2 = await saveQuestionnaire(tx(), marcus, { id: qid, name: "Daily Readiness", frequency: "weekdays", groupIds: after.schedule.groupIds, flagRules: after.schedule.flagRules, questions: after.questions.map((q) => ({ ...q, required: q.required ?? false })) });
    expect(res2.newVersion).toBe(false);
    const erin = await viewerFor(ctx, "erin");
    await expect(saveQuestionnaire(tx(), erin, { name: "x", frequency: "daily", questions: [{ key: "a", label: "A", kind: "text" }] })).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("body map", () => {
  it("pain creates one deduped review task; low soreness does not; review closes the task", async () => {
    const maya = await viewerFor(ctx, "maya");
    const r1 = await submitBodyReport(tx(), maya, { athleteId: ctx.athletes.maya, view: "back", region: "hamstring", side: "right", kind: "pain", severity: 4 }, NOW);
    expect(r1.taskId).not.toBeNull();
    const [t] = await tx().select().from(tasks).where(eq(tasks.id, r1.taskId!));
    expect(t.dedupeKey).toBe(`body_review:${r1.id}`);
    expect(t.assigneeUserId).toBe(ctx.users.marcus);
    const r2 = await submitBodyReport(tx(), maya, { athleteId: ctx.athletes.maya, view: "front", region: "quad", side: "left", kind: "soreness", severity: 3 }, NOW);
    expect(r2.taskId).toBeNull();
    await expect(submitBodyReport(tx(), maya, { athleteId: ctx.athletes.maya, view: "front", region: "hamstring", side: "left", kind: "pain", severity: 4 }, NOW)).rejects.toBeInstanceOf(UserError);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(reviewBodyReport(tx(), marcus, { reportId: r1.id, status: "referred_out" })).rejects.toBeInstanceOf(UserError);
    await reviewBodyReport(tx(), marcus, { reportId: r1.id, status: "referred_out", note: "Referred to athletic trainer (test)" }, NOW);
    const [t2] = await tx().select().from(tasks).where(eq(tasks.id, r1.taskId!));
    expect(t2.status).toBe("done");
    // Athlete can't review; guardian without health can't report.
    await expect(reviewBodyReport(tx(), maya, { reportId: r1.id, status: "reviewed" })).rejects.toBeInstanceOf(AuthzError);
    const jordan = await viewerFor(ctx, "jordan");
    await expect(submitBodyReport(tx(), jordan, { athleteId: ctx.athletes.maya, view: "front", region: "chest", side: "center", kind: "pain", severity: 2 }, NOW)).rejects.toBeInstanceOf(AuthzError);
    const [stored] = await tx().select().from(bodyRegionReports).where(and(eq(bodyRegionReports.id, r1.id)));
    expect(stored.reviewStatus).toBe("referred_out");
  });
});

describe("habits", () => {
  it("check-in upserts and adherence separates missed vs no check-in", async () => {
    const maya = await viewerFor(ctx, "maya");
    const [sleep] = (await habitSummaries(tx(), maya, ctx.athletes.maya, "2026-02-03", TODAY)).filter((h) => h.habit.name === "Sleep 8h");
    await checkinHabit(tx(), maya, { habitId: sleep.habit.id, athleteId: ctx.athletes.maya, forDate: TODAY, status: "partial", value: 6 }, NOW);
    await checkinHabit(tx(), maya, { habitId: sleep.habit.id, athleteId: ctx.athletes.maya, forDate: TODAY, status: "done", value: 8 }, NOW);
    const [after] = (await habitSummaries(tx(), maya, ctx.athletes.maya, "2026-02-03", TODAY)).filter((h) => h.habit.name === "Sleep 8h");
    expect(after.todayStatus).toBe("done");
    const a = after.adherence;
    expect(a.done + a.partial + a.missed + a.noCheckin).toBe(a.expected);
    expect(after.streak).toBeGreaterThanOrEqual(6);
  });
});

describe("KPIs & units", () => {
  it("broad jump entries in inches are converted explicitly to cm; incompatible units are refused", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const [bj] = await athleteMetricSeries(tx(), marcus, ctx.athletes.leo, { metricIds: [ctx.extra.science.mBroad] });
    expect(bj.metric.unit).toBe("cm");
    expect(bj.points[0].convertedFromUnits).toEqual(["in"]);
    expect(bj.latest!.value!).toBeGreaterThan(150); // cm-scale, not raw inches (~80–90)
    await expect(
      recordTestSession(tx(), marcus, { athleteId: ctx.athletes.maya, testTypeId: ctx.extra.science.ttBroad, date: TODAY, values: [{ metricId: ctx.extra.science.mBroad, trialNumber: 1, value: 3, unit: "s" }] }),
    ).rejects.toBeInstanceOf(UserError);
    await recordTestSession(tx(), marcus, { athleteId: ctx.athletes.maya, testTypeId: ctx.extra.science.ttBroad, date: TODAY, values: [{ metricId: ctx.extra.science.mBroad, trialNumber: 1, value: 90, unit: "in" }, { metricId: ctx.extra.science.mBroad, trialNumber: 2, value: null, unit: "" }] });
    const [m] = await athleteMetricSeries(tx(), marcus, ctx.athletes.maya, { metricIds: [ctx.extra.science.mBroad] });
    expect(m.latest!.value).toBeCloseTo(228.6, 6); // null trial skipped, never 0
  });

  it("CMJ session value never includes the vendor aggregate row or excluded trial", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const [jh] = await athleteMetricSeries(tx(), marcus, ctx.athletes.maya, { metricIds: [ctx.extra.science.mJump] });
    for (const p of jh.points) {
      const included = p.trials.filter((t) => !t.isAggregate && !t.excluded && t.converted !== null);
      expect(p.n).toBe(included.length);
      expect(p.value).toBeCloseTo(included.reduce((a, t) => a + t.converted!, 0) / included.length, 9);
      expect(p.vendorAggregate).not.toBeNull();
    }
    expect(jh.points.some((p) => p.n === 2)).toBe(true); // the excluded-trial session
  });
});

describe("load & DST", () => {
  it("workout completed 23:30 local on DST day is bucketed to that local date", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    await tx().insert(workouts).values({ orgId: ctx.orgId, athleteId: ctx.athletes.dana, scheduledDate: "2026-03-08", title: "Late lift (test)", status: "completed", completedAt: new Date("2026-03-09T03:30:00Z"), durationMinutes: 50, sessionRpe: 6, isDemo: true });
    const entries = await loadEntries(tx(), ctx.orgId, ctx.athletes.dana, "2026-03-07", "2026-03-09");
    const w = entries.find((e) => e.label.includes("Late lift"))!;
    expect(w.date).toBe("2026-03-08");
    expect(w.load).toBe(300);
    await expect(logActivity(tx(), marcus, { athleteId: ctx.athletes.dana, activityDate: TODAY, kind: "practice" }, NOW)).rejects.toThrow();
  });

  it("sparse logging leaves ACWR null with coverage shown", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const leo = await athleteLoad(tx(), marcus, ctx.athletes.leo, TODAY);
    expect(leo.acwr.ratio).toBeNull();
    expect(leo.acwr.chronicCoverage).toBeLessThan(0.75);
    const maya = await athleteLoad(tx(), marcus, ctx.athletes.maya, TODAY);
    expect(maya.acwr.chronicCoverage).toBeGreaterThanOrEqual(0.75);
  });
});

describe("volume from set_logs", () => {
  it("applies warm-up, bodyweight-without-mass and scope rules", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const r = await volumeReport(tx(), marcus, { athleteIds: [ctx.athletes.maya], from: "2026-02-01", to: TODAY, groupBy: "exercise", includeWarmups: false, displayUnit: "lb" });
    const pu = r.buckets.find((b) => b.label === "Push-up")!;
    expect(pu.tonnage).toBe(0);
    expect(pu.reps).toBeGreaterThan(0);
    expect(pu.excludedBodyweightNoMass).toBeGreaterThan(0);
    const sq = r.buckets.find((b) => b.label === "Back Squat")!;
    expect(sq.excludedWarmup).toBe(6);
    expect(sq.excludedMissingLoad).toBe(1);
    const bss = r.buckets.find((b) => b.label === "Bulgarian Split Squat")!;
    expect(bss.tonnageLeft).toBeGreaterThan(bss.tonnageRight);
    const leo = await volumeReport(tx(), marcus, { athleteIds: [ctx.athletes.leo], from: "2026-02-01", to: TODAY, groupBy: "exercise", includeWarmups: false, displayUnit: "kg" });
    expect(leo.buckets.find((b) => b.label === "Push-up")!.tonnage).toBeGreaterThan(0); // body mass known
    const tess = await viewerFor(ctx, "tess");
    const none = await volumeReport(tx(), tess, { athleteIds: [ctx.athletes.maya], from: "2026-02-01", to: TODAY, groupBy: "exercise", includeWarmups: false, displayUnit: "lb" });
    expect(none.buckets.find((b) => b.label === "Back Squat")).toBeUndefined();
  });
});

describe("wearables import", () => {
  it("matches by unique email, re-checks health scope per row, converts units, dedupes", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const csv = ["date,athlete_email,metric,value,unit", "2026-03-01,dana.brooks@example.test,sleep_hours,450,min", "2026-03-01,dana.brooks@example.test,hrv_rmssd,,ms", "2026-03-01,nobody@example.test,resting_hr,55,bpm", "2026-03-01,dana.brooks@example.test,resting_hr,55,kg"].join("\n");
    const mapping = { date: "date", athlete: "athlete_email", athleteMatch: "email" as const, metric: "metric", value: "value", unit: "unit" };
    const res = await tx().transaction((t) => importWearableCsv(t, marcus, { csvText: csv, filename: "test.csv", provider: "testband", mapping }));
    expect(res.valid).toBe(2);
    expect(res.inserted).toBe(2);
    const again = await tx().transaction((t) => importWearableCsv(t, marcus, { csvText: csv, filename: "test.csv", provider: "testband", mapping }));
    expect(again.inserted).toBe(0);
    const rows = await tx().select().from(wearableObservations).where(and(eq(wearableObservations.provider, "testband"), eq(wearableObservations.athleteId, ctx.athletes.dana)));
    const sleep = rows.find((r) => r.metricKey === "sleep_hours")!;
    expect(sleep).toMatchObject({ value: 7.5, unit: "h", quality: "measured", importBatchId: res.batchId });
    expect(rows.find((r) => r.metricKey === "hrv_rmssd")).toMatchObject({ value: null, quality: "missing" });
    const d = await wearableDashboard(tx(), marcus, ctx.athletes.dana, "2026-03-02", "2026-03-02");
    expect(d.metrics.every((m) => m.days[0].quality === "no_data" && m.days[0].value === null)).toBe(true);
    const tess = await viewerFor(ctx, "tess");
    const denied = await tx().transaction((t) => importWearableCsv(t, tess, { csvText: csv, filename: "t.csv", provider: "testband2", mapping, dryRun: true }));
    expect(denied.valid).toBe(0);
  });
});

describe("progress reports", () => {
  it("families see only shared reports; wellness only when included AND viewer has health access", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const alex = await viewerFor(ctx, "alex");
    const jordan = await viewerFor(ctx, "jordan");
    const draft = await createDraftReport(tx(), marcus, { athleteId: ctx.athletes.maya, periodStart: "2026-02-01", periodEnd: TODAY });
    expect(await viewReport(tx(), alex, draft.id)).toBeNull();
    const shared = await sharedReportsFor(tx(), alex, [ctx.athletes.maya]);
    expect(shared.every((r) => r.status === "shared")).toBe(true);
    expect(shared.some((r) => r.id === draft.id)).toBe(false);
    // Seeded shared report has wellness OFF → hidden even for Alex.
    const seeded = await viewReport(tx(), alex, shared[0].id);
    expect(seeded!.showWellness).toBe(false);
    expect(seeded!.snapshot.wellness).toBeNull();

    await expect(setReportStatus(tx(), marcus, { id: draft.id, to: "approved" })).rejects.toBeInstanceOf(UserError); // needs summary
    await editReport(tx(), marcus, { id: draft.id, coachSummary: "Great block (test).", sections: { kpis: true, strength: true, habits: true, attendance: true, wellness: true } });
    await expect(setReportStatus(tx(), marcus, { id: draft.id, to: "shared" })).rejects.toBeInstanceOf(UserError); // must approve first
    await setReportStatus(tx(), marcus, { id: draft.id, to: "approved" });
    await setReportStatus(tx(), marcus, { id: draft.id, to: "shared" });
    const forAlex = await viewReport(tx(), alex, draft.id);
    expect(forAlex!.showWellness).toBe(true);
    expect(forAlex!.snapshot.wellness).not.toBeNull();
    const forJordan = await viewReport(tx(), jordan, draft.id);
    expect(forJordan).not.toBeNull();
    expect(forJordan!.showWellness).toBe(false);
    expect(forJordan!.snapshot.wellness).toBeNull();
    // Chris (unrelated Parker) can't see it at all; operations can't create one.
    expect(await viewReport(tx(), await viewerFor(ctx, "chris"), draft.id)).toBeNull();
    await expect(createDraftReport(tx(), await viewerFor(ctx, "erin"), { athleteId: ctx.athletes.maya, periodStart: "2026-02-01", periodEnd: TODAY })).rejects.toBeInstanceOf(AuthzError);
  });
});
