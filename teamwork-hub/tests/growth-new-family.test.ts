import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, invoices, leads, memberships, referralRewards, referrals, transactions } from "@/db/schema";
import { createInvoiceRecord, recordManualPayment, voidInvoice } from "@/lib/billing/invoices";
import { requestRefund } from "@/lib/billing/refunds";
import { convertLead } from "@/lib/crm/convert";
import { createReferredInquiry } from "@/lib/growth/intake";
import { accountCreditBalances, approveReward, declineReward, ensureReferralCode, familyReferralView, REFUND_WITHHOLD_REASON, staffReferralOverview, syncReferrals } from "@/lib/growth/referrals";
import { describeNewFamilyDiscount, growthFromSettings, parseGrowthSettings } from "@/lib/growth/settings";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { inquiry, SAMPLE_CREDIT, setGrowth } from "./growth-helpers";

/**
 * Owner decision 2026-11-11: the referred (new) family gets money off their FIRST invoice.
 * Applied automatically as an invoice discount; one per new payer account; never for existing or
 * returning families or self-referrals; never twice; withheld or reversed with a refund.
 */
const T = "2026-03-02";
const db = testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let parkerCode: string;
let riveraCode: string;
type V = Awaited<ReturnType<typeof viewerFor>>;
let erin: V;
let rod: V;

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing", "crm"] });
  await setGrowth(ctx.orgId, { referral: { enabled: true, reward: SAMPLE_CREDIT, newFamilyDiscountMinor: 5000 } });
  parkerCode = (await ensureReferralCode(db, ctx.orgId, ctx.payers.parker)).code;
  riveraCode = (await ensureReferralCode(db, ctx.orgId, ctx.payers.rivera)).code;
  erin = await viewerFor(ctx, "erin");
  rod = await viewerFor(ctx, "rod");
});
afterAll(closeTestDb);

const refer = async (code: string | null, x: Parameters<typeof inquiry>[0] = {}) => {
  const r = await db.transaction((tx) => createReferredInquiry(tx, ctx.orgId, inquiry(x), code, {}));
  await db.update(leads).set({ source: "web_inquiry_test" }).where(eq(leads.id, r.leadId));
  return r;
};
const referralOf = async (leadId: string) => (await db.select().from(referrals).where(eq(referrals.leadId, leadId)))[0];
const rewardsOf = async (leadId: string) => db.select().from(referralRewards).where(eq(referralRewards.referralId, (await referralOf(leadId)).id));
const referredReward = async (leadId: string) => (await rewardsOf(leadId)).find((r) => r.beneficiary === "referred");
const sync = () => db.transaction((tx) => syncReferrals(tx, ctx.orgId, T));
const convert = (leadId: string) => db.transaction((tx) => convertLead(tx, erin, { leadId, household: "new", payer: "new", dateOfBirth: "2013-01-15" }));
const invoiceFor = async (payerAccountId: string, athleteId: string, unitAmountMinor = 12_000) =>
  (await db.transaction((tx) => createInvoiceRecord(tx, { orgId: ctx.orgId, actorUserId: erin.userId, actorRole: "operations" }, { orgId: ctx.orgId, payerAccountId, lines: [{ description: "First month (test)", unitAmountMinor, athleteId }] }))).invoice;
const inv = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const payInFull = async (invoiceId: string) => db.transaction(async (tx) => recordManualPayment(tx, erin, { invoiceId, amountMinor: (await inv(invoiceId)).totalMinor, method: "cash", reference: "TEST-CASH" }));
const refundAll = async (invoiceId: string, part?: number) => {
  const [charge] = await db.select().from(transactions).where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.kind, "manual_payment")));
  return requestRefund(db, rod, { transactionId: charge.id, amountMinor: part ?? charge.amountMinor, reason: "Test refund", offline: true, reference: "TEST-REFUND" });
};
/** A referred, converted new family. */
const newFamily = async (code = parkerCode) => {
  const r = await refer(code);
  const fam = await convert(r.leadId);
  return { ...fam, leadId: r.leadId };
};

describe("settings", () => {
  it("is off by default and is a plain amount", () => {
    expect(growthFromSettings({}).referral.newFamilyDiscountMinor).toBeNull();
    const base = { dismissalDays: "30", lowCreditsThreshold: "2", creditsExpiringDays: "14", monthToMonthMonths: "3", assessmentMonths: "6", inSeasonEndingDays: "21" };
    expect(parseGrowthSettings({ ...base, newFamilyDiscount: "" }).settings.referral.newFamilyDiscountMinor).toBeNull();
    expect(parseGrowthSettings({ ...base, newFamilyDiscount: "50" }).settings.referral.newFamilyDiscountMinor).toBe(5000);
    expect(parseGrowthSettings({ ...base, newFamilyDiscount: "$50.00" }).settings.referral.newFamilyDiscountMinor).toBe(5000);
    expect(Object.keys(parseGrowthSettings({ ...base, newFamilyDiscount: "lots" }).errors)).toEqual(["newFamilyDiscount"]);
    expect(Object.keys(parseGrowthSettings({ ...base, newFamilyDiscount: "0" }).errors)).toEqual(["newFamilyDiscount"]);
    expect(describeNewFamilyDiscount(5000)).toBe("$50.00 off their first invoice");
    expect(describeNewFamilyDiscount(null)).toBeNull();
  });

  it("the family page describes both sides without em dashes", async () => {
    const alex = await viewerFor(ctx, "alex");
    const view = await db.transaction((tx) => familyReferralView(tx, alex, "https://hub.example.test"));
    expect(view).toMatchObject({ rewardText: "a $25.00 account credit", referredRewardText: "$50.00 off their first invoice", referredIsDiscount: true });
    expect(JSON.stringify(view)).not.toMatch(/[—―]/);
  });
});

describe("applied automatically to the first invoice", () => {
  it("comes off the new family's first invoice when it is created, once, audited, and never as a payment", async () => {
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    // createInvoiceRecord hands back the invoice as it stands after the discount.
    expect(first).toMatchObject({ subtotalMinor: 12_000, discountMinor: 5000, totalMinor: 7000, status: "open" });
    const rw = (await referredReward(fam.leadId))!;
    expect(rw).toMatchObject({ kind: "invoice_discount", status: "approved", amountMinor: 5000, appliedMinor: 5000, appliedInvoiceId: first.id, payerAccountId: fam.payerAccountId, decidedBy: null });
    expect(await db.select().from(transactions).where(eq(transactions.invoiceId, first.id))).toHaveLength(0);
    expect((await accountCreditBalances(db, ctx.orgId, [fam.payerAccountId]))[fam.payerAccountId] ?? 0).toBe(0);
    const [au] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, first.id), eq(auditEvents.action, "growth.new_family_discount.apply")));
    expect(au.after).toMatchObject({ discountMinor: 5000, totalMinor: 7000, rewardId: rw.id });
    // A second invoice, and any number of further runs, change nothing.
    const second = await invoiceFor(fam.payerAccountId, fam.athleteId);
    expect(second).toMatchObject({ discountMinor: 0, totalMinor: 12_000 });
    const runs = await Promise.all(Array.from({ length: 4 }, () => sync()));
    expect(runs.reduce((n, r) => n + r.discountsApplied, 0)).toBe(0);
    expect(await inv(first.id)).toMatchObject({ discountMinor: 5000, totalMinor: 7000 });
    expect(await rewardsOf(fam.leadId)).toHaveLength(1);

    // Paying the discounted invoice earns the referring family's (pending) credit as before.
    expect((await payInFull(first.id)).invoicePaid).toBe(true);
    expect(await sync()).toMatchObject({ earned: 1, rewards: 1, discountsConverted: 0 });
    const all = await rewardsOf(fam.leadId);
    expect(all.map((r) => [r.beneficiary, r.kind, r.status]).sort()).toEqual([["referred", "invoice_discount", "approved"], ["referrer", "account_credit", "pending"]]);
    // Staff cannot "approve" the discount into account credit as well.
    await expect(db.transaction((tx) => approveReward(tx, rod, { rewardId: rw.id }))).resolves.toMatchObject({ alreadyApproved: true });
    expect((await accountCreditBalances(db, ctx.orgId, [fam.payerAccountId]))[fam.payerAccountId] ?? 0).toBe(0);
  });

  it("concurrent runs (a page load and the nightly job) apply it once", async () => {
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: null } });
    const fam = await newFamily(riveraCode);
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    expect(first.discountMinor).toBe(0); // no discount configured when the invoice was created
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: 5000 } });
    const runs = await Promise.allSettled(Array.from({ length: 5 }, () => sync()));
    expect(runs.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await inv(first.id)).toMatchObject({ discountMinor: 5000, totalMinor: 7000 });
    expect((await rewardsOf(fam.leadId)).filter((r) => r.beneficiary === "referred")).toHaveLength(1);
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, first.id), eq(auditEvents.action, "growth.new_family_discount.apply")))).toHaveLength(1);
  });

  it("is capped at the invoice: a smaller first invoice becomes $0, the rest is not carried over, and a $0 invoice earns nothing", async () => {
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId, 3000);
    expect(first).toMatchObject({ discountMinor: 3000, totalMinor: 0 });
    expect((await inv(first.id)).status).toBe("paid");
    expect(await referredReward(fam.leadId)).toMatchObject({ status: "approved", appliedMinor: 3000, amountMinor: 5000 });
    expect(await sync()).toMatchObject({ earned: 0, discountsApplied: 0, discountsConverted: 0 });
    expect((await invoiceFor(fam.payerAccountId, fam.athleteId)).discountMinor).toBe(0);
    expect((await referralOf(fam.leadId)).status).toBe("started");
  });

  it("waits while a payment is in flight, and skips invoices billed by a provider subscription", async () => {
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: null } });
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    const [pending] = await db
      .insert(transactions)
      .values({ orgId: ctx.orgId, payerAccountId: fam.payerAccountId, invoiceId: first.id, kind: "charge", status: "pending", amountMinor: first.totalMinor, currency: "USD", provider: "stripe", providerTxnId: `pi_nf_${first.id}`, verification: "provider_verified" })
      .returning();
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: 5000 } });
    expect(await sync()).toMatchObject({ discountsApplied: 0 });
    expect(await referredReward(fam.leadId)).toMatchObject({ kind: "invoice_discount", status: "pending" });
    expect((await inv(first.id)).discountMinor).toBe(0);
    // Provider-billed membership invoice: never touched.
    const [m] = await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: fam.athleteId, payerAccountId: fam.payerAccountId, productVersionId: ctx.extra.billing.unlimitedVersionId, status: "active", startDate: T, billingProvider: "stripe", providerSubscriptionId: `sub_test_${Date.now()}` })
      .returning();
    await db.update(invoices).set({ membershipId: m.id }).where(eq(invoices.id, first.id));
    await db.update(transactions).set({ status: "failed" }).where(eq(transactions.id, pending.id));
    expect(await sync()).toMatchObject({ discountsApplied: 0 });
    await db.update(invoices).set({ membershipId: null }).where(eq(invoices.id, first.id));
    expect(await sync()).toMatchObject({ discountsApplied: 1 });
    expect(await inv(first.id)).toMatchObject({ discountMinor: 5000, totalMinor: 7000 });
  });

  it("a voided first invoice gives the discount back, and it lands on the next one", async () => {
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    expect(first.discountMinor).toBe(5000);
    await db.transaction((tx) => voidInvoice(tx, erin, first.id, "Wrong plan (test)"));
    const next = await invoiceFor(fam.payerAccountId, fam.athleteId, 20_000);
    expect(next).toMatchObject({ discountMinor: 5000, totalMinor: 15_000 });
    expect(await referredReward(fam.leadId)).toMatchObject({ status: "approved", appliedInvoiceId: next.id });
    expect(await rewardsOf(fam.leadId)).toHaveLength(1);
  });
});

describe("abuse guards", () => {
  it("default off: with no amount set, nothing is reserved or applied", async () => {
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: null } });
    const fam = await newFamily();
    expect((await invoiceFor(fam.payerAccountId, fam.athleteId)).discountMinor).toBe(0);
    await sync();
    expect(await referredReward(fam.leadId)).toBeUndefined();
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: 5000 } });
  });

  it("self-referral and a lead linked onto the referrer's own account never get it", async () => {
    const [alexPerson] = (await db.execute(sql`select p.email from people p join users u on u.person_id = p.id where u.id = ${ctx.users.alex}`)).rows as { email: string }[];
    const self = await refer(parkerCode, { email: alexPerson.email });
    expect(self.referral).toMatchObject({ attributed: false, reason: "self_referral" });
    const r = await refer(parkerCode);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    const [ath] = (await db.execute(sql`insert into athletes (org_id, person_id) values (${ctx.orgId}, ${lead.personId}) returning id`)).rows as { id: string }[];
    await db.execute(sql`insert into payer_beneficiaries (payer_account_id, athlete_id) values (${ctx.payers.parker}, ${ath.id})`);
    await db.update(leads).set({ convertedAthleteId: ath.id, convertedAt: new Date() }).where(eq(leads.id, r.leadId));
    const own = await invoiceFor(ctx.payers.parker, ath.id);
    expect(own.discountMinor).toBe(0);
    expect(await referralOf(r.leadId)).toMatchObject({ status: "rejected", rejectionReason: "self_referral" });
    expect(await db.select().from(referralRewards).where(and(eq(referralRewards.payerAccountId, ctx.payers.parker), eq(referralRewards.beneficiary, "referred")))).toHaveLength(0);
    await db.execute(sql`delete from payer_beneficiaries where athlete_id = ${ath.id}`);
  });

  it("existing or returning families never get it, even when 'the referred family must be new' is switched off", async () => {
    await setGrowth(ctx.orgId, { referral: { requireNewFamily: false } });
    // Returning family: the billing account already had an invoice before the inquiry.
    const a = await newFamily();
    const [old] = await db
      .insert(invoices)
      .values({ orgId: ctx.orgId, payerAccountId: a.payerAccountId, number: `OLD-${Date.now()}`, status: "void", currency: "USD", subtotalMinor: 1000, discountMinor: 0, taxMinor: 0, totalMinor: 1000, createdAt: new Date(Date.now() - 400 * 86_400_000) })
      .returning();
    expect(old.id).toBeTruthy();
    expect((await invoiceFor(a.payerAccountId, a.athleteId)).discountMinor).toBe(0);
    expect(await referredReward(a.leadId)).toBeUndefined();
    // Existing member: the athlete had a membership before the inquiry.
    const b = await newFamily();
    await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: b.athleteId, payerAccountId: b.payerAccountId, productVersionId: ctx.extra.billing.unlimitedVersionId, status: "cancelled", startDate: addDaysYmd(T, -400), billingProvider: "none", createdAt: new Date(Date.now() - 400 * 86_400_000) });
    expect((await invoiceFor(b.payerAccountId, b.athleteId)).discountMinor).toBe(0);
    expect(await referralOf(b.leadId)).toMatchObject({ status: "started" }); // the referral itself still counts (setting is off)
    expect(await referredReward(b.leadId)).toBeUndefined();
    await setGrowth(ctx.orgId, { referral: { requireNewFamily: true } });
  });

  it("one per payer account: a second referral onto the same billing account does not stack", async () => {
    await setGrowth(ctx.orgId, { referral: { requireNewFamily: false, blockSameHousehold: false } });
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    expect(first.discountMinor).toBe(5000);
    // A sibling arrives through another family's link and is put on the same billing account.
    const r2 = await refer(riveraCode);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r2.leadId));
    const [sib] = (await db.execute(sql`insert into athletes (org_id, person_id) values (${ctx.orgId}, ${lead.personId}) returning id`)).rows as { id: string }[];
    await db.execute(sql`insert into payer_beneficiaries (payer_account_id, athlete_id) values (${fam.payerAccountId}, ${sib.id})`);
    await db.update(leads).set({ convertedAthleteId: sib.id, convertedAt: new Date() }).where(eq(leads.id, r2.leadId));
    const sibInv = await invoiceFor(fam.payerAccountId, sib.id);
    expect(sibInv.discountMinor).toBe(0);
    await sync();
    expect(await referredReward(r2.leadId)).toBeUndefined();
    expect(await db.select().from(referralRewards).where(and(eq(referralRewards.payerAccountId, fam.payerAccountId), eq(referralRewards.beneficiary, "referred")))).toHaveLength(1);
    // The database refuses a second live new-family reward for the account outright.
    const ref2 = await referralOf(r2.leadId);
    await expect(db.insert(referralRewards).values({ orgId: ctx.orgId, referralId: ref2.id, beneficiary: "referred", payerAccountId: fam.payerAccountId, kind: "invoice_discount", amountMinor: 5000, currency: "USD" })).rejects.toThrow();
    await setGrowth(ctx.orgId, { referral: { requireNewFamily: true, blockSameHousehold: true } });
  });

  it("staff can decline a reserved discount before it applies; the database refuses impossible rows", async () => {
    const fam = await newFamily();
    expect(await sync()).toMatchObject({ started: 1 });
    const rw = (await referredReward(fam.leadId))!;
    expect(rw).toMatchObject({ kind: "invoice_discount", status: "pending", appliedInvoiceId: null });
    await expect(db.transaction((tx) => approveReward(tx, rod, { rewardId: rw.id }))).rejects.toThrow(/applied automatically/);
    const alex = await viewerFor(ctx, "alex");
    await expect(db.transaction((tx) => declineReward(tx, alex, { rewardId: rw.id, reason: "x" }))).rejects.toThrow();
    await db.transaction((tx) => declineReward(tx, erin, { rewardId: rw.id, reason: "Known family (test)" }));
    expect((await invoiceFor(fam.payerAccountId, fam.athleteId)).discountMinor).toBe(0);
    const ref = await referralOf(fam.leadId);
    // invoice_discount is only for the referred side, and "applied" needs an invoice and an amount.
    await expect(db.insert(referralRewards).values({ orgId: ctx.orgId, referralId: ref.id, beneficiary: "referrer", payerAccountId: ctx.payers.parker, kind: "invoice_discount", amountMinor: 5000, currency: "USD" })).rejects.toThrow();
    await expect(db.update(referralRewards).set({ appliedMinor: 100 }).where(eq(referralRewards.id, rw.id))).rejects.toThrow();
  });
});

describe("first invoice already paid, and refunds", () => {
  it("if the first invoice was paid before the discount could apply, it becomes account credit that needs staff approval", async () => {
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: null } });
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    await payInFull(first.id);
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: 5000 } });
    expect(await sync()).toMatchObject({ earned: 1, discountsApplied: 0, discountsConverted: 1 });
    const rw = (await referredReward(fam.leadId))!;
    expect(rw).toMatchObject({ kind: "account_credit", status: "pending", amountMinor: 5000, appliedInvoiceId: null });
    expect((await accountCreditBalances(db, ctx.orgId, [fam.payerAccountId]))[fam.payerAccountId] ?? 0).toBe(0);
    await db.transaction((tx) => approveReward(tx, erin, { rewardId: rw.id }));
    expect((await accountCreditBalances(db, ctx.orgId, [fam.payerAccountId]))[fam.payerAccountId]).toBe(5000);
    // Later invoices are not discounted as well.
    expect((await invoiceFor(fam.payerAccountId, fam.athleteId)).discountMinor).toBe(0);
  });

  it("a first payment refunded in full before anyone looked does not earn", async () => {
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    await payInFull(first.id);
    expect((await refundAll(first.id)).status).toBe("succeeded");
    expect(await sync()).toMatchObject({ earned: 0, rewards: 0 });
    expect((await referralOf(fam.leadId)).status).toBe("started");
    // The family got back what they paid ($70), not the discounted $50 as well.
    const [refund] = await db.select().from(transactions).where(and(eq(transactions.invoiceId, first.id), eq(transactions.kind, "refund")));
    expect(Math.abs(refund.amountMinor)).toBe(7000);
  });

  it("a full refund after earning withholds every pending reward; a partial refund does not; approval is refused", async () => {
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: null } });
    const fam = await newFamily();
    const first = await invoiceFor(fam.payerAccountId, fam.athleteId);
    await payInFull(first.id);
    await setGrowth(ctx.orgId, { referral: { newFamilyDiscountMinor: 5000 } });
    expect(await sync()).toMatchObject({ earned: 1, rewards: 1, discountsConverted: 1 });
    await refundAll(first.id, 1000);
    expect(await sync()).toMatchObject({ withheld: 0 });
    const overview = await staffReferralOverview(db, erin);
    expect(overview.rewards.filter((r) => r.lead_id === fam.leadId).every((r) => r.first_payment_refunded)).toBe(true);
    await refundAll(first.id, 11_000);
    const pendingReferrer = (await rewardsOf(fam.leadId)).find((r) => r.beneficiary === "referrer")!;
    await expect(db.transaction((tx) => approveReward(tx, rod, { rewardId: pendingReferrer.id }))).rejects.toThrow(/refunded/);
    expect(await sync()).toMatchObject({ withheld: 2 });
    const after = await rewardsOf(fam.leadId);
    expect(after.every((r) => r.status === "declined" && r.declineReason === REFUND_WITHHOLD_REASON && r.decidedBy === null)).toBe(true);
    expect((await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker, fam.payerAccountId]))[fam.payerAccountId] ?? 0).toBe(0);
    expect(await sync()).toMatchObject({ withheld: 0 });
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, pendingReferrer.id), eq(auditEvents.action, "growth.reward.withhold")))).toHaveLength(1);
  });
});
