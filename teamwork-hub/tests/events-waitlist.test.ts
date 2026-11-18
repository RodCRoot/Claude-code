import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gt, inArray, like } from "drizzle-orm";
import { auditEvents, eventRegistrations, eventWaitlistEntries, formTemplates, invoices, jobs, messageDeliveries, messages, threads } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { recordManualPayment } from "@/lib/billing/invoices";
import { seatsTaken } from "@/lib/events/confirm";
import { createEvent, setEventStatus, updateEvent, type EventInput } from "@/lib/events/events";
import { familyEventDetail, listFamilyEvents, staffEventDetail } from "@/lib/events/queries";
import { cancelEventRegistration, registerForEvent, releaseExpiredHolds } from "@/lib/events/registration";
import { acceptWaitlistOffer, joinEventWaitlist, leaveEventWaitlist, moveWaitlistEntry, removeWaitlistEntry, staffWaitlist } from "@/lib/events/waitlist";
import { EVENT_HOLDS_NIGHTLY_JOB, NIGHTLY_JOB_TYPES, SCHEDULED_JOBS, scheduledJobHandlers } from "@/lib/scheduled/jobs";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const key = () => randomUUID();
const H = 3_600_000;

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing"] });
});
afterAll(closeTestDb);

/** A published sample event. Prices are test values, not real prices. */
async function mkEvent(over: Partial<EventInput> & { startIn?: number } = {}) {
  const erin = await viewerFor(ctx, "erin");
  const { startIn = 10, ...input } = over;
  const sessions = [{ date: addDaysYmd(T, startIn), startTime: "09:00", endTime: "11:00" }];
  const { event } = await db().transaction((tx) => createEvent(tx, erin, { name: `Sample Clinic ${randomUUID().slice(0, 6)}`, kind: "clinic", capacity: 1, priceMinor: 5000, ...input, sessions }));
  await db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "published" }));
  return event;
}
const A = (k: string) => ctx.athletes[k];
const register = async (who: string, eventId: string, athletes: string[], now?: Date) => {
  const v = await viewerFor(ctx, who);
  return db().transaction((tx) => registerForEvent(tx, v, { eventId, athleteIds: athletes.map(A), idempotencyKey: key(), now }));
};
const join = async (who: string, eventId: string, athletes: string[], extra: { now?: Date; override?: { reason: string } } = {}) => {
  const v = await viewerFor(ctx, who);
  return db().transaction((tx) => joinEventWaitlist(tx, v, { eventId, athleteIds: athletes.map(A), ...extra }));
};
const cancel = async (eventId: string, athlete: string, now?: Date) => {
  const erin = await viewerFor(ctx, "erin");
  const [reg] = await db().select().from(eventRegistrations).where(and(eq(eventRegistrations.eventId, eventId), eq(eventRegistrations.athleteId, A(athlete)), inArray(eventRegistrations.status, ["held", "confirmed"])));
  return db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: reg.id, reason: "test: family asked to cancel", now }));
};
const entries = (eventId: string) => db().select().from(eventWaitlistEntries).where(eq(eventWaitlistEntries.eventId, eventId));
const entryOf = async (eventId: string, athlete: string) => (await entries(eventId)).filter((e) => e.athleteId === A(athlete)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
const liveRegs = (eventId: string) => db().select().from(eventRegistrations).where(and(eq(eventRegistrations.eventId, eventId), inArray(eventRegistrations.status, ["held", "confirmed"])));
/** The invariant every test ends on: registrations plus live offers never exceed capacity. */
async function neverOversold(eventId: string, capacity: number) {
  const regs = await liveRegs(eventId);
  const offers = (await entries(eventId)).filter((e) => e.status === "offered");
  expect(regs.length + offers.length).toBeLessThanOrEqual(capacity);
  expect(await seatsTaken(db(), eventId)).toBe(regs.length + offers.length);
}

describe("joining", () => {
  it("is only possible when the event is full, with the same permission and eligibility checks as registering", async () => {
    const event = await mkEvent({ capacity: 1, minAge: 8 });
    await expect(join("alex", event.id, ["maya"])).rejects.toThrow(/has 1 spot open\. Register instead/);
    await register("dana", event.id, ["dana"]);

    // Jordan can view but not pay; Casey can neither book nor pay; Chris is another family; a coach is not billing staff.
    for (const [who, athlete] of [["jordan", "maya"], ["casey", "leo"], ["chris", "maya"], ["alex", "leo"], ["maya", "maya"], ["marcus", "maya"]]) {
      await expect(join(who, event.id, [athlete]), `${who} for ${athlete}`).rejects.toBeInstanceOf(AuthzError);
    }
    expect(await entries(event.id)).toHaveLength(0);

    const r = await join("alex", event.id, ["maya", "eli"]);
    expect(r.positions).toEqual([1, 2]);
    await expect(join("alex", event.id, ["maya"])).rejects.toThrow(/already on the waitlist/);
    await expect(join("dana", event.id, ["dana"])).rejects.toThrow(/already has a spot/);
    // Front desk staff can add an athlete on a family's behalf.
    expect((await join("erin", event.id, ["leo"])).positions).toEqual([3]);
    // Joining charges nothing and creates no bill.
    expect(await db().select().from(invoices).where(and(eq(invoices.orgId, ctx.orgId), like(invoices.memo, `%${event.name}%`)))).toHaveLength(1); // Dana's only
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "events.waitlist.join")));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses ineligible athletes with the plain reason; staff may override with a reason", async () => {
    const [form] = await db().insert(formTemplates).values({ orgId: ctx.orgId, name: "Sample Clinic Waiver", kind: "waiver" }).returning();
    const event = await mkEvent({ capacity: 1, requiredFormTemplateIds: [form.id] });
    const erin = await viewerFor(ctx, "erin");
    await db().transaction((tx) => registerForEvent(tx, erin, { eventId: event.id, athleteIds: [A("dana")], idempotencyKey: key(), override: { reason: "Paper waiver on file" } }));
    await expect(join("alex", event.id, ["maya"])).rejects.toThrow(/Maya Parker can't join the waitlist yet: .*Sample Clinic Waiver/);
    await expect(join("alex", event.id, ["maya"], { override: { reason: "x" } })).rejects.toBeInstanceOf(AuthzError);
    expect((await join("erin", event.id, ["maya"], { override: { reason: "Paper waiver on file" } })).positions).toEqual([1]);
  });

  it("a closed or started event takes no new waitlist entries", async () => {
    const erin = await viewerFor(ctx, "erin");
    const event = await mkEvent({ capacity: 1 });
    await register("dana", event.id, ["dana"]);
    await expect(join("alex", event.id, ["maya"], { now: new Date(Date.now() + 11 * 86_400_000) })).rejects.toThrow(/already started/);
    await db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "closed" }));
    await expect(join("alex", event.id, ["maya"])).rejects.toThrow(/Registration is closed/);
  });
});

describe("a released spot is offered, never auto-charged", () => {
  it("cancelling a registration offers the spot to the first in line with an expiry; no bill, no message, and the seat is reserved", async () => {
    const event = await mkEvent({ capacity: 1, waitlistOfferHours: 6 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    const since = new Date();
    await cancel(event.id, "dana");

    const maya = await entryOf(event.id, "maya");
    expect(maya.status).toBe("offered");
    const hours = (maya.offerExpiresAt!.getTime() - Date.now()) / H;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThanOrEqual(6);
    expect((await entryOf(event.id, "leo")).status).toBe("waiting");

    // Not charged, not registered, not messaged.
    expect(await liveRegs(event.id)).toHaveLength(0);
    expect(await db().select().from(eventRegistrations).where(and(eq(eventRegistrations.eventId, event.id), eq(eventRegistrations.athleteId, A("maya"))))).toHaveLength(0);
    const newMsgs = await db().select({ id: messages.id }).from(messages).innerJoin(threads, eq(threads.id, messages.threadId)).where(and(eq(threads.orgId, ctx.orgId), gt(messages.createdAt, since)));
    expect(newMsgs).toHaveLength(0);
    expect(await db().select().from(messageDeliveries).where(gt(messageDeliveries.updatedAt, since)).innerJoin(messages, eq(messages.id, messageDeliveries.messageId)).innerJoin(threads, and(eq(threads.id, messages.threadId), eq(threads.orgId, ctx.orgId)))).toHaveLength(0);
    expect(await db().select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.type, "messaging.deliver"), gt(jobs.createdAt, since)))).toHaveLength(0);

    // The offered seat is reserved: another family cannot register into it, and the page says full.
    await expect(register("chris", event.id, ["ava"])).rejects.toThrow(/full/);
    await expect(register("sam", event.id, ["leo"])).rejects.toThrow(/full/);
    const chris = (await listFamilyEvents(db(), await viewerFor(ctx, "chris"))).find((e) => e.id === event.id)!;
    expect(chris.spotsLeft).toBe(0);
    expect(chris.waitlist).toHaveLength(0); // other families' entries are never shown
    await neverOversold(event.id, 1);

    // The family sees its own offer and place.
    const alexView = (await familyEventDetail(db(), await viewerFor(ctx, "alex"), event.id))!;
    expect(alexView.athletes.find((a) => a.first === "Maya")).toMatchObject({ state: "offered", canAct: true, entryId: maya.id });
    const samView = (await familyEventDetail(db(), await viewerFor(ctx, "sam"), event.id))!;
    expect(samView.athletes.find((a) => a.first === "Leo")).toMatchObject({ state: "waitlisted", place: 1 });
    // Jordan (view only) sees the offer but may not act on it.
    const jordanView = (await familyEventDetail(db(), await viewerFor(ctx, "jordan"), event.id))!;
    expect(jordanView.athletes.find((a) => a.first === "Maya")).toMatchObject({ state: "offered", canAct: false });
    const [offerAudit] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, maya.id), eq(auditEvents.action, "events.waitlist.offer")));
    expect(offerAudit.summary).toMatch(/Nothing was charged and no message was sent/);
  });

  it("accepting creates the normal held registration and bill; paying it confirms; the entry points at the registration", async () => {
    const event = await mkEvent({ capacity: 1, priceMinor: 5000 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await cancel(event.id, "dana");
    const offer = await entryOf(event.id, "maya");
    const alex = await viewerFor(ctx, "alex");
    // Only someone who could register Maya may accept.
    for (const who of ["jordan", "chris", "sam", "marcus"]) {
      const v = await viewerFor(ctx, who);
      await expect(db().transaction((tx) => acceptWaitlistOffer(tx, v, { entryId: offer.id, idempotencyKey: key() })), who).rejects.toBeInstanceOf(AuthzError);
    }
    const k = key();
    const r = await db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: offer.id, idempotencyKey: k }));
    expect(r.invoices).toHaveLength(1);
    expect(r.invoices[0]).toMatchObject({ status: "open", totalMinor: 5000 });
    const [reg] = await liveRegs(event.id);
    expect(reg).toMatchObject({ athleteId: A("maya"), status: "held", amountMinor: 5000 });
    const after = await entryOf(event.id, "maya");
    expect(after).toMatchObject({ status: "accepted", registrationId: reg.id });
    // A second tap with the same form key returns the same registration.
    const again = await db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: offer.id, idempotencyKey: k }));
    expect(again.registrationIds).toEqual(r.registrationIds);
    expect(await liveRegs(event.id)).toHaveLength(1);

    const erin = await viewerFor(ctx, "erin");
    await db().transaction((tx) => recordManualPayment(tx, erin, { invoiceId: r.invoices[0].id, amountMinor: 5000, method: "cash", reference: "test receipt" }));
    expect((await liveRegs(event.id))[0].status).toBe("confirmed");
    await neverOversold(event.id, 1);
  });

  it("an accepted spot that is then not paid is released like any hold, and offered to the next in line", async () => {
    const event = await mkEvent({ capacity: 1, holdHours: 2 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await cancel(event.id, "dana");
    const alex = await viewerFor(ctx, "alex");
    await db().transaction(async (tx) => acceptWaitlistOffer(tx, alex, { entryId: (await entryOf(event.id, "maya")).id, idempotencyKey: key() }));
    expect((await entryOf(event.id, "leo")).status).toBe("waiting");
    // Three hours later the unpaid hold has lapsed: the hold-release path frees it and offers it to Leo.
    const later = new Date(Date.now() + 3 * H);
    expect(await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, later))).toBe(1);
    expect((await liveRegs(event.id))).toHaveLength(0);
    expect((await entryOf(event.id, "leo")).status).toBe("offered");
    await neverOversold(event.id, 1);
  });
});

describe("expiry and declining pass the spot on", () => {
  it("an offer that runs out goes to the next in line, through the hold-release path and the nightly job", async () => {
    const event = await mkEvent({ capacity: 1, waitlistOfferHours: 24 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await join("chris", event.id, ["ava"]);
    await cancel(event.id, "dana");
    const first = await entryOf(event.id, "maya");

    // One hour before expiry nothing moves.
    await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, new Date(first.offerExpiresAt!.getTime() - H)));
    expect((await entryOf(event.id, "maya")).status).toBe("offered");
    expect((await entryOf(event.id, "leo")).status).toBe("waiting");

    // After expiry: the same sweep that releases unpaid holds passes the offer on.
    const t1 = new Date(first.offerExpiresAt!.getTime() + 60_000);
    await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, t1));
    expect((await entryOf(event.id, "maya")).status).toBe("expired");
    const leo = await entryOf(event.id, "leo");
    expect(leo.status).toBe("offered");
    expect(leo.offerExpiresAt!.getTime()).toBe(t1.getTime() + 24 * H);
    // The expired offer can no longer be accepted.
    const alex = await viewerFor(ctx, "alex");
    await expect(db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: first.id, idempotencyKey: key() }))).rejects.toThrow(/run out/);

    // The nightly job is registered and does the same thing.
    expect(NIGHTLY_JOB_TYPES).toContain(EVENT_HOLDS_NIGHTLY_JOB);
    expect(SCHEDULED_JOBS.find((j) => j.type === EVENT_HOLDS_NIGHTLY_JOB)!.does).toMatch(/Charges nothing and sends nothing/);
    const handler = scheduledJobHandlers(db())[EVENT_HOLDS_NIGHTLY_JOB];
    expect(typeof handler).toBe("function");
    const { runEventHoldsNightly } = await import("@/lib/scheduled/jobs");
    await runEventHoldsNightly(db(), ctx.orgId, { now: new Date(leo.offerExpiresAt!.getTime() + 60_000) });
    expect((await entryOf(event.id, "leo")).status).toBe("expired");
    expect((await entryOf(event.id, "ava")).status).toBe("offered");
    await neverOversold(event.id, 1);

    // An accept that arrives after the time is refused even before any sweep has run.
    const ava = await entryOf(event.id, "ava");
    const chris = await viewerFor(ctx, "chris");
    await expect(db().transaction((tx) => acceptWaitlistOffer(tx, chris, { entryId: ava.id, idempotencyKey: key(), now: new Date(ava.offerExpiresAt!.getTime() + 1000) }))).rejects.toThrow(/run out/);
  });

  it("an offer never outlasts the start of the event, and nothing is offered once it has started", async () => {
    const event = await mkEvent({ capacity: 1, startIn: 1, waitlistOfferHours: 720 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await cancel(event.id, "dana");
    const maya = await entryOf(event.id, "maya");
    const d = (await staffEventDetail(db(), await viewerFor(ctx, "erin"), event.id))!;
    expect(maya.offerExpiresAt!.getTime()).toBe(d.sessions[0].startsAt.getTime());
    await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, new Date(d.sessions[0].startsAt.getTime() + H)));
    expect((await entryOf(event.id, "maya")).status).toBe("expired");
    expect((await entryOf(event.id, "leo")).status).toBe("waiting"); // too late to offer
  });

  it("declining an offer passes it on at once; leaving the line needs the same permission", async () => {
    const event = await mkEvent({ capacity: 1 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await cancel(event.id, "dana");
    const maya = await entryOf(event.id, "maya");
    for (const who of ["jordan", "chris", "marcus"]) {
      const v = await viewerFor(ctx, who);
      await expect(db().transaction((tx) => leaveEventWaitlist(tx, v, { entryId: maya.id })), who).rejects.toBeInstanceOf(AuthzError);
    }
    const alex = await viewerFor(ctx, "alex");
    await db().transaction((tx) => leaveEventWaitlist(tx, alex, { entryId: maya.id }));
    expect((await entryOf(event.id, "maya")).status).toBe("declined");
    expect((await entryOf(event.id, "leo")).status).toBe("offered");
    await expect(db().transaction((tx) => leaveEventWaitlist(tx, alex, { entryId: maya.id }))).rejects.toThrow(/not on the waitlist/);
    // Alex may join again at the back while it is still full.
    expect((await join("alex", event.id, ["maya"])).positions).toEqual([1]);
    await neverOversold(event.id, 1);
  });

  it("more capacity, or an expired unpaid hold, also triggers an offer", async () => {
    const erin = await viewerFor(ctx, "erin");
    const event = await mkEvent({ capacity: 1, holdHours: 2 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await db().transaction((tx) => updateEvent(tx, erin, event.id, { name: event.name, kind: "clinic", capacity: 2, priceMinor: 5000, holdHours: 2 }));
    expect((await entryOf(event.id, "maya")).status).toBe("offered");
    expect((await entryOf(event.id, "leo")).status).toBe("waiting");
    // Capacity cannot be cut below registrations plus live offers.
    await expect(db().transaction((tx) => updateEvent(tx, erin, event.id, { name: event.name, kind: "clinic", capacity: 1, priceMinor: 5000 }))).rejects.toThrow(/2 spots are already taken/);
    // Dana's unpaid hold lapses: the sweep offers her seat to Leo.
    await db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, new Date(Date.now() + 3 * H)));
    expect((await entryOf(event.id, "leo")).status).toBe("offered");
    await neverOversold(event.id, 2);
  });
});

describe("staff", () => {
  it("see the line, reorder it and remove entries with a reason; coaches and families cannot", async () => {
    const event = await mkEvent({ capacity: 1 });
    const erin = await viewerFor(ctx, "erin");
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await join("chris", event.id, ["ava"]);
    const names = async () => (await staffWaitlist(db(), erin, event.id)).filter((w) => w.status === "waiting").map((w) => `${w.place}:${w.athleteName.split(" ")[0]}`);
    expect(await names()).toEqual(["1:Maya", "2:Leo", "3:Ava"]);

    for (const who of ["marcus", "alex"]) {
      const v = await viewerFor(ctx, who);
      await expect(staffWaitlist(db(), v, event.id), who).rejects.toBeInstanceOf(AuthzError);
      await expect(db().transaction(async (tx) => moveWaitlistEntry(tx, v, { entryId: (await entryOf(event.id, "ava")).id, direction: "up" })), who).rejects.toBeInstanceOf(AuthzError);
      await expect(db().transaction(async (tx) => removeWaitlistEntry(tx, v, { entryId: (await entryOf(event.id, "ava")).id, reason: "x" })), who).rejects.toBeInstanceOf(AuthzError);
    }

    const ava = await entryOf(event.id, "ava");
    await db().transaction((tx) => moveWaitlistEntry(tx, erin, { entryId: ava.id, direction: "up" }));
    await db().transaction((tx) => moveWaitlistEntry(tx, erin, { entryId: ava.id, direction: "up" }));
    expect(await names()).toEqual(["1:Ava", "2:Maya", "3:Leo"]);
    expect((await db().transaction((tx) => moveWaitlistEntry(tx, erin, { entryId: ava.id, direction: "up" }))).moved).toBe(false);
    await db().transaction(async (tx) => moveWaitlistEntry(tx, erin, { entryId: (await entryOf(event.id, "maya")).id, direction: "down" }));
    expect(await names()).toEqual(["1:Ava", "2:Leo", "3:Maya"]);
    const positions = (await entries(event.id)).filter((e) => e.status === "waiting").map((e) => e.position);
    expect(new Set(positions).size).toBe(positions.length);

    await expect(db().transaction((tx) => removeWaitlistEntry(tx, erin, { entryId: ava.id, reason: " " }))).rejects.toThrow(/reason is required/);
    await db().transaction((tx) => removeWaitlistEntry(tx, erin, { entryId: ava.id, reason: "Moved away" }));
    expect(await names()).toEqual(["1:Leo", "2:Maya"]);
    expect((await entryOf(event.id, "ava"))).toMatchObject({ status: "removed", closedReason: "Moved away", closedByUserId: erin.userId });

    // The reordered line is the order offers follow.
    await cancel(event.id, "dana");
    expect((await entryOf(event.id, "leo")).status).toBe("offered");
    expect((await entryOf(event.id, "maya")).status).toBe("waiting");
    // Removing an offered entry passes the spot on.
    await db().transaction(async (tx) => removeWaitlistEntry(tx, erin, { entryId: (await entryOf(event.id, "leo")).id, reason: "Family said no by phone" }));
    expect((await entryOf(event.id, "maya")).status).toBe("offered");
    // Staff with billing rights may accept on the family's behalf; the result is the usual open invoice.
    const r = await db().transaction(async (tx) => acceptWaitlistOffer(tx, erin, { entryId: (await entryOf(event.id, "maya")).id, idempotencyKey: key() }));
    expect(r.invoices[0].status).toBe("open");
    const d = (await staffEventDetail(db(), erin, event.id))!;
    expect(d.counts).toMatchObject({ held: 1, offered: 0, waiting: 0 });
    expect(d.spotsLeft).toBe(0);
    for (const action of ["events.waitlist.reorder", "events.waitlist.remove", "events.waitlist.accept"]) {
      expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, action)))).length, action).toBeGreaterThan(0);
    }
  });

  it("entries are scoped to the organization", async () => {
    const other = await seedOrg(T, { modules: ["scheduling", "billing"] });
    const stranger = await viewerFor(other, "erin");
    const event = await mkEvent({ capacity: 1 });
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    const maya = await entryOf(event.id, "maya");
    await expect(db().transaction((tx) => removeWaitlistEntry(tx, stranger, { entryId: maya.id, reason: "x" }))).rejects.toThrow(/not found/);
    await expect(db().transaction((tx) => acceptWaitlistOffer(tx, stranger, { entryId: maya.id, idempotencyKey: key() }))).rejects.toThrow(/not found/);
    expect(await staffWaitlist(db(), stranger, event.id)).toHaveLength(0);
    await expect(db().transaction((tx) => joinEventWaitlist(tx, stranger, { eventId: event.id, athleteIds: [other.athletes.maya] }))).rejects.toThrow(/not found/);
  });
});

describe("concurrency", () => {
  const KIDS = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson", "eli", "harper"];

  it("10 athletes joining at once get 10 distinct places", async () => {
    const event = await mkEvent({ capacity: 1 });
    const erin = await viewerFor(ctx, "erin");
    await register("dana", event.id, ["dana"]);
    const results = await Promise.allSettled(KIDS.map((k) => db().transaction((tx) => joinEventWaitlist(tx, erin, { eventId: event.id, athleteIds: [A(k)] }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const line = (await entries(event.id)).filter((e) => e.status === "waiting");
    expect(line).toHaveLength(10);
    expect(new Set(line.map((e) => e.position)).size).toBe(10);
    // The same athlete twice at once: one entry.
    const event2 = await mkEvent({ capacity: 1 });
    await register("dana", event2.id, ["dana"]);
    const twice = await Promise.allSettled([0, 1, 2].map(() => db().transaction((tx) => joinEventWaitlist(tx, erin, { eventId: event2.id, athleteIds: [A("maya")] }))));
    expect(twice.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await entries(event2.id)).filter((e) => e.status === "waiting")).toHaveLength(1);
  });

  it("two spots released at the same moment produce exactly two offers, to the first two in line", async () => {
    const event = await mkEvent({ capacity: 3 });
    const erin = await viewerFor(ctx, "erin");
    for (const k of ["dana", "ava", "ella"]) await db().transaction((tx) => registerForEvent(tx, erin, { eventId: event.id, athleteIds: [A(k)], idempotencyKey: key() }));
    for (const k of ["maya", "leo", "ethan", "sofia"]) await db().transaction((tx) => joinEventWaitlist(tx, erin, { eventId: event.id, athleteIds: [A(k)] }));
    const out = await Promise.allSettled([cancel(event.id, "dana"), cancel(event.id, "ava")]);
    expect(out.every((r) => r.status === "fulfilled")).toBe(true);
    const all = await entries(event.id);
    expect(all.filter((e) => e.status === "offered").map((e) => e.athleteId).sort()).toEqual([A("maya"), A("leo")].sort());
    expect(all.filter((e) => e.status === "waiting")).toHaveLength(2);
    await neverOversold(event.id, 3);
  });

  it("an offer accepted from several tabs at once, while others try to register and the sweep runs, seats exactly one athlete", async () => {
    const event = await mkEvent({ capacity: 1 });
    const erin = await viewerFor(ctx, "erin");
    const alex = await viewerFor(ctx, "alex");
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await cancel(event.id, "dana");
    const offer = await entryOf(event.id, "maya");
    const work: Promise<unknown>[] = [
      ...[0, 1, 2, 3].map(() => db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: offer.id, idempotencyKey: key() }))),
      ...["ethan", "sofia", "liam"].map((k) => db().transaction((tx) => registerForEvent(tx, erin, { eventId: event.id, athleteIds: [A(k)], idempotencyKey: key() }))),
      db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId)),
    ];
    const results = await Promise.allSettled(work);
    expect(results.slice(0, 4).filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.slice(4, 7).every((r) => r.status === "rejected")).toBe(true);
    const regs = await liveRegs(event.id);
    expect(regs).toHaveLength(1);
    expect(regs[0].athleteId).toBe(A("maya"));
    expect((await entryOf(event.id, "leo")).status).toBe("waiting");
    expect((await entries(event.id)).filter((e) => e.status === "offered")).toHaveLength(0);
    await neverOversold(event.id, 1);
  });

  it("accept racing with the expiry sweep: either the family got the spot or the next in line was offered it, never both", async () => {
    const event = await mkEvent({ capacity: 1, waitlistOfferHours: 1 });
    const alex = await viewerFor(ctx, "alex");
    await register("dana", event.id, ["dana"]);
    await join("alex", event.id, ["maya"]);
    await join("sam", event.id, ["leo"]);
    await cancel(event.id, "dana");
    const offer = await entryOf(event.id, "maya");
    const justBefore = new Date(offer.offerExpiresAt!.getTime() - 1000);
    const justAfter = new Date(offer.offerExpiresAt!.getTime() + 1000);
    await Promise.allSettled([
      db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: offer.id, idempotencyKey: key(), now: justBefore })),
      db().transaction((tx) => releaseExpiredHolds(tx, ctx.orgId, justAfter)),
    ]);
    const regs = await liveRegs(event.id);
    const maya = await entryOf(event.id, "maya");
    const leo = await entryOf(event.id, "leo");
    if (regs.length === 1) {
      expect(maya.status).toBe("accepted");
      expect(leo.status).toBe("waiting");
    } else {
      expect(maya.status).toBe("expired");
      expect(leo.status).toBe("offered");
    }
    await neverOversold(event.id, 1);
  });
});
