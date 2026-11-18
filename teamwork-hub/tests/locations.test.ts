import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bookings, creditBuckets, locations, products, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { setProductLocations } from "@/lib/billing/catalog";
import { grantCredits } from "@/lib/credits";
import { saveLocation, scopeCovers, setKioskLocation } from "@/lib/locations";
import { reportByKey } from "@/lib/reports";
import { bookSession, createSession, kioskCheckIn, kioskRoster, listSessions, resolveEntitlement } from "@/lib/scheduling";
import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { DAY, mkSession } from "./scheduling-helpers";

const db = () => testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let BLOOM: string;
let LINTON: string;

async function at(locationId: string | null, opts: Parameters<typeof mkSession>[1] = {}) {
  const s = await mkSession(ctx, { title: `Loc ${randomUUID().slice(0, 4)}`, ...opts });
  await db().update(scheduleSessions).set({ locationId }).where(eq(scheduleSessions.id, s.id));
  return { ...s, locationId };
}

beforeAll(async () => {
  ctx = await seedOrg();
  BLOOM = ctx.extra.locations.bloomington;
  LINTON = ctx.extra.locations.linton;
  // Maya's demo staff credits are unscoped; void them so only her (Bloomington-only) unlimited membership can pay.
  await db().update(creditBuckets).set({ status: "void" }).where(eq(creditBuckets.athleteId, ctx.athletes.maya));
});
afterAll(closeTestDb);

describe("location seed", () => {
  it("seeds two locations, puts the existing schedule at the primary one, and scopes sample memberships", async () => {
    const locs = await db().select().from(locations).where(eq(locations.orgId, ctx.orgId));
    expect(locs.map((l) => l.name).sort()).toEqual(["Bloomington", "Linton"]);
    const tonight = await db().select().from(scheduleSessions).where(eq(scheduleSessions.id, ctx.extra.scheduling.tonightSession));
    expect(tonight[0].locationId).toBe(BLOOM);
    const linton = await db().select().from(scheduleSessions).where(and(eq(scheduleSessions.orgId, ctx.orgId), eq(scheduleSessions.locationId, LINTON)));
    expect(linton.length).toBeGreaterThan(0);
    const [unl] = await db().select().from(products).where(and(eq(products.orgId, ctx.orgId), eq(products.name, "Sample — Unlimited Monthly Membership")));
    expect(unl.locationIds).toEqual([BLOOM]);
  });

  it("scopeCovers: empty scope = everywhere; unlocated sessions are covered by anything", () => {
    expect(scopeCovers([], "x")).toBe(true);
    expect(scopeCovers(["a"], null)).toBe(true);
    expect(scopeCovers(["a"], "a")).toBe(true);
    expect(scopeCovers(["a"], "b")).toBe(false);
  });
});

describe("entitlement scoping", () => {
  it("a Bloomington membership books Bloomington and unlocated sessions but not Linton (clear message)", async () => {
    const alex = await viewerFor(ctx, "alex");
    const bloom = await at(BLOOM);
    const none = await at(null);
    const linton = await at(LINTON);
    const r1 = await db().transaction((tx) => bookSession(tx, alex, { sessionId: bloom.id, athleteId: ctx.athletes.maya }));
    expect(r1.booking.entitlementSource).toBe("unlimited");
    const r2 = await db().transaction((tx) => bookSession(tx, alex, { sessionId: none.id, athleteId: ctx.athletes.maya }));
    expect(r2.booking.entitlementSource).toBe("unlimited");

    const err = await db()
      .transaction((tx) => bookSession(tx, alex, { sessionId: linton.id, athleteId: ctx.athletes.maya }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/Maya Parker's Sample: Unlimited Monthly Membership covers Bloomington sessions only\. This session is at Linton\./);
    expect(err.message).not.toMatch(/—/);

    const ent = await resolveEntitlement(db(), { orgId: ctx.orgId, athleteId: ctx.athletes.maya, serviceType: { id: ctx.extra.scheduling.gpt, eligibility: {}, creditCost: 1 }, at: linton.startsAt, locationId: LINTON });
    expect(ent).toMatchObject({ kind: "none", locationBlocked: { coveredLocations: ["Bloomington"], sessionLocation: "Linton" } });

    // Staff see the same reason plus the comp option; a comp with a reason works.
    const erin = await viewerFor(ctx, "erin");
    await expect(db().transaction((tx) => bookSession(tx, erin, { sessionId: linton.id, athleteId: ctx.athletes.maya }))).rejects.toThrow(/comp/);
    const comp = await db().transaction((tx) => bookSession(tx, erin, { sessionId: linton.id, athleteId: ctx.athletes.maya, comp: { reason: "Linton trial week" } }));
    expect(comp.booking.entitlementSource).toBe("comp");
  });

  it("removing the product's location limit lets the same membership book Linton", async () => {
    const rod = await viewerFor(ctx, "rod");
    const [unl] = await db().select().from(products).where(and(eq(products.orgId, ctx.orgId), eq(products.name, "Sample — Unlimited Monthly Membership")));
    const linton = await at(LINTON);
    await db().transaction((tx) => setProductLocations(tx, rod, unl.id, []));
    const alex = await viewerFor(ctx, "alex");
    const r = await db().transaction((tx) => bookSession(tx, alex, { sessionId: linton.id, athleteId: ctx.athletes.maya }));
    expect(r.booking.entitlementSource).toBe("unlimited");
    await db().transaction((tx) => setProductLocations(tx, rod, unl.id, [BLOOM]));
    // Another org's location id is refused.
    await expect(db().transaction((tx) => setProductLocations(tx, rod, unl.id, [randomUUID()]))).rejects.toThrow(/not found/);
  });

  it("credits granted for one location are only spent there", async () => {
    // Ethan is a clean slate (no credits, no membership).
    await db().transaction((tx) =>
      grantCredits(tx, { orgId: ctx.orgId, athleteId: ctx.athletes.ethan, amount: 2, sourceKind: "staff_grant", locationIds: [LINTON], idempotencyKey: `loc-${randomUUID()}` }),
    );
    const erin = await viewerFor(ctx, "erin");
    const bloom = await at(BLOOM);
    const linton = await at(LINTON);
    await expect(db().transaction((tx) => bookSession(tx, erin, { sessionId: bloom.id, athleteId: ctx.athletes.ethan }))).rejects.toThrow(/no membership or credits/);
    const r = await db().transaction((tx) => bookSession(tx, erin, { sessionId: linton.id, athleteId: ctx.athletes.ethan }));
    expect(r.booking.entitlementSource).toBe("credit");
  });

  it("new sessions take the series / resource / service location, and explicit choice wins", async () => {
    const erin = await viewerFor(ctx, "erin");
    const viaResource = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: new Date(Date.now() + 9 * DAY), resourceId: ctx.extra.locations.lintonGym, coachUserId: null }));
    expect(viaResource.locationId).toBe(LINTON);
    const explicit = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: new Date(Date.now() + 9 * DAY + 3 * 3_600_000), resourceId: ctx.extra.locations.lintonGym, locationId: BLOOM, coachUserId: null }));
    expect(explicit.locationId).toBe(BLOOM);
    const plain = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: new Date(Date.now() + 10 * DAY), coachUserId: null }));
    expect(plain.locationId).toBeNull();
    // Locations are validated per org.
    await expect(db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: new Date(Date.now() + 11 * DAY), locationId: randomUUID() }))).rejects.toThrow(/Location not found/);
  });
});

describe("schedule filter", () => {
  it("listSessions filters by location and returns the location name", async () => {
    const erin = await viewerFor(ctx, "erin");
    const from = new Date();
    const to = new Date(Date.now() + 30 * DAY);
    const all = await listSessions(db(), erin, { from, to });
    const lin = await listSessions(db(), erin, { from, to, filters: { locationId: LINTON } });
    expect(lin.length).toBeGreaterThan(0);
    expect(lin.length).toBeLessThan(all.length);
    expect(lin.every((s) => s.locationId === LINTON && s.locationName === "Linton")).toBe(true);
  });
});

describe("reports by location", () => {
  it("attendance and utilization group by location and honour the filter", async () => {
    const tz = ctx.tz;
    const day = addDaysYmd(todayLocal(tz), -2);
    const s = await at(LINTON, { startsAt: localToUtc(day, "07:00", tz), capacity: 4, title: "Linton report class" });
    await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes.sofia, status: "attended" });
    const range = { from: day, to: day, tz };
    const attendance = reportByKey("attendance")!;
    const allRows = (await attendance.run(db(), ctx.orgId, range)).rows;
    expect(allRows.some((r) => r.location === "Linton" && Number(r.attended) >= 1)).toBe(true);
    const only = (await attendance.run(db(), ctx.orgId, { ...range, locationId: LINTON })).rows;
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.location === "Linton")).toBe(true);
    const util = (await reportByKey("utilization")!.run(db(), ctx.orgId, { ...range, locationId: LINTON })).rows;
    expect(util.length).toBe(1);
    expect(util[0]).toMatchObject({ location: "Linton", sessions: 1, capacity: 4, attended: 1 });
    expect(util[0].fill_rate).toBeCloseTo(0.25);
    expect(attendance.locationAware && reportByKey("utilization")!.locationAware).toBe(true);
  });
});

describe("kiosk bound to a location", () => {
  it("shows and checks in only that location's sessions", async () => {
    const tz = ctx.tz;
    const tomorrow = addDaysYmd(todayLocal(tz), 1);
    const now = localToUtc(tomorrow, "09:45", tz);
    const bloom = await at(BLOOM, { startsAt: localToUtc(tomorrow, "10:00", tz), title: "Bloom kiosk class" });
    const linton = await at(LINTON, { startsAt: localToUtc(tomorrow, "10:00", tz), title: "Linton kiosk class", coach: ctx.users.tess });
    const erin = await viewerFor(ctx, "erin");
    await db().transaction((tx) => grantCredits(tx, { orgId: ctx.orgId, athleteId: ctx.athletes.liam, amount: 4, sourceKind: "staff_grant", idempotencyKey: `k-${randomUUID()}` }));
    const bB = await db().transaction((tx) => bookSession(tx, erin, { sessionId: bloom.id, athleteId: ctx.athletes.liam }));
    const bL = await db().transaction((tx) => bookSession(tx, erin, { sessionId: linton.id, athleteId: ctx.athletes.liam }));

    const kiosk = await viewerFor(ctx, "kiosk");
    const unbound = await db().transaction((tx) => kioskRoster(tx, kiosk, { now }));
    expect(unbound.map((s) => s.id)).toEqual(expect.arrayContaining([bloom.id, linton.id]));

    await db().transaction((tx) => setKioskLocation(tx, erin, { userId: ctx.users.kiosk, locationId: LINTON }));
    const bound = await db().transaction((tx) => kioskRoster(tx, kiosk, { now }));
    expect(bound.map((s) => s.id)).toContain(linton.id);
    expect(bound.map((s) => s.id)).not.toContain(bloom.id);

    await expect(db().transaction((tx) => kioskCheckIn(tx, kiosk, { bookingId: bB.booking.id, now }))).rejects.toBeInstanceOf(AuthzError);
    const ok = await db().transaction((tx) => kioskCheckIn(tx, kiosk, { bookingId: bL.booking.id, now }));
    expect(ok.status).toBe("attended");

    // Only kiosk logins can be bound, and only by schedule managers.
    await expect(db().transaction((tx) => setKioskLocation(tx, erin, { userId: ctx.users.alex, locationId: LINTON }))).rejects.toThrow(/kiosk login/);
    const alex = await viewerFor(ctx, "alex");
    await expect(db().transaction((tx) => setKioskLocation(tx, alex, { userId: ctx.users.kiosk, locationId: null }))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => setKioskLocation(tx, erin, { userId: ctx.users.kiosk, locationId: null }));
  });
});

describe("location admin", () => {
  it("creates locations with the facility timezone by default and rejects duplicates / bad timezones", async () => {
    const erin = await viewerFor(ctx, "erin");
    const id = await db().transaction((tx) => saveLocation(tx, erin, { name: "Third Site (test)", active: true, sortOrder: 2 }));
    const [l] = await db().select().from(locations).where(eq(locations.id, id));
    expect(l.timezone).toBe(ctx.tz);
    await expect(db().transaction((tx) => saveLocation(tx, erin, { name: "linton", active: true, sortOrder: 0 }))).rejects.toThrow(/already exists/);
    await expect(db().transaction((tx) => saveLocation(tx, erin, { name: "Bad TZ", timezone: "Mars/Olympus", active: true, sortOrder: 0 }))).rejects.toThrow(/timezone/);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(db().transaction((tx) => saveLocation(tx, marcus, { name: "Coach site", active: true, sortOrder: 0 }))).rejects.toBeInstanceOf(AuthzError);
  });
});
