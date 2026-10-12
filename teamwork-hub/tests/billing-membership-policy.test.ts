/**
 * Teamwork membership policies (src/lib/membership-policy.ts) enforced end to end against a real DB:
 * weekly class caps (concurrency, DST/ISO-week boundaries, staff override, family message), billing
 * anchored to the 1st with a mid-month stub, commitments rolling to month-to-month, holds (backdating,
 * cap, already-billed punch card, makeup-requires-active), in-season terms, cancellation notice,
 * family discount, restart nudges, decline classification and the Settings policy panel.
 * All people and data are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  bookings,
  creditBuckets,
  discounts,
  invoices,
  jobs,
  membershipEvents,
  memberships,
  organizations,
  paymentAttempts,
  payerAccounts,
  payerBeneficiaries,
  tasks,
} from "@/db/schema";
import { findCandidates } from "@/lib/automation/engine";
import { AuthzError } from "@/lib/authz/policy";
import { createProduct } from "@/lib/billing/catalog";
import { CARD_UPDATE_INSTRUCTIONS, classifyDecline, RETRY_INSTRUCTIONS } from "@/lib/billing/declines";
import { recordManualPayment } from "@/lib/billing/invoices";
import {
  addHold,
  cancellationPreview,
  cancelMembership,
  commitmentStatus,
  computeStub,
  createMembership,
  holdCapCheck,
  inSeasonCapCheck,
  previewMembershipStart,
  scheduleRestartNudge,
  startInSeason,
} from "@/lib/billing/memberships";
import { paymentExceptions } from "@/lib/billing/reconciliation";
import { generateRenewals } from "@/lib/billing/renewals";
import { createProductVersion } from "@/lib/billing/catalog";
import { DEFAULT_MEMBERSHIP_POLICY, membershipPolicy, parseMembershipPolicy, saveMembershipPolicy, weeklyCapMessage } from "@/lib/membership-policy";
import { bookSession, cancelBooking, lockWeeklyUsage, markAttendance } from "@/lib/scheduling/booking";
import { resolveEntitlement } from "@/lib/scheduling/eligibility";
import { localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { mkServiceType, mkSession } from "./scheduling-helpers";

const T = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
let svc: Awaited<ReturnType<typeof mkServiceType>>;
let twelveMonthVersionId: string;
const db = () => testDb();
const rod = () => viewerFor(ctx, "rod");
const erin = () => viewerFor(ctx, "erin");

beforeAll(async () => {
  ctx = await seedOrg(T);
  B = ctx.extra.billing;
  svc = await mkServiceType(ctx, { name: "Policy test class" });
  const p = await db().transaction(async (tx) =>
    createProduct(tx, await rod(), {
      name: "Test 2x per Week (12 Months)",
      kind: "recurring_membership",
      version: { priceMinor: 20000, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2020-01-01" },
    }),
  );
  twelveMonthVersionId = p.version.id;
  // These athletes start without seeded session credits, so the weekly cap (not a credit fallback) decides.
  const ids = ["dana", "ella", "jackson", "harper", "mason", "zoe"].map((k) => ctx.athletes[k]);
  await db().execute(sql`update credit_buckets set status = 'void' where org_id = ${ctx.orgId} and athlete_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
});
afterAll(closeTestDb);

async function membership(athlete: string, versionId: string, startDate: string, opts: { payer?: string; today?: string; billing?: "manual" | "none" } = {}) {
  const r = await db().transaction(async (tx) =>
    createMembership(tx, await rod(), { athleteId: ctx.athletes[athlete], payerAccountId: opts.payer ?? ctx.payers[athlete], productVersionId: versionId, startDate, today: opts.today ?? T, billingProvider: opts.billing ?? "none" }),
  );
  return r;
}
const at = (ymd: string, hm = "17:00") => localToUtc(ymd, hm);
const session = (ymd: string, hm = "17:00") => mkSession(ctx, { serviceTypeId: svc.id, startsAt: at(ymd, hm), capacity: 20 });
const book = async (v: Awaited<ReturnType<typeof erin>>, sessionId: string, athlete: string, extra: Partial<Parameters<typeof bookSession>[2]> = {}) =>
  db().transaction((tx) => bookSession(tx, v, { sessionId, athleteId: ctx.athletes[athlete], now: new Date("2026-10-13T12:00:00Z"), ...extra }));

// ---------------------------------------------------------------------------------------------
describe("weekly class caps", () => {
  it("counts booked/attended/no-show (not cancelled) in the ISO week; family sees a clear message; staff override is audited", async () => {
    await membership("dana", B.ref_perf_2x_m2m, "2026-10-01");
    const dana = await viewerFor(ctx, "dana");
    const now = new Date("2026-11-14T12:00:00Z");
    const [s1, s2, s3, s4] = await Promise.all([session("2026-11-16"), session("2026-11-18"), session("2026-11-20"), session("2026-11-23")]);
    const b1 = await book(dana, s1.id, "dana", { now });
    expect(b1.booking).toMatchObject({ entitlementSource: "membership", status: "booked" });
    await book(dana, s2.id, "dana", { now });
    // Third in the same week: refused with the family-facing message.
    await expect(book(dana, s3.id, "dana", { now })).rejects.toThrow("Dana's 2x/week plan already has 2 sessions booked the week of Nov 16.");
    // Next ISO week is fine.
    expect((await book(dana, s4.id, "dana", { now })).booking.entitlementSource).toBe("membership");
    // Cancelled bookings don't count.
    await db().transaction((tx) => cancelBooking(tx, dana, { bookingId: b1.booking.id, now }));
    const again = await book(dana, s3.id, "dana", { now });
    expect(again.booking.entitlementSource).toBe("membership");
    // Families cannot override; staff need a reason; staff override is audited.
    const s5 = await session("2026-11-21");
    await expect(book(dana, s5.id, "dana", { now, capOverride: { reason: "x" } })).rejects.toBeInstanceOf(AuthzError);
    const e = await erin();
    await expect(book(e, s5.id, "dana", { now, capOverride: { reason: "  " } })).rejects.toThrow(/reason/);
    await expect(book(e, s5.id, "dana", { now })).rejects.toThrow(/Staff can override with a reason/);
    const ov = await book(e, s5.id, "dana", { now, capOverride: { reason: "Make-up for a coach-cancelled session" } });
    expect(ov.booking.entitlementSource).toBe("membership");
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, ov.booking.id), eq(auditEvents.action, "booking.create")));
    expect(a.summary).toContain("weekly limit 2x overridden: Make-up for a coach-cancelled session");
    expect((a.after as Record<string, unknown>).weeklyCapOverride).toBe("Make-up for a coach-cancelled session");
  });

  it("attended and no-show bookings count toward the cap", async () => {
    await membership("ella", B.ref_perf_1x_m2m, "2026-10-01");
    const e = await erin();
    const s1 = await session("2026-10-19", "06:00");
    const s2 = await session("2026-10-22");
    const b = await book(e, s1.id, "ella", { now: new Date("2026-10-18T12:00:00Z") });
    await db().transaction((tx) => markAttendance(tx, e, { bookingId: b.booking.id, outcome: "no_show", now: new Date("2026-10-19T12:00:00Z") }));
    await expect(book(e, s2.id, "ella", { now: new Date("2026-10-19T13:00:00Z") })).rejects.toThrow(/1x\/week plan already has 1 session booked the week of Oct 19/);
  });

  it("concurrent bookings for different sessions can never exceed the cap (row lock on the membership)", async () => {
    await membership("jackson", B.ref_perf_2x_m2m, "2026-10-01");
    const e = await erin();
    const ss = await Promise.all(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map((d) => session(d)));
    const res = await Promise.allSettled(ss.map((s) => book(e, s.id, "jackson", { now: new Date("2026-11-01T12:00:00Z") })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(res.filter((r) => r.status === "rejected").every((r) => /2x\/week plan already has 2 sessions/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    const n = await db().execute(sql`select count(*)::int as n from bookings where athlete_id = ${ctx.athletes.jackson} and status = 'booked' and session_id in (${sql.join(ss.map((s) => sql`${s.id}`), sql`, `)})`);
    expect((n.rows[0] as { n: number }).n).toBe(2);
  });

  it("weeks are ISO weeks in facility time, DST-safe (Sunday 23:30 after DST ends stays in its week)", async () => {
    await membership("harper", B.ref_perf_1x_m2m, "2026-10-01");
    const e = await erin();
    const now = new Date("2026-10-25T12:00:00Z");
    const monday = await session("2026-10-26", "07:00");
    const sundayLate = await session("2026-11-01", "23:30"); // DST ended 02:00 that day: 23:30 EST = Monday 04:30 UTC
    const nextMonday = await session("2026-11-02", "00:30");
    expect(sundayLate.startsAt.toISOString()).toBe("2026-11-02T04:30:00.000Z");
    await book(e, monday.id, "harper", { now });
    await expect(book(e, sundayLate.id, "harper", { now })).rejects.toThrow(/week of Oct 26/);
    expect((await book(e, nextMonday.id, "harper", { now })).booking.entitlementSource).toBe("membership");
    // The DST week is 169 hours long (00:00 EDT Monday → 00:00 EST next Monday).
    const u = await db().transaction(async (tx) => {
      const [m] = await tx.select().from(memberships).where(eq(memberships.athleteId, ctx.athletes.harper));
      return lockWeeklyUsage(tx, { orgId: ctx.orgId, membershipId: m.id, athleteId: ctx.athletes.harper, at: sundayLate.startsAt });
    });
    expect(u.weekStart).toBe("2026-10-26");
    expect((u.to.getTime() - u.from.getTime()) / 3_600_000).toBe(169);
    // DST start in spring: the week of Mar 2 2026 includes Sunday Mar 8 (23 hours that day).
    const spring = await db().transaction(async (tx) => {
      const [m] = await tx.select().from(memberships).where(eq(memberships.athleteId, ctx.athletes.harper));
      return lockWeeklyUsage(tx, { orgId: ctx.orgId, membershipId: m.id, athleteId: ctx.athletes.harper, at: at("2026-03-08", "22:00") });
    });
    expect(spring.weekStart).toBe("2026-03-02");
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(167);
  });

  it("weeklyCapMessage reads naturally", () => {
    expect(weeklyCapMessage("Maya", 2, 2, "2026-03-02")).toBe("Maya's 2x/week plan already has 2 sessions booked the week of Mar 2.");
    expect(weeklyCapMessage("Maya", 1, 1, "2026-03-02")).toContain("1 session booked");
  });
});

// ---------------------------------------------------------------------------------------------
describe("billing anchored to the 1st with a mid-month stub", () => {
  it("stub math: half-month rule, daily, weekly; next bill on the 1st", () => {
    const s = computeStub(26199, "2026-07-20", 1, "teamwork_half_month");
    expect(s).toMatchObject({ periodStart: "2026-07-20", periodEnd: "2026-07-31", coveredDays: 12, periodDays: 31, grossMinor: 13100, nextBillDate: "2026-08-01", overridden: false });
    expect(computeStub(26199, "2026-07-05", 1, "teamwork_half_month").grossMinor).toBe(26199); // 27 days → full
    expect(computeStub(26199, "2026-07-28", 1, "teamwork_half_month").grossMinor).toBe(6550); // 4 days → 25%
    expect(computeStub(31000, "2026-07-22", 1, "daily").grossMinor).toBe(10000);
    expect(computeStub(28000, "2026-02-15", 1, "weekly")).toMatchObject({ coveredDays: 14, grossMinor: 14000 }); // 2 of 4 weeks
    expect(computeStub(23299, "2026-02-27", 1, "teamwork_half_month")).toMatchObject({ periodEnd: "2026-02-28", nextBillDate: "2026-03-01", coveredDays: 2 });
    expect(computeStub(10000, "2026-10-20", 1, "teamwork_half_month", { amountMinor: 4000, reason: "agreed" })).toMatchObject({ grossMinor: 4000, policyAmountMinor: 5000, overridden: true });
  });

  it("a mid-month start bills a stub to month end (shown to staff first), then regular periods from the 1st", async () => {
    const r = await db().transaction(async (tx) => previewMembershipStart(tx, await rod(), { athleteId: ctx.athletes.ella, payerAccountId: ctx.payers.ella, productVersionId: B.ref_perf_2x_m2m, startDate: "2026-10-20" }));
    expect(r.stub).toMatchObject({ periodStart: "2026-10-20", periodEnd: "2026-10-31", grossMinor: 11650, netMinor: 11650 });
    expect(r.firstRegularBillDate).toBe("2026-11-01");
    const { membership: m, firstInvoice } = await membership("ella", B.ref_perf_2x_m2m, "2026-10-20", { billing: "manual" });
    expect(m.billingAnchorDay).toBe(1);
    expect(firstInvoice).toMatchObject({ periodStart: "2026-10-20", periodEnd: "2026-10-31", totalMinor: r.stub!.netMinor });
    expect(m.nextBillDate).toBe("2026-11-01");
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-01"));
    const [nov] = await db().select().from(invoices).where(and(eq(invoices.membershipId, m.id), eq(invoices.periodStart, "2026-11-01")));
    expect(nov).toMatchObject({ periodEnd: "2026-11-30", totalMinor: 23299 });
    const ev = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, "stub_billed")));
    expect(ev).toHaveLength(1);
  });

  it("starting on the 1st has no stub; staff can override the stub amount only with a reason (audited)", async () => {
    const first = await membership("owen", B.ref_perf_1x_m2m, "2026-11-01", { billing: "manual" });
    expect(first.stub).toBeNull();
    expect(first.firstInvoice).toBeNull(); // future start on the 1st: billed by the renewal job
    const v = await rod();
    await expect(
      db().transaction((tx) => createMembership(tx, v, { athleteId: ctx.athletes.owen, payerAccountId: ctx.payers.owen, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-10-15", today: T, stubOverride: { amountMinor: 5000, reason: "" } })),
    ).rejects.toThrow(/requires a reason/);
    const r = await db().transaction((tx) =>
      createMembership(tx, v, { athleteId: ctx.athletes.owen, payerAccountId: ctx.payers.owen, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-10-15", today: T, stubOverride: { amountMinor: 5000, reason: "Started after a comped trial week" } }),
    );
    expect(r.firstInvoice).toMatchObject({ totalMinor: 5000, periodEnd: "2026-10-31" });
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, r.membership.id), eq(auditEvents.action, "billing.membership.create")));
    expect(a.summary).toContain("amount overridden (Started after a comped trial week)");
  });

  it("the stub method comes from the saved policy", async () => {
    const v = await rod();
    await db().transaction((tx) => saveMembershipPolicy(tx, v, { ...DEFAULT_MEMBERSHIP_POLICY, prorationMethod: "daily" }));
    const r = await db().transaction((tx) => previewMembershipStart(tx, v, { athleteId: ctx.athletes.ella, payerAccountId: ctx.payers.ella, productVersionId: B.ref_perf_2x_m2m, startDate: "2026-10-20" }));
    expect(r.stub!.grossMinor).toBe(Math.round((23299 * 12) / 31));
    await db().transaction((tx) => saveMembershipPolicy(tx, v, { ...DEFAULT_MEMBERSHIP_POLICY }));
  });
});

describe("college plan", () => {
  it("bills weekly with unlimited classes and no monthly stub", async () => {
    const r = await membership("ava", B.ref_college_break, "2026-06-03", { billing: "manual", payer: ctx.payers.chris_parker, today: "2026-06-03" });
    expect(r.stub).toBeNull();
    expect(r.firstInvoice).toMatchObject({ periodStart: "2026-06-03", periodEnd: "2026-06-09", totalMinor: 5000 });
    await db().transaction(async (tx) => recordManualPayment(tx, await erin(), { invoiceId: r.firstInvoice!.id, amountMinor: 5000, method: "cash", reference: "R-college-1" }));
    expect(await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.ava, serviceType: svc, at: at("2026-06-05") })).toMatchObject({ kind: "unlimited", membershipId: r.membership.id });
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-06-20"));
    const starts = (await db().select().from(invoices).where(eq(invoices.membershipId, r.membership.id))).map((i) => i.periodStart).sort();
    expect(starts).toEqual(["2026-06-03", "2026-06-10", "2026-06-17"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("commitments", () => {
  it("a 6-month term continues month-to-month at the committed rate, never into a new commitment", async () => {
    const v = await rod();
    const { membership: m } = await db().transaction((tx) =>
      createMembership(tx, v, { athleteId: ctx.athletes.aria, payerAccountId: ctx.payers.aria, productVersionId: B.ref_perf_3x_6mo, startDate: "2026-01-01", today: "2026-01-01" }),
    );
    expect(m).toMatchObject({ commitmentStartsOn: "2026-01-01", commitmentEndsOn: "2026-06-30" });
    // A later price increase does not touch this membership's committed rate.
    const [prod] = await db().execute(sql`select product_id from product_versions where id = ${B.ref_perf_3x_6mo}`).then((r) => r.rows as { product_id: string }[]);
    await db().transaction((tx) => createProductVersion(tx, v, prod.product_id, { priceMinor: 29999, interval: "month", classesPerWeek: 3, commitmentMonths: 6, effectiveFrom: "2027-01-01" }));
    for (const day of ["2026-09-15", "2026-09-15"]) await db().transaction((tx) => generateRenewals(tx, ctx.orgId, day));
    const invs = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
    expect(invs.map((i) => i.periodStart).sort()).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(new Set(invs.map((i) => i.totalMinor))).toEqual(new Set([26199]));
    const [after] = await db().select().from(memberships).where(eq(memberships.id, m.id));
    expect(after).toMatchObject({ commitmentEndsOn: "2026-06-30", productVersionId: B.ref_perf_3x_6mo, cancelAt: null });
    const ended = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, "commitment_ended")));
    expect(ended).toHaveLength(1);
    expect(ended[0].details).toMatchObject({ continues: "month_to_month_at_committed_rate" });
    // Served / remaining / remaining contract value.
    expect(commitmentStatus(after, { commitmentMonths: 6 }, "2026-04-15", 26199)).toMatchObject({ served: 3, remaining: 3, remainingValueMinor: 3 * 26199, ended: false });
    expect(commitmentStatus(after, { commitmentMonths: 6 }, "2026-06-30", 26199)).toMatchObject({ served: 6, remaining: 0, ended: false });
    expect(commitmentStatus(after, { commitmentMonths: 6 }, "2026-08-01", 26199)).toMatchObject({ remaining: 0, ended: true });
    // During the term the commitment end governs; after it only the notice applies.
    expect((await cancellationPreview(db(), ctx.orgId, m.id, "2026-03-01")).effectiveOn).toBe("2026-07-01");
    expect((await cancellationPreview(db(), ctx.orgId, m.id, "2026-09-10")).effectiveOn).toBe("2026-10-10");
  });
});

// ---------------------------------------------------------------------------------------------
describe("holds", () => {
  it("backdating only to the request date, firm restart, channel recorded, never a cancellation; already-billed → punch card", async () => {
    const v = await rod();
    const { membership: m, firstInvoice } = await db().transaction((tx) =>
      createMembership(tx, v, { athleteId: ctx.athletes.mason, payerAccountId: ctx.payers.mason, productVersionId: twelveMonthVersionId, startDate: "2026-03-01", today: "2026-03-01" }),
    );
    await db().transaction(async (tx) => recordManualPayment(tx, await erin(), { invoiceId: firstInvoice!.id, amountMinor: firstInvoice!.totalMinor, method: "check", reference: "CHK-MASON-1" }));
    // The March invoice was paid on the 1st, before the family asked.
    await db().update(invoices).set({ paidAt: new Date("2026-03-01T15:00:00Z") }).where(eq(invoices.id, firstInvoice!.id));
    // One session actually used in the window.
    const s = await session("2026-03-11");
    await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes.mason, bookedByUserId: v.userId, status: "attended", entitlementSource: "membership", membershipId: m.id });

    const base = { membershipId: m.id, reason: "Family trip (synthetic)", requestedOn: "2026-03-10", requestChannel: "sms" as const, today: "2026-03-12" };
    await expect(db().transaction((tx) => addHold(tx, v, { ...base, startDate: "2026-03-08", restartDate: "2026-05-01" }))).rejects.toThrow(/backdated only to the date the family sent the request \(2026-03-10\)/);
    await expect(db().transaction((tx) => addHold(tx, v, { ...base, startDate: "2026-03-10" }))).rejects.toThrow(/firm restart date/);
    const h = await db().transaction((tx) => addHold(tx, v, { ...base, startDate: "2026-03-10", restartDate: "2026-05-01" }));
    expect(h).toMatchObject({ startDate: "2026-03-10", endDate: "2026-04-30", requestedOn: "2026-03-10", requestChannel: "sms", kind: "hold", restartDate: "2026-05-01" });
    // Window Mar 10–31 = 22 days → round(2 × 22 / 7) = 6 entitled, 1 used → 5 unused.
    expect(h.makeup).toMatchObject({ granted: 5, eligible: true });
    const [bucket] = await db().select().from(creditBuckets).where(eq(creditBuckets.id, h.makeup!.bucketId!));
    expect(bucket).toMatchObject({ sourceKind: "hold_makeup", available: 5, periodStart: "2026-05-01", membershipId: m.id });
    expect(bucket.expiresAt!.toISOString()).toBe(localToUtc("2026-06-12", "00:00").toISOString()); // 3 months after issue (Mar 12)
    const [held] = await db().select().from(memberships).where(eq(memberships.id, m.id));
    expect(held).toMatchObject({ status: "on_hold", cancelAt: null, endDate: null });
    // The money is kept: the March invoice is untouched.
    expect((await db().select().from(invoices).where(eq(invoices.id, firstInvoice!.id)))[0]).toMatchObject({ status: "paid", totalMinor: 20000 });

    // Makeup credits work while the membership is active; the cap is used first, then the punch card.
    const e = await erin();
    const now = new Date("2026-05-02T12:00:00Z");
    const may = await Promise.all(["2026-05-04", "2026-05-05", "2026-05-06"].map((d) => session(d)));
    await book(e, may[0].id, "mason", { now });
    await book(e, may[1].id, "mason", { now });
    const third = await book(e, may[2].id, "mason", { now });
    expect(third.booking).toMatchObject({ entitlementSource: "credit", creditBucketId: bucket.id });
    // Before the restart date the punch card is not usable (periodStart) and the membership is held.
    expect(await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.mason, serviceType: svc, at: at("2026-04-20") })).toEqual({ kind: "none" });

    // Makeup rule: once the membership has ended the punch card can't be used.
    await db().transaction((tx) => cancelMembership(tx, v, { membershipId: m.id, requestedOn: "2026-05-07", reason: "Moving away", today: "2026-05-08", overrideCancelAt: "2026-05-08", overrideReason: "Relocation, owner approved" }));
    expect(await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.mason, serviceType: svc, at: at("2026-05-12") })).toEqual({ kind: "none" });
    const late = await session("2026-05-12");
    await expect(book(e, late.id, "mason", { now: new Date("2026-05-09T12:00:00Z") })).rejects.toThrow(/no membership or credits/);
    // With the rule off, the same credits would count (proves it is the makeup rule, not expiry).
    expect(await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.mason, serviceType: svc, at: at("2026-05-12"), makeupRequiresActiveMembership: false })).toEqual({ kind: "credits", available: 4 });
    // Expiry: unusable after 3 months.
    expect(await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.mason, serviceType: svc, at: at("2026-06-13"), makeupRequiresActiveMembership: false })).toEqual({ kind: "none" });
  });

  it("month-to-month already-billed holds are a staff decision (task); staff can grant with a reason", async () => {
    const v = await rod();
    const mk = async () => {
      const r = await db().transaction((tx) => createMembership(tx, v, { athleteId: ctx.athletes.zoe, payerAccountId: ctx.payers.zoe, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-03-01", today: "2026-03-01" }));
      await db().transaction(async (tx) => recordManualPayment(tx, await erin(), { invoiceId: r.firstInvoice!.id, amountMinor: r.firstInvoice!.totalMinor, method: "cash", reference: `R-${r.membership.id.slice(0, 6)}` }));
      await db().update(invoices).set({ paidAt: new Date("2026-03-01T15:00:00Z") }).where(eq(invoices.id, r.firstInvoice!.id));
      return r.membership;
    };
    const m1 = await mk();
    const h1 = await db().transaction((tx) => addHold(tx, v, { membershipId: m1.id, startDate: "2026-03-17", restartDate: "2026-04-15", requestedOn: "2026-03-17", requestChannel: "phone", reason: "Injury", today: "2026-03-17" }));
    expect(h1.makeup).toMatchObject({ granted: 0, eligible: false, decision: expect.stringContaining("staff decision") });
    const t = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `billing:hold-makeup-decision:${h1.id}`)));
    expect(t).toHaveLength(1);
    const m2 = await mk();
    const h2 = await db().transaction((tx) =>
      addHold(tx, v, { membershipId: m2.id, startDate: "2026-03-17", restartDate: "2026-04-15", requestedOn: "2026-03-17", requestChannel: "voice_agent_recap", reason: "Injury", grantMakeup: { reason: "Long-time family, owner approved" }, today: "2026-03-17" }),
    );
    // 15 days left → round(1 × 15 / 7) = 2.
    expect(h2.makeup).toMatchObject({ granted: 2, eligible: false });
  });

  it("caps holds at 2 months per membership year; an override needs a reason and is audited", async () => {
    const v = await rod();
    const { membership: m } = await db().transaction((tx) =>
      createMembership(tx, v, { athleteId: ctx.athletes.ava, payerAccountId: ctx.payers.chris_parker, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-01-01", billingProvider: "none", today: "2026-01-01" }),
    );
    const hold = (startDate: string, restartDate: string, overrideReason?: string) =>
      db().transaction((tx) => addHold(tx, v, { membershipId: m.id, startDate, restartDate, requestedOn: startDate, requestChannel: "email", reason: "Break", overrideReason, today: startDate }));
    await hold("2026-02-01", "2026-03-15"); // 42 days
    await expect(hold("2026-06-01", "2026-07-01")).rejects.toThrow(/72 held days; the policy allows 2 months \(62 days\)/);
    const over = await hold("2026-06-01", "2026-07-01", "Medical, owner approved");
    expect(over.overrideReason).toBe("Medical, owner approved");
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, m.id), eq(auditEvents.action, "billing.membership.hold"), sql`${auditEvents.summary} like '%cap overridden%'`));
    expect(a).toBeTruthy();
    // A new membership year starts the count again.
    await hold("2027-01-05", "2027-02-20"); // 46 days in the 2027 membership year
    expect(holdCapCheck("2026-01-01", [{ startDate: "2026-12-15", endDate: "2027-01-20" }], { startDate: "2027-02-01", endDate: "2027-03-15" }, 2)).toEqual([
      expect.objectContaining({ yearStart: "2027-01-01", usedDays: 20, addingDays: 43, over: true }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("in-season", () => {
  it("pauses the regular membership, adds a fixed-term In Season membership, resumes automatically, caps 12-month members", async () => {
    const v = await rod();
    const { membership: reg } = await db().transaction((tx) =>
      createMembership(tx, v, { athleteId: ctx.athletes.liam, payerAccountId: ctx.payers.liam, productVersionId: twelveMonthVersionId, startDate: "2027-01-01", today: "2026-12-15" }),
    );
    expect(reg.commitmentEndsOn).toBe("2027-12-31");
    const r = await db().transaction((tx) =>
      startInSeason(tx, v, { membershipId: reg.id, inSeasonVersionId: B.ref_in_season_1x, startDate: "2027-04-01", endDate: "2027-05-31", reason: "Spring basketball", requestedOn: "2027-03-15", requestChannel: "messenger", today: "2027-03-20" }),
    );
    expect(r.hold).toMatchObject({ kind: "in_season", startDate: "2027-04-01", endDate: "2027-05-31", relatedMembershipId: r.inSeasonMembership.id, requestChannel: "messenger" });
    expect(r.inSeasonMembership).toMatchObject({ kind: "in_season", startDate: "2027-04-01", endDate: "2027-05-31", cancelAt: "2027-06-01" });
    // The DB refuses an open-ended In Season membership.
    await expect(db().update(memberships).set({ cancelAt: null }).where(eq(memberships.id, r.inSeasonMembership.id))).rejects.toThrow();
    // Restart nudge: automation job + staff task at restart − 14 days (09:00 local), deduped per hold.
    const due = localToUtc("2027-05-18", "09:00");
    const [job] = await db().select().from(jobs).where(eq(jobs.dedupeKey, `restart_nudge:${r.hold.id}`));
    expect(job).toMatchObject({ type: "automation.evaluate", payload: { orgId: ctx.orgId, trigger: "membership_restart_upcoming", membershipId: reg.id } });
    expect(job.runAt.toISOString()).toBe(due.toISOString());
    const policy = await membershipPolicy(db(), ctx.orgId);
    await db().transaction((tx) => scheduleRestartNudge(tx, ctx.orgId, { membershipId: reg.id, holdId: r.hold.id, restartDate: "2027-06-01", label: "Liam", kind: "in_season", policy }));
    expect(await db().select().from(jobs).where(eq(jobs.dedupeKey, `restart_nudge:${r.hold.id}`))).toHaveLength(1);
    const [task] = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `billing:restart-nudge:${r.hold.id}`)));
    expect(task.dueAt!.toISOString()).toBe(due.toISOString());
    // When the job runs, the automation trigger finds the family (delivery stays with messaging rules).
    const cands = await db().transaction((tx) => findCandidates(tx, ctx.orgId, "membership_restart_upcoming", {}, { membershipId: reg.id }, due));
    expect(cands).toEqual([expect.objectContaining({ entityType: "membership", entityId: reg.id, period: `restart:${r.hold.id}`, vars: expect.objectContaining({ restart_date: "Jun 1, 2027" }) })]);

    // Cap: 61 days already; another 30 within 365 days is over 62 → override needed.
    const second = { membershipId: reg.id, inSeasonVersionId: B.ref_in_season_1x, startDate: "2027-09-01", endDate: "2027-09-30", reason: "Fall season", today: "2027-08-20" };
    await expect(db().transaction((tx) => startInSeason(tx, v, second))).rejects.toThrow(/2 months \(62 days\) per rolling 365 days/);
    const ok = await db().transaction((tx) => startInSeason(tx, v, { ...second, overrideReason: "State tournament run, owner approved" }));
    expect(ok.hold.overrideReason).toBe("State tournament run, owner approved");
    expect(inSeasonCapCheck([{ startDate: "2027-04-01", endDate: "2027-05-31" }], { startDate: "2028-05-01", endDate: "2028-05-31" }, 2).over).toBe(false);

    // Renewals: regular deferred during the term and billed again from Jun 1; In Season expires and never renews.
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2027-06-15"));
    const regInv = (await db().select().from(invoices).where(eq(invoices.membershipId, reg.id))).map((i) => i.periodStart).sort();
    expect(regInv).toEqual(["2027-01-01", "2027-02-01", "2027-03-01", "2027-06-01"]);
    const insInv = (await db().select().from(invoices).where(eq(invoices.membershipId, r.inSeasonMembership.id))).map((i) => [i.periodStart, i.periodEnd]);
    expect(insInv.sort()).toEqual([["2027-04-01", "2027-04-30"], ["2027-05-01", "2027-05-31"]]);
    const [ins] = await db().select().from(memberships).where(eq(memberships.id, r.inSeasonMembership.id));
    expect(ins).toMatchObject({ status: "expired", nextBillDate: null });
    const [regAfter] = await db().select().from(memberships).where(eq(memberships.id, reg.id));
    expect(regAfter.commitmentEndsOn).toBe("2027-12-31"); // commitment carries over unchanged
    expect(regAfter.status).not.toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------------------------
describe("cancellation", () => {
  it("30 days' notice from the request date via any channel; shows last bill date and what remains", async () => {
    const v = await rod();
    const { membership: mm } = await membership("owen", B.ref_perf_1x_m2m, "2026-10-01", { billing: "manual" });
    expect(mm.nextBillDate).toBe("2026-11-01");
    const p = await cancellationPreview(db(), ctx.orgId, mm.id, "2026-10-12");
    expect(p).toMatchObject({ noticeDays: 30, effectiveOn: "2026-11-11", lastBillDate: "2026-11-01", remainingTotalMinor: 12900, openBalanceMinor: 12900 });
    expect(p.remaining.map((r) => r.periodStart)).toEqual(["2026-11-01"]);
    const c = await db().transaction((tx) => cancelMembership(tx, v, { membershipId: mm.id, requestedOn: "2026-10-12", requestChannel: "forwarded_email", reason: "Switching sports", today: T }));
    expect(c).toMatchObject({ cancelAt: "2026-11-11", immediate: false });
    const [ev] = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, mm.id), eq(membershipEvents.type, "cancel_scheduled")));
    expect(ev.details).toMatchObject({ requestChannel: "forwarded_email", requestedOn: "2026-10-12", noticeDays: 30, lastBillDate: "2026-11-01" });
    const [m] = await db().select().from(memberships).where(eq(memberships.id, mm.id));
    expect(m.status).not.toBe("cancelled");
    // The plan version's own notice wins when it sets one (the seeded unlimited sample has 30).
    expect((await cancellationPreview(db(), ctx.orgId, B.mayaMembershipId, "2026-10-12")).noticeDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------------------------
describe("family discount", () => {
  it("applies to every active athlete once 2+ are enrolled, and is removed below 2 (audited)", async () => {
    const v = await rod();
    const [fam] = await db().insert(payerAccounts).values({ orgId: ctx.orgId, name: "Synthetic Cole-Reyes family" }).returning();
    await db().insert(payerBeneficiaries).values([{ payerAccountId: fam.id, athleteId: ctx.athletes.ethan }, { payerAccountId: fam.id, athleteId: ctx.athletes.sofia }]);
    const discountOf = async (id: string) => {
      const [row] = await db().select({ d: discounts }).from(memberships).leftJoin(discounts, eq(discounts.id, memberships.discountId)).where(eq(memberships.id, id));
      return row.d ? `${row.d.name}` : null;
    };
    const ethan = await membership("ethan", B.ref_perf_1x_m2m, "2026-11-01", { payer: fam.id, billing: "manual" });
    expect(await discountOf(ethan.membership.id)).toBeNull();
    const sofia = await membership("sofia", B.ref_perf_2x_m2m, "2026-11-01", { payer: fam.id, billing: "manual" });
    expect(await discountOf(ethan.membership.id)).toBe("Family discount 10%");
    expect(await discountOf(sofia.membership.id)).toBe("Family discount 10%");
    const applied = await db().select().from(membershipEvents).where(and(sql`${membershipEvents.membershipId} in (${ethan.membership.id}, ${sofia.membership.id})`, eq(membershipEvents.type, "family_discount_applied")));
    expect(applied).toHaveLength(2);
    expect(await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, ethan.membership.id), eq(auditEvents.action, "billing.membership.family_discount_applied")))).toHaveLength(1);
    // Sibling leaves (cancellation becomes effective through the renewal job) → discount removed from Ethan.
    await db().transaction((tx) => cancelMembership(tx, v, { membershipId: sofia.membership.id, requestedOn: "2026-10-16", requestChannel: "email", reason: "Season ended", today: T }));
    const s = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-15"));
    expect(s.familyDiscountChanges).toBeGreaterThanOrEqual(1);
    // Ethan's November invoice was billed with the discount while both were enrolled.
    const [nov] = await db().select().from(invoices).where(and(eq(invoices.membershipId, ethan.membership.id), eq(invoices.periodStart, "2026-11-01")));
    expect(nov.totalMinor).toBe(12900 - 1290);
    expect(await discountOf(ethan.membership.id)).toBeNull();
    const removed = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, ethan.membership.id), eq(membershipEvents.type, "family_discount_removed")));
    expect(removed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("decline classification", () => {
  it("maps provider reasons to card-needs-updating vs retryable with app-first family text (no em dashes)", async () => {
    for (const c of ["expired_card", "fraudulent", "account_closed", "no_account", "lost_card", "INSTRUMENT_DECLINED"]) expect(classifyDecline(c).category).toBe("card_needs_update");
    for (const c of ["insufficient_funds", "processing_error", "try_again_later"]) expect(classifyDecline(c).category).toBe("retryable");
    expect(classifyDecline("weird_code", "Your card has expired.").category).toBe("card_needs_update");
    expect(classifyDecline(null, null)).toMatchObject({ category: "unknown", familyText: null });
    for (const text of [CARD_UPDATE_INSTRUCTIONS, RETRY_INSTRUCTIONS]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).toMatch(/Teamwork app/);
    }
    const [inv] = await db().select().from(invoices).where(and(eq(invoices.orgId, ctx.orgId), eq(invoices.status, "open")));
    await db().insert(paymentAttempts).values({ orgId: ctx.orgId, invoiceId: inv.id, provider: "stripe", amountMinor: inv.totalMinor, currency: "USD", status: "failed", idempotencyKey: `t-decline-${inv.id}`, failureCode: "expired_card", failureMessage: "Your card has expired." });
    const ex = await paymentExceptions(db(), ctx.orgId, { today: T });
    const e = ex.find((x) => x.kind === "failed_payment" && x.href.endsWith(inv.id));
    expect(e).toMatchObject({ severity: "high", decline: { category: "card_needs_update", label: "Card needs updating", familyText: CARD_UPDATE_INSTRUCTIONS } });
  });
});

// ---------------------------------------------------------------------------------------------
describe("Settings → Membership policy", () => {
  it("validates, confirms flagged values, audits, and is owner/admin only", async () => {
    const v = await rod();
    const current = await membershipPolicy(db(), ctx.orgId);
    expect(current.unconfirmed).toContain("familyDiscountPercent");
    expect(parseMembershipPolicy({ ...current, familyDiscountPercent: "150", cancellationNoticeDays: "x" }, current).errors).toMatchObject({ familyDiscountPercent: expect.any(String), cancellationNoticeDays: expect.any(String) });
    const bad = await db().transaction((tx) => saveMembershipPolicy(tx, v, { ...current, familyDiscountPercent: 150 }));
    expect(bad.ok).toBe(false);
    const r = await db().transaction((tx) => saveMembershipPolicy(tx, v, { ...current, familyDiscountPercent: "15", confirm: ["familyDiscountPercent"] }));
    expect(r.ok).toBe(true);
    const saved = await membershipPolicy(db(), ctx.orgId);
    expect(saved).toMatchObject({ familyDiscountPercent: 15, unconfirmed: [] });
    const [o] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect((o.settings as Record<string, unknown>).membershipPolicy).toMatchObject({ familyDiscountPercent: 15 });
    expect(await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, ctx.orgId), eq(auditEvents.action, "org.membership_policy_update")))).not.toHaveLength(0);
    for (const k of ["erin", "marcus", "alex"]) {
      const who = await viewerFor(ctx, k);
      await expect(db().transaction((tx) => saveMembershipPolicy(tx, who, { ...current }))).rejects.toBeInstanceOf(AuthzError);
    }
    await db().transaction((tx) => saveMembershipPolicy(tx, v, { ...DEFAULT_MEMBERSHIP_POLICY }));
  });

  it("seeds the reference plans as clearly labelled samples", async () => {
    const rows = await db().execute(sql`
      select p.name, p.description, v.classes_per_week, v.commitment_months, v.interval, v.unlimited
      from products p join product_versions v on v.product_id = p.id
      where p.org_id = ${ctx.orgId} and p.description like 'SAMPLE reference price%' order by p.name`);
    const plans = rows.rows as { name: string; classes_per_week: number | null; commitment_months: number; interval: string; unlimited: boolean }[];
    expect(plans.length).toBeGreaterThanOrEqual(5);
    expect(plans.every((p) => p.name.startsWith("Sample — "))).toBe(true);
    expect(plans.find((p) => p.name.includes("College"))).toMatchObject({ interval: "week", unlimited: true, classes_per_week: null });
    expect(plans.find((p) => p.name.includes("3x per Week (6 Months)"))).toMatchObject({ classes_per_week: 3, commitment_months: 6 });
  });
});
