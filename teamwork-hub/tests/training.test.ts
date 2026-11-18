import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { activitySessions, externalIds, guardianships, importBatches, setLogs, vbtReadings, workoutItems, workouts, programDays, programItems, programs } from "@/db/schema";
import { AuthzError, accessibleAthleteIds } from "@/lib/authz/policy";
import { adherence, brzycki, convertLoad, epley, estimateOneRepMax, expandSets, KG_PER_LB, percentLoad, roundToIncrement, type ResolvedSetGroup } from "@/lib/training/formulas";
import { addDay, addItem, addPhase, createProgram, updateItem } from "@/lib/training/programs";
import { applyTemplateToUnstarted, assignProgram, scheduleDates } from "@/lib/training/assignments";
import { recordMax, suggestEstimatedMaxes } from "@/lib/training/maxes";
import { maxAsOf } from "@/lib/training/loads";
import { applySetMutation, completeWorkout, substituteItem, workoutDetail } from "@/lib/training/logging";
import { weightRoomRoster } from "@/lib/training/weightroom";
import { athleteAdherence, exportCsv, importVbtCsv, leaderboard } from "@/lib/training/reports";
import { prAlerts } from "@/lib/training/review";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02"; // seedOrg default (a Monday)

beforeAll(async () => {
  ctx = await seedOrg(TODAY);
});
afterAll(closeTestDb);

const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<T>) => testDb().transaction(fn);

describe("formulas", () => {
  it("epley_v1 and brzycki_v1 match the documented equations", () => {
    expect(epley(200, 5)).toBeCloseTo(200 * (1 + 5 / 30), 2);
    expect(epley(225, 1)).toBe(225);
    expect(brzycki(200, 5)).toBeCloseTo((200 * 36) / 32, 2);
    expect(brzycki(100, 1)).toBe(100);
    expect(estimateOneRepMax("epley_v1", 100, 10)).toBeCloseTo(133.33, 2);
  });

  it("invalid reps or loads return null", () => {
    expect(epley(100, 0)).toBeNull();
    expect(epley(100, 2.5)).toBeNull();
    expect(epley(0, 5)).toBeNull();
    expect(epley(-10, 5)).toBeNull();
    expect(brzycki(100, 37)).toBeNull();
    expect(brzycki(100, 40)).toBeNull();
    expect(brzycki(100, 36)).toBeCloseTo(3600, 2);
    expect(brzycki(Number.NaN, 3)).toBeNull();
  });

  it("rounds to plate increments and converts units only explicitly", () => {
    expect(roundToIncrement(167.475, 5)).toBe(165);
    expect(roundToIncrement(168, 5)).toBe(170);
    expect(roundToIncrement(101.2, 2.5)).toBe(100);
    expect(roundToIncrement(101.3, 2.5)).toBe(102.5);
    expect(percentLoad(203, 82.5, 5)).toBe(165);
    expect(convertLoad(100, "lb", "kg")).toBeCloseTo(100 * KG_PER_LB, 6);
    expect(convertLoad(45.359237, "kg", "lb")).toBeCloseTo(100, 6);
    expect(convertLoad(100, "kg", "kg")).toBe(100);
  });

  it("adherence = completed / scheduled up to today (future excluded, none → null)", () => {
    const ws = [
      { scheduledDate: "2026-02-20", status: "completed" },
      { scheduledDate: "2026-02-22", status: "skipped" },
      { scheduledDate: "2026-02-24", status: "scheduled" },
      { scheduledDate: "2026-03-02", status: "completed" },
      { scheduledDate: "2026-03-04", status: "scheduled" },
    ];
    expect(adherence(ws, "2026-03-02")).toEqual({ completed: 2, scheduled: 4, pct: 50 });
    expect(adherence(ws, "2026-01-01")).toEqual({ completed: 0, scheduled: 0, pct: null });
  });

  it("scheduleDates places program days on chosen weekdays, week-aligned", () => {
    const days = [
      { id: "a", week: 1, dayIndex: 1 },
      { id: "b", week: 1, dayIndex: 2 },
      { id: "c", week: 2, dayIndex: 1 },
    ];
    const m = scheduleDates("2026-03-04", [1, 3, 5], days); // Wednesday start
    expect(m.get("a")).toBe("2026-03-04");
    expect(m.get("b")).toBe("2026-03-06");
    expect(m.get("c")).toBe("2026-03-09");
  });
});

/** Builds a one-day-per-week Back Squat program and assigns it to Dana. */
async function buildDanaProgram(percent = 82.5, weeks = 3) {
  const rod = await viewerFor(ctx, "rod");
  const ex = ctx.extra.exercises;
  return tx(async (t) => {
    const p = await createProgram(t, rod, { name: `Test ${randomUUID().slice(0, 6)}`, status: "active" });
    const ph = await addPhase(t, rod, p.id, { name: "Block", weeks });
    for (let w = 1; w <= weeks; w++) {
      const d = await addDay(t, rod, p.id, { week: w, dayIndex: 1, title: `Squat W${w}`, phaseId: ph.id });
      await addItem(t, rod, p.id, d.id, { exerciseId: ex["Back Squat"], blockLabel: "A1", prescription: [{ sets: 3, reps: 5, load: { type: "percent_max", percent } }] });
    }
    return p;
  });
}

describe("% loading from the max as of the workout date", () => {
  it("uses the latest max on/before each workout date and rounds to 5 lb", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const rod = await viewerFor(ctx, "rod");
    const dana = ctx.athletes.dana;
    const sq = ctx.extra.exercises["Back Squat"];
    await tx((t) => recordMax(t, marcus, { athleteId: dana, exerciseId: sq, value: 203, unit: "lb", kind: "tested", recordedOn: "2026-02-01" }));
    await tx((t) => recordMax(t, marcus, { athleteId: dana, exerciseId: sq, value: 250, unit: "lb", kind: "tested", recordedOn: "2026-02-20" }));
    expect(Number((await maxAsOf(testDb(), ctx.orgId, dana, sq, "2026-02-19"))!.value)).toBe(203);
    expect(Number((await maxAsOf(testDb(), ctx.orgId, dana, sq, "2026-02-20"))!.value)).toBe(250);
    expect(await maxAsOf(testDb(), ctx.orgId, dana, sq, "2026-01-01")).toBeNull();

    const p = await buildDanaProgram();
    const { assignment } = await tx((t) => assignProgram(t, rod, { programId: p.id, athleteId: dana, startDate: "2026-02-09", daysOfWeek: [1] }));
    const ws = await testDb().select().from(workouts).where(eq(workouts.assignmentId, assignment.id)).orderBy(asc(workouts.scheduledDate));
    expect(ws.map((w) => w.scheduledDate)).toEqual(["2026-02-09", "2026-02-16", "2026-02-23"]);
    const loads = [];
    for (const w of ws) {
      const [it] = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, w.id));
      const g = (it.prescription as unknown as ResolvedSetGroup[])[0];
      loads.push([g.targetLoad, g.targetUnit, g.maxUsed?.value]);
      expect(g.loadMethod).toContain("rounded to 5 lb");
    }
    // 82.5% × 203 = 167.475 → 165 ; 82.5% × 250 = 206.25 → 205
    expect(loads).toEqual([
      [165, "lb", 203],
      [165, "lb", 203],
      [205, "lb", 250],
    ]);
  });

  it("Front Squat % uses the Back Squat max via max_source_exercise_id; kg max stays kg with 2.5 kg rounding", async () => {
    const rod = await viewerFor(ctx, "rod");
    const sofia = ctx.athletes.sofia; // seeded maxes in kg
    const ex = ctx.extra.exercises;
    const p = await tx(async (t) => {
      const p = await createProgram(t, rod, { name: `FS ${randomUUID().slice(0, 6)}`, status: "active" });
      const d = await addDay(t, rod, p.id, { week: 1, dayIndex: 1, title: "FS" });
      await addItem(t, rod, p.id, d.id, { exerciseId: ex["Front Squat"], blockLabel: "A", prescription: [{ sets: 3, reps: 3, load: { type: "percent_max", percent: 70 } }] });
      return p;
    });
    await tx((t) => assignProgram(t, rod, { programId: p.id, athleteId: sofia, startDate: "2026-03-09", daysOfWeek: [1] }));
    const bs = await maxAsOf(testDb(), ctx.orgId, sofia, ex["Back Squat"], "2026-03-09");
    const [w] = await testDb().select().from(workouts).where(and(eq(workouts.athleteId, sofia), eq(workouts.title, "FS")));
    const [it] = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, w.id));
    const g = (it.prescription as unknown as ResolvedSetGroup[])[0];
    expect(bs!.unit).toBe("kg");
    expect(g.targetUnit).toBe("kg");
    expect(g.maxUsed?.exerciseId).toBe(ex["Back Squat"]);
    expect(g.targetLoad).toBe(roundToIncrement((Number(bs!.value) * 70) / 100, 2.5));
    expect((g.targetLoad! * 10) % 25).toBe(0);
  });
});

describe("template versioning", () => {
  it("editing the template after assignment leaves existing workouts unchanged; apply-to-unstarted rebuilds only unstarted future ones", async () => {
    const rod = await viewerFor(ctx, "rod");
    const marcus = await viewerFor(ctx, "marcus");
    const p = await buildDanaProgram(70, 3);
    const { assignment } = await tx((t) => assignProgram(t, rod, { programId: p.id, athleteId: ctx.athletes.dana, startDate: "2026-03-02", daysOfWeek: [3] }));
    const ws = await testDb().select().from(workouts).where(eq(workouts.assignmentId, assignment.id)).orderBy(asc(workouts.scheduledDate));
    const itemsBefore = await testDb().select().from(workoutItems).where(inArray(workoutItems.workoutId, ws.map((w) => w.id)));
    const [prog0] = await testDb().select().from(programs).where(eq(programs.id, p.id));

    // Start the first workout (log one set) so it is no longer "unstarted".
    const firstItem = itemsBefore.find((i) => i.workoutId === ws[0].id)!;
    await tx((t) => applySetMutation(t, marcus, { clientMutationId: randomUUID(), workoutItemId: firstItem.id, setIndex: 0, reps: 5, load: 175, loadUnit: "lb" }));

    // Edit every template item: 70% → 90%.
    const days = await testDb().select().from(programDays).where(eq(programDays.programId, p.id));
    const tItems = await testDb().select().from(programItems).where(inArray(programItems.dayId, days.map((d) => d.id)));
    for (const ti of tItems) {
      await tx((t) => updateItem(t, rod, p.id, ti.id, { exerciseId: ti.exerciseId, blockLabel: "A1", prescription: [{ sets: 5, reps: 3, load: { type: "percent_max", percent: 90 } }] }));
    }
    const [prog1] = await testDb().select().from(programs).where(eq(programs.id, p.id));
    expect(prog1.currentVersion).toBe(prog0.currentVersion + tItems.length);

    const itemsAfter = await testDb().select().from(workoutItems).where(inArray(workoutItems.workoutId, ws.map((w) => w.id)));
    expect(itemsAfter.map((i) => [i.id, i.prescription]).sort()).toEqual(itemsBefore.map((i) => [i.id, i.prescription]).sort());

    // Coach chooses "apply to unstarted workouts" (as of 2026-03-02).
    const res = await tx((t) => applyTemplateToUnstarted(t, rod, assignment.id, "2026-03-02"));
    expect(res.removed).toBe(2);
    expect(res.created).toBe(2);
    const ws2 = await testDb().select().from(workouts).where(eq(workouts.assignmentId, assignment.id)).orderBy(asc(workouts.scheduledDate));
    expect(ws2).toHaveLength(3);
    expect(ws2[0].id).toBe(ws[0].id); // started workout kept as-is
    const [kept] = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, ws[0].id));
    expect((kept.prescription as unknown as ResolvedSetGroup[])[0].percent).toBe(70);
    const [rebuilt] = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, ws2[2].id));
    expect((rebuilt.prescription as unknown as ResolvedSetGroup[])[0].percent).toBe(90);
  });
});

async function itemFor(athleteKey: string, date?: string) {
  const conds = [eq(workouts.athleteId, ctx.athletes[athleteKey]), eq(workouts.status, "scheduled")];
  if (date) conds.push(eq(workouts.scheduledDate, date));
  const [w] = await testDb().select().from(workouts).where(and(...conds)).orderBy(asc(workouts.scheduledDate)).limit(1);
  const its = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, w.id)).orderBy(asc(workoutItems.sortOrder));
  return { workout: w, item: its[0], items: its };
}

describe("idempotent set logging (offline retry)", () => {
  it("same clientMutationId twice → one row; different id for same slot → update, not duplicate; older client time → ignored", async () => {
    const maya = await viewerFor(ctx, "maya");
    const { item, workout } = await itemFor("maya", TODAY);
    const id1 = randomUUID();
    const m = { clientMutationId: id1, workoutItemId: item.id, setIndex: 1, reps: 5, load: 135, loadUnit: "lb" as const, loggedAt: Date.now() - 60_000 };
    const r1 = await tx((t) => applySetMutation(t, maya, m));
    const r2 = await tx((t) => applySetMutation(t, maya, m));
    expect(r1.status).toBe("applied");
    expect(r2.status).toBe("duplicate");
    let rows = await testDb().select().from(setLogs).where(and(eq(setLogs.workoutItemId, item.id), eq(setLogs.setIndex, 1)));
    expect(rows).toHaveLength(1);

    const r3 = await tx((t) => applySetMutation(t, maya, { ...m, clientMutationId: randomUUID(), reps: 4, load: 140, loggedAt: Date.now() - 30_000 }));
    expect(r3.status).toBe("applied");
    rows = await testDb().select().from(setLogs).where(and(eq(setLogs.workoutItemId, item.id), eq(setLogs.setIndex, 1)));
    expect(rows).toHaveLength(1);
    expect(rows[0].reps).toBe(4);
    expect(Number(rows[0].load)).toBe(140);

    // A late retry of an older edit (new id, older client time) must not clobber the newer value.
    const r4 = await tx((t) => applySetMutation(t, maya, { ...m, clientMutationId: randomUUID(), reps: 1, loggedAt: Date.now() - 50_000 }));
    expect(r4.status).toBe("stale");
    rows = await testDb().select().from(setLogs).where(and(eq(setLogs.workoutItemId, item.id), eq(setLogs.setIndex, 1)));
    expect(rows).toHaveLength(1);
    expect(rows[0].reps).toBe(4);

    // Concurrent duplicates of the same mutation still produce exactly one row.
    const id5 = randomUUID();
    const both = await Promise.allSettled([0, 1, 2].map(() => tx((t) => applySetMutation(t, maya, { ...m, clientMutationId: id5, setIndex: 2, loggedAt: Date.now() }))));
    expect(both.some((b) => b.status === "fulfilled")).toBe(true);
    rows = await testDb().select().from(setLogs).where(and(eq(setLogs.workoutItemId, item.id), eq(setLogs.setIndex, 2)));
    expect(rows).toHaveLength(1);

    const [w] = await testDb().select().from(workouts).where(eq(workouts.id, workout.id));
    expect(w.status).toBe("in_progress");
  });

  it("estimated max is suggested from logged sets, never stored automatically", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const sugg = await suggestEstimatedMaxes(testDb(), marcus, ctx.athletes.maya, "epley_v1", TODAY);
    expect(Array.isArray(sugg)).toBe(true);
    for (const s of sugg) expect(s.suggested.e1rm).toBeGreaterThan(s.current?.value ?? 0);
  });
});

describe("authorization scope", () => {
  it("coach Marcus cannot log for Eli (Tess's youth athlete) but can for Maya", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const eli = await itemFor("eli");
    await expect(tx((t) => applySetMutation(t, marcus, { clientMutationId: randomUUID(), workoutItemId: eli.item.id, setIndex: 0, reps: 8 }, "weight_room"))).rejects.toBeInstanceOf(AuthzError);
    const maya = await itemFor("maya");
    const r = await tx((t) => applySetMutation(t, marcus, { clientMutationId: randomUUID(), workoutItemId: maya.items[1].id, setIndex: 0, reps: 5, load: 100, loadUnit: "lb" }, "weight_room"));
    expect(r.status).toBe("applied");
  });

  it("weight room: coaches only see groups/athletes they coach; owner sees all; operations is read-only", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const tess = await viewerFor(ctx, "tess");
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    await expect(weightRoomRoster(testDb(), marcus, ctx.groups.youth, TODAY)).rejects.toBeInstanceOf(AuthzError);
    const hs = await weightRoomRoster(testDb(), marcus, ctx.groups.hs, TODAY);
    expect(hs.athletes.map((a) => a.athleteId)).toContain(ctx.athletes.maya);
    expect(hs.athletes.every((a) => a.canLog)).toBe(true);
    expect(hs.athletes.some((a) => a.athleteId === ctx.athletes.eli)).toBe(false);
    expect(Object.keys(hs.athletes[0]).sort()).toEqual(["athleteId", "canLog", "name", "workout"]);
    await expect(weightRoomRoster(testDb(), tess, ctx.groups.hs, TODAY)).rejects.toBeInstanceOf(AuthzError);
    expect((await weightRoomRoster(testDb(), rod, ctx.groups.youth, TODAY)).athletes.length).toBe(6);
    const ops = await weightRoomRoster(testDb(), erin, ctx.groups.hs, TODAY);
    expect(ops.canLog).toBe(false);
    const { item } = await itemFor("leo");
    await expect(tx((t) => applySetMutation(t, erin, { clientMutationId: randomUUID(), workoutItemId: item.id, setIndex: 0, reps: 5 }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("athletes log only their own workouts", async () => {
    const maya = await viewerFor(ctx, "maya");
    const { item } = await itemFor("leo");
    await expect(tx((t) => applySetMutation(t, maya, { clientMutationId: randomUUID(), workoutItemId: item.id, setIndex: 0, reps: 5 }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("guardians need training.read: Jordan can view; a guardian with canViewTraining=false is denied", async () => {
    const jordan = await viewerFor(ctx, "jordan");
    const { workout: mayaW } = await itemFor("maya");
    const detail = await workoutDetail(testDb(), jordan, mayaW.id);
    expect(detail.athleteId).toBe(ctx.athletes.maya);
    // Guardian can read but not log.
    await expect(tx((t) => applySetMutation(t, jordan, { clientMutationId: randomUUID(), workoutItemId: detail.items[0].id, setIndex: 0, reps: 1 }))).rejects.toBeInstanceOf(AuthzError);

    await testDb()
      .update(guardianships)
      .set({ canViewTraining: false })
      .where(and(eq(guardianships.guardianPersonId, ctx.people.casey_nguyen), eq(guardianships.athleteId, ctx.athletes.leo)));
    const casey = await viewerFor(ctx, "casey");
    const { workout: leoW } = await itemFor("leo");
    await expect(workoutDetail(testDb(), casey, leoW.id)).rejects.toBeInstanceOf(AuthzError);
    expect(await accessibleAthleteIds(testDb(), casey, "training.read")).not.toContain(ctx.athletes.leo);
    await expect(exportCsv(testDb(), casey, "sets", { athleteId: ctx.athletes.leo })).rejects.toBeInstanceOf(AuthzError);
    const sam = await viewerFor(ctx, "sam");
    expect((await workoutDetail(testDb(), sam, leoW.id)).athleteId).toBe(ctx.athletes.leo);
  });

  it("athletes may substitute only coach-approved alternatives", async () => {
    const maya = await viewerFor(ctx, "maya");
    const ex = ctx.extra.exercises;
    const [w] = await testDb().select().from(workouts).where(and(eq(workouts.athleteId, ctx.athletes.maya), eq(workouts.status, "scheduled"), eq(workouts.title, "Upper — Press & Pull"))).limit(1);
    const its = await testDb().select().from(workoutItems).where(eq(workoutItems.workoutId, w.id));
    const bench = its.find((i) => i.exerciseId === ex["Bench Press"])!;
    await tx((t) => substituteItem(t, maya, bench.id, ex["Push-Up"], "Shoulder sore"));
    await expect(tx((t) => substituteItem(t, maya, bench.id, ex["Sled Push"]))).rejects.toBeInstanceOf(AuthzError);
    const [after] = await testDb().select().from(workoutItems).where(eq(workoutItems.id, bench.id));
    expect(after.substitutedExerciseId).toBe(ex["Push-Up"]);
    expect(after.athleteModification).toBe("Shoulder sore");
  });
});

describe("workout completion", () => {
  it("creates exactly one activity_session (re-completing updates it)", async () => {
    const maya = await viewerFor(ctx, "maya");
    const { workout } = await itemFor("maya");
    await tx((t) => completeWorkout(t, maya, workout.id, { sessionRpe: 7, durationMinutes: 60 }));
    await tx((t) => completeWorkout(t, maya, workout.id, { sessionRpe: 8, durationMinutes: 65, comment: "Felt strong" }));
    const sessions = await testDb().select().from(activitySessions).where(eq(activitySessions.workoutId, workout.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: "training", sessionRpe: 8, durationMinutes: 65, athleteId: ctx.athletes.maya, activityDate: workout.scheduledDate });
    const [w] = await testDb().select().from(workouts).where(eq(workouts.id, workout.id));
    expect(w.status).toBe("completed");
    await expect(tx((t) => completeWorkout(t, maya, workout.id, { sessionRpe: 11, durationMinutes: 60 }))).rejects.toThrow();
  });

  it("seeded completed workouts each have one activity session", async () => {
    const done = await testDb().select({ id: workouts.id }).from(workouts).where(and(eq(workouts.orgId, ctx.orgId), eq(workouts.status, "completed")));
    const sess = await testDb().select({ id: activitySessions.id }).from(activitySessions).where(inArray(activitySessions.workoutId, done.map((d) => d.id)));
    expect(done.length).toBeGreaterThan(20);
    expect(sess.length).toBe(done.length);
  });
});

describe("reports", () => {
  it("adherence for a seeded athlete counts only workouts dated up to today", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const a = await athleteAdherence(testDb(), marcus, ctx.athletes.leo, {}, TODAY);
    const ws = await testDb().select().from(workouts).where(eq(workouts.athleteId, ctx.athletes.leo));
    const due = ws.filter((w) => w.scheduledDate <= TODAY);
    expect(a.scheduled).toBe(due.length);
    expect(a.completed).toBe(due.filter((w) => w.status === "completed").length);
  });

  it("leaderboard includes only opted-in athletes and is scoped to the coach's group", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const tess = await viewerFor(ctx, "tess");
    const lb = await leaderboard(testDb(), marcus, ctx.groups.hs, ctx.extra.exercises["Back Squat"], { from: "2026-01-01", to: TODAY });
    const allowed = [ctx.athletes.maya, ctx.athletes.leo, ctx.athletes.ethan, ctx.athletes.mason];
    expect(lb.rows.every((r) => allowed.includes(r.athleteId))).toBe(true);
    expect(lb.optedInCount).toBe(4);
    await expect(leaderboard(testDb(), tess, ctx.groups.hs, ctx.extra.exercises["Back Squat"], { from: "2026-01-01", to: TODAY })).rejects.toBeInstanceOf(AuthzError);
  });

  it("PR alerts are scoped to the coach's athletes", async () => {
    const tess = await viewerFor(ctx, "tess");
    const alerts = await prAlerts(testDb(), tess, { since: "2026-01-01" });
    const hs = new Set([ctx.athletes.maya, ctx.athletes.leo, ctx.athletes.ethan]);
    expect(alerts.some((a) => hs.has(a.athleteId))).toBe(false);
    const marcus = await viewerFor(ctx, "marcus");
    const mAlerts = await prAlerts(testDb(), marcus, { since: "2026-01-01" });
    expect(mAlerts.length).toBeGreaterThan(0);
  });

  it("CSV export: athlete gets own data only; formula injection neutralized", async () => {
    const maya = await viewerFor(ctx, "maya");
    const csv = await exportCsv(testDb(), maya, "workouts", {});
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("workout_id");
    expect(lines.slice(1).every((l) => l.includes("Maya Parker"))).toBe(true);
    await expect(exportCsv(testDb(), maya, "workouts", { athleteId: ctx.athletes.leo })).rejects.toBeInstanceOf(AuthzError);
  });

  it("VBT CSV import stores provenance, rejects unknown/unscoped rows, and is idempotent", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const text = [
      "athlete,exercise,timestamp,load,unit,rep,mean_velocity,peak_velocity,power,device",
      "dana.brooks@example.test,Back Squat,2026-02-27T16:05:00Z,185,lb,1,0.62,0.95,780,Sample VBT unit",
      "dana.brooks@example.test,Back Squat,2026-02-27T16:05:10Z,185,lb,2,0.58,0.90,740,Sample VBT unit",
      "nobody@example.test,Back Squat,2026-02-27T16:05:10Z,185,lb,2,0.58,0.90,740,x",
      "dana.brooks@example.test,Not An Exercise,2026-02-27T16:05:10Z,185,lb,2,0.58,0.90,740,x",
      "dana.brooks@example.test,Back Squat,2026-02-27T16:06:00Z,185,,3,0.5,0.8,700,x",
    ].join("\n");
    const r1 = await tx((t) => importVbtCsv(t, marcus, { name: "vbt-session.csv", text }));
    expect(r1.imported).toBe(2);
    expect(r1.errors.map((e) => e.row)).toEqual([4, 5, 6]);
    const r2 = await tx((t) => importVbtCsv(t, marcus, { name: "vbt-session.csv", text }));
    expect(r2.imported).toBe(0);
    expect(r2.duplicates).toBe(2);
    // Eli (matched by external id) is outside Marcus's scope.
    await testDb().insert(externalIds).values({ orgId: ctx.orgId, source: "vbt_device", sourceEntityType: "athlete", sourceId: "ELI-001", localEntityType: "athlete", localId: ctx.athletes.eli });
    const r3 = await tx((t) => importVbtCsv(t, marcus, { name: "x.csv", text: "athlete_external_id,exercise,timestamp,load,unit,rep\nELI-001,Back Squat,2026-02-27T16:05:00Z,100,lb,1" }));
    expect(r3.imported).toBe(0);
    expect(r3.errors[0].message).toMatch(/outside your coaching scope/);
    const rows = await testDb().select().from(vbtReadings).where(eq(vbtReadings.importBatchId, r1.batchId));
    expect(rows).toHaveLength(2);
    const [batch] = await testDb().select().from(importBatches).where(eq(importBatches.id, r1.batchId));
    expect(batch).toMatchObject({ originalFilename: "vbt-session.csv", entityType: "vbt_readings" });
  });
});

describe("expandSets", () => {
  it("flattens set groups with sequential indexes", () => {
    const s = expandSets([
      { sets: 1, reps: 5, isWarmup: true, loadType: "none" },
      { sets: 3, reps: 3, loadType: "absolute", targetLoad: 100, targetUnit: "lb" },
    ]);
    expect(s.map((x) => [x.setIndex, x.isWarmup, x.reps])).toEqual([
      [0, true, 5],
      [1, false, 3],
      [2, false, 3],
      [3, false, 3],
    ]);
  });
});
