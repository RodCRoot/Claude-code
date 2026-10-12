import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { bookings, creditBuckets, scheduleSessions, serviceTypes } from "@/db/schema";
import {
  adjustCredits,
  creditSummary,
  expireCredits,
  grantCredits,
  InsufficientCreditsError,
  reserveCredits,
  restoreCredit,
  settleReservation,
  verifyLedger,
} from "@/lib/credits";
import { closeTestDb, seedOrg, testDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let serviceTypeId: string;

beforeAll(async () => {
  ctx = await seedOrg();
  const [st] = await testDb()
    .insert(serviceTypes)
    .values({ orgId: ctx.orgId, name: "Test Class", kind: "class", defaultCapacity: 20 })
    .returning();
  serviceTypeId = st.id;
});
afterAll(closeTestDb);

async function makeBookings(athleteId: string, n: number) {
  const db = testDb();
  const start = new Date(Date.now() + 86_400_000);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [s] = await db
      .insert(scheduleSessions)
      .values({
        orgId: ctx.orgId,
        serviceTypeId,
        title: `S${i}`,
        startsAt: new Date(start.getTime() + i * 3_600_000),
        endsAt: new Date(start.getTime() + i * 3_600_000 + 3_000_000),
        timezone: ctx.tz,
        capacity: 10,
      })
      .returning();
    const [b] = await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId, status: "booked" }).returning();
    ids.push(b.id);
  }
  return ids;
}

describe("credit ledger", () => {
  it("grant is idempotent by key", async () => {
    const db = testDb();
    const key = `grant-${randomUUID()}`;
    const a = await db.transaction((tx) => grantCredits(tx, { orgId: ctx.orgId, athleteId: ctx.athletes.ethan, amount: 3, sourceKind: "staff_grant", idempotencyKey: key }));
    const b = await db.transaction((tx) => grantCredits(tx, { orgId: ctx.orgId, athleteId: ctx.athletes.ethan, amount: 3, sourceKind: "staff_grant", idempotencyKey: key }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.bucket.id).toBe(a.bucket.id);
    expect((await creditSummary(db, ctx.athletes.ethan)).available).toBe(3);
  });

  it("concurrent reservations never overspend a single credit", async () => {
    const db = testDb();
    const athlete = ctx.athletes.sofia;
    await db.transaction((tx) => grantCredits(tx, { orgId: ctx.orgId, athleteId: athlete, amount: 1, sourceKind: "staff_grant", idempotencyKey: `g-${randomUUID()}` }));
    const bookingIds = await makeBookings(athlete, 6);
    const results = await Promise.allSettled(
      bookingIds.map((bookingId) =>
        db.transaction((tx) =>
          reserveCredits(tx, { orgId: ctx.orgId, athleteId: athlete, bookingId, serviceTypeId, cost: 1, sessionStartsAt: new Date(Date.now() + 2 * 86_400_000) }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const insufficient = results.filter((r) => r.status === "rejected" && r.reason instanceof InsufficientCreditsError);
    expect(ok).toHaveLength(1);
    expect(insufficient).toHaveLength(5);
    const sum = await creditSummary(db, athlete);
    expect(sum.available).toBe(0);
    expect(sum.reserved).toBe(1);
    expect(await verifyLedger(db, ctx.orgId)).toEqual([]);
  });

  it("settles exactly once; release returns the credit; restore reverses a forfeit once", async () => {
    const db = testDb();
    const athlete = ctx.athletes.liam;
    await db.transaction((tx) => grantCredits(tx, { orgId: ctx.orgId, athleteId: athlete, amount: 2, sourceKind: "staff_grant", idempotencyKey: `g-${randomUUID()}` }));
    const [b1, b2] = await makeBookings(athlete, 2);
    const at = new Date(Date.now() + 2 * 86_400_000);
    await db.transaction((tx) => reserveCredits(tx, { orgId: ctx.orgId, athleteId: athlete, bookingId: b1, serviceTypeId, cost: 1, sessionStartsAt: at }));
    // retry of the same reservation is a no-op
    const again = await db.transaction((tx) => reserveCredits(tx, { orgId: ctx.orgId, athleteId: athlete, bookingId: b1, serviceTypeId, cost: 1, sessionStartsAt: at }));
    expect(again.reused).toBe(true);
    await db.transaction((tx) => reserveCredits(tx, { orgId: ctx.orgId, athleteId: athlete, bookingId: b2, serviceTypeId, cost: 1, sessionStartsAt: at }));
    expect((await creditSummary(db, athlete)).available).toBe(0);

    const r1 = await db.transaction((tx) => settleReservation(tx, { bookingId: b1, outcome: "release" }));
    const r1again = await db.transaction((tx) => settleReservation(tx, { bookingId: b1, outcome: "consume" }));
    expect(r1.settled).toBe(true);
    expect(r1again.settled).toBe(false);
    expect((await creditSummary(db, athlete)).available).toBe(1);

    await db.transaction((tx) => settleReservation(tx, { bookingId: b2, outcome: "forfeit", reason: "no-show" }));
    expect((await creditSummary(db, athlete)).available).toBe(1);
    const rs = await db.transaction((tx) => restoreCredit(tx, { bookingId: b2, actorUserId: ctx.users.erin, reason: "Excused: illness" }));
    const rs2 = await db.transaction((tx) => restoreCredit(tx, { bookingId: b2, actorUserId: ctx.users.erin, reason: "again" }));
    expect(rs.restored).toBe(true);
    expect(rs2.restored).toBe(false);
    expect((await creditSummary(db, athlete)).available).toBe(2);
    expect(await verifyLedger(db, ctx.orgId)).toEqual([]);
  });

  it("does not use expired buckets, expires leftovers, and adjustments are attributable", async () => {
    const db = testDb();
    const athlete = ctx.athletes.harper;
    const { bucket } = await db.transaction((tx) =>
      grantCredits(tx, { orgId: ctx.orgId, athleteId: athlete, amount: 2, sourceKind: "staff_grant", expiresAt: new Date(Date.now() + 3_600_000), idempotencyKey: `g-${randomUUID()}` }),
    );
    const [b] = await makeBookings(athlete, 1);
    await expect(
      db.transaction((tx) => reserveCredits(tx, { orgId: ctx.orgId, athleteId: athlete, bookingId: b, serviceTypeId, cost: 1, sessionStartsAt: new Date(Date.now() + 2 * 86_400_000) })),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    await expect(db.transaction((tx) => adjustCredits(tx, { bucketId: bucket.id, delta: -5, actorUserId: ctx.users.rod, reason: "x", idempotencyKey: randomUUID() }))).rejects.toThrow(/negative/);
    await db.transaction((tx) => adjustCredits(tx, { bucketId: bucket.id, delta: 1, actorUserId: ctx.users.rod, reason: "Goodwill", idempotencyKey: "adj-1-" + bucket.id }));
    const res = await db.transaction((tx) => expireCredits(tx, new Date(Date.now() + 2 * 3_600_000)));
    expect(res.creditsExpired).toBeGreaterThanOrEqual(3);
    const [after] = await db.select().from(creditBuckets).where(eq(creditBuckets.id, bucket.id));
    expect(after.available).toBe(0);
    expect(after.status).toBe("expired");
    expect(await verifyLedger(db, ctx.orgId)).toEqual([]);
  });
});
