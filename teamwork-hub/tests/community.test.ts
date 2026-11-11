import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { athleteBadges, athletes, auditEvents, bookings, communityChallengeCompletions, communityDisplayPrefs, communityDisplayTokens, communityShoutouts, guardianships, maxes, organizations, people, scheduleSessions, serviceTypes, workouts, xpEvents } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { boardPayload, createDisplayToken, hashDisplayToken, listDisplayTokens, resolveDisplayToken, revokeDisplayToken } from "@/lib/community/board";
import { archiveChallenge, challengeViews, createChallenge, syncChallengeCompletions } from "@/lib/community/challenges";
import { communityRoster, displayModeAccess, setDisplayMode } from "@/lib/community/display-name";
import { leaderboardsFor } from "@/lib/community/leaderboards";
import { communitySettingsOf, saveCommunitySettings } from "@/lib/community/settings";
import { postShoutout, removeShoutout, shoutoutsForAthlete, shoutoutsLeftToday } from "@/lib/community/shoutouts";
import { DEFAULT_XP } from "@/lib/engagement/settings";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
/** A Monday. The month started the day before (a Sunday). */
const TODAY = "2026-03-02";
/** Noon on TODAY in the facility timezone, so "today" is the same date in UTC and locally. */
const NOW = localToUtc(TODAY, "12:00");
const db = testDb();
let ctx: Ctx;
let other: Ctx;
let serviceTypeId: string;
let squat: string;
const V: Record<string, Viewer> = {};

beforeAll(async () => {
  // Scheduling for service types, training for the exercise library and tested maxes. The community
  // seed is left out: every test below builds exactly the rows it needs.
  ctx = await seedOrg(TODAY, { modules: ["scheduling", "training"] });
  other = await seedOrg(TODAY, { modules: [] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "maya", "dana", "sam", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  [{ id: serviceTypeId }] = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(eq(serviceTypes.orgId, ctx.orgId)).limit(1);
  squat = ctx.extra.exercises["Back Squat"];
  // Give the athlete we will hide a name that cannot collide with anything else in a payload.
  await db.update(people).set({ firstName: "Zyxeli", lastName: "Qwvhidden" }).where(eq(people.id, ctx.people.eli_parker));
});
afterAll(closeTestDb);

let seq = 0;
async function newAthlete(first: string, last: string, dob: string | null, extra: { groupId?: string; bodyMassKg?: string } = {}) {
  const [p] = await db.insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: last, dateOfBirth: dob, isDemo: true }).returning();
  const [a] = await db.insert(athletes).values({ orgId: ctx.orgId, personId: p.id, sport: "Track", bodyMassKg: extra.bodyMassKg ?? null, isDemo: true }).returning();
  if (extra.groupId) await db.execute(sql`insert into group_members (group_id, athlete_id) values (${extra.groupId}, ${a.id})`);
  seq++;
  return a.id;
}
async function addSessionAt(athleteId: string, startsAt: Date, status: "attended" | "booked" = "attended", capacity = 10) {
  const [s] = await db.insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId, title: `Community test ${++seq}`, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), timezone: "America/Indiana/Indianapolis", capacity }).returning();
  await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId, status });
  return s.id;
}
const addSession = (athleteId: string, ymd: string, hm = "07:00") => addSessionAt(athleteId, localToUtc(ymd, hm));
const addMax = (athleteId: string, value: number, recordedOn: string, kind: "tested" | "estimated" | "manual" = "tested", exerciseId = squat, unit: "lb" | "kg" = "lb") =>
  db.insert(maxes).values({ orgId: ctx.orgId, athleteId, exerciseId, value: String(value), unit, kind, method: kind === "estimated" ? "epley_v1" : kind, recordedOn });
const audits = (action: string, entityId: string) => db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)));
const board = () => db.transaction((tx) => boardPayload(tx, ctx.orgId, { now: NOW }));
const setSettings = (patch: Record<string, unknown>) =>
  db.transaction(async (tx) => {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await tx.update(organizations).set({ settings: { ...o.settings, community: { ...(o.settings.community as object | undefined), ...patch } } }).where(eq(organizations.id, ctx.orgId));
  });
const ADULT = "1990-05-05";

describe("display consent", () => {
  it("defaults to first name and last initial for everyone, with no stored row", async () => {
    const roster = await communityRoster(db, ctx.orgId, { today: TODAY });
    expect(roster.get(ctx.athletes.maya)).toMatchObject({ displayName: "Maya P.", mode: "first_last_initial", band: "U16" });
    expect(await db.select().from(communityDisplayPrefs).where(eq(communityDisplayPrefs.orgId, ctx.orgId))).toHaveLength(0);
  });

  it("a guardian with profile access sets a minor's mode; it is audited", async () => {
    const access = await displayModeAccess(db, V.alex, ctx.athletes.eli, TODAY);
    expect(access).toMatchObject({ canChange: true, staffOnRequest: false, effective: "first_last_initial", preview: "Zyxeli Q." });
    await db.transaction((tx) => setDisplayMode(tx, V.alex, { athleteId: ctx.athletes.eli, mode: "hidden" }, TODAY));
    expect((await communityRoster(db, ctx.orgId, { today: TODAY })).get(ctx.athletes.eli)).toMatchObject({ displayName: null, mode: "hidden" });
    const log = await audits("community.display_mode.set", ctx.athletes.eli);
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(V.alex.userId);
  });

  it("a guardian without profile access cannot read or change it", async () => {
    // Chris is a guardian in the same organization, but not of Maya.
    await expect(displayModeAccess(db, V.chris, ctx.athletes.maya, TODAY)).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => setDisplayMode(tx, V.chris, { athleteId: ctx.athletes.maya, mode: "hidden" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    // A revoked guardianship no longer counts.
    await db.update(guardianships).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(guardianships.guardianPersonId, ctx.people.jordan_parker), eq(guardianships.athleteId, ctx.athletes.maya)));
    await expect(db.transaction((tx) => setDisplayMode(tx, V.jordan, { athleteId: ctx.athletes.maya, mode: "hidden" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    expect((await communityRoster(db, ctx.orgId, { today: TODAY })).get(ctx.athletes.maya)?.mode).toBe("first_last_initial");
  });

  it("a minor cannot change their own mode; an adult athlete can; a guardian cannot for an adult", async () => {
    await expect(db.transaction((tx) => setDisplayMode(tx, V.maya, { athleteId: ctx.athletes.maya, mode: "first_name_only" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    expect((await displayModeAccess(db, V.maya, ctx.athletes.maya, TODAY)).blockedReason).toMatch(/parent or guardian/);
    await db.transaction((tx) => setDisplayMode(tx, V.dana, { athleteId: ctx.athletes.dana, mode: "first_name_only" }, TODAY));
    expect((await communityRoster(db, ctx.orgId, { today: TODAY })).get(ctx.athletes.dana)?.displayName).toBe("Dana");
    // Leo turns 18: his guardian can no longer choose for him.
    await db.update(people).set({ dateOfBirth: "2008-01-01" }).where(eq(people.id, ctx.people.leo_rivera));
    await expect(db.transaction((tx) => setDisplayMode(tx, V.sam, { athleteId: ctx.athletes.leo, mode: "hidden" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    await db.update(people).set({ dateOfBirth: "2010-01-01" }).where(eq(people.id, ctx.people.leo_rivera));
  });

  it("staff change it only with a note of who asked, and never a coach or another organization", async () => {
    await expect(db.transaction((tx) => setDisplayMode(tx, V.erin, { athleteId: ctx.athletes.ava, mode: "first_name_only" }, TODAY))).rejects.toBeInstanceOf(UserError);
    await db.transaction((tx) => setDisplayMode(tx, V.erin, { athleteId: ctx.athletes.ava, mode: "first_name_only", requestedBy: "Chris Parker asked at the front desk" }, TODAY));
    const [log] = await audits("community.display_mode.set", ctx.athletes.ava);
    expect(log.after).toMatchObject({ mode: "first_name_only", requestedBy: "Chris Parker asked at the front desk" });
    expect(log.summary).toMatch(/family's request/);
    await expect(db.transaction((tx) => setDisplayMode(tx, V.marcus, { athleteId: ctx.athletes.maya, mode: "hidden", requestedBy: "Parent asked" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => setDisplayMode(tx, V.otherOwner, { athleteId: ctx.athletes.maya, mode: "hidden", requestedBy: "Parent asked" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => setDisplayMode(tx, V.kiosk, { athleteId: ctx.athletes.maya, mode: "hidden" }, TODAY))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => setDisplayMode(tx, V.alex, { athleteId: ctx.athletes.maya, mode: "full_name" }, TODAY))).rejects.toBeInstanceOf(UserError);
  });

  it("the organization default applies to athletes with no explicit choice", async () => {
    await setSettings({ defaultDisplayMode: "hidden" });
    const roster = await communityRoster(db, ctx.orgId, { today: TODAY });
    expect(roster.get(ctx.athletes.maya)?.displayName).toBeNull();
    expect(roster.get(ctx.athletes.dana)?.displayName).toBe("Dana"); // explicit choice wins
    await setSettings({ defaultDisplayMode: "first_last_initial" });
  });
});

describe("hidden athletes never reach another family, but still see themselves", () => {
  let payload = "";
  beforeAll(async () => {
    // Eli (hidden above) gets everything that could put him on a board.
    await addSession(ctx.athletes.eli, "2026-03-01");
    await addSession(ctx.athletes.eli, "2026-03-02");
    await addSession(ctx.athletes.eli, "2026-02-23");
    await addMax(ctx.athletes.eli, 100, "2026-01-05");
    await addMax(ctx.athletes.eli, 140, "2026-03-02"); // a PR today
    await db.transaction((tx) => postShoutout(tx, V.tess, { athleteId: ctx.athletes.eli, template: "great_effort", note: "Sharp today" }, { today: TODAY, now: NOW }));
    await db.transaction((tx) => createChallenge(tx, V.rod, { title: "March sessions", mode: "individual", metric: "attendance", target: 2, startsOn: "2026-03-01", endsOn: "2026-03-31", groupId: null }, { today: TODAY }));
    await db.transaction((tx) => syncChallengeCompletions(tx, ctx.orgId, { today: TODAY }));
    // Visible peers in Eli's band so the boards exist.
    for (const k of ["ava", "harper", "ella", "aria"]) {
      await addSession(ctx.athletes[k], "2026-03-02");
      await addMax(ctx.athletes[k], 90, "2026-02-01");
    }
    await addMax(ctx.athletes.harper, 95, "2026-03-02"); // a visible PR today
    payload = JSON.stringify(await board());
  });

  it("the TV board payload has no trace of the hidden athlete, even though he earned a PR, a shoutout, a badge and a streak", async () => {
    expect(payload).not.toContain("Zyxeli");
    expect(payload).not.toContain("Qwvhidden");
    expect(payload).not.toContain(ctx.athletes.eli);
    // The same payload does carry visible athletes for those panels.
    expect(payload).toContain("Harper L.");
    const p = await board();
    expect(p.panels.map((x) => x.key)).toEqual(expect.arrayContaining(["pr_bell", "classes", "challenges"]));
  });

  it("the board payload carries no ids, no full last names, no birthdays and no body mass", async () => {
    expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const last of ["Parker", "Rivera", "Brooks", "Lindqvist", "Castellanos"]) expect(payload).not.toContain(last);
    expect(payload.toLowerCase()).not.toContain("birthday");
    expect(payload).not.toMatch(/date_?of_?birth|dob|bodyMass|body_mass/i);
  });

  it("another family's leaderboards and challenge leaders never include him", async () => {
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.chris, { today: TODAY })); // Chris: guardian of Ava, same band
    expect(view.band).toBe("U14");
    expect(view.boards.length).toBeGreaterThan(0);
    const json = JSON.stringify(view);
    expect(json).not.toContain("Zyxeli");
    expect(json).not.toContain(ctx.athletes.eli);
    const ch = JSON.stringify(await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY, ownIds: new Set([ctx.athletes.ava]) })));
    expect(ch).not.toContain("Zyxeli");
    expect(ch).not.toContain(ctx.athletes.eli);
    // Staff get the same public rows.
    expect(JSON.stringify(await db.transaction((tx) => leaderboardsFor(tx, V.tess, { band: "U14", today: TODAY })))).not.toContain("Zyxeli");
  });

  it("his own guardian sees his rank on every board he is on, marked hidden", async () => {
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.alex, { band: "U14", today: TODAY }));
    const sessions = view.boards.find((b) => b.kind === "sessions_month")!;
    expect(sessions.rows.map((r) => r.name)).not.toContain("Zyxeli Q.");
    expect(sessions.you).toEqual([{ athleteId: ctx.athletes.eli, firstName: "Zyxeli", rank: 1, of: null, hidden: true, value: "2" }]);
    // Four visible athletes: a small board, so no total and ranks 1..n among visible athletes only.
    expect(sessions.small).toBe(true);
    expect(sessions.total).toBeNull();
    expect(sessions.rows.map((r) => r.rank)).toEqual([1, 1, 1, 1]);
    const max = view.boards.find((b) => b.kind === "max")!;
    expect(max.you[0]).toMatchObject({ hidden: true, rank: 1, value: "140 lb" });
    const ch = await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY, ownIds: new Set([ctx.athletes.eli]) }));
    expect(ch[0].you).toEqual([{ athleteId: ctx.athletes.eli, firstName: "Zyxeli", value: 2, done: true }]);
    expect(ch[0].leaders.map((l) => l.name)).not.toContain("Zyxeli Q.");
  });

  it("with five or more visible athletes the hidden athlete's own line shows the true rank and count", async () => {
    for (let i = 0; i < 2; i++) await addSession(await newAthlete(`Peer${i}`, "Visible", "2013-06-01"), "2026-03-02");
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.alex, { band: "U14", today: TODAY }));
    const sessions = view.boards.find((b) => b.kind === "sessions_month")!;
    expect(sessions.small).toBe(false);
    expect(sessions.total).toBe(7);
    expect(sessions.you[0]).toMatchObject({ rank: 1, of: 7, hidden: true });
    // The visible rows show true ranks: everyone is tied for 2nd behind the hidden leader.
    expect(new Set(sessions.rows.map((r) => r.rank))).toEqual(new Set([2]));
    expect(JSON.stringify(sessions.rows)).not.toContain("Zyxeli");
  });

  it("shoutouts stay visible to the athlete's own family and staff in scope, not to others", async () => {
    expect((await shoutoutsForAthlete(db, V.alex, ctx.athletes.eli)).map((s) => s.note)).toEqual(["Sharp today"]);
    expect(await shoutoutsForAthlete(db, V.tess, ctx.athletes.eli)).toHaveLength(1);
    await expect(shoutoutsForAthlete(db, V.chris, ctx.athletes.eli)).rejects.toBeInstanceOf(AuthzError);
    await expect(shoutoutsForAthlete(db, V.marcus, ctx.athletes.eli)).rejects.toBeInstanceOf(AuthzError); // not Marcus's athlete
  });
});

describe("leaderboards", () => {
  it("athletes are only ranked inside their own age band", async () => {
    const adultA = await newAthlete("Bandadult", "One", ADULT);
    const kid = await newAthlete("Bandkid", "Two", "2015-06-01"); // U12
    await addMax(adultA, 400, "2026-02-01");
    await addMax(kid, 60, "2026-02-01");
    await addSession(adultA, "2026-03-02");
    await addSession(kid, "2026-03-02");
    const adult = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band: "Adult", today: TODAY }));
    const u12 = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band: "U12", today: TODAY }));
    expect(adult.boards.every((b) => b.band === "Adult")).toBe(true);
    expect(JSON.stringify(adult)).toContain("Bandadult O.");
    expect(JSON.stringify(adult)).not.toContain("Bandkid");
    expect(JSON.stringify(u12)).toContain("Bandkid T.");
    expect(JSON.stringify(u12)).not.toContain("Bandadult");
    // The TV board labels each leaderboard with exactly one band.
    const p = await board();
    for (const panel of p.panels) if (panel.key === "leaderboards") expect(["U12", "U14", "U16", "U18", "Adults"]).toContain(panel.board.cohort);
  });

  it("an athlete with no birthday on file is not ranked anywhere", async () => {
    const id = await newAthlete("Nobirthday", "Three", null);
    await addMax(id, 999, "2026-02-01");
    await addSession(id, "2026-03-02");
    for (const band of ["U12", "U14", "U16", "U18", "Adult"]) expect(JSON.stringify(await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band, today: TODAY })))).not.toContain("Nobirthday");
    expect(JSON.stringify(await board())).not.toContain("Nobirthday");
  });

  it("families only get the bands their own athletes are in; staff get every band", async () => {
    const alex = await db.transaction((tx) => leaderboardsFor(tx, V.alex, { band: "Adult", today: TODAY }));
    expect(alex.bands).toEqual(["U14", "U16"]);
    expect(alex.band).toBe("U14"); // an unknown or foreign band falls back to the first of their own
    const rod = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { today: TODAY }));
    expect(rod.bands).toEqual(expect.arrayContaining(["U12", "U14", "U16", "U18", "Adult"]));
    await expect(db.transaction((tx) => leaderboardsFor(tx, V.kiosk, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("exercise boards use measured maxes only", async () => {
    const onlyEstimated = await newAthlete("Estimonly", "Four", ADULT);
    const both = await newAthlete("Measured", "Five", ADULT);
    await addMax(onlyEstimated, 900, "2026-02-01", "estimated");
    await addMax(both, 200, "2026-02-01", "tested");
    await addMax(both, 700, "2026-02-10", "estimated");
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band: "Adult", today: TODAY }));
    const squatBoard = view.boards.find((b) => b.kind === "max" && b.title === "Back Squat")!;
    expect(squatBoard.label).toBe("Measured maxes only");
    expect(squatBoard.rows.find((r) => r.name === "Measured F.")?.value).toBe("200 lb");
    expect(JSON.stringify(view)).not.toContain("Estimonly");
    expect(JSON.stringify(view)).not.toMatch(/\b(900|700) lb/);
  });

  it("relative strength orders by body mass without ever showing a weight or a ratio", async () => {
    const light = await newAthlete("Light", "Six", ADULT, { bodyMassKg: "50.5" });
    const heavy = await newAthlete("Heavy", "Seven", ADULT, { bodyMassKg: "120.25" });
    await addMax(light, 250, "2026-02-01");
    await addMax(heavy, 350, "2026-02-01");
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band: "Adult", today: TODAY }));
    const rel = view.boards.find((b) => b.kind === "relative")!;
    expect(rel.rows.map((r) => r.name)).toEqual(["Light S.", "Heavy S."]);
    expect(rel.rows.every((r) => r.value === null)).toBe(true);
    const json = JSON.stringify(view);
    expect(json).not.toContain("50.5");
    expect(json).not.toContain("120.25");
    // Relative boards never go on the TV.
    expect((await board()).panels.some((p) => p.key === "leaderboards" && /pound for pound/.test(p.board.title))).toBe(false);
  });

  it("most improved lets a newer athlete win on percent", async () => {
    const strong = await newAthlete("Strong", "Eight", ADULT);
    const newer = await newAthlete("Newer", "Nine", ADULT);
    await addMax(strong, 400, "2025-11-01");
    await addMax(strong, 410, "2026-02-20");
    await addMax(newer, 100, "2026-01-05");
    await addMax(newer, 130, "2026-02-25");
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.rod, { band: "Adult", today: TODAY }));
    const improved = view.boards.find((b) => b.kind === "improved")!;
    expect(improved.rows[0]).toMatchObject({ rank: 1, name: "Newer N.", value: "+30%", detail: "Back Squat" });
    expect(improved.rows.find((r) => r.name === "Strong E.")?.value).toBe("+3%");
  });

  it("a guardian without training access gets no own-number line", async () => {
    await db.update(guardianships).set({ canViewTraining: false }).where(and(eq(guardianships.guardianPersonId, ctx.people.chris_parker), eq(guardianships.athleteId, ctx.athletes.ava)));
    const view = await db.transaction((tx) => leaderboardsFor(tx, V.chris, { today: TODAY }));
    expect(view.boards.length).toBeGreaterThan(0);
    expect(view.boards.every((b) => b.you.length === 0)).toBe(true);
    await db.update(guardianships).set({ canViewTraining: true }).where(and(eq(guardianships.guardianPersonId, ctx.people.chris_parker), eq(guardianships.athleteId, ctx.athletes.ava)));
  });
});

describe("coach shoutouts", () => {
  it("staff only, and coaches only for athletes they can see", async () => {
    const row = await db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.maya, template: "new_pr", note: "  Clean reps\non the last set " }, { today: TODAY, now: NOW }));
    expect(row.note).toBe("Clean reps on the last set");
    await expect(db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.eli, template: "new_pr" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => postShoutout(tx, V.alex, { athleteId: ctx.athletes.maya, template: "new_pr" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => postShoutout(tx, V.maya, { athleteId: ctx.athletes.maya, template: "new_pr" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => postShoutout(tx, V.otherOwner, { athleteId: ctx.athletes.maya, template: "new_pr" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    expect(await audits("community.shoutout.post", row.id)).toHaveLength(1);
    // Guardian and athlete both see it; the board shows it under the display name.
    expect((await shoutoutsForAthlete(db, V.alex, ctx.athletes.maya))[0]).toMatchObject({ headline: "New PR", coach: "Coach Marcus Hale", canRemove: false });
    expect(await shoutoutsForAthlete(db, V.maya, ctx.athletes.maya)).toHaveLength(1);
    const panel = (await board()).panels.find((p) => p.key === "shoutouts");
    expect(panel && panel.key === "shoutouts" && panel.items.some((i) => i.name === "Maya P." && i.note === "Clean reps on the last set")).toBe(true);
  });

  it("awards XP once through the engagement ledger with the configured value", async () => {
    const rows = await db.select().from(xpEvents).where(and(eq(xpEvents.orgId, ctx.orgId), eq(xpEvents.athleteId, ctx.athletes.maya), eq(xpEvents.kind, "coach_shoutout")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: DEFAULT_XP.coach_shoutout, sourceType: "community_shoutout" });
    expect(rows[0].idempotencyKey).toMatch(/^shoutout:/);
  });

  it("the text is length-limited, linted with the family style rules, and the template must be a known chip", async () => {
    const post = (note: string, template = "great_effort") => db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.maya, template, note }, { today: TODAY }));
    await expect(post("x".repeat(141))).rejects.toBeInstanceOf(UserError);
    await expect(post("Great work — keep going")).rejects.toThrow(/Em dash/);
    await expect(post("ok", "you_rock")).rejects.toBeInstanceOf(UserError);
    await expect(post("Card 4111 1111 1111 1111")).rejects.toBeInstanceOf(UserError);
  });

  it("enforces the per-coach daily limit in the facility day", async () => {
    await setSettings({ shoutoutDailyLimit: 3 });
    // Marcus has posted one today already.
    expect(await shoutoutsLeftToday(db, V.marcus, TODAY)).toMatchObject({ left: 2, limit: 3 });
    const earlier = new Date(NOW.getTime() - 3_600_000);
    const post = (day: string) => db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.leo, template: "consistency" }, { today: day, now: earlier }));
    await post(TODAY);
    await post(TODAY);
    await expect(post(TODAY)).rejects.toThrow(/limit of 3/);
    // Another coach has their own allowance, and tomorrow is a new day.
    await db.transaction((tx) => postShoutout(tx, V.tess, { athleteId: ctx.athletes.ava, template: "consistency" }, { today: TODAY, now: earlier }));
    await post(addDaysYmd(TODAY, 1));
    await setSettings({ shoutoutDailyLimit: 10 });
  });

  it("removal: the author or front-desk staff, audited, and it disappears everywhere", async () => {
    const row = await db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.maya, template: "leader_today", note: "Removable note" }, { today: TODAY, now: NOW }));
    await expect(db.transaction((tx) => removeShoutout(tx, V.tess, row.id))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => removeShoutout(tx, V.alex, row.id))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => removeShoutout(tx, V.otherOwner, row.id))).rejects.toBeInstanceOf(AuthzError);
    expect(JSON.stringify(await board())).toContain("Removable note");
    await db.transaction((tx) => removeShoutout(tx, V.erin, row.id, { reason: "Posted on the wrong athlete" }));
    const [log] = await audits("community.shoutout.remove", row.id);
    expect(log.actorUserId).toBe(V.erin.userId);
    expect(log.summary).toContain("Posted on the wrong athlete");
    expect(log.before).toMatchObject({ note: "Removable note", authorUserId: V.marcus.userId });
    expect((await shoutoutsForAthlete(db, V.alex, ctx.athletes.maya)).some((s) => s.id === row.id)).toBe(false);
    expect(JSON.stringify(await board())).not.toContain("Removable note");
    // Removing twice writes one audit entry; the row is kept.
    await db.transaction((tx) => removeShoutout(tx, V.erin, row.id));
    expect(await audits("community.shoutout.remove", row.id)).toHaveLength(1);
    const [kept] = await db.select().from(communityShoutouts).where(eq(communityShoutouts.id, row.id));
    expect(kept.removedBy).toBe(V.erin.userId);
    // An author can remove their own.
    const own = await db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.maya, template: "leader_today" }, { today: TODAY }));
    await db.transaction((tx) => removeShoutout(tx, V.marcus, own.id));
    expect(await audits("community.shoutout.remove", own.id)).toHaveLength(1);
  });
});

describe("team challenges", () => {
  it("counts in the facility timezone, not UTC", async () => {
    const a = await newAthlete("Tzone", "Ten", ADULT);
    const window = { startsOn: "2026-02-10", endsOn: "2026-02-12" };
    // 11:30 PM local on the last day is already Feb 13 in UTC: it counts.
    await addSessionAt(a, localToUtc("2026-02-12", "23:30"));
    // 12:30 AM local the next day does not.
    await addSessionAt(a, localToUtc("2026-02-13", "00:30"));
    // 11:30 PM local the day before the start is Feb 10 in UTC: it does not count.
    await addSessionAt(a, localToUtc("2026-02-09", "23:30"));
    await addSessionAt(a, localToUtc("2026-02-10", "00:15"));
    // A booking that was not attended never counts.
    await addSessionAt(a, localToUtc("2026-02-11", "10:00"), "booked");
    const c = await db.transaction((tx) => createChallenge(tx, V.rod, { title: "Timezone check", mode: "individual", metric: "attendance", target: 2, ...window, groupId: null }, { today: "2026-02-10" }));
    const [view] = (await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: "2026-02-12", ownIds: new Set([a]) }))).filter((x) => x.id === c.id);
    expect(view.you).toEqual([{ athleteId: a, firstName: "Tzone", value: 2, done: true }]);
    expect(view.daysLeft).toBe(1);
    await db.transaction((tx) => archiveChallenge(tx, V.rod, c.id));
  });

  it("completion writes one completion row, the badge and an audit entry, exactly once", async () => {
    const a = await newAthlete("Finisher", "Eleven", ADULT);
    const b = await newAthlete("Almost", "Twelve", ADULT);
    for (const d of ["2026-03-01", "2026-03-02"]) await db.insert(workouts).values({ orgId: ctx.orgId, athleteId: a, title: "Logged", scheduledDate: d, status: "completed", completedAt: localToUtc(d, "18:00") } as typeof workouts.$inferInsert);
    await db.insert(workouts).values({ orgId: ctx.orgId, athleteId: b, title: "Logged", scheduledDate: "2026-03-02", status: "completed", completedAt: localToUtc("2026-03-02", "18:00") } as typeof workouts.$inferInsert);
    const c = await db.transaction((tx) => createChallenge(tx, V.rod, { title: "Two workouts", mode: "individual", metric: "workouts", target: 2, startsOn: "2026-03-01", endsOn: "2026-03-07", groupId: null }, { today: TODAY }));
    await db.transaction((tx) => syncChallengeCompletions(tx, ctx.orgId, { today: TODAY }));
    const again = await db.transaction((tx) => syncChallengeCompletions(tx, ctx.orgId, { today: TODAY }));
    expect(again).toBe(0);
    const done = await db.select().from(communityChallengeCompletions).where(eq(communityChallengeCompletions.challengeId, c.id));
    expect(done.map((d) => d.athleteId)).toEqual([a]);
    expect(done[0].value).toBe(2);
    const badges = await db.select().from(athleteBadges).where(and(eq(athleteBadges.athleteId, a), eq(athleteBadges.badgeKey, "challenge_complete_v1")));
    expect(badges).toHaveLength(1);
    expect(await db.select().from(athleteBadges).where(eq(athleteBadges.athleteId, b))).toHaveLength(0);
    const log = (await audits("community.challenge.complete", c.id)).filter((l) => (l.after as { athleteId: string }).athleteId === a);
    expect(log).toHaveLength(1);
    expect(log[0].after).toMatchObject({ value: 2, target: 2, badges: ["challenge_complete_v1"] });
    expect(log[0].actorUserId).toBeNull();
    await db.transaction((tx) => archiveChallenge(tx, V.rod, c.id));
  });

  it("a team total finishes for everyone who contributed once the combined target is met", async () => {
    const c = await db.transaction((tx) => createChallenge(tx, V.marcus, { title: "HS sessions", mode: "group_total", metric: "attendance", target: 3, startsOn: "2026-03-01", endsOn: "2026-03-07", groupId: ctx.groups.hs }, { today: TODAY }));
    await addSession(ctx.athletes.maya, "2026-03-02");
    await addSession(ctx.athletes.leo, "2026-03-02");
    let [view] = (await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY }))).filter((x) => x.id === c.id);
    const before = view.total;
    expect(view.groupName).toBe("HS Speed & Strength");
    for (let i = before; i < 3; i++) await addSession(ctx.athletes.maya, "2026-03-01", `0${6 + i}:00`);
    await db.transaction((tx) => syncChallengeCompletions(tx, ctx.orgId, { today: TODAY }));
    [view] = (await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY }))).filter((x) => x.id === c.id);
    expect(view.pct).toBe(100);
    const done = await db.select().from(communityChallengeCompletions).where(eq(communityChallengeCompletions.challengeId, c.id));
    expect(done.map((d) => d.athleteId)).toEqual(expect.arrayContaining([ctx.athletes.maya, ctx.athletes.leo]));
    // Only members of the group count toward it or finish it.
    const hs = new Set((await db.execute(sql`select athlete_id from group_members where group_id = ${ctx.groups.hs}`)).rows.map((r) => (r as { athlete_id: string }).athlete_id));
    expect(done.every((d) => hs.has(d.athleteId))).toBe(true);
    await db.transaction((tx) => archiveChallenge(tx, V.marcus, c.id));
  });

  it("who may create and archive", async () => {
    const input = { title: "Scope check", mode: "individual", metric: "attendance", target: 5, startsOn: TODAY, endsOn: addDaysYmd(TODAY, 20) };
    await expect(db.transaction((tx) => createChallenge(tx, V.marcus, { ...input, groupId: null }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError); // gym-wide
    await expect(db.transaction((tx) => createChallenge(tx, V.marcus, { ...input, groupId: ctx.groups.youth }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError); // Tess's group
    await expect(db.transaction((tx) => createChallenge(tx, V.alex, { ...input, groupId: null }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => createChallenge(tx, V.rod, { ...input, groupId: other.groups.hs }, { today: TODAY }))).rejects.toBeInstanceOf(UserError); // another org's group
    await expect(db.transaction((tx) => createChallenge(tx, V.rod, { ...input, endsOn: addDaysYmd(TODAY, -1), groupId: null }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await expect(db.transaction((tx) => createChallenge(tx, V.rod, { ...input, endsOn: addDaysYmd(TODAY, 400), groupId: null }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    const c = await db.transaction((tx) => createChallenge(tx, V.tess, { ...input, groupId: ctx.groups.youth }, { today: TODAY }));
    expect(await audits("community.challenge.create", c.id)).toHaveLength(1);
    await expect(db.transaction((tx) => archiveChallenge(tx, V.marcus, c.id))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => archiveChallenge(tx, V.otherOwner, c.id))).rejects.toBeInstanceOf(AuthzError);
    await db.transaction((tx) => archiveChallenge(tx, V.tess, c.id));
    expect(await audits("community.challenge.archive", c.id)).toHaveLength(1);
    expect((await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY }))).some((x) => x.id === c.id)).toBe(false);
  });
});

describe("TV board access and payload", () => {
  it("only owner/admin can add a screen; only the hash is stored", async () => {
    await expect(db.transaction((tx) => createDisplayToken(tx, V.marcus, { label: "Lobby" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => createDisplayToken(tx, V.erin, { label: "Lobby" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => createDisplayToken(tx, V.rod, { label: " " }))).rejects.toBeInstanceOf(UserError);
    const { id, token } = await db.transaction((tx) => createDisplayToken(tx, V.rod, { label: "Lobby TV" }));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(communityDisplayTokens).where(eq(communityDisplayTokens.id, id));
    expect(row.tokenHash).toBe(hashDisplayToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(await audits("community.display.create", id))).not.toContain(token);
    expect(await resolveDisplayToken(db, token, { touch: true })).toEqual({ orgId: ctx.orgId, tokenId: id });
    expect((await listDisplayTokens(db, V.rod)).find((t) => t.id === id)?.lastSeenAt).toBeInstanceOf(Date);
    await expect(listDisplayTokens(db, V.marcus)).rejects.toBeInstanceOf(AuthzError);
  });

  it("a revoked token is dead; malformed and unknown tokens resolve to nothing", async () => {
    const { id, token } = await db.transaction((tx) => createDisplayToken(tx, V.rod, { label: "Weight room TV" }));
    expect(await resolveDisplayToken(db, token)).not.toBeNull();
    await expect(db.transaction((tx) => revokeDisplayToken(tx, V.otherOwner, id))).rejects.toBeInstanceOf(UserError);
    await expect(db.transaction((tx) => revokeDisplayToken(tx, V.marcus, id))).rejects.toBeInstanceOf(AuthzError);
    expect(await resolveDisplayToken(db, token)).not.toBeNull();
    await db.transaction((tx) => revokeDisplayToken(tx, V.rod, id));
    expect(await resolveDisplayToken(db, token)).toBeNull();
    expect(await resolveDisplayToken(db, token, { touch: true })).toBeNull();
    expect(await audits("community.display.revoke", id)).toHaveLength(1);
    for (const bad of [null, undefined, "", "short", `${token}x`, "a".repeat(43), 12345, { token }]) expect(await resolveDisplayToken(db, bad)).toBeNull();
  });

  it("a token only ever resolves to its own organization's board", async () => {
    const { token } = await db.transaction((tx) => createDisplayToken(tx, V.otherOwner, { label: "Other gym TV" }));
    const who = await resolveDisplayToken(db, token);
    expect(who?.orgId).toBe(other.orgId);
    const p = JSON.stringify(await db.transaction((tx) => boardPayload(tx, who!.orgId, { now: NOW })));
    expect(p).not.toContain("Ava P.");
    expect(p).not.toContain("Bandadult");
  });

  it("building the payload writes nothing", async () => {
    const count = async () => (await db.execute(sql`select (select count(*) from xp_events) + (select count(*) from athlete_badges) + (select count(*) from community_challenge_completions) + (select count(*) from audit_events) as n`)).rows[0] as { n: string };
    const before = await count();
    await board();
    await board();
    expect(await count()).toEqual(before);
  });

  it("today's classes show time, name, coach and spots left, never who is booked", async () => {
    const a = await newAthlete("Rosterperson", "Thirteen", ADULT);
    await addSessionAt(a, localToUtc(TODAY, "18:00"), "booked", 4);
    const panel = (await board()).panels.find((p) => p.key === "classes");
    expect(panel?.key).toBe("classes");
    const items = panel && panel.key === "classes" ? panel.items : [];
    expect(items.some((i) => i.time === "6:00 PM" && i.spotsLeft === 3 && i.state === "next")).toBe(true);
    expect(JSON.stringify(panel)).not.toContain("Rosterperson");
  });

  it("birthdays never reach the board, even on the day", async () => {
    const id = await newAthlete("Bdaykid", "Fourteen", "2012-03-02"); // birthday is TODAY
    await addSession(id, "2026-03-02");
    const json = JSON.stringify(await board());
    expect(json.toLowerCase()).not.toContain("birthday");
    expect(json).not.toContain("2012");
  });

  it("panels can be switched off one by one, and the master switch empties everything", async () => {
    await setSettings({ panels: { pr_bell: false, classes: false }, orgMessage: "Open gym Saturday" });
    let p = await board();
    expect(p.panels.some((x) => x.key === "pr_bell" || x.key === "classes")).toBe(false);
    expect(p.panels.find((x) => x.key === "message")).toMatchObject({ text: "Open gym Saturday" });
    await setSettings({ enabled: false });
    p = await board();
    expect(p.enabled).toBe(false);
    expect(p.panels).toEqual([]);
    const lb = await db.transaction((tx) => leaderboardsFor(tx, V.alex, { today: TODAY }));
    expect(lb).toMatchObject({ enabled: false, boards: [] });
    expect(await db.transaction((tx) => challengeViews(tx, ctx.orgId, { today: TODAY }))).toEqual([]);
    expect(await shoutoutsForAthlete(db, V.alex, ctx.athletes.maya)).toEqual([]);
    await expect(db.transaction((tx) => postShoutout(tx, V.marcus, { athleteId: ctx.athletes.maya, template: "new_pr" }, { today: addDaysYmd(TODAY, 3) }))).rejects.toBeInstanceOf(UserError);
    await setSettings({ enabled: true, panels: {} });
  });
});

describe("settings", () => {
  const input = { enabled: true, defaultDisplayMode: "first_name_only", panels: ["pr_bell", "classes"], rotationSeconds: "20", shoutoutDailyLimit: "4", orgMessage: "Holiday hours start Monday." };
  it("owner/admin only, validated and audited", async () => {
    await expect(db.transaction((tx) => saveCommunitySettings(tx, V.marcus, input))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => saveCommunitySettings(tx, V.erin, input))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => saveCommunitySettings(tx, V.rod, { ...input, rotationSeconds: "2" }))).rejects.toThrow();
    await expect(db.transaction((tx) => saveCommunitySettings(tx, V.rod, { ...input, orgMessage: "Closed Friday — see you Monday" }))).rejects.toBeInstanceOf(UserError);
    const saved = await db.transaction((tx) => saveCommunitySettings(tx, V.rod, input));
    expect(saved).toMatchObject({ defaultDisplayMode: "first_name_only", rotationSeconds: 20, shoutoutDailyLimit: 4, orgMessage: "Holiday hours start Monday." });
    expect(saved.panels).toMatchObject({ pr_bell: true, classes: true, streaks: false, leaderboards: false });
    const [o] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(communitySettingsOf(o.settings)).toEqual(saved);
    expect((await audits("org.community_settings_update", ctx.orgId)).length).toBe(1);
    // Other settings blocks are untouched.
    expect(o.settings.bookingWindowDays).toBe(21);
    expect((await board()).rotationSeconds).toBe(20);
  });
});
