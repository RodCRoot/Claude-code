import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitySessions, anywhereCompletions, athletes, auditEvents, exercises, guardianships, people, xpEvents } from "@/db/schema";
import { AuthzError, athleteCapabilities, guardianMayLogAtHome, type Viewer } from "@/lib/authz/policy";
import { anywhereAccess } from "@/lib/anywhere/common";
import { logSport } from "@/lib/anywhere/season";
import { addStep, completeSession, completionReviewQueue, completionsForAthlete, createSession, updateSession } from "@/lib/anywhere/sessions";
import { refreshEngagement } from "@/lib/engagement/sync";
import { checkinHabit } from "@/lib/science/habits";
import { athleteLoad } from "@/lib/science/load";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * Owner decision (2026-11): a parent may finish an On Your Own session and enter its effort rating
 * for an athlete under 13. Rule: the guardian link carries training access AND booking access, and
 * the athlete is under 13 by the birthday on file (no birthday = not allowed).
 */
type Ctx = Awaited<ReturnType<typeof seedOrg>>;
const TODAY = todayLocal();
const NOW = new Date();
const db = testDb();
let ctx: Ctx;
let other: Ctx;
const V: Record<string, Viewer> = {};
let kids = "";
let teens = "";
let n = 0;
const key = () => `guardian-key-${Date.now()}-${n++}`;
const input = (athleteId: string, sessionId = kids, extra: Record<string, unknown> = {}) => ({ athleteId, sessionId, clientKey: key(), stepsDone: 1, durationMinutes: null, rpe: null, ...extra });
const finish = (who: string, athleteId: string, sessionId = kids, extra: Record<string, unknown> = {}) => db.transaction((tx) => completeSession(tx, V[who], input(athleteId, sessionId, extra), NOW));

async function makeSession(title: string, suitableUnder13: boolean) {
  const d = { title, description: "Test session", category: "mobility", durationMinutes: 10, equipment: [], suitableUnder13 };
  const s = await createSession(db, V.marcus, d);
  const [ex] = await db.select().from(exercises).where(and(eq(exercises.orgId, ctx.orgId), eq(exercises.name, "Plank")));
  await addStep(db, V.marcus, s.id, { exerciseId: ex.id, prescription: "2 x 30 seconds" });
  await updateSession(db, V.marcus, s.id, { ...d, status: "published" });
  return s.id;
}
const setDob = async (athleteId: string, dob: string | null) => {
  const [a] = await db.select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, athleteId));
  await db.update(people).set({ dateOfBirth: dob }).where(eq(people.id, a.personId));
};
const yearsBefore = (ymd: string, years: number) => `${Number(ymd.slice(0, 4)) - years}${ymd.slice(4)}`;

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: ["scheduling", "training", "science"] });
  other = await seedOrg(TODAY, { modules: ["training"] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "maya", "dana", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherAlex = await viewerFor(other, "alex");
  kids = await makeSession("Guardian Test Kids", true);
  teens = await makeSession("Guardian Test Teens", false);
});
afterAll(closeTestDb);

const A = () => ctx.athletes;

describe("pure rule", () => {
  it("needs training access, booking access and a birthday that makes the athlete under 13", () => {
    const both = { canViewTraining: true, canBook: true };
    expect(guardianMayLogAtHome(both, "2015-06-01", "2026-11-11")).toBe(true);
    expect(guardianMayLogAtHome(both, "2013-11-12", "2026-11-11")).toBe(true); // 13th birthday is tomorrow
    expect(guardianMayLogAtHome(both, "2013-11-11", "2026-11-11")).toBe(false); // turns 13 today
    expect(guardianMayLogAtHome(both, "2010-01-01", "2026-11-11")).toBe(false);
    expect(guardianMayLogAtHome(both, null, "2026-11-11")).toBe(false); // no birthday on file
    expect(guardianMayLogAtHome({ canViewTraining: true, canBook: false }, "2015-06-01", "2026-11-11")).toBe(false);
    expect(guardianMayLogAtHome({ canViewTraining: false, canBook: true }, "2015-06-01", "2026-11-11")).toBe(false);
  });
});

describe("a parent logs an at-home session for an athlete under 13", () => {
  it("Alex (training and booking access) finishes a session for Eli (12): recorded as logged by a parent, audited, with load", async () => {
    const r = await finish("alex", A().eli, kids, { durationMinutes: 12, rpe: 4 });
    expect(r).toMatchObject({ status: "applied", loadLogged: true });
    const [row] = await db.select().from(anywhereCompletions).where(eq(anywhereCompletions.id, r.completionId));
    expect(row).toMatchObject({ athleteId: A().eli, loggedAs: "guardian", loggedBy: V.alex.userId, durationMinutes: 12, rpe: 4 });
    // The load row is the same kind of row the athlete's own log writes.
    const [act] = await db.select().from(activitySessions).where(eq(activitySessions.id, row.activitySessionId!));
    expect(act).toMatchObject({ athleteId: A().eli, source: "on_your_own", kind: "training", durationMinutes: 12, sessionRpe: 4, enteredBy: V.alex.userId });
    const load = await athleteLoad(db, V.tess, A().eli);
    expect(JSON.stringify(load)).toContain("on_your_own");
    const [au] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, r.completionId), eq(auditEvents.action, "anywhere.session.complete")));
    expect(au.actorUserId).toBe(V.alex.userId);
    expect(au.summary).toMatch(/Parent logged .* on behalf of an athlete under 13/);
    expect(au.after).toMatchObject({ loggedAs: "guardian", athleteId: A().eli });
  });

  it("counts toward the streak and XP exactly like the athlete's own log, once", async () => {
    const before = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, A().eli, { today: TODAY }));
    const r = await finish("alex", A().eli);
    const after = await db.transaction((tx) => refreshEngagement(tx, ctx.orgId, A().eli, { today: TODAY }));
    expect(after!.streak.thisWeekActive).toBe(true);
    const xp = await db.select().from(xpEvents).where(and(eq(xpEvents.athleteId, A().eli), eq(xpEvents.idempotencyKey, `own:${r.completionId}`)));
    expect(xp).toHaveLength(1);
    expect(xp[0]).toMatchObject({ kind: "on_your_own_completed", points: 10 });
    expect(after!.level!.xp - before!.level!.xp).toBe(10);
    // A retry with the same key changes nothing.
    const clientKey = key();
    const one = await db.transaction((tx) => completeSession(tx, V.alex, { ...input(A().eli), clientKey }, NOW));
    const two = await db.transaction((tx) => completeSession(tx, V.alex, { ...input(A().eli), clientKey }, NOW));
    expect([one.status, two.status]).toEqual(["applied", "duplicate"]);
  });

  it("coaches see the 'logged by parent' marker with the parent's name; the family history says so too", async () => {
    const q = await completionReviewQueue(db, V.tess);
    const mine = q.filter((c) => c.athleteId === A().eli);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.loggedAs === "guardian" && c.loggedByName === V.alex.displayName)).toBe(true);
    const own = await finish("tess", A().eli);
    const q2 = await completionReviewQueue(db, V.tess);
    expect(q2.find((c) => c.id === own.completionId)).toMatchObject({ loggedAs: "staff", loggedByName: null });
    expect((await completionsForAthlete(db, V.jordan, A().eli)).some((c) => c.loggedAs === "guardian")).toBe(true);
  });

  it("Jordan has no health access but has training and booking access: allowed (effort is training data)", async () => {
    expect((await finish("jordan", A().eli, kids, { durationMinutes: 8, rpe: 3 })).status).toBe("applied");
    const access = await anywhereAccess(db, V.jordan, A().eli, TODAY);
    expect(access).toMatchObject({ canLog: false, canFinishSession: true, finishesAsGuardian: true });
  });

  it("the under-13 library rule still applies to the parent", async () => {
    await expect(finish("alex", A().eli, teens)).rejects.toThrow(AuthzError);
  });
});

describe("who may not", () => {
  it("a parent of an athlete who is 13 or older (Maya 15, Leo 16)", async () => {
    await expect(finish("alex", A().maya, teens)).rejects.toThrow(AuthzError);
    await expect(finish("jordan", A().maya, kids)).rejects.toThrow(AuthzError);
    await expect(finish("sam", A().leo, kids)).rejects.toThrow(AuthzError);
    expect(await anywhereAccess(db, V.alex, A().maya, TODAY)).toMatchObject({ canFinishSession: false, finishesAsGuardian: false });
  });

  it("someone who is not this child's guardian: another family, another athlete, kiosk, another organization", async () => {
    for (const who of ["chris", "sam", "casey", "maya", "dana", "kiosk", "otherAlex"]) await expect(finish(who, A().eli)).rejects.toThrow(AuthzError);
    // Operations has no training.log and is not a guardian.
    await expect(finish("erin", A().eli)).rejects.toThrow(AuthzError);
  });

  it("a guardian without booking access, or without training access, even when the child is under 13", async () => {
    const leoDob = (await db.select({ dob: people.dateOfBirth }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.id, A().leo)))[0].dob;
    await setDob(A().leo, yearsBefore(addDaysYmd(TODAY, -30), 10));
    try {
      // Casey: can_book = false. Sam: both flags.
      await expect(finish("casey", A().leo)).rejects.toThrow(AuthzError);
      expect((await athleteCapabilities(db, V.casey, A().leo, { today: TODAY })).has("training.log_at_home")).toBe(false);
      expect((await finish("sam", A().leo)).status).toBe("applied");
      // Jordan loses training access for Eli: no longer allowed (and cannot even open the session).
      await db.update(guardianships).set({ canViewTraining: false }).where(and(eq(guardianships.guardianPersonId, V.jordan.personId!), eq(guardianships.athleteId, A().eli)));
      await expect(finish("jordan", A().eli)).rejects.toThrow(AuthzError);
      await db.update(guardianships).set({ canViewTraining: true }).where(and(eq(guardianships.guardianPersonId, V.jordan.personId!), eq(guardianships.athleteId, A().eli)));
      // A revoked link grants nothing.
      await db.update(guardianships).set({ status: "revoked" }).where(and(eq(guardianships.guardianPersonId, V.sam.personId!), eq(guardianships.athleteId, A().leo)));
      await expect(finish("sam", A().leo)).rejects.toThrow(AuthzError);
      await db.update(guardianships).set({ status: "active" }).where(and(eq(guardianships.guardianPersonId, V.sam.personId!), eq(guardianships.athleteId, A().leo)));
    } finally {
      await setDob(A().leo, leoDob);
    }
  });

  it("no birthday on file: the parent cannot log (unknown age never widens access); the day the athlete turns 13 it stops", async () => {
    const eliDob = (await db.select({ dob: people.dateOfBirth }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.id, A().eli)))[0].dob;
    try {
      await setDob(A().eli, null);
      await expect(finish("alex", A().eli)).rejects.toThrow(AuthzError);
      expect(await anywhereAccess(db, V.alex, A().eli, TODAY)).toMatchObject({ restricted: true, canFinishSession: false });
      // The coach still can.
      expect((await finish("tess", A().eli)).status).toBe("applied");
      await setDob(A().eli, yearsBefore(TODAY, 13));
      await expect(finish("alex", A().eli)).rejects.toThrow(AuthzError);
      await setDob(A().eli, yearsBefore(addDaysYmd(TODAY, 1), 13));
      expect((await finish("alex", A().eli)).status).toBe("applied");
    } finally {
      await setDob(A().eli, eliDob);
    }
  });

  it("the new permission is only for at-home sessions: practice logs and habits stay with the athlete and coaches", async () => {
    const caps = await athleteCapabilities(db, V.alex, A().eli, { today: TODAY });
    expect(caps.has("training.log_at_home")).toBe(true);
    expect(caps.has("training.log")).toBe(false);
    await expect(db.transaction((tx) => logSport(tx, V.alex, { athleteId: A().eli, kind: "practice", occurrenceDate: TODAY, durationMinutes: 60, rpe: 5, clientKey: key() }, NOW))).rejects.toThrow(AuthzError);
    await expect(checkinHabit(db, V.alex, { habitId: "00000000-0000-4000-8000-000000000000", athleteId: A().eli, forDate: TODAY, status: "done" } as never)).rejects.toThrow();
    // Staff and athletes never carry the guardian capability.
    for (const who of ["rod", "tess", "maya"]) expect((await athleteCapabilities(db, V[who], who === "maya" ? A().maya : A().eli, { today: TODAY })).has("training.log_at_home")).toBe(false);
  });

  it("the database refuses an unknown logged_as value", async () => {
    await expect(db.insert(anywhereCompletions).values({ orgId: ctx.orgId, athleteId: A().eli, sessionId: kids, sessionTitle: "x", category: "mobility", clientKey: key(), completedAt: NOW, localDate: TODAY, stepsDone: 1, stepsTotal: 1, loggedAs: "nobody" as never })).rejects.toThrow();
  });
});
