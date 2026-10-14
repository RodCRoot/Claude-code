import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  bookings,
  creditBuckets,
  creditLedger,
  formRequests,
  formTemplates,
  formTemplateVersions,
  jobs,
  memberships,
  products,
  productVersions,
  scheduleSessions,
  tasks,
} from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { creditSummary, verifyLedger } from "@/lib/credits";
import {
  attendanceHistory,
  bookSession,
  cancelBooking,
  cancelSession,
  kioskCheckIn,
  kioskRoster,
  markAttendance,
  rescheduleBooking,
  restoreBookingCredit,
  substituteCoach,
} from "@/lib/scheduling";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { DAY, giveCredits, HOUR, mkServiceType, mkSession } from "./scheduling-helpers";
import { localToUtc, addDaysYmd, todayLocal } from "@/lib/time";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
  // These tests exercise credit-based entitlement; neutralize memberships created by the billing demo seed in this isolated org.
  await db().execute(sql`update memberships set status = 'cancelled' where org_id = ${ctx.orgId}`);
  // The seed leaves these athletes credit-free (shared ledger tests rely on that); give them credits here.
  for (const k of ["ethan", "sofia", "liam", "harper"]) await giveCredits(ctx, k, 20);
});
afterAll(closeTestDb);

const avail = async (k: string) => (await creditSummary(db(), ctx.athletes[k])).available;

describe("bookSession concurrency & integrity", () => {
  it("10 concurrent bookings for a capacity-1 session → exactly 1 booked, waitlist filled, rest rejected, ledger consistent", async () => {
    const erin = await viewerFor(ctx, "erin");
    const s = await mkSession(ctx, { capacity: 1, waitlist: 3 });
    const keys = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson", "eli", "harper"];
    const before = await Promise.all(keys.map(avail));
    const results = await Promise.allSettled(keys.map((k) => db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes[k] }))));
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof bookSession>>>).value);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.filter((r) => r.status === "booked")).toHaveLength(1);
    expect(ok.filter((r) => r.status === "waitlisted")).toHaveLength(3);
    expect(rejected).toHaveLength(6);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(UserError);
    const rows = await db().select().from(bookings).where(eq(bookings.sessionId, s.id));
    expect(rows.filter((b) => b.status === "booked")).toHaveLength(1);
    expect(rows.filter((b) => b.status === "waitlisted").map((b) => b.waitlistPosition).sort()).toEqual([1, 2, 3]);
    // Only the booked athlete spent (reserved) a credit.
    const after = await Promise.all(keys.map(avail));
    expect(before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("prevents double booking the same athlete (sequential and concurrent)", async () => {
    const erin = await viewerFor(ctx, "erin");
    const s = await mkSession(ctx, { capacity: 5 });
    await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.maya }));
    await expect(db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/already booked/);

    const s2 = await mkSession(ctx, { capacity: 5 });
    const res = await Promise.allSettled([0, 1, 2].map(() => db().transaction((tx) => bookSession(tx, erin, { sessionId: s2.id, athleteId: ctx.athletes.leo }))));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const live = await db().select().from(bookings).where(and(eq(bookings.sessionId, s2.id), eq(bookings.athleteId, ctx.athletes.leo)));
    expect(live).toHaveLength(1);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("idempotent retry returns the same booking and reserves once", async () => {
    const alex = await viewerFor(ctx, "alex");
    const s = await mkSession(ctx, { capacity: 5 });
    const key = `idem-${randomUUID()}`;
    const before = await avail("eli");
    const a = await db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.eli, idempotencyKey: key }));
    const b = await db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.eli, idempotencyKey: key }));
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
    expect(b.booking.id).toBe(a.booking.id);
    expect(await avail("eli")).toBe(before - 1);
    const reserves = await db().select().from(creditLedger).where(and(eq(creditLedger.bookingId, a.booking.id), eq(creditLedger.kind, "reserve")));
    expect(reserves).toHaveLength(1);
    // Reusing the key for a different athlete is refused.
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.maya, idempotencyKey: key }))).rejects.toThrow(/already used/);
  });
});

describe("authorization & entitlement", () => {
  it("guardian scope: Alex books Maya but not Ava; Casey cannot book Leo; Sam can", async () => {
    const s = await mkSession(ctx, { capacity: 10 });
    const alex = await viewerFor(ctx, "alex");
    const casey = await viewerFor(ctx, "casey");
    const sam = await viewerFor(ctx, "sam");
    const r = await db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.maya }));
    expect(r.status).toBe("booked");
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.ava }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => bookSession(tx, casey, { sessionId: s.id, athleteId: ctx.athletes.leo }))).rejects.toBeInstanceOf(AuthzError);
    expect((await db().transaction((tx) => bookSession(tx, sam, { sessionId: s.id, athleteId: ctx.athletes.leo }))).status).toBe("booked");
    // Families can't comp.
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.eli, comp: { reason: "please" } }))).rejects.toBeInstanceOf(AuthzError);
    // Kiosk can't book.
    const kiosk = await viewerFor(ctx, "kiosk");
    await expect(db().transaction((tx) => bookSession(tx, kiosk, { sessionId: s.id, athleteId: ctx.athletes.eli }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("families without membership/credits get a clear error; staff must comp with a reason", async () => {
    const s = await mkSession(ctx, { capacity: 10 });
    const chris = await viewerFor(ctx, "chris");
    const erin = await viewerFor(ctx, "erin");
    await expect(db().transaction((tx) => bookSession(tx, chris, { sessionId: s.id, athleteId: ctx.athletes.ava }))).rejects.toThrow(/membership or available session credits/);
    await expect(db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.ava }))).rejects.toThrow(/comp/);
    await expect(db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.ava, comp: { reason: " " } }))).rejects.toThrow(/reason/);
    const r = await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.ava, comp: { reason: "Trial class" } }));
    expect(r.booking.entitlementSource).toBe("comp");
    expect(r.booking.creditBucketId).toBeNull();
  });

  it("an active unlimited membership covering the service is used instead of credits", async () => {
    const d = db();
    const [p] = await d.insert(products).values({ orgId: ctx.orgId, name: "Sample Unlimited", kind: "recurring_membership" }).returning();
    const [pv] = await d.insert(productVersions).values({ productId: p.id, version: 1, priceMinor: 100, interval: "month", unlimited: true, effectiveFrom: "2020-01-01" }).returning();
    const [m] = await d.insert(memberships).values({ orgId: ctx.orgId, athleteId: ctx.athletes.dana, productVersionId: pv.id, status: "active", startDate: "2020-01-01", billingProvider: "manual" }).returning();
    const dana = await viewerFor(ctx, "dana");
    const s = await mkSession(ctx, { capacity: 10 });
    const before = await avail("dana");
    const r = await d.transaction((tx) => bookSession(tx, dana, { sessionId: s.id, athleteId: ctx.athletes.dana }));
    expect(r.booking.entitlementSource).toBe("unlimited");
    expect(r.booking.membershipId).toBe(m.id);
    expect(await avail("dana")).toBe(before);
    await d.update(memberships).set({ status: "cancelled" }).where(eq(memberships.id, m.id));
  });

  it("required forms and age limits gate eligibility; staff can override with a reason", async () => {
    const d = db();
    const [tpl] = await d.insert(formTemplates).values({ orgId: ctx.orgId, name: "Sample Waiver", kind: "waiver", requiredForBooking: true }).returning();
    const [ver] = await d
      .insert(formTemplateVersions)
      .values({ templateId: tpl.id, version: 1, title: "Sample Waiver", bodyMarkdown: "SAMPLE", signers: [{ role: "guardian", required: true }], contentHash: "x", status: "published" })
      .returning();
    await d.insert(formRequests).values({ orgId: ctx.orgId, templateVersionId: ver.id, subjectPersonId: ctx.people.maya_parker, athleteId: ctx.athletes.maya, status: "completed", completedAt: new Date() });
    // Eli's waiver expired.
    await d.insert(formRequests).values({ orgId: ctx.orgId, templateVersionId: ver.id, subjectPersonId: ctx.people.eli_parker, athleteId: ctx.athletes.eli, status: "completed", expiresAt: new Date(Date.now() - DAY) });
    const st = await mkServiceType(ctx, { eligibility: { requiredFormTemplateIds: [tpl.id], maxAge: 14 } });
    const s = await mkSession(ctx, { serviceTypeId: st.id });
    const alex = await viewerFor(ctx, "alex");
    // Maya (15) has the waiver but is over the age limit; Eli (12) is in range but his waiver expired.
    await expect(d.transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/ages 14 and under/);
    await expect(d.transaction((tx) => bookSession(tx, alex, { sessionId: s.id, athleteId: ctx.athletes.eli }))).rejects.toThrow(/Sample Waiver/);
    const erin = await viewerFor(ctx, "erin");
    const r = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.eli, override: { reason: "Paper waiver on file" } }));
    expect(r.status).toBe("booked");
  });

  it("enforces the family booking window and cutoff; staff are exempt", async () => {
    const alex = await viewerFor(ctx, "alex");
    const erin = await viewerFor(ctx, "erin");
    const far = await mkSession(ctx, { startsInMs: 30 * DAY });
    const soon = await mkSession(ctx, { startsInMs: 30 * 60_000 });
    const priv = await mkSession(ctx, { visibility: "private" });
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: far.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/opens 21 days/);
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: soon.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/closes 60 minutes/);
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: priv.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/isn't open/);
    expect((await db().transaction((tx) => bookSession(tx, erin, { sessionId: soon.id, athleteId: ctx.athletes.maya }))).status).toBe("booked");
  });

  it("coaches may only add athletes to their own sessions", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const tessSession = await mkSession(ctx, { coach: ctx.users.tess });
    const own = await mkSession(ctx, { coach: ctx.users.marcus });
    await expect(db().transaction((tx) => bookSession(tx, marcus, { sessionId: tessSession.id, athleteId: ctx.athletes.maya }))).rejects.toBeInstanceOf(AuthzError);
    expect((await db().transaction((tx) => bookSession(tx, marcus, { sessionId: own.id, athleteId: ctx.athletes.maya }))).status).toBe("booked");
    // Out-of-scope athlete (Tess's youth athlete) is refused even in his own session.
    await expect(db().transaction((tx) => bookSession(tx, marcus, { sessionId: own.id, athleteId: ctx.athletes.eli }))).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("cancellation, attendance, waitlist", () => {
  it("late cancel forfeits the credit; early cancel releases it", async () => {
    const alex = await viewerFor(ctx, "alex");
    const early = await mkSession(ctx, { startsInMs: 3 * DAY });
    const late = await mkSession(ctx, { startsInMs: 2 * HOUR }); // inside the sample 12h window
    const a = await avail("maya");
    const b1 = await db().transaction((tx) => bookSession(tx, alex, { sessionId: early.id, athleteId: ctx.athletes.maya }));
    const b2 = await db().transaction((tx) => bookSession(tx, alex, { sessionId: late.id, athleteId: ctx.athletes.maya }));
    expect(await avail("maya")).toBe(a - 2);
    const r1 = await db().transaction((tx) => cancelBooking(tx, alex, { bookingId: b1.booking.id }));
    expect(r1).toMatchObject({ status: "cancelled", late: false, creditOutcome: "release" });
    expect(await avail("maya")).toBe(a - 1);
    const r2 = await db().transaction((tx) => cancelBooking(tx, alex, { bookingId: b2.booking.id }));
    expect(r2).toMatchObject({ status: "late_cancelled", late: true, penalty: "forfeit_credit", creditOutcome: "forfeit" });
    expect(await avail("maya")).toBe(a - 1);
    // Staff can restore the forfeited credit once, with a reason.
    const erin = await viewerFor(ctx, "erin");
    await expect(db().transaction((tx) => restoreBookingCredit(tx, alex, { bookingId: b2.booking.id, reason: "x" }))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => restoreBookingCredit(tx, erin, { bookingId: b2.booking.id, reason: "Family emergency" }));
    expect(await avail("maya")).toBe(a);
    await expect(db().transaction((tx) => restoreBookingCredit(tx, erin, { bookingId: b2.booking.id, reason: "again" }))).rejects.toThrow(/already restored|no used/);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("staff can waive a late cancel (reason required) and fee policies create a pending billing task", async () => {
    const erin = await viewerFor(ctx, "erin");
    const d = db();
    const st = await mkServiceType(ctx, { cancellationPolicyId: ctx.extra.scheduling.policy });
    const s = await mkSession(ctx, { serviceTypeId: st.id, startsInMs: HOUR });
    const b = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.sofia }));
    await expect(d.transaction((tx) => cancelBooking(tx, erin, { bookingId: b.booking.id, mode: "waive" }))).rejects.toThrow(/reason/);
    const r = await d.transaction((tx) => cancelBooking(tx, erin, { bookingId: b.booking.id, mode: "waive", reason: "Injury" }));
    expect(r).toMatchObject({ status: "cancelled", creditOutcome: "release" });

    const { cancellationPolicies } = await import("@/db/schema");
    const [feePolicy] = await d.insert(cancellationPolicies).values({ orgId: ctx.orgId, name: "Fee test", lateCancelWindowMinutes: 600, lateCancelPenalty: "fee", noShowPenalty: "fee", feeMinor: 1500 }).returning();
    const st2 = await mkServiceType(ctx, { cancellationPolicyId: feePolicy.id });
    const s2 = await mkSession(ctx, { serviceTypeId: st2.id, startsInMs: HOUR });
    const b2 = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s2.id, athleteId: ctx.athletes.sofia }));
    const before = await avail("sofia");
    const r2 = await d.transaction((tx) => cancelBooking(tx, erin, { bookingId: b2.booking.id }));
    expect(r2).toMatchObject({ status: "late_cancelled", penalty: "fee", creditOutcome: "release" });
    expect(await avail("sofia")).toBe(before + 1);
    const t = await d.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.relatedId, b2.booking.id)));
    expect(t).toHaveLength(1);
    expect(t[0].relatedType).toBe("booking_fee");
  });

  it("waitlist promotion reserves a credit for the next eligible athlete and skips (with a recorded reason) those who can't pay", async () => {
    const erin = await viewerFor(ctx, "erin");
    const d = db();
    const s = await mkSession(ctx, { capacity: 1, waitlist: 3 });
    const first = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.mason }));
    const ariaWait = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.aria }));
    const zoeWait = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.zoe }));
    expect(ariaWait.status).toBe("waitlisted");
    expect(zoeWait.status).toBe("waitlisted");
    // Aria's credits are voided after she joined, so she can't be charged at promotion time.
    await d.update(creditBuckets).set({ status: "void" }).where(eq(creditBuckets.athleteId, ctx.athletes.aria));
    const zoeBefore = await avail("zoe");
    const r = await d.transaction((tx) => cancelBooking(tx, erin, { bookingId: first.booking.id }));
    expect(r.promoted).toEqual([zoeWait.booking.id]);
    expect(r.skipped.map((x) => x.bookingId)).toEqual([ariaWait.booking.id]);
    expect(r.skipped[0].reason).toMatch(/credits/);
    const [z] = await d.select().from(bookings).where(eq(bookings.id, zoeWait.booking.id));
    expect(z.status).toBe("booked");
    expect(z.entitlementSource).toBe("credit");
    expect(await avail("zoe")).toBe(zoeBefore - 1);
    const [a] = await d.select().from(bookings).where(eq(bookings.id, ariaWait.booking.id));
    expect(a.status).toBe("waitlisted");
    expect(a.waitlistPosition).toBe(1);
    const skipAudit = await d.select().from(auditEvents).where(and(eq(auditEvents.entityId, ariaWait.booking.id), eq(auditEvents.action, "booking.waitlist_skipped")));
    expect(skipAudit).toHaveLength(1);
    const notify = await d.select().from(jobs).where(eq(jobs.dedupeKey, `notify.waitlist_promoted:${zoeWait.booking.id}`));
    expect(notify).toHaveLength(1);
    expect(await verifyLedger(d, ctx.orgId)).toEqual([]);
  });

  it("attendance: attended consumes, no-show forfeits per policy; corrections keep credits consistent", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const tess = await viewerFor(ctx, "tess");
    const d = db();
    const s = await mkSession(ctx, { startsInMs: -30 * 60_000, coach: ctx.users.marcus });
    const erin = await viewerFor(ctx, "erin");
    const b1 = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.ethan }));
    const b2 = await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.liam }));
    await expect(d.transaction((tx) => markAttendance(tx, tess, { bookingId: b1.booking.id, outcome: "attended" }))).rejects.toBeInstanceOf(AuthzError);
    await d.transaction((tx) => markAttendance(tx, marcus, { bookingId: b1.booking.id, outcome: "attended" }));
    await d.transaction((tx) => markAttendance(tx, marcus, { bookingId: b2.booking.id, outcome: "no_show" }));
    const kinds = async (id: string) => (await d.select({ k: creditLedger.kind }).from(creditLedger).where(eq(creditLedger.bookingId, id))).map((r) => r.k).sort();
    expect(await kinds(b1.booking.id)).toEqual(["consume", "reserve"]);
    expect(await kinds(b2.booking.id)).toEqual(["forfeit", "reserve"]);
    // Correct no-show → attended (credit already used under forfeit policy)
    await d.transaction((tx) => markAttendance(tx, marcus, { bookingId: b2.booking.id, outcome: "attended" }));
    const [row] = await d.select().from(bookings).where(eq(bookings.id, b2.booking.id));
    expect(row.status).toBe("attended");
    expect(await verifyLedger(d, ctx.orgId)).toEqual([]);
  });

  it("reschedule atomically cancels the old booking and links the new one", async () => {
    const alex = await viewerFor(ctx, "alex");
    const from = await mkSession(ctx, { startsInMs: 4 * DAY });
    const to = await mkSession(ctx, { startsInMs: 5 * DAY });
    const full = await mkSession(ctx, { startsInMs: 5 * DAY, capacity: 0 });
    const b = await db().transaction((tx) => bookSession(tx, alex, { sessionId: from.id, athleteId: ctx.athletes.eli }));
    const before = await avail("eli");
    // Target full → whole reschedule rolls back.
    await expect(db().transaction((tx) => rescheduleBooking(tx, alex, { bookingId: b.booking.id, toSessionId: full.id }))).rejects.toThrow(/full/);
    const [still] = await db().select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(still.status).toBe("booked");
    const r = await db().transaction((tx) => rescheduleBooking(tx, alex, { bookingId: b.booking.id, toSessionId: to.id }));
    expect(r.booked.booking.rescheduledFromBookingId).toBe(b.booking.id);
    const [old] = await db().select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(old.status).toBe("cancelled");
    expect(await avail("eli")).toBe(before);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("staff session cancellation releases every credit and enqueues one notification job", async () => {
    const erin = await viewerFor(ctx, "erin");
    const d = db();
    const s = await mkSession(ctx, { capacity: 1, waitlist: 2 });
    await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.jackson }));
    await d.transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.harper }));
    const before = await avail("jackson");
    const marcus = await viewerFor(ctx, "marcus");
    await expect(d.transaction((tx) => cancelSession(tx, marcus, { sessionId: s.id, reason: "x" }))).rejects.toBeInstanceOf(AuthzError);
    const r = await d.transaction((tx) => cancelSession(tx, erin, { sessionId: s.id, reason: "Facility closed (weather)" }));
    expect(r.released).toBe(2);
    expect(await avail("jackson")).toBe(before + 1);
    const live = await d.select().from(bookings).where(and(eq(bookings.sessionId, s.id), sql`${bookings.status} in ('booked','waitlisted')`));
    expect(live).toHaveLength(0);
    const j = await d.select().from(jobs).where(eq(jobs.dedupeKey, `notify.session_cancelled:${s.id}`));
    expect(j).toHaveLength(1);
    expect(j[0].type).toBe("notify.session_cancelled");
    await expect(d.transaction((tx) => cancelSession(tx, erin, { sessionId: s.id, reason: "again" }))).rejects.toThrow(/already cancelled/);
    expect(await verifyLedger(d, ctx.orgId)).toEqual([]);
  });

  it("coach substitution keeps the original coach", async () => {
    const erin = await viewerFor(ctx, "erin");
    const s = await mkSession(ctx, { coach: ctx.users.marcus });
    await db().transaction((tx) => substituteCoach(tx, erin, { sessionId: s.id, coachUserId: ctx.users.tess, reason: "Marcus at clinic" }));
    await db().transaction((tx) => substituteCoach(tx, erin, { sessionId: s.id, coachUserId: ctx.users.rod }));
    const [row] = await db().select().from(scheduleSessions).where(eq(scheduleSessions.id, s.id));
    expect(row.coachUserId).toBe(ctx.users.rod);
    expect(row.originalCoachUserId).toBe(ctx.users.marcus);
    expect(row.version).toBe(3);
  });
});

describe("kiosk", () => {
  it("returns minimal fields only and checks in with one tap (credit consumed)", async () => {
    const tz = ctx.tz;
    const tomorrow = addDaysYmd(todayLocal(tz), 1);
    const startsAt = localToUtc(tomorrow, "10:00", tz);
    const now = localToUtc(tomorrow, "09:45", tz);
    const s = await mkSession(ctx, { startsAt, title: "Kiosk test class" });
    const erin = await viewerFor(ctx, "erin");
    const b = await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.eli }));
    const kiosk = await viewerFor(ctx, "kiosk");
    const roster = await db().transaction((tx) => kioskRoster(tx, kiosk, { now }));
    const session = roster.find((x) => x.id === s.id)!;
    expect(session).toBeTruthy();
    expect(Object.keys(session).sort()).toEqual(["athletes", "endsAt", "id", "startsAt", "title"]);
    const eli = session.athletes.find((a) => a.bookingId === b.booking.id)!;
    expect(Object.keys(eli).sort()).toEqual(["alerts", "bookingId", "displayName", "status"]);
    expect(eli.displayName).toBe("Eli P.");
    expect(eli.alerts).toEqual(["Please see front desk"]);
    expect(JSON.stringify(roster)).not.toMatch(/Parker|@|\d{4}-\d{2}-\d{2}T.*dateOfBirth/);
    // Search by first name.
    const filtered = await db().transaction((tx) => kioskRoster(tx, kiosk, { now, q: "eli" }));
    expect(filtered.flatMap((x) => x.athletes).every((a) => a.displayName.toLowerCase().includes("eli"))).toBe(true);

    const before = (await creditSummary(db(), ctx.athletes.eli)).reserved;
    await db().transaction((tx) => kioskCheckIn(tx, kiosk, { bookingId: b.booking.id, now }));
    const [row] = await db().select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(row.status).toBe("attended");
    expect(row.checkInMethod).toBe("kiosk");
    expect((await creditSummary(db(), ctx.athletes.eli)).reserved).toBe(before - 1);
    // Kiosk can't mark no-shows; guardians can't read the kiosk roster.
    await expect(db().transaction((tx) => markAttendance(tx, kiosk, { bookingId: b.booking.id, outcome: "no_show", now }))).rejects.toBeInstanceOf(AuthzError);
    const alex = await viewerFor(ctx, "alex");
    await expect(db().transaction((tx) => kioskRoster(tx, alex, { now }))).rejects.toBeInstanceOf(AuthzError);
    // Not-today sessions can't be checked in at the kiosk.
    const later = await mkSession(ctx, { startsAt: localToUtc(addDaysYmd(tomorrow, 2), "10:00", tz) });
    const b2 = await db().transaction((tx) => bookSession(tx, erin, { sessionId: later.id, athleteId: ctx.athletes.eli }));
    await expect(db().transaction((tx) => kioskCheckIn(tx, kiosk, { bookingId: b2.booking.id, now }))).rejects.toThrow(/today/);
  });
});

describe("attendance history", () => {
  it("counts statuses and reports milestones; guardians only see their own athletes", async () => {
    const alex = await viewerFor(ctx, "alex");
    const h = await db().transaction((tx) => attendanceHistory(tx, alex, ctx.athletes.maya));
    expect(h.counts.attended).toBeGreaterThan(0);
    expect(h.milestones.find((m) => m.count === 10)!.reachedAt !== null).toBe(h.counts.attended >= 10);
    expect(h.nextMilestone).toBeGreaterThan(h.counts.attended);
    await expect(db().transaction((tx) => attendanceHistory(tx, alex, ctx.athletes.ava))).rejects.toBeInstanceOf(AuthzError);
    const err = await db().transaction((tx) => attendanceHistory(tx, alex, ctx.athletes.leo)).catch((e) => e);
    expect(err).toBeInstanceOf(AuthzError);
  });
});
