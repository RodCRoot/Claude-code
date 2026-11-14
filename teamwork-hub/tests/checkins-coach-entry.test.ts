import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { activitySessions, auditEvents, bookings, scheduleSessions, serviceTypes, sessionCheckins, sessionFeedback, tasks, xpEvents } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { coachEntryAccess, coachEntryTarget, coachSubmitAfter, coachSubmitReady, entryName } from "@/lib/checkins/coach-entry";
import { afterTarget, enteredByCoach, readyTarget, sharedWithCoach, submitAfter, submitReady } from "@/lib/checkins/core";
import { athleteCheckinTrends, checkinDetail, checkinInsights, sessionReadiness } from "@/lib/checkins/views";
import { syncXp } from "@/lib/engagement/sync";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * Coach-entered check-ins. Every person is synthetic. Sessions are created at fixed offsets from a
 * fixed instant, so nothing depends on the weekday or on seeded sessions.
 */
const db = testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
type V = Awaited<ReturnType<typeof viewerFor>>;
let marcus: V; // coach assigned to Maya (and others)
let tess: V; // a coach NOT assigned to Maya
let erin: V; // operations: no health access, no training.write
let rod: V; // owner
let maya: V; // the athlete
let alex: V; // parent with health access
let MARCUS = ""; // the name shown after "entered by coach"

const NOW = new Date("2026-03-04T17:00:00Z");
const H = 3_600_000;
let n = 0;

/** A session for Maya coached by Marcus. `startsIn` hours from NOW; attended when asked. */
async function mkBooking(startsIn: number, opts: { attended?: boolean; athlete?: string; coach?: V } = {}) {
  n += 1;
  const [st] = await db.select().from(serviceTypes).where(eq(serviceTypes.orgId, ctx.orgId)).limit(1);
  const startsAt = new Date(NOW.getTime() + startsIn * H);
  const [s] = await db
    .insert(scheduleSessions)
    .values({ orgId: ctx.orgId, serviceTypeId: st.id, title: `Sample Coach Entry Class ${n}`, startsAt, endsAt: new Date(startsAt.getTime() + H), timezone: "America/Indiana/Indianapolis", capacity: 10, coachUserId: (opts.coach ?? marcus).userId, status: "scheduled" })
    .returning();
  const [b] = await db
    .insert(bookings)
    .values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes[opts.athlete ?? "maya"], status: opts.attended ? "attended" : "booked", bookedByUserId: rod.userId, entitlementSource: "comp", idempotencyKey: `coach-entry-test:${ctx.orgId}:${n}` })
    .returning();
  return { session: s, booking: b };
}
const ready = (v: V, bookingId: string, x: Record<string, unknown> = {}, now = NOW) => db.transaction((tx) => coachSubmitReady(tx, v, { bookingId, readiness: 4, soreness: 2, sleepQuality: 3, hurt: "no", ...x }, now));
const after = (v: V, bookingId: string, x: Record<string, unknown> = {}, now = NOW) => db.transaction((tx) => coachSubmitAfter(tx, v, { bookingId, liked: [], disliked: [], ...x }, now));
const rowOf = async (bookingId: string, phase: "pre" | "post") => (await db.select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, bookingId), eq(sessionCheckins.phase, phase))))[0];

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: ["scheduling"] });
  [marcus, tess, erin, rod, maya, alex] = await Promise.all(["marcus", "tess", "erin", "rod", "maya", "alex"].map((k) => viewerFor(ctx, k)));
  MARCUS = entryName(marcus);
  expect(MARCUS).toBe("Marcus Hale");
});
afterAll(closeTestDb);

describe("who may enter", () => {
  it("a coach with training and health access to the athlete; not other coaches, operations or families", async () => {
    expect(await coachEntryAccess(db, marcus, ctx.athletes.maya)).toEqual({ any: true, ready: true, effort: true, body: true, experience: true });
    expect((await coachEntryAccess(db, rod, ctx.athletes.maya)).any).toBe(true);
    for (const v of [tess, erin, alex, maya]) expect((await coachEntryAccess(db, v, ctx.athletes.maya)).any, v.displayName).toBe(false);

    const { booking } = await mkBooking(1);
    for (const v of [tess, erin, alex, maya]) {
      await expect(ready(v, booking.id), v.displayName).rejects.toBeInstanceOf(AuthzError);
      await expect(db.transaction((tx) => coachEntryTarget(tx, v, booking.id, NOW)), v.displayName).rejects.toBeInstanceOf(AuthzError);
    }
    expect(await rowOf(booking.id, "pre")).toBeUndefined();
    // Another organization's coach cannot even see that the booking exists.
    const other = await seedOrg("2026-03-02", { modules: ["scheduling"] });
    await expect(ready(await viewerFor(other, "marcus"), booking.id)).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("ready check entered by a coach", () => {
  it("is stamped with the coach's name everywhere it shows, and audited without any answers", async () => {
    const { session, booking } = await mkBooking(1);
    const r = await ready(marcus, booking.id, { note: "Said the left knee is a bit stiff (sample)" });
    expect(r.replaced).toBe(false);
    const row = await rowOf(booking.id, "pre");
    expect(row.answeredBy.ready).toMatchObject({ role: "coach", userId: marcus.userId, name: MARCUS });
    expect(row.loggedByParent).toBe(false);
    expect(row.replacements).toEqual([]);
    expect(enteredByCoach(row)).toBe(MARCUS);

    // Roster strip, the response page, the athlete's trends and the family's own page all say so.
    const strip = (await sessionReadiness(db, marcus, session.id))!;
    expect(strip.rows[0]).toMatchObject({ done: true, enteredByCoach: MARCUS, replaced: false, canCoachEnter: true });
    // Operations has no health access: no answers, but still told who entered it, and no entry link.
    const ops = (await sessionReadiness(db, erin, session.id))!;
    expect(ops.rows[0]).toMatchObject({ enteredByCoach: MARCUS, canCoachEnter: false, health: null });
    const detail = await checkinDetail(db, marcus, row.id);
    expect(detail.enteredByCoach).toBe(MARCUS);
    expect(detail.coachEntered).toEqual([{ section: "ready", name: MARCUS, at: NOW.toISOString() }]);
    const fam = await db.transaction((tx) => readyTarget(tx, maya, booking.id, NOW));
    expect(fam).toMatchObject({ state: "done", enteredByCoach: MARCUS, replacedByCoach: false });
    const parent = await db.transaction((tx) => readyTarget(tx, alex, booking.id, NOW));
    expect(parent.enteredByCoach).toBe(MARCUS);

    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.entityId, row.id)));
    const entry = audits.find((a) => a.action === "checkin.coach_entry")!;
    expect(entry.actorUserId).toBe(marcus.userId);
    expect(entry.summary).toBe(`Ready check entered by coach ${MARCUS} on behalf of Maya Parker`);
    for (const a of audits) expect(a.summary ?? "").not.toMatch(/knee|stiff/);
    expect(audits.some((a) => a.action === "checkin.ready_submit" && /entered by coach/.test(a.summary ?? ""))).toBe(true);
  });

  it("a coach may correct a coach entry, but the athlete cannot be locked out silently: the athlete sees it as done", async () => {
    const { booking } = await mkBooking(1);
    await ready(marcus, booking.id, { readiness: 2 });
    await ready(marcus, booking.id, { readiness: 5 }); // plain correction, no replacement record
    const row = await rowOf(booking.id, "pre");
    expect(row.readiness).toBe(5);
    expect(row.replacements).toEqual([]);
    await expect(db.transaction((tx) => submitReady(tx, maya, { bookingId: booking.id, readiness: 1, soreness: 9, sleepQuality: 1 }, NOW))).rejects.toThrow(/already done/);
    expect((await rowOf(booking.id, "pre")).readiness).toBe(5);
  });

  it("never overwrites the athlete's own answer without an explicit, visible replacement", async () => {
    const { session, booking } = await mkBooking(1);
    await db.transaction((tx) => submitReady(tx, maya, { bookingId: booking.id, readiness: 2, soreness: 7, sleepQuality: 2, note: "Tired today (sample)" }, NOW));
    const t = await db.transaction((tx) => coachEntryTarget(tx, marcus, booking.id, NOW));
    expect(t.ready).toBe("answered");
    expect(t.readyBy?.label).toBe("the athlete");

    await expect(ready(marcus, booking.id, { readiness: 5 })).rejects.toThrow(/already answered this/);
    await expect(ready(marcus, booking.id, { readiness: 5, replace: "on" })).rejects.toThrow(/Say why/);
    let row = await rowOf(booking.id, "pre");
    expect(row).toMatchObject({ readiness: 2, soreness: 7 });
    expect(row.answeredBy.ready?.role).toBe("athlete");

    const later = new Date(NOW.getTime() + 10 * 60_000);
    const r = await ready(marcus, booking.id, { readiness: 4, soreness: 3, replace: "on", replaceReason: "Maya asked me to fix a mistapped answer" }, later);
    expect(r.replaced).toBe(true);
    row = await rowOf(booking.id, "pre");
    expect(row).toMatchObject({ readiness: 4, soreness: 3 });
    expect(row.answeredBy.ready).toMatchObject({ role: "coach", name: MARCUS });
    expect(row.replacements).toHaveLength(1);
    expect(row.replacements[0]).toMatchObject({
      section: "ready",
      byUserId: marcus.userId,
      byName: MARCUS,
      reason: "Maya asked me to fix a mistapped answer",
      previous: { role: "athlete", userId: maya.userId, at: NOW.toISOString() },
      values: { readiness: 2, soreness: 7, sleepQuality: 2, note: "Tired today (sample)" },
    });

    // Visible wherever the check-in shows.
    expect((await sessionReadiness(db, marcus, session.id))!.rows[0]).toMatchObject({ enteredByCoach: MARCUS, replaced: true });
    const detail = await checkinDetail(db, marcus, row.id);
    expect(detail.replacements[0]).toMatchObject({ section: "ready", byName: MARCUS, previousBy: "the athlete", reason: "Maya asked me to fix a mistapped answer" });
    expect(detail.replacements[0].values).toMatchObject({ readiness: 2 });
    expect((await db.transaction((tx) => readyTarget(tx, maya, booking.id, later))).replacedByCoach).toBe(true);
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, row.id), eq(auditEvents.action, "checkin.coach_replace")));
    expect(a.summary).toMatch(/replacing the answer given by the athlete\. Reason: Maya asked me/);
    expect(a.summary).not.toMatch(/Tired today/);
  });

  it("windows: from the ready-check opening until the session ends; not for a cancelled booking", async () => {
    const early = await mkBooking(10);
    await expect(ready(marcus, early.booking.id)).rejects.toThrow(/opens a few hours before/);
    const running = await mkBooking(-0.5); // started 30 minutes ago: closed for the family, open for the coach at the gym
    await expect(db.transaction((tx) => submitReady(tx, maya, { bookingId: running.booking.id, readiness: 3, soreness: 1, sleepQuality: 3 }, NOW))).rejects.toThrow(/closed/);
    expect((await ready(marcus, running.booking.id)).checkin.readiness).toBe(4);
    const over = await mkBooking(-3);
    await expect(ready(marcus, over.booking.id)).rejects.toThrow(/session has ended/);
    const cancelled = await mkBooking(1);
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, cancelled.booking.id));
    await expect(ready(marcus, cancelled.booking.id)).rejects.toThrow(/booked session/);
  });

  it("alerts work the same as for an athlete's own answer", async () => {
    const { booking } = await mkBooking(1);
    const r = await ready(marcus, booking.id, { hurt: "yes" });
    expect(r.reasons).toContain("hurt_no_location");
    const row = await rowOf(booking.id, "pre");
    const [task] = await db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `checkin_review:${row.id}`)));
    expect(task.description).not.toMatch(/hurt|pain/i);
  });
});

describe("after check entered by a coach", () => {
  it("effort and body are entered and labelled; the load row is written once; no rating and no 'show my coach' tick is touched", async () => {
    const { booking } = await mkBooking(-2, { attended: true });
    const r = await after(marcus, booking.id, { rpe: 7, soreness: 4, hurt: "no", rating: 1, tellCoach: "on" });
    expect(r.wrote.sort()).toEqual(["body", "effort"]);
    const row = await rowOf(booking.id, "post");
    expect(row).toMatchObject({ rpe: 7, soreness: 4, hurt: false, tellCoach: false, loggedByParent: false });
    expect(row.answeredBy.effort).toMatchObject({ role: "coach", name: MARCUS });
    expect(row.answeredBy.body).toMatchObject({ role: "coach", name: MARCUS });
    expect(row.answeredBy.experience).toBeUndefined();
    expect(await db.select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, booking.id))).toHaveLength(0);
    // Correcting the effort updates the same load row.
    await after(marcus, booking.id, { rpe: 8 });
    const loads = await db.select().from(activitySessions).where(and(eq(activitySessions.orgId, ctx.orgId), eq(activitySessions.athleteId, ctx.athletes.maya), like(activitySessions.notes, `%${"Sample Coach Entry Class"}%`), eq(activitySessions.sessionRpe, 8)));
    expect(loads.filter((l) => l.id === (row.activitySessionId ?? ""))).toHaveLength(1);

    // The athlete can still add what only they should: their own likes, and the rating.
    const fam = await db.transaction((tx) => afterTarget(tx, maya, booking.id, NOW));
    expect(fam.sections).toMatchObject({ effort: "locked", body: "locked", experience: "open" });
    expect(fam.enteredByCoach).toBe(MARCUS);
    await db.transaction((tx) => submitAfter(tx, maya, { bookingId: booking.id, liked: ["lifting"], disliked: [], rating: 5 }, NOW));
    const done = await rowOf(booking.id, "post");
    expect(done.rpe).toBe(8); // untouched by the athlete's later submission
    expect(done.answeredBy.experience?.role).toBe("athlete");
    expect(done.replacements).toEqual([]);
  });

  it("replacing the athlete's effort or body answer needs a reason and leaves a visible record; their likes cannot be replaced", async () => {
    const { booking } = await mkBooking(-2, { attended: true });
    await db.transaction((tx) => submitAfter(tx, maya, { bookingId: booking.id, rpe: 3, liked: [], disliked: [], dislikedText: "Too much waiting (sample)", soreness: 6, hurt: "no" }, NOW));
    const t = await db.transaction((tx) => coachEntryTarget(tx, marcus, booking.id, NOW));
    expect(t.after).toEqual({ effort: "answered", body: "answered", experience: "family" });
    expect(t.post?.experience).toBeNull(); // the family's own words are not handed to the entry form

    await expect(after(marcus, booking.id, { rpe: 9 })).rejects.toThrow(/already answered this/);
    await expect(after(marcus, booking.id, { likedText: "Loved it" })).rejects.toThrow(/their own words/);
    expect(await rowOf(booking.id, "post")).toMatchObject({ rpe: 3, dislikedText: "Too much waiting (sample)" });

    const r = await after(marcus, booking.id, { rpe: 9, replace: "on", replaceReason: "Meant 9, tapped 3" });
    expect(r.replaced).toEqual(["effort"]);
    const row = await rowOf(booking.id, "post");
    expect(row.rpe).toBe(9);
    expect(row.soreness).toBe(6); // the body answer was not part of this entry and is untouched
    expect(row.answeredBy.body?.role).toBe("athlete");
    expect(row.dislikedText).toBe("Too much waiting (sample)");
    expect(row.replacements).toHaveLength(1);
    expect(row.replacements[0]).toMatchObject({ section: "effort", byName: MARCUS, previous: { role: "athlete" }, values: { rpe: 3 } });
    const detail = await checkinDetail(db, marcus, row.id);
    expect(detail.replacements).toHaveLength(1);
    expect(detail.coachEntered.map((c) => c.section)).toEqual(["effort"]);
  });

  it("opens only after the session ends and only for an attended booking; body questions need health access", async () => {
    const future = await mkBooking(1, { attended: true });
    await expect(after(marcus, future.booking.id, { rpe: 5 })).rejects.toThrow(/opens when the session ends/);
    const notAttended = await mkBooking(-2);
    await expect(after(marcus, notAttended.booking.id, { rpe: 5 })).rejects.toThrow(/checked in/);
    const empty = await mkBooking(-2, { attended: true });
    await expect(after(marcus, empty.booking.id, {})).rejects.toThrow(/nothing to save/i);
    await expect(after(erin, empty.booking.id, { rpe: 5 })).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("the privacy promise and XP", () => {
  it("coach-entered likes and dislikes are visible to the coach without the family's tick, and that tick stays the family's", async () => {
    const { booking } = await mkBooking(-2, { attended: true });
    await after(marcus, booking.id, { rpe: 6, liked: ["lifting"], dislikedText: "Wanted more sprint work (sample)" });
    const row = await rowOf(booking.id, "post");
    expect(row.tellCoach).toBe(false);
    expect(row.answeredBy.experience).toMatchObject({ role: "coach", name: MARCUS });
    expect(sharedWithCoach(row)).toBe(true);
    // The coach reads it with the name; the follow-up goes to the session's coach, not to the owner.
    const detail = await checkinDetail(db, marcus, row.id);
    expect(detail.athleteName).toBe("Maya Parker");
    expect(detail.experience).toMatchObject({ dislikedText: "Wanted more sprint work (sample)", tellCoach: false });
    const [task] = await db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `checkin_dislike:${row.id}`)));
    expect(task.assigneeUserId).toBe(marcus.userId);
    const trends = await athleteCheckinTrends(db, marcus, ctx.athletes.maya, { now: new Date(NOW.getTime() + H) });
    const point = trends.points.find((p) => p.bookingId === booking.id)!;
    expect(point.afterEnteredByCoach).toBe(MARCUS);
    expect(point.liked.map((c) => c.key)).toEqual(["lifting"]);
    const insights = await checkinInsights(db, ctx.orgId, { from: "2026-03-01", to: "2026-03-31", tz: "America/Indiana/Indianapolis", coachUserId: marcus.userId, groupBy: "coach" }, { reviewer: false, minResponses: 1, withComments: true });
    expect(insights.flatMap((i) => i.comments).some((c) => c.text === "Wanted more sprint work (sample)")).toBe(true);

    // The promise itself is unchanged: what the ATHLETE wrote without the tick stays hidden from the coach.
    const own = await mkBooking(-2, { attended: true });
    await db.transaction((tx) => submitAfter(tx, maya, { bookingId: own.booking.id, rpe: 5, liked: [], disliked: [], dislikedText: "Private thought (sample)" }, NOW));
    const ownRow = await rowOf(own.booking.id, "post");
    expect(sharedWithCoach(ownRow)).toBe(false);
    const hidden = await checkinDetail(db, marcus, ownRow.id);
    expect(hidden.experience).toBeNull();
    // A coach replacing the athlete's EFFORT answer does not open up the athlete's private comment.
    await after(marcus, own.booking.id, { rpe: 6, replace: "on", replaceReason: "Corrected with the athlete" });
    const after2 = await rowOf(own.booking.id, "post");
    expect(sharedWithCoach(after2)).toBe(false);
    expect((await checkinDetail(db, marcus, after2.id)).experience).toBeNull();
  });

  it("the athlete earns the check-in XP once per booking and phase, however many people answered", async () => {
    const { booking } = await mkBooking(-2, { attended: true });
    const pre = await mkBooking(-0.5, { attended: true });
    await ready(marcus, pre.booking.id);
    await after(marcus, booking.id, { rpe: 6 });
    await db.transaction((tx) => submitAfter(tx, maya, { bookingId: booking.id, liked: ["lifting"], disliked: [], rating: 4 }, NOW));
    await after(marcus, booking.id, { rpe: 7 }); // a correction
    const sync = () => db.transaction((tx) => syncXp(tx, ctx.orgId, ctx.athletes.maya));
    await sync();
    await sync();
    const xp = await db.select().from(xpEvents).where(and(eq(xpEvents.orgId, ctx.orgId), eq(xpEvents.athleteId, ctx.athletes.maya), eq(xpEvents.sourceType, "session_checkin")));
    const forPost = xp.filter((x) => x.sourceId === `${booking.id}:post`);
    const forPre = xp.filter((x) => x.sourceId === `${pre.booking.id}:pre`);
    expect(forPost).toHaveLength(1);
    expect(forPre).toHaveLength(1);
    expect(forPost[0].points).toBe(forPre[0].points);
  });
});
