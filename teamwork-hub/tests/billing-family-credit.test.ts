/**
 * Sibling credit (owner's decision, 2026-11-23: "immediately. You can prorate the sibling for a bill credit
 * for the remainder of the billing period w/ discount so it can be applied to next months bill").
 *
 *   credit = round( amount billed for the period before discounts
 *                   × (new % − old %) ÷ 100
 *                   × days remaining ÷ days in period )
 *   days remaining = the day the rate changed through the last day of the billed period, both included.
 *
 * Worked example used below (plan: $129.00 a month, billed on the 1st):
 *   Ada is billed $129.00 for 1 to 30 November (30 days), alone, so at 0%.
 *   Bo enrols on 16 November. The household has 2 active members: 10% each.
 *   Days remaining = 16..30 November = 15. Extra discount = 10 − 0 = 10%.
 *   Credit = 12900 × 10 ÷ 100 × 15 ÷ 30 = 645 cents = $6.45.
 *   Ada's December bill: $129.00 − 10% ($12.90) − credit ($6.45) = $109.65.
 *
 * Every person here is fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";
import { accountCreditLedger, athletes, auditEvents, discounts, householdMembers, households, invoices, membershipEvents, memberships, organizations, payerAccounts, payerBeneficiaries, people, products, productVersions, tasks, transactions } from "@/db/schema";
import { estimateSiblingCredits, siblingCreditMinor, siblingCreditOutstanding } from "@/lib/billing/family-credit";
import { syncFamilyDiscount } from "@/lib/billing/family-rate";
import { billPeriod, cancelMembership, createMembership, previewMembershipStart } from "@/lib/billing/memberships";
import { invoiceDetail } from "@/lib/billing/queries";
import { generateRenewals } from "@/lib/billing/renewals";
import { OPEN_DECISIONS } from "@/lib/golive/decisions";
import { computeOffers } from "@/lib/growth/offers";
import { DEFAULT_MEMBERSHIP_POLICY, POLICY_FIELDS, policyFromSettings, saveMembershipPolicy } from "@/lib/membership-policy";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-10-12";
const NOV1 = "2026-11-01";
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

type Kid = { athleteId: string; personId: string; payerId: string };
type M = typeof memberships.$inferSelect;

async function kid(first: string, last: string): Promise<Kid> {
  const [p] = await db().insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: last }).returning();
  const [a] = await db().insert(athletes).values({ orgId: ctx.orgId, personId: p.id }).returning();
  const [pa] = await db().insert(payerAccounts).values({ orgId: ctx.orgId, name: `${first} ${last} (fictional payer)` }).returning();
  await db().insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: a.id });
  return { athleteId: a.id, personId: p.id, payerId: pa.id };
}
/** A fictional household of `n` siblings, each on their own payer account. */
async function family(last: string, n: number) {
  const kids: Kid[] = [];
  for (let i = 0; i < n; i++) kids.push(await kid(["Ada", "Bo", "Cy", "Dee"][i], last));
  const [h] = await db().insert(households).values({ orgId: ctx.orgId, name: `${last} household (fictional)` }).returning();
  await db().insert(householdMembers).values(kids.map((m) => ({ householdId: h.id, personId: m.personId, role: "child" as const })));
  return { kids, householdId: h.id };
}
/** Enrol on `day` (start = today = day), so the first bill is issued at once. */
const enrolOn = async (k: Kid, day: string, version = B.ref_perf_1x_m2m) =>
  (await db().transaction(async (t) => createMembership(t, await rod(), { athleteId: k.athleteId, payerAccountId: k.payerId, productVersionId: version, startDate: day, today: day, billingProvider: "manual" }))).membership;
const sync = (today: string) => db().transaction((t) => syncFamilyDiscount(t, SYSTEM(), ctx.orgId, { today }));
const credits = (membershipId: string) =>
  db().select().from(accountCreditLedger).where(and(eq(accountCreditLedger.membershipId, membershipId), eq(accountCreditLedger.kind, "family_rate_credit"))).orderBy(asc(accountCreditLedger.createdAt), asc(accountCreditLedger.deltaMinor));
const creditTotal = async (membershipId: string) => (await credits(membershipId)).reduce((s, c) => s + c.deltaMinor, 0);
const invoicesOf = (membershipId: string) => db().select().from(invoices).where(eq(invoices.membershipId, membershipId)).orderBy(asc(invoices.periodStart));
const rateOf = async (membershipId: string) => {
  const [row] = await db().select({ d: discounts }).from(memberships).leftJoin(discounts, eq(discounts.id, memberships.discountId)).where(eq(memberships.id, membershipId));
  return row.d ? row.d.value : 0;
};
/** Issue this one membership's next bill (the daily job would bill every membership in the test organization). */
async function billNext(membershipId: string) {
  return db().transaction(async (t) => {
    const [m] = await t.select().from(memberships).where(eq(memberships.id, membershipId));
    const [row] = await t.select({ v: productVersions, name: products.name }).from(productVersions).innerJoin(products, eq(products.id, productVersions.productId)).where(eq(productVersions.id, m.productVersionId));
    return billPeriod(t, SYSTEM(), m, row.v, row.name, m.nextBillDate!);
  });
}
async function withPolicy<R>(patch: Record<string, unknown>, fn: () => Promise<R>): Promise<R> {
  const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
  const saved = org.settings as Record<string, unknown>;
  await db().update(organizations).set({ settings: { ...saved, membershipPolicy: { ...((saved.membershipPolicy as object) ?? {}), ...patch } } }).where(eq(organizations.id, ctx.orgId));
  try {
    return await fn();
  } finally {
    await db().update(organizations).set({ settings: saved }).where(eq(organizations.id, ctx.orgId));
  }
}
const cancelNow = async (membershipId: string, today: string) =>
  db().transaction(async (t) => cancelMembership(t, await rod(), { membershipId, requestedOn: today, requestChannel: "email", reason: "Moved away (fictional)", today, overrideCancelAt: today, overrideReason: "Owner waived the notice period" }));

describe("the formula", () => {
  it("base × step % × days remaining ÷ days in period, one rounding to the cent", () => {
    expect(siblingCreditMinor(12900, 10, 15, 30)).toBe(645); // the worked example
    expect(siblingCreditMinor(12900, 10, 30, 30)).toBe(1290); // first day: the whole period
    expect(siblingCreditMinor(12900, 10, 1, 30)).toBe(43); // last day: one day
    expect(siblingCreditMinor(12900, 5, 10, 30)).toBe(215);
    expect(siblingCreditMinor(23299, 5, 7, 31)).toBe(263); // 263.05... rounds down
    expect(siblingCreditMinor(12900, 0, 15, 30)).toBe(0);
    expect(siblingCreditMinor(12900, 10, 0, 30)).toBe(0);
  });

  it("the setting is on by default, in Membership policy, and not waiting for confirmation", () => {
    expect(DEFAULT_MEMBERSHIP_POLICY.familyRateSiblingCredit).toBe(true);
    expect(DEFAULT_MEMBERSHIP_POLICY.unconfirmed).not.toContain("familyRateSiblingCredit");
    expect(POLICY_FIELDS.find((f) => f.key === "familyRateSiblingCredit")).toMatchObject({ kind: "bool" });
    expect(policyFromSettings({ membershipPolicy: { familyRateSiblingCredit: false } }).familyRateSiblingCredit).toBe(false);
    const d = OPEN_DECISIONS.find((x) => x.id === "family_discount_percent")!;
    expect(d.currentBehaviour).toContain("2026-11-23");
    expect(d.value(null)).toContain("sibling credit when the rate goes up mid-period: on");
  });
});

describe("rate goes up mid-period", () => {
  let ada: M, bo: M, cy: M;
  let fam: Awaited<ReturnType<typeof family>>;

  it("second sibling joins on the 16th: the existing sibling gets $6.45, the newcomer nothing", async () => {
    fam = await family("Featherstonehaugh", 3);
    ada = await enrolOn(fam.kids[0], NOV1);
    const [nov] = await invoicesOf(ada.id);
    expect(nov).toMatchObject({ periodStart: NOV1, periodEnd: "2026-11-30", subtotalMinor: 12900, totalMinor: 12900, familyRatePercent: 0 });

    // Before Bo enrols, the staff preview estimates the credit.
    const preview = await db().transaction(async (t) => previewMembershipStart(t, await rod(), { athleteId: fam.kids[1].athleteId, payerAccountId: fam.kids[1].payerId, productVersionId: B.ref_perf_1x_m2m, startDate: "2026-11-16" }));
    expect(preview.siblingCreditOn).toBe(true);
    const est = await db().transaction((t) => estimateSiblingCredits(t, ctx.orgId, fam.kids[1].athleteId, "2026-11-16"));
    expect(est).toHaveLength(1);
    expect(est[0]).toMatchObject({ athleteId: fam.kids[0].athleteId, firstName: "Ada", fromPercent: 0, newPercent: 10, creditMinor: 645, daysRemaining: 15, daysInPeriod: 30, periodEnd: "2026-11-30" });
    expect(await credits(ada.id)).toHaveLength(0); // an estimate writes nothing

    bo = await enrolOn(fam.kids[1], "2026-11-16");
    expect([await rateOf(ada.id), await rateOf(bo.id)]).toEqual([10, 10]);

    const adaCredits = await credits(ada.id);
    expect(adaCredits).toHaveLength(1);
    expect(adaCredits[0]).toMatchObject({ deltaMinor: 645, payerAccountId: fam.kids[0].payerId, invoiceId: nov.id, currency: "USD", kind: "family_rate_credit" });
    // The bill already issued is untouched.
    const [novAfter] = await invoicesOf(ada.id);
    expect(novAfter).toMatchObject({ subtotalMinor: 12900, discountMinor: 0, totalMinor: 12900, status: nov.status });
    // What it was for is in the membership history and the audit trail.
    const [ev] = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, ada.id), eq(membershipEvents.type, "family_rate_credit")));
    expect(ev.effectiveOn).toBe("2026-11-16");
    expect(ev.details).toMatchObject({ householdId: fam.householdId, activeMembers: 2, oldPercent: 0, newPercent: 10, invoiceId: nov.id, periodStart: NOV1, periodEnd: "2026-11-30", daysRemaining: 15, daysInPeriod: 30, baseMinor: 12900, creditMinor: 645 });
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, ada.id), eq(auditEvents.action, "billing.membership.family_rate_credit")));
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toContain("$6.45");
    expect(audits[0].summary).toContain("15 of 30 days");

    // The newcomer: first bill (a partial month) already at 10%, and no credit.
    const [boFirst] = await invoicesOf(bo.id);
    expect(boFirst).toMatchObject({ periodStart: "2026-11-16", periodEnd: "2026-11-30", subtotalMinor: 6450, discountMinor: 645, familyRatePercent: 10 });
    expect(await credits(bo.id)).toHaveLength(0);
  });

  it("running the recalculation and the daily job again grants nothing more", async () => {
    expect((await sync("2026-11-16")).changes).toEqual([]);
    expect((await sync("2026-11-17")).changes).toEqual([]);
    // The first run of the daily job also bills the seeded demo memberships; the second must change nothing at all.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-17"));
    const before = await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.orgId, ctx.orgId));
    const second = await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-17"));
    expect(second.familyDiscountChanges).toBe(0);
    const after = await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.orgId, ctx.orgId));
    expect(after).toHaveLength(before.length);
    expect((await credits(ada.id)).map((c) => c.deltaMinor)).toEqual([645]);
    expect(await credits(bo.id)).toHaveLength(0);
  });

  it("third sibling joins on the 21st: both existing siblings get credit for the 10 to 15 step only", async () => {
    cy = await enrolOn(fam.kids[2], "2026-11-21");
    expect([await rateOf(ada.id), await rateOf(bo.id), await rateOf(cy.id)]).toEqual([15, 15, 15]);
    // Ada: 12900 × 5% × 10 days (21..30) ÷ 30 = 215. On top of the 645 from the first step.
    const adaCredits = await credits(ada.id);
    expect(adaCredits.map((c) => c.deltaMinor)).toEqual([645, 215]);
    // Bo: billed 6450 for 16..30 November (15 days) at 10%. 6450 × 5% × 10 ÷ 15 = 215.
    const boCredits = await credits(bo.id);
    expect(boCredits.map((c) => c.deltaMinor)).toEqual([215]);
    const [ev] = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, bo.id), eq(membershipEvents.type, "family_rate_credit")));
    expect(ev.details).toMatchObject({ oldPercent: 10, newPercent: 15, daysRemaining: 10, daysInPeriod: 15, baseMinor: 6450, creditMinor: 215, activeMembers: 3 });
    // The newcomer gets none.
    expect(await credits(cy.id)).toHaveLength(0);
    expect((await sync("2026-11-21")).changes).toEqual([]);
  });

  it("the credit is a visible line on the next bill and reduces it; the daily job is idempotent", async () => {
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-12-01"));
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-12-01"));
    const adaInvs = await invoicesOf(ada.id);
    expect(adaInvs).toHaveLength(2);
    const dec = adaInvs[1];
    // $129.00 − 15% ($19.35) − credit ($6.45 + $2.15 = $8.60) = $101.05
    expect(dec).toMatchObject({ periodStart: "2026-12-01", subtotalMinor: 12900, discountMinor: 1935 + 860, totalMinor: 10105, familyRatePercent: 15, status: "open" });
    expect(dec.memo).toContain("Family rate credit: $8.60 off this bill");
    const detail = await db().transaction(async (t) => invoiceDetail(t, await rod(), dec.id));
    expect(detail.familyCreditMinor).toBe(860);
    // Used up: nothing left for January, and the ledger nets to zero for this membership.
    expect(await db().transaction((t) => siblingCreditOutstanding(t, { id: ada.id, orgId: ctx.orgId, payerAccountId: ada.payerAccountId }))).toBe(0);
    const applied = await db().select().from(accountCreditLedger).where(and(eq(accountCreditLedger.membershipId, ada.id), eq(accountCreditLedger.kind, "applied_to_invoice")));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ deltaMinor: -860, invoiceId: dec.id });
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, dec.id), eq(auditEvents.action, "billing.invoice.family_rate_credit_applied")));
    expect(audits).toHaveLength(1);
    // Bo's December bill: $129.00 − 15% − $2.15. Cy's: no credit.
    const boDec = (await invoicesOf(bo.id))[1];
    expect(boDec).toMatchObject({ discountMinor: 1935 + 215, totalMinor: 12900 - 1935 - 215 });
    const cyDec = (await invoicesOf(cy.id)).find((i) => i.periodStart === "2026-12-01")!;
    expect(cyDec).toMatchObject({ discountMinor: 1935, totalMinor: 12900 - 1935 });
    expect(cyDec.memo ?? "").not.toContain("Family rate credit");
    // No money was recorded as received or refunded for the credit.
    expect(await db().select().from(transactions).where(eq(transactions.invoiceId, dec.id))).toHaveLength(0);
    // The month after is a plain bill again.
    const jan = await billNext(ada.id);
    expect(jan).toMatchObject({ periodStart: "2027-01-01", discountMinor: 1935, totalMinor: 12900 - 1935 });
  });
});

describe("first and last day of the period", () => {
  it("joining on the last day credits one day; on the first day, the whole period", async () => {
    const last = await family("Lastdayson", 2);
    const a = await enrolOn(last.kids[0], NOV1);
    await enrolOn(last.kids[1], "2026-11-30");
    // 12900 × 10% × 1 ÷ 30 = 43
    expect((await credits(a.id)).map((c) => c.deltaMinor)).toEqual([43]);

    const first = await family("Firstdayson", 2);
    const b = await enrolOn(first.kids[0], NOV1); // billed for November at 0% a moment before the sibling enrols
    await enrolOn(first.kids[1], NOV1);
    // 12900 × 10% × 30 ÷ 30 = 1290: the same as if the bill had been priced at 10%.
    expect((await credits(b.id)).map((c) => c.deltaMinor)).toEqual([1290]);
    const dec = await billNext(b.id);
    expect(dec.totalMinor).toBe(12900 - 1290 - 1290);
  });

  it("a member whose first bill is not issued yet gets no credit: that bill is already at the new rate", async () => {
    const { kids } = await family("Notbilledyet", 2);
    const pending = async (k: Kid) =>
      (await db().transaction(async (t) => createMembership(t, await rod(), { athleteId: k.athleteId, payerAccountId: k.payerId, productVersionId: B.ref_perf_1x_m2m, startDate: "2027-02-01", today: "2027-01-10", billingProvider: "manual" }))).membership;
    const a = await pending(kids[0]);
    const b = await pending(kids[1]);
    expect([await rateOf(a.id), await rateOf(b.id)]).toEqual([10, 10]);
    expect(await invoicesOf(a.id)).toHaveLength(0);
    expect(await credits(a.id)).toHaveLength(0);
    expect(await credits(b.id)).toHaveLength(0);
    const first = await billNext(a.id);
    expect(first).toMatchObject({ periodStart: "2027-02-01", discountMinor: 1290, totalMinor: 11610 });
  });
});

describe("who gets no credit", () => {
  it("a membership on another discount: no family rate, no credit, discount untouched", async () => {
    const { kids } = await family("Otherdiscount", 2);
    const a = await enrolOn(kids[0], NOV1);
    const [coach] = await db().insert(discounts).values({ orgId: ctx.orgId, name: "Coach's family 30% (fictional)", kind: "percent", value: 30 }).returning();
    await db().update(memberships).set({ discountId: coach.id }).where(eq(memberships.id, a.id));
    const b = await enrolOn(kids[1], "2026-11-16");
    const [after] = await db().select().from(memberships).where(eq(memberships.id, a.id));
    expect(after.discountId).toBe(coach.id);
    expect(await credits(a.id)).toHaveLength(0);
    expect(await rateOf(b.id)).toBe(10); // the athlete still counts toward the household
    expect(await db().transaction((t) => estimateSiblingCredits(t, ctx.orgId, kids[1].athleteId, "2026-11-16"))).toEqual([]);
  });

  it("an imported Zen Planner sibling: no credit, and the membership is not touched", async () => {
    const { kids } = await family("Stillinzenplanner", 2);
    const [zp] = await db()
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: kids[0].athleteId, payerAccountId: kids[0].payerId, productVersionId: B.ref_perf_1x_m2m, status: "active", startDate: "2026-01-01", billingProvider: "external_zenplanner", nextBillDate: "2026-12-01", source: "zenplanner" })
      .returning();
    // Even with an imported bill on file for the current period.
    await db().insert(invoices).values({ orgId: ctx.orgId, payerAccountId: kids[0].payerId, number: "ZP-FICTIONAL-1", status: "paid", subtotalMinor: 12900, totalMinor: 12900, membershipId: zp.id, periodStart: NOV1, periodEnd: "2026-11-30", source: "imported" });
    const hub = await enrolOn(kids[1], "2026-11-16");
    expect(await rateOf(hub.id)).toBe(10); // the imported sibling counts toward the household
    const [after] = await db().select().from(memberships).where(eq(memberships.id, zp.id));
    expect(after).toEqual(zp);
    expect(await credits(zp.id)).toHaveLength(0);
    expect(await db().select().from(membershipEvents).where(eq(membershipEvents.membershipId, zp.id))).toHaveLength(0);
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, zp.id))).toHaveLength(1);
    expect(await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.payerAccountId, kids[0].payerId))).toHaveLength(0);
  });

  it("a Stripe subscription sibling: staff task as before, saying no credit was created", async () => {
    const { kids } = await family("Onsubscription", 2);
    const [sub] = await db()
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: kids[0].athleteId, payerAccountId: kids[0].payerId, productVersionId: B.ref_perf_1x_m2m, status: "active", startDate: "2026-09-01", billingProvider: "stripe", providerSubscriptionId: "sub_fictional_credit_test" })
      .returning();
    await enrolOn(kids[1], "2026-11-16");
    const [after] = await db().select().from(memberships).where(eq(memberships.id, sub.id));
    expect(after.discountId).toBeNull();
    expect(await credits(sub.id)).toHaveLength(0);
    const [task] = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.relatedId, sub.id), like(tasks.title, "Family rate change needs the Stripe subscription updated")));
    expect(task.description).toContain("No sibling credit was created");
  });

  it("setting off: the rate still rises, no credit", async () => {
    const { kids } = await family("Settingoff", 2);
    const a = await enrolOn(kids[0], NOV1);
    await withPolicy({ familyRateSiblingCredit: false }, async () => {
      expect(await db().transaction((t) => estimateSiblingCredits(t, ctx.orgId, kids[1].athleteId, "2026-11-16"))).toEqual([]);
      await enrolOn(kids[1], "2026-11-16");
    });
    expect(await rateOf(a.id)).toBe(10);
    expect(await credits(a.id)).toHaveLength(0);
    // Turning it back on later does not hand out the missed credit: the rate did not change again.
    expect((await sync("2026-11-18")).changes).toEqual([]);
    expect(await credits(a.id)).toHaveLength(0);
    const dec = await billNext(a.id);
    expect(dec.totalMinor).toBe(12900 - 1290);
  });

  it("owners can switch the setting in Membership policy (audited)", async () => {
    const raw: Record<string, unknown> = { ...DEFAULT_MEMBERSHIP_POLICY, makeupRequiresActiveMembership: "on", commitmentRollsToMonthToMonth: "on", familyRateCountsZenPlannerMembers: "on" };
    delete raw.familyRateSiblingCredit; // an unticked checkbox is absent from the form
    delete raw.familyRateCountsSinglePayments;
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const res = await db().transaction(async (t) => saveMembershipPolicy(t, await rod(), raw));
    expect(res.ok && res.policy.familyRateSiblingCredit).toBe(false);
    await db().update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ctx.orgId));
  });
});

describe("rate goes down", () => {
  it("no credit, no charge for the period already billed; the next bill is at the lower rate", async () => {
    const { kids } = await family("Goingdown", 3);
    // Both pending before the 1st, so both November bills are issued at 10% and nobody has a credit.
    const pending = async (k: Kid) =>
      (await db().transaction(async (t) => createMembership(t, await rod(), { athleteId: k.athleteId, payerAccountId: k.payerId, productVersionId: B.ref_perf_1x_m2m, startDate: "2027-03-01", today: "2027-02-10", billingProvider: "manual" }))).membership;
    const a = await pending(kids[0]);
    const b = await pending(kids[1]);
    const mar = await billNext(a.id);
    await billNext(b.id);
    expect(mar).toMatchObject({ periodStart: "2027-03-01", totalMinor: 11610, familyRatePercent: 10 });

    const ledgerBefore = await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.orgId, ctx.orgId));
    await cancelNow(b.id, "2027-03-10");
    expect(await rateOf(a.id)).toBe(0);
    // Nothing was charged, credited or re-priced for March.
    expect(await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.orgId, ctx.orgId))).toHaveLength(ledgerBefore.length);
    const invs = await invoicesOf(a.id);
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({ subtotalMinor: 12900, discountMinor: 1290, totalMinor: 11610 });
    expect(await db().select().from(transactions).where(eq(transactions.invoiceId, invs[0].id))).toHaveLength(0);

    // The rate comes back inside the same period: March was already priced at 10%, so no credit for it.
    const c = await enrolOn(kids[2], "2027-03-20");
    expect(await rateOf(a.id)).toBe(10);
    expect(await credits(a.id)).toHaveLength(0);
    await cancelNow(c.id, "2027-03-25");
    expect(await rateOf(a.id)).toBe(0);

    // April: full price, the lower rate from the next bill.
    const apr = await billNext(a.id);
    expect(apr).toMatchObject({ periodStart: "2027-04-01", discountMinor: 0, totalMinor: 12900, familyRatePercent: 0 });
  });
});

describe("credit larger than the next bill", () => {
  it("the bill goes to $0, never below; the rest is carried to the bill after", async () => {
    const { kids } = await family("Carryforward", 2);
    const a = await enrolOn(kids[0], NOV1);
    await enrolOn(kids[1], NOV1);
    expect(await creditTotal(a.id)).toBe(1290);
    // Ada then moves to a much cheaper plan (a fictional $10.00 a month version) before the next bill.
    const [ref] = await db().select().from(productVersions).where(eq(productVersions.id, B.ref_perf_1x_m2m));
    const [cheap] = await db().insert(productVersions).values({ ...ref, id: undefined, version: ref.version + 100, priceMinor: 1000, createdAt: undefined }).returning();
    await db().update(memberships).set({ productVersionId: cheap.id }).where(eq(memberships.id, a.id));

    // December: $10.00 − 10% = $9.00, all of it covered by credit. $12.90 − $9.00 = $3.90 carried.
    const [dec] = await db().select().from(invoices).where(eq(invoices.id, (await billNext(a.id)).id));
    expect(dec).toMatchObject({ subtotalMinor: 1000, discountMinor: 1000, totalMinor: 0, status: "paid" });
    expect(dec.memo).toContain("Family rate credit: $9.00 off this bill");
    expect(dec.memo).toContain("$3.90 more is carried to the next bill");
    const ref0 = { id: a.id, orgId: ctx.orgId, payerAccountId: a.payerAccountId };
    expect(await db().transaction((t) => siblingCreditOutstanding(t, ref0))).toBe(390);
    expect(await db().select().from(transactions).where(eq(transactions.invoiceId, dec.id))).toHaveLength(0); // no refund, no payment invented

    // January: $9.00 − $3.90 = $5.10. Nothing left after that.
    const jan = await billNext(a.id);
    expect(jan).toMatchObject({ subtotalMinor: 1000, discountMinor: 100 + 390, totalMinor: 510, status: "open" });
    expect(await db().transaction((t) => siblingCreditOutstanding(t, ref0))).toBe(0);
    const feb = await billNext(a.id);
    expect(feb).toMatchObject({ discountMinor: 100, totalMinor: 900 });
    // The ledger for this membership nets to zero and never went negative.
    const rows = await db().select().from(accountCreditLedger).where(eq(accountCreditLedger.membershipId, a.id)).orderBy(asc(accountCreditLedger.createdAt));
    expect(rows.reduce((s, r) => s + r.deltaMinor, 0)).toBe(0);
  });
});

describe("the added perk in the sibling offer", () => {
  it("tells the family, and shows staff the estimate", async () => {
    const { kids } = await family("Perkwording", 2);
    // The sibling is on file on Ada's billing account, not enrolled.
    await db().insert(payerBeneficiaries).values({ payerAccountId: kids[0].payerId, athleteId: kids[1].athleteId });
    const ada = await enrolOn(kids[0], NOV1);
    await db().update(memberships).set({ status: "active" }).where(eq(memberships.id, ada.id)); // as if the November bill was paid
    const offers = await db().transaction((t) => computeOffers(t, ctx.orgId, { today: "2026-11-16", athleteIds: [kids[0].athleteId] }));
    const offer = offers.find((o) => o.key === "sibling_discount")!;
    expect(offer.familyText).toContain("Enrolling now also earns Ada a credit on next month's bill, for the higher family discount over the rest of this billing period.");
    expect(offer.familyText).not.toMatch(/[!—]/);
    expect(offer.evidence.join(" ")).toContain("Ada about $6.45");
    await withPolicy({ familyRateSiblingCredit: false }, async () => {
      const off = (await db().transaction((t) => computeOffers(t, ctx.orgId, { today: "2026-11-16", athleteIds: [kids[0].athleteId] }))).find((o) => o.key === "sibling_discount")!;
      expect(off.familyText).not.toContain("credit on next month's bill");
    });
  });
});
