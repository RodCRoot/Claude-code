import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { activitySessions, auditEvents, bodyRegionReports, bookings, checkinKioskPasses, organizations, questionnaireResponses, questionnaires, questionnaireVersions, scheduleSessions, sessionCheckins, sessionFeedback, tasks, workouts, xpEvents } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { baselineV1, completionV1, farFromBaseline, intensityGapV1 } from "@/lib/checkins/baseline";
import { afterTarget, issueKioskReadyPass, preWindow, readyTarget, REVIEW_TASK_TITLE, DISLIKE_TASK_TITLE, submitAfter, submitKioskReady, submitReady } from "@/lib/checkins/core";
import { DEFAULT_CHECKIN_SETTINGS, checkinSettings, saveCheckinSettings } from "@/lib/checkins/settings";
import { athleteCheckinTrends, checkinCompletionSummary, checkinDetail, classInsightsFor, openCheckinAlerts, pendingCheckins, reviewCheckin, sessionReadiness, setIntendedRpe } from "@/lib/checkins/views";
import { syncXp } from "@/lib/engagement/sync";
import { reportByKey } from "@/lib/reports";
import { FOLLOW_UP_TITLE, submitFeedback } from "@/lib/retention/feedback";
import { kioskPinCheckIn, setCheckInPin } from "@/lib/scheduling";
import { dailyLoadSeries } from "@/lib/science/formulas";
import { loadEntries } from "@/lib/science/load";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

/**
 * Session check-ins. Core-only org; "today" is Monday 2026-10-12; classes run 5:00 to 6:00 PM
 * facility time (21:00 to 22:00 UTC that week).
 */
const TODAY = "2026-10-12";
const START = new Date("2026-10-12T21:00:00Z");
const PRE = new Date("2026-10-12T19:00:00Z"); // 3:00 PM local, two hours before class
const MORNING = new Date("2026-10-12T15:00:00Z"); // 11:00 AM local, 17 hours after yesterday's class ended
const SECRET_NOTE = "Rolled my ankle at recess";
const SECRET_DISLIKE = "Too much standing around between sets";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let w: Awaited<ReturnType<typeof retentionWorld>>;
const db = () => testDb();
const V = (k: string) => viewerFor(ctx, k);
const ready = async (userKey: string, input: Record<string, unknown>, now = PRE) => db().transaction(async (tx) => submitReady(tx, await V(userKey), input, now));
const after = async (userKey: string, input: Record<string, unknown>, now = MORNING) => db().transaction(async (tx) => submitAfter(tx, await V(userKey), input, now));
const B: Record<string, string> = {};
const S: Record<string, string> = {};
const okReady = { readiness: 4, sleepQuality: 4, soreness: 2, hurt: "no" };

async function book(key: string, athlete: string, offset: number, status: "booked" | "attended", opts: Parameters<typeof w.booking>[3] = {}) {
  const r = await w.booking(ctx.athletes[athlete], offset, status, opts);
  B[key] = r.booking.id;
  S[key] = r.session.id;
  return r;
}

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  w = await retentionWorld(ctx, TODAY);
  // Maya: six earlier sessions with a steady ready check (readiness 4, soreness 2) so a baseline exists.
  for (const d of [20, 17, 14, 11, 8, 5]) {
    const r = await w.booking(ctx.athletes.maya, -d, "attended");
    await db().insert(sessionCheckins).values({ orgId: ctx.orgId, bookingId: r.booking.id, sessionId: r.session.id, athleteId: ctx.athletes.maya, phase: "pre", questionSetVersion: "1.1", readiness: 4, sleepQuality: 4, soreness: 2, hurt: false, answeredBy: {} });
  }
  for (const k of ["maya", "eli", "leo", "dana", "ava"]) {
    await book(`${k}Today`, k, 0, "booked");
    await book(`${k}Yesterday`, k, -1, "attended");
  }
  await book("mayaLate", "maya", 0, "booked", { time: "23:30", title: "Late Class" });
  await book("mayaTess", "maya", -2, "attended", { coach: "tess", title: "Tess Class" });
});

afterAll(closeTestDb);

describe("pure calculations", () => {
  const at = (d: number) => new Date(START.getTime() - d * 86_400_000);
  it("checkin_baseline_v1: mean of earlier answers in the window; null until the minimum exists; nulls skipped", () => {
    const series = [3, 4, null, 5, 4].map((value, i) => ({ at: at(10 - i), value }));
    expect(baselineV1(series, START, { windowDays: 42, minAnswers: 5 })).toMatchObject({ mean: null, n: 4, needed: 5 });
    expect(baselineV1(series, START, { windowDays: 42, minAnswers: 4 })).toMatchObject({ mean: 4, n: 4 });
    // The answer being judged, and anything outside the window, never counts.
    expect(baselineV1([...series, { at: START, value: 1 }, { at: at(60), value: 1 }], START, { windowDays: 42, minAnswers: 4 }).mean).toBe(4);
  });
  it("checkin_deviation_v1: only the unfavourable side, and never without a baseline", () => {
    const b = baselineV1([2, 2, 2, 2, 2].map((value, i) => ({ at: at(i + 1), value })), START, { windowDays: 42, minAnswers: 5 });
    expect(farFromBaseline(5, b, 3, "above")).toBe(true);
    expect(farFromBaseline(4, b, 3, "above")).toBe(false);
    expect(farFromBaseline(0, b, 1, "above")).toBe(false);
    expect(farFromBaseline(9, baselineV1([], START, { windowDays: 42, minAnswers: 5 }), 3, "above")).toBe(false);
    expect(farFromBaseline(null, b, 3, "above")).toBe(false);
  });
  it("intensity gap and completion are null, not 0, when there is nothing to compute", () => {
    expect(intensityGapV1([{ intended: null, reported: [7] }, { intended: 6, reported: [null] }])).toEqual({ gap: null, sessions: 0 });
    expect(intensityGapV1([{ intended: 6, reported: [7, 8, null] }, { intended: 5, reported: [5] }])).toEqual({ gap: 0.8, sessions: 2 });
    expect(completionV1(0, 0)).toBeNull();
    expect(completionV1(1, 4)).toBe(0.25);
  });
});

describe("ready check: who may answer", () => {
  it("the athlete answers their own; the row records who and the question-set version", async () => {
    const r = await ready("dana", { bookingId: B.danaToday, ...okReady, note: "Long shift today" });
    expect(r.created).toBe(true);
    expect(r.checkin).toMatchObject({ phase: "pre", readiness: 4, sleepQuality: 4, soreness: 2, hurt: false, note: "Long shift today", loggedByParent: false, source: "app", questionSetVersion: "1.1", alertReasons: [] });
    expect(r.checkin.answeredBy.ready).toMatchObject({ userId: ctx.users.dana, role: "athlete" });
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityType, "session_checkin"), eq(auditEvents.entityId, r.checkin.id)));
    expect(a.action).toBe("checkin.ready_submit");
    expect(JSON.stringify(a)).not.toContain("Long shift");
    await expect(ready("dana", { bookingId: B.mayaToday, ...okReady })).rejects.toBeInstanceOf(AuthzError);
  });

  it("a parent with health access may answer for a child under 13, recorded as logged by a parent", async () => {
    const r = await ready("alex", { bookingId: B.eliToday, ...okReady, note: SECRET_NOTE });
    expect(r.checkin).toMatchObject({ loggedByParent: true, note: SECRET_NOTE });
    expect(r.checkin.answeredBy.ready).toMatchObject({ userId: ctx.users.alex, role: "guardian" });
  });

  it("refuses a parent of a 15 year old, a parent without health access, an unrelated parent, staff and the kiosk login", async () => {
    await expect(ready("alex", { bookingId: B.mayaToday, ...okReady })).rejects.toBeInstanceOf(AuthzError); // Maya is 15
    await expect(ready("sam", { bookingId: B.leoToday, ...okReady })).rejects.toBeInstanceOf(AuthzError); // Leo is 16
    await expect(ready("jordan", { bookingId: B.avaToday, ...okReady })).rejects.toBeInstanceOf(AuthzError); // not their child
    await expect(ready("chris", { bookingId: B.eliToday, ...okReady })).rejects.toBeInstanceOf(AuthzError);
    for (const k of ["rod", "erin", "marcus", "tess", "kiosk"]) await expect(ready(k, { bookingId: B.leoToday, ...okReady })).rejects.toBeInstanceOf(AuthzError);
    // Jordan is Eli's parent but has no health access: the page says so and loads no health answers.
    const t = await db().transaction(async (tx) => readyTarget(tx, await V("jordan"), B.eliToday, PRE));
    expect(t).toMatchObject({ state: "not_allowed", canWrite: false, existing: null, prefill: {}, done: true });
    expect(JSON.stringify(t.existing)).not.toContain(SECRET_NOTE);
  });
});

describe("ready check: windows, prefill, idempotency", () => {
  it("opens the configured hours before the start and closes 15 minutes after it", async () => {
    const s = DEFAULT_CHECKIN_SETTINGS;
    expect(preWindow({ startsAt: START }, s, new Date(START.getTime() - 4 * 3_600_000 - 1000)).state).toBe("not_open_yet");
    expect(preWindow({ startsAt: START }, s, new Date(START.getTime() - 4 * 3_600_000)).state).toBe("open");
    expect(preWindow({ startsAt: START }, s, new Date(START.getTime() + 15 * 60_000)).state).toBe("open");
    expect(preWindow({ startsAt: START }, s, new Date(START.getTime() + 16 * 60_000)).state).toBe("closed");
    await expect(ready("maya", { bookingId: B.mayaToday, ...okReady }, new Date("2026-10-12T16:00:00Z"))).rejects.toBeInstanceOf(UserError);
    await expect(ready("maya", { bookingId: B.mayaToday, ...okReady }, new Date("2026-10-12T21:20:00Z"))).rejects.toBeInstanceOf(UserError);
    // A booking that was cancelled, or an attended one from yesterday, has no open ready check.
    await expect(ready("maya", { bookingId: B.mayaYesterday, ...okReady })).rejects.toBeInstanceOf(UserError);
  });

  it("prefills from today's wellness by FACILITY-LOCAL date, only for identical items, and stores what it reused", async () => {
    const [q] = await db().insert(questionnaires).values({ orgId: ctx.orgId, name: "Daily", schedule: { frequency: "daily" } }).returning();
    const [ver] = await db()
      .insert(questionnaireVersions)
      .values({
        questionnaireId: q.id,
        version: 1,
        questions: [
          { key: "sleep_hours", label: "Hours", kind: "number" },
          { key: "sleep_quality", label: "Sleep", kind: "scale", min: 1, max: 5 },
          { key: "fatigue", label: "Fatigue", kind: "scale", min: 1, max: 5 },
          { key: "soreness", label: "Soreness", kind: "scale", min: 1, max: 5 },
          { key: "mood", label: "Mood", kind: "scale", min: 1, max: 10 },
        ],
      })
      .returning();
    await db().insert(questionnaireResponses).values({ orgId: ctx.orgId, athleteId: ctx.athletes.maya, versionId: ver.id, forDate: TODAY, answers: { sleep_hours: 6.5, sleep_quality: 2, fatigue: 4, soreness: 5, mood: 7 } });
    // 11:10 PM local on the 12th is already the 13th in UTC; the late class starts 11:30 PM local.
    const lateNow = new Date("2026-10-13T03:10:00Z");
    const t = await db().transaction(async (tx) => readyTarget(tx, await V("maya"), B.mayaLate, lateNow));
    expect(t.state).toBe("open");
    // Mood is a 1 to 10 item there, so it is not the same item; soreness 1 to 5 never fills the 0 to 10 one.
    expect(t.prefill).toEqual({ sleep_hours: 6.5, sleep_quality: 2, fatigue: 4 });
    const r = await ready("maya", { bookingId: B.mayaLate, readiness: 3, soreness: 1, mood: 4 }, lateNow);
    expect(r.checkin).toMatchObject({ sleepQuality: 2, sleepHours: 6.5, fatigue: 4, mood: 4, soreness: 1, stress: null });
    expect(r.checkin.prefilled.sort()).toEqual(["fatigue", "sleep_hours", "sleep_quality"]);
    // Without a wellness answer, sleep is a required question.
    await expect(ready("chris", { bookingId: B.avaToday, readiness: 3, soreness: 1 })).rejects.toMatchObject({ fieldErrors: { sleepQuality: expect.any(String) } });
  });

  it("re-submitting corrects the same row: one check-in, one alert task, XP once", async () => {
    // Soreness 6 is 4 above Maya's baseline of 2; readiness 2 is 2 below her 4.
    const first = await ready("maya", { bookingId: B.mayaToday, readiness: 2, sleepQuality: 3, soreness: 6, hurt: "no" });
    expect(first.reasons.sort()).toEqual(["readiness_below_baseline", "soreness_above_baseline"]);
    const again = await ready("maya", { bookingId: B.mayaToday, readiness: 2, sleepQuality: 3, soreness: 7, hurt: "no" });
    expect(again.created).toBe(false);
    expect(again.checkin.id).toBe(first.checkin.id);
    expect(again.checkin.soreness).toBe(7);
    const rows = await db().select().from(sessionCheckins).where(eq(sessionCheckins.bookingId, B.mayaToday));
    expect(rows).toHaveLength(1);
    const alertTasks = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `checkin_review:${first.checkin.id}`)));
    expect(alertTasks).toHaveLength(1);
    // Routed to the athlete's coach; the task text carries no answer.
    expect(alertTasks[0]).toMatchObject({ title: REVIEW_TASK_TITLE, assigneeUserId: ctx.users.marcus, source: "session_checkin", priority: "high" });
    expect(`${alertTasks[0].title} ${alertTasks[0].description}`).not.toMatch(/soreness|readiness|\b7\b/i);
    const awarded = async () => (await db().select().from(xpEvents).where(and(eq(xpEvents.athleteId, ctx.athletes.maya), eq(xpEvents.sourceType, "session_checkin")))).length;
    await db().transaction((tx) => syncXp(tx, ctx.orgId, ctx.athletes.maya));
    const n = await awarded();
    expect(n).toBe((await db().select().from(sessionCheckins).where(eq(sessionCheckins.athleteId, ctx.athletes.maya))).length);
    expect(await db().transaction((tx) => syncXp(tx, ctx.orgId, ctx.athletes.maya))).toBe(0);
    expect(await awarded()).toBe(n);
  });

  it("someone with no history gets no baseline alert, however sore", async () => {
    const r = await ready("chris", { bookingId: B.avaToday, readiness: 1, sleepQuality: 1, soreness: 9, hurt: "no" });
    expect(r.reasons).toEqual([]);
    expect(r.checkin.reviewTaskId).toBeNull();
  });
});

describe("pain answers", () => {
  it("a marked spot goes to the existing body map; sharp pain uses its review task, not a second one", async () => {
    // Ava is 12; her parent Chris (health access) corrects the ready check he just sent.
    const r = await ready("chris", { bookingId: B.avaToday, readiness: 3, sleepQuality: 3, soreness: 3, hurt: "yes", spot: { view: "front", region: "knee", side: "left", type: "sharp", level: 6 } });
    expect(r.reasons).toEqual(["sharp_pain"]);
    const spots = await db().select().from(bodyRegionReports).where(eq(bodyRegionReports.sourceCheckinId, r.checkin.id));
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ athleteId: ctx.athletes.ava, region: "knee", side: "left", kind: "pain", severity: 6, reviewStatus: "new" });
    expect(spots[0].reviewTaskId).not.toBeNull();
    expect(r.checkin.reviewTaskId).toBeNull();
    // Correcting to "achy" replaces the report: the old one is closed, not left in the queue.
    await ready("chris", { bookingId: B.avaToday, readiness: 3, sleepQuality: 3, soreness: 3, hurt: "yes", spot: { view: "front", region: "knee", side: "left", type: "ache", level: 3 } });
    const all = await db().select().from(bodyRegionReports).where(eq(bodyRegionReports.sourceCheckinId, r.checkin.id));
    expect(all.map((s) => `${s.kind}:${s.reviewStatus}`).sort()).toEqual(["pain:reviewed", "soreness:reviewed"]);
    await expect(ready("chris", { bookingId: B.avaToday, ...okReady, hurt: "yes", spot: { view: "front", region: "upper_back", side: "center", type: "ache", level: 3 } })).rejects.toBeInstanceOf(UserError);
  });

  it("something hurt two sessions running creates one coach task", async () => {
    // Yesterday's after check for Dana: something hurt. Today: it still does.
    await after("dana", { bookingId: B.danaYesterday, rpe: 6, hurt: "yes", spot: { view: "back", region: "lower_back", side: "center", type: "ache", level: 3 }, hurtStartedInSession: "yes" });
    const r = await ready("dana", { bookingId: B.danaToday, ...okReady, hurt: "yes" });
    expect(r.reasons.sort()).toEqual(["hurt_no_location", "pain_two_sessions"]);
    const t = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `checkin_review:${r.checkin.id}`)));
    expect(t).toHaveLength(1);
    expect(t[0].assigneeUserId).toBe(ctx.users.marcus);
  });
});

describe("after check", () => {
  it("is closed until the booking is attended and the session has ended", async () => {
    await expect(after("maya", { bookingId: B.mayaToday, rpe: 5 }, PRE)).rejects.toBeInstanceOf(UserError);
    const t = await db().transaction(async (tx) => afterTarget(tx, await V("maya"), B.mayaToday, PRE));
    expect(t.state).toBe("not_attended");
  });

  it("the athlete's answers: sRPE feeds the existing load exactly once, the rating stays in session feedback, alerts go to the right person", async () => {
    const r = await after("maya", { bookingId: B.mayaYesterday, rpe: 7, liked: ["lifting", "my_group", "not_a_chip"], dislikedText: SECRET_DISLIKE, disliked: ["too_much_waiting"], soreness: 4, hurt: "no", rating: 2, note: "See you Wednesday" });
    expect(r.wrote).toEqual(["effort", "body", "experience"]);
    expect(r.load).toBe(420);
    expect(r.checkin).toMatchObject({ rpe: 7, durationMinutes: 60, soreness: 4, hurt: false, tellCoach: false, nothingToChange: false, dislikedText: SECRET_DISLIKE, alertReasons: ["disliked_comment"] });
    expect(r.checkin.likedChips).toEqual([{ key: "lifting", label: "Lifting" }, { key: "my_group", label: "My group" }]);
    const yesterday = addDaysYmd(TODAY, -1);
    const acts = () => db().select().from(activitySessions).where(and(eq(activitySessions.athleteId, ctx.athletes.maya), eq(activitySessions.source, "session_checkin")));
    expect(await acts()).toMatchObject([{ activityDate: yesterday, kind: "training", durationMinutes: 60, sessionRpe: 7 }]);
    // Correcting the RPE updates that row.
    const again = await after("maya", { bookingId: B.mayaYesterday, rpe: 8, liked: ["lifting"], dislikedText: SECRET_DISLIKE, soreness: 4, hurt: "no", rating: 2 });
    expect(again.checkin.id).toBe(r.checkin.id);
    expect(await acts()).toMatchObject([{ sessionRpe: 8 }]);
    const day = async () => {
      const entries = await loadEntries(db(), ctx.orgId, ctx.athletes.maya, yesterday, yesterday);
      return { entries, load: dailyLoadSeries(entries, yesterday, yesterday)[0] };
    };
    expect((await day()).load).toMatchObject({ load: 480, status: "logged", sessions: 1 });

    // Rating: one session_feedback row, with its own low-rating task for the owner.
    const fb = await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.mayaYesterday));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ rating: 2, tellCoach: false, submittedByRole: "athlete" });
    const [low] = await db().select().from(tasks).where(eq(tasks.id, fb[0].followUpTaskId!));
    expect(low).toMatchObject({ title: FOLLOW_UP_TITLE, assigneeUserId: ctx.users.rod });
    // "Did not like" comment: owner / front desk, not linked to the athlete, and the words are not in the task.
    const [dis] = await db().select().from(tasks).where(eq(tasks.dedupeKey, `checkin_dislike:${r.checkin.id}`));
    expect(dis).toMatchObject({ title: DISLIKE_TASK_TITLE, assigneeUserId: ctx.users.rod, relatedPersonId: null });
    expect(JSON.stringify(dis)).not.toContain("standing around");
    expect(again.checkin.reviewTaskId).toBeNull();

    // No double counting with the workout logger: a workout with its own load wins for that day...
    const [wo] = await db().insert(workouts).values({ orgId: ctx.orgId, athleteId: ctx.athletes.maya, title: "Lower A", scheduledDate: yesterday, status: "completed", completedAt: new Date("2026-10-11T21:50:00Z"), durationMinutes: 50, sessionRpe: 6 }).returning();
    let d = await day();
    expect(d.entries.map((e) => e.source)).toEqual(["workout"]);
    expect(d.load).toMatchObject({ load: 300, sessions: 1 });
    // ...and a workout finished without an RPE leaves the check-in's number standing (never "incomplete", never both).
    await db().update(workouts).set({ sessionRpe: null }).where(eq(workouts.id, wo.id));
    d = await day();
    expect(d.entries.map((e) => e.source)).toEqual(["activity"]);
    expect(d.load).toMatchObject({ load: 480, status: "logged", sessions: 1 });
    await db().delete(workouts).where(eq(workouts.id, wo.id));
  });

  it("a parent without health access answers effort and experience for an under-13, never the body questions", async () => {
    const t = await db().transaction(async (tx) => afterTarget(tx, await V("jordan"), B.eliYesterday, MORNING));
    expect(t.sections).toEqual({ effort: "open", body: "not_allowed", experience: "open" });
    const r = await after("jordan", { bookingId: B.eliYesterday, rpe: 5, soreness: 8, hurt: "yes", liked: ["jumps"], nothingToChange: "on", rating: 5, tellCoach: "on" });
    expect(r.wrote).toEqual(["effort", "experience"]);
    expect(r.checkin).toMatchObject({ rpe: 5, soreness: null, hurt: null, loggedByParent: true, nothingToChange: true, tellCoach: true });
    // The other parent, who has health access, completes the body section later; Jordan's answers stay.
    const alexT = await db().transaction(async (tx) => afterTarget(tx, await V("alex"), B.eliYesterday, MORNING));
    expect(alexT.sections).toEqual({ effort: "locked", body: "open", experience: "locked" });
    expect(alexT.rating).toBe("locked");
    const r2 = await after("alex", { bookingId: B.eliYesterday, rpe: 9, soreness: 3, hurt: "no", rating: 1 });
    expect(r2.wrote).toEqual(["body"]);
    expect(r2.checkin).toMatchObject({ rpe: 5, soreness: 3, hurt: false });
    expect(Object.keys(r2.checkin.answeredBy).sort()).toEqual(["body", "effort", "experience"]);
    expect((await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.eliYesterday)))[0].rating).toBe(5);
    // What Jordan gets back never includes the body answers Alex gave.
    const back = await db().transaction(async (tx) => afterTarget(tx, await V("jordan"), B.eliYesterday, MORNING));
    expect(back.existing).toMatchObject({ rpe: 5, soreness: null, hurt: null });
  });

  it("a parent of an older athlete can leave the experience answers only; one who cannot book can leave nothing", async () => {
    const t = await db().transaction(async (tx) => afterTarget(tx, await V("sam"), B.leoYesterday, MORNING));
    expect(t.sections).toEqual({ effort: "not_allowed", body: "not_allowed", experience: "open" });
    const r = await after("sam", { bookingId: B.leoYesterday, rpe: 9, rating: 4, liked: ["my_coach"] });
    expect(r.wrote).toEqual(["experience"]);
    expect(r.checkin.rpe).toBeNull();
    expect(await db().select().from(activitySessions).where(and(eq(activitySessions.athleteId, ctx.athletes.leo), eq(activitySessions.source, "session_checkin")))).toHaveLength(0);
    const casey = await db().transaction(async (tx) => afterTarget(tx, await V("casey"), B.leoYesterday, MORNING));
    expect(casey.state).toBe("nothing_open");
    await expect(after("casey", { bookingId: B.leoYesterday, rating: 1 })).rejects.toBeInstanceOf(UserError);
    for (const k of ["rod", "erin", "marcus", "kiosk", "chris"]) await expect(after(k, { bookingId: B.leoYesterday, rpe: 5 })).rejects.toBeInstanceOf(AuthzError);
  });

  it("effort and body close after the configured hours; the rating stays open for the feedback window, and the old feedback path still works", async () => {
    const late = new Date("2026-10-14T23:00:00Z"); // 49 hours after yesterday's class ended
    const t = await db().transaction(async (tx) => afterTarget(tx, await V("chris"), B.avaYesterday, late));
    expect(t.sections).toEqual({ effort: "closed", body: "closed", experience: "open" });
    // A rating left through the old function shows up as this check-in's rating.
    await db().transaction(async (tx) => submitFeedback(tx, await V("chris"), { bookingId: B.avaYesterday, rating: 4 }, late));
    const t2 = await db().transaction(async (tx) => afterTarget(tx, await V("chris"), B.avaYesterday, late));
    expect(t2.rating).toBe("editable");
    expect(t2.feedback).toMatchObject({ rating: 4, mine: true });
    const r = await after("chris", { bookingId: B.avaYesterday, rpe: 6, rating: 5, liked: ["it_was_fun"] }, late);
    expect(r.wrote).toEqual(["experience"]);
    expect((await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.avaYesterday))).map((f) => f.rating)).toEqual([5]);
  });
});

describe("who sees what", () => {
  it("coach strip: health details only inside the viewer's health scope; others get 'has a note'", async () => {
    const session = S.mayaToday;
    const by = async (k: string) => {
      const r = await db().transaction(async (tx) => sessionReadiness(tx, await V(k), session));
      return { r, row: (a: string) => r!.rows.find((x) => x.athleteId === ctx.athletes[a])! };
    };
    const marcus = await by("marcus");
    expect(marcus.r).toMatchObject({ booked: 5, answered: 4, canSetIntended: true, anyHealth: true });
    expect(marcus.row("maya").health).toMatchObject({ readiness: 2, soreness: 7, reasons: ["soreness_above_baseline", "readiness_below_baseline"], via: "app" });
    expect(marcus.row("maya").health!.sorenessBaseline).toMatchObject({ mean: 2, n: 6 });
    expect(marcus.row("leo")).toMatchObject({ done: false, hasNote: false, health: null });
    // Eli and Ava are Coach Tess's athletes: Marcus runs the class but has no health access to them.
    expect(marcus.row("eli")).toMatchObject({ done: true, hasNote: true, health: null });
    expect(JSON.stringify(marcus.r)).not.toContain(SECRET_NOTE);
    const erin = await by("erin");
    expect(erin.r!.anyHealth).toBe(false);
    expect(erin.r!.rows.every((x) => x.health === null)).toBe(true);
    expect(erin.row("eli").hasNote).toBe(true);
    expect(JSON.stringify(erin.r)).not.toMatch(/ankle|"soreness"/);
    const tess = await by("tess");
    expect(tess.row("eli").health).toMatchObject({ note: SECRET_NOTE, via: "parent" });
    expect(tess.row("ava").health!.spot).toMatchObject({ label: "Left knee", kind: "ache", severity: 3 });
    expect(tess.row("maya").health).toBeNull();
    expect(tess.r!.canSetIntended).toBe(false);
    const rod = await by("rod");
    expect(rod.r!.rows.filter((x) => x.done).every((x) => x.health !== null)).toBe(true);
    for (const k of ["alex", "maya", "kiosk"]) expect(await db().transaction(async (tx) => sessionReadiness(tx, await V(k), session))).toBeNull();
  });

  it("athlete trends: health values only with health access; a coach sees a rating only when it was shared", async () => {
    const trends = async (k: string, athlete: string) => db().transaction(async (tx) => athleteCheckinTrends(tx, await V(k), ctx.athletes[athlete], { now: new Date("2026-10-12T23:00:00Z") }));
    const jordan = await trends("jordan", "eli");
    expect(jordan.access).toEqual({ any: true, health: false, effort: true, experience: "all" });
    const jp = jordan.points.find((p) => p.bookingId === B.eliYesterday)!;
    expect(jp).toMatchObject({ rpe: 5, load: 300, rating: 5, soreness: null, sorenessAfter: null, hurt: null, readiness: null, spots: [] });
    expect(jp.liked).toEqual([{ key: "jumps", label: "Jumps" }]);
    expect(jordan.painBySpot).toEqual([]);
    const alex = await trends("alex", "eli");
    expect(alex.points.find((p) => p.bookingId === B.eliYesterday)).toMatchObject({ sorenessAfter: 3, hurt: false, rpe: 5 });
    // Maya did not tick "show my coach": Marcus gets her effort and health trend but not her rating or likes.
    const marcus = await trends("marcus", "maya");
    const mp = marcus.points.find((p) => p.bookingId === B.mayaYesterday)!;
    expect(marcus.access.experience).toBe("shared");
    expect(mp).toMatchObject({ rpe: 8, load: 480, sorenessAfter: 4, rating: null, liked: [] });
    expect(marcus.baselines!.soreness.mean).not.toBeNull();
    // Front desk: no health, every experience answer.
    const erin = await trends("erin", "maya");
    expect(erin.access).toMatchObject({ health: false, experience: "all" });
    expect(erin.points.find((p) => p.bookingId === B.mayaYesterday)).toMatchObject({ rating: 2, sorenessAfter: null, readiness: null });
    expect(erin.baselines!.soreness).toMatchObject({ mean: null, n: 0 });
    // Not enough data yet is explicit.
    const dana = await trends("dana", "dana");
    expect(dana.baselines!.readiness).toMatchObject({ mean: null, needed: 5 });
    expect(dana.painBySpot).toEqual([{ label: "Lower back", count: 1, sharp: 0, lastDate: addDaysYmd(TODAY, -1) }]);
    for (const [k, a] of [["tess", "maya"], ["chris", "eli"], ["marcus", "eli"], ["kiosk", "maya"], ["maya", "eli"]]) await expect(trends(k, a)).rejects.toBeInstanceOf(AuthzError);
  });

  it("one response: operations never gets health; a coach never gets an unshared comment", async () => {
    const [mayaPost] = await db().select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, B.mayaYesterday), eq(sessionCheckins.phase, "post")));
    const detail = async (k: string, id: string) => db().transaction(async (tx) => checkinDetail(tx, await V(k), id));
    const erin = await detail("erin", mayaPost.id);
    expect(erin.health).toBeNull();
    expect(erin.experience).toMatchObject({ dislikedText: SECRET_DISLIKE, rating: 2 });
    const marcus = await detail("marcus", mayaPost.id);
    expect(marcus.experience).toBeNull();
    expect(marcus.health).toMatchObject({ soreness: 4, hurt: false });
    expect(JSON.stringify(marcus)).not.toContain("standing around");
    await expect(detail("tess", mayaPost.id)).rejects.toBeInstanceOf(AuthzError);
    await expect(detail("alex", mayaPost.id)).rejects.toBeInstanceOf(AuthzError);
    // Eli's was shared with the coach by Jordan, and Marcus ran that class.
    const [eliPost] = await db().select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, B.eliYesterday), eq(sessionCheckins.phase, "post")));
    const shared = await detail("marcus", eliPost.id);
    expect(shared.experience).toMatchObject({ rating: 5, nothingToChange: true });
    expect(shared.health).toBeNull();
  });

  it("alerts for the follow-ups page go to the right people, and reviewing closes the task", async () => {
    const alerts = async (k: string) => db().transaction(async (tx) => openCheckinAlerts(tx, await V(k)));
    const marcus = await alerts("marcus");
    expect(marcus.every((a) => a.kind === "training")).toBe(true);
    expect(marcus.map((a) => a.athleteName).sort()).toEqual(["Dana Brooks", "Maya Parker"]);
    const erin = await alerts("erin");
    expect(erin.map((a) => a.kind)).toEqual(["experience"]);
    expect(await alerts("tess")).toEqual([]);
    expect(await alerts("alex")).toEqual([]);
    expect((await alerts("rod")).length).toBe(3);
    const maya = marcus.find((a) => a.athleteName === "Maya Parker")!;
    await expect(db().transaction(async (tx) => reviewCheckin(tx, await V("erin"), maya.checkinId))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction(async (tx) => reviewCheckin(tx, await V("marcus"), maya.checkinId));
    expect((await db().select().from(tasks).where(eq(tasks.id, maya.taskId)))[0]).toMatchObject({ status: "done", completedBy: ctx.users.marcus });
    expect((await alerts("marcus")).map((a) => a.athleteName)).toEqual(["Dana Brooks"]);
  });

  it("family home list offers only what that person may answer", async () => {
    const list = async (k: string, now: Date) => (await db().transaction(async (tx) => pendingCheckins(tx, await V(k), now))).map((p) => `${p.kind}:${p.athleteFirst}:${p.state}`);
    // Jordan (no health access): never a ready check. Leo has not done his after check.
    expect((await list("jordan", PRE)).filter((x) => x.startsWith("ready"))).toEqual([]);
    // Maya finished yesterday's after check (still correctable) and has not done Saturday's.
    expect(await list("maya", MORNING)).toEqual(expect.arrayContaining(["after:Maya:open", "after:Maya:editable"]));
    expect(await list("rod", PRE)).toEqual([]);
    expect(await list("kiosk", PRE)).toEqual([]);
  });
});

describe("class view, planned intensity and the owner report", () => {
  it("planned RPE is set by the session's coach or a schedule manager only", async () => {
    const set = async (k: string, n: number | null) => db().transaction(async (tx) => setIntendedRpe(tx, await V(k), { sessionId: S.mayaYesterday, intendedRpe: n }));
    await expect(set("tess", 5)).rejects.toBeInstanceOf(AuthzError);
    await expect(set("alex", 5)).rejects.toBeInstanceOf(AuthzError);
    await expect(set("marcus", 11)).rejects.toBeInstanceOf(UserError);
    await set("marcus", 5);
    expect((await db().select().from(scheduleSessions).where(eq(scheduleSessions.id, S.mayaYesterday)))[0].intendedRpe).toBe(5);
  });

  it("coach sees own classes with totals; comments only when shared; reviewers see all", async () => {
    const range = { from: addDaysYmd(TODAY, -1), to: addDaysYmd(TODAY, -1), tz: ctx.tz };
    const marcus = await db().transaction(async (tx) => classInsightsFor(tx, await V("marcus"), range));
    expect(marcus).toHaveLength(1);
    // Reported RPE: Maya 8, Eli 5, Dana 6 (Leo and Ava gave none) = 6.3 against a planned 5.
    expect(marcus[0]).toMatchObject({ title: "Test Class", sessions: 1, attended: 5, after: 5, afterRate: 1, meanRpe: 6.3, intendedRpe: 5, gap: 1.3, gapSessions: 1 });
    expect(marcus[0].liked.find((c) => c.key === "lifting")).toMatchObject({ count: 1 });
    expect(JSON.stringify(marcus)).not.toContain("standing around");
    const rod = await db().transaction(async (tx) => classInsightsFor(tx, await V("rod"), range));
    expect(rod[0].comments).toEqual([expect.objectContaining({ kind: "disliked", text: SECRET_DISLIKE, athleteName: "Maya Parker" })]);
    expect(await db().transaction(async (tx) => classInsightsFor(tx, await V("tess"), range))).toEqual([]);
    await expect(db().transaction(async (tx) => classInsightsFor(tx, await V("alex"), range))).rejects.toBeInstanceOf(AuthzError);
  });

  it("report: completion and themes by coach and class slot, no names or comments", async () => {
    const def = reportByKey("session-checkins")!;
    expect(def.cap).toBe("feedback.report");
    const range = { from: addDaysYmd(TODAY, -1), to: TODAY, tz: ctx.tz };
    const res = await def.run(db(), ctx.orgId, { ...range, viewer: { userId: ctx.users.rod, role: "owner" } });
    const coach = res.rows.find((r) => r.section === "Coach" && r.name === "Coach Marcus Reed") ?? res.rows.find((r) => r.section === "Coach");
    expect(coach).toMatchObject({ attended: 5, after: 5, after_rate: 1, ready: 0, ready_rate: 0 });
    expect(res.rows.some((r) => r.section === "Class slot" && String(r.name).includes("Test Class · Sun"))).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/Maya|standing around|ankle/);
    const sum = await checkinCompletionSummary(db(), ctx.orgId, range);
    expect(sum).toMatchObject({ attended: 5, after: 5, afterRate: 1 });
    const tess = await def.run(db(), ctx.orgId, { ...range, viewer: { userId: ctx.users.tess, role: "coach" } });
    expect(tess.rows).toEqual([]);
    // Nothing attended in range: rates are null, not 0.
    expect(await checkinCompletionSummary(db(), ctx.orgId, { from: "2025-01-01", to: "2025-01-02", tz: ctx.tz })).toMatchObject({ attended: 0, readyRate: null, afterRate: null });
  });
});

describe("kiosk", () => {
  const key = "kiosk-session-1";
  it("a PIN check-in yields a single-use pass that only writes the ready check and reads nothing back", async () => {
    const kiosk = await V("kiosk");
    // Sofia is booked for tonight's class and has not done a ready check.
    const r0 = await w.booking(ctx.athletes.sofia, 0, "booked");
    await db().transaction(async (tx) => setCheckInPin(tx, await V("rod"), { athleteId: ctx.athletes.sofia, pin: "7391" }));
    const now = new Date("2026-10-12T20:45:00Z");
    const res = await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "7391", sessionKey: key, now }));
    expect(res.ok).toBe(true);
    await expect(db().transaction(async (tx) => issueKioskReadyPass(tx, await V("alex"), { pin: "7391", now }))).rejects.toBeInstanceOf(AuthzError);
    expect(await db().transaction((tx) => issueKioskReadyPass(tx, kiosk, { pin: "0000", now }))).toBeNull();
    const pass = await db().transaction((tx) => issueKioskReadyPass(tx, kiosk, { pin: "7391", now }));
    expect(Object.keys(pass!).sort()).toEqual(["expiresInSeconds", "sessionTitle", "token"]);
    const [stored] = await db().select().from(checkinKioskPasses).where(eq(checkinKioskPasses.bookingId, r0.booking.id));
    expect(stored.tokenHash).not.toBe(pass!.token);
    await expect(db().transaction((tx) => submitKioskReady(tx, kiosk, { token: "x".repeat(32), readiness: 3, soreness: 2 }, now))).rejects.toBeInstanceOf(UserError);
    const out = await db().transaction((tx) => submitKioskReady(tx, kiosk, { token: pass!.token, readiness: 5, sleepQuality: 4, soreness: 1, hurt: "yes" }, now));
    expect(out).toEqual({ created: true, hurt: true });
    const [row] = await db().select().from(sessionCheckins).where(eq(sessionCheckins.bookingId, r0.booking.id));
    expect(row).toMatchObject({ phase: "pre", source: "kiosk", readiness: 5, soreness: 1, hurt: true, note: null, loggedByParent: false, alertReasons: ["hurt_no_location"] });
    expect(row.answeredBy.ready).toMatchObject({ userId: null, role: "kiosk" });
    // Used once; and no second pass once the ready check exists.
    await expect(db().transaction((tx) => submitKioskReady(tx, kiosk, { token: pass!.token, readiness: 1, soreness: 9 }, now))).rejects.toBeInstanceOf(UserError);
    expect(await db().transaction((tx) => issueKioskReadyPass(tx, kiosk, { pin: "7391", now }))).toBeNull();
  });

  it("a pass expires, and no pass is issued when the kiosk offer is off", async () => {
    const kiosk = await V("kiosk");
    await w.booking(ctx.athletes.liam, 0, "booked");
    await db().transaction(async (tx) => setCheckInPin(tx, await V("rod"), { athleteId: ctx.athletes.liam, pin: "8264" }));
    const now = new Date("2026-10-12T20:50:00Z");
    await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "8264", sessionKey: key, now }));
    const pass = await db().transaction((tx) => issueKioskReadyPass(tx, kiosk, { pin: "8264", now }));
    await expect(db().transaction((tx) => submitKioskReady(tx, kiosk, { token: pass!.token, readiness: 3, soreness: 2 }, new Date(now.getTime() + 4 * 60_000)))).rejects.toBeInstanceOf(UserError);
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db().update(organizations).set({ settings: { ...org.settings, checkins: { kioskOffer: false } } }).where(eq(organizations.id, ctx.orgId));
    expect(await db().transaction((tx) => issueKioskReadyPass(tx, kiosk, { pin: "8264", now }))).toBeNull();
    await db().update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ctx.orgId));
  });
});

describe("settings", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    preEnabled: "on", postEnabled: "on", kioskOffer: "on", askSleepHours: "on", askFatigue: "on", askMood: "on", askPriorSoreness: "on",
    preOpensHoursBefore: "4", postClosesHoursAfter: "48", bodyMapSorenessAt: "6", baselineMinAnswers: "5", baselineWindowDays: "42", sorenessAboveBaseline: "3", readinessBelowBaseline: "1.5",
    likedChips: DEFAULT_CHECKIN_SETTINGS.likedChips.map((c) => c.label).join("\n"),
    dislikedChips: DEFAULT_CHECKIN_SETTINGS.dislikedChips.map((c) => c.label).join("\n"),
    ...over,
  });
  it("owner and admin only; chip edits bump the question-set version, window edits do not; old answers keep their labels", async () => {
    const save = async (k: string, over = {}) => db().transaction(async (tx) => saveCheckinSettings(tx, await V(k), form(over)));
    for (const k of ["erin", "marcus", "alex", "kiosk"]) await expect(save(k)).rejects.toBeInstanceOf(AuthzError);
    expect((await save("rod", { preOpensHoursBefore: "6" })).revision).toBe(1);
    await expect(save("rod", { preOpensHoursBefore: "0" })).rejects.toMatchObject({ fieldErrors: { preOpensHoursBefore: expect.any(String) } });
    const s = await save("rod", { likedChips: "Sled pushes\nMy coach", preEnabled: undefined, preOpensHoursBefore: "6" });
    expect(s).toMatchObject({ revision: 2, preEnabled: false, preOpensHoursBefore: 6 });
    expect(s.likedChips).toEqual([{ key: "sled_pushes", label: "Sled pushes" }, { key: "my_coach", label: "My coach" }]);
    expect(await checkinSettings(db(), ctx.orgId)).toMatchObject({ revision: 2 });
    // Ready checks are off now.
    await expect(ready("maya", { bookingId: B.mayaToday, ...okReady })).rejects.toBeInstanceOf(UserError);
    // Maya's earlier "Lifting" chip is no longer offered but stays on her answer.
    const [mayaPost] = await db().select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, B.mayaYesterday), eq(sessionCheckins.phase, "post")));
    expect(mayaPost.likedChips).toEqual([{ key: "lifting", label: "Lifting" }]);
    expect(mayaPost.questionSetVersion).toBe("1.1");
    const r = await after("dana", { bookingId: B.danaYesterday, rpe: 6, liked: ["sled_pushes", "lifting"] });
    expect(r.checkin.questionSetVersion).toBe("1.2");
    expect(r.checkin.likedChips).toEqual([{ key: "sled_pushes", label: "Sled pushes" }]);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "org.checkin_settings_update")));
    expect(audits.length).toBe(2);
  });

  it("every org's rows stay in their org", async () => {
    const other = await seedOrg(TODAY, { modules: [] });
    const stranger = await viewerFor(other, "rod");
    const [anyCheck] = await db().select().from(sessionCheckins).where(eq(sessionCheckins.orgId, ctx.orgId)).limit(1);
    await expect(db().transaction((tx) => checkinDetail(tx, stranger, anyCheck.id))).rejects.toBeInstanceOf(AuthzError);
    expect(await db().transaction((tx) => sessionReadiness(tx, stranger, S.mayaToday))).toBeNull();
    await expect(db().transaction((tx) => athleteCheckinTrends(tx, stranger, ctx.athletes.maya))).rejects.toBeInstanceOf(AuthzError);
    expect(await db().select().from(bookings).where(and(eq(bookings.orgId, other.orgId), inArray(bookings.id, Object.values(B))))).toEqual([]);
  });
});
