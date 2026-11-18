import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { auditEvents, programDays, programItems, programs, workoutItems, workouts, programAssignments } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { addDay, addItem, addPhase, bulkEditScheme, copyDay, createProgram, saveProgramLayout } from "@/lib/training/programs";
import { assignProgram } from "@/lib/training/assignments";
import {
  blocksOf,
  dropOnDayEnd,
  dropOnItem,
  groupsFromLabels,
  joinPrevious,
  moveStep,
  moveToDay,
  normalizeDay,
  separate,
  type DayLayout,
} from "@/lib/training/program-layout";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: ["training"] });
});
afterAll(closeTestDb);

const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<T>) => testDb().transaction(fn);

// --- Pure ordering logic ------------------------------------------------------------------

/** Day "d1": A1 a | B1 b, B2 c (superset) | C1 d ; day "d2": A1 e */
function sample(): DayLayout[] {
  return [
    {
      dayId: "d1",
      items: groupsFromLabels("d1", [
        { id: "a", blockLabel: "A1", blockType: "straight" },
        { id: "b", blockLabel: "B1", blockType: "superset" },
        { id: "c", blockLabel: "B2", blockType: "superset" },
        { id: "d", blockLabel: "C1", blockType: "straight" },
      ]),
    },
    { dayId: "d2", items: groupsFromLabels("d2", [{ id: "e", blockLabel: "A1", blockType: "straight" }]) },
  ];
}
const labels = (days: DayLayout[], dayId = "d1") => normalizeDay(days.find((d) => d.dayId === dayId)!.items).map((n) => `${n.blockLabel}:${n.id}`);

describe("program layout (pure)", () => {
  it("normalizes labels A1.. by block and derives block types", () => {
    const n = normalizeDay(sample()[0].items);
    expect(n.map((x) => [x.id, x.sortOrder, x.blockLabel, x.blockType])).toEqual([
      ["a", 0, "A1", "straight"],
      ["b", 1, "B1", "superset"],
      ["c", 2, "B2", "superset"],
      ["d", 3, "C1", "straight"],
    ]);
    // A circuit stays a circuit; a lone former superset member becomes straight.
    expect(normalizeDay([{ id: "x", group: "g", blockType: "circuit" }, { id: "y", group: "g", blockType: "straight" }]).map((x) => x.blockType)).toEqual(["circuit", "circuit"]);
    expect(normalizeDay([{ id: "x", group: "g", blockType: "superset" }])[0].blockType).toBe("straight");
    // Same letter in two separate runs = two blocks.
    expect(groupsFromLabels("d", [{ id: "1", blockLabel: "A1", blockType: "straight" }, { id: "2", blockLabel: "B1", blockType: "straight" }, { id: "3", blockLabel: "A2", blockType: "straight" }]).map((x) => x.group)).toEqual(["d:0", "d:1", "d:2"]);
    expect(() => normalizeDay(Array.from({ length: 27 }, (_, i) => ({ id: String(i), group: String(i), blockType: "straight" as const })))).toThrow(/26 blocks/);
  });

  it("move up/down is block-aware (jump over blocks, swap inside, step out at the edge)", () => {
    // Single item jumps over the whole superset.
    expect(labels(moveStep(sample(), "a", 1))).toEqual(["A1:b", "A2:c", "B1:a", "C1:d"]);
    expect(labels(moveStep(sample(), "d", -1))).toEqual(["A1:a", "B1:d", "C1:b", "C2:c"]);
    // Inside a superset: swap members.
    expect(labels(moveStep(sample(), "c", -1))).toEqual(["A1:a", "B1:c", "B2:b", "C1:d"]);
    // At the superset edge: step out (the remaining member becomes straight).
    const out = moveStep(sample(), "b", -1);
    expect(labels(out)).toEqual(["A1:a", "B1:b", "C1:c", "D1:d"]);
    expect(normalizeDay(out[0].items).find((x) => x.id === "c")!.blockType).toBe("straight");
    // No-op at the ends.
    expect(labels(moveStep(sample(), "a", -1))).toEqual(labels(sample()));
    expect(labels(moveStep(sample(), "d", 1))).toEqual(labels(sample()));
  });

  it("join previous block / separate", () => {
    const joined = joinPrevious(sample(), "d");
    expect(labels(joined)).toEqual(["A1:a", "B1:b", "B2:c", "B3:d"]);
    expect(normalizeDay(joined[0].items).at(-1)!.blockType).toBe("superset");
    expect(labels(separate(joined, "b"))).toEqual(["A1:a", "B1:c", "B2:d", "C1:b"]);
    expect(labels(separate(sample(), "a"))).toEqual(labels(sample()));
    expect(labels(joinPrevious(sample(), "a"))).toEqual(labels(sample()));
  });

  it("drag-and-drop: outer edges stay separate, between members joins, other days append", () => {
    expect(labels(dropOnItem(sample(), "d", "b", "before"))).toEqual(["A1:a", "B1:d", "C1:b", "C2:c"]);
    expect(labels(dropOnItem(sample(), "d", "b", "after"))).toEqual(["A1:a", "B1:b", "B2:d", "B3:c"]);
    expect(labels(dropOnItem(sample(), "a", "c", "after"))).toEqual(["A1:b", "A2:c", "B1:a", "C1:d"]);
    // Reorder within its own superset keeps membership.
    expect(labels(dropOnItem(sample(), "c", "b", "before"))).toEqual(["A1:a", "B1:c", "B2:b", "C1:d"]);
    // Across days.
    const moved = dropOnItem(sample(), "b", "e", "before");
    expect(labels(moved, "d2")).toEqual(["A1:b", "B1:e"]);
    expect(labels(moved)).toEqual(["A1:a", "B1:c", "C1:d"]);
    expect(labels(dropOnDayEnd(sample(), "a", "d2"), "d2")).toEqual(["A1:e", "B1:a"]);
    expect(labels(moveToDay(sample(), "c", "d2"), "d2")).toEqual(["A1:e", "B1:c"]);
    expect(blocksOf(moveToDay(sample(), "c", "d2")[0].items).length).toBe(3);
  });
});

// --- Server persistence -------------------------------------------------------------------

async function buildProgram() {
  const rod = await viewerFor(ctx, "rod");
  const ex = ctx.extra.exercises;
  return tx(async (t) => {
    const p = await createProgram(t, rod, { name: `Builder ${randomUUID().slice(0, 6)}`, status: "active" });
    const ph = await addPhase(t, rod, p.id, { name: "Block", weeks: 2 });
    const d1 = await addDay(t, rod, p.id, { week: 1, dayIndex: 1, title: "Lower", phaseId: ph.id });
    const d2 = await addDay(t, rod, p.id, { week: 1, dayIndex: 2, title: "Upper", phaseId: ph.id });
    const rx = [{ sets: 1, reps: 5, load: { type: "percent_max" as const, percent: 50 }, isWarmup: true }, { sets: 3, reps: 5, load: { type: "percent_max" as const, percent: 80 }, restS: 120 }];
    const a = await addItem(t, rod, p.id, d1.id, { exerciseId: ex["Back Squat"], blockLabel: "A1", prescription: rx });
    const b = await addItem(t, rod, p.id, d1.id, { exerciseId: ex["Box Jump"], blockLabel: "B1", blockType: "superset", prescription: [{ sets: 3, reps: 3, load: { type: "bodyweight" } }] });
    const c = await addItem(t, rod, p.id, d1.id, { exerciseId: ex["Plank"], blockLabel: "B2", blockType: "superset", prescription: [{ sets: 3, durationS: 30 }] });
    const e = await addItem(t, rod, p.id, d2.id, { exerciseId: ex["Bench Press"], blockLabel: "A1", prescription: rx });
    const [{ v }] = await t.select({ v: programs.currentVersion }).from(programs).where(eq(programs.id, p.id));
    return { p, d1, d2, a, b, c, e, version: v };
  });
}

async function dayRows(dayId: string) {
  return testDb().select().from(programItems).where(eq(programItems.dayId, dayId)).orderBy(asc(programItems.sortOrder));
}
const version = async (programId: string) => (await testDb().select({ v: programs.currentVersion }).from(programs).where(eq(programs.id, programId)))[0].v;

describe("saveProgramLayout", () => {
  it("reorders within a day and moves between days atomically, normalizing labels and bumping the version once", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, d1, d2, a, b, c, e, version: v0 } = await buildProgram();
    // Move Plank (c) to day 2 before Bench (e); move Back Squat (a) after Box Jump (b).
    const r = await tx((t) =>
      saveProgramLayout(t, rod, p.id, {
        expectedVersion: v0,
        days: [
          { dayId: d1.id, items: [{ id: b.id, group: "x" }, { id: a.id, group: "y" }] },
          { dayId: d2.id, items: [{ id: c.id, group: "p" }, { id: e.id, group: "q" }] },
        ],
      }),
    );
    expect(r).toEqual({ version: v0 + 1, changed: 4 });
    expect(await version(p.id)).toBe(v0 + 1);
    expect((await dayRows(d1.id)).map((i) => [i.id, i.sortOrder, i.blockLabel, i.blockType])).toEqual([
      [b.id, 0, "A1", "straight"],
      [a.id, 1, "B1", "straight"],
    ]);
    expect((await dayRows(d2.id)).map((i) => [i.id, i.blockLabel])).toEqual([
      [c.id, "A1"],
      [e.id, "B1"],
    ]);
    const [log] = await testDb().select().from(auditEvents).where(and(eq(auditEvents.entityId, p.id), eq(auditEvents.action, "training.program.layout")));
    expect(log.summary).toContain("1 moved between days");

    // Saving the same layout again changes nothing and does not bump.
    const again = await tx((t) =>
      saveProgramLayout(t, rod, p.id, {
        expectedVersion: v0 + 1,
        days: [{ dayId: d1.id, items: [{ id: b.id, group: "x" }, { id: a.id, group: "y" }] }],
      }),
    );
    expect(again).toEqual({ version: v0 + 1, changed: 0 });
  });

  it("joins items into a superset from the client's grouping (labels from the server, not the client)", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, d1, a, b, c, version: v0 } = await buildProgram();
    await tx((t) => saveProgramLayout(t, rod, p.id, { expectedVersion: v0, days: [{ dayId: d1.id, items: [{ id: a.id, group: "g" }, { id: b.id, group: "g" }, { id: c.id, group: "h" }] }] }));
    expect((await dayRows(d1.id)).map((i) => [i.blockLabel, i.blockType])).toEqual([
      ["A1", "superset"],
      ["A2", "superset"],
      ["B1", "straight"],
    ]);
  });

  it("rejects stale versions, missing/foreign/duplicate items and other programs' days; nothing is written", async () => {
    const rod = await viewerFor(ctx, "rod");
    const one = await buildProgram();
    const two = await buildProgram();
    const before = await dayRows(one.d1.id);
    const save = (days: Parameters<typeof saveProgramLayout>[3]["days"], expectedVersion = one.version) => tx((t) => saveProgramLayout(t, rod, one.p.id, { expectedVersion, days }));
    await expect(save([{ dayId: one.d1.id, items: [{ id: one.c.id, group: "1" }, { id: one.b.id, group: "2" }, { id: one.a.id, group: "3" }] }], one.version - 1)).rejects.toThrow(/changed since you loaded it/);
    await expect(save([{ dayId: one.d1.id, items: [{ id: one.a.id, group: "1" }, { id: one.b.id, group: "2" }] }])).rejects.toThrow(/added or removed/);
    await expect(save([{ dayId: one.d1.id, items: [{ id: one.a.id, group: "1" }, { id: one.b.id, group: "2" }, { id: one.c.id, group: "3" }, { id: one.e.id, group: "4" }] }])).rejects.toThrow(/added or removed/);
    await expect(save([{ dayId: one.d1.id, items: [{ id: one.a.id, group: "1" }, { id: one.b.id, group: "2" }, { id: two.a.id, group: "3" }] }])).rejects.toThrow(/added or removed/);
    await expect(save([{ dayId: one.d1.id, items: [{ id: one.a.id, group: "1" }, { id: one.a.id, group: "2" }, { id: one.c.id, group: "3" }] }])).rejects.toThrow(/listed twice/);
    await expect(save([{ dayId: two.d1.id, items: [{ id: two.a.id, group: "1" }, { id: two.b.id, group: "2" }, { id: two.c.id, group: "3" }] }])).rejects.toThrow(/Day not found/);
    expect(await dayRows(one.d1.id)).toEqual(before);
    expect(await version(one.p.id)).toBe(one.version);
    expect((await dayRows(two.d1.id)).map((i) => i.id)).toEqual([two.a.id, two.b.id, two.c.id]);
  });

  it("requires training.manage; coaches of other orgs/athletes and families can't reorder", async () => {
    const { p, d1, a, b, c, version: v0 } = await buildProgram();
    const days = [{ dayId: d1.id, items: [{ id: c.id, group: "1" }, { id: b.id, group: "2" }, { id: a.id, group: "3" }] }];
    for (const who of ["erin", "alex", "maya"]) {
      const viewer = await viewerFor(ctx, who);
      await expect(tx((t) => saveProgramLayout(t, viewer, p.id, { expectedVersion: v0, days }))).rejects.toBeInstanceOf(AuthzError);
    }
    // Another organization's owner cannot see the program at all.
    const other = await seedOrg("2026-03-02", { modules: ["training"] });
    const otherRod = await viewerFor(other, "rod");
    await expect(tx((t) => saveProgramLayout(t, otherRod, p.id, { expectedVersion: v0, days }))).rejects.toThrow(/Program not found/);
  });

  it("concurrent saves from the same version: exactly one wins (row lock + version check)", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, d1, a, b, c, version: v0 } = await buildProgram();
    const results = await Promise.allSettled([
      tx((t) => saveProgramLayout(t, rod, p.id, { expectedVersion: v0, days: [{ dayId: d1.id, items: [{ id: c.id, group: "1" }, { id: b.id, group: "2" }, { id: a.id, group: "3" }] }] })),
      tx((t) => saveProgramLayout(t, rod, p.id, { expectedVersion: v0, days: [{ dayId: d1.id, items: [{ id: b.id, group: "1" }, { id: a.id, group: "2" }, { id: c.id, group: "3" }] }] })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await version(p.id)).toBe(v0 + 1);
  });

  it("existing assignments keep their frozen workouts and version", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, d1, a, b, c, version: v0 } = await buildProgram();
    const { assignment } = await tx((t) => assignProgram(t, rod, { programId: p.id, athleteId: ctx.athletes.dana, startDate: "2026-03-09", daysOfWeek: [1, 3] }));
    const ws = await testDb().select().from(workouts).where(eq(workouts.assignmentId, assignment.id));
    const snapshot = async () =>
      testDb()
        .select({ id: workoutItems.id, sortOrder: workoutItems.sortOrder, blockLabel: workoutItems.blockLabel, exerciseId: workoutItems.exerciseId })
        .from(workoutItems)
        .where(inArray(workoutItems.workoutId, ws.map((w) => w.id)))
        .orderBy(asc(workoutItems.id));
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await tx((t) => saveProgramLayout(t, rod, p.id, { expectedVersion: v0, days: [{ dayId: d1.id, items: [{ id: c.id, group: "1" }, { id: a.id, group: "2" }, { id: b.id, group: "2" }] }] }));
    expect(await snapshot()).toEqual(before);
    const [asg] = await testDb().select().from(programAssignments).where(eq(programAssignments.id, assignment.id));
    expect(asg.programVersion).toBe(v0);
    expect(await version(p.id)).toBe(v0 + 1);
  });
});

describe("copyDay", () => {
  it("copies into an empty slot (new day) or appends after an existing day's blocks", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, d1, d2, version: v0 } = await buildProgram();
    const r1 = await tx((t) => copyDay(t, rod, p.id, d1.id, { week: 2, dayIndex: 1 }));
    expect(r1).toMatchObject({ created: true, copied: 3, version: v0 + 1 });
    const [nd] = await testDb().select().from(programDays).where(eq(programDays.id, r1.dayId));
    expect([nd.week, nd.dayIndex, nd.title, nd.phaseId]).toEqual([2, 1, "Lower", d1.phaseId]);
    expect((await dayRows(r1.dayId)).map((i) => i.blockLabel)).toEqual(["A1", "B1", "B2"]);

    const r2 = await tx((t) => copyDay(t, rod, p.id, d1.id, { week: 1, dayIndex: 2 }));
    expect(r2).toMatchObject({ created: false, dayId: d2.id, version: v0 + 2 });
    const rows = await dayRows(d2.id);
    expect(rows.map((i) => [i.sortOrder, i.blockLabel, i.blockType])).toEqual([
      [0, "A1", "straight"],
      [1, "B1", "straight"],
      [2, "C1", "superset"],
      [3, "C2", "superset"],
    ]);
    await expect(tx((t) => copyDay(t, rod, p.id, d1.id, { week: 1, dayIndex: 1 }))).rejects.toThrow(/different week or day/);
  });
});

describe("bulkEditScheme", () => {
  it("patches working set groups of the selected items only; warm-ups untouched; one version bump", async () => {
    const rod = await viewerFor(ctx, "rod");
    const { p, a, b, e, c, version: v0 } = await buildProgram();
    const r = await tx((t) => bulkEditScheme(t, rod, p.id, [a.id, e.id, b.id], { sets: 5, reps: 3, load: { type: "percent_max", percent: 85 }, restS: 180 }));
    expect(r).toEqual({ updated: 3, version: v0 + 1 });
    const rows = await testDb().select().from(programItems).where(inArray(programItems.id, [a.id, b.id, c.id]));
    const byId = new Map(rows.map((i) => [i.id, i.prescription]));
    expect(byId.get(a.id)).toEqual([
      { sets: 1, reps: 5, load: { type: "percent_max", percent: 50 }, isWarmup: true },
      { sets: 5, reps: 3, load: { type: "percent_max", percent: 85 }, restS: 180 },
    ]);
    expect(byId.get(b.id)).toEqual([{ sets: 5, reps: 3, load: { type: "percent_max", percent: 85 }, restS: 180 }]);
    expect(byId.get(c.id)).toEqual([{ sets: 3, durationS: 30 }]); // not selected

    await tx((t) => bulkEditScheme(t, rod, p.id, [a.id], { sets: 2, applyTo: "all" }));
    expect((await testDb().select().from(programItems).where(eq(programItems.id, a.id)))[0].prescription.map((g) => g.sets)).toEqual([2, 2]);
  });

  it("validates input and scope", async () => {
    const rod = await viewerFor(ctx, "rod");
    const one = await buildProgram();
    const two = await buildProgram();
    await expect(tx((t) => bulkEditScheme(t, rod, one.p.id, [], { sets: 3 }))).rejects.toThrow(/Select at least one/);
    await expect(tx((t) => bulkEditScheme(t, rod, one.p.id, [one.a.id], {}))).rejects.toThrow();
    await expect(tx((t) => bulkEditScheme(t, rod, one.p.id, [one.a.id, two.a.id], { sets: 3 }))).rejects.toThrow(/not found/);
    await expect(tx((t) => bulkEditScheme(t, rod, one.p.id, [one.a.id], { sets: 99 }))).rejects.toThrow();
    const erin = await viewerFor(ctx, "erin");
    await expect(tx((t) => bulkEditScheme(t, erin, one.p.id, [one.a.id], { sets: 3 }))).rejects.toBeInstanceOf(AuthzError);
    expect(await version(one.p.id)).toBe(one.version);
  });
});
