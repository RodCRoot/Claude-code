/**
 * Sports-science demo seed. Synthetic data only (is_demo where the table supports it).
 * Imports only pure modules (no `server-only`) so it runs under plain tsx.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activitySessions,
  athletes,
  bodyRegionReports,
  exercises,
  habitAssignments,
  habitCheckins,
  habits,
  importBatches,
  kpiTargets,
  maxes,
  metricDefinitions,
  metricValues,
  progressReports,
  questionnaireResponses,
  questionnaires,
  questionnaireVersions,
  rawSignals,
  setLogs,
  storedObjects,
  tasks,
  testSessions,
  testTypes,
  trials,
  wearableObservations,
  workoutItems,
  workouts,
  type QuestionDef,
} from "../../src/db/schema";
import { addDaysYmd, fmt, isoWeekday, localToUtc } from "../../src/lib/time";
import { expectedHabitDates, habitAdherence, mean, readinessV1, selectTrials, type HabitStatus } from "../../src/lib/science/formulas";
import type { SeedCtx } from "./context";

/** Deterministic PRNG so demo data is stable between runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const DAILY_READINESS: QuestionDef[] = [
  { key: "sleep_hours", label: "Hours slept last night", kind: "number", unit: "h", required: false },
  { key: "sleep_quality", label: "Sleep quality", kind: "scale", min: 1, max: 5, polarity: "higher_better", anchors: { "1": "Very poor", "5": "Excellent" }, required: true },
  { key: "fatigue", label: "Fatigue", kind: "scale", min: 1, max: 5, polarity: "lower_better", anchors: { "1": "Fresh", "5": "Exhausted" }, required: true },
  { key: "soreness", label: "Muscle soreness", kind: "scale", min: 1, max: 5, polarity: "lower_better", anchors: { "1": "None", "5": "Very sore" }, required: true },
  { key: "stress", label: "Stress", kind: "scale", min: 1, max: 5, polarity: "lower_better", anchors: { "1": "Relaxed", "5": "Very stressed" }, required: true },
  { key: "mood", label: "Mood", kind: "scale", min: 1, max: 5, polarity: "higher_better", anchors: { "1": "Low", "5": "Great" }, required: false },
  { key: "readiness", label: "Ready to train", kind: "scale", min: 1, max: 10, polarity: "higher_better", anchors: { "1": "Not at all", "10": "Fully ready" }, required: true },
  { key: "comments", label: "Anything your coach should know?", kind: "text", required: false },
];

export async function seedScience(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const A = ctx.athletes;
  const U = ctx.users;
  const r = rng(20261012);
  const hs = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson"];
  ctx.extra.science = {};

  // -------------------------------------------------------------------------
  // Wellness questionnaire + ~28 days of responses (gaps + some nulls)
  // -------------------------------------------------------------------------
  const [q] = await tx
    .insert(questionnaires)
    .values({
      orgId,
      name: "Daily Readiness",
      schedule: { frequency: "daily", groupIds: [ctx.groups.hs], flagRules: { sleep_hours: { below: 6 }, soreness: { above: 3 }, stress: { above: 4 }, readiness: { below: 4 } } },
    })
    .returning();
  const [qv] = await tx.insert(questionnaireVersions).values({ questionnaireId: q.id, version: 1, questions: DAILY_READINESS }).returning();
  await tx.update(questionnaires).set({ currentVersionId: qv.id }).where(eq(questionnaires.id, q.id));
  ctx.extra.science.questionnaireId = q.id;
  ctx.extra.science.questionnaireVersionId = qv.id;

  // Maya, Leo and Zoe have NOT answered today, so the coach grid shows "no response".
  const notToday = new Set(["maya", "leo", "zoe"]);
  const responseRows: (typeof questionnaireResponses.$inferInsert)[] = [];
  for (const [i, k] of hs.entries()) {
    const base = 0.35 + (i % 4) * 0.1;
    for (let d = 27; d >= 0; d--) {
      const date = addDaysYmd(today, -d);
      if (d === 0 && notToday.has(k)) continue;
      if (d > 0 && r() < 0.16) continue; // ~16% gaps (no response — never treated as fine)
      const s5 = () => Math.round(clamp(1 + 4 * (base + (r() - 0.5) * 0.5), 1, 5));
      const answers: Record<string, number | string | boolean | null> = {
        sleep_hours: r() < 0.1 ? null : Math.round(clamp(6 + r() * 3.2 - (k === "leo" && d < 4 ? 2 : 0), 3, 11) * 2) / 2,
        sleep_quality: s5(),
        fatigue: s5(),
        soreness: k === "leo" && d < 3 ? 5 : s5(),
        stress: s5(),
        mood: r() < 0.15 ? null : s5(),
        readiness: Math.round(clamp(10 * (base + 0.3 + (r() - 0.5) * 0.4), 1, 10)),
        comments: null,
      };
      // One legacy partial response with most required items missing → readiness null.
      if (k === "jackson" && d === 5) Object.assign(answers, { fatigue: null, soreness: null, stress: null });
      responseRows.push({ orgId, athleteId: A[k], versionId: qv.id, forDate: date, answers, submittedBy: null, submittedAt: localToUtc(date, "07:15"), source: "teamwork", isDemo: true });
    }
  }
  await tx.insert(questionnaireResponses).values(responseRows);

  // -------------------------------------------------------------------------
  // Body map reports (self-reported; pain → review task)
  // -------------------------------------------------------------------------
  const bodySeeds: { k: string; daysAgo: number; view: "front" | "back"; region: string; side: "left" | "right" | "center"; kind: "soreness" | "pain"; severity: number; note?: string; review?: "new" | "reviewed" }[] = [
    { k: "maya", daysAgo: 6, view: "front", region: "quad", side: "right", kind: "soreness", severity: 4, note: "After plyo day", review: "reviewed" },
    { k: "maya", daysAgo: 1, view: "front", region: "knee", side: "left", kind: "pain", severity: 6, note: "Sharp on landing (sample)", review: "new" },
    { k: "leo", daysAgo: 2, view: "back", region: "hamstring", side: "left", kind: "soreness", severity: 8, note: "Tight after sprints", review: "new" },
    { k: "ethan", daysAgo: 3, view: "back", region: "lower_back", side: "center", kind: "soreness", severity: 3, review: "reviewed" },
    { k: "ava", daysAgo: 2, view: "front", region: "ankle_foot", side: "right", kind: "pain", severity: 5, note: "Rolled ankle at school (sample)", review: "new" },
  ];
  for (const b of bodySeeds) {
    const date = addDaysYmd(today, -b.daysAgo);
    const [rep] = await tx
      .insert(bodyRegionReports)
      .values({ orgId, athleteId: A[b.k], region: b.region, side: b.side, view: b.view, kind: b.kind, severity: b.severity, note: b.note ?? null, reportedAt: localToUtc(date, "07:30"), reviewStatus: b.review ?? "new", reviewNote: b.review === "reviewed" ? "Below review threshold (auto)" : null, isDemo: true })
      .returning();
    if (b.review === "new") {
      const coach = b.k === "ava" ? U.tess : U.marcus;
      const [t] = await tx
        .insert(tasks)
        .values({ orgId, title: `Review self-reported ${b.kind}: ${b.side === "center" ? "" : b.side + " "}${b.region.replace("_", " / ")} (${b.severity}/10)`, description: "Self-reported symptom from the body map. Not a diagnosis.", assigneeUserId: coach, relatedType: "body_region_report", relatedId: rep.id, priority: b.kind === "pain" || b.severity >= 8 ? "high" : "normal", source: "science.body_map", dedupeKey: `body_review:${rep.id}`, isDemo: true })
        .returning();
      await tx.update(bodyRegionReports).set({ reviewTaskId: t.id }).where(eq(bodyRegionReports.id, rep.id));
    }
  }

  // -------------------------------------------------------------------------
  // Habits + check-ins with missing days
  // -------------------------------------------------------------------------
  const habitStart = addDaysYmd(today, -27);
  const [hSleep] = await tx.insert(habits).values({ orgId, name: "Sleep 8h", description: "Aim for 8 hours of sleep.", targetValue: 8, targetUnit: "h", frequency: "daily", createdBy: U.marcus }).returning();
  const [hHyd] = await tx.insert(habits).values({ orgId, name: "Hydration", description: "Drink your target water.", targetValue: 2.5, targetUnit: "L", frequency: "daily", createdBy: U.marcus }).returning();
  const [hMob] = await tx.insert(habits).values({ orgId, name: "Mobility 10 min", description: "Hips + ankles routine.", targetValue: 10, targetUnit: "min", frequency: "weekdays", createdBy: U.marcus }).returning();
  await tx.insert(habitAssignments).values([
    { habitId: hSleep.id, groupId: ctx.groups.hs, startDate: habitStart },
    { habitId: hHyd.id, groupId: ctx.groups.hs, startDate: habitStart },
    { habitId: hMob.id, athleteId: A.maya, startDate: habitStart },
    { habitId: hMob.id, athleteId: A.dana, startDate: habitStart },
  ]);
  const habitRows: (typeof habitCheckins.$inferInsert)[] = [];
  const habitPlan: [typeof hSleep, string[]][] = [
    [hSleep, hs],
    [hHyd, hs],
    [hMob, ["maya", "dana"]],
  ];
  for (const [h, keys] of habitPlan) {
    for (const k of keys) {
      for (const d of expectedHabitDates(h.frequency, habitStart, addDaysYmd(today, -1))) {
        const x = r();
        if (x < 0.15) continue; // no check-in (distinct from "missed")
        const status: HabitStatus = x < 0.25 ? "missed" : x < 0.38 ? "partial" : "done";
        const value = h.targetValue == null ? null : status === "done" ? h.targetValue : status === "partial" ? Math.round(h.targetValue * 0.6 * 10) / 10 : null;
        habitRows.push({ orgId, habitId: h.id, athleteId: A[k], forDate: d, status, value });
      }
    }
  }
  // Maya: a clean recent streak.
  for (let d = 1; d <= 5; d++) {
    const date = addDaysYmd(today, -d);
    const i = habitRows.findIndex((x) => x.habitId === hSleep.id && x.athleteId === A.maya && x.forDate === date);
    const row = { orgId, habitId: hSleep.id, athleteId: A.maya, forDate: date, status: "done" as const, value: 8 };
    if (i >= 0) habitRows[i] = row;
    else habitRows.push(row);
  }
  await tx.insert(habitCheckins).values(habitRows);

  // -------------------------------------------------------------------------
  // Metric definitions & test types (vendor vs Teamwork kept separate)
  // -------------------------------------------------------------------------
  const md = async (v: typeof metricDefinitions.$inferInsert) => (await tx.insert(metricDefinitions).values(v).returning())[0];
  const mJump = await md({ orgId, key: "jump_height_imp_mom", name: "Jump Height (Imp-Mom)", unit: "m", higherIsBetter: true, category: "force_plate", definedBy: "hawkin", vendorMetricId: "Jump Height (Imp-Mom)", precision: 3, description: "Vendor metric reported by Hawkin Dynamics (impulse-momentum method)." });
  const mRsi = await md({ orgId, key: "mrsi", name: "mRSI", unit: "m/s", higherIsBetter: true, category: "force_plate", definedBy: "hawkin", vendorMetricId: "mRSI", precision: 2, description: "Vendor metric (RSI-modified) reported by Hawkin Dynamics." });
  const mPower = await md({ orgId, key: "peak_propulsive_power", name: "Peak Propulsive Power", unit: "W", higherIsBetter: true, category: "force_plate", definedBy: "hawkin", vendorMetricId: "Peak Propulsive Power", precision: 0 });
  const mAsym = await md({ orgId, key: "braking_asymmetry", name: "Braking Asymmetry", unit: "%", higherIsBetter: null, category: "force_plate", definedBy: "hawkin", vendorMetricId: "Braking Asymmetry", precision: 1, description: "Vendor-reported L/R braking asymmetry. Sign convention per vendor." });
  const m10 = await md({ orgId, key: "sprint_10yd", name: "10 yd sprint", unit: "s", higherIsBetter: false, category: "sprint", definedBy: "teamwork_manual", precision: 2, description: "Hand/electronic timed from a 3-point start." });
  const m40 = await md({ orgId, key: "sprint_40yd", name: "40 yd sprint", unit: "s", higherIsBetter: false, category: "sprint", definedBy: "teamwork_manual", precision: 2 });
  const mBroad = await md({ orgId, key: "broad_jump", name: "Broad Jump", unit: "cm", higherIsBetter: true, category: "jump", definedBy: "teamwork_manual", precision: 1, description: "Standing broad jump. Entries may be recorded in cm or in; views convert explicitly (1 in = 2.54 cm)." });
  Object.assign(ctx.extra.science, { mJump: mJump.id, mRsi: mRsi.id, mPower: mPower.id, mAsym: mAsym.id, m10: m10.id, m40: m40.id, mBroad: mBroad.id });

  const [ttCmj] = await tx.insert(testTypes).values({ orgId, key: "cmj", name: "Hawkin CMJ", vendor: "hawkin", vendorTestTypeId: "Countermovement Jump", protocol: "Hands on hips, 3 trials, 30 s rest.", trialSelection: "mean" }).returning();
  const [ttSprint] = await tx.insert(testTypes).values({ orgId, key: "sprint", name: "Teamwork Sprint", vendor: "teamwork", protocol: "10 yd and 40 yd from a 3-point start, 2–3 trials.", trialSelection: "best" }).returning();
  const [ttBroad] = await tx.insert(testTypes).values({ orgId, key: "broad_jump", name: "Broad Jump", vendor: "teamwork", protocol: "Two-foot takeoff, stick landing, measure to heel.", trialSelection: "best" }).returning();
  Object.assign(ctx.extra.science, { ttCmj: ttCmj.id, ttSprint: ttSprint.id, ttBroad: ttBroad.id });

  // CMJ sessions (Hawkin source): 3 trials + a vendor_mean aggregate row each.
  const cmjAthletes: [string, number][] = [["maya", 0.31], ["leo", 0.42], ["dana", 0.36], ["ethan", 0.38]];
  let firstMayaTrialForSignal: string | null = null;
  const kpiForReport: Record<string, { latest: number | null; first: number | null; latestDate: string | null; sessions: number }> = {};
  for (const [k, jh0] of cmjAthletes) {
    const sessionsVals: (number | null)[] = [];
    for (let s = 0; s < 5; s++) {
      const date = addDaysYmd(today, -(56 - s * 13));
      const at = localToUtc(date, "16:00");
      const [ts] = await tx
        .insert(testSessions)
        .values({ orgId, athleteId: A[k], testTypeId: ttCmj.id, testedAt: at, sourceTimestamp: fmt(at, "yyyy-MM-dd'T'HH:mm:ssxxx"), source: "hawkin", sourceRecordId: `demo-${orgId.slice(0, 8)}-cmj-${k}-${s}`, device: "Hawkin Dynamics (demo file)", isDemo: true })
        .returning();
      const jhs: (number | null)[] = [];
      const powers: number[] = [];
      for (let t = 1; t <= 3; t++) {
        const excluded = k === "maya" && s === 3 && t === 2;
        const [tr] = await tx
          .insert(trials)
          .values({ testSessionId: ts.id, trialNumber: t, performedAt: new Date(at.getTime() + t * 60_000), excluded, exclusionReason: excluded ? "Arm swing — protocol violation (demo)" : null, sourceTrialId: `t${t}` })
          .returning();
        if (k === "maya" && s === 4 && t === 1) firstMayaTrialForSignal = tr.id;
        const jh = Math.round((jh0 + s * 0.008 + (r() - 0.5) * 0.02 + (excluded ? 0.05 : 0)) * 1000) / 1000;
        const rsiNull = k === "leo" && s === 2 && t === 3; // vendor didn't report mRSI for this trial
        const power = Math.round(2600 + jh * 4000 + (r() - 0.5) * 200);
        if (!excluded) {
          jhs.push(jh);
          powers.push(power);
        }
        const mv = (metric: string, value: number | null, unit: string) => ({ orgId, athleteId: A[k], metricDefinitionId: metric, testSessionId: ts.id, trialId: tr.id, value, rawValue: value === null ? null : String(value), unit, recordedAt: at, source: "hawkin" as const, aggregation: "trial" as const, isDemo: true });
        await tx.insert(metricValues).values([
          mv(mJump.id, jh, "m"),
          mv(mRsi.id, rsiNull ? null : Math.round((jh / 0.82) * 100) / 100, "m/s"),
          mv(mPower.id, power, "W"),
          mv(mAsym.id, Math.round((r() - 0.5) * 16 * 10) / 10, "%"),
        ]);
      }
      // Vendor aggregate row: stored separately, flagged, never averaged with trials.
      const [agg] = await tx.insert(trials).values({ testSessionId: ts.id, trialNumber: null, isAggregate: true, aggregateKind: "vendor_mean", sourceTrialId: "vendor_mean" }).returning();
      const vendorMean = mean(jhs);
      await tx.insert(metricValues).values([
        { orgId, athleteId: A[k], metricDefinitionId: mJump.id, testSessionId: ts.id, trialId: agg.id, value: vendorMean === null ? null : Math.round(vendorMean * 1000) / 1000, rawValue: vendorMean?.toFixed(3) ?? null, unit: "m", recordedAt: at, source: "hawkin", aggregation: "vendor_mean", isDemo: true },
        { orgId, athleteId: A[k], metricDefinitionId: mPower.id, testSessionId: ts.id, trialId: agg.id, value: Math.round(mean(powers) ?? 0), rawValue: String(Math.round(mean(powers) ?? 0)), unit: "W", recordedAt: at, source: "hawkin", aggregation: "vendor_mean", isDemo: true },
      ]);
      sessionsVals.push(selectTrials(jhs.map((v, i) => ({ trialId: String(i), trialNumber: i, value: v, isAggregate: false, excluded: false })), "mean", true).value);
    }
    if (k === "maya") kpiForReport.jump = { first: sessionsVals[0], latest: sessionsVals.at(-1) ?? null, latestDate: addDaysYmd(today, -4), sessions: 5 };
  }

  // Raw force-time CSV for one Maya trial, written to the local object store.
  if (firstMayaTrialForSignal) {
    const lines = ["time_s,force_left_N,force_right_N"];
    const bw = 280; // per-side quiet standing force (N), synthetic
    for (let i = 0; i <= 1200; i++) {
      const t = i / 1000;
      let f = bw;
      if (t > 0.3 && t < 0.55) f = bw - 180 * Math.sin(((t - 0.3) / 0.25) * Math.PI); // unweighting
      else if (t >= 0.55 && t < 0.85) f = bw + 520 * Math.sin(((t - 0.55) / 0.3) * Math.PI); // braking + propulsion
      else if (t >= 0.85 && t < 1.25) f = 0; // flight
      if (t >= 1.25) f = bw;
      const noise = () => (r() - 0.5) * 6;
      const left = f === 0 ? 0 : f * 1.04 + noise();
      const right = f === 0 ? 0 : f * 0.96 + noise();
      lines.push(`${t.toFixed(3)},${left.toFixed(1)},${right.toFixed(1)}`);
    }
    const csv = lines.join("\n");
    const bytes = new TextEncoder().encode(csv);
    const key = `${orgId}/raw_signal/${today}/${randomUUID()}-cmj_force_time_demo.csv`;
    const root = process.env.STORAGE_DIR ?? "./.storage";
    const file = path.resolve(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    const [obj] = await tx
      .insert(storedObjects)
      .values({ orgId, storageKey: key, filename: "cmj_force_time_demo.csv", mimeType: "text/csv", sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), kind: "raw_signal", ownerPersonId: ctx.people.maya_parker, accessLevel: "staff" })
      .returning();
    await tx.insert(rawSignals).values({ orgId, trialId: firstMayaTrialForSignal, objectId: obj.id, sampleRateHz: 1000, channels: [{ name: "time_s", unit: "s" }, { name: "force_left_N", unit: "N" }, { name: "force_right_N", unit: "N" }], sampleCount: 1201 });
  }

  // Teamwork sprint + broad jump sessions (manual). Leo's broad jumps were recorded in inches.
  for (const [i, k] of hs.entries()) {
    for (let s = 0; s < 3; s++) {
      const date = addDaysYmd(today, -(42 - s * 18));
      const at = localToUtc(date, "17:00");
      const [ts] = await tx.insert(testSessions).values({ orgId, athleteId: A[k], testTypeId: ttSprint.id, testedAt: at, source: "teamwork_manual", isDemo: true }).returning();
      for (let t = 1; t <= 2; t++) {
        const [tr] = await tx.insert(trials).values({ testSessionId: ts.id, trialNumber: t, performedAt: at, sourceTrialId: `manual-${t}` }).returning();
        const ten = Math.round((1.95 - i * 0.02 - s * 0.03 + (r() - 0.5) * 0.06) * 100) / 100;
        const forty = Math.round((5.5 - i * 0.04 - s * 0.05 + (r() - 0.5) * 0.12) * 100) / 100;
        await tx.insert(metricValues).values([
          { orgId, athleteId: A[k], metricDefinitionId: m10.id, testSessionId: ts.id, trialId: tr.id, value: ten, rawValue: String(ten), unit: "s", recordedAt: at, source: "teamwork_manual", aggregation: "trial", isDemo: true },
          { orgId, athleteId: A[k], metricDefinitionId: m40.id, testSessionId: ts.id, trialId: tr.id, value: forty, rawValue: String(forty), unit: "s", recordedAt: at, source: "teamwork_manual", aggregation: "trial", isDemo: true },
        ]);
      }
      const [bs] = await tx.insert(testSessions).values({ orgId, athleteId: A[k], testTypeId: ttBroad.id, testedAt: localToUtc(date, "17:30"), source: "teamwork_manual", isDemo: true }).returning();
      for (let t = 1; t <= 2; t++) {
        const [tr] = await tx.insert(trials).values({ testSessionId: bs.id, trialNumber: t, sourceTrialId: `manual-${t}` }).returning();
        const cm = 205 + i * 6 + s * 4 + (r() - 0.5) * 8;
        const inInches = k === "leo" || (k === "maya" && s === 1);
        const value = inInches ? Math.round((cm / 2.54) * 10) / 10 : Math.round(cm);
        await tx.insert(metricValues).values({ orgId, athleteId: A[k], metricDefinitionId: mBroad.id, testSessionId: bs.id, trialId: tr.id, value, rawValue: String(value), unit: inInches ? "in" : "cm", recordedAt: bs.testedAt, source: "teamwork_manual", aggregation: "trial", isDemo: true });
      }
    }
  }

  // KPI targets & baselines.
  await tx.insert(kpiTargets).values([
    { orgId, athleteId: A.maya, metricDefinitionId: mJump.id, baselineValue: 0.31, baselineDate: addDaysYmd(today, -56), targetValue: 0.38, goalDate: addDaysYmd(today, 60), trialSelection: "mean", createdBy: U.marcus },
    { orgId, groupId: ctx.groups.hs, metricDefinitionId: m10.id, targetValue: 1.75, goalDate: addDaysYmd(today, 90), trialSelection: "best", createdBy: U.marcus },
    { orgId, athleteId: A.leo, metricDefinitionId: mBroad.id, baselineValue: 245, baselineDate: addDaysYmd(today, -42), targetValue: 265, goalDate: addDaysYmd(today, 90), trialSelection: "best", createdBy: U.marcus },
  ]);

  // -------------------------------------------------------------------------
  // Activity sessions (practices / games / explicit rest days)
  // -------------------------------------------------------------------------
  const actRows: (typeof activitySessions.$inferInsert)[] = [];
  for (const k of ["maya", "leo", "ethan", "sofia", "dana"]) {
    for (let d = 34; d >= 1; d--) {
      const date = addDaysYmd(today, -d);
      const wd = isoWeekday(date);
      const spike = k === "maya" && d <= 7 ? 1.6 : 1;
      if (k === "leo" && r() < 0.45) continue; // sparse logging → low coverage → ACWR null
      if (wd === 1 || wd === 2 || wd === 4) actRows.push({ orgId, athleteId: A[k], activityDate: date, kind: "practice", durationMinutes: Math.round((75 + r() * 30) * spike), sessionRpe: Math.round(clamp(5 + r() * 3, 1, 10)), enteredBy: U.marcus, isDemo: true });
      else if (wd === 6) actRows.push({ orgId, athleteId: A[k], activityDate: date, kind: "game", durationMinutes: 90, sessionRpe: Math.round(clamp(7 + r() * 2, 1, 10)), enteredBy: U.marcus, isDemo: true });
      else if (wd === 3 && k !== "leo") actRows.push({ orgId, athleteId: A[k], activityDate: date, kind: "conditioning", durationMinutes: Math.round(30 * spike), sessionRpe: 6, enteredBy: U.marcus, isDemo: true });
      else if (k !== "leo") actRows.push({ orgId, athleteId: A[k], activityDate: date, kind: "rest", enteredBy: U.marcus, isDemo: true });
    }
  }
  // One practice with a missing RPE: that day is "incomplete" (load unknown, never 0).
  actRows.push({ orgId, athleteId: A.ethan, activityDate: addDaysYmd(today, -9), kind: "other", durationMinutes: 40, sessionRpe: null, notes: "RPE not collected", enteredBy: U.marcus, isDemo: true });
  await tx.insert(activitySessions).values(actRows);

  // -------------------------------------------------------------------------
  // Wearables (sleep h, HRV ms, resting HR bpm) with missing days + provenance batch
  // -------------------------------------------------------------------------
  const [wb] = await tx
    .insert(importBatches)
    .values({ orgId, source: "wearable_csv", entityType: "wearable_observation", status: "committed", originalFilename: "demo_wearables.csv", mapping: { provider: "demo_band" }, coverageStart: addDaysYmd(today, -20), coverageEnd: addDaysYmd(today, -1), limitations: "Synthetic demo data — not from a real device.", createdBy: U.marcus, committedAt: new Date(), committedBy: U.marcus })
    .returning();
  const wRows: (typeof wearableObservations.$inferInsert)[] = [];
  for (const k of ["maya", "dana", "leo"]) {
    for (let d = 20; d >= 1; d--) {
      const date = addDaysYmd(today, -d);
      if (r() < 0.15) continue; // device not worn → no row at all
      const missing = r() < 0.06;
      wRows.push(
        { orgId, athleteId: A[k], provider: "demo_band", metricKey: "sleep_hours", observedOn: date, value: missing ? null : Math.round((6.5 + r() * 2.5) * 10) / 10, unit: "h", quality: missing ? "missing" : "measured", sourceRecordId: `${date}:sleep_hours`, importBatchId: wb.id },
        { orgId, athleteId: A[k], provider: "demo_band", metricKey: "hrv_rmssd", observedOn: date, value: Math.round(55 + r() * 40), unit: "ms", quality: "measured", sourceRecordId: `${date}:hrv_rmssd`, importBatchId: wb.id },
        { orgId, athleteId: A[k], provider: "demo_band", metricKey: "resting_hr", observedOn: date, value: Math.round(50 + r() * 12), unit: "bpm", quality: r() < 0.1 ? "device_estimate" : "measured", sourceRecordId: `${date}:resting_hr`, importBatchId: wb.id },
      );
    }
  }
  await tx.insert(wearableObservations).values(wRows);
  await tx.update(importBatches).set({ stats: { total: wRows.length, inserted: wRows.length } }).where(eq(importBatches.id, wb.id));

  // -------------------------------------------------------------------------
  // Volume demo: only when no training seed has produced set logs.
  // -------------------------------------------------------------------------
  const [{ n: setCount }] = await tx.select({ n: sql<number>`count(*)::int` }).from(setLogs).where(eq(setLogs.orgId, orgId));
  const strength: Record<string, { value: number; unit: string; date: string }> = {};
  if (setCount === 0) {
    const exDefs: (typeof exercises.$inferInsert)[] = [
      { orgId, name: "Back Squat", category: "Lower body strength", movementPattern: "squat", trackingType: "weight_reps", defaultUnit: "lb" },
      { orgId, name: "Bench Press", category: "Upper body strength", movementPattern: "horizontal_push", trackingType: "weight_reps", defaultUnit: "lb" },
      { orgId, name: "Bulgarian Split Squat", category: "Lower body strength", movementPattern: "single_leg", trackingType: "weight_reps", defaultUnit: "lb", isUnilateral: true },
      { orgId, name: "Push-up", category: "Upper body strength", movementPattern: "horizontal_push", trackingType: "bodyweight_reps", defaultUnit: "reps", bodyweightFactor: 0.64 },
      { orgId, name: "Sled Sprint", category: "Speed", movementPattern: "sprint", trackingType: "distance", defaultUnit: "m" },
    ];
    await tx.insert(exercises).values(exDefs).onConflictDoNothing();
    const exRows = await tx.select().from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.name, exDefs.map((e) => e.name))));
    const ex = Object.fromEntries(exRows.map((e) => [e.name, e]));
    // Leo's body mass is known (bodyweight tonnage counted); Maya's is not (excluded, reps still counted).
    await tx.update(athletes).set({ bodyMassKg: "75" }).where(eq(athletes.id, A.leo));
    await tx.insert(maxes).values([
      { orgId, athleteId: A.maya, exerciseId: ex["Back Squat"].id, value: "185", unit: "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(today, -40), source: "teamwork", enteredBy: U.marcus },
      { orgId, athleteId: A.maya, exerciseId: ex["Back Squat"].id, value: "205", unit: "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(today, -10), source: "teamwork", enteredBy: U.marcus },
      { orgId, athleteId: A.maya, exerciseId: ex["Bench Press"].id, value: "95", unit: "lb", kind: "estimated", method: "epley_v1", recordedOn: addDaysYmd(today, -20), source: "teamwork", enteredBy: U.marcus },
      { orgId, athleteId: A.leo, exerciseId: ex["Back Squat"].id, value: "120", unit: "kg", kind: "tested", method: "tested", recordedOn: addDaysYmd(today, -30), source: "teamwork", enteredBy: U.marcus },
    ]);
    strength.squat = { value: 205, unit: "lb", date: addDaysYmd(today, -10) };
    strength.bench = { value: 95, unit: "lb", date: addDaysYmd(today, -20) };
    for (const [k, unit, base] of [["maya", "lb", 135], ["leo", "kg", 80]] as const) {
      for (let w = 0; w < 6; w++) {
        const date = addDaysYmd(today, -(20 - w * 3));
        const [wo] = await tx
          .insert(workouts)
          .values({ orgId, athleteId: A[k], scheduledDate: date, title: `Strength ${String.fromCharCode(65 + (w % 2))} (demo)`, status: "completed", startedAt: localToUtc(date, "15:30"), completedAt: localToUtc(date, "16:30"), sessionRpe: 7, durationMinutes: 60, source: "teamwork", isDemo: true })
          .returning();
        const item = async (exName: string, i: number) =>
          (await tx.insert(workoutItems).values({ workoutId: wo.id, sortOrder: i, exerciseId: ex[exName].id, blockLabel: String.fromCharCode(65 + i), prescription: [{ sets: 3 }] }).returning())[0];
        const sl = (itemId: string, setIndex: number, v: Partial<typeof setLogs.$inferInsert>) => ({ orgId, workoutItemId: itemId, athleteId: A[k], setIndex, clientMutationId: `seed-${randomUUID()}`, loggedBy: U.marcus, loggedVia: "coach" as const, loggedAt: localToUtc(date, "16:00"), ...v });
        const sq = await item("Back Squat", 0);
        const load = base + w * (unit === "lb" ? 5 : 2.5);
        await tx.insert(setLogs).values([
          sl(sq.id, 0, { isWarmup: true, reps: 8, load: String(unit === "lb" ? 95 : 40), loadUnit: unit }),
          sl(sq.id, 1, { reps: 5, load: String(load), loadUnit: unit }),
          sl(sq.id, 2, { reps: 5, load: String(load), loadUnit: unit }),
          sl(sq.id, 3, { reps: 5, load: w === 2 ? null : String(load + (unit === "lb" ? 10 : 5)), loadUnit: w === 2 ? null : unit, note: w === 2 ? "Load not recorded" : null }),
        ]);
        const bss = await item("Bulgarian Split Squat", 1);
        await tx.insert(setLogs).values([
          sl(bss.id, 0, { side: "left", reps: 8, load: String(unit === "lb" ? 25 : 12), loadUnit: unit }),
          sl(bss.id, 0, { side: "right", reps: 8, load: String(unit === "lb" ? 25 : 12), loadUnit: unit }),
          sl(bss.id, 1, { side: "left", reps: 8, load: String(unit === "lb" ? 25 : 12), loadUnit: unit }),
          sl(bss.id, 1, { side: "right", reps: 7, load: String(unit === "lb" ? 25 : 12), loadUnit: unit }),
        ]);
        const pu = await item("Push-up", 2);
        await tx.insert(setLogs).values([sl(pu.id, 0, { reps: 15 }), sl(pu.id, 1, { reps: 12 })]);
        const sled = await item("Sled Sprint", 3);
        await tx.insert(setLogs).values([sl(sled.id, 0, { distanceM: "20", durationS: "4.1" }), sl(sled.id, 1, { distanceM: "20", durationS: "4.0" })]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // One coach-approved, shared progress report for Maya (wellness section OFF).
  // -------------------------------------------------------------------------
  const periodStart = addDaysYmd(today, -27);
  const periodEnd = addDaysYmd(today, -1);
  const mayaSleep = habitRows.filter((h) => h.athleteId === A.maya && h.habitId === hSleep.id);
  const sleepAdh = habitAdherence("daily", expectedHabitDates("daily", periodStart, periodEnd), new Map(mayaSleep.filter((h) => h.forDate! >= periodStart && h.forDate! <= periodEnd).map((h) => [h.forDate!, h.status as HabitStatus])));
  const mayaResponses = responseRows.filter((x) => x.athleteId === A.maya && x.forDate! >= periodStart && x.forDate! <= periodEnd);
  await tx.insert(progressReports).values({
    orgId,
    athleteId: A.maya,
    periodStart,
    periodEnd,
    includeWellness: false,
    coachSummary: "Maya's jump height is trending up and she has been consistent with sleep. Next block: landing mechanics and single-leg strength. (Sample summary)",
    status: "shared",
    createdBy: U.marcus,
    approvedBy: U.marcus,
    approvedAt: new Date(),
    content: {
      sections: { kpis: true, strength: true, habits: true, attendance: true, wellness: false },
      snapshot: {
        generatedAt: new Date().toISOString(),
        period: { start: periodStart, end: periodEnd },
        kpis: [
          { metric: "Jump Height (Imp-Mom)", unit: "m", source: "hawkin", precision: 3, higherIsBetter: true, latest: kpiForReport.jump?.latest ?? null, latestDate: kpiForReport.jump?.latestDate ?? null, baseline: 0.31, target: 0.38, changePct: kpiForReport.jump?.latest ? ((kpiForReport.jump.latest - 0.31) / 0.31) * 100 : null, sessions: 2 },
        ],
        strength: Object.entries(strength).map(([key, s]) => ({ exercise: key === "squat" ? "Back Squat" : "Bench Press", value: s.value, unit: s.unit, date: s.date, method: key === "squat" ? "tested" : "epley_v1", prInPeriod: s.date >= periodStart })),
        habits: [{ name: "Sleep 8h", adherencePct: sleepAdh.adherencePct, expected: sleepAdh.expected, done: sleepAdh.done, partial: sleepAdh.partial, missed: sleepAdh.missed, noCheckin: sleepAdh.noCheckin, streak: 5 }],
        attendance: null,
        // Wellness was captured (coach has health access) but the section is OFF, so families never see it.
        wellness: { respondedDays: mayaResponses.length, periodDays: 27, meanReadiness: mean(mayaResponses.map((x) => readinessV1(DAILY_READINESS, x.answers as Record<string, unknown>).score)), formula: "tw_readiness_v1" },
      },
    },
  });
}
