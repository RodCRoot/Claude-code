import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, classSeries, creditLedger, scheduleSessions } from "@/db/schema";
import { creditSummary, verifyLedger } from "@/lib/credits";
import { bookBatch, generateSeriesSessions, nextSeriesSessions } from "@/lib/scheduling";
import { addDaysYmd, isoWeekday, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { DAY, giveCredits, mkSession } from "./scheduling-helpers";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
  await db().execute(sql`update memberships set status = 'cancelled' where org_id = ${ctx.orgId}`);
  for (const k of ["maya", "eli", "leo"]) await giveCredits(ctx, k, 40);
});
afterAll(closeTestDb);

const avail = async (k: string) => (await creditSummary(db(), ctx.athletes[k])).available;
const liveFor = async (sessionId: string) =>
  db().select().from(bookings).where(and(eq(bookings.sessionId, sessionId), sql`${bookings.status} in ('booked','waitlisted','attended','no_show')`));

async function weeklySeries(weeks: number) {
  const tz = ctx.tz;
  const first = addDaysYmd(todayLocal(tz), 1);
  const erin = await viewerFor(ctx, "erin");
  const [series] = await db()
    .insert(classSeries)
    .values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.gpt, title: `Weekly ${randomUUID().slice(0, 5)}`, weekdays: [isoWeekday(first)], startTimeLocal: "17:00", durationMinutes: 60, timezone: tz, startsOn: first, capacity: 8, waitlistCapacity: 0 })
    .returning();
  await db().transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: first, weeks }));
  return db().select().from(scheduleSessions).where(eq(scheduleSessions.seriesId, series.id)).orderBy(asc(scheduleSessions.startsAt));
}

describe("family multi-athlete booking", () => {
  it("books several authorized children into one session in one action; a retry is idempotent", async () => {
    const alex = await viewerFor(ctx, "alex");
    const s = await mkSession(ctx, { startsInMs: 3 * DAY, capacity: 10 });
    const [m0, e0] = [await avail("maya"), await avail("eli")];
    const key = randomUUID();
    const items = [ctx.athletes.maya, ctx.athletes.eli].map((athleteId) => ({ sessionId: s.id, athleteId }));
    const r = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: key }));
    expect(r.committed).toBe(true);
    expect(r.results.map((x) => [x.athleteLabel, x.outcome])).toEqual([
      ["Maya Parker", "booked"],
      ["Eli Parker", "booked"],
    ]);
    expect([await avail("maya"), await avail("eli")]).toEqual([m0 - 1, e0 - 1]);
    const again = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: key }));
    expect(again.results.every((x) => x.reused && x.outcome === "booked")).toBe(true);
    expect(again.results.map((x) => x.bookingId)).toEqual(r.results.map((x) => x.bookingId));
    expect([await avail("maya"), await avail("eli")]).toEqual([m0 - 1, e0 - 1]);
    expect(await liveFor(s.id)).toHaveLength(2);
  });

  it("all-or-nothing rolls back when any athlete fails; partial keeps the rest; unauthorized names are never echoed", async () => {
    const alex = await viewerFor(ctx, "alex");
    const s = await mkSession(ctx, { startsInMs: 3 * DAY, capacity: 10 });
    const items = [ctx.athletes.maya, ctx.athletes.ava, ctx.athletes.eli].map((athleteId) => ({ sessionId: s.id, athleteId }));
    const m0 = await avail("maya");
    const all = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: randomUUID() }));
    expect(all.committed).toBe(false);
    expect(all.results.map((x) => x.outcome)).toEqual(["rolled_back", "failed", "rolled_back"]);
    expect(all.results[1].athleteLabel).toBe("Athlete");
    expect(all.results[1].error).toMatch(/permission/);
    expect(JSON.stringify(all)).not.toMatch(/Ava/);
    expect(await liveFor(s.id)).toHaveLength(0);
    expect(await avail("maya")).toBe(m0);

    const part = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "partial", idempotencyKey: randomUUID() }));
    expect(part.committed).toBe(true);
    expect(part.results.map((x) => x.outcome)).toEqual(["booked", "failed", "booked"]);
    expect({ booked: part.booked, failed: part.failed }).toEqual({ booked: 2, failed: 1 });
    expect((await liveFor(s.id)).map((b) => b.athleteId).sort()).toEqual([ctx.athletes.maya, ctx.athletes.eli].sort());
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("each booking is validated independently: capacity and waitlist choice", async () => {
    const alex = await viewerFor(ctx, "alex");
    const s = await mkSession(ctx, { startsInMs: 3 * DAY, capacity: 1, waitlist: 2 });
    const items = [ctx.athletes.maya, ctx.athletes.eli].map((athleteId) => ({ sessionId: s.id, athleteId }));
    const strict = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: randomUUID() }));
    expect(strict.committed).toBe(false);
    expect(strict.results.find((x) => x.outcome === "failed")!.error).toMatch(/full/);
    const wl = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: randomUUID(), allowWaitlist: true }));
    expect(wl.committed).toBe(true);
    expect(wl.results.map((x) => x.outcome).sort()).toEqual(["booked", "waitlisted"]);
  });

  it("book the next N weeks: within the booking window only; partial books what's allowed, earliest first", async () => {
    const alex = await viewerFor(ctx, "alex");
    const sessions = await weeklySeries(6);
    const picked = await db().transaction((tx) => nextSeriesSessions(tx, alex, { sessionId: sessions[0].id, weeks: 6 }));
    expect(picked.map((x) => x.id)).toEqual(sessions.map((x) => x.id));
    const items = picked.map((x) => ({ sessionId: x.id, athleteId: ctx.athletes.eli }));
    // Family booking window is 21 days in the seed: weeks 1–3 open, 4–6 not yet.
    const strict = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: randomUUID() }));
    expect(strict.committed).toBe(false);
    expect(strict.failed).toBeGreaterThan(0);
    const part = await db().transaction((tx) => bookBatch(tx, alex, { items, mode: "partial", idempotencyKey: randomUUID() }));
    const okIdx = part.results.map((x, i) => (x.outcome === "booked" ? i : -1)).filter((i) => i >= 0);
    expect(okIdx.length).toBeGreaterThanOrEqual(2);
    // Successes are a prefix (earliest weeks), failures name the window.
    expect(okIdx).toEqual(okIdx.map((_, i) => i));
    for (const f of part.results.filter((x) => x.outcome === "failed")) expect(f.error).toMatch(/opens 21 days/);
  });

  it("limited credits go to the earliest sessions", async () => {
    const chris = await viewerFor(ctx, "chris");
    await giveCredits(ctx, "ava", 2);
    const sessions = await weeklySeries(3);
    const items = [...sessions].reverse().map((x) => ({ sessionId: x.id, athleteId: ctx.athletes.ava }));
    const r = await db().transaction((tx) => bookBatch(tx, chris, { items, mode: "partial", idempotencyKey: randomUUID() }));
    const bySession = new Map(r.results.map((x) => [x.sessionId, x.outcome]));
    expect(sessions.map((x) => bySession.get(x.id))).toEqual(["booked", "booked", "failed"]);
    expect(r.results.find((x) => x.outcome === "failed")!.error).toMatch(/membership or available session credits/);
    expect(await avail("ava")).toBe(0);
  });

  it("concurrency: an all-or-nothing family batch races a single booking for the last spots", async () => {
    for (let round = 0; round < 3; round++) {
      const alex = await viewerFor(ctx, "alex");
      const sam = await viewerFor(ctx, "sam");
      const s = await mkSession(ctx, { startsInMs: 4 * DAY, capacity: 2 });
      const items = [ctx.athletes.maya, ctx.athletes.eli].map((athleteId) => ({ sessionId: s.id, athleteId }));
      const key = randomUUID();
      const [a, b, c] = await Promise.allSettled([
        db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: key })),
        db().transaction((tx) => bookBatch(tx, alex, { items, mode: "all_or_nothing", idempotencyKey: key })), // double submit
        db().transaction((tx) => bookBatch(tx, sam, { items: [{ sessionId: s.id, athleteId: ctx.athletes.leo }], mode: "partial", idempotencyKey: randomUUID() })),
      ]);
      expect([a.status, b.status, c.status]).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      const rows = await liveFor(s.id);
      expect(rows.length).toBeLessThanOrEqual(2);
      const parker = rows.filter((x) => x.athleteId === ctx.athletes.maya || x.athleteId === ctx.athletes.eli);
      expect([0, 2]).toContain(parker.length); // never just one of the two
      const leo = rows.filter((x) => x.athleteId === ctx.athletes.leo);
      expect(parker.length + leo.length).toBe(rows.length);
      for (const bk of rows) {
        const reserves = await db().select().from(creditLedger).where(and(eq(creditLedger.bookingId, bk.id), eq(creditLedger.kind, "reserve")));
        expect(reserves).toHaveLength(1);
      }
    }
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("guards: kiosk refused, empty or oversized batches refused, Casey (no booking right) gets a per-athlete failure", async () => {
    const kiosk = await viewerFor(ctx, "kiosk");
    const casey = await viewerFor(ctx, "casey");
    const s = await mkSession(ctx, { startsInMs: 3 * DAY });
    await expect(db().transaction((tx) => bookBatch(tx, kiosk, { items: [{ sessionId: s.id, athleteId: ctx.athletes.leo }], mode: "partial", idempotencyKey: randomUUID() }))).rejects.toThrow();
    await expect(db().transaction((tx) => bookBatch(tx, casey, { items: [], mode: "partial", idempotencyKey: randomUUID() }))).rejects.toThrow(/at least one/);
    const many = Array.from({ length: 25 }, () => ({ sessionId: randomUUID(), athleteId: ctx.athletes.leo }));
    await expect(db().transaction((tx) => bookBatch(tx, casey, { items: many, mode: "partial", idempotencyKey: randomUUID() }))).rejects.toThrow(/at most/);
    const r = await db().transaction((tx) => bookBatch(tx, casey, { items: [{ sessionId: s.id, athleteId: ctx.athletes.leo }], mode: "partial", idempotencyKey: randomUUID() }));
    expect(r.results[0]).toMatchObject({ outcome: "failed", athleteLabel: "Leo Rivera" });
    expect(r.results[0].error).toMatch(/permission/);
  });
});
