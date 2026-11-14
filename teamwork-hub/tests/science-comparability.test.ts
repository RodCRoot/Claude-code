import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareContexts, isRelativeToBodyMass, summarizeExclusions, type MeasurementContext } from "@/lib/science/comparability";
import { athleteMetricSeries, createTestType, recordTestSession } from "@/lib/science/kpis";
import { performanceSummary } from "@/lib/science/performance";
import { assembleSnapshot } from "@/lib/science/reports";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const base: MeasurementContext = { testTypeId: "tt-1", protocol: "Hands on hips, 3 trials, 30 s rest.", source: "hawkin", unit: "m", aggregation: "trial" };

describe("compareContexts (pure)", () => {
  it("identical contexts are comparable with no reasons", () => {
    expect(compareContexts(base, { ...base })).toEqual({ comparable: true, reasons: [] });
    // Protocol text is compared after whitespace/case normalization only.
    expect(compareContexts(base, { ...base, protocol: "  hands on hips,  3 trials, 30 s rest. " }).comparable).toBe(true);
  });

  it("a different test type is not comparable", () => {
    const r = compareContexts(base, { ...base, testTypeId: "tt-2" });
    expect(r.comparable).toBe(false);
    expect(r.reasons).toEqual(["Different test type."]);
  });

  it("a different or missing protocol is disclosed verbatim", () => {
    expect(compareContexts(base, { ...base, protocol: "Arm swing allowed, 3 trials." }).reasons).toEqual(['Different protocol: "Hands on hips, 3 trials, 30 s rest." vs "Arm swing allowed, 3 trials.".']);
    expect(compareContexts(base, { ...base, protocol: null }).reasons).toEqual(['Different protocol: "Hands on hips, 3 trials, 30 s rest." vs not recorded.']);
    expect(compareContexts({ ...base, protocol: null }, { ...base, protocol: null }).comparable).toBe(true);
  });

  it("vendor values and Teamwork-derived values are never compared, nor two calculation versions", () => {
    expect(compareContexts(base, { ...base, source: "teamwork_derived", formulaVersion: "asymmetry_v1" }).reasons).toEqual(["Different source: Hawkin (vendor) vs Teamwork-derived."]);
    const v1 = { ...base, source: "teamwork_derived", formulaVersion: "swc_02sd_v1" };
    expect(compareContexts(v1, { ...v1, formulaVersion: "swc_02sd_v2" }).reasons).toEqual(["Different calculation version: swc_02sd_v1 vs swc_02sd_v2."]);
    expect(compareContexts(v1, { ...v1 }).comparable).toBe(true);
  });

  it("units are accepted only with an exact conversion; nothing is invented", () => {
    expect(compareContexts({ ...base, unit: "cm" }, { ...base, unit: "in" }).comparable).toBe(true);
    expect(compareContexts({ ...base, unit: "m" }, { ...base, unit: "s" }).reasons).toEqual(["Units m and s cannot be converted exactly."]);
    expect(compareContexts({ ...base, unit: "W" }, { ...base, unit: "W/kg" }).reasons).toEqual(["Units W and W/kg cannot be converted exactly."]);
  });

  it("an individual trial is not comparable with a vendor mean or a derived value", () => {
    expect(compareContexts(base, { ...base, aggregation: "vendor_mean" }).reasons).toEqual(["Different aggregation level: individual trial vs vendor mean."]);
    expect(compareContexts(base, { ...base, aggregation: "derived" }).reasons).toEqual(["Different aggregation level: individual trial vs Teamwork-derived value."]);
  });

  it("relative metrics need body mass known for both measurements", () => {
    const rel = { ...base, unit: "W/kg", relativeToBodyMass: true };
    expect(compareContexts({ ...rel, bodyMassKnown: true }, { ...rel, bodyMassKnown: null }).reasons).toEqual(["Body mass was known for one measurement but not the other (relative metric)."]);
    expect(compareContexts({ ...rel, bodyMassKnown: true }, { ...rel, bodyMassKnown: true }).comparable).toBe(true);
    // Absolute metrics ignore body mass.
    expect(compareContexts({ ...base, bodyMassKnown: true }, { ...base, bodyMassKnown: false }).comparable).toBe(true);
    expect(isRelativeToBodyMass("W/kg")).toBe(true);
    expect(isRelativeToBodyMass("N/kg")).toBe(true);
    expect(isRelativeToBodyMass("kg")).toBe(false);
    expect(isRelativeToBodyMass("m/s")).toBe(false);
  });

  it("every failing rule is reported together", () => {
    const r = compareContexts(base, { testTypeId: "tt-9", protocol: null, source: "teamwork_manual", unit: "s", aggregation: "single" });
    expect(r.comparable).toBe(false);
    expect(r.reasons).toHaveLength(5);
  });

  it("summarizeExclusions counts repeated reasons in first-seen order", () => {
    expect(summarizeExclusions(["a", "b", "a"])).toEqual([
      { reason: "a", count: 2 },
      { reason: "b", count: 1 },
    ]);
    expect(summarizeExclusions([])).toEqual([]);
  });
});

describe("trend across two protocols (DB)", () => {
  const TODAY = "2026-03-02";
  let ctx: Awaited<ReturnType<typeof seedOrg>>;
  beforeAll(async () => {
    ctx = await seedOrg(TODAY, { modules: ["science"] });
  });
  afterAll(closeTestDb);
  const tx = () => testDb();

  it("sessions from a different protocol are excluded from the trend and disclosed, never merged", async () => {
    const rod = await viewerFor(ctx, "rod");
    // Eli (youth group) has no seeded broad-jump sessions. Record two with the standard protocol, then one with a different one.
    const athleteId = ctx.athletes.eli;
    const metricId = ctx.extra.science.mBroad as string;
    const standard = ctx.extra.science.ttBroad as string;
    const noStick = await createTestType(tx(), rod, { key: "broad_jump_no_stick", name: "Broad Jump (fall-forward landing)", vendor: "teamwork", protocol: "Two-foot takeoff, landing may fall forward, measure to heel.", trialSelection: "best" });
    await recordTestSession(tx(), rod, { athleteId, testTypeId: standard, date: "2026-01-10", values: [{ metricId, trialNumber: 1, value: 200, unit: "cm" }] });
    await recordTestSession(tx(), rod, { athleteId, testTypeId: noStick.id, date: "2026-02-01", values: [{ metricId, trialNumber: 1, value: 230, unit: "cm" }] });
    await recordTestSession(tx(), rod, { athleteId, testTypeId: standard, date: "2026-02-20", values: [{ metricId, trialNumber: 1, value: 210, unit: "cm" }] });

    const [s] = await athleteMetricSeries(tx(), rod, athleteId, { metricIds: [metricId] });
    // Reference = the latest session's protocol (standard). Only the standard sessions form the trend.
    expect(s.context?.testTypeId).toBe(standard);
    expect(s.points.map((p) => p.date)).toEqual(["2026-01-10", "2026-02-20"]);
    expect(s.latest?.value).toBe(210);
    expect(s.baseline).toEqual({ value: 200, date: "2026-01-10", source: "first_session" });
    expect(s.change).toBe(10);
    // The 230 cm result was not silently merged (it would otherwise be the "best" and bend the trend).
    expect(s.excludedPoints.map((p) => p.date)).toEqual(["2026-02-01"]);
    expect(s.excludedPoints[0].value).toBe(230);
    expect(s.excludedPoints[0].incomparable).toEqual([
      "Different test type.",
      'Different protocol: "Two-foot takeoff, stick landing, measure to heel." vs "Two-foot takeoff, landing may fall forward, measure to heel.".',
    ]);
    expect(s.excluded).toEqual([
      { reason: "Different test type.", count: 1 },
      { reason: 'Different protocol: "Two-foot takeoff, stick landing, measure to heel." vs "Two-foot takeoff, landing may fall forward, measure to heel.".', count: 1 },
    ]);
    // Disclosure reaches the family-facing summary and the frozen report snapshot.
    const summary = await performanceSummary(tx(), rod, athleteId, TODAY);
    const kpi = summary.kpis.find((k) => k.metric.id === metricId)!;
    expect(kpi.excluded.length).toBeGreaterThan(0);
    const snap = await assembleSnapshot(tx(), rod, athleteId, "2026-01-01", TODAY);
    const row = snap.kpis.find((k) => k.metric === "Broad Jump")!;
    expect(row.sessions).toBe(2);
    expect(row.latest).toBe(210);
    expect(row.excludedNote).toMatch(/1 result\(s\) measured a different way were not compared: Different test type\./);
  });

  it("seeded single-protocol series are unchanged (nothing excluded)", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const [jh] = await athleteMetricSeries(tx(), marcus, ctx.athletes.maya, { metricIds: [ctx.extra.science.mJump] });
    expect(jh.points).toHaveLength(5);
    expect(jh.excludedPoints).toEqual([]);
    expect(jh.excluded).toEqual([]);
    expect(jh.context).toMatchObject({ source: "hawkin", aggregation: "trial", unit: "m", relativeToBodyMass: false });
  });
});
