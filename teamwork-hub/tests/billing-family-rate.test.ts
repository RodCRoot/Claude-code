/**
 * Family rate, the owner's rule (decided 2026-11-16):
 *   household, not payer; 5% × active members in the household (0 below 2), the same rate for every active
 *   member; a member on hold neither counts nor gets it; recalculated for the whole household on every
 *   membership event; capped (default 25%) with a staff task instead of a silent cap.
 * Every person here is fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { athletes, auditEvents, discounts, householdMembers, households, invoices, membershipEvents, memberships, organizations, zpMembershipDetails, payerAccounts, payerBeneficiaries, people, tasks } from "@/db/schema";
import { familyRateIfEnrolled, householdFamilyRates, syncFamilyDiscount } from "@/lib/billing/family-rate";
import { addHold, cancelMembership, createMembership, previewMembershipStart, removeHold, startInSeason } from "@/lib/billing/memberships";
import { generateRenewals } from "@/lib/billing/renewals";
import { DEFAULT_MEMBERSHIP_POLICY, familyRateLadder, familyRatePercent, membershipPolicy, policyFromSettings } from "@/lib/membership-policy";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
const db = () => testDb();
const rod = () => viewerFor(ctx, "rod");
const SYSTEM = () => ({ orgId: ctx.orgId, actorUserId: null, actorRole: "system" });

beforeAll(async () => {
  ctx = await seedOrg(T);
  B = ctx.extra.billing;
});
afterAll(closeTestDb);

type Kid = { athleteId: string; personId: string; payerId: string; name: string };

/** A fictional athlete with their own payer account (so nobody shares a payer unless a test says so). */
async function kid(first: string, last: string): Promise<Kid> {
  const [p] = await db().insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: last }).returning();
  const [a] = await db().insert(athletes).values({ orgId: ctx.orgId, personId: p.id }).returning();
  const [pa] = await db().insert(payerAccounts).values({ orgId: ctx.orgId, name: `${first} ${last} (fictional payer)` }).returning();
  await db().insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: a.id });
  return { athleteId: a.id, personId: p.id, payerId: pa.id, name: `${first} ${last}` };
}
async function household(name: string, members: Kid[]) {
  const [h] = await db().insert(households).values({ orgId: ctx.orgId, name }).returning();
  if (members.length) await db().insert(householdMembers).values(members.map((m) => ({ householdId: h.id, personId: m.personId, role: "child" as const })));
  return h.id;
}
/** A family of `n` fictional siblings in one household, each on their own payer account. */
async function family(last: string, n: number) {
  const kids: Kid[] = [];
  for (let i = 0; i < n; i++) kids.push(await kid(["Ada", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus"][i], last));
  const householdId = await household(`${last} household (fictional)`, kids);
  return { kids, householdId };
}
const enrol = async (k: Kid, opts: { start?: string; today?: string; payer?: string; version?: string } = {}) =>
  (
    await db().transaction(async (t) =>
      createMembership(t, await rod(), { athleteId: k.athleteId, payerAccountId: opts.payer ?? k.payerId, productVersionId: opts.version ?? B.ref_perf_1x_m2m, startDate: opts.start ?? "2026-11-01", today: opts.today ?? T, billingProvider: "manual" }),
    )
  ).membership;
const rateOf = async (membershipId: string) => {
  const [row] = await db().select({ d: discounts }).from(memberships).leftJoin(discounts, eq(discounts.id, memberships.discountId)).where(eq(memberships.id, membershipId));
  return row.d ? row.d.value : 0;
};
const rates = (ms: { id: string }[]) => Promise.all(ms.map((m) => rateOf(m.id)));
const eventsOf = (membershipId: string) =>
  db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, membershipId), like(membershipEvents.type, "family_discount_%"))).orderBy(asc(membershipEvents.createdAt));
const sync = () => db().transaction((t) => syncFamilyDiscount(t, SYSTEM(), ctx.orgId));
const cancelNow = async (membershipId: string, today = T) =>
  db().transaction(async (t) => cancelMembership(t, await rod(), { membershipId, requestedOn: today, requestChannel: "email", reason: "Moved away (fictional)", today, overrideCancelAt: today, overrideReason: "Owner waived the notice period" }));
const hold = async (membershipId: string, startDate: string, restartDate: string, today = T) =>
  db().transaction(async (t) => addHold(t, await rod(), { membershipId, startDate, restartDate, requestedOn: startDate, requestChannel: "email", reason: "Travel (fictional)", today }));

describe("the rule itself", () => {
  it("5% per active member from 2 up, capped; settings saved under the old flat percent migrate", () => {
    const p = DEFAULT_MEMBERSHIP_POLICY;
    expect([0, 1, 2, 3, 4, 5, 6, 9].map((n) => familyRatePercent(p, n).percent)).toEqual([0, 0, 10, 15, 20, 25, 25, 25]);
    expect(familyRatePercent(p, 5)).toEqual({ percent: 25, uncappedPercent: 25, capped: false });
    expect(familyRatePercent(p, 6)).toEqual({ percent: 25, uncappedPercent: 30, capped: true });
    expect(familyRatePercent({ familyDiscountStepPercent: 0, familyDiscountCapPercent: 25 }, 4).percent).toBe(0);
    expect(familyRateLadder(p)).toBe("2 members 10% each, 3 members 15% each, 4 members 20% each");
    // Saved before the rule changed: the flat percent is dropped, the new cap needs an owner's confirmation.
    const legacy = policyFromSettings({ membershipPolicy: { familyDiscountPercent: 15, unconfirmed: [] } });
    expect(legacy).toMatchObject({ familyDiscountStepPercent: 5, familyDiscountCapPercent: 25, unconfirmed: [] });
    expect(legacy).not.toHaveProperty("familyDiscountPercent");
    // A facility that had switched the family discount off keeps it off.
    expect(policyFromSettings({ membershipPolicy: { familyDiscountPercent: 0 } }).familyDiscountStepPercent).toBe(0);
  });
});

describe("tiers by household head count", () => {
  it("2, 3 and 4 active members: 10%, 15% and 20% on every member, on different payer accounts", async () => {
    const { kids } = await family("Quillfeather", 4);
    const ms = [await enrol(kids[0])];
    expect(await rates(ms)).toEqual([0]);
    ms.push(await enrol(kids[1]));
    expect(await rates(ms)).toEqual([10, 10]);
    ms.push(await enrol(kids[2]));
    expect(await rates(ms)).toEqual([15, 15, 15]);
    ms.push(await enrol(kids[3]));
    expect(await rates(ms)).toEqual([20, 20, 20, 20]);
    // Four different payer accounts: the payer plays no part.
    expect(new Set(ms.map((m) => m.payerAccountId)).size).toBe(4);
    // The first member's history: applied at 10, changed to 15, changed to 20, each audited.
    expect((await eventsOf(ms[0].id)).map((e) => [e.type, (e.details as { percent: number; activeMembers: number }).percent, (e.details as { activeMembers: number }).activeMembers])).toEqual([
      ["family_discount_applied", 10, 2],
      ["family_discount_changed", 15, 3],
      ["family_discount_changed", 20, 4],
    ]);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, ms[0].id), like(auditEvents.action, "billing.membership.family_discount_%")));
    expect(audits).toHaveLength(3);
    // The newest member's first bill is priced at the tier in force when it was issued (20%).
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    for (const m of ms) {
      const [inv] = await db().select().from(invoices).where(and(eq(invoices.membershipId, m.id), eq(invoices.periodStart, "2026-11-01")));
      expect(inv.totalMinor).toBe(12900 - 2580);
    }
  });

  it("same payer account but different households: no family rate", async () => {
    const a = await kid("Ines", "Makebelieve");
    const b = await kid("Otto", "Pretendson");
    await household("Makebelieve household (fictional)", [a]);
    await household("Pretendson household (fictional)", [b]);
    // One payer (say a grandparent) pays for both.
    await db().insert(payerBeneficiaries).values({ payerAccountId: a.payerId, athleteId: b.athleteId });
    const ms = [await enrol(a), await enrol(b, { payer: a.payerId })];
    expect(ms[0].payerAccountId).toBe(ms[1].payerAccountId);
    expect(await rates(ms)).toEqual([0, 0]);
    expect(await eventsOf(ms[0].id)).toEqual([]);
  });

  it("an athlete in no household is a household of one: no rate, and never grouped with others", async () => {
    const solo = await kid("Wren", "Nohousehold");
    const other = await kid("Lark", "Nohousehold");
    const ms = [await enrol(solo), await enrol(other)];
    expect(await rates(ms)).toEqual([0, 0]);
    const r = await db().transaction(async (t) => (await householdFamilyRates(t, ctx.orgId, await membershipPolicy(t, ctx.orgId))).rateOf(solo.athleteId));
    expect(r).toMatchObject({ householdId: null, headCount: 1, percent: 0 });
  });

  it("an athlete in two households gets the larger household's rate; households are not merged", async () => {
    const shared = await kid("Remy", "Twohomes");
    const halfSib = await kid("Juno", "Twohomes");
    const stepA = await kid("Kit", "Otherhome");
    const stepB = await kid("Lou", "Otherhome");
    await household("Twohomes household (fictional)", [shared, halfSib]);
    await household("Otherhome household (fictional)", [shared, stepA, stepB]);
    const ms = [await enrol(shared), await enrol(halfSib), await enrol(stepA), await enrol(stepB)];
    // Remy: 3 active in the Otherhome household. Juno: 2 in Twohomes. Kit and Lou: 3 in Otherhome.
    expect(await rates(ms)).toEqual([15, 10, 15, 15]);
  });

  it("the preview staff see before enrolling uses the household tier", async () => {
    const { kids } = await family("Previewson", 3);
    await enrol(kids[0]);
    await enrol(kids[1]);
    const preview = await db().transaction(async (t) => previewMembershipStart(t, await rod(), { athleteId: kids[2].athleteId, payerAccountId: kids[2].payerId, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-11-01" }));
    expect(preview.discountPercent).toBe(15);
    expect(preview.regular.netMinor).toBe(12900 - 1935);
    expect((await db().transaction((t) => familyRateIfEnrolled(t, ctx.orgId, kids[2].athleteId))).headCount).toBe(3);
  });
});

describe("recalculated for the whole household on every membership event", () => {
  it("hold start drops the tier for everyone and removes it from the held member; hold end restores it", async () => {
    const { kids } = await family("Holdaway", 3);
    const ms = [await enrol(kids[0], { start: T }), await enrol(kids[1], { start: T }), await enrol(kids[2], { start: T })];
    expect(await rates(ms)).toEqual([15, 15, 15]);
    const h = await hold(ms[2].id, T, "2026-12-01");
    expect((await db().select().from(memberships).where(eq(memberships.id, ms[2].id)))[0].status).toBe("on_hold");
    expect(await rates(ms)).toEqual([10, 10, 0]);
    const held = await eventsOf(ms[2].id);
    expect(held[held.length - 1]).toMatchObject({ type: "family_discount_removed", details: { onHold: true, previous: { value: 15 } } });
    // Ended early by staff: back to three active members.
    await db().transaction(async (t) => removeHold(t, await rod(), h.id, "2026-10-20"));
    expect(await rates(ms)).toEqual([15, 15, 15]);
  });

  it("a second member on hold takes the household below 2: nobody has the rate until one returns", async () => {
    const { kids } = await family("Pausewell", 2);
    const ms = [await enrol(kids[0], { start: T }), await enrol(kids[1], { start: T })];
    expect(await rates(ms)).toEqual([10, 10]);
    const h = await hold(ms[1].id, T, "2026-11-15");
    expect(await rates(ms)).toEqual([0, 0]);
    await db().transaction(async (t) => removeHold(t, await rod(), h.id, "2026-10-13"));
    expect(await rates(ms)).toEqual([10, 10]);
  });

  it("holds that start and end by date are picked up by the daily job before that day's bills", async () => {
    const { kids } = await family("Datedhold", 3);
    const ms = [await enrol(kids[0]), await enrol(kids[1]), await enrol(kids[2])];
    // Entered today for December: nothing changes yet.
    await hold(ms[2].id, "2026-12-01", "2027-01-01");
    expect(await rates(ms)).toEqual([15, 15, 15]);
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    const billed = async (id: string, period: string) => (await db().select().from(invoices).where(and(eq(invoices.membershipId, id), eq(invoices.periodStart, period))))[0]?.totalMinor ?? null;
    expect(await billed(ms[0].id, "2026-11-01")).toBe(12900 - 1935);
    // Dec 1: the hold starts. The two still training are billed at 10%; the held member is not billed.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-12-01"));
    expect(await rates(ms)).toEqual([10, 10, 0]);
    expect(await billed(ms[0].id, "2026-12-01")).toBe(12900 - 1290);
    expect(await billed(ms[2].id, "2026-12-01")).toBeNull();
    // Jan 1: the hold is over. All three are billed at 15% again, the returning member included.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2027-01-01"));
    expect(await rates(ms)).toEqual([15, 15, 15]);
    expect(await billed(ms[0].id, "2027-01-01")).toBe(12900 - 1935);
    expect(await billed(ms[2].id, "2027-01-01")).toBe(12900 - 1935);
  });

  it("In Season: the regular membership is on hold but the athlete still counts through the In Season membership", async () => {
    const { kids } = await family("Seasonal", 2);
    const twelve = B.ref_perf_3x_6mo;
    const reg = await enrol(kids[0], { start: T, version: twelve });
    const sib = await enrol(kids[1], { start: T });
    const r = await db().transaction(async (t) =>
      startInSeason(t, await rod(), { membershipId: reg.id, startDate: T, endDate: "2026-11-30", inSeasonVersionId: B.ref_in_season_1x, reason: "School season (fictional)", requestedOn: T, requestChannel: "email", today: T }),
    );
    expect(await rateOf(reg.id)).toBe(0); // on hold
    expect(await rateOf(r.inSeasonMembership.id)).toBe(10);
    expect(await rateOf(sib.id)).toBe(10);
  });

  it("cancel in both directions: a member leaving drops the tier, a new member raises it", async () => {
    const { kids } = await family("Comeandgo", 4);
    const ms = [await enrol(kids[0]), await enrol(kids[1]), await enrol(kids[2])];
    expect(await rates(ms)).toEqual([15, 15, 15]);
    await cancelNow(ms[2].id);
    expect(await rates(ms.slice(0, 2))).toEqual([10, 10]);
    await cancelNow(ms[1].id);
    expect(await rates(ms.slice(0, 1))).toEqual([0]);
    const last = await eventsOf(ms[0].id);
    expect(last.map((e) => e.type)).toEqual(["family_discount_applied", "family_discount_changed", "family_discount_changed", "family_discount_removed"]);
    // Two more enrol: back up to 15% for all three active members.
    const again = [ms[0], await enrol(kids[1]), await enrol(kids[3])];
    expect(await rates(again)).toEqual([15, 15, 15]);
  });

  it("a scheduled cancellation and an In Season expiry are handled by the renewal job (both directions)", async () => {
    const { kids } = await family("Scheduled", 3);
    const v = await rod();
    const ms = [await enrol(kids[0]), await enrol(kids[1])];
    // Fixed-term In Season membership for the third sibling: expires by itself.
    const ins = (
      await db().transaction((t) => createMembership(t, v, { athleteId: kids[2].athleteId, payerAccountId: kids[2].payerId, productVersionId: B.ref_in_season_1x, startDate: "2026-11-01", kind: "in_season", endDate: "2026-11-30", today: T, billingProvider: "manual" }))
    ).membership;
    expect(await rates([...ms, ins])).toEqual([15, 15, 15]);
    // Second sibling gives 30 days' notice on Oct 16: ends Nov 15.
    await db().transaction((t) => cancelMembership(t, v, { membershipId: ms[1].id, requestedOn: "2026-10-16", requestChannel: "email", reason: "Season ended (fictional)", today: T }));
    expect(await rates([...ms, ins])).toEqual([15, 15, 15]); // not yet
    const s = await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-15"));
    expect(s.familyDiscountChanges).toBeGreaterThanOrEqual(2);
    expect(await rates([ms[0], ins])).toEqual([10, 10]);
    // November was billed while three were active.
    const [nov] = await db().select().from(invoices).where(and(eq(invoices.membershipId, ms[0].id), eq(invoices.periodStart, "2026-11-01")));
    expect(nov.totalMinor).toBe(12900 - 1935);
    // Dec 1: the In Season term has expired. That day's bill still carries 10% (the job recalculates after
    // billing when a membership ends); the rate is gone for the bill after it.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-12-01"));
    expect((await db().select().from(memberships).where(eq(memberships.id, ins.id)))[0].status).toBe("expired");
    expect(await rateOf(ms[0].id)).toBe(0);
    const [dec] = await db().select().from(invoices).where(and(eq(invoices.membershipId, ms[0].id), eq(invoices.periodStart, "2026-12-01")));
    expect(dec.totalMinor).toBe(12900 - 1290);
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2027-01-01"));
    const [jan] = await db().select().from(invoices).where(and(eq(invoices.membershipId, ms[0].id), eq(invoices.periodStart, "2027-01-01")));
    expect(jan.totalMinor).toBe(12900);
  });

  it("a person moving household is repriced on the next recalculation (both households)", async () => {
    const a = await family("Leftbehind", 2);
    const b = await family("Arrivals", 2);
    const ms = [await enrol(a.kids[0]), await enrol(a.kids[1]), await enrol(b.kids[0]), await enrol(b.kids[1])];
    expect(await rates(ms)).toEqual([10, 10, 10, 10]);
    // Bo moves from the Leftbehind household to the Arrivals household.
    await db().update(householdMembers).set({ householdId: b.householdId }).where(and(eq(householdMembers.householdId, a.householdId), eq(householdMembers.personId, a.kids[1].personId)));
    const r = await sync();
    expect(r.changes).toHaveLength(4);
    expect(await rates(ms)).toEqual([0, 15, 15, 15]);
  });

  it("is idempotent: a second run changes nothing and writes no event, audit entry or task", async () => {
    const { kids } = await family("Twiceover", 3);
    const ms = [await enrol(kids[0]), await enrol(kids[1]), await enrol(kids[2])];
    await sync();
    const count = async () => {
      const ev = await db().execute(sql`select count(*)::int as n from membership_events e join memberships m on m.id = e.membership_id where m.org_id = ${ctx.orgId}`);
      const au = await db().execute(sql`select count(*)::int as n from audit_events where org_id = ${ctx.orgId}`);
      const tk = await db().execute(sql`select count(*)::int as n from tasks where org_id = ${ctx.orgId}`);
      return [ev.rows[0].n, au.rows[0].n, tk.rows[0].n];
    };
    const before = await count();
    const first = await sync();
    const second = await sync();
    expect(first.changes).toEqual([]);
    expect(second.changes).toEqual([]);
    expect(await count()).toEqual(before);
    expect(await rates(ms)).toEqual([15, 15, 15]);
    // The renewal job run twice for the same day is idempotent too.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    const mid = await count();
    const again = await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    expect(again.familyDiscountChanges).toBe(0);
    expect(again.invoicesCreated).toBe(0);
    expect(await count()).toEqual(mid);
  });
});

describe("what is left alone", () => {
  it("cap: 6 members would be 30%; each gets the 25% cap and staff get a task naming the household", async () => {
    const { kids, householdId } = await family("Sixpack", 6);
    const ms = [];
    for (const k of kids.slice(0, 5)) ms.push(await enrol(k));
    expect(await rates(ms)).toEqual([25, 25, 25, 25, 25]);
    const capTasks = () => db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.relatedType, "household"), eq(tasks.relatedId, householdId)));
    expect(await capTasks()).toHaveLength(0); // exactly at the cap: nothing was cut
    ms.push(await enrol(kids[5]));
    expect(await rates(ms)).toEqual([25, 25, 25, 25, 25, 25]);
    const t = await capTasks();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ source: "billing", priority: "high", status: "open" });
    expect(t[0].title).toBe("Family rate capped at 25% for Sixpack household (fictional)");
    expect(t[0].description).toContain("6 active members");
    expect(t[0].description).toContain("gives 30%");
    const ev = await eventsOf(ms[5].id);
    expect(ev[0].details).toMatchObject({ percent: 25, capped: true, uncappedPercent: 30, activeMembers: 6 });
    // Re-running does not raise the same alert twice.
    await sync();
    expect(await capTasks()).toHaveLength(1);
    // An owner raises the cap in Settings: the next recalculation gives the full 30%.
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const saved = { ...(org.settings as Record<string, unknown>) };
    await db().update(organizations).set({ settings: { ...saved, membershipPolicy: { familyDiscountCapPercent: 40 } } }).where(eq(organizations.id, ctx.orgId));
    await sync();
    expect(await rates(ms)).toEqual([30, 30, 30, 30, 30, 30]);
    await db().update(organizations).set({ settings: saved }).where(eq(organizations.id, ctx.orgId));
    await sync();
    expect(await rates(ms)).toEqual([25, 25, 25, 25, 25, 25]);
  });

  it("a sibling still billed by Zen Planner counts toward the household, and is never repriced or billed", async () => {
    const { kids } = await family("Importedsib", 2);
    const hub = await enrol(kids[0]);
    const [zp] = await db()
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: kids[1].athleteId, payerAccountId: null, productVersionId: B.ref_perf_1x_m2m, status: "active", startDate: "2026-01-01", billingProvider: "external_zenplanner", nextBillDate: "2026-11-01", source: "zenplanner" })
      .returning();
    await sync();
    // The hub-billed sibling keeps the family rate while the household is split across the two systems.
    expect(await rateOf(hub.id)).toBe(10);
    expect(await rateOf(zp.id)).toBe(0);
    // With the setting off, a household split across the two systems reads as a household of one.
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const saved = org.settings;
    await db().update(organizations).set({ settings: { ...(saved as Record<string, unknown>), membershipPolicy: { ...((saved as { membershipPolicy?: object }).membershipPolicy ?? {}), familyRateCountsZenPlannerMembers: false } } }).where(eq(organizations.id, ctx.orgId));
    await sync();
    expect(await rateOf(hub.id)).toBe(0);
    await db().update(organizations).set({ settings: saved }).where(eq(organizations.id, ctx.orgId));
    await sync();
    expect(await rateOf(hub.id)).toBe(10);
    // A one-off purchase in Zen Planner (Installment Plan "Single Payment") is not a membership and does not count.
    await db().insert(zpMembershipDetails).values({ orgId: ctx.orgId, membershipId: zp.id, planName: "Drop In (fictional)", flags: ["single_payment"] });
    await sync();
    expect(await rateOf(hub.id)).toBe(0);
    await db().update(zpMembershipDetails).set({ flags: [] }).where(eq(zpMembershipDetails.membershipId, zp.id));
    await sync();
    expect(await rateOf(hub.id)).toBe(10);
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, zp.id))).toEqual([]);
    const [after] = await db().select().from(memberships).where(eq(memberships.id, zp.id));
    expect(after).toMatchObject({ discountId: null, status: "active", nextBillDate: "2026-11-01" });
    expect(await eventsOf(zp.id)).toEqual([]);
  });

  it("a membership with another discount is not stacked or replaced, but its athlete still counts", async () => {
    const { kids } = await family("Handrate", 2);
    const ms = [await enrol(kids[0]), await enrol(kids[1])];
    const [coach] = await db().insert(discounts).values({ orgId: ctx.orgId, name: "Coach's family (fictional) 50%", kind: "percent", value: 50 }).returning();
    await db().update(memberships).set({ discountId: coach.id }).where(eq(memberships.id, ms[0].id));
    await sync();
    expect(await rates(ms)).toEqual([50, 10]);
  });

  it("past due and not-started (pending) members count; a bill already issued is never re-priced", async () => {
    const { kids } = await family("Stillenrolled", 2);
    const first = await enrol(kids[0], { start: T }); // billed today (a mid-month stub: half of $129.00), alone, no discount
    const [inv] = await db().select().from(invoices).where(eq(invoices.membershipId, first.id));
    expect(inv.totalMinor).toBe(6450);
    await db().update(memberships).set({ status: "past_due" }).where(eq(memberships.id, first.id));
    // The sibling signs up for a start next month: pending, not started, and it counts at once.
    const second = await enrol(kids[1], { start: "2026-11-01" });
    expect(second.status).toBe("pending");
    expect(await rates([first, second])).toEqual([10, 10]);
    const [same] = await db().select().from(invoices).where(eq(invoices.id, inv.id));
    expect(same).toEqual(inv);
  });
});
