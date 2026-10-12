import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { auditEvents, bookings, cancellationPolicies, creditLedger, tasks } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { bookingNetCharge, creditSummary, verifyLedger } from "@/lib/credits";
import { bookSession, markAttendance, restoreBookingCredit } from "@/lib/scheduling";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { giveCredits, mkServiceType, mkSession } from "./scheduling-helpers";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
  await db().execute(sql`update memberships set status = 'cancelled' where org_id = ${ctx.orgId}`);
  for (const k of ["ethan", "sofia", "liam"]) await giveCredits(ctx, k, 10);
});
afterAll(closeTestDb);

const avail = async (k: string) => (await creditSummary(db(), ctx.athletes[k])).available;
const net = async (bookingId: string) => (await bookingNetCharge(db(), bookingId))!.net;

async function policyService(noShowPenalty: "none" | "fee" | "forfeit_credit") {
  const [p] = await db()
    .insert(cancellationPolicies)
    .values({ orgId: ctx.orgId, name: `Test ${noShowPenalty}`, lateCancelWindowMinutes: 60, lateCancelPenalty: "none", noShowPenalty, feeMinor: noShowPenalty === "fee" ? 1000 : 0 })
    .returning();
  return mkServiceType(ctx, { cancellationPolicyId: p.id });
}

async function startedBooking(athleteKey: string, serviceTypeId: string) {
  const erin = await viewerFor(ctx, "erin");
  const s = await mkSession(ctx, { serviceTypeId, startsInMs: -30 * 60_000, coach: ctx.users.marcus });
  const b = await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes[athleteKey] }));
  return b.booking.id;
}

describe("attendance corrections re-settle credits", () => {
  it("no-penalty policy: no-show → attended re-consumes; back and forth stays exact; audited", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const st = await policyService("none");
    const start = await avail("ethan");
    const id = await startedBooking("ethan", st.id);
    expect(await avail("ethan")).toBe(start - 1);
    const mark = (outcome: "attended" | "no_show") => db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome }));

    await mark("no_show");
    expect(await avail("ethan")).toBe(start); // released under "none"
    expect(await net(id)).toBe(0);

    const r = await mark("attended"); // the documented gap: this used to leave the credit unspent
    expect(r).toMatchObject({ status: "attended", changed: true, creditDelta: -1 });
    expect(await avail("ethan")).toBe(start - 1);
    expect(await net(id)).toBe(1);

    await mark("no_show");
    expect(await avail("ethan")).toBe(start);
    await mark("attended");
    expect(await avail("ethan")).toBe(start - 1);
    expect(await net(id)).toBe(1);

    const corrections = await db().select().from(creditLedger).where(like(creditLedger.idempotencyKey, `correct:${id}:%`));
    expect(corrections.map((c) => [c.kind, c.deltaAvailable]).sort()).toEqual([
      ["consume", -1],
      ["consume", -1],
      ["restore", 1],
    ]);
    const audit = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "booking.attendance_correct")));
    expect(audit).toHaveLength(3);
    expect(audit.map((a) => a.summary).join(" ")).toMatch(/re-charged/);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("fee policy: correcting to attended charges the credit and cancels the pending fee; back to no-show reopens the same fee task", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const st = await policyService("fee");
    const start = await avail("sofia");
    const id = await startedBooking("sofia", st.id);
    const mark = (outcome: "attended" | "no_show") => db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome }));
    const feeTasks = () => db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `sched-fee:${id}`)));

    await mark("no_show");
    expect((await feeTasks()).map((t) => t.status)).toEqual(["open"]);
    expect(await avail("sofia")).toBe(start);

    await mark("attended");
    expect((await feeTasks()).map((t) => t.status)).toEqual(["cancelled"]);
    expect(await avail("sofia")).toBe(start - 1);

    await mark("no_show");
    expect((await feeTasks()).map((t) => t.status)).toEqual(["open"]);
    expect(await avail("sofia")).toBe(start);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("forfeit policy: corrections in either direction keep the credit used", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const start = await avail("liam");
    const id = await startedBooking("liam", ctx.extra.scheduling.gpt); // seed SAMPLE policy forfeits on no-show
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "attended" }));
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "no_show" }));
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "attended" }));
    expect(await avail("liam")).toBe(start - 1);
    expect(await db().select().from(creditLedger).where(like(creditLedger.idempotencyKey, `correct:${id}:%`))).toHaveLength(0);
  });

  it("a staff credit restore is final: a later correction to attended does not re-charge it", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin");
    const start = await avail("liam");
    const id = await startedBooking("liam", ctx.extra.scheduling.gpt);
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "no_show" })); // forfeit
    await db().transaction((tx) => restoreBookingCredit(tx, erin, { bookingId: id, reason: "Excused: injury" }));
    expect(await avail("liam")).toBe(start);
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "attended" }));
    expect(await avail("liam")).toBe(start);
    // And attended → no-show under a release policy after a restore never double-refunds.
    const st = await policyService("none");
    const id2 = await startedBooking("liam", st.id);
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id2, outcome: "attended" }));
    await db().transaction((tx) => restoreBookingCredit(tx, erin, { bookingId: id2, reason: "Goodwill" }));
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id2, outcome: "no_show" }));
    expect(await net(id2)).toBe(0);
    expect(await avail("liam")).toBe(start);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("refuses (and changes nothing) when no credit is left to re-charge", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin");
    await giveCredits(ctx, "harper", 1);
    const st = await policyService("none");
    const id = await startedBooking("harper", st.id);
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "no_show" })); // credit back
    const other = await mkSession(ctx, { startsInMs: 2 * 24 * 3_600_000 });
    await db().transaction((tx) => bookSession(tx, erin, { sessionId: other.id, athleteId: ctx.athletes.harper })); // spends it
    expect(await avail("harper")).toBe(0);
    const err = await db()
      .transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "attended" }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/no session credit left/);
    const [row] = await db().select().from(bookings).where(eq(bookings.id, id));
    expect(row.status).toBe("no_show");
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("concurrent corrections of the same booking charge exactly once", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin");
    const st = await policyService("none");
    const start = await avail("ethan");
    const id = await startedBooking("ethan", st.id);
    await db().transaction((tx) => markAttendance(tx, marcus, { bookingId: id, outcome: "no_show" }));
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => db().transaction((tx) => markAttendance(tx, i % 2 ? erin : marcus, { bookingId: id, outcome: "attended" }))),
    );
    expect(res.filter((r) => r.changed)).toHaveLength(1);
    expect(await avail("ethan")).toBe(start - 1);
    expect(await net(id)).toBe(1);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });
});
