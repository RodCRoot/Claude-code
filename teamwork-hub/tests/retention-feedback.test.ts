import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, jobs, organizations, sessionFeedback, tasks } from "@/db/schema";
import { AuthzError, can } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { EDIT_WINDOW_MS, feedbackDetail, feedbackTarget, FOLLOW_UP_TITLE, pendingFeedback, sessionFeedbackSummary, submitFeedback } from "@/lib/retention/feedback";
import { reportByKey } from "@/lib/reports";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

/**
 * Session feedback: who may leave it, one response per booking, the 24-hour edit window, coach
 * anonymity, and the low-rating follow-up task. Core-only org; "today" is Monday 2026-10-12.
 */
const TODAY = "2026-10-12";
const NOW = new Date("2026-10-12T16:00:00Z"); // Monday noon in Bloomington
const SECRET = "The coach ignored her all hour";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let w: Awaited<ReturnType<typeof retentionWorld>>;
const db = () => testDb();
const submit = async (userKey: string, input: Record<string, unknown>, now = NOW) => db().transaction(async (tx) => submitFeedback(tx, await viewerFor(ctx, userKey), input, now));
const B: Record<string, string> = {};
let sessionA = "";

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  w = await retentionWorld(ctx, TODAY);
  const A = ctx.athletes;
  // Session A (3 days ago, Coach Marcus): Maya, Leo, Dana, Eli, Ethan attended; Zoe was a no-show.
  for (const k of ["maya", "leo", "dana", "eli", "ethan"]) {
    const r = await w.booking(A[k], -3, "attended");
    B[k] = r.booking.id;
    sessionA = r.session.id;
  }
  B.zoeNoShow = (await w.booking(A.zoe, -3, "no_show")).booking.id;
  // Other bookings for state checks.
  B.mayaOld = (await w.booking(A.maya, -30, "attended")).booking.id; // outside the 14-day entry window
  B.mayaFuture = (await w.booking(A.maya, 2, "booked")).booking.id;
  B.mayaTonight = (await w.booking(A.maya, 0, "attended")).booking.id; // checked in, session not over at NOW
  B.mayaYesterday = (await w.booking(A.maya, -1, "attended")).booking.id;
  B.leoTess = (await w.booking(A.leo, -2, "attended", { coach: "tess", title: "Tess Class" })).booking.id;
});

afterAll(closeTestDb);

describe("who may leave feedback", () => {
  it("a guardian who may book for the athlete can; the response records who left it", async () => {
    const fb = await submit("alex", { bookingId: B.maya, rating: 5, comment: "  Great session  ", tellCoach: true });
    expect(fb).toMatchObject({ rating: 5, comment: "Great session", tellCoach: true, submittedByRole: "guardian", athleteId: ctx.athletes.maya, sessionId: sessionA, orgId: ctx.orgId, followUpTaskId: null });
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityType, "session_feedback"), eq(auditEvents.entityId, fb.id)));
    expect(a.action).toBe("feedback.submit");
    expect(JSON.stringify(a)).not.toContain("Great session");
  });

  it("an athlete can for their own booking only", async () => {
    const fb = await submit("maya", { bookingId: B.mayaYesterday, rating: 4 });
    expect(fb).toMatchObject({ rating: 4, submittedByRole: "athlete", comment: null, tellCoach: false });
    await expect(submit("maya", { bookingId: B.eli, rating: 4 })).rejects.toBeInstanceOf(AuthzError);
    await expect(submit("dana", { bookingId: B.leo, rating: 4 })).rejects.toBeInstanceOf(AuthzError);
  });

  it("a guardian without booking permission, an unrelated guardian, staff and the kiosk cannot", async () => {
    await expect(submit("casey", { bookingId: B.leo, rating: 3 })).rejects.toBeInstanceOf(AuthzError); // Leo's co-parent: can_book = false
    await expect(submit("chris", { bookingId: B.leo, rating: 3 })).rejects.toBeInstanceOf(AuthzError); // unrelated family
    for (const k of ["rod", "erin", "marcus", "kiosk"]) await expect(submit(k, { bookingId: B.leo, rating: 3 })).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction(async (tx) => feedbackTarget(tx, await viewerFor(ctx, "chris"), B.leo, NOW))).rejects.toBeInstanceOf(AuthzError);
  });

  it("a booking in another organization looks exactly like one that does not exist", async () => {
    const other = await seedOrg(TODAY, { modules: [] });
    const alexElsewhere = await viewerFor(other, "alex");
    await expect(db().transaction((tx) => submitFeedback(tx, alexElsewhere, { bookingId: B.eli, rating: 5 }, NOW))).rejects.toBeInstanceOf(AuthzError);
    await expect(submit("alex", { bookingId: "00000000-0000-4000-8000-000000000000", rating: 5 })).rejects.toBeInstanceOf(AuthzError);
  });

  it("only after an attended session that has ended, and within the entry window", async () => {
    await expect(submit("alex", { bookingId: B.mayaFuture, rating: 5 })).rejects.toThrow(/after an attended session/);
    await expect(submit("alex", { bookingId: B.mayaTonight, rating: 5 })).rejects.toThrow(/when the session ends/);
    await expect(submit("alex", { bookingId: B.mayaOld, rating: 5 })).rejects.toThrow(/window for this session has closed/);
    const sam = await viewerFor(ctx, "sam");
    expect((await feedbackTarget(db(), sam, B.leo, NOW)).state).toBe("open");
    await expect(submit("alex", { bookingId: B.eli, rating: 0 })).rejects.toThrow();
    await expect(submit("alex", { bookingId: B.eli, rating: 6 })).rejects.toThrow();
    await expect(submit("alex", { bookingId: B.eli, rating: 2.5 })).rejects.toThrow();
  });
});

describe("one response per booking, editable for 24 hours", () => {
  it("the same person can change it within 24 hours; nobody can after", async () => {
    const first = await submit("alex", { bookingId: B.eli, rating: 4, comment: "Good" });
    const later = new Date(NOW.getTime() + EDIT_WINDOW_MS - 60_000);
    const edited = await submit("alex", { bookingId: B.eli, rating: 3, comment: "Good, but crowded", tellCoach: true }, later);
    expect(edited.id).toBe(first.id);
    expect(edited).toMatchObject({ rating: 3, comment: "Good, but crowded", tellCoach: true });
    expect(await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.eli))).toHaveLength(1);
    const tooLate = new Date(NOW.getTime() + EDIT_WINDOW_MS + 60_000);
    await expect(submit("alex", { bookingId: B.eli, rating: 5 }, tooLate)).rejects.toBeInstanceOf(UserError);
    expect((await feedbackTarget(db(), await viewerFor(ctx, "alex"), B.eli, tooLate)).state).toBe("locked");
    const [row] = await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.eli));
    expect(row.rating).toBe(3);
  });

  it("the other parent cannot add a second response or change the first", async () => {
    // Jordan may also book for Eli, but Alex already answered for this booking.
    await expect(submit("jordan", { bookingId: B.eli, rating: 1 })).rejects.toThrow(/already left/);
    expect((await feedbackTarget(db(), await viewerFor(ctx, "jordan"), B.eli, NOW)).state).toBe("locked");
  });

  it("the database enforces uniqueness and the 1–5 range on its own", async () => {
    const [row] = await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.eli));
    const dup = { orgId: ctx.orgId, bookingId: B.eli, sessionId: row.sessionId, athleteId: row.athleteId, rating: 5, submittedByUserId: ctx.users.jordan, submittedByRole: "guardian" as const };
    await expect(db().insert(sessionFeedback).values(dup)).rejects.toThrow();
    await expect(db().insert(sessionFeedback).values({ ...dup, bookingId: B.ethan, rating: 7 })).rejects.toThrow();
  });

  it("the family card lists recent attended sessions with their state", async () => {
    const alex = await pendingFeedback(db(), await viewerFor(ctx, "alex"), NOW, 20);
    const state = (id: string) => alex.find((x) => x.bookingId === id)?.state;
    expect(state(B.eli)).toBe("editable");
    expect(state(B.mayaYesterday)).toBe("locked"); // Maya answered herself
    expect(alex.map((x) => x.bookingId)).not.toContain(B.mayaOld);
    expect(alex.map((x) => x.bookingId)).not.toContain(B.mayaTonight);
    expect(alex.map((x) => x.bookingId)).not.toContain(B.leo);
    // Casey cannot book for Leo, so nothing is offered; staff get nothing.
    expect(await pendingFeedback(db(), await viewerFor(ctx, "casey"), NOW)).toEqual([]);
    expect(await pendingFeedback(db(), await viewerFor(ctx, "rod"), NOW)).toEqual([]);
    expect((await pendingFeedback(db(), await viewerFor(ctx, "sam"), NOW)).map((x) => x.bookingId).sort()).toEqual([B.leo, B.leoTess].sort());
  });
});

describe("low rating → staff follow-up task that does not leak the comment", () => {
  it("creates one task, titled generically, not linked to the athlete unless 'tell my coach' was ticked", async () => {
    const fb = await submit("sam", { bookingId: B.leo, rating: 2, comment: SECRET });
    expect(fb.followUpTaskId).not.toBeNull();
    const [t] = await db().select().from(tasks).where(eq(tasks.id, fb.followUpTaskId!));
    expect(t).toMatchObject({ title: FOLLOW_UP_TITLE, source: "session_feedback", priority: "high", status: "open", relatedType: "session_feedback", relatedId: fb.id, relatedPersonId: null, assigneeUserId: ctx.users.rod });
    expect(`${t.title} ${t.description}`).not.toContain(SECRET);
    expect(`${t.title} ${t.description}`).not.toMatch(/Leo|Rivera/);
    expect(t.description).toContain(`/people/retention/feedback/${fb.id}`);
    // Editing (still low) does not create a second task.
    const again = await submit("sam", { bookingId: B.leo, rating: 1, comment: SECRET }, new Date(NOW.getTime() + 3_600_000));
    expect(again.followUpTaskId).toBe(fb.followUpTaskId);
    expect(await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "session_feedback")))).toHaveLength(1);
  });

  it("with 'tell my coach' the task goes to the session's coach and links the athlete", async () => {
    const fb = await submit("sam", { bookingId: B.leoTess, rating: 2, comment: "Please check in with Leo", tellCoach: true });
    const [t] = await db().select().from(tasks).where(eq(tasks.id, fb.followUpTaskId!));
    expect(t).toMatchObject({ title: FOLLOW_UP_TITLE, assigneeUserId: ctx.users.tess, relatedPersonId: ctx.people.leo_rivera });
    expect(`${t.title} ${t.description}`).not.toContain("Please check in");
  });

  it("ratings above the threshold create nothing, and the threshold is a setting", async () => {
    const before = (await db().select().from(tasks).where(eq(tasks.orgId, ctx.orgId))).length;
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const ok = await submit("dana", { bookingId: B.dana, rating: 3, comment: "Fine" });
    expect(ok.followUpTaskId).toBeNull();
    expect((await db().select().from(tasks).where(eq(tasks.orgId, ctx.orgId))).length).toBe(before);
    await db().update(organizations).set({ settings: { ...org.settings, retention: { lowRatingThreshold: 3, negativeCommentMaxRating: 3 } } }).where(eq(organizations.id, ctx.orgId));
    try {
      const edited = await submit("dana", { bookingId: B.dana, rating: 3, comment: "Fine" }, new Date(NOW.getTime() + 60_000));
      expect(edited.followUpTaskId).not.toBeNull();
    } finally {
      await db().update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ctx.orgId));
    }
  });

  it("sends nothing: no messages and no outbound jobs exist", async () => {
    const m = await db().execute(sql`select count(*)::int as n from messages m join threads t on t.id = m.thread_id where t.org_id = ${ctx.orgId}`);
    expect(m.rows[0].n).toBe(0);
    expect(await db().select().from(jobs).where(eq(jobs.orgId, ctx.orgId))).toEqual([]);
  });
});

describe("anonymity: coaches see averages, never who said what unless 'tell my coach'", () => {
  // Session A now has: Maya 5 (shared), Eli 3 (shared after edit), Leo 1 (NOT shared), Dana 3 (NOT shared).
  it("owner / admin / operations see the average and every response", async () => {
    for (const k of ["rod", "erin"]) {
      const s = await sessionFeedbackSummary(db(), await viewerFor(ctx, k), sessionA);
      expect(s).toMatchObject({ count: 4, average: 3, hiddenForAnonymity: false });
      expect(s!.responses.map((r) => r.athleteName).sort()).toEqual(["Dana Brooks", "Eli Parker", "Leo Rivera", "Maya Parker"]);
    }
  });

  it("the session's coach sees the average and only the shared responses", async () => {
    const s = await sessionFeedbackSummary(db(), await viewerFor(ctx, "marcus"), sessionA);
    expect(s).toMatchObject({ count: 4, average: 3 });
    expect(s!.responses.map((r) => r.athleteName).sort()).toEqual(["Eli Parker", "Maya Parker"]);
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("below the minimum number of responses the coach gets no average at all", async () => {
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db().update(organizations).set({ settings: { ...org.settings, retention: { anonymityMinResponses: 5 } } }).where(eq(organizations.id, ctx.orgId));
    try {
      const s = await sessionFeedbackSummary(db(), await viewerFor(ctx, "marcus"), sessionA);
      expect(s).toMatchObject({ count: 4, average: null, hiddenForAnonymity: true, minResponses: 5 });
      expect((await sessionFeedbackSummary(db(), await viewerFor(ctx, "rod"), sessionA))!.average).toBe(3);
    } finally {
      await db().update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ctx.orgId));
    }
  });

  it("another coach and non-staff get nothing for the session", async () => {
    for (const k of ["tess", "alex", "maya", "kiosk"]) expect(await sessionFeedbackSummary(db(), await viewerFor(ctx, k), sessionA)).toBeNull();
  });

  it("opening one response: reviewers always; a coach only when it was shared with them", async () => {
    const [leo] = await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.leo));
    const [maya] = await db().select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, B.maya));
    expect((await feedbackDetail(db(), await viewerFor(ctx, "rod"), leo.id)).comment).toBe(SECRET);
    expect((await feedbackDetail(db(), await viewerFor(ctx, "erin"), leo.id)).athleteName).toBe("Leo Rivera");
    await expect(feedbackDetail(db(), await viewerFor(ctx, "marcus"), leo.id)).rejects.toBeInstanceOf(AuthzError); // his session, his athlete, but not shared
    expect((await feedbackDetail(db(), await viewerFor(ctx, "marcus"), maya.id)).comment).toBe("Great session");
    await expect(feedbackDetail(db(), await viewerFor(ctx, "tess"), maya.id)).rejects.toBeInstanceOf(AuthzError); // shared, but not her session or athlete
    for (const k of ["alex", "sam", "maya"]) await expect(feedbackDetail(db(), await viewerFor(ctx, k), leo.id)).rejects.toBeInstanceOf(AuthzError);
    const other = await seedOrg(TODAY, { modules: [] });
    await expect(feedbackDetail(db(), await viewerFor(other, "rod"), leo.id)).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("session feedback report (coach-level and class-level averages)", () => {
  const range = (viewer?: { userId: string; role: string }) => ({ from: addDaysYmd(TODAY, -7), to: TODAY, tz: "America/Indiana/Indianapolis", viewer });
  it("owner/admin and coaches may open it; operations, guardians and athletes may not", async () => {
    const def = reportByKey("session-feedback")!;
    expect(def.cap).toBe("feedback.report");
    for (const k of ["rod", "marcus"]) expect(can(await viewerFor(ctx, k), def.cap)).toBe(true);
    for (const k of ["erin", "alex", "maya", "kiosk"]) expect(can(await viewerFor(ctx, k), def.cap)).toBe(false);
  });

  it("owner sees every coach and class with exact averages; no names, no comments", async () => {
    const rod = await viewerFor(ctx, "rod");
    const res = await reportByKey("session-feedback")!.run(db(), ctx.orgId, range(rod));
    const row = (section: string, name: string) => res.rows.find((r) => r.section === section && r.name === name);
    // Marcus: session A (5, 3, 1, 3) + Maya's 4 yesterday = 16 / 5.
    expect(row("Coach", "Coach Marcus Hale")).toMatchObject({ responses: 5, avg_rating: "3.20", low: 1, attended: 7 });
    expect(row("Coach", "Coach Tess Morales")).toMatchObject({ responses: 1, avg_rating: "2.00", low: 1, attended: 1, response_rate: 1 });
    expect(row("Class", "Test Class")).toMatchObject({ responses: 5, avg_rating: "3.20" });
    expect(row("Class", "Tess Class")).toMatchObject({ responses: 1 });
    expect(JSON.stringify(res)).not.toMatch(/Leo|Maya|Parker|Rivera|crowded|ignored/);
  });

  it("a coach sees only their own sessions, and no average below the anonymity minimum", async () => {
    const def = reportByKey("session-feedback")!;
    const marcus = await def.run(db(), ctx.orgId, range(await viewerFor(ctx, "marcus")));
    expect(marcus.rows.map((r) => r.name).sort()).toEqual(["Coach Marcus Hale", "Test Class"]);
    expect(marcus.rows[0]).toMatchObject({ responses: 5, avg_rating: "3.20" });
    const tess = await def.run(db(), ctx.orgId, range(await viewerFor(ctx, "tess")));
    expect(tess.rows.map((r) => r.name).sort()).toEqual(["Coach Tess Morales", "Tess Class"]);
    for (const r of tess.rows) {
      expect(r.responses).toBe(1);
      expect(String(r.avg_rating)).toMatch(/not shown/);
      expect(r.low).toBeNull();
    }
  });
});
