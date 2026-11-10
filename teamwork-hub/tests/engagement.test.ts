import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { athleteBadges, athleteGoals, athletes, auditEvents, bookings, exercises, guardianships, maxes, membershipHolds, memberships, organizations, payerAuthorizations, people, questionnaireResponses, scheduleSessions, serviceTypes, xpEvents } from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { engagementAccess } from "@/lib/engagement/access";
import { INCOMPARABLE_LATEST, createGoal, evaluateGoals, goalLinkOptions, listGoals, setGoalStatus } from "@/lib/engagement/goals";
import { athleteHome, engagementStrip } from "@/lib/engagement/home";
import { DEFAULT_XP, engagementSettings, saveEngagementSettings } from "@/lib/engagement/settings";
import { readEngagement, refreshEngagement, syncBadges, syncXp } from "@/lib/engagement/sync";
import { createTestType, recordTestSession } from "@/lib/science/kpis";
import { addDaysYmd, localToUtc, startOfWeekYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02";
const db = testDb();
let ctx: Ctx;
let other: Ctx;
let serviceTypeId: string;
const V: Record<string, Viewer> = {};

beforeAll(async () => {
  ctx = await seedOrg(TODAY);
  other = await seedOrg(TODAY, { modules: [] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "maya", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  [{ id: serviceTypeId }] = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(eq(serviceTypes.orgId, ctx.orgId)).limit(1);
});
afterAll(closeTestDb);

let seq = 0;
async function newAthlete(dob: string | null = "2010-01-15") {
  const [p] = await db.insert(people).values({ orgId: ctx.orgId, firstName: `Test${++seq}`, lastName: "Athlete", dateOfBirth: dob, isDemo: true }).returning();
  const [a] = await db.insert(athletes).values({ orgId: ctx.orgId, personId: p.id, sport: "Track", isDemo: true }).returning();
  return a.id;
}
async function addSession(athleteId: string, ymd: string, hm = "17:00", status: "attended" | "booked" | "no_show" = "attended") {
  const startsAt = localToUtc(ymd, hm);
  const [s] = await db
    .insert(scheduleSessions)
    .values({ orgId: ctx.orgId, serviceTypeId, title: "Test session", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: "America/Indiana/Indianapolis", capacity: 10 })
    .returning();
  const [b] = await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId, status }).returning();
  return b.id;
}
const xpRows = (athleteId: string) => db.select().from(xpEvents).where(and(eq(xpEvents.orgId, ctx.orgId), eq(xpEvents.athleteId, athleteId)));
const xpTotal = async (athleteId: string) => (await xpRows(athleteId)).reduce((n, r) => n + r.points, 0);
const thisWeek = startOfWeekYmd(TODAY);
const weekAgo = (n: number, dayOffset = 2) => addDaysYmd(thisWeek, -7 * n + dayOffset);

describe("XP ledger", () => {
  it("the demo seed derived XP for athletes with history, and a second sync awards nothing", async () => {
    const before = await xpRows(ctx.athletes.maya);
    expect(before.length).toBeGreaterThan(5);
    expect(await db.transaction((tx) => syncXp(tx, ctx.orgId, ctx.athletes.maya))).toBe(0);
    expect(await db.transaction((tx) => syncXp(tx, ctx.orgId, ctx.athletes.maya))).toBe(0);
    expect((await xpRows(ctx.athletes.maya)).length).toBe(before.length);
    expect(new Set(before.map((r) => r.idempotencyKey)).size).toBe(before.length);
  });

  it("awards once per source row, even under concurrent sync", async () => {
    const a = await newAthlete();
    for (const n of [3, 2, 1]) await addSession(a, weekAgo(n));
    await addSession(a, weekAgo(1, 4), "17:00", "no_show"); // not attended: no XP
    await addSession(a, addDaysYmd(TODAY, 3), "17:00", "booked"); // future booking: no XP
    const results = await Promise.all(Array.from({ length: 8 }, () => db.transaction((tx) => syncXp(tx, ctx.orgId, a))));
    expect(results.reduce((x, y) => x + y, 0)).toBe(3);
    const rows = await xpRows(a);
    expect(rows.map((r) => r.kind)).toEqual(["session_attended", "session_attended", "session_attended"]);
    expect(await xpTotal(a)).toBe(3 * DEFAULT_XP.session_attended);
    // A new attended session adds exactly one more row.
    await addSession(a, TODAY, "06:00");
    expect(await db.transaction((tx) => syncXp(tx, ctx.orgId, a))).toBe(1);
    expect(await xpTotal(a)).toBe(4 * DEFAULT_XP.session_attended);
  });

  it("is append-only and rejects duplicate keys and bad rows at the database", async () => {
    const [row] = await xpRows(ctx.athletes.maya);
    await expect((async () => db.update(xpEvents).set({ points: 9999 }).where(eq(xpEvents.id, row.id)))()).rejects.toThrow();
    await expect((async () => db.delete(xpEvents).where(eq(xpEvents.id, row.id)))()).rejects.toThrow();
    const dup = { orgId: ctx.orgId, athleteId: row.athleteId, kind: row.kind, points: 1, sourceType: "x", sourceId: "x", idempotencyKey: row.idempotencyKey, occurredAt: new Date() };
    await expect((async () => db.insert(xpEvents).values(dup))()).rejects.toThrow();
    await expect((async () => db.insert(xpEvents).values({ ...dup, idempotencyKey: "neg", points: -5 }))()).rejects.toThrow();
    await expect((async () => db.insert(xpEvents).values({ ...dup, idempotencyKey: "kind", kind: "bribe" as never }))()).rejects.toThrow();
  });

  it("a wellness check-in earns XP for being submitted, once a day, whatever the answers are", async () => {
    const a = await newAthlete();
    const b = await newAthlete();
    const versionId = ctx.extra.science.questionnaireVersionId;
    const low = { sleep: 1, soreness: 10, mood: 1, stress: 10, energy: 1 };
    const high = { sleep: 10, soreness: 1, mood: 10, stress: 1, energy: 10 };
    await db.insert(questionnaireResponses).values([
      { orgId: ctx.orgId, athleteId: a, versionId, forDate: "2026-02-27", answers: low },
      { orgId: ctx.orgId, athleteId: a, versionId, forDate: "2026-02-28", answers: low },
      { orgId: ctx.orgId, athleteId: b, versionId, forDate: "2026-02-27", answers: high },
      { orgId: ctx.orgId, athleteId: b, versionId, forDate: "2026-02-28", answers: high },
    ]);
    await db.transaction((tx) => syncXp(tx, ctx.orgId, a));
    await db.transaction((tx) => syncXp(tx, ctx.orgId, b));
    expect(await xpTotal(a)).toBe(2 * DEFAULT_XP.wellness_checkin);
    expect(await xpTotal(b)).toBe(await xpTotal(a));
    // The ledger holds the date only: no answer, score or note.
    const rows = await xpRows(a);
    expect(rows.map((r) => r.sourceId).sort()).toEqual(["2026-02-27", "2026-02-28"]);
    expect(JSON.stringify(rows)).not.toMatch(/sleep|soreness|mood|answers/);
  });

  it("uses the org's point values at award time and never rewrites earlier awards", async () => {
    const a = await newAthlete();
    await addSession(a, weekAgo(2));
    await db.transaction((tx) => syncXp(tx, ctx.orgId, a));
    await db.transaction((tx) => saveEngagementSettings(tx, V.rod, { levelsEnabled: true, badgesEnabled: true, ...DEFAULT_XP, session_attended: 35 }));
    expect((await engagementSettings(db, ctx.orgId)).xp.session_attended).toBe(35);
    await addSession(a, weekAgo(1));
    await db.transaction((tx) => syncXp(tx, ctx.orgId, a));
    expect((await xpRows(a)).map((r) => r.points).sort()).toEqual([20, 35]);
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "org.engagement_settings_update")));
    expect(audit).toBeTruthy();
    await db.transaction((tx) => saveEngagementSettings(tx, V.rod, { levelsEnabled: true, badgesEnabled: true, ...DEFAULT_XP }));
  });

  it("awards nothing and reports no level or badges when turned off org-wide; turning back on backfills", async () => {
    const a = await newAthlete();
    await addSession(a, weekAgo(1));
    await db.transaction((tx) => saveEngagementSettings(tx, V.rod, { levelsEnabled: false, badgesEnabled: false, ...DEFAULT_XP }));
    const off = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, a, { today: TODAY }));
    expect(off?.level).toBeNull();
    expect(off?.badges).toBeNull();
    expect(off?.streak.current).toBe(1); // the streak is not gamification and stays
    expect(await xpRows(a)).toEqual([]);
    expect(await db.select().from(athleteBadges).where(eq(athleteBadges.athleteId, a))).toEqual([]);
    const home = await db.transaction((tx) => athleteHome(tx, V.rod, a, { today: TODAY }));
    expect(home.engagement).toMatchObject({ level: null, badges: null });
    await db.transaction((tx) => saveEngagementSettings(tx, V.rod, { levelsEnabled: true, badgesEnabled: true, ...DEFAULT_XP }));
    const on = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, a, { today: TODAY }));
    expect(on?.level?.xp).toBe(DEFAULT_XP.session_attended);
    expect(on?.badges?.map((b) => b.key)).toEqual(["first_session_v1"]);
  });

  it("only owner/admin may change engagement settings, and values are validated", async () => {
    const ok = { levelsEnabled: true, badgesEnabled: true, ...DEFAULT_XP };
    for (const who of ["erin", "marcus", "alex", "maya", "kiosk"]) {
      await expect(db.transaction((tx) => saveEngagementSettings(tx, V[who], ok))).rejects.toBeInstanceOf(AuthzError);
    }
    await expect(db.transaction((tx) => saveEngagementSettings(tx, V.rod, { ...ok, pr_set: -1 }))).rejects.toThrow();
    await expect(db.transaction((tx) => saveEngagementSettings(tx, V.rod, { ...ok, pr_set: 2.5 }))).rejects.toThrow();
    await expect(db.transaction((tx) => saveEngagementSettings(tx, V.rod, { ...ok, pr_set: 100000 }))).rejects.toThrow();
  });

  it("never touches another organization's athletes", async () => {
    expect(await db.transaction((tx) => syncXp(tx, other.orgId, ctx.athletes.maya))).toBe(0);
    expect(await db.transaction((tx) => syncBadges(tx, other.orgId, ctx.athletes.maya))).toEqual([]);
    expect(await db.transaction((tx) => refreshEngagement(tx, other.orgId, ctx.athletes.maya))).toBeNull();
    expect(await db.select().from(xpEvents).where(eq(xpEvents.orgId, other.orgId))).toEqual([]);
  });
});

describe("streaks and badges from real rows", () => {
  it("awards session and early-bird badges once, dated to the session that earned them", async () => {
    const a = await newAthlete();
    const ids: string[] = [];
    // Ten sessions over five weeks; the first five start at 6:00 AM facility time.
    for (let i = 0; i < 10; i++) ids.push(await addSession(a, addDaysYmd(weekAgo(5, 0), i * 3), i < 5 ? "06:00" : "17:00"));
    const first = await db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }));
    expect(first.sort()).toEqual(["early_bird_v1", "first_session_v1", "sessions_10_v1", "streak_4_v1"]);
    expect(await db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }))).toEqual([]);
    const again = await Promise.all(Array.from({ length: 5 }, () => db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }))));
    expect(again.flat()).toEqual([]);
    const rows = await db.select().from(athleteBadges).where(eq(athleteBadges.athleteId, a));
    expect(rows.length).toBe(4);
    const tenth = rows.find((r) => r.badgeKey === "sessions_10_v1")!;
    expect(tenth.earnedAt.toISOString()).toBe(localToUtc(addDaysYmd(weekAgo(5, 0), 27), "17:00").toISOString());
    expect(tenth.source).toEqual({ rule: "sessions", count: 10 });
    const early = rows.find((r) => r.badgeKey === "early_bird_v1")!;
    expect(early.earnedAt.toISOString()).toBe(localToUtc(addDaysYmd(weekAgo(5, 0), 12), "06:00").toISOString());
  });

  it("a 6:59 AM session is early, a 7:00 AM session is not", async () => {
    const a = await newAthlete();
    for (let i = 0; i < 4; i++) await addSession(a, addDaysYmd(weekAgo(3, 0), i), "06:59");
    await addSession(a, addDaysYmd(weekAgo(3, 0), 4), "07:00");
    expect(await db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }))).not.toContain("early_bird_v1");
    await addSession(a, addDaysYmd(weekAgo(3, 0), 5), "06:59");
    expect(await db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }))).toContain("early_bird_v1");
  });

  it("weeks on a membership hold do not break the streak", async () => {
    const a = await newAthlete();
    for (const n of [6, 5, 2, 1]) await addSession(a, weekAgo(n));
    expect((await readEngagement(db, ctx.orgId, a, { today: TODAY })).streak).toMatchObject({ current: 2, best: 2 });
    const [m] = await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: a, productVersionId: ctx.extra.billing.unlimitedVersionId, status: "active", startDate: weekAgo(10), billingProvider: "manual" })
      .returning();
    await db.insert(membershipHolds).values({ membershipId: m.id, startDate: weekAgo(4, 0), endDate: weekAgo(3, 6), kind: "hold" });
    const s = (await readEngagement(db, ctx.orgId, a, { today: TODAY })).streak;
    expect(s).toMatchObject({ current: 4, best: 4, thisWeekActive: false });
    expect(s.recent.map((w) => w.state)).toEqual(["active", "hold", "hold", "active", "active", "open"]);
    expect(await db.transaction((tx) => syncBadges(tx, ctx.orgId, a, { today: TODAY }))).toContain("streak_4_v1");
  });

  it("an in-season pause is not a hold, and a completed logged workout keeps a week alive", async () => {
    const a = await newAthlete();
    await addSession(a, weekAgo(3));
    await addSession(a, weekAgo(1));
    const [m] = await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: a, productVersionId: ctx.extra.billing.unlimitedVersionId, status: "active", startDate: weekAgo(10), billingProvider: "manual" })
      .returning();
    await db.insert(membershipHolds).values({ membershipId: m.id, startDate: weekAgo(2, 0), endDate: weekAgo(2, 6), kind: "in_season" });
    expect((await readEngagement(db, ctx.orgId, a, { today: TODAY })).streak.current).toBe(1);
    await db.execute(sql`insert into workouts (org_id, athlete_id, scheduled_date, title, status, completed_at) values (${ctx.orgId}, ${a}, ${weekAgo(2)}, 'Test workout', 'completed', ${localToUtc(weekAgo(2), "18:00").toISOString()})`);
    await db.execute(sql`insert into workouts (org_id, athlete_id, scheduled_date, title, status) values (${ctx.orgId}, ${a}, ${weekAgo(4)}, 'Skipped workout', 'skipped')`);
    expect((await readEngagement(db, ctx.orgId, a, { today: TODAY })).streak).toMatchObject({ current: 3, best: 3 });
  });
});

describe("goals", () => {
  async function squat(athleteId: string) {
    const [ex] = await db.select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, "Back Squat")));
    const rows = await db.select().from(maxes).where(and(eq(maxes.athleteId, athleteId), eq(maxes.exerciseId, ex.id)));
    return { ex, best: Math.max(...rows.map((r) => Number(r.value))) };
  }

  it("a max goal tracks the best tested max and checks itself off once, with audit and XP", async () => {
    const leo = ctx.athletes.leo;
    const { ex, best } = await squat(leo);
    await expect(db.transaction((tx) => createGoal(tx, V.marcus, { athleteId: leo, title: "Too easy", link: `exercise:${ex.id}`, targetValue: best }, TODAY))).rejects.toBeInstanceOf(UserError);
    const g = await db.transaction((tx) => createGoal(tx, V.marcus, { athleteId: leo, title: "Squat more", link: `exercise:${ex.id}`, targetValue: best + 20, targetDate: addDaysYmd(TODAY, 30) }, TODAY));
    expect(g).toMatchObject({ status: "active", targetUnit: "lb", direction: "increase", baselineValue: best, maxBasis: "measured" });

    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: leo, exerciseId: ex.id, value: String(best + 10), unit: "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(TODAY, -1) });
    let view = (await listGoals(db, V.marcus, leo, { today: TODAY })).find((x) => x.id === g.id)!;
    expect(view.progress).toMatchObject({ current: best + 10, baseline: best, pct: 50 });
    expect(view.daysLeft).toBe(30);

    // An estimated max over the target is a different kind of number: it does not count.
    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: leo, exerciseId: ex.id, value: String(best + 60), unit: "lb", kind: "estimated", method: "epley_v1", recordedOn: TODAY });
    expect(await db.transaction((tx) => evaluateGoals(tx, ctx.orgId, leo))).not.toContain(g.id);
    view = (await listGoals(db, V.marcus, leo, { today: TODAY })).find((x) => x.id === g.id)!;
    expect(view.progress).toMatchObject({ current: best + 10, pct: 50 });
    expect(view.progress?.note).toMatch(/Only tested maxes count/);

    // A tested max in kg that converts past the target does count (exact lb/kg conversion).
    const kg = Math.ceil(((best + 20) * 0.45359237 + 0.5) * 10) / 10;
    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: leo, exerciseId: ex.id, value: String(kg), unit: "kg", kind: "tested", method: "tested", recordedOn: TODAY });
    const xpBefore = await xpTotal(leo);
    await Promise.all(Array.from({ length: 4 }, () => db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }))));
    await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, leo, { today: TODAY }));
    const [after] = await db.select().from(athleteGoals).where(eq(athleteGoals.id, g.id));
    expect(after.status).toBe("achieved");
    expect(after.achievedValue).toBeGreaterThanOrEqual(best + 20);
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.entityType, "athlete_goal"), eq(auditEvents.entityId, g.id), eq(auditEvents.action, "engagement.goal.achieved")));
    expect(audits.length).toBe(1);
    expect(audits[0]).toMatchObject({ actorUserId: null, actorRole: "system" });
    const goalXp = (await xpRows(leo)).filter((r) => r.idempotencyKey === `goal:${g.id}`);
    expect(goalXp.length).toBe(1);
    // +10 lb PR, the kg PR, and the goal. The estimated max is the first of its kind: no PR.
    expect((await xpTotal(leo)) - xpBefore).toBe(DEFAULT_XP.goal_achieved + 2 * DEFAULT_XP.pr_set);
    expect((await db.select().from(athleteBadges).where(eq(athleteBadges.athleteId, leo))).map((b) => b.badgeKey)).toContain("goal_first_v1");
  });

  it("a test-result goal never counts a result measured under a different protocol", async () => {
    const a = await newAthlete();
    const metricId = ctx.extra.science.m10;
    const mk = (key: string, protocol: string) => db.transaction((tx) => createTestType(tx, V.rod, { key, name: `Sprint ${key}`, vendor: "teamwork", protocol, trialSelection: "best" }));
    const gates = await mk(`gates_${Date.now()}`, "Timing gates, standing start.");
    const hand = await mk(`hand_${Date.now()}`, "Hand timed, standing start.");
    const record = (testTypeId: string, date: string, value: number) =>
      db.transaction((tx) => recordTestSession(tx, V.rod, { athleteId: a, testTypeId, date, time: "12:00", values: [{ metricId, trialNumber: 1, value, unit: "s" }] }));
    await record(gates.id, "2026-02-01", 2.0);

    await expect(db.transaction((tx) => createGoal(tx, V.rod, { athleteId: a, title: "Bad unit", link: `metric:${metricId}`, targetValue: 1.9, targetUnit: "kg" }, TODAY))).rejects.toBeInstanceOf(UserError);
    await expect(db.transaction((tx) => createGoal(tx, V.rod, { athleteId: a, title: "No number", link: `metric:${metricId}` }, TODAY))).rejects.toBeInstanceOf(UserError);
    await expect(db.transaction((tx) => createGoal(tx, V.rod, { athleteId: a, title: "Already there", link: `metric:${metricId}`, targetValue: 2.1 }, TODAY))).rejects.toBeInstanceOf(UserError);
    const g = await db.transaction((tx) => createGoal(tx, V.rod, { athleteId: a, title: "Faster 10", link: `metric:${metricId}`, targetValue: 1.9 }, TODAY));
    expect(g).toMatchObject({ direction: "decrease", targetUnit: "s", baselineValue: 2.0 });
    expect(g.baselineContext).toMatchObject({ testTypeId: gates.id, protocol: "Timing gates, standing start.", source: "teamwork_manual" });
    const view = async () => (await listGoals(db, V.rod, a, { today: TODAY })).find((x) => x.id === g.id)!;

    await record(gates.id, "2026-02-10", 1.95);
    expect((await view()).progress).toMatchObject({ current: 1.95, baseline: 2.0, pct: 50 });

    // A hand-timed 1.85 would "meet" the target, but it is not comparable: not counted, not achieved.
    await record(hand.id, "2026-02-20", 1.85);
    expect(await db.transaction((tx) => evaluateGoals(tx, ctx.orgId, a))).toEqual([]);
    expect((await view()).progress).toMatchObject({ current: null, pct: null, note: INCOMPARABLE_LATEST });
    expect((await view()).status).toBe("active");

    // Back on timing gates and under the target: achieved.
    await record(gates.id, "2026-02-25", 1.88);
    expect(await db.transaction((tx) => evaluateGoals(tx, ctx.orgId, a))).toEqual([g.id]);
    expect(await view()).toMatchObject({ status: "achieved", progress: { pct: 100, achievedValue: 1.88 } });
    expect(await db.transaction((tx) => evaluateGoals(tx, ctx.orgId, a))).toEqual([]);
  });

  it("a goal set before anything was measured picks up its starting value from the first result", async () => {
    const a = await newAthlete();
    const [ex] = await db.select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, "Bench Press")));
    const g = await db.transaction((tx) => createGoal(tx, V.rod, { athleteId: a, title: "Bench 100", link: `exercise:${ex.id}`, targetValue: 100, targetUnit: "lb" }, TODAY));
    expect(g.baselineValue).toBeNull();
    let [v] = await listGoals(db, V.rod, a, { today: TODAY });
    expect(v.progress).toMatchObject({ current: null, pct: null });
    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: a, exerciseId: ex.id, value: "80", unit: "lb", kind: "tested", method: "tested", recordedOn: TODAY });
    await db.transaction((tx) => evaluateGoals(tx, ctx.orgId, a));
    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: a, exerciseId: ex.id, value: "90", unit: "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(TODAY, 1) });
    [v] = await listGoals(db, V.rod, a, { today: TODAY });
    expect(v.progress).toMatchObject({ current: 90, baseline: 80, pct: 50 });
  });

  it("free-text goals are checked off by hand; linked goals cannot be", async () => {
    const maya = ctx.athletes.maya;
    const g = await db.transaction((tx) => createGoal(tx, V.maya, { athleteId: maya, title: "Stretch every night" }, TODAY));
    expect(g).toMatchObject({ metricDefinitionId: null, exerciseId: null, targetValue: null, createdBy: V.maya.userId });
    const done = await db.transaction((tx) => setGoalStatus(tx, V.maya, g.id, "achieve"));
    expect(done.status).toBe("achieved");
    await expect(db.transaction((tx) => setGoalStatus(tx, V.maya, g.id, "achieve"))).rejects.toBeInstanceOf(UserError);
    const { ex, best } = await squat(maya);
    const linked = await db.transaction((tx) => createGoal(tx, V.marcus, { athleteId: maya, title: "Squat test goal", link: `exercise:${ex.id}`, targetValue: best + 100 }, TODAY));
    await expect(db.transaction((tx) => setGoalStatus(tx, V.marcus, linked.id, "achieve"))).rejects.toBeInstanceOf(UserError);
    expect((await db.transaction((tx) => setGoalStatus(tx, V.marcus, linked.id, "archive"))).status).toBe("archived");
    expect((await db.transaction((tx) => setGoalStatus(tx, V.marcus, linked.id, "reopen"))).status).toBe("active");
    await db.transaction((tx) => setGoalStatus(tx, V.marcus, linked.id, "archive"));
    await expect(db.transaction((tx) => createGoal(tx, V.maya, { athleteId: maya, title: "Yesterday", targetDate: addDaysYmd(TODAY, -1) }, TODAY))).rejects.toBeInstanceOf(UserError);
    await expect(db.transaction((tx) => createGoal(tx, V.maya, { athleteId: maya, title: "x" }, TODAY))).rejects.toThrow();
  });
});

describe("authorization", () => {
  let goalId: string;
  beforeAll(async () => {
    const g = await db.transaction((tx) => createGoal(tx, V.marcus, { athleteId: ctx.athletes.maya, title: "Authz goal" }, TODAY));
    goalId = g.id;
  });
  const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(AuthzError);

  it("an athlete sees and edits only themselves", async () => {
    const home = await db.transaction((tx) => athleteHome(tx, V.maya, ctx.athletes.maya, { today: TODAY }));
    expect(home.firstName).toBe("Maya");
    expect(home.engagement?.level).not.toBeNull();
    expect(home.goals?.some((g) => g.id === goalId)).toBe(true);
    expect(home.wellness).not.toBeNull();
    for (const otherAthlete of [ctx.athletes.eli, ctx.athletes.leo]) {
      await denied(db.transaction((tx) => athleteHome(tx, V.maya, otherAthlete, { today: TODAY })));
      await denied(db.transaction((tx) => engagementStrip(tx, V.maya, otherAthlete)));
      await denied(listGoals(db, V.maya, otherAthlete));
      await denied(db.transaction((tx) => createGoal(tx, V.maya, { athleteId: otherAthlete, title: "Not mine" }, TODAY)));
    }
    const [leoGoal] = await db.select().from(athleteGoals).where(eq(athleteGoals.athleteId, ctx.athletes.leo));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.maya, leoGoal.id, "archive")));
  });

  it("an athlete under 13 (or with no birthday on file) cannot set goals alone; a guardian or coach can", async () => {
    const personId = ctx.people.maya_parker;
    const [{ dob }] = await db.select({ dob: people.dateOfBirth }).from(people).where(eq(people.id, personId));
    try {
      await db.update(people).set({ dateOfBirth: addDaysYmd(TODAY, -12 * 365) }).where(eq(people.id, personId));
      expect(await engagementAccess(db, V.maya, ctx.athletes.maya, TODAY)).toMatchObject({ canWriteGoals: false, canSeeGoals: true, isSelf: true });
      await denied(db.transaction((tx) => createGoal(tx, V.maya, { athleteId: ctx.athletes.maya, title: "Too young alone" }, TODAY)));
      await denied(db.transaction((tx) => setGoalStatus(tx, V.maya, goalId, "archive")));
      await db.update(people).set({ dateOfBirth: null }).where(eq(people.id, personId));
      expect((await engagementAccess(db, V.maya, ctx.athletes.maya, TODAY)).canWriteGoals).toBe(false);
      const g = await db.transaction((tx) => createGoal(tx, V.alex, { athleteId: ctx.athletes.maya, title: "Set with a parent" }, TODAY));
      expect(g.createdBy).toBe(V.alex.userId);
      await db.transaction((tx) => setGoalStatus(tx, V.alex, g.id, "archive"));
    } finally {
      await db.update(people).set({ dateOfBirth: dob }).where(eq(people.id, personId));
    }
    expect((await engagementAccess(db, V.maya, ctx.athletes.maya, TODAY)).canWriteGoals).toBe(true);
  });

  it("a guardian without health access gets coaching data but nothing about wellness", async () => {
    const jordan = await db.transaction((tx) => athleteHome(tx, V.jordan, ctx.athletes.maya, { today: TODAY }));
    expect(jordan.wellness).toBeNull();
    expect(jordan.access.canSeeHealth).toBe(false);
    expect(jordan.engagement?.streak).toBeTruthy();
    expect(jordan.goals?.length).toBeGreaterThan(0);
    expect(JSON.stringify(jordan)).not.toMatch(/readiness|answers|soreness|"sleep"/i);
    const alex = await db.transaction((tx) => athleteHome(tx, V.alex, ctx.athletes.maya, { today: TODAY }));
    expect(alex.wellness).not.toBeNull();
    expect(Object.keys(alex.wellness!).sort()).toEqual(["done", "due"]);
  });

  it("a guardian without training access sees goal titles but no measured values, streak, XP, badges or PRs", async () => {
    const ava = ctx.athletes.ava;
    const [ex] = await db.select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, "Bench Press")));
    await db.insert(maxes).values({ orgId: ctx.orgId, athleteId: ava, exerciseId: ex.id, value: "60", unit: "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(TODAY, -3) });
    const g = await db.transaction((tx) => createGoal(tx, V.rod, { athleteId: ava, title: "Bench 80", link: `exercise:${ex.id}`, targetValue: 80 }, TODAY));
    const link = and(eq(guardianships.athleteId, ava), eq(guardianships.guardianPersonId, ctx.people.chris_parker));
    await db.update(guardianships).set({ canViewTraining: false }).where(link);
    try {
      const home = await db.transaction((tx) => athleteHome(tx, V.chris, ava, { today: TODAY }));
      expect(home).toMatchObject({ engagement: null, prs: null, workouts: null });
      expect(home.week).toMatchObject({ workoutsLogged: null, workoutsPlanned: null });
      expect(home.checklist.some((i) => i.key === "baseline")).toBe(false);
      const view = home.goals!.find((x) => x.id === g.id)!;
      expect(view.title).toBe("Bench 80");
      expect(view.progress).toBeNull();
      expect(JSON.stringify(home.goals)).not.toMatch(/"current":60/);
      await denied(db.transaction((tx) => engagementStrip(tx, V.chris, ava)));
      expect(await goalLinkOptions(db, V.chris, ava)).toEqual({ metrics: [], exercises: [] });
      // May still add a free-text goal, but may not link one to results they cannot see.
      await denied(db.transaction((tx) => createGoal(tx, V.chris, { athleteId: ava, title: "Linked", link: `exercise:${ex.id}`, targetValue: 90 }, TODAY)));
      expect((await db.transaction((tx) => createGoal(tx, V.chris, { athleteId: ava, title: "Have fun" }, TODAY))).title).toBe("Have fun");
    } finally {
      await db.update(guardianships).set({ canViewTraining: true }).where(link);
    }
    const withAccess = (await listGoals(db, V.chris, ava, { today: TODAY })).find((x) => x.id === g.id)!;
    expect(withAccess.progress).toMatchObject({ current: 60, pct: 0 });
  });

  it("an unrelated guardian, and a payer-only adult, see nothing about the athlete", async () => {
    const maya = ctx.athletes.maya;
    const all = async (v: Viewer) => {
      await denied(db.transaction((tx) => athleteHome(tx, v, maya, { today: TODAY })));
      await denied(db.transaction((tx) => engagementStrip(tx, v, maya)));
      await denied(listGoals(db, v, maya));
      await denied(db.transaction((tx) => createGoal(tx, v, { athleteId: maya, title: "Nope" }, TODAY)));
      await denied(db.transaction((tx) => setGoalStatus(tx, v, goalId, "achieve")));
    };
    await all(V.chris);
    // Chris becomes a payer on the Parker account (billing only): still no coaching data or goals.
    await db.insert(payerAuthorizations).values({ payerAccountId: ctx.payers.parker, personId: ctx.people.chris_parker, canViewInvoices: true, canPay: true });
    try {
      const a = await engagementAccess(db, V.chris, maya, TODAY);
      expect([...a.caps]).toEqual(["billing.read"]);
      expect(a).toMatchObject({ canSeeGoals: false, canSeeTraining: false, canSeeHealth: false, canWriteGoals: false });
      await all(V.chris);
    } finally {
      await db.delete(payerAuthorizations).where(and(eq(payerAuthorizations.payerAccountId, ctx.payers.parker), eq(payerAuthorizations.personId, ctx.people.chris_parker)));
    }
  });

  it("a coach sees and edits only assigned athletes", async () => {
    const maya = ctx.athletes.maya;
    const strip = await db.transaction((tx) => engagementStrip(tx, V.marcus, maya, { today: TODAY }));
    expect(strip.level?.xp).toBeGreaterThan(0);
    expect(strip.badges?.length).toBeGreaterThan(0);
    expect(strip.lastActivityAt).toBeInstanceOf(Date);
    expect((await listGoals(db, V.marcus, maya)).some((g) => g.id === goalId)).toBe(true);
    // Tess coaches the youth group, not Maya.
    await denied(db.transaction((tx) => engagementStrip(tx, V.tess, maya)));
    await denied(db.transaction((tx) => athleteHome(tx, V.tess, maya, { today: TODAY })));
    await denied(listGoals(db, V.tess, maya));
    await denied(db.transaction((tx) => createGoal(tx, V.tess, { athleteId: maya, title: "Not my athlete" }, TODAY)));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.tess, goalId, "archive")));
    expect(await goalLinkOptions(db, V.tess, maya)).toEqual({ metrics: [], exercises: [] });
    expect((await db.transaction((tx) => engagementStrip(tx, V.tess, ctx.athletes.eli, { today: TODAY }))).streak).toBeTruthy();
  });

  it("operations can view engagement but not write goals; the kiosk gets nothing", async () => {
    const maya = ctx.athletes.maya;
    expect((await db.transaction((tx) => engagementStrip(tx, V.erin, maya, { today: TODAY }))).streak).toBeTruthy();
    const home = await db.transaction((tx) => athleteHome(tx, V.erin, maya, { today: TODAY }));
    expect(home.wellness).toBeNull(); // operations has no health access
    await denied(db.transaction((tx) => createGoal(tx, V.erin, { athleteId: maya, title: "Ops goal" }, TODAY)));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.erin, goalId, "archive")));
    await denied(db.transaction((tx) => engagementStrip(tx, V.kiosk, maya)));
    await denied(db.transaction((tx) => athleteHome(tx, V.kiosk, maya, { today: TODAY })));
    await denied(listGoals(db, V.kiosk, maya));
    await denied(db.transaction((tx) => createGoal(tx, V.kiosk, { athleteId: maya, title: "Kiosk goal" }, TODAY)));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.kiosk, goalId, "achieve")));
  });

  it("another organization's owner cannot read or change anything here", async () => {
    const maya = ctx.athletes.maya;
    await denied(db.transaction((tx) => engagementStrip(tx, V.otherOwner, maya)));
    await denied(db.transaction((tx) => athleteHome(tx, V.otherOwner, maya, { today: TODAY })));
    await denied(listGoals(db, V.otherOwner, maya));
    await denied(db.transaction((tx) => createGoal(tx, V.otherOwner, { athleteId: maya, title: "Cross-org" }, TODAY)));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.otherOwner, goalId, "archive")));
    await denied(db.transaction((tx) => setGoalStatus(tx, V.rod, "not-a-uuid", "archive")));
    // A metric or exercise id from another org cannot be linked.
    const [foreign] = await db.insert(exercises).values({ orgId: other.orgId, name: "Foreign lift", category: "strength" }).returning();
    await denied(db.transaction((tx) => createGoal(tx, V.rod, { athleteId: maya, title: "Foreign", link: `exercise:${foreign.id}`, targetValue: 100 }, TODAY)));
    const [org] = await db.select().from(organizations).where(eq(organizations.id, other.orgId));
    expect(org.settings.engagement).toBeUndefined();
  });
});
