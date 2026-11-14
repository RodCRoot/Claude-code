import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { auditEvents, bookings, creditLedger, eventRegistrations, events, formTemplates, invoiceLines, invoices, paymentAttempts, scheduleSessions, tasks, transactions } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { applyInvoiceEntitlements, recordManualPayment, settleInvoiceIfCovered, voidInvoice } from "@/lib/billing/invoices";
import { addEventSession, createEvent, setEventStatus, updateEvent, type EventInput } from "@/lib/events/events";
import { eventPriceOn, priceSeats } from "@/lib/events/pricing";
import { eventRosterCsv, familyEventDetail, listFamilyEvents, listStaffEvents, staffEventDetail } from "@/lib/events/queries";
import { cancelEventRegistration, registerForEvent, registrableAthletes, releaseExpiredHolds } from "@/lib/events/registration";
import { bookSession } from "@/lib/scheduling";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const key = () => randomUUID();
const SYSTEM = { orgId: null, actorUserId: null, actorRole: "system" };

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing"] });
});
afterAll(closeTestDb);

/** A published sample event starting in `startIn` days. Prices are test values, not real prices. */
async function mkEvent(over: Partial<EventInput> & { days?: number; startIn?: number; publish?: boolean } = {}) {
  const erin = await viewerFor(ctx, "erin");
  const { days = 2, startIn = 10, publish = true, ...input } = over;
  const sessions = Array.from({ length: days }, (_, i) => ({ date: addDaysYmd(T, startIn + i), startTime: "09:00", endTime: "11:00" }));
  const { event, sessionIds } = await db().transaction((tx) => createEvent(tx, erin, { name: `Sample Camp ${randomUUID().slice(0, 6)}`, kind: "camp", capacity: 10, priceMinor: 20000, ...input, sessions }));
  if (publish) await db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "published" }));
  return { event, sessionIds };
}
const register = async (who: string, eventId: string, athleteKeys: string[], extra: { now?: Date; override?: { reason: string } } = {}) => {
  const v = await viewerFor(ctx, who);
  return db().transaction((tx) => registerForEvent(tx, v, { eventId, athleteIds: athleteKeys.map((k) => ctx.athletes[k]), idempotencyKey: key(), ...extra }));
};
const regsOf = (eventId: string) => db().select().from(eventRegistrations).where(eq(eventRegistrations.eventId, eventId));
const pay = async (invoiceId: string, amountMinor: number) => {
  const erin = await viewerFor(ctx, "erin");
  return db().transaction((tx) => recordManualPayment(tx, erin, { invoiceId, amountMinor, method: "cash", reference: "test receipt" }));
};

describe("pricing", () => {
  const base = { priceMinor: 20000, earlyBirdPriceMinor: 17500, earlyBirdUntil: "2026-12-01", siblingDiscountPercent: 10 };
  it("early bird applies through the end of its last day, then the regular price", () => {
    expect(eventPriceOn(base, "2026-11-30")).toEqual({ baseMinor: 17500, earlyBird: true });
    expect(eventPriceOn(base, "2026-12-01")).toEqual({ baseMinor: 17500, earlyBird: true });
    expect(eventPriceOn(base, "2026-12-02")).toEqual({ baseMinor: 20000, earlyBird: false });
    expect(eventPriceOn({ ...base, earlyBirdPriceMinor: null, earlyBirdUntil: null }, "2026-11-01")).toEqual({ baseMinor: 20000, earlyBird: false });
  });
  it("sibling discount: first athlete full price, later athletes discounted off the price in effect", () => {
    expect(priceSeats(base, "2026-12-05", 3, 0).map((s) => s.amountMinor)).toEqual([20000, 18000, 18000]);
    expect(priceSeats(base, "2026-11-20", 2, 0)).toEqual([
      { baseMinor: 17500, earlyBird: true, siblingDiscountMinor: 0, amountMinor: 17500 },
      { baseMinor: 17500, earlyBird: true, siblingDiscountMinor: 1750, amountMinor: 15750 },
    ]);
  });
  it("counts a sibling who is already registered, rounds to the cent, never goes below zero", () => {
    expect(priceSeats(base, "2026-12-05", 1, 1)[0].amountMinor).toBe(18000);
    expect(priceSeats({ ...base, priceMinor: 9999, earlyBirdPriceMinor: null, earlyBirdUntil: null, siblingDiscountPercent: 15 }, "2026-12-05", 1, 1)[0]).toMatchObject({ siblingDiscountMinor: 1500, amountMinor: 8499 });
    expect(priceSeats({ ...base, siblingDiscountPercent: 100 }, "2026-12-05", 2, 0)[1].amountMinor).toBe(0);
    expect(priceSeats({ ...base, siblingDiscountPercent: null }, "2026-12-05", 2, 0)[1].amountMinor).toBe(20000);
  });
});

describe("staff setup", () => {
  it("creates a draft with private sessions and validates prices, dates and ages", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { event, sessionIds } = await mkEvent({ days: 3, publish: false, capacity: 12 });
    expect(event.status).toBe("draft");
    const ss = await db().select().from(scheduleSessions).where(inArray(scheduleSessions.id, sessionIds));
    expect(ss).toHaveLength(3);
    expect(ss.every((s) => s.visibility === "private" && s.capacity === 12 && s.title === event.name)).toBe(true);
    const bad = (over: Partial<EventInput>) => db().transaction((tx) => createEvent(tx, erin, { name: "X", kind: "camp", capacity: 5, priceMinor: 1000, ...over, sessions: [{ date: addDaysYmd(T, 5), startTime: "09:00", endTime: "10:00" }] }));
    await expect(bad({ earlyBirdPriceMinor: 1500, earlyBirdUntil: T })).rejects.toThrow(/lower than the regular price/);
    await expect(bad({ earlyBirdPriceMinor: 500 })).rejects.toThrow(/both a price and a last day/);
    await expect(bad({ siblingDiscountPercent: 150 })).rejects.toThrow(/1 to 100/);
    await expect(bad({ minAge: 14, maxAge: 10 })).rejects.toThrow(/Minimum age/);
    await expect(bad({ capacity: 0 })).rejects.toThrow(/Capacity/);
    await expect(bad({ registrationOpensOn: addDaysYmd(T, 3), registrationClosesOn: T })).rejects.toThrow(/open before it closes/);
  });

  it("only schedule managers can create, publish or see the staff list; drafts are invisible to families", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const alex = await viewerFor(ctx, "alex");
    const { event } = await mkEvent({ publish: false });
    for (const v of [marcus, alex]) {
      await expect(db().transaction((tx) => createEvent(tx, v, { name: "Nope", kind: "clinic", capacity: 5, priceMinor: 1000, sessions: [{ date: addDaysYmd(T, 5), startTime: "09:00", endTime: "10:00" }] }))).rejects.toBeInstanceOf(AuthzError);
      await expect(db().transaction((tx) => setEventStatus(tx, v, { eventId: event.id, status: "published" }))).rejects.toBeInstanceOf(AuthzError);
      await expect(listStaffEvents(db(), v)).rejects.toBeInstanceOf(AuthzError);
      await expect(eventRosterCsv(db(), v, event.id)).rejects.toBeInstanceOf(AuthzError);
    }
    expect((await listFamilyEvents(db(), alex)).some((e) => e.id === event.id)).toBe(false);
    expect(await familyEventDetail(db(), alex, event.id)).toBeNull();
    await expect(register("alex", event.id, ["maya"])).rejects.toThrow(/not found/);
  });

  it("capacity cannot drop below seats taken; publishing needs an upcoming session", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { event } = await mkEvent({ capacity: 3 });
    await register("alex", event.id, ["maya", "eli"]);
    const input: EventInput = { name: event.name, kind: "camp", capacity: 1, priceMinor: 20000 };
    await expect(db().transaction((tx) => updateEvent(tx, erin, event.id, input))).rejects.toThrow(/already taken/);
    await db().transaction((tx) => updateEvent(tx, erin, event.id, { ...input, capacity: 2 }));
    await expect(db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "draft" }))).rejects.toThrow(/Close it instead/);
    const past = await mkEvent({ startIn: -3, days: 1, publish: false });
    await expect(db().transaction((tx) => setEventStatus(tx, erin, { eventId: past.event.id, status: "published" }))).rejects.toThrow(/upcoming session/);
  });
});

describe("family registration", () => {
  it("holds the spots, creates one open invoice with the right amounts, and books nobody yet", async () => {
    const { event, sessionIds } = await mkEvent({ earlyBirdPriceMinor: 17500, earlyBirdUntil: addDaysYmd(T, 1), siblingDiscountPercent: 10, holdHours: 24 });
    const alex = await viewerFor(ctx, "alex");
    const r = await register("alex", event.id, ["maya", "eli"]);
    expect(r.created).toBe(true);
    expect(r.invoices).toHaveLength(1);
    expect(r.invoices[0]).toMatchObject({ status: "open", totalMinor: 17500 + 15750 });
    const regs = await regsOf(event.id);
    expect(regs.map((x) => x.status)).toEqual(["held", "held"]);
    expect(regs.map((x) => x.amountMinor).sort()).toEqual([15750, 17500]);
    const hoursHeld = (regs[0].holdExpiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hoursHeld).toBeGreaterThan(23.9);
    expect(hoursHeld).toBeLessThanOrEqual(24);
    const lines = await db().select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r.invoices[0].id));
    expect(lines.map((l) => l.entitlement?.eventRegistrationId).sort()).toEqual(regs.map((x) => x.id).sort());
    expect(lines.some((l) => /early bird price, sibling discount 10%/.test(l.description))).toBe(true);
    expect(await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds))).toHaveLength(0);
    // The family sees the held spots and the spots left.
    const d = (await familyEventDetail(db(), alex, event.id))!;
    expect(d.event.spotsLeft).toBe(8);
    expect(d.athletes.map((a) => [a.first, a.state])).toEqual([["Eli", "held"], ["Maya", "held"]]);
    expect(d.athletes[0].invoiceId).toBe(r.invoices[0].id);
  });

  it("is idempotent for a resubmitted form and refuses a second registration for the same athlete", async () => {
    const { event } = await mkEvent();
    const alex = await viewerFor(ctx, "alex");
    const k = key();
    const a = await db().transaction((tx) => registerForEvent(tx, alex, { eventId: event.id, athleteIds: [ctx.athletes.maya], idempotencyKey: k }));
    const b = await db().transaction((tx) => registerForEvent(tx, alex, { eventId: event.id, athleteIds: [ctx.athletes.maya], idempotencyKey: k }));
    expect(b.created).toBe(false);
    expect(b.registrationIds).toEqual(a.registrationIds);
    expect(await regsOf(event.id)).toHaveLength(1);
    await expect(register("alex", event.id, ["maya"])).rejects.toThrow(/already has a spot held/);
  });

  it("a later sibling gets the discount because the family already holds a spot", async () => {
    const { event } = await mkEvent({ siblingDiscountPercent: 20 });
    await register("alex", event.id, ["maya"]);
    const r = await register("alex", event.id, ["eli"]);
    expect(r.invoices[0].totalMinor).toBe(16000);
    // Another family pays full price.
    expect((await register("sam", event.id, ["leo"])).invoices[0].totalMinor).toBe(20000);
  });

  it("permissions: view-only payers, guardians who cannot book, other families, athletes' own logins and coaches cannot register", async () => {
    const { event } = await mkEvent();
    // Jordan can view the Parker account but not pay; Casey can neither book nor pay for Leo.
    await expect(register("jordan", event.id, ["maya"])).rejects.toBeInstanceOf(AuthzError);
    await expect(register("casey", event.id, ["leo"])).rejects.toBeInstanceOf(AuthzError);
    // Chris is an unrelated Parker: not Maya's guardian or payer.
    await expect(register("chris", event.id, ["maya"])).rejects.toBeInstanceOf(AuthzError);
    await expect(register("alex", event.id, ["leo"])).rejects.toBeInstanceOf(AuthzError);
    await expect(register("maya", event.id, ["maya"])).rejects.toBeInstanceOf(AuthzError);
    await expect(register("marcus", event.id, ["maya"])).rejects.toBeInstanceOf(AuthzError);
    expect(await regsOf(event.id)).toHaveLength(0);
    expect((await registrableAthletes(db(), await viewerFor(ctx, "jordan"))).length).toBe(0);
    expect((await registrableAthletes(db(), await viewerFor(ctx, "casey"))).length).toBe(0);
    expect((await registrableAthletes(db(), await viewerFor(ctx, "alex"))).map((a) => a.name).sort()).toEqual(["Eli Parker", "Maya Parker"]);
    // Jordan still sees the event, with a plain reason instead of a button.
    const d = (await familyEventDetail(db(), await viewerFor(ctx, "jordan"), event.id))!;
    expect(d.canRegisterAny).toBe(false);
    expect(d.athletes.every((a) => a.state === "blocked" && /cannot pay/.test(a.reasons[0]))).toBe(true);
    // Dana is an adult athlete who pays for herself.
    expect((await register("dana", event.id, ["dana"])).invoices).toHaveLength(1);
    // Front desk staff can register on a family's behalf.
    expect((await register("erin", event.id, ["leo"])).invoices[0].status).toBe("open");
  });

  it("eligibility: age limits and required forms block with plain reasons; staff may override with a reason", async () => {
    const [form] = await db().insert(formTemplates).values({ orgId: ctx.orgId, name: "Sample Camp Waiver", kind: "waiver" }).returning();
    const young = await mkEvent({ minAge: 8, maxAge: 13 });
    await expect(register("alex", young.event.id, ["maya"])).rejects.toThrow(/Maya Parker can't be registered yet: .* is for ages 13 and under\./);
    expect((await register("alex", young.event.id, ["eli"])).invoices).toHaveLength(1);
    const d = (await familyEventDetail(db(), await viewerFor(ctx, "alex"), young.event.id))!;
    expect(d.event.ages).toBe("Ages 8 to 13");
    expect(d.athletes.find((a) => a.first === "Maya")).toMatchObject({ state: "blocked" });
    expect(d.athletes.find((a) => a.first === "Maya")!.reasons[0]).toMatch(/ages 13 and under/);

    const forms = await mkEvent({ requiredFormTemplateIds: [form.id] });
    await expect(register("alex", forms.event.id, ["maya"])).rejects.toThrow(/Required form not completed \(or expired\): Sample Camp Waiver/);
    await expect(register("alex", forms.event.id, ["maya"], { override: { reason: "x" } })).rejects.toBeInstanceOf(AuthzError);
    await expect(register("erin", forms.event.id, ["maya"], { override: { reason: " " } })).rejects.toThrow(/reason is required/);
    expect((await register("erin", forms.event.id, ["maya"], { override: { reason: "Paper waiver on file" } })).invoices).toHaveLength(1);
  });

  it("registration window, closed status and a started event all refuse with a clear message", async () => {
    const erin = await viewerFor(ctx, "erin");
    const notYet = await mkEvent({ registrationOpensOn: addDaysYmd(T, 2) });
    await expect(register("alex", notYet.event.id, ["maya"])).rejects.toThrow(/Registration opens/);
    const over = await mkEvent({ registrationClosesOn: addDaysYmd(T, -1) });
    await expect(register("alex", over.event.id, ["maya"])).rejects.toThrow(/Registration is closed/);
    const closed = await mkEvent();
    await db().transaction((tx) => setEventStatus(tx, erin, { eventId: closed.event.id, status: "closed" }));
    await expect(register("alex", closed.event.id, ["maya"])).rejects.toThrow(/Registration is closed/);
    expect((await listFamilyEvents(db(), await viewerFor(ctx, "alex"))).some((e) => e.id === closed.event.id)).toBe(false);
    const started = await mkEvent();
    await expect(register("alex", started.event.id, ["maya"], { now: new Date(Date.now() + 11 * 86_400_000) })).rejects.toThrow(/already started/);
  });
});

describe("capacity", () => {
  it("10 concurrent registrations for 3 spots: exactly 3 hold a spot, the rest are told it is full", async () => {
    const { event } = await mkEvent({ capacity: 3 });
    const erin = await viewerFor(ctx, "erin");
    const keys = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson", "eli", "harper"];
    const results = await Promise.allSettled(keys.map((k) => db().transaction((tx) => registerForEvent(tx, erin, { eventId: event.id, athleteIds: [ctx.athletes[k]], idempotencyKey: key() }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(String(r.reason.message)).toMatch(/This camp is full/);
    const regs = await regsOf(event.id);
    expect(regs).toHaveLength(3);
    expect(new Set(regs.map((r) => r.invoiceId)).size).toBe(3);
    const open = await db().select().from(invoices).where(and(inArray(invoices.id, regs.map((r) => r.invoiceId!)), eq(invoices.status, "open")));
    expect(open).toHaveLength(3);
    const fam = (await listFamilyEvents(db(), await viewerFor(ctx, "chris"))).find((e) => e.id === event.id)!;
    expect(fam.spotsLeft).toBe(0);
  });

  it("the same athlete submitted twice at once is registered once; a family asking for more spots than are left is refused whole", async () => {
    const { event } = await mkEvent({ capacity: 2 });
    const alex = await viewerFor(ctx, "alex");
    const twice = await Promise.allSettled([0, 1, 2].map(() => db().transaction((tx) => registerForEvent(tx, alex, { eventId: event.id, athleteIds: [ctx.athletes.maya], idempotencyKey: key() }))));
    expect(twice.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await regsOf(event.id)).toHaveLength(1);
    const one = await mkEvent({ capacity: 1 });
    await expect(register("alex", one.event.id, ["maya", "eli"])).rejects.toThrow(/Only 1 spot is left, and you chose 2 athletes/);
    expect(await regsOf(one.event.id)).toHaveLength(0);
  });
});

describe("confirmation only on settled payment", () => {
  it("money in flight, a partial payment and the grant-on-pending path never confirm; full settlement does and books every session without credits", async () => {
    const { event, sessionIds } = await mkEvent({ days: 3 });
    const r = await register("alex", event.id, ["maya"]);
    const invoiceId = r.invoices[0].id;
    const [reg] = await regsOf(event.id);
    const status = async () => (await regsOf(event.id))[0].status;
    const ledgerBefore = await db().select().from(creditLedger).where(eq(creditLedger.athleteId, ctx.athletes.maya));

    // A provider payment that is still processing (what a bank debit looks like before it settles).
    const [inv] = await db().select().from(invoices).where(eq(invoices.id, invoiceId));
    const [pending] = await db()
      .insert(transactions)
      .values({ orgId: ctx.orgId, payerAccountId: inv.payerAccountId, invoiceId, kind: "charge", status: "pending", amountMinor: 20000, currency: "USD", provider: "stripe", providerTxnId: `pi_test_${key()}`, verification: "provider_verified" })
      .returning();
    await db().transaction((tx) => settleInvoiceIfCovered(tx, invoiceId, SYSTEM));
    // The org policy "grant on pending" applies entitlements early for credits; it must not confirm a seat.
    await db().transaction((tx) => applyInvoiceEntitlements(tx, invoiceId, SYSTEM));
    expect(await status()).toBe("held");
    await db().update(transactions).set({ status: "failed" }).where(eq(transactions.id, pending.id));

    expect((await pay(invoiceId, 5000)).invoicePaid).toBe(false);
    expect(await status()).toBe("held");
    expect(await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds))).toHaveLength(0);

    expect((await pay(invoiceId, 15000)).invoicePaid).toBe(true);
    const [done] = await regsOf(event.id);
    expect(done).toMatchObject({ id: reg.id, status: "confirmed", holdExpiresAt: null });
    expect(done.confirmedAt).toBeInstanceOf(Date);
    const bs = await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds));
    expect(bs).toHaveLength(3);
    expect(bs.every((b) => b.status === "booked" && b.athleteId === ctx.athletes.maya && b.entitlementSource === "drop_in_invoice" && b.creditBucketId === null && b.membershipId === null)).toBe(true);
    // No membership credit was reserved or used.
    expect(await db().select().from(creditLedger).where(eq(creditLedger.athleteId, ctx.athletes.maya))).toHaveLength(ledgerBefore.length);
    // Settling again changes nothing.
    await db().transaction((tx) => settleInvoiceIfCovered(tx, invoiceId, SYSTEM));
    expect(await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds))).toHaveLength(3);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, reg.id), eq(auditEvents.action, "events.registration.confirm")));
    expect(audits).toHaveLength(1);
  });

  it("a verified provider charge that settles confirms every athlete on the invoice", async () => {
    const { event, sessionIds } = await mkEvent({ days: 2, siblingDiscountPercent: 10 });
    const r = await register("alex", event.id, ["maya", "eli"]);
    const [inv] = await db().select().from(invoices).where(eq(invoices.id, r.invoices[0].id));
    await db().insert(transactions).values({ orgId: ctx.orgId, payerAccountId: inv.payerAccountId, invoiceId: inv.id, kind: "charge", status: "settled", amountMinor: inv.totalMinor, currency: "USD", provider: "stripe", providerTxnId: `pi_test_${key()}`, verification: "provider_verified", settledAt: new Date() });
    expect((await db().transaction((tx) => settleInvoiceIfCovered(tx, inv.id, SYSTEM))).paid).toBe(true);
    expect((await regsOf(event.id)).map((x) => x.status)).toEqual(["confirmed", "confirmed"]);
    expect(await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds))).toHaveLength(4);
    const staff = (await staffEventDetail(db(), await viewerFor(ctx, "erin"), event.id))!;
    expect(staff.counts).toMatchObject({ confirmed: 2, held: 0, paidMinor: 38000 });
    expect(staff.netRevenueMinor).toBe(38000);
  });

  it("a free event confirms at once through the same settlement path; a session added later books confirmed athletes", async () => {
    const { event, sessionIds } = await mkEvent({ priceMinor: 0, days: 1 });
    const r = await register("alex", event.id, ["maya"]);
    expect(r.invoices[0]).toMatchObject({ status: "paid", totalMinor: 0 });
    expect((await regsOf(event.id))[0].status).toBe("confirmed");
    const erin = await viewerFor(ctx, "erin");
    const added = await db().transaction((tx) => addEventSession(tx, erin, { eventId: event.id, session: { date: addDaysYmd(T, 20), startTime: "09:00", endTime: "10:00" } }));
    const bs = await db().select().from(bookings).where(inArray(bookings.sessionId, [...sessionIds, added]));
    expect(bs.map((b) => b.status)).toEqual(["booked", "booked"]);
  });

  it("event sessions cannot be booked by a family with credits (the only way in is the registration)", async () => {
    const { sessionIds } = await mkEvent();
    const alex = await viewerFor(ctx, "alex");
    await expect(db().transaction((tx) => bookSession(tx, alex, { sessionId: sessionIds[0], athleteId: ctx.athletes.maya }))).rejects.toThrow(/isn't open for online booking/);
  });
});

describe("unpaid holds", () => {
  it("an expired hold releases the spot and voids the unpaid invoice; another family can then register", async () => {
    const { event } = await mkEvent({ capacity: 1, holdHours: 2 });
    const r = await register("alex", event.id, ["maya"]);
    await expect(register("sam", event.id, ["leo"])).rejects.toThrow(/full/);
    // Before the hold runs out nothing is released.
    expect(await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, new Date(Date.now() + 60 * 60_000)))).toBe(0);
    // Sam registers three hours later: Alex's hold has lapsed and is released inside the same transaction.
    const later = new Date(Date.now() + 3 * 3_600_000);
    const s = await register("sam", event.id, ["leo"], { now: later });
    expect(s.invoices[0].status).toBe("open");
    const regs = await regsOf(event.id);
    expect(regs.find((x) => x.athleteId === ctx.athletes.maya)!.status).toBe("expired");
    expect(regs.find((x) => x.athleteId === ctx.athletes.leo)!.status).toBe("held");
    const [old] = await db().select().from(invoices).where(eq(invoices.id, r.invoices[0].id));
    expect(old.status).toBe("void");
    // The voided invoice can no longer be paid, so the lapsed registration can never be confirmed late.
    await expect(pay(old.id, 20000)).rejects.toThrow(/open invoices/);
    // Alex may register again while a spot is free (none is now).
    await expect(register("alex", event.id, ["maya"], { now: later })).rejects.toThrow(/full/);
  });

  it("a hold is never released while money is recorded or a checkout is in flight, and never past the first session", async () => {
    const { event } = await mkEvent({ capacity: 2, holdHours: 1, startIn: 10 });
    const a = await register("alex", event.id, ["maya"]);
    const b = await register("sam", event.id, ["leo"]);
    await pay(a.invoices[0].id, 5000); // part paid
    await db().insert(paymentAttempts).values({ orgId: ctx.orgId, invoiceId: b.invoices[0].id, provider: "stripe", amountMinor: 20000, currency: "USD", status: "processing", idempotencyKey: `checkout:${key()}` });
    const later = new Date(Date.now() + 5 * 3_600_000);
    await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, later));
    expect((await regsOf(event.id)).map((x) => x.status)).toEqual(["held", "held"]);
    // The part-paid family finishes paying after the hold time: still confirmed, the spot was never given away.
    await pay(a.invoices[0].id, 15000);
    expect((await regsOf(event.id)).find((x) => x.athleteId === ctx.athletes.maya)!.status).toBe("confirmed");

    const soon = await mkEvent({ startIn: 1, days: 1, holdHours: 720 });
    await register("alex", soon.event.id, ["maya"]);
    const [reg] = await regsOf(soon.event.id);
    const [first] = await db().select().from(scheduleSessions).where(eq(scheduleSessions.id, soon.sessionIds[0]));
    expect(reg.holdExpiresAt!.getTime()).toBe(first.startsAt.getTime());
  });

  it("when staff void the invoice by hand, the spot is released on the next sweep", async () => {
    const { event } = await mkEvent({ capacity: 1 });
    const erin = await viewerFor(ctx, "erin");
    const r = await register("alex", event.id, ["maya"]);
    await db().transaction((tx) => voidInvoice(tx, erin, r.invoices[0].id, "Family changed their mind"));
    expect(await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId))).toBe(1);
    expect((await regsOf(event.id))[0].status).toBe("expired");
    expect((await register("sam", event.id, ["leo"])).invoices).toHaveLength(1);
  });
});

describe("staff cancellation", () => {
  it("unpaid: releases the spot and voids the invoice; with a sibling still held, a new invoice is issued for the sibling only", async () => {
    const { event } = await mkEvent({ capacity: 2, siblingDiscountPercent: 10 });
    const erin = await viewerFor(ctx, "erin");
    const r = await register("alex", event.id, ["maya", "eli"]);
    const regs = await regsOf(event.id);
    const eli = regs.find((x) => x.athleteId === ctx.athletes.eli)!;
    const maya = regs.find((x) => x.athleteId === ctx.athletes.maya)!;
    await expect(db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: eli.id, reason: "" }))).rejects.toThrow(/reason is required/);
    await expect(db().transaction(async (tx) => cancelEventRegistration(tx, await viewerFor(ctx, "alex"), { registrationId: eli.id, reason: "x" }))).rejects.toBeInstanceOf(AuthzError);
    const out = await db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: eli.id, reason: "Schedule conflict" }));
    expect(out.outcome).toBe("reissued");
    const [old] = await db().select().from(invoices).where(eq(invoices.id, r.invoices[0].id));
    expect(old.status).toBe("void");
    const [mayaNow] = await db().select().from(eventRegistrations).where(eq(eventRegistrations.id, maya.id));
    expect(mayaNow.status).toBe("held");
    expect(mayaNow.invoiceId).not.toBe(old.id);
    const [fresh] = await db().select().from(invoices).where(eq(invoices.id, mayaNow.invoiceId!));
    expect(fresh).toMatchObject({ status: "open", totalMinor: maya.amountMinor });
    // The released spot is available again.
    expect((await register("sam", event.id, ["leo"])).invoices).toHaveLength(1);
    // Paying the reissued invoice confirms Maya.
    await pay(fresh.id, fresh.totalMinor);
    expect((await db().select().from(eventRegistrations).where(eq(eventRegistrations.id, maya.id)))[0].status).toBe("confirmed");
    const leoId = (await regsOf(event.id)).find((x) => x.athleteId === ctx.athletes.leo)!.id;
    const last = await db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: leoId, reason: "No longer coming" }));
    expect(last.outcome).toBe("voided");
  });

  it("paid: releases the spot and removes upcoming bookings, but leaves the invoice and the money to the refund flow", async () => {
    const { event, sessionIds } = await mkEvent({ capacity: 1, days: 2 });
    const erin = await viewerFor(ctx, "erin");
    const r = await register("alex", event.id, ["maya"]);
    await pay(r.invoices[0].id, 20000);
    const [reg] = await regsOf(event.id);
    const out = await db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: reg.id, reason: "Injury" }));
    expect(out.outcome).toBe("paid_refund_separately");
    const [inv] = await db().select().from(invoices).where(eq(invoices.id, r.invoices[0].id));
    expect(inv.status).toBe("paid");
    expect(await db().select().from(transactions).where(and(eq(transactions.invoiceId, inv.id), eq(transactions.kind, "refund")))).toHaveLength(0);
    const bs = await db().select().from(bookings).where(inArray(bookings.sessionId, sessionIds));
    expect(bs.map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
    expect((await regsOf(event.id))[0]).toMatchObject({ status: "cancelled", cancelReason: "Injury" });
    // Spot is free again, and the same athlete can come back later.
    expect((await register("sam", event.id, ["leo"])).invoices).toHaveLength(1);
    await expect(db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: reg.id, reason: "again" }))).rejects.toThrow(/already cancelled/);
    // Revenue still shows the payment until a refund is recorded by the existing refund flow.
    const staff = (await staffEventDetail(db(), erin, event.id))!;
    expect(staff.counts.paidMinor).toBe(20000);
  });

  it("a payment that lands on a cancelled registration does not re-seat the athlete; staff get a task", async () => {
    const { event } = await mkEvent({ capacity: 1 });
    const erin = await viewerFor(ctx, "erin");
    const r = await register("alex", event.id, ["maya"]);
    await pay(r.invoices[0].id, 5000);
    const [reg] = await regsOf(event.id);
    const out = await db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: reg.id, reason: "Asked to cancel" }));
    expect(out.outcome).toBe("open_with_payments");
    await pay(r.invoices[0].id, 15000);
    expect((await regsOf(event.id))[0].status).toBe("cancelled");
    const t = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), like(tasks.dedupeKey, `%event-paid-released:${reg.id}`)));
    expect(t).toHaveLength(1);
  });
});

describe("staff views", () => {
  it("lists registrations with paid/unpaid, revenue, and a roster CSV that is safe to open in a spreadsheet", async () => {
    const { event } = await mkEvent({ capacity: 5 });
    const erin = await viewerFor(ctx, "erin");
    const a = await register("alex", event.id, ["maya"]);
    await register("sam", event.id, ["leo"]);
    await pay(a.invoices[0].id, 20000);
    const row = (await listStaffEvents(db(), erin)).rows.find((x) => x.event.id === event.id)!;
    expect(row).toMatchObject({ spotsLeft: 3, netRevenueMinor: 20000, refundedMinor: 0 });
    expect(row.counts).toMatchObject({ confirmed: 1, held: 1, heldMinor: 20000, paidMinor: 20000 });
    const { csv, filename } = (await eventRosterCsv(db(), erin, event.id))!;
    expect(filename).toMatch(/^roster-sample-camp-.*\.csv$/);
    const lines = csv.split(/\r?\n/);
    expect(lines[0]).toBe("Athlete,Age at start,Registration,Payment,Amount,Invoice,Billing account,Billing email,Registered on");
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.startsWith("Maya Parker"))).toMatch(/Maya Parker,15,Confirmed,Paid,200\.00,TW-/);
    expect(lines.find((l) => l.startsWith("Leo Rivera"))).toMatch(/Leo Rivera,16,Spot held,Unpaid,200\.00,TW-/);
    // Another organization's staff cannot read it.
    const other = await seedOrg(T, { modules: [] });
    expect(await staffEventDetail(db(), await viewerFor(other, "erin"), event.id)).toBeNull();
    expect(await eventRosterCsv(db(), await viewerFor(other, "erin"), event.id)).toBeNull();
    await expect(db().transaction(async (tx) => registerForEvent(tx, await viewerFor(other, "erin"), { eventId: event.id, athleteIds: [other.athletes.maya], idempotencyKey: key() }))).rejects.toThrow(/not found/);
    expect(await db().select().from(events).where(eq(events.orgId, other.orgId))).toHaveLength(0);
  });
});
