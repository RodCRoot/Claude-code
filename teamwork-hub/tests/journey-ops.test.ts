import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, coachReflections, locations, notes, opsChecklistItems, opsChecklistTicks, scheduleSessions, serviceTypes, bookings } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { addOpsItem, addSampleOpsItems, opsChecklistForDay, opsMonthGrid, SAMPLE_OPS_ITEMS, setOpsTick, updateOpsItem } from "@/lib/journey/ops";
import { coachScorecard, coachScorecards, saveReflection } from "@/lib/journey/scorecard";
import { syncJourneys } from "@/lib/journey/sync";
import { completeStep } from "@/lib/journey/steps";
import { athletes, journeySteps, tasks } from "@/db/schema";
import { addDaysYmd, localToUtc, startOfWeekYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

/** The checklist is ticked for the real "today" (facility time); the scorecard uses a fixed week. */
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const viewer = (k: string) => viewerFor(ctx, k);
const REAL_TODAY = todayLocal();

beforeAll(async () => {
  ctx = await seedOrg("2026-10-12", { modules: [] });
});
afterAll(closeTestDb);

describe("operations checklist", () => {
  let locA = "";
  let locB = "";
  it("is configured per location by owner or admin only", async () => {
    const [rod, erin] = await Promise.all(["rod", "erin"].map(viewer));
    const [a] = await db().insert(locations).values({ orgId: ctx.orgId, name: "North (sample)" }).returning();
    const [b] = await db().insert(locations).values({ orgId: ctx.orgId, name: "South (sample)" }).returning();
    locA = a.id;
    locB = b.id;
    await expect(db().transaction((tx) => addOpsItem(tx, erin, { section: "opening", label: "Unlock", locationId: locA }))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => addSampleOpsItems(tx, rod, locA));
    await db().transaction((tx) => addOpsItem(tx, rod, { section: "closing", label: "Set the alarm", locationId: locB }));
    await db().transaction((tx) => addOpsItem(tx, rod, { section: "weekly", label: "Bank run", locationId: "" })); // every location
    const other = await seedOrg("2026-10-12", { modules: [] });
    const [foreign] = await db().insert(locations).values({ orgId: other.orgId, name: "Elsewhere" }).returning();
    await expect(db().transaction((tx) => addOpsItem(tx, rod, { section: "opening", label: "Nope", locationId: foreign.id }))).rejects.toBeInstanceOf(UserError);
    const dayA = await opsChecklistForDay(db(), erin, { locationId: locA });
    expect(dayA.items.length).toBe(SAMPLE_OPS_ITEMS.length + 1);
    const dayB = await opsChecklistForDay(db(), erin, { locationId: locB });
    expect(dayB.items.map((i) => i.label).sort()).toEqual(["Bank run", "Set the alarm"]);
  });

  it("is ticked per day by whoever is on shift, once, and audited", async () => {
    const [erin, marcus, alex, rod] = await Promise.all(["erin", "marcus", "alex", "rod"].map(viewer));
    const day = await opsChecklistForDay(db(), erin, { locationId: locA });
    const opening = day.items.filter((i) => i.section === "opening");
    await db().transaction((tx) => setOpsTick(tx, erin, { itemId: opening[0].id, day: REAL_TODAY, done: true }));
    await db().transaction((tx) => setOpsTick(tx, marcus, { itemId: opening[0].id, day: REAL_TODAY, done: true })); // already done: no second tick
    await db().transaction((tx) => setOpsTick(tx, marcus, { itemId: opening[1].id, day: REAL_TODAY, done: true }));
    expect((await db().select().from(opsChecklistTicks).where(eq(opsChecklistTicks.orgId, ctx.orgId))).length).toBe(2);
    const after = await opsChecklistForDay(db(), marcus, { locationId: locA });
    expect(after.items.find((i) => i.id === opening[0].id)!.tick?.by).toBe(erin.displayName);
    expect(after.items.find((i) => i.id === opening[2].id)!.tick).toBeNull();
    await expect(db().transaction((tx) => setOpsTick(tx, alex, { itemId: opening[2].id, day: REAL_TODAY, done: true }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => setOpsTick(tx, erin, { itemId: opening[2].id, day: addDaysYmd(REAL_TODAY, -5), done: true }))).rejects.toBeInstanceOf(UserError);
    await expect(db().transaction((tx) => setOpsTick(tx, erin, { itemId: opening[2].id, day: addDaysYmd(REAL_TODAY, 1), done: true }))).rejects.toBeInstanceOf(UserError);
    // Only the person who ticked it (or an owner/admin) can untick.
    await expect(db().transaction((tx) => setOpsTick(tx, marcus, { itemId: opening[0].id, day: REAL_TODAY, done: false }))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => setOpsTick(tx, rod, { itemId: opening[1].id, day: REAL_TODAY, done: false }));
    expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "ops_checklist.tick")))).length).toBe(2);
    expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "ops_checklist.untick")))).length).toBe(1);
  });

  it("weekly items are ticked once per week; the month grid counts daily items per day", async () => {
    const erin = await viewer("erin");
    const day = await opsChecklistForDay(db(), erin, { locationId: locA });
    const weekly = day.items.find((i) => i.label === "Bank run")!;
    await db().transaction((tx) => setOpsTick(tx, erin, { itemId: weekly.id, day: REAL_TODAY, done: true }));
    const [t] = await db().select().from(opsChecklistTicks).where(eq(opsChecklistTicks.itemId, weekly.id));
    expect(t.localDate).toBe(startOfWeekYmd(REAL_TODAY));
    const grid = await opsMonthGrid(db(), erin, { locationId: locA });
    const dailyCount = SAMPLE_OPS_ITEMS.filter(([s]) => s !== "weekly").length;
    expect(grid.dailyTotal).toBe(dailyCount);
    expect(grid.days.find((d) => d.day === REAL_TODAY)).toMatchObject({ done: 1, total: dailyCount, future: false });
    expect(grid.days.length).toBeGreaterThanOrEqual(28);
    expect(grid.weekly.find((x) => x.weekStart === startOfWeekYmd(REAL_TODAY))).toMatchObject({ done: 1, total: SAMPLE_OPS_ITEMS.filter(([s]) => s === "weekly").length + 1 });
    // Location B shares only the every-location weekly item.
    const gridB = await opsMonthGrid(db(), erin, { locationId: locB });
    expect(gridB.days.find((d) => d.day === REAL_TODAY)).toMatchObject({ done: 0, total: 1 });
    // Turning an item off removes it from the day list.
    const rod = await viewer("rod");
    const [row] = await db().select().from(opsChecklistItems).where(eq(opsChecklistItems.id, weekly.id));
    await db().transaction((tx) => updateOpsItem(tx, rod, { id: row.id, section: row.section, label: row.label, locationId: "", sortOrder: 0, active: false }));
    expect((await opsChecklistForDay(db(), erin, { locationId: locB })).items.map((i) => i.label)).toEqual(["Set the alarm"]);
  });
});

describe("coach weekly scorecard", () => {
  const WEEK = "2026-10-05"; // Monday
  const TODAY = "2026-10-12";
  it("computes utilisation, reach-outs, assessments held and on-time touchpoints for the coach's own week", async () => {
    const w = await retentionWorld(ctx, TODAY);
    const A = ctx.athletes;
    // marcus: one class last week, capacity 100, 3 live bookings.
    await w.membership(A.maya, "parker", 300);
    for (const k of ["maya", "leo", "ethan"]) await w.booking(A[k], -4, k === "leo" ? "no_show" : "attended");
    await w.booking(A.sofia, -4, "cancelled");
    // An assessment that was held, and one nobody attended.
    const [svc] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Assessment (sample)", kind: "assessment", defaultCapacity: 1 }).returning();
    const mk = async (offset: number, attended: boolean) => {
      const startsAt = localToUtc(addDaysYmd(TODAY, offset), "10:00", ctx.tz);
      const [s] = await db().insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId: svc.id, title: "Assessment", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: ctx.tz, coachUserId: ctx.users.marcus, capacity: 1 }).returning();
      await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: A.maya, status: attended ? "attended" : "no_show", entitlementSource: "membership" });
    };
    await mk(-3, true);
    await mk(-2, false);
    // Reach-outs: two notes in the week, one outside it, one by someone else.
    const at = (offset: number) => new Date(Date.parse(`${addDaysYmd(TODAY, offset)}T18:00:00Z`));
    const [{ mayaPerson }] = await db().select({ mayaPerson: athletes.personId }).from(athletes).where(eq(athletes.id, A.maya));
    await db().insert(notes).values([
      { orgId: ctx.orgId, subjectPersonId: mayaPerson, authorUserId: ctx.users.marcus, body: "x", category: "reach_out", createdAt: at(-5) },
      { orgId: ctx.orgId, subjectPersonId: mayaPerson, authorUserId: ctx.users.marcus, body: "x", category: "check_in", createdAt: at(-3) },
      { orgId: ctx.orgId, subjectPersonId: mayaPerson, authorUserId: ctx.users.marcus, body: "x", category: "general", createdAt: at(-3) },
      { orgId: ctx.orgId, subjectPersonId: mayaPerson, authorUserId: ctx.users.marcus, body: "x", category: "reach_out", createdAt: at(0) },
      { orgId: ctx.orgId, subjectPersonId: mayaPerson, authorUserId: ctx.users.tess, body: "x", category: "reach_out", createdAt: at(-3) },
    ]);
    // Touchpoints due last week for dana (directly assigned to marcus): one done on time, one left open.
    await w.membership(A.dana, "dana", 0, { startDate: "2026-04-08" }); // 6 months = Oct 8
    await db().transaction((tx) => syncJourneys(tx, ctx.orgId, { today: "2026-10-06", now: new Date("2026-10-06T16:00:00Z"), athleteIds: [A.dana] }));
    const [step] = await db().select({ taskId: journeySteps.taskId, assignee: tasks.assigneeUserId, dueOn: journeySteps.dueOn }).from(journeySteps).innerJoin(tasks, eq(tasks.id, journeySteps.taskId)).where(and(eq(journeySteps.athleteId, A.dana), eq(journeySteps.kind, "touchpoints")));
    expect(step).toMatchObject({ assignee: ctx.users.marcus, dueOn: "2026-10-08" });
    const marcus = await viewer("marcus");
    await db().transaction((tx) => completeStep(tx, marcus, { taskId: step.taskId, note: "Six-month check-in (sample)." }, { now: new Date("2026-10-08T15:00:00Z"), today: "2026-10-08" }));

    const card = await coachScorecard(db(), marcus, { weekStart: "2026-10-07" }); // any day in the week
    expect(card).toMatchObject({ weekStart: WEEK, weekEnd: "2026-10-11", sessions: 3, capacity: 102, booked: 5, utilisationPercent: 5, meetings: 1, touchpointsDue: 1, touchpointsOnTime: 1, touchpointsOnTimePercent: 100 });
    expect(card.reachOuts).toBe(2 + 1); // two logged by hand plus the check-in note the touchpoint wrote (Oct 8)
    expect(card.targets).toEqual({ utilisationPercent: 70, reachOuts: 10, meetings: 3, touchpointsOnTimePercent: 90 });
    // A week with nothing has nulls, not zeros, for the two rates.
    const empty = await coachScorecard(db(), marcus, { weekStart: "2026-08-03" });
    expect(empty).toMatchObject({ sessions: 0, utilisationPercent: null, touchpointsOnTimePercent: null, reachOuts: 0 });
  });

  it("coaches see only their own; owner and admin see all; the reflection is the coach's own", async () => {
    const [rod, erin, marcus, tess, alex] = await Promise.all(["rod", "erin", "marcus", "tess", "alex"].map(viewer));
    await expect(coachScorecard(db(), tess, { coachUserId: ctx.users.marcus, weekStart: WEEK })).rejects.toBeInstanceOf(AuthzError);
    await expect(coachScorecard(db(), erin, { coachUserId: ctx.users.marcus, weekStart: WEEK })).rejects.toBeInstanceOf(AuthzError);
    await expect(coachScorecard(db(), alex, { weekStart: WEEK })).rejects.toBeInstanceOf(AuthzError);
    await expect(coachScorecards(db(), marcus, { weekStart: WEEK })).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => saveReflection(tx, marcus, { weekStart: WEEK, wentWell: "Full classes (sample).", stuck: "", helpNeeded: "A second rack." }));
    await db().transaction((tx) => saveReflection(tx, marcus, { weekStart: "2026-10-09", wentWell: "Full classes, good energy (sample).", stuck: "", helpNeeded: "A second rack." }));
    expect((await db().select().from(coachReflections).where(eq(coachReflections.orgId, ctx.orgId))).length).toBe(1);
    await expect(db().transaction((tx) => saveReflection(tx, marcus, { weekStart: "2999-01-04" }))).rejects.toBeInstanceOf(AuthzError);
    const all = await coachScorecards(db(), rod, { weekStart: WEEK });
    expect(all.map((c) => c.coachName).sort()).toEqual([marcus.displayName, tess.displayName].sort());
    expect(all.find((c) => c.coachUserId === ctx.users.marcus)!.reflection).toMatchObject({ wentWell: "Full classes, good energy (sample).", stuck: null, helpNeeded: "A second rack." });
    expect(all.find((c) => c.coachUserId === ctx.users.tess)!.reflection).toBeNull();
    expect((await coachScorecard(db(), rod, { coachUserId: ctx.users.marcus, weekStart: WEEK })).sessions).toBe(3);
    // The reflection text never lands in the audit log.
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "scorecard.reflection_save")));
    expect(audits.length).toBe(2);
    expect(JSON.stringify(audits)).not.toContain("second rack");
  });
});
