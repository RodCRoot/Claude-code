import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { eventRegistrations, events, eventWaitlistEntries } from "@/db/schema";
import { createEvent, setEventStatus } from "@/lib/events/events";
import { familyLiveOffers, staffLiveOffers } from "@/lib/events/offers";
import { familyEventDetail, listFamilyEvents, listStaffEvents, staffEventDetail } from "@/lib/events/queries";
import { cancelEventRegistration, registerForEvent } from "@/lib/events/registration";
import { acceptWaitlistOffer, joinEventWaitlist, leaveEventWaitlist, staffWaitlist } from "@/lib/events/waitlist";
import { isLiveOffer } from "@/lib/events/waitlist-core";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * Waitlist offers where families and the front desk already look (family Home, staff Today), and
 * the rule that an offer whose time has run out is never shown as live or accepted, even before
 * any sweep has marked it expired.
 */
const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const key = () => randomUUID();
const A = (k: string) => ctx.athletes[k];

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing", "events"] });
});
afterAll(closeTestDb);

/** A full one-spot sample clinic where Maya holds a live offer and Leo is still waiting. */
async function offeredEvent() {
  const erin = await viewerFor(ctx, "erin");
  const { event } = await db().transaction((tx) => createEvent(tx, erin, { name: `Sample Clinic ${randomUUID().slice(0, 6)}`, kind: "clinic", capacity: 1, priceMinor: 5000, sessions: [{ date: addDaysYmd(T, 10), startTime: "09:00", endTime: "11:00" }] }));
  await db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "published" }));
  const dana = await viewerFor(ctx, "dana");
  const r = await db().transaction((tx) => registerForEvent(tx, dana, { eventId: event.id, athleteIds: [A("dana")], idempotencyKey: key() }));
  await db().transaction(async (tx) => joinEventWaitlist(tx, await viewerFor(ctx, "alex"), { eventId: event.id, athleteIds: [A("maya")] }));
  await db().transaction(async (tx) => joinEventWaitlist(tx, await viewerFor(ctx, "sam"), { eventId: event.id, athleteIds: [A("leo")] }));
  await db().transaction((tx) => cancelEventRegistration(tx, erin, { registrationId: r.registrationIds[0], reason: "test: family asked to cancel" }));
  const [entry] = await db().select().from(eventWaitlistEntries).where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.athleteId, A("maya"))));
  expect(entry.status).toBe("offered");
  return { event, entry };
}

describe("isLiveOffer", () => {
  const at = new Date("2026-06-01T12:00:00Z");
  it("needs status offered and an expiry still ahead", () => {
    expect(isLiveOffer({ status: "offered", offerExpiresAt: new Date(at.getTime() + 1) }, at)).toBe(true);
    expect(isLiveOffer({ status: "offered", offerExpiresAt: at }, at)).toBe(false);
    expect(isLiveOffer({ status: "offered", offerExpiresAt: null }, at)).toBe(false);
    expect(isLiveOffer({ status: "waiting", offerExpiresAt: new Date(at.getTime() + 1) }, at)).toBe(false);
    expect(isLiveOffer({ status: "expired", offerExpiresAt: new Date(at.getTime() + 1) }, at)).toBe(false);
  });
});

describe("the demo seed", () => {
  it("has one live offer and one athlete still waiting on a full sample clinic, third in the family list", async () => {
    const id = ctx.extra.events.waitlistClinic;
    expect(id).toBeTruthy();
    const rows = await db().select().from(eventWaitlistEntries).where(eq(eventWaitlistEntries.eventId, id));
    expect(rows.map((r) => r.status).sort()).toEqual(["offered", "waiting"]);
    expect(rows.find((r) => r.status === "offered")!.athleteId).toBe(A("maya"));
    expect(rows.find((r) => r.status === "waiting")!.athleteId).toBe(A("ava"));
    expect(rows.every((r) => r.isDemo)).toBe(true);
    const [e] = await db().select().from(events).where(eq(events.id, id));
    expect(e.name).toMatch(/^Sample: /);
    expect(e.isDemo).toBe(true);
    // Full: one paid registration plus the reserved offer.
    const regs = await db().select().from(eventRegistrations).where(and(eq(eventRegistrations.eventId, id), inArray(eventRegistrations.status, ["held", "confirmed"])));
    expect(regs).toHaveLength(1);
    // The two events other screens and browser tests rely on still come first.
    const list = await listFamilyEvents(db(), await viewerFor(ctx, "alex"));
    expect(list.slice(0, 3).map((x) => x.id)).toEqual([ctx.extra.events.clinic, ctx.extra.events.camp, id]);
    expect(list[2].spotsLeft).toBe(0);
    // The seeded offer is live right now for the family and for the front desk.
    const fam = await familyLiveOffers(db(), await viewerFor(ctx, "alex"));
    expect(fam.offers.filter((o) => o.eventId === id).map((o) => o.first)).toEqual(["Maya"]);
    expect((await staffLiveOffers(db(), await viewerFor(ctx, "erin"))).offers.some((o) => o.eventId === id)).toBe(true);
  });
});

describe("live offers on family Home and staff Today", () => {
  it("a family sees only its own athletes' offers; who may act follows the registration rule; staff need schedule.manage", async () => {
    const { event, entry } = await offeredEvent();
    const mine = async (who: string) => (await familyLiveOffers(db(), await viewerFor(ctx, who))).offers.filter((o) => o.eventId === event.id);

    const alex = await mine("alex");
    expect(alex).toHaveLength(1);
    expect(alex[0]).toMatchObject({ entryId: entry.id, athleteId: A("maya"), first: "Maya", canAct: true });
    expect(alex[0].offerExpiresAt.getTime()).toBe(entry.offerExpiresAt!.getTime());
    // Jordan can view Maya but cannot pay: the offer is shown without the right to act.
    expect((await mine("jordan"))[0]).toMatchObject({ athleteId: A("maya"), canAct: false });
    // The athlete's own login sees it too, also without the right to act.
    expect((await mine("maya"))[0]).toMatchObject({ canAct: false });
    // Leo is only waiting; other families see nothing of Maya's offer.
    for (const who of ["sam", "casey", "chris", "dana"]) expect(await mine(who), who).toHaveLength(0);
    // Staff logins get nothing from the family read.
    for (const who of ["erin", "rod", "marcus"]) expect(await mine(who), who).toHaveLength(0);

    const staff = async (who: string) => (await staffLiveOffers(db(), await viewerFor(ctx, who))).offers.filter((o) => o.eventId === event.id);
    for (const who of ["erin", "rod"]) {
      const s = await staff(who);
      expect(s, who).toHaveLength(1);
      expect(s[0]).toMatchObject({ athleteName: "Maya Parker", eventName: event.name });
      expect(s[0].payerName).toBeTruthy();
    }
    for (const who of ["marcus", "alex", "maya", "kiosk"]) expect(await staff(who), who).toHaveLength(0);
  });

  it("offers are scoped to the organization and to published events", async () => {
    const { event } = await offeredEvent();
    const other = await seedOrg(T, { modules: ["scheduling", "billing"] });
    expect((await staffLiveOffers(db(), await viewerFor(other, "erin"))).offers).toHaveLength(0);
    expect((await familyLiveOffers(db(), await viewerFor(other, "alex"))).offers).toHaveLength(0);
    const erin = await viewerFor(ctx, "erin");
    await db().transaction((tx) => setEventStatus(tx, erin, { eventId: event.id, status: "closed" }));
    expect((await staffLiveOffers(db(), erin)).offers.some((o) => o.eventId === event.id)).toBe(false);
    expect((await familyLiveOffers(db(), await viewerFor(ctx, "alex"))).offers.some((o) => o.eventId === event.id)).toBe(false);
  });

  it("declining from Home uses the existing function: the offer disappears and passes to the next in line", async () => {
    const { event, entry } = await offeredEvent();
    const alex = await viewerFor(ctx, "alex");
    await db().transaction((tx) => leaveEventWaitlist(tx, alex, { entryId: entry.id }));
    expect((await familyLiveOffers(db(), alex)).offers.some((o) => o.eventId === event.id)).toBe(false);
    const sam = (await familyLiveOffers(db(), await viewerFor(ctx, "sam"))).offers.filter((o) => o.eventId === event.id);
    expect(sam.map((o) => o.first)).toEqual(["Leo"]);
  });
});

describe("an offer whose time has run out is never live, even before any sweep", () => {
  it("every read drops it and accepting is refused, while the row still says offered", async () => {
    const { event, entry } = await offeredEvent();
    const alex = await viewerFor(ctx, "alex");
    const erin = await viewerFor(ctx, "erin");
    const before = new Date(entry.offerExpiresAt!.getTime() - 60_000);
    const after = new Date(entry.offerExpiresAt!.getTime() + 60_000);

    // One minute before: live everywhere.
    expect((await familyLiveOffers(db(), alex, before)).offers.some((o) => o.entryId === entry.id)).toBe(true);
    expect((await staffLiveOffers(db(), erin, before)).offers.some((o) => o.entryId === entry.id)).toBe(true);
    expect((await familyEventDetail(db(), alex, event.id, before))!.athletes.find((a) => a.athleteId === A("maya"))!.state).toBe("offered");
    expect((await staffWaitlist(db(), erin, event.id, before)).find((w) => w.id === entry.id)!.status).toBe("offered");

    // One minute after, with NO sweep: nothing shows it as live.
    expect((await familyLiveOffers(db(), alex, after)).offers.some((o) => o.entryId === entry.id)).toBe(false);
    expect((await staffLiveOffers(db(), erin, after)).offers.some((o) => o.entryId === entry.id)).toBe(false);
    const detail = (await familyEventDetail(db(), alex, event.id, after))!;
    expect(detail.athletes.find((a) => a.athleteId === A("maya"))!.state).not.toBe("offered");
    expect(detail.event.waitlist.some((w) => w.status === "offered")).toBe(false);
    const listed = (await listFamilyEvents(db(), alex, after)).find((e) => e.id === event.id)!;
    expect(listed.waitlist.some((w) => w.status === "offered")).toBe(false);
    const row = (await staffWaitlist(db(), erin, event.id, after)).find((w) => w.id === entry.id)!;
    expect(row.status).toBe("expired");
    expect(row.offerExpiresAt).toBeNull();
    expect((await listStaffEvents(db(), erin, after)).rows.find((r) => r.event.id === event.id)!.counts.offered).toBe(0);
    await expect(db().transaction((tx) => acceptWaitlistOffer(tx, alex, { entryId: entry.id, idempotencyKey: key(), now: after }))).rejects.toThrow(/run out/);
    await expect(db().transaction((tx) => acceptWaitlistOffer(tx, erin, { entryId: entry.id, idempotencyKey: key(), now: after }))).rejects.toThrow(/run out/);

    // No sweep ran: the stored row is unchanged, which is exactly the case the reads must handle.
    const [stored] = await db().select().from(eventWaitlistEntries).where(eq(eventWaitlistEntries.id, entry.id));
    expect(stored.status).toBe("offered");
    // At the real current time it is still live (the staff detail read uses the clock).
    expect((await staffEventDetail(db(), erin, event.id))!.counts.offered).toBe(1);
  });
});
