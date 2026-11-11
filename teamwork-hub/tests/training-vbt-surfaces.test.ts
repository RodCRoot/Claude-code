import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { athletes, auditEvents, exercises, externalIds, importRows, maxes, metricDefinitions, metricValues, vbtMaxDismissals, vbtReadings, workoutItems, workouts } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { loadMeasuredMaxes } from "@/lib/community/stats";
import { leaderboardsFor } from "@/lib/community/leaderboards";
import { loadActivity } from "@/lib/engagement/sync";
import { resolveIdentity, reviewGroups } from "@/lib/imports/batches";
import { strengthPrs } from "@/lib/science/kpis";
import { buildCatalog } from "@/lib/showcase/catalog";
import { computeRecap } from "@/lib/showcase/recap";
import { TrainingError } from "@/lib/training/common";
import { applySetMutation, MANUAL_VBT_DEVICE, setMutationSchema, workoutDetail } from "@/lib/training/logging";
import { maxAsOf } from "@/lib/training/loads";
import { importVbtCsv } from "@/lib/training/reports";
import { bodyMassFor, canSeeRelativeStrength, relativeStrengthFor } from "@/lib/training/rel-strength";
import { BAR_SPEED_SOURCE, isBarSpeedMethod, pctFromVelocity } from "@/lib/training/vbt";
import { loadUnitFromHeaders, normalizeVbtHeader, wrongVelocityUnits } from "@/lib/training/vbt-csv";
import { confirmVbtMax, dismissVbtMax, pendingVbtSuggestions, storeValueFor } from "@/lib/training/vbt-maxes";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { confirmAndCommit, fixture } from "./imports.helpers";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02"; // a Monday: the HS group (Maya) trains today

beforeAll(async () => {
  ctx = await seedOrg(TODAY); // includes the synthetic "vbt" seed: Maya's Back Squat and Bench Press bar speeds
});
afterAll(closeTestDb);

type T = Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0];
const tx = <R>(fn: (t: T) => Promise<R>) => testDb().transaction(fn);
const text = (rel: string) => new TextDecoder().decode(fixture(rel));

async function ex(name: string) {
  const [e] = await testDb().select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, name)));
  expect(e, `exercise ${name}`).toBeTruthy();
  return e;
}
const audits = (action: string) => testDb().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, action)));

describe("estimated max from bar speed: suggest, dismiss, confirm", () => {
  it("suggests from seeded synthetic data, in the unit the athlete's max is kept in, and only to staff who can write", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const list = await tx((t) => pendingVbtSuggestions(t, marcus, ctx.athletes.maya, { today: TODAY }));
    expect(list.map((s) => s.exerciseName)).toEqual(["Back Squat", "Bench Press"]);
    const squat = list[0];
    expect(squat.method).toBe("lv_profile_v1");
    expect(squat.e1rmKg).toBeGreaterThan(105);
    expect(squat.e1rmKg).toBeLessThan(120);
    expect(squat.store.unit).toBe("lb"); // Maya's maxes are in lb
    expect(squat.store.value).toBeCloseTo(squat.e1rmKg / 0.45359237, 1);
    expect(squat.current?.kind).toBe("tested");

    for (const who of ["alex", "jordan", "maya", "erin", "tess", "chris"]) {
      const v = await viewerFor(ctx, who);
      await expect(tx((t) => pendingVbtSuggestions(t, v, ctx.athletes.maya, { today: TODAY })), who).rejects.toBeInstanceOf(AuthzError);
      await expect(tx((t) => confirmVbtMax(t, v, { athleteId: ctx.athletes.maya, exerciseId: squat.exerciseId, today: TODAY })), who).rejects.toBeInstanceOf(AuthzError);
      await expect(tx((t) => dismissVbtMax(t, v, { athleteId: ctx.athletes.maya, exerciseId: squat.exerciseId, today: TODAY })), who).rejects.toBeInstanceOf(AuthzError);
    }
    // Nothing was applied just by looking.
    const stored = await testDb().select().from(maxes).where(and(eq(maxes.orgId, ctx.orgId), eq(maxes.source, BAR_SPEED_SOURCE)));
    expect(stored).toHaveLength(0);
  });

  it("stores kg when the athlete's max is in kg or there is none and the exercise is kg", () => {
    expect(storeValueFor(100, "kg", "lb")).toEqual({ unit: "kg", value: 100 });
    expect(storeValueFor(100, null, "kg")).toEqual({ unit: "kg", value: 100 });
    expect(storeValueFor(100, null, "lb")).toEqual({ unit: "lb", value: 220.5 });
    expect(storeValueFor(100, "lb", "kg")).toEqual({ unit: "lb", value: 220.5 });
  });

  it("dismiss stores no max, is audited, hides the suggestion, and new data brings it back", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const bench = await ex("Bench Press");
    const before = await testDb().select().from(maxes).where(and(eq(maxes.athleteId, ctx.athletes.maya), eq(maxes.exerciseId, bench.id)));
    const d = await tx((t) => dismissVbtMax(t, marcus, { athleteId: ctx.athletes.maya, exerciseId: bench.id, today: TODAY }));
    expect(d.dismissedBy).toBe(marcus.userId);
    const after = await testDb().select().from(maxes).where(and(eq(maxes.athleteId, ctx.athletes.maya), eq(maxes.exerciseId, bench.id)));
    expect(after).toHaveLength(before.length);
    expect((await audits("training.max.dismiss_bar_speed")).some((a) => a.entityId === d.id)).toBe(true);
    let list = await tx((t) => pendingVbtSuggestions(t, marcus, ctx.athletes.maya, { today: TODAY }));
    expect(list.map((s) => s.exerciseName)).toEqual(["Back Squat"]);

    await testDb().insert(vbtReadings).values({ orgId: ctx.orgId, athleteId: ctx.athletes.maya, exerciseId: bench.id, performedAt: new Date("2026-03-01T21:00:00Z"), load: "67.5", loadUnit: "kg", meanVelocityMs: 0.29, device: "test", sourceRecordId: `t-${randomUUID()}` });
    list = await tx((t) => pendingVbtSuggestions(t, marcus, ctx.athletes.maya, { today: TODAY }));
    expect(list.map((s) => s.exerciseName)).toEqual(["Back Squat", "Bench Press"]);
    const clean = await ex("Power Clean");
    await expect(tx((t) => dismissVbtMax(t, marcus, { athleteId: ctx.athletes.maya, exerciseId: clean.id, today: TODAY }))).rejects.toBeInstanceOf(TrainingError);
  });

  it("confirm appends an estimated max marked as from bar speed, audited, and never as tested", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const squat = await ex("Back Squat");
    const r = await tx((t) => confirmVbtMax(t, marcus, { athleteId: ctx.athletes.maya, exerciseId: squat.id, today: TODAY }));
    expect(r.max).toMatchObject({ kind: "estimated", method: "lv_profile_v1", source: BAR_SPEED_SOURCE, unit: "lb", recordedOn: TODAY, enteredBy: marcus.userId });
    expect(isBarSpeedMethod(r.max.method)).toBe(true);
    const a = (await audits("training.max.confirm_bar_speed")).find((x) => x.entityId === r.max.id);
    expect(a?.summary).toMatch(/estimated from bar speed/);
    expect(a?.actorUserId).toBe(marcus.userId);
    // It goes through the normal max machinery: it is now the dated max used for % loads, labelled estimated.
    const cur = await tx((t) => maxAsOf(t, ctx.orgId, ctx.athletes.maya, squat.id, TODAY));
    expect(cur?.id).toBe(r.max.id);
    expect(cur?.kind).toBe("estimated");
    // Decided: no longer pending.
    const list = await tx((t) => pendingVbtSuggestions(t, marcus, ctx.athletes.maya, { today: TODAY }));
    expect(list.map((s) => s.exerciseName)).not.toContain("Back Squat");
  });
});

describe("estimates never appear as measured maxes", () => {
  it("leaderboards, showcase, recap, PRs/XP and the family strength table ignore bar-speed maxes", async () => {
    const squat = await ex("Back Squat");
    const rdl = await ex("Romanian Deadlift"); // Maya has no measured max here
    // Worst case: estimates far above anything tested, and one for a lift with no tested max at all.
    const [big, lone] = await testDb()
      .insert(maxes)
      .values([
        { orgId: ctx.orgId, athleteId: ctx.athletes.maya, exerciseId: squat.id, value: "999", unit: "lb", kind: "estimated", method: "lv_profile_v1", source: BAR_SPEED_SOURCE, recordedOn: TODAY },
        { orgId: ctx.orgId, athleteId: ctx.athletes.maya, exerciseId: rdl.id, value: "888", unit: "lb", kind: "estimated", method: "lv_profile_v1", source: BAR_SPEED_SOURCE, recordedOn: TODAY },
      ])
      .returning();
    const barSpeed = await testDb().select().from(maxes).where(and(eq(maxes.orgId, ctx.orgId), eq(maxes.source, BAR_SPEED_SOURCE)));
    expect(barSpeed.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(barSpeed.map((m) => m.id));

    const measured = await tx((t) => loadMeasuredMaxes(t, ctx.orgId));
    expect(measured.rows.some((m) => ids.has(m.id))).toBe(false);
    expect(measured.rows.every((m) => m.kind !== "estimated")).toBe(true);

    for (const who of ["rod", "alex", "chris"]) {
      const view = await tx(async (t) => leaderboardsFor(t, await viewerFor(ctx, who), { today: TODAY }));
      const json = JSON.stringify(view);
      expect(json, who).not.toContain("999");
      expect(json, who).not.toContain("888");
      expect(json, who).not.toMatch(/bodyMass|body_mass|61\.2/); // body weight never reaches a board payload
    }

    const catalog = (await tx((t) => buildCatalog(t, ctx.orgId, ctx.athletes.maya, { includeTraining: true, today: TODAY })))!;
    const lifts = catalog.lifts ?? [];
    expect(lifts.some((l) => l.exerciseId === rdl.id)).toBe(false);
    const cSquat = lifts.find((l) => l.exerciseId === squat.id)!;
    expect(cSquat.basis).toBe("measured");
    expect(cSquat.value).toBeLessThan(400);
    expect(lifts.some((l) => isBarSpeedMethod(l.method))).toBe(false);

    const activity = await tx((t) => loadActivity(t, ctx.orgId, ctx.athletes.maya));
    expect(activity.prs.some((p) => ids.has(p.maxId))).toBe(false);
    const recap = await tx((t) => computeRecap(t, ctx.orgId, ctx.athletes.maya, TODAY.slice(0, 7), { today: TODAY }));
    expect(JSON.stringify(recap)).not.toMatch(/999|888/);

    const alex = await viewerFor(ctx, "alex");
    const prs = await tx((t) => strengthPrs(t, alex, ctx.athletes.maya, {}));
    expect(prs.some((p) => p.exercise === "Romanian Deadlift")).toBe(false);
    expect(prs.find((p) => p.exercise === "Back Squat")!.best.value).toBeLessThan(400);
    await testDb().delete(maxes).where(inArray(maxes.id, [big.id, lone.id]));
  });
});

describe("live %1RM next to bar speed in the logger and weight room", () => {
  async function todaysWorkout(athleteKey: string) {
    const [w] = await testDb().select().from(workouts).where(and(eq(workouts.orgId, ctx.orgId), eq(workouts.athleteId, ctx.athletes[athleteKey]), eq(workouts.scheduledDate, TODAY)));
    expect(w, `${athleteKey} workout today`).toBeTruthy();
    return w;
  }

  it("offers the estimate only for lifts with enough bar-speed data; other lifts and athletes get nothing", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const maya = await tx(async (t) => workoutDetail(t, marcus, (await todaysWorkout("maya")).id));
    const withVbt = maya.items.filter((i) => i.vbt);
    expect(withVbt.length).toBeGreaterThan(0);
    for (const i of withVbt) expect(["Back Squat", "Bench Press"]).toContain(i.performed.name);
    const squat = maya.items.find((i) => i.performed.name === "Back Squat");
    if (squat) {
      expect(squat.vbt).toEqual({ profile: "squat", mvtMs: 0.3, method: "mpv_squat_v1" });
      expect(pctFromVelocity(0.75, squat.vbt!.profile, squat.vbt!.mvtMs)).toBeCloseTo(67.3, 1);
    }
    expect(maya.items.filter((i) => !["Back Squat", "Bench Press"].includes(i.performed.name)).every((i) => i.vbt === null)).toBe(true);
    // Leo has no bar-speed data at all: nothing is offered for any lift.
    const leo = await tx(async (t) => workoutDetail(t, marcus, (await todaysWorkout("leo")).id));
    expect(leo.items.length).toBeGreaterThan(0);
    expect(leo.items.every((i) => i.vbt === null)).toBe(true);
  });

  it("a typed bar speed is stored with the set, can be cleared, and 0 is refused", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const w = await todaysWorkout("leo");
    const detail = await tx((t) => workoutDetail(t, marcus, w.id));
    const item = detail.items.find((i) => i.performed.trackingType === "weight_reps")!;
    const base = { workoutItemId: item.id, setIndex: 0, side: "both" as const, reps: 5, load: 135, loadUnit: "lb" as const };
    const r1 = await tx((t) => applySetMutation(t, marcus, { ...base, clientMutationId: `m-${randomUUID()}`, meanVelocityMs: 0.71, loggedAt: Date.now() - 3000 }, "weight_room"));
    expect(r1.status).toBe("applied");
    const setLogId = (r1 as { setLogId: string }).setLogId;
    let rows = await testDb().select().from(vbtReadings).where(eq(vbtReadings.setLogId, setLogId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ athleteId: ctx.athletes.leo, exerciseId: item.performed.id, meanVelocityMs: 0.71, device: MANUAL_VBT_DEVICE, loadUnit: "lb" });
    expect((await tx((t) => workoutDetail(t, marcus, w.id))).items.find((i) => i.id === item.id)!.logs[0].meanVelocityMs).toBe(0.71);

    // Omitted (e.g. "Done as prescribed" or an older client): the stored speed is left alone.
    await tx((t) => applySetMutation(t, marcus, { ...base, clientMutationId: `m-${randomUUID()}`, loggedAt: Date.now() - 2000 }, "weight_room"));
    rows = await testDb().select().from(vbtReadings).where(eq(vbtReadings.setLogId, setLogId));
    expect(rows[0].meanVelocityMs).toBe(0.71);
    // Update keeps one reading per set.
    await tx((t) => applySetMutation(t, marcus, { ...base, clientMutationId: `m-${randomUUID()}`, meanVelocityMs: 0.65, loggedAt: Date.now() - 1000 }, "weight_room"));
    rows = await testDb().select().from(vbtReadings).where(eq(vbtReadings.setLogId, setLogId));
    expect(rows.map((r) => r.meanVelocityMs)).toEqual([0.65]);
    // Explicit null clears it; the log then reads null, never 0.
    await tx((t) => applySetMutation(t, marcus, { ...base, clientMutationId: `m-${randomUUID()}`, meanVelocityMs: null, loggedAt: Date.now() }, "weight_room"));
    expect(await testDb().select().from(vbtReadings).where(eq(vbtReadings.setLogId, setLogId))).toHaveLength(0);
    expect((await tx((t) => workoutDetail(t, marcus, w.id))).items.find((i) => i.id === item.id)!.logs[0].meanVelocityMs).toBeNull();

    expect(setMutationSchema.safeParse({ ...base, clientMutationId: "abcdefgh", meanVelocityMs: 0 }).success).toBe(false);
    expect(setMutationSchema.safeParse({ ...base, clientMutationId: "abcdefgh", meanVelocityMs: -0.5 }).success).toBe(false);

    // A guardian cannot log a speed for someone else's child.
    const chris = await viewerFor(ctx, "chris");
    await expect(tx((t) => applySetMutation(t, chris, { ...base, clientMutationId: `m-${randomUUID()}`, meanVelocityMs: 0.5 }))).rejects.toBeInstanceOf(AuthzError);
    void workoutItems;
  });
});

describe("relative strength (staff with health access only)", () => {
  it("uses recorded body weight, names its method, and is null (not 0) without one", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const view = await tx((t) => relativeStrengthFor(t, marcus, ctx.athletes.maya));
    expect(view.method).toBe("rel_strength_v1");
    expect(view.bodyMass).toEqual({ kg: 61.2, source: "recorded", measuredOn: null });
    const clean = view.rows.find((r) => r.exerciseName === "Power Clean")!;
    expect(clean.max.kind).toBe("tested");
    expect(clean.xbw).toBeCloseTo((clean.max.value * 0.45359237) / 61.2, 2);
    expect(clean.tier).toBeTruthy();
    const squat = view.rows.find((r) => r.exerciseName === "Back Squat")!;
    expect(squat.fromBarSpeed).toBe(true); // the confirmed estimate is the current max and is labelled as such
    expect(squat.estimated).toBe(true);

    await testDb().update(athletes).set({ bodyMassKg: null }).where(eq(athletes.id, ctx.athletes.ethan));
    const none = await tx((t) => relativeStrengthFor(t, marcus, ctx.athletes.ethan));
    expect(none.bodyMass).toBeNull();
    expect(none.rows.length).toBeGreaterThan(0);
    expect(none.rows.every((r) => r.xbw === null && r.tier === null)).toBe(true);
  });

  it("prefers the latest included Hawkin body-weight trial and converts lb and N explicitly", async () => {
    const [def] = await testDb()
      .insert(metricDefinitions)
      .values({ orgId: ctx.orgId, key: "body_weight__kg", name: "Body Weight", unit: "kg", category: "force_plate", definedBy: "hawkin" })
      .returning();
    await testDb().insert(metricValues).values([
      { orgId: ctx.orgId, athleteId: ctx.athletes.maya, metricDefinitionId: def.id, value: 62.4, unit: "kg", recordedAt: new Date("2026-02-20T21:00:00Z"), source: "hawkin", aggregation: "trial" },
      { orgId: ctx.orgId, athleteId: ctx.athletes.maya, metricDefinitionId: def.id, value: null, unit: "kg", recordedAt: new Date("2026-02-27T21:00:00Z"), source: "hawkin", aggregation: "trial" },
      { orgId: ctx.orgId, athleteId: ctx.athletes.leo, metricDefinitionId: def.id, value: 165, unit: "lb", recordedAt: new Date("2026-02-20T21:00:00Z"), source: "hawkin", aggregation: "trial" },
    ]);
    expect(await tx((t) => bodyMassFor(t, ctx.orgId, ctx.athletes.maya))).toEqual({ kg: 62.4, source: "hawkin_trial", measuredOn: "2026-02-20" });
    expect((await tx((t) => bodyMassFor(t, ctx.orgId, ctx.athletes.leo)))!.kg).toBeCloseTo(74.8, 1);
    await testDb().delete(metricValues).where(eq(metricValues.metricDefinitionId, def.id));
  });

  it("is refused for operations, guardians (with or without health access), athletes and other coaches", async () => {
    for (const who of ["erin", "alex", "jordan", "maya", "chris", "tess"]) {
      const v = await viewerFor(ctx, who);
      expect(await tx((t) => canSeeRelativeStrength(t, v, ctx.athletes.maya)), who).toBe(false);
      await expect(tx((t) => relativeStrengthFor(t, v, ctx.athletes.maya)), who).rejects.toBeInstanceOf(AuthzError);
    }
    for (const who of ["rod", "marcus"]) expect(await tx(async (t) => canSeeRelativeStrength(t, await viewerFor(ctx, who), ctx.athletes.maya)), who).toBe(true);
  });
});

describe("bar-speed CSV import (GymAware-style headers)", () => {
  it("header helpers strip units and read the load unit", () => {
    expect(normalizeVbtHeader("Mean Velocity (m/s)")).toEqual({ key: "mean_velocity", unit: "m/s" });
    expect(normalizeVbtHeader(" Weight [kg] ")).toEqual({ key: "weight", unit: "kg" });
    expect(normalizeVbtHeader("Rep #")).toEqual({ key: "rep_number", unit: null });
    expect(normalizeVbtHeader("athlete_external_id")).toEqual({ key: "athlete_external_id", unit: null });
    expect(loadUnitFromHeaders(["Athlete", "Weight (kg)"])).toBe("kg");
    expect(loadUnitFromHeaders(["Load (lbs)"])).toBe("lb");
    expect(loadUnitFromHeaders(["Weight", "Mean Velocity (m/s)"])).toBeNull();
    expect(wrongVelocityUnits(["Mean Velocity (m/s)", "Peak Velocity (mm/s)"])).toEqual(["Peak Velocity (mm/s)"]);
  });

  it("imports a file with unit suffixes, infers kg from the header, and never stores a 0 speed", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const r = await tx((t) => importVbtCsv(t, marcus, { name: "gymaware_style.csv", text: text("vbt/gymaware_style.csv") }));
    expect(r.imported).toBe(4);
    expect(r.review).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 6 });
    expect(r.errors[0].message).toMatch(/never stored as 0/);
    const rows = await testDb().select().from(vbtReadings).where(eq(vbtReadings.importBatchId, r.batchId));
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.loadUnit === "kg" && x.athleteId === ctx.athletes.dana && (x.meanVelocityMs ?? 0) > 0)).toBe(true);
    expect(rows.map((x) => Number(x.load)).sort((a, b) => a - b)).toEqual([60, 60, 80, 95]);
    // "2026-02-26 16:05:00" has no offset: read as facility-local time (EST, UTC-5).
    expect(rows.map((x) => x.performedAt.toISOString())).toContain("2026-02-26T21:05:00.000Z");
    const again = await tx((t) => importVbtCsv(t, marcus, { name: "gymaware_style.csv", text: text("vbt/gymaware_style.csv") }));
    expect(again).toMatchObject({ imported: 0, duplicates: 4 });
  });

  it("refuses velocities that are not in m/s and loads without any unit", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    await expect(tx((t) => importVbtCsv(t, marcus, { name: "mm.csv", text: "Athlete Email,Exercise,Timestamp,Weight (kg),Mean Velocity (mm/s)\ndana.brooks@example.test,Back Squat,2026-02-25T16:00:00Z,60,820" }))).rejects.toBeInstanceOf(TrainingError);
    const r = await tx((t) => importVbtCsv(t, marcus, { name: "nounit.csv", text: "Athlete Email,Exercise,Timestamp,Weight,Mean Velocity (m/s)\ndana.brooks@example.test,Back Squat,2026-02-25T16:00:00Z,60,0.8" }));
    expect(r.imported).toBe(0);
    expect(r.errors[0].message).toMatch(/without unit/);
  });

  it("name-only rows are never matched: a coach is told, an owner gets an identity-review batch", async () => {
    const names = text("vbt/gymaware_style_names.csv");
    const trap = await ex("Trap Bar Deadlift");
    const mayaTrap = () => testDb().select().from(vbtReadings).where(and(eq(vbtReadings.athleteId, ctx.athletes.maya), eq(vbtReadings.exerciseId, trap.id)));

    const marcus = await viewerFor(ctx, "marcus"); // training.manage but not imports.manage
    const asCoach = await tx((t) => importVbtCsv(t, marcus, { name: "names.csv", text: names }));
    expect(asCoach.imported).toBe(1); // the row identified by email
    expect(asCoach.review).toBeNull();
    expect(asCoach.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(asCoach.errors[0].message).toMatch(/never matched automatically/);
    expect(await mayaTrap()).toHaveLength(0);

    const rod = await viewerFor(ctx, "rod");
    const r = await tx((t) => importVbtCsv(t, rod, { name: "names.csv", text: names }));
    expect(r).toMatchObject({ imported: 0, duplicates: 1, errors: [] });
    expect(r.review?.rows).toBe(3);
    expect(await mayaTrap()).toHaveLength(0); // still nothing stored for the named athlete
    const held = await testDb().select().from(importRows).where(eq(importRows.batchId, r.review!.batchId));
    expect(held).toHaveLength(3);
    expect(held.every((x) => x.status === "needs_review" && x.matchPersonId === null)).toBe(true);
    const groups = await tx((t) => reviewGroups(t, rod, r.review!.batchId));
    const mayaGroup = groups.find((g) => g.key.includes("maya parker"))!;
    const riley = groups.find((g) => g.key.includes("riley example"))!;
    expect(mayaGroup.confidence).toBe("ambiguous"); // exactly one Maya Parker exists, and it is still not linked by name
    expect(riley.confidence).toBe("none");

    // The coach cannot open the review; the owner links Maya and skips the unknown name.
    await expect(tx((t) => resolveIdentity(t, marcus, r.review!.batchId, mayaGroup.key, { resolution: "link", personId: ctx.people.maya_parker }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => resolveIdentity(t, rod, r.review!.batchId, riley.key, { resolution: "create_new" }))).rejects.toThrow(/cannot create people/);
    await tx((t) => resolveIdentity(t, rod, r.review!.batchId, mayaGroup.key, { resolution: "link", personId: ctx.people.maya_parker }));
    await tx((t) => resolveIdentity(t, rod, r.review!.batchId, riley.key, { resolution: "skip" }));
    const counts = await confirmAndCommit(rod, r.review!.batchId);
    expect(counts).toMatchObject({ create: 2, skip: 1 });
    const stored = await mayaTrap();
    expect(stored).toHaveLength(2);
    expect(stored.every((x) => x.loadUnit === "kg" && x.importBatchId === r.review!.batchId)).toBe(true);

    // The confirmed name is remembered as an alias (like Hawkin): the same file now links Maya
    // directly and finds her rows already imported; only the unknown name still needs review.
    const alias = await testDb().select().from(externalIds).where(and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.source, "vbt_csv"), eq(externalIds.sourceEntityType, "athlete_name")));
    expect(alias.map((a) => a.sourceId)).toEqual(["maya parker"]);
    const again = await tx((t) => importVbtCsv(t, rod, { name: "names.csv", text: names }));
    expect(again).toMatchObject({ imported: 0, duplicates: 3 });
    expect(again.review?.rows).toBe(1);
    expect(await mayaTrap()).toHaveLength(2);
    expect(await testDb().select().from(vbtMaxDismissals).where(eq(vbtMaxDismissals.orgId, ctx.orgId))).not.toHaveLength(0);
  });
});
