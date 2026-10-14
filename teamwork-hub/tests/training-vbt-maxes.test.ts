import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { exercises, maxes, vbtReadings } from "@/db/schema";
import { confirmVbtMax, lvPointsFromReadings, suggestVbtMaxes } from "@/lib/training/vbt-maxes";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02"; // seedOrg default (a Monday)

beforeAll(async () => {
  ctx = await seedOrg(TODAY);
});
afterAll(closeTestDb);

const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<T>) => testDb().transaction(fn);

async function exerciseByName(name: string) {
  const [ex] = await testDb()
    .select()
    .from(exercises)
    .where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, name)));
  expect(ex, `seed exercise "${name}"`).toBeTruthy();
  return ex;
}

// Synthetic bar-speed session: v = 1.2 − 0.005·load ⇒ 1RM at squat MVT 0.3 is 180 kg.
const SESSION: Array<{ loadKg: number; v: number }> = [
  { loadKg: 90, v: 0.76 },
  { loadKg: 90, v: 0.74 }, // duplicate load → readings average into one LV point
  { loadKg: 126, v: 0.57 },
  { loadKg: 153, v: 0.435 },
];

describe("lv_profile_v1 maxes from vbt_readings", () => {
  it("suggests an estimated 1RM from the athlete's own bar speeds", async () => {
    const squat = await exerciseByName("Back Squat");
    await testDb().insert(vbtReadings).values(
      SESSION.map((s, i) => ({
        orgId: ctx.orgId,
        athleteId: ctx.athletes.maya,
        exerciseId: squat.id,
        performedAt: new Date("2026-02-27T16:00:00Z"),
        load: String(s.loadKg),
        loadUnit: "kg",
        repNumber: 1,
        meanVelocityMs: s.v,
        device: "test-device",
        sourceRecordId: `lvp-${i}`,
      })),
    );

    const marcus = await viewerFor(ctx, "marcus");
    const suggestions = await tx((t) => suggestVbtMaxes(t, marcus, ctx.athletes.maya, { today: TODAY }));
    const s = suggestions.find((x) => x.exerciseName === "Back Squat");
    expect(s).toBeTruthy();
    expect(s!.method).toBe("lv_profile_v1");
    expect(s!.points).toHaveLength(3); // 90 (averaged), 126, 153
    expect(s!.readingsUsed).toBe(4);
    expect(s!.e1rmKg).toBeGreaterThan(175);
    expect(s!.e1rmKg).toBeLessThan(185);
  });

  it("confirm recomputes server-side and appends an estimated max in kg", async () => {
    const squat = await exerciseByName("Back Squat");
    const marcus = await viewerFor(ctx, "marcus");
    const r = await tx((t) => confirmVbtMax(t, marcus, { athleteId: ctx.athletes.maya, exerciseId: squat.id, today: TODAY }));
    expect(r.max.kind).toBe("estimated");
    expect(r.max.method).toBe("lv_profile_v1");
    expect(r.max.unit).toBe("kg");
    expect(Number(r.max.value)).toBeCloseTo(r.suggestion.e1rmKg, 1);
    const rows = await testDb()
      .select()
      .from(maxes)
      .where(and(eq(maxes.athleteId, ctx.athletes.maya), eq(maxes.method, "lv_profile_v1")));
    expect(rows).toHaveLength(1);
  });

  it("refuses when there is not enough load variety", async () => {
    const bench = await exerciseByName("Bench Press");
    await testDb().insert(vbtReadings).values({
      orgId: ctx.orgId,
      athleteId: ctx.athletes.maya,
      exerciseId: bench.id,
      performedAt: new Date("2026-02-27T16:30:00Z"),
      load: "60",
      loadUnit: "kg",
      repNumber: 1,
      meanVelocityMs: 0.5,
      device: "test-device",
      sourceRecordId: "lvp-single",
    });
    const marcus = await viewerFor(ctx, "marcus");
    await expect(
      tx((t) => confirmVbtMax(t, marcus, { athleteId: ctx.athletes.maya, exerciseId: bench.id, today: TODAY })),
    ).rejects.toThrow(/2\+ loads/);
  });

  it("stays inside coaching scope (authz)", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    await expect(tx((t) => suggestVbtMaxes(t, marcus, ctx.athletes.eli, { today: TODAY }))).rejects.toThrow();
  });

  it("lb readings convert to kg before fitting", () => {
    const { points } = lvPointsFromReadings([
      { loadKg: 100 * 0.45359237, meanVelocityMs: 0.7 },
      { loadKg: 100 * 0.45359237, meanVelocityMs: 0.72 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].loadKg).toBeCloseTo(45.4, 1);
    expect(points[0].velocityMs).toBeCloseTo(0.71, 2);
  });
});
