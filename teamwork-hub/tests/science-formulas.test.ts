import { describe, expect, it } from "vitest";
import type { QuestionDef } from "@/db/schema";
import {
  acwrRolling,
  asymmetryPct,
  changePct,
  completionStatus,
  computeVolume,
  convertUnit,
  dailyLoadSeries,
  expectedHabitDates,
  habitAdherence,
  habitStreak,
  intensityZone,
  KG_PER_LB,
  mean,
  monotonyStrain,
  readinessV1,
  selectDatedMax,
  selectTrials,
  srpeLoad,
  swcBand,
  wellnessFlags,
  addDaysYmdPure,
  type VolumeSet,
} from "@/lib/science/formulas";
import { heatOverlay, isValidSpot, needsReview, spotsFor } from "@/lib/science/body-regions";
import { parseForceCsv } from "@/lib/science/forceplate";
import { metricsAnchor, workoutLoadDate } from "@/lib/science/load";
import { localToUtc } from "@/lib/time";

describe("srpe_load_v1", () => {
  it("is duration × sRPE in AU", () => {
    expect(srpeLoad(60, 7)).toBe(420);
    expect(srpeLoad(0, 5)).toBe(0); // a real 0-minute session is 0, legitimately
  });
  it("is null (never 0) when an input is missing or out of range", () => {
    expect(srpeLoad(null, 7)).toBeNull();
    expect(srpeLoad(60, null)).toBeNull();
    expect(srpeLoad(60, 11)).toBeNull();
    expect(srpeLoad(-5, 5)).toBeNull();
  });
});

describe("daily load + acwr_rolling_v1", () => {
  const end = "2026-03-28";
  const start = addDaysYmdPure(end, -27);
  it("counts missing days as 0 ONLY when recorded as rest", () => {
    const s = dailyLoadSeries([{ date: start, durationMin: 60, rpe: 5 }, { date: addDaysYmdPure(start, 1), durationMin: null, rpe: null, kind: "rest" }], start, addDaysYmdPure(start, 2));
    expect(s.map((d) => d.status)).toEqual(["logged", "rest", "no_data"]);
    expect(s.map((d) => d.load)).toEqual([300, 0, null]);
  });
  it("a session missing RPE makes the day incomplete (null), not 0", () => {
    const s = dailyLoadSeries([{ date: start, durationMin: 60, rpe: 5 }, { date: start, durationMin: 30, rpe: null }], start, start);
    expect(s[0]).toMatchObject({ status: "incomplete", load: null });
  });
  it("computes the ratio with full coverage", () => {
    const entries = [];
    for (let i = 0; i < 28; i++) entries.push({ date: addDaysYmdPure(start, i), durationMin: i >= 21 ? 120 : 60, rpe: 5 });
    const a = acwrRolling(dailyLoadSeries(entries, start, end), end);
    expect(a.acuteMean).toBe(600);
    expect(a.chronicMean).toBe((21 * 300 + 7 * 600) / 28);
    expect(a.ratio).toBeCloseTo(600 / 375, 6);
    expect(a.chronicCoverage).toBe(1);
  });
  it("returns null with a coverage reason when gaps leave the chronic window under threshold", () => {
    const entries = [];
    for (let i = 0; i < 28; i += 2) entries.push({ date: addDaysYmdPure(start, i), durationMin: 60, rpe: 5 }); // 50% coverage
    const a = acwrRolling(dailyLoadSeries(entries, start, end), end, { minCoverage: 0.75 });
    expect(a.ratio).toBeNull();
    expect(a.chronicCoverage).toBe(0.5);
    expect(a.reason).toMatch(/coverage/i);
  });
  it("explicit rest days restore coverage (and contribute 0)", () => {
    const entries = [];
    for (let i = 0; i < 28; i++) entries.push(i % 2 ? { date: addDaysYmdPure(start, i), durationMin: null, rpe: null, kind: "rest" } : { date: addDaysYmdPure(start, i), durationMin: 60, rpe: 5 });
    const a = acwrRolling(dailyLoadSeries(entries, start, end), end);
    expect(a.chronicCoverage).toBe(1);
    expect(a.chronicMean).toBe(150);
    expect(a.ratio).not.toBeNull();
  });
  it("derived metrics anchor to yesterday until today's load is known", () => {
    const s = dailyLoadSeries([{ date: "2026-03-01", durationMin: 60, rpe: 5 }], "2026-03-01", "2026-03-02");
    expect(metricsAnchor(s, "2026-03-02")).toBe("2026-03-01");
    const s2 = dailyLoadSeries([{ date: "2026-03-02", durationMin: 60, rpe: 5 }], "2026-03-01", "2026-03-02");
    expect(metricsAnchor(s2, "2026-03-02")).toBe("2026-03-02");
  });
  it("monotony/strain require 7 known days", () => {
    const entries = [];
    for (let i = 0; i < 6; i++) entries.push({ date: addDaysYmdPure(end, -i), durationMin: 60 + i * 10, rpe: 5 });
    expect(monotonyStrain(dailyLoadSeries(entries, addDaysYmdPure(end, -6), end), end).monotony).toBeNull();
  });
});

describe("DST date bucketing (America/Indiana/Indianapolis)", () => {
  it("buckets a workout completed at 11:30 pm local into the local date across spring-forward", () => {
    // DST starts 2026-03-08 02:00 local. 23:30 EST on Mar 7 = 04:30Z Mar 8.
    expect(workoutLoadDate(new Date("2026-03-08T04:30:00Z"), "2026-03-07")).toBe("2026-03-07");
    // 23:30 EDT on Mar 8 = 03:30Z Mar 9 (offset changed to -4).
    expect(workoutLoadDate(new Date("2026-03-09T03:30:00Z"), "2026-03-08")).toBe("2026-03-08");
    // 00:30 EDT on Mar 9 = 04:30Z Mar 9 → Mar 9 (not Mar 8).
    expect(workoutLoadDate(new Date("2026-03-09T04:30:00Z"), "2026-03-08")).toBe("2026-03-09");
    expect(localToUtc("2026-03-08", "23:30").toISOString()).toBe("2026-03-09T03:30:00.000Z");
  });
  it("daily series across DST has exactly one bucket per calendar day", () => {
    const s = dailyLoadSeries([], "2026-03-07", "2026-03-09");
    expect(s.map((d) => d.date)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    const fall = dailyLoadSeries([], "2026-10-31", "2026-11-02");
    expect(fall.map((d) => d.date)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

const Q: QuestionDef[] = [
  { key: "sleep_hours", label: "Sleep", kind: "number", unit: "h", required: false },
  { key: "sleep_quality", label: "Sleep quality", kind: "scale", min: 1, max: 5, polarity: "higher_better", required: true },
  { key: "soreness", label: "Soreness", kind: "scale", min: 1, max: 5, polarity: "lower_better", required: true },
  { key: "stress", label: "Stress", kind: "scale", min: 1, max: 5, polarity: "lower_better", required: true },
  { key: "mood", label: "Mood", kind: "scale", min: 1, max: 5, polarity: "higher_better", required: false },
];

describe("tw_readiness_v1", () => {
  it("normalizes polarity and averages answered required scale items", () => {
    // sleep_quality 5 → 100, soreness 1 → 100, stress 3 → 50 ⇒ 83.33
    const r = readinessV1(Q, { sleep_quality: 5, soreness: 1, stress: 3, mood: 1 });
    expect(r.score).toBeCloseTo(83.333, 2);
    expect(r.eligible).toBe(3);
  });
  it("is null when fewer than half of the eligible items are answered", () => {
    expect(readinessV1(Q, { sleep_quality: 5, soreness: null, stress: null }).score).toBeNull();
    expect(readinessV1(Q, { sleep_quality: 5, soreness: 1, stress: null }).score).toBe(100); // 2 of 3 is enough
  });
  it("a missing response is null — never favorable", () => {
    expect(readinessV1(Q, null).score).toBeNull();
    expect(completionStatus(Q, null)).toBe("no_response");
    expect(wellnessFlags(Q, null, { soreness: { above: 3 } })).toEqual([]);
    expect(completionStatus(Q, { sleep_quality: 4, soreness: null, stress: 2 })).toBe("partial");
  });
  it("flags concerning answers by configurable thresholds", () => {
    const f = wellnessFlags(Q, { sleep_hours: 5, soreness: 5, stress: 2 }, { sleep_hours: { below: 6 }, soreness: { above: 3 } });
    expect(f.map((x) => x.key)).toEqual(["sleep_hours", "soreness"]);
  });
});

describe("averages treat null as missing, not zero", () => {
  it("mean ignores nulls and is null when empty", () => {
    expect(mean([10, null, 20])).toBe(15);
    expect(mean([null, null])).toBeNull();
    expect(changePct(null, 10)).toBeNull();
  });
});

const baseSet = (o: Partial<VolumeSet>): VolumeSet => ({
  id: Math.random().toString(),
  athleteId: "a",
  date: "2026-03-01",
  exerciseId: "sq",
  exerciseName: "Back Squat",
  category: "Lower",
  movementPattern: "squat",
  trackingType: "weight_reps",
  isUnilateral: false,
  bodyweightFactor: null,
  side: "both",
  isWarmup: false,
  completed: true,
  reps: 5,
  load: 100,
  loadUnit: "kg",
  durationS: null,
  distanceM: null,
  bodyMassKg: null,
  max: null,
  ...o,
});

describe("tonnage_v1 volume rules", () => {
  it("excludes warm-ups by default and includes them on toggle", () => {
    const sets = [baseSet({ isWarmup: true, load: 60 }), baseSet({})];
    expect(computeVolume(sets, { displayUnit: "kg", groupBy: "exercise" })[0]).toMatchObject({ tonnage: 500, reps: 5, excludedWarmup: 1 });
    expect(computeVolume(sets, { displayUnit: "kg", groupBy: "exercise", includeWarmups: true })[0].tonnage).toBe(800);
  });
  it("sums unilateral sets per side and labels them", () => {
    const sets = [baseSet({ exerciseId: "bss", side: "left", reps: 8, load: 20 }), baseSet({ exerciseId: "bss", side: "right", reps: 7, load: 20 })];
    const b = computeVolume(sets, { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(b).toMatchObject({ tonnageLeft: 160, tonnageRight: 140, tonnage: 300, reps: 15 });
  });
  it("bodyweight movements use factor × body mass, and are excluded from tonnage (reps counted) without mass", () => {
    const pu = { trackingType: "bodyweight_reps", bodyweightFactor: 0.64, load: null, loadUnit: null, reps: 10 } as const;
    const noMass = computeVolume([baseSet({ ...pu })], { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(noMass).toMatchObject({ tonnage: 0, setsInTonnage: 0, reps: 10, excludedBodyweightNoMass: 1 });
    const withMass = computeVolume([baseSet({ ...pu, bodyMassKg: 75 })], { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(withMass.tonnage).toBeCloseTo(0.64 * 75 * 10, 6);
  });
  it("sets with missing load are excluded from tonnage but counted in reps", () => {
    const b = computeVolume([baseSet({ load: null, loadUnit: null }), baseSet({})], { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(b).toMatchObject({ tonnage: 500, reps: 10, excludedMissingLoad: 1, setsInTonnage: 1 });
  });
  it("converts lb/kg explicitly to the display unit (0.45359237)", () => {
    const sets = [baseSet({ load: 225, loadUnit: "lb", reps: 1 }), baseSet({ load: 100, loadUnit: "kg", reps: 1 })];
    const kg = computeVolume(sets, { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(kg.tonnage).toBeCloseTo(225 * KG_PER_LB + 100, 9);
    const lb = computeVolume(sets, { displayUnit: "lb", groupBy: "exercise" })[0];
    expect(lb.tonnage).toBeCloseTo(225 + 100 / KG_PER_LB, 9);
  });
  it("keeps duration/distance separate from tonnage", () => {
    const b = computeVolume([baseSet({ trackingType: "distance", load: null, reps: null, distanceM: 20, durationS: 4 })], { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(b).toMatchObject({ tonnage: 0, distanceM: 20, durationS: 4, reps: 0 });
  });
});

describe("intensity_zone_v1 uses the dated max", () => {
  const maxes = [
    { recordedOn: "2026-01-01", value: 100, unit: "kg" },
    { recordedOn: "2026-02-15", value: 125, unit: "kg" },
  ];
  it("selects the most recent max on or before the set date (never a future max)", () => {
    expect(selectDatedMax(maxes, "2026-02-01")?.value).toBe(100);
    expect(selectDatedMax(maxes, "2026-02-15")?.value).toBe(125);
    expect(selectDatedMax(maxes, "2025-12-31")).toBeNull();
  });
  it("buckets sets by zone with unit conversion and a 'no max' bucket", () => {
    const early = baseSet({ date: "2026-02-01", load: 90, max: { value: 100, unit: "kg" } }); // 90%
    const late = baseSet({ date: "2026-03-01", load: 90, max: { value: 125, unit: "kg" } }); // 72%
    const lbSet = baseSet({ load: 176, loadUnit: "lb", max: { value: 100, unit: "kg" } }); // 79.8%
    const none = baseSet({ max: null });
    const b = computeVolume([early, late, lbSet, none], { displayUnit: "kg", groupBy: "exercise" })[0];
    expect(b.zones[">=90"].sets).toBe(1);
    expect(b.zones["70-80"].sets).toBe(2);
    expect(b.zones.no_max.sets).toBe(1);
    expect(intensityZone(59.99)).toBe("<60");
  });
});

describe("trial_selection_v1 — aggregates never double-counted", () => {
  const rows = [
    { trialId: "1", trialNumber: 1, value: 0.3, isAggregate: false, excluded: false },
    { trialId: "2", trialNumber: 2, value: 0.5, isAggregate: false, excluded: true },
    { trialId: "3", trialNumber: 3, value: 0.36, isAggregate: false, excluded: false },
    { trialId: "4", trialNumber: 4, value: null, isAggregate: false, excluded: false },
    { trialId: "agg", trialNumber: null, value: 0.9, isAggregate: true, excluded: false },
  ];
  it("mean excludes the vendor aggregate row, excluded trials, and nulls", () => {
    const r = selectTrials(rows, "mean", true);
    expect(r.value).toBeCloseTo(0.33, 9);
    expect(r.n).toBe(2);
    expect(r.vendorAggregate).toBe(0.9);
  });
  it("best respects direction; latest uses trial order", () => {
    expect(selectTrials(rows, "best", true).value).toBe(0.36);
    expect(selectTrials(rows, "best", false).value).toBe(0.3);
    expect(selectTrials(rows, "latest", true).value).toBe(0.36);
    expect(selectTrials(rows, "best", null).value).toBeNull();
  });
});

describe("units — never compared without explicit conversion", () => {
  it("converts cm ↔ in exactly and refuses incompatible units", () => {
    expect(convertUnit(100, "in", "cm")).toBeCloseTo(254, 9);
    expect(convertUnit(254, "cm", "in")).toBeCloseTo(100, 9);
    expect(convertUnit(10, "cm", "s")).toBeNull();
    expect(convertUnit(10, "cm", "kg")).toBeNull();
    expect(convertUnit(null, "cm", "in")).toBeNull();
  });
});

describe("swc / asymmetry / habits", () => {
  it("SWC needs ≥ 3 sessions and is 0.2 × SD", () => {
    expect(swcBand([1, 2])).toBeNull();
    expect(swcBand([1, 2, 3])).toBeCloseTo(0.2, 9);
  });
  it("asymmetry is signed and null-safe", () => {
    expect(asymmetryPct(110, 90)).toBeCloseTo(20, 9);
    expect(asymmetryPct(null, 90)).toBeNull();
  });
  it("adherence separates explicit 'missed' from no check-in", () => {
    const exp = expectedHabitDates("daily", "2026-03-01", "2026-03-04");
    const a = habitAdherence("daily", exp, new Map([["2026-03-01", "done"], ["2026-03-02", "partial"], ["2026-03-03", "missed"]]));
    expect(a).toMatchObject({ expected: 4, done: 1, partial: 1, missed: 1, noCheckin: 1 });
    expect(a.adherencePct).toBeCloseTo(37.5, 9);
  });
  it("weekday habits skip weekends; streak ignores an unanswered today", () => {
    expect(expectedHabitDates("weekdays", "2026-03-06", "2026-03-09")).toEqual(["2026-03-06", "2026-03-09"]);
    const exp = expectedHabitDates("daily", "2026-03-01", "2026-03-04");
    expect(habitStreak("daily", exp, new Map([["2026-03-02", "done"], ["2026-03-03", "done"]]), "2026-03-04")).toBe(2);
    expect(habitStreak("daily", exp, new Map([["2026-03-03", "missed"]]), "2026-03-04")).toBe(0);
  });
});

describe("body map", () => {
  it("maps front-view viewer-left to the athlete's right", () => {
    const front = spotsFor("front").filter((s) => s.region === "knee");
    const leftmost = front.reduce((a, b) => ((a.shape as { cx: number }).cx < (b.shape as { cx: number }).cx ? a : b));
    expect(leftmost.side).toBe("right");
    const back = spotsFor("back").filter((s) => s.region === "knee");
    const backLeftmost = back.reduce((a, b) => ((a.shape as { cx: number }).cx < (b.shape as { cx: number }).cx ? a : b));
    expect(backLeftmost.side).toBe("left");
  });
  it("validates region/view/side combinations", () => {
    expect(isValidSpot("front", "chest", "center")).toBe(true);
    expect(isValidSpot("back", "chest", "center")).toBe(false);
    expect(isValidSpot("front", "knee", "center")).toBe(false);
  });
  it("review rule: pain always, soreness at/above threshold", () => {
    expect(needsReview("pain", 1, 7)).toBe(true);
    expect(needsReview("soreness", 6, 7)).toBe(false);
    expect(needsReview("soreness", 7, 7)).toBe(true);
  });
  it("heat overlay keeps max recent severity", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const h = heatOverlay(
      [
        { region: "knee", side: "left", severity: 3, kind: "soreness", reportedAt: "2026-03-09T12:00:00Z" },
        { region: "knee", side: "left", severity: 6, kind: "pain", reportedAt: "2026-03-08T12:00:00Z" },
        { region: "knee", side: "left", severity: 9, kind: "pain", reportedAt: "2026-01-01T12:00:00Z" },
      ],
      now,
      14,
    );
    expect(h.get("knee:left")).toEqual({ severity: 6, pain: true, count: 2 });
  });
});

describe("raw force-time CSV", () => {
  it("parses channels, peaks, and Teamwork-derived asymmetry", () => {
    const t = parseForceCsv("time_s,force_left_N,force_right_N\n0,100,100\n0.001,600,500\n0.002,,400\n");
    expect(t.samples).toBe(3);
    expect(t.peakLeftN).toBe(600);
    expect(t.peakRightN).toBe(500);
    expect(t.points[2].left).toBeNull();
    expect(t.peakAsymmetryPct).toBeCloseTo((100 / 550) * 100, 6);
  });
});
