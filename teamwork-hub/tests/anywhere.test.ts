import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activitySessions, anywhereCompletions, anywhereSeasonEvents, anywhereSessions, anywhereSportLogs, bodyRegionReports, exercises, guardianships, habitAssignments, habits, xpEvents } from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { assignSession, assignmentBoard, assignmentsForAthlete } from "@/lib/anywhere/assignments";
import { anywhereAccess, saveAnywhereSettings } from "@/lib/anywhere/common";
import { anywhereHome } from "@/lib/anywhere/home";
import { ICS_MAX_BYTES, importStaged, stageIcs, stagedImport } from "@/lib/anywhere/ics";
import { weeklyLoadByOrigin } from "@/lib/anywhere/load-split";
import { addEvent, calendarForAthlete, createSeason, deleteSeason, gamesInNext48h, logSport, removeEvent, seasonsForAthlete } from "@/lib/anywhere/season";
import { addStep, completeSession, completionReviewQueue, completionsForAthlete, createSession, libraryForAthlete, markCompletionReviewed, moveStep, sessionForAthlete, sessionForStaff, updateSession } from "@/lib/anywhere/sessions";
import { saveEngagementSettings } from "@/lib/engagement/settings";
import { refreshEngagement } from "@/lib/engagement/sync";
import { acwrRolling, dailyLoadSeries, monotonyStrain, weeklyTotals } from "@/lib/science/formulas";
import { checkinHabit } from "@/lib/science/habits";
import { athleteLoad, loadAlerts, metricsAnchor } from "@/lib/science/load";
import { addDaysYmd, isoWeekday, localToUtc, startOfWeekYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
// Real "today": several functions default to the facility clock, so the fixtures use it too.
const TODAY = todayLocal();
const NOW = new Date();
const db = testDb();
let ctx: Ctx;
let other: Ctx;
const V: Record<string, Viewer> = {};
const S: Record<string, string> = {};
let n = 0;
const key = () => `test-key-${Date.now()}-${n++}`;

const details = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: "Test session", category: "mobility", durationMinutes: 10, equipment: [], suitableUnder13: false, ...extra });

async function makeSession(title: string, extra: Record<string, unknown> = {}, publish = true) {
  const s = await createSession(db, V.marcus, details(title, extra));
  const [ex] = await db.select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, "Plank")));
  await addStep(db, V.marcus, s.id, { exerciseId: ex.id, prescription: "2 x 30 seconds" });
  await addStep(db, V.marcus, s.id, { exerciseId: ex.id, prescription: "1 x 45 seconds", cue: "Breathe" });
  if (publish) await updateSession(db, V.marcus, s.id, { ...details(title, extra), status: "published" });
  return s.id;
}

beforeAll(async () => {
  // No "anywhere" seed: every outside session in these tests is created by the test itself.
  ctx = await seedOrg(TODAY, { modules: ["scheduling", "training", "science"] });
  other = await seedOrg(TODAY, { modules: ["training"] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "maya", "dana", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  S.mobility = await makeSession("Test Mobility");
  S.kids = await makeSession("Test Kids Mobility", { suitableUnder13: true });
  S.band = await makeSession("Test Band Core", { category: "core", equipment: ["band"], durationMinutes: 20 });
  S.warmup = await makeSession("Test Warm-Up", { category: "pre_game_warmup", suitableUnder13: true });
  S.draft = await makeSession("Test Draft", {}, false);
});
afterAll(closeTestDb);

const A = () => ctx.athletes;

describe("library: builder authorization and what athletes see", () => {
  it("only coaches, admins and owners build sessions; a session needs a step before it is published", async () => {
    for (const who of ["erin", "alex", "maya", "kiosk"]) await expect(createSession(db, V[who], details("Nope"))).rejects.toThrow(AuthzError);
    const empty = await createSession(db, V.rod, details("Empty"));
    await expect(updateSession(db, V.rod, empty.id, { ...details("Empty"), status: "published" })).rejects.toThrow(UserError);
    await expect(createSession(db, V.rod, { ...details("Straight to live"), status: "published" })).rejects.toThrow(UserError);
    // Another organization's coach cannot edit it, and its exercises cannot be used here.
    await expect(updateSession(db, V.otherOwner, empty.id, details("Hijack"))).rejects.toThrow(AuthzError);
    const [foreign] = await db.select().from(exercises).where(eq(exercises.orgId, other.orgId)).limit(1);
    await expect(addStep(db, V.rod, empty.id, { exerciseId: foreign.id, prescription: "x" })).rejects.toThrow(UserError);
    await expect(sessionForStaff(db, V.otherOwner, S.mobility)).rejects.toThrow(AuthzError);
    await expect(sessionForStaff(db, V.maya, S.mobility)).rejects.toThrow(AuthzError);
  });

  it("steps reuse the exercise library and can be reordered", async () => {
    const before = await sessionForStaff(db, V.marcus, S.mobility);
    expect(before.steps.map((s) => s.prescription)).toEqual(["2 x 30 seconds", "1 x 45 seconds"]);
    expect(before.steps[0].exercise.name).toBe("Plank");
    await moveStep(db, V.marcus, before.steps[1].id, "up");
    const after = await sessionForStaff(db, V.marcus, S.mobility);
    expect(after.steps.map((s) => [s.sortOrder, s.prescription])).toEqual([[1, "1 x 45 seconds"], [2, "2 x 30 seconds"]]);
    await expect(moveStep(db, V.maya, before.steps[0].id, "up")).rejects.toThrow(AuthzError);
  });

  it("athletes see published sessions only; filters work; under-13 athletes see only suitable ones", async () => {
    const maya = await libraryForAthlete(db, V.maya, A().maya, {}, TODAY);
    expect(maya.map((s) => s.title).sort()).toEqual(["Test Band Core", "Test Kids Mobility", "Test Mobility", "Test Warm-Up"]);
    expect((await libraryForAthlete(db, V.maya, A().maya, { maxMinutes: 10, equipment: "none" }, TODAY)).map((s) => s.title)).not.toContain("Test Band Core");
    // Eli is 12: through his guardian, the list holds only sessions marked suitable.
    const eli = await libraryForAthlete(db, V.alex, A().eli, {}, TODAY);
    expect(eli.map((s) => s.title).sort()).toEqual(["Test Kids Mobility", "Test Warm-Up"]);
    await expect(sessionForAthlete(db, V.alex, A().eli, S.mobility, TODAY)).rejects.toThrow(AuthzError);
    await expect(sessionForAthlete(db, V.maya, A().maya, S.draft, TODAY)).rejects.toThrow(AuthzError);
    expect((await sessionForAthlete(db, V.maya, A().maya, S.mobility, TODAY)).steps).toHaveLength(2);
    expect((await anywhereAccess(db, V.alex, A().eli, TODAY))?.restricted).toBe(true);
    expect((await anywhereAccess(db, V.maya, A().maya, TODAY))?.restricted).toBe(false);
  });

  it("scope: unrelated guardian, another athlete, another org and the kiosk get nothing", async () => {
    await expect(libraryForAthlete(db, V.chris, A().maya)).rejects.toThrow(AuthzError);
    await expect(libraryForAthlete(db, V.maya, A().leo)).rejects.toThrow(AuthzError);
    await expect(libraryForAthlete(db, V.otherOwner, A().maya)).rejects.toThrow(AuthzError);
    await expect(libraryForAthlete(db, V.kiosk, A().maya)).rejects.toThrow(AuthzError);
    await expect(sessionForAthlete(db, V.otherOwner, other.athletes.maya, S.mobility)).rejects.toThrow(AuthzError);
    expect(await anywhereAccess(db, V.otherOwner, A().maya)).toBeNull();
  });
});

describe("completions: idempotent, own record, feed streak, XP and load", () => {
  it("is idempotent on the client key, even when two retries race", async () => {
    const clientKey = key();
    const input = { athleteId: A().maya, sessionId: S.mobility, clientKey, stepsDone: 2, durationMinutes: null, rpe: null };
    const first = await db.transaction((tx) => completeSession(tx, V.maya, input, NOW));
    expect(first).toMatchObject({ status: "applied", loadLogged: false });
    const again = await db.transaction((tx) => completeSession(tx, V.maya, input, NOW));
    expect(again).toMatchObject({ status: "duplicate", completionId: first.completionId });
    const racedKey = key();
    const raced = await Promise.allSettled(Array.from({ length: 4 }, () => db.transaction((tx) => completeSession(tx, V.maya, { ...input, clientKey: racedKey, durationMinutes: 12, rpe: 3 }, NOW))));
    expect(raced.filter((r) => r.status === "fulfilled" && r.value.status === "applied")).toHaveLength(1);
    const rows = await db.select().from(anywhereCompletions).where(and(eq(anywhereCompletions.orgId, ctx.orgId), eq(anywhereCompletions.clientKey, racedKey)));
    expect(rows).toHaveLength(1);
    // Exactly one load row for the raced completion, none for the one without RPE and minutes.
    const loads = await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().maya), eq(activitySessions.source, "on_your_own")));
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ kind: "training", durationMinutes: 12, sessionRpe: 3, activityDate: TODAY });
    expect(rows[0].activitySessionId).toBe(loads[0].id);
    const [noLoad] = await db.select().from(anywhereCompletions).where(eq(anywhereCompletions.id, first.completionId));
    expect(noLoad).toMatchObject({ activitySessionId: null, durationMinutes: null, rpe: null, stepsDone: 2, stepsTotal: 2, sessionTitle: "Test Mobility", localDate: TODAY });
  });

  it("only RPE or only minutes logs no load (missing is never zero)", async () => {
    const before = await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().dana), eq(activitySessions.source, "on_your_own")));
    await db.transaction((tx) => completeSession(tx, V.dana, { athleteId: A().dana, sessionId: S.mobility, clientKey: key(), stepsDone: 1, durationMinutes: 10, rpe: null }, NOW));
    await db.transaction((tx) => completeSession(tx, V.dana, { athleteId: A().dana, sessionId: S.mobility, clientKey: key(), stepsDone: 1, durationMinutes: null, rpe: 4 }, NOW));
    const after = await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().dana), eq(activitySessions.source, "on_your_own")));
    expect(after).toHaveLength(before.length);
  });

  it("who may finish a session: the athlete and their own coach; not guardians, other coaches or other athletes", async () => {
    const input = (athleteId: string, sessionId = S.kids) => ({ athleteId, sessionId, clientKey: key(), stepsDone: 1, durationMinutes: null, rpe: null });
    for (const who of ["alex", "jordan", "chris", "tess", "dana", "erin", "kiosk", "otherOwner"]) await expect(db.transaction((tx) => completeSession(tx, V[who], input(A().maya), NOW))).rejects.toThrow(AuthzError);
    expect((await db.transaction((tx) => completeSession(tx, V.marcus, input(A().maya), NOW))).status).toBe("applied");
    // Tess coaches Eli (12): a session not marked suitable is refused even for the coach.
    await expect(db.transaction((tx) => completeSession(tx, V.tess, input(A().eli, S.mobility), NOW))).rejects.toThrow(AuthzError);
    expect((await db.transaction((tx) => completeSession(tx, V.tess, input(A().eli, S.kids), NOW))).status).toBe("applied");
    // A draft cannot be completed, and a key cannot be replayed for another athlete.
    await expect(db.transaction((tx) => completeSession(tx, V.maya, input(A().maya, S.draft), NOW))).rejects.toThrow(AuthzError);
    const shared = key();
    await db.transaction((tx) => completeSession(tx, V.maya, { ...input(A().maya), clientKey: shared }, NOW));
    await expect(db.transaction((tx) => completeSession(tx, V.dana, { ...input(A().dana), clientKey: shared }, NOW))).rejects.toThrow(AuthzError);
  });

  it("a late offline retry keeps the time the athlete finished, within limits", async () => {
    const finished = new Date(NOW.getTime() - 26 * 3_600_000);
    const r = await db.transaction((tx) => completeSession(tx, V.dana, { athleteId: A().dana, sessionId: S.band, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null, completedAt: finished.toISOString() }, NOW));
    const [row] = await db.select().from(anywhereCompletions).where(eq(anywhereCompletions.id, r.completionId));
    expect(row.completedAt.toISOString()).toBe(finished.toISOString());
    const future = await db.transaction((tx) => completeSession(tx, V.dana, { athleteId: A().dana, sessionId: S.band, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null, completedAt: new Date(NOW.getTime() + 86_400_000).toISOString() }, NOW));
    const [f] = await db.select().from(anywhereCompletions).where(eq(anywhereCompletions.id, future.completionId));
    expect(f.completedAt.toISOString()).toBe(NOW.toISOString());
  });

  it("counts toward the weekly streak and earns the configurable On Your Own XP once", async () => {
    const leo = A().leo;
    const before = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }));
    const r = await db.transaction((tx) => completeSession(tx, V.marcus, { athleteId: leo, sessionId: S.mobility, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null }, NOW));
    const after = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }));
    expect(after!.streak.thisWeekActive).toBe(true);
    expect(after!.streak.current).toBeGreaterThanOrEqual(Math.max(1, before!.streak.current));
    const xp = await db.select().from(xpEvents).where(and(eq(xpEvents.athleteId, leo), eq(xpEvents.kind, "on_your_own_completed")));
    expect(xp).toHaveLength(1);
    expect(xp[0]).toMatchObject({ points: 10, sourceType: "anywhere_completion", sourceId: r.completionId, idempotencyKey: `own:${r.completionId}` });
    expect(after!.level!.xp - before!.level!.xp).toBe(10);
    await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }));
    expect(await db.select().from(xpEvents).where(and(eq(xpEvents.athleteId, leo), eq(xpEvents.kind, "on_your_own_completed")))).toHaveLength(1);
    // New point value applies to the next award only.
    await db.transaction((tx) => saveEngagementSettings(tx, V.rod, { levelsEnabled: true, badgesEnabled: true, session_attended: 20, workout_completed: 15, wellness_checkin: 5, pr_set: 25, goal_achieved: 50, form_signed: 10, on_your_own_completed: 6 }));
    await db.transaction((tx) => completeSession(tx, V.marcus, { athleteId: leo, sessionId: S.band, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null }, NOW));
    await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }));
    const pts = (await db.select().from(xpEvents).where(and(eq(xpEvents.athleteId, leo), eq(xpEvents.kind, "on_your_own_completed")))).map((x) => x.points).sort();
    expect(pts).toEqual([10, 6]);
    await expect(db.execute(sql`insert into xp_events (org_id, athlete_id, kind, points, source_type, source_id, idempotency_key, occurred_at) values (${ctx.orgId}, ${leo}, 'made_up_kind', 1, 'x', 'x', ${key()}, now())`)).rejects.toThrow();
  });

  it("history and the coach review queue follow training scope", async () => {
    expect((await completionsForAthlete(db, V.jordan, A().maya)).length).toBeGreaterThan(0);
    await expect(completionsForAthlete(db, V.chris, A().maya)).rejects.toThrow(AuthzError);
    const marcus = await completionReviewQueue(db, V.marcus);
    const tess = await completionReviewQueue(db, V.tess);
    expect(marcus.some((c) => c.athleteId === A().maya)).toBe(true);
    expect(marcus.some((c) => c.athleteId === A().eli)).toBe(false);
    expect(tess.every((c) => c.athleteId !== A().maya && c.athleteId !== A().dana)).toBe(true);
    expect(tess.some((c) => c.athleteId === A().eli)).toBe(true);
    await expect(completionReviewQueue(db, V.alex)).rejects.toThrow(AuthzError);
    const mine = marcus.find((c) => c.athleteId === A().maya)!;
    await expect(markCompletionReviewed(db, V.tess, mine.id)).rejects.toThrow(AuthzError);
    await markCompletionReviewed(db, V.marcus, mine.id);
    expect((await completionReviewQueue(db, V.marcus)).some((c) => c.id === mine.id)).toBe(false);
  });
});

describe("assignments", () => {
  it("coach assigns to a group in scope; completion status shows for the athlete and the coach", async () => {
    const week = { startDate: startOfWeekYmd(TODAY), endDate: addDaysYmd(startOfWeekYmd(TODAY), 6) };
    await expect(assignSession(db, V.tess, { what: "category:mobility", groupId: ctx.groups.hs, ...week })).rejects.toThrow(AuthzError);
    await expect(assignSession(db, V.erin, { what: "category:mobility", groupId: ctx.groups.hs, ...week })).rejects.toThrow(AuthzError);
    await expect(assignSession(db, V.alex, { what: "category:mobility", athleteId: A().maya, ...week })).rejects.toThrow(AuthzError);
    await expect(assignSession(db, V.marcus, { what: `session:${S.draft}`, athleteId: A().maya, ...week })).rejects.toThrow(UserError);
    await expect(assignSession(db, V.marcus, { what: "category:mobility", athleteId: A().maya, groupId: ctx.groups.hs, ...week })).rejects.toThrow();
    const a = await assignSession(db, V.marcus, { what: "category:mobility", groupId: ctx.groups.hs, ...week, targetCount: 12, note: "Lots of mobility" });
    const mine = (await assignmentsForAthlete(db, V.maya, A().maya, TODAY)).find((x) => x.id === a.id)!;
    expect(mine).toMatchObject({ title: "Any mobility session", target: 12, complete: false, sessionId: null, category: "mobility" });
    expect(mine.done).toBeGreaterThanOrEqual(1); // earlier tests finished mobility sessions today
    await db.transaction((tx) => completeSession(tx, V.maya, { athleteId: A().maya, sessionId: S.mobility, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null }, NOW));
    await db.transaction((tx) => completeSession(tx, V.maya, { athleteId: A().maya, sessionId: S.band, clientKey: key(), stepsDone: 2, durationMinutes: null, rpe: null }, NOW));
    const after = (await assignmentsForAthlete(db, V.jordan, A().maya, TODAY)).find((x) => x.id === a.id)!;
    expect(after.done).toBe(mine.done + 1); // the core session does not count toward a mobility assignment
    await expect(assignmentsForAthlete(db, V.chris, A().maya, TODAY)).rejects.toThrow(AuthzError);
    const board = await assignmentBoard(db, V.marcus, TODAY);
    const row = board.find((b) => b.id === a.id)!;
    expect(row.target).toBe("HS Speed & Strength");
    expect(row.athletes.find((x) => x.athleteId === A().maya)).toMatchObject({ done: after.done, complete: false });
    expect(row.athletes.find((x) => x.athleteId === A().leo)).toBeTruthy();
    // Tess does not coach the HS group: nothing of it appears on her board.
    expect((await assignmentBoard(db, V.tess, TODAY)).some((b) => b.id === a.id)).toBe(false);
    await expect(assignmentBoard(db, V.maya, TODAY)).rejects.toThrow(AuthzError);
  });

  it("an under-13 athlete never gets an unsuitable assigned session", async () => {
    const week = { startDate: TODAY, endDate: addDaysYmd(TODAY, 3) };
    const bad = await assignSession(db, V.tess, { what: `session:${S.mobility}`, groupId: ctx.groups.youth, ...week });
    const good = await assignSession(db, V.tess, { what: `session:${S.kids}`, groupId: ctx.groups.youth, ...week });
    const eli = await assignmentsForAthlete(db, V.alex, A().eli, TODAY);
    expect(eli.map((x) => x.id)).toContain(good.id);
    expect(eli.map((x) => x.id)).not.toContain(bad.id);
    const board = await assignmentBoard(db, V.tess, TODAY);
    expect(board.find((b) => b.id === bad.id)?.athletes.some((x) => x.athleteId === A().eli) ?? false).toBe(false);
    expect(board.find((b) => b.id === good.id)!.athletes.some((x) => x.athleteId === A().eli)).toBe(true);
  });
});

describe("My Season: calendar access and sport logs feeding sRPE load", () => {
  let seasonId: string;
  let practiceId: string;
  const yesterday = addDaysYmd(TODAY, -1);

  it("guardians who can book (and the athlete) edit the season; others only view; unrelated viewers get nothing", async () => {
    const input = (athleteId: string) => ({ athleteId, teamName: "Sample Club", sport: "Volleyball", startsOn: addDaysYmd(TODAY, -40), endsOn: addDaysYmd(TODAY, 40) });
    // Casey is Leo's guardian without booking rights.
    await expect(createSeason(db, V.casey, input(A().leo))).rejects.toThrow(AuthzError);
    expect(await seasonsForAthlete(db, V.casey, A().leo)).toEqual([]);
    await expect(createSeason(db, V.chris, input(A().maya))).rejects.toThrow(AuthzError);
    await expect(createSeason(db, V.tess, input(A().maya))).rejects.toThrow(AuthzError);
    await expect(createSeason(db, V.otherOwner, input(A().maya))).rejects.toThrow(AuthzError);
    await expect(createSeason(db, V.alex, { ...input(A().maya), endsOn: addDaysYmd(TODAY, -60) })).rejects.toThrow();
    const s = await createSeason(db, V.alex, input(A().maya));
    seasonId = s.id;
    // The athlete adds a weekly practice (yesterday's weekday) and a game today.
    const p = await addEvent(db, V.maya, { seasonId, kind: "practice", repeat: "weekly", weekdays: [isoWeekday(yesterday)], startTime: "16:30", durationMinutes: 90, location: "Sample gym" });
    practiceId = p.id;
    expect(p).toMatchObject({ startsOn: s.startsOn, endsOn: s.endsOn, timezone: "America/Indiana/Indianapolis" });
    await addEvent(db, V.alex, { seasonId, kind: "game", repeat: "once", date: TODAY, startTime: "23:59", opponent: "Sample Opponent", location: "123 Sample St <b>" });
    await expect(addEvent(db, V.alex, { seasonId, kind: "game", repeat: "once", date: addDaysYmd(TODAY, 90) })).rejects.toThrow(UserError);
    await expect(addEvent(db, V.jordan, { seasonId, kind: "rest", repeat: "once", date: TODAY })).resolves.toBeTruthy(); // Jordan can book
    await expect(addEvent(db, V.chris, { seasonId, kind: "rest", repeat: "once", date: TODAY })).rejects.toThrow(AuthzError);
    await expect(addEvent(db, V.tess, { seasonId, kind: "rest", repeat: "once", date: TODAY })).rejects.toThrow(AuthzError);
    await expect(seasonsForAthlete(db, V.chris, A().maya)).rejects.toThrow(AuthzError);
    await expect(seasonsForAthlete(db, V.tess, A().maya)).rejects.toThrow(AuthzError);
    await expect(calendarForAthlete(db, V.otherOwner, A().maya, TODAY, TODAY)).rejects.toThrow(AuthzError);
    expect((await seasonsForAthlete(db, V.marcus, A().maya))[0].events).toHaveLength(3);
    // Location text is stored exactly as typed (rendered as text, never geocoded or fetched).
    const [g] = await db.select().from(anywhereSeasonEvents).where(and(eq(anywhereSeasonEvents.seasonId, seasonId), eq(anywhereSeasonEvents.kind, "game")));
    expect(g.location).toBe("123 Sample St <b>");
  });

  it("existing load and ACWR are unchanged until an outside session is actually logged", async () => {
    const before = await athleteLoad(db, V.marcus, A().maya, TODAY);
    const alertsBefore = await loadAlerts(db, V.marcus, TODAY);
    // Having a season with unlogged practices, and On Your Own completions without RPE, changes nothing.
    const onlyNoLoad = before.entries.filter((e) => e.origin === "on_your_own");
    expect(onlyNoLoad).toHaveLength(1); // the one raced completion logged with 12 min at RPE 3
    const legacy = before.entries.filter((e) => e.origin !== "on_your_own");
    const legacySeries = dailyLoadSeries(legacy, before.from, before.to);
    // Recompute from the pre-existing rows only: identical on every day except today's 36 AU.
    for (const d of before.series) {
      const l = legacySeries.find((x) => x.date === d.date)!;
      if (d.date === TODAY) expect(d.load).toBe((l.load ?? 0) + 36);
      else expect(d).toEqual(l);
    }

    // Dana has no outside sessions with load at all: her numbers equal a recomputation from workouts and manual entries.
    const dana = await athleteLoad(db, V.marcus, A().dana, TODAY);
    expect(dana.entries.every((e) => e.origin !== "on_your_own" && (e.origin !== "sport" || e.source === "activity"))).toBe(true);
    const series = dailyLoadSeries(dana.entries, dana.from, dana.to);
    expect(dana.series).toEqual(series);
    expect(dana.acwr).toEqual(acwrRolling(series, metricsAnchor(series, TODAY), { minCoverage: dana.minCoverage }));
    expect(dana.weeks).toEqual(weeklyTotals(series));
    const ms = monotonyStrain(series, metricsAnchor(series, TODAY));
    expect([dana.monotony, dana.strain, dana.weeklyLoad]).toEqual([ms.monotony, ms.strain, ms.weeklyLoad]);

    // Unlogged practice yesterday: Maya's day is whatever it was before (not zero-filled by the season).
    const y = before.series.find((d) => d.date === yesterday)!;
    const cal = await calendarForAthlete(db, V.maya, A().maya, yesterday, yesterday);
    expect(cal).toHaveLength(1);
    expect(cal[0]).toMatchObject({ kind: "practice", loggable: true, log: null });
    expect(y).toEqual(legacySeries.find((d) => d.date === yesterday));

    // Now log it: 80 minutes at RPE 6 = 480 AU with source "sport".
    const r = await db.transaction((tx) => logSport(tx, V.maya, { athleteId: A().maya, eventId: practiceId, occurrenceDate: yesterday, durationMinutes: 80, rpe: 6 }, NOW));
    expect(r).toMatchObject({ status: "applied", load: 480 });
    const [act] = await db.select().from(activitySessions).where(eq(activitySessions.id, r.activitySessionId));
    expect(act).toMatchObject({ source: "sport", kind: "practice", durationMinutes: 80, sessionRpe: 6, activityDate: yesterday, workoutId: null });
    const after = await athleteLoad(db, V.marcus, A().maya, TODAY);
    const added = after.entries.find((e) => e.id === r.activitySessionId)!;
    expect(added).toMatchObject({ origin: "sport", load: 480, date: yesterday });
    const ya = after.series.find((d) => d.date === yesterday)!;
    expect(ya.status).toBe(y.status === "incomplete" ? "incomplete" : "logged");
    if (y.status !== "incomplete") expect(ya.load).toBe((y.load ?? 0) + 480);
    // Every other day is untouched, and the derived numbers are exactly the existing formulas over the new series.
    expect(after.series.filter((d) => d.date !== yesterday)).toEqual(before.series.filter((d) => d.date !== yesterday));
    const expected = dailyLoadSeries([...before.entries, { date: yesterday, durationMin: 80, rpe: 6, kind: "practice" }], before.from, before.to);
    expect(after.series).toEqual(expected);
    expect(after.acwr).toEqual(acwrRolling(expected, metricsAnchor(expected, TODAY), { minCoverage: after.minCoverage }));
    expect(after.acwr.formula).toBe("acwr_rolling_v1");
    // The split is display only: per-week origins add up to the week's known session loads.
    const split = weeklyLoadByOrigin(after.entries, after.from, after.to);
    const known = after.entries.filter((e) => e.kind !== "rest" && e.load !== null).reduce((s, e) => s + e.load!, 0);
    expect(split.reduce((s, w) => s + w.gym + w.sport + w.onYourOwn + w.other, 0)).toBe(known);
    expect(split.reduce((s, w) => s + w.sport, 0) - weeklyLoadByOrigin(before.entries, before.from, before.to).reduce((s, w) => s + w.sport, 0)).toBe(480);
    expect((await loadAlerts(db, V.marcus, TODAY)).length).toBeGreaterThanOrEqual(0);
    expect(alertsBefore).toBeDefined();
  });

  it("logging again updates the same row; bad dates and non-events are refused; access mirrors load logging", async () => {
    const again = await db.transaction((tx) => logSport(tx, V.maya, { athleteId: A().maya, eventId: practiceId, occurrenceDate: yesterday, durationMinutes: 85, rpe: 7 }, NOW));
    expect(again.status).toBe("updated");
    const logs = await db.select().from(anywhereSportLogs).where(and(eq(anywhereSportLogs.athleteId, A().maya), eq(anywhereSportLogs.eventId, practiceId)));
    expect(logs).toHaveLength(1);
    expect(await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().maya), eq(activitySessions.source, "sport")))).toHaveLength(1);
    const item = (await calendarForAthlete(db, V.jordan, A().maya, yesterday, yesterday))[0];
    expect(item.log).toEqual({ durationMinutes: 85, rpe: 7 }); // Jordan has training access (no health access needed, same as load)
    const log = (who: string, extra: Record<string, unknown> = {}) => db.transaction((tx) => logSport(tx, V[who], { athleteId: A().maya, eventId: practiceId, occurrenceDate: yesterday, durationMinutes: 60, rpe: 5, ...extra }, NOW));
    for (const who of ["alex", "jordan", "chris", "tess", "erin", "dana", "otherOwner"]) await expect(log(who)).rejects.toThrow(AuthzError);
    await expect(log("maya", { occurrenceDate: addDaysYmd(yesterday, 1) })).rejects.toThrow(UserError); // not a practice day
    await expect(log("maya", { occurrenceDate: addDaysYmd(yesterday, 7) })).rejects.toThrow(UserError); // future
    await expect(log("maya", { occurrenceDate: addDaysYmd(yesterday, -35) })).rejects.toThrow(UserError); // too old
    await expect(log("maya", { rpe: 11 })).rejects.toThrow();
    await expect(log("maya", { durationMinutes: 0 })).rejects.toThrow();
    // Without an event: needs a kind and a one-time key, and a double submit logs once.
    const adhoc = { athleteId: A().maya, occurrenceDate: addDaysYmd(TODAY, -3), kind: "game", durationMinutes: 70, rpe: 8, clientKey: key() };
    expect((await db.transaction((tx) => logSport(tx, V.marcus, adhoc, NOW))).status).toBe("applied");
    expect((await db.transaction((tx) => logSport(tx, V.marcus, adhoc, NOW))).status).toBe("duplicate");
    await expect(db.transaction((tx) => logSport(tx, V.maya, { ...adhoc, clientKey: undefined }, NOW))).rejects.toThrow(UserError);
  });

  it("a guardian without training access sees the calendar but no RPE, minutes or library", async () => {
    await db.update(guardianships).set({ canViewTraining: false }).where(and(eq(guardianships.guardianPersonId, V.jordan.personId!), eq(guardianships.athleteId, A().maya)));
    try {
      const cal = await calendarForAthlete(db, V.jordan, A().maya, yesterday, TODAY);
      expect(cal.length).toBeGreaterThanOrEqual(2);
      expect(cal.every((i) => i.log === undefined)).toBe(true);
      await expect(libraryForAthlete(db, V.jordan, A().maya)).rejects.toThrow(AuthzError);
      await expect(completionsForAthlete(db, V.jordan, A().maya)).rejects.toThrow(AuthzError);
      const home = await anywhereHome(db, V.jordan, A().maya, { today: TODAY, now: NOW });
      expect(home).toMatchObject({ assignments: null, daily3: null, toLog: null });
      expect(home.gameDay?.warmup).toBeNull();
      expect(JSON.stringify(home)).not.toMatch(/"rpe"|durationMinutes":8/);
    } finally {
      await db.update(guardianships).set({ canViewTraining: true }).where(and(eq(guardianships.guardianPersonId, V.jordan.personId!), eq(guardianships.athleteId, A().maya)));
    }
  });

  it("coaches see who has a game in the next 48 hours, only for their own athletes", async () => {
    const marcus = await gamesInNext48h(db, V.marcus, NOW);
    expect(marcus.filter((g) => g.athleteId === A().maya)).toHaveLength(1);
    expect(marcus[0]).toMatchObject({ athleteName: "Maya Parker", teamName: "Sample Club", kind: "game", opponent: "Sample Opponent", date: TODAY });
    expect(await gamesInNext48h(db, V.tess, NOW)).toEqual([]);
    expect((await gamesInNext48h(db, V.rod, NOW)).length).toBe(1);
    await expect(gamesInNext48h(db, V.alex, NOW)).rejects.toThrow(AuthzError);
    // A game three days out is not listed.
    await addEvent(db, V.alex, { seasonId, kind: "tournament", repeat: "once", date: addDaysYmd(TODAY, 3) });
    expect((await gamesInNext48h(db, V.marcus, NOW)).filter((g) => g.athleteId === A().maya)).toHaveLength(1);
  });

  it("Athlete Home: game day card, warm-up from the library category, log prompt, Daily 3; nothing depends on wellness or pain reports", async () => {
    const habitRows = await db.insert(habits).values(["Sleep 8h (test)", "Hydration (test)", "Protein (test)", "Mobility (test)"].map((name) => ({ orgId: ctx.orgId, name, frequency: "daily" as const, targetValue: 8, targetUnit: "h" }))).returning();
    await db.insert(habitAssignments).values(habitRows.map((h) => ({ habitId: h.id, athleteId: A().eli, startDate: addDaysYmd(TODAY, -3) })));
    const home = await anywhereHome(db, V.maya, A().maya, { today: TODAY, now: NOW });
    expect(home.gameDay).toMatchObject({ started: false, warmup: { id: S.warmup, title: "Test Warm-Up" } });
    expect(home.gameDay!.item).toMatchObject({ kind: "game", opponent: "Sample Opponent", location: "123 Sample St <b>", teamName: "Sample Club" });
    expect(home.toLog).toEqual([]); // yesterday's practice is logged; today's game has not started
    expect(home.inSeason).toBeNull(); // off by default
    // After the game starts the card asks for a log; the prompt list never repeats the game-day item.
    const late = await anywhereHome(db, V.maya, A().maya, { today: TODAY, now: localToUtc(addDaysYmd(TODAY, 1), "00:00") });
    expect(late.gameDay).toMatchObject({ started: true });
    expect(late.gameDay!.item.log).toBeNull();
    // A severe pain report and no wellness data change nothing about the suggestion.
    await db.insert(bodyRegionReports).values({ orgId: ctx.orgId, athleteId: A().maya, region: "knee", side: "left", view: "front", kind: "pain", severity: 9 });
    const afterPain = await anywhereHome(db, V.maya, A().maya, { today: TODAY, now: NOW });
    expect(afterPain.gameDay!.warmup).toEqual(home.gameDay!.warmup);
    expect(await libraryForAthlete(db, V.maya, A().maya, {}, TODAY)).toEqual(await libraryForAthlete(db, V.maya, A().maya, {}, TODAY));
    // Guardian view of Maya: sees the card, cannot log.
    const alex = await anywhereHome(db, V.alex, A().maya, { today: TODAY, now: NOW });
    expect(alex.toLog).toBeNull();
    expect(alex.access.canLog).toBe(false);
    // Daily 3: at most three assigned habits, checked off through the existing habit check-in.
    const eli = await anywhereHome(db, V.alex, A().eli, { today: TODAY, now: NOW });
    expect(eli.daily3).toHaveLength(3);
    expect(eli.daily3!.every((h) => h.status === null && h.target === "8 h")).toBe(true);
    expect(eli.gameDay).toBeNull();
    await expect(checkinHabit(db, V.alex, { habitId: eli.daily3![0].habitId, athleteId: A().eli, forDate: TODAY, status: "done" })).rejects.toThrow(AuthzError);
    await checkinHabit(db, V.tess, { habitId: eli.daily3![0].habitId, athleteId: A().eli, forDate: TODAY, status: "done" });
    expect((await anywhereHome(db, V.alex, A().eli, { today: TODAY, now: NOW })).daily3![0]).toMatchObject({ status: "done", streak: 1 });
    await expect(anywhereHome(db, V.chris, A().maya)).rejects.toThrow(AuthzError);
    await expect(anywhereHome(db, V.tess, A().maya)).rejects.toThrow(AuthzError);
  });

  it("the In Season link is off unless the organization turns it on, and never touches memberships", async () => {
    await expect(saveAnywhereSettings(db, V.marcus, { showInSeasonOption: true })).rejects.toThrow(AuthzError);
    const memberships = await db.execute(sql`select count(*)::int as n, coalesce(max(updated_at), 'epoch') as u from memberships where org_id = ${ctx.orgId}`);
    await db.transaction((tx) => saveAnywhereSettings(tx, V.rod, { showInSeasonOption: true }));
    const home = await anywhereHome(db, V.alex, A().maya, { today: TODAY, now: NOW });
    expect(home.inSeason).toEqual({ teamName: "Sample Club" });
    expect((await anywhereHome(db, V.alex, A().eli, { today: TODAY, now: NOW })).inSeason).toBeNull(); // no season
    expect((await db.execute(sql`select count(*)::int as n, coalesce(max(updated_at), 'epoch') as u from memberships where org_id = ${ctx.orgId}`)).rows).toEqual(memberships.rows);
    expect((await db.execute(sql`select count(*)::int as n from member_requests where org_id = ${ctx.orgId}`)).rows[0]).toEqual({ n: 0 });
  });

  it(".ics upload is staged for preview, then imported idempotently by UID", async () => {
    const start = addDaysYmd(TODAY, 5).replaceAll("-", "");
    const file = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ics-1", "SUMMARY:Away game", `DTSTART:${start}T180000`, "LOCATION:Sample fieldhouse", "END:VEVENT", "BEGIN:VEVENT", "UID:ics-2", "SUMMARY:Film practice", `DTSTART:${start}T090000`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const bytes = new TextEncoder().encode(file);
    await expect(stageIcs(db, V.chris, seasonId, "team.ics", bytes)).rejects.toThrow(AuthzError);
    await expect(stageIcs(db, V.tess, seasonId, "team.ics", bytes)).rejects.toThrow(AuthzError);
    await expect(stageIcs(db, V.alex, seasonId, "team.ics", new Uint8Array(ICS_MAX_BYTES + 1))).rejects.toThrow(/too large/);
    await expect(stageIcs(db, V.alex, seasonId, "team.txt", bytes)).rejects.toThrow(UserError);
    await expect(stageIcs(db, V.alex, seasonId, "team.ics", new TextEncoder().encode("hello"))).rejects.toThrow(/does not look like a calendar/);
    await expect(stageIcs(db, V.alex, seasonId, "team.ics", new Uint8Array([0xff, 0xfe, 0xfd]))).rejects.toThrow(/could not be read/);
    const count = async () => (await db.select().from(anywhereSeasonEvents).where(eq(anywhereSeasonEvents.seasonId, seasonId))).length;
    const before = await count();
    const staged = await stageIcs(db, V.alex, seasonId, "team.ics", bytes);
    expect(staged.events.map((e) => [e.uid, e.kind])).toEqual([["ics-2", "practice"], ["ics-1", "game"]]);
    expect(await count()).toBe(before); // preview only
    expect((await stagedImport(db, V.alex, seasonId))?.id).toBe(staged.id);
    await expect(importStaged(db, V.chris, staged.id)).rejects.toThrow(AuthzError);
    expect(await db.transaction((tx) => importStaged(tx, V.alex, staged.id))).toMatchObject({ added: 2, updated: 0 });
    await expect(db.transaction((tx) => importStaged(tx, V.alex, staged.id))).rejects.toThrow(UserError);
    const again = await stageIcs(db, V.maya, seasonId, "team.ics", new TextEncoder().encode(file.replace("Away game", "Away game (moved)")));
    expect(await db.transaction((tx) => importStaged(tx, V.maya, again.id))).toMatchObject({ added: 0, updated: 2 });
    expect(await count()).toBe(before + 2);
    const [moved] = await db.select().from(anywhereSeasonEvents).where(and(eq(anywhereSeasonEvents.seasonId, seasonId), eq(anywhereSeasonEvents.icsUid, "ics-1")));
    expect(moved).toMatchObject({ title: "Away game (moved)", kind: "game", startTimeLocal: "18:00", location: "Sample fieldhouse" });
    expect(await stagedImport(db, V.alex, seasonId)).toBeNull();
  });

  it("skipping one day of a weekly event and removing a season keep logged load", async () => {
    const next = (await calendarForAthlete(db, V.maya, A().maya, addDaysYmd(TODAY, 1), addDaysYmd(TODAY, 8))).find((i) => i.eventId === practiceId)!;
    await expect(removeEvent(db, V.chris, practiceId, next.date)).rejects.toThrow(AuthzError);
    await removeEvent(db, V.alex, practiceId, next.date);
    expect((await calendarForAthlete(db, V.maya, A().maya, addDaysYmd(TODAY, 1), addDaysYmd(TODAY, 8))).some((i) => i.eventId === practiceId)).toBe(false);
    const sportBefore = await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().maya), eq(activitySessions.source, "sport")));
    await expect(deleteSeason(db, V.chris, seasonId)).rejects.toThrow(AuthzError);
    await deleteSeason(db, V.alex, seasonId);
    expect(await seasonsForAthlete(db, V.maya, A().maya)).toEqual([]);
    expect(await db.select().from(activitySessions).where(and(eq(activitySessions.athleteId, A().maya), eq(activitySessions.source, "sport")))).toHaveLength(sportBefore.length);
  });
});

describe("database guards", () => {
  it("CHECK constraints reject impossible rows", async () => {
    await expect(db.insert(anywhereSessions).values({ orgId: ctx.orgId, title: "x", category: "nonsense" as never, durationMinutes: 10 })).rejects.toThrow();
    await expect(db.insert(anywhereSessions).values({ orgId: ctx.orgId, title: "x", category: "core", durationMinutes: 0 })).rejects.toThrow();
    await expect(db.insert(anywhereCompletions).values({ orgId: ctx.orgId, athleteId: A().maya, sessionId: S.mobility, sessionTitle: "x", category: "mobility", clientKey: key(), completedAt: NOW, localDate: TODAY, stepsDone: 1, stepsTotal: 1, rpe: 11 })).rejects.toThrow();
    await expect(db.execute(sql`insert into anywhere_assignments (org_id, category, start_date, end_date) values (${ctx.orgId}, 'core', ${TODAY}, ${TODAY})`)).rejects.toThrow();
    await expect(db.execute(sql`insert into anywhere_assignments (org_id, session_id, category, athlete_id, start_date, end_date) values (${ctx.orgId}, ${S.mobility}, 'core', ${A().maya}, ${TODAY}, ${TODAY})`)).rejects.toThrow();
  });
});
