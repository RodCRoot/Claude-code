import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountCreditLedger, auditEvents, creditBuckets, householdMembers, invoices, leads, memberships, people, referralCodes, referralRewards, referrals, transactions, trialPasses } from "@/db/schema";
import { createInvoiceRecord, recordManualPayment } from "@/lib/billing/invoices";
import { convertLead } from "@/lib/crm/convert";
import { createReferredInquiry } from "@/lib/growth/intake";
import { issueTrialPass } from "@/lib/growth/passes";
import {
  accountCreditBalances,
  applyAccountCredit,
  approveReward,
  attachReferralByStaff,
  declineReward,
  ensureReferralCode,
  familyReferralView,
  generateReferralCode,
  normalizeCode,
  revokeReferralCode,
  staffReferralOverview,
  syncReferrals,
} from "@/lib/growth/referrals";
import { DEFAULT_GROWTH, growthFromSettings, parseGrowthSettings, saveGrowthSettings } from "@/lib/growth/settings";
import { reportByKey, toCsv } from "@/lib/reports";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { inquiry, NO_REWARD, SAMPLE_CREDIT, setGrowth } from "./growth-helpers";

const T = "2026-03-02";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let parkerCode: string;
let riveraCode: string;

beforeAll(async () => {
  // No growth seed: every referral in this file is created by a test.
  ctx = await seedOrg(T, { modules: ["scheduling", "billing", "crm"] });
  const db = testDb();
  await setGrowth(ctx.orgId, { referral: { enabled: true, reward: SAMPLE_CREDIT } });
  parkerCode = (await ensureReferralCode(db, ctx.orgId, ctx.payers.parker)).code;
  riveraCode = (await ensureReferralCode(db, ctx.orgId, ctx.payers.rivera)).code;
});
beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
});
afterAll(closeTestDb);

/**
 * A referred public inquiry. The lead's source is relabelled afterwards so this file's many
 * inquiries do not trip the org-wide hourly ceiling on web inquiries (the per-IP limit still counts).
 */
const refer = async (code: string | null, x: Parameters<typeof inquiry>[0] = {}, meta: { ip?: string } = {}) => {
  const r = await testDb().transaction((tx) => createReferredInquiry(tx, ctx.orgId, inquiry(x), code, meta));
  await testDb().update(leads).set({ source: "web_inquiry_test" }).where(eq(leads.id, r.leadId));
  return r;
};
const referralOf = async (leadId: string) => (await testDb().select().from(referrals).where(eq(referrals.leadId, leadId)))[0];
const sync = () => testDb().transaction((tx) => syncReferrals(tx, ctx.orgId, T));

/** Converts the lead to a brand-new family and returns the new athlete + payer. */
async function convert(leadId: string) {
  const erin = await viewerFor(ctx, "erin");
  return testDb().transaction((tx) => convertLead(tx, erin, { leadId, household: "new", payer: "new", dateOfBirth: "2013-01-15" }));
}
async function invoiceFor(payerAccountId: string, athleteId: string, unitAmountMinor = 3000) {
  const erin = await viewerFor(ctx, "erin");
  const r = await testDb().transaction((tx) =>
    createInvoiceRecord(tx, { orgId: ctx.orgId, actorUserId: erin.userId, actorRole: "operations" }, { orgId: ctx.orgId, payerAccountId, lines: [{ description: "Drop-in (test)", unitAmountMinor, athleteId }] }),
  );
  return r.invoice;
}
async function payInFull(invoiceId: string) {
  const erin = await viewerFor(ctx, "erin");
  const [inv] = await testDb().select().from(invoices).where(eq(invoices.id, invoiceId));
  return testDb().transaction((tx) => recordManualPayment(tx, erin, { invoiceId, amountMinor: inv.totalMinor, method: "cash", reference: "TEST-CASH" }));
}

describe("referral codes", () => {
  it("are short, unguessable, one active per payer, and revocable", async () => {
    const db = testDb();
    const codes = new Set(Array.from({ length: 200 }, generateReferralCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{10}$/);
    expect(normalizeCode("  ABCdef2345 ")).toBe("abcdef2345");
    expect(normalizeCode("../etc/passwd")).toBeNull();
    expect(normalizeCode("")).toBeNull();
    // Concurrent first use still yields exactly one active code.
    const made = await Promise.all(Array.from({ length: 6 }, () => db.transaction((tx) => ensureReferralCode(tx, ctx.orgId, ctx.payers.dana))));
    expect(new Set(made.map((m) => m.code)).size).toBe(1);
    expect(await db.select().from(referralCodes).where(and(eq(referralCodes.payerAccountId, ctx.payers.dana), eq(referralCodes.status, "active")))).toHaveLength(1);

    const erin = await viewerFor(ctx, "erin");
    const alex = await viewerFor(ctx, "alex");
    await expect(db.transaction((tx) => revokeReferralCode(tx, alex, made[0].id))).rejects.toThrow();
    const fresh = await db.transaction((tx) => revokeReferralCode(tx, erin, made[0].id));
    expect(fresh!.code).not.toBe(made[0].code);
    // The revoked code no longer attributes, and nothing is recorded for it.
    const r = await refer(made[0].code);
    expect(r.referral).toEqual({ attributed: false, reason: "code_revoked" });
    expect(await referralOf(r.leadId)).toBeUndefined();
  });

  it("another org's payer cannot be given a code through this org", async () => {
    const other = await seedOrg(T, { modules: [] });
    await expect(ensureReferralCode(testDb(), ctx.orgId, other.payers.parker)).rejects.toThrow();
  });
});

describe("attribution rules", () => {
  it("a new family with a valid code is attributed; unknown codes record nothing and look the same", async () => {
    const ok = await refer(parkerCode);
    expect(ok.referral.attributed).toBe(true);
    const row = await referralOf(ok.leadId);
    expect(row).toMatchObject({ status: "inquired", referrerPayerAccountId: ctx.payers.parker, attachedVia: "link", rejectionReason: null });

    for (const bad of ["zzzzzzzzzz", "", "DROP TABLE", null, "x".repeat(40)]) {
      const r = await refer(bad);
      expect(r.leadId).toBeTruthy(); // the inquiry itself always succeeds
      expect(r.referral).toEqual({ attributed: false, reason: "unknown_code" });
      expect(await referralOf(r.leadId)).toBeUndefined();
    }
  });

  it("blocks self-referral (the inquirer pays on the referrer's account)", async () => {
    const r = await refer(parkerCode, { email: "alex.parker@example.test", contactFirstName: "Alex", contactLastName: "Parker" });
    expect(r.referral).toMatchObject({ attributed: false, reason: "self_referral" });
    expect(await referralOf(r.leadId)).toMatchObject({ status: "rejected", rejectionReason: "self_referral" });
    // Phone match counts too (Jordan is authorized on the same account).
    const byPhone = await refer(parkerCode, { email: undefined, phone: "(812) 555-0102" });
    expect(byPhone.referral).toMatchObject({ reason: "self_referral" });
  });

  it("blocks same-household referral, unless the org allows it", async () => {
    const db = testDb();
    const [gran] = await db.insert(people).values({ orgId: ctx.orgId, firstName: "Gran", lastName: "Parker", email: "gran.parker@example.test" }).returning();
    await db.insert(householdMembers).values({ householdId: ctx.households.parker, personId: gran.id, role: "adult" });
    const r = await refer(parkerCode, { email: "gran.parker@example.test" });
    expect(r.referral).toMatchObject({ attributed: false, reason: "same_household" });
    // A different family's code is fine for the same person.
    const viaRivera = await refer(riveraCode, { email: "gran.parker@example.test", contactLastName: "Parker-Other" });
    expect(viaRivera.referral.attributed).toBe(true);
    await db.delete(referrals).where(eq(referrals.leadId, viaRivera.leadId));

    await setGrowth(ctx.orgId, { referral: { blockSameHousehold: false } });
    const allowed = await refer(parkerCode, { email: "gran.parker@example.test", contactLastName: "Parker-Again" });
    expect(allowed.referral.attributed).toBe(true);
    await db.delete(referrals).where(eq(referrals.leadId, allowed.leadId));
    await setGrowth(ctx.orgId, { referral: { blockSameHousehold: true } });
  });

  it("blocks a family that already has a membership (must be new), configurable", async () => {
    // Sam Rivera pays for Leo, who has a membership.
    const r = await refer(parkerCode, { email: "sam.rivera@example.test", contactFirstName: "Sam", contactLastName: "Rivera" });
    expect(r.referral).toMatchObject({ attributed: false, reason: "existing_member" });
    expect(await referralOf(r.leadId)).toMatchObject({ status: "rejected", rejectionReason: "existing_member" });

    await setGrowth(ctx.orgId, { referral: { requireNewFamily: false } });
    const allowed = await refer(parkerCode, { email: "sam.rivera@example.test", contactFirstName: "Sam", contactLastName: "Rivera" });
    expect(allowed.referral.attributed).toBe(true);
    await testDb().delete(referrals).where(eq(referrals.leadId, allowed.leadId));
    await setGrowth(ctx.orgId, { referral: { requireNewFamily: true } });
  });

  it("first valid code wins: per lead, and per family across inquiries", async () => {
    const erin = await viewerFor(ctx, "erin");
    const first = await refer(parkerCode, { email: "first.wins@example.test" });
    expect(first.referral.attributed).toBe(true);
    // A second code on the same lead is refused and changes nothing.
    await expect(testDb().transaction((tx) => attachReferralByStaff(tx, erin, { leadId: first.leadId, code: riveraCode }))).rejects.toThrow(/first code wins/i);
    expect(await referralOf(first.leadId)).toMatchObject({ referrerPayerAccountId: ctx.payers.parker, status: "inquired" });
    // The same family inquiring again with another family's code does not move the credit.
    const again = await refer(riveraCode, { email: "first.wins@example.test" });
    expect(again.referral).toMatchObject({ attributed: false, reason: "already_referred" });
    expect(await referralOf(again.leadId)).toMatchObject({ status: "rejected", rejectionReason: "already_referred" });
    expect(await testDb().select().from(referrals).where(and(eq(referrals.leadId, first.leadId), eq(referrals.status, "inquired")))).toHaveLength(1);
  });

  it("staff can add a code mentioned in person; guardians and coaches cannot", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const lead = await refer(null, { email: "walkin.friend@example.test" });
    for (const who of ["alex", "marcus", "dana"]) {
      const v = await viewerFor(ctx, who);
      await expect(db.transaction((tx) => attachReferralByStaff(tx, v, { leadId: lead.leadId, code: parkerCode }))).rejects.toThrow();
    }
    await expect(db.transaction((tx) => attachReferralByStaff(tx, erin, { leadId: lead.leadId, code: "nope000000" }))).rejects.toThrow(/not an active referral code/i);
    const res = await db.transaction((tx) => attachReferralByStaff(tx, erin, { leadId: lead.leadId, code: parkerCode.toUpperCase() }));
    expect(res.attributed).toBe(true);
    expect(await referralOf(lead.leadId)).toMatchObject({ attachedVia: "staff", attachedBy: erin.userId });
  });

  it("nothing is attributed while the program is off", async () => {
    await setGrowth(ctx.orgId, { referral: { enabled: false } });
    const r = await refer(parkerCode);
    expect(r.referral).toEqual({ attributed: false, reason: "disabled" });
    expect(await referralOf(r.leadId)).toBeUndefined();
    await setGrowth(ctx.orgId, { referral: { enabled: true } });
  });

  it("referred inquiries use the same per-connection rate limit as the public form", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) await refer("zzzzzzzzzz", {}, { ip });
    await expect(refer(parkerCode, {}, { ip })).rejects.toThrow(/several inquiries/i);
  });
});

describe("reward is earned only after a settled payment, and issued only after approval", () => {
  it("inquired → started on conversion → earned only when the first invoice above $0 is PAID", async () => {
    const db = testDb();
    const r = await refer(parkerCode, { email: "earn.flow@example.test" });
    expect(await sync()).toMatchObject({ started: 0, earned: 0 });

    const fam = await convert(r.leadId);
    expect(await sync()).toMatchObject({ started: 1, earned: 0, rewards: 0 });
    expect(await referralOf(r.leadId)).toMatchObject({ status: "started", convertedAthleteId: fam.athleteId, convertedPayerAccountId: fam.payerAccountId });

    // A $0 (comp) invoice settles at once but never earns a reward.
    await invoiceFor(fam.payerAccountId, fam.athleteId, 0);
    // An open invoice earns nothing.
    const inv = await invoiceFor(fam.payerAccountId, fam.athleteId);
    expect(await sync()).toMatchObject({ earned: 0 });
    // Money in flight (pending bank payment) earns nothing: the invoice is not paid.
    const [pending] = await db
      .insert(transactions)
      .values({ orgId: ctx.orgId, payerAccountId: fam.payerAccountId, invoiceId: inv.id, kind: "charge", status: "pending", amountMinor: inv.totalMinor, currency: "USD", provider: "stripe", providerTxnId: `pi_test_${inv.id}`, verification: "provider_verified" })
      .returning();
    expect(await sync()).toMatchObject({ earned: 0 });
    expect((await referralOf(r.leadId)).status).toBe("started");
    expect(await db.select().from(referralRewards).where(eq(referralRewards.referralId, (await referralOf(r.leadId)).id))).toHaveLength(0);
    await db.update(transactions).set({ status: "failed" }).where(eq(transactions.id, pending.id));

    // Settled payment → invoice paid → reward EARNED, but only as a pending row.
    expect((await payInFull(inv.id)).invoicePaid).toBe(true);
    expect(await sync()).toMatchObject({ earned: 1, rewards: 1 });
    const ref = await referralOf(r.leadId);
    expect(ref).toMatchObject({ status: "earned", qualifyingInvoiceId: inv.id });
    const rewards = await db.select().from(referralRewards).where(eq(referralRewards.referralId, ref.id));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({ status: "pending", beneficiary: "referrer", kind: "account_credit", amountMinor: 2500, currency: "USD", payerAccountId: ctx.payers.parker });
    // Nothing was issued: no account credit exists before approval.
    expect((await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker]))[ctx.payers.parker] ?? 0).toBe(0);
    // Re-running never duplicates.
    expect(await sync()).toMatchObject({ earned: 0, rewards: 0 });
    expect(await db.select().from(referralRewards).where(eq(referralRewards.referralId, ref.id))).toHaveLength(1);
  });

  it("re-checks the rules at conversion: linking to the referrer's own family is not counted", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const r = await refer(parkerCode, { email: "sneaky.link@example.test" });
    // Staff convert the lead onto the referrer's own payer account by hand.
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    const [ath] = await db.execute(sql`insert into athletes (org_id, person_id) values (${ctx.orgId}, ${lead.personId}) returning id`).then((x) => x.rows as { id: string }[]);
    await db.execute(sql`insert into payer_beneficiaries (payer_account_id, athlete_id) values (${ctx.payers.parker}, ${ath.id})`);
    await db.update(leads).set({ convertedAthleteId: ath.id, convertedAt: new Date() }).where(eq(leads.id, r.leadId));
    expect(await sync()).toMatchObject({ rejected: 1 });
    expect(await referralOf(r.leadId)).toMatchObject({ status: "rejected", rejectionReason: "self_referral" });
    await db.execute(sql`delete from payer_beneficiaries where athlete_id = ${ath.id}`);
    expect(erin.role).toBe("operations");
  });

  it("days-active rule and a reward for the referred family", async () => {
    const db = testDb();
    await setGrowth(ctx.orgId, { referral: { earnedWhen: "days_active", daysActive: 30, referredReward: { type: "session_credits", amountMinor: null, credits: 2, creditExpiryDays: 45 } } });
    const r = await refer(riveraCode, { email: "days.active@example.test" });
    const fam = await convert(r.leadId);
    const B = ctx.extra.billing;
    const [m] = await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId: fam.athleteId, payerAccountId: fam.payerAccountId, productVersionId: B.unlimitedVersionId, status: "active", startDate: addDaysYmd(T, -10), billingProvider: "none" })
      .returning();
    expect(await sync()).toMatchObject({ earned: 0 });
    await db.update(memberships).set({ startDate: addDaysYmd(T, -31) }).where(eq(memberships.id, m.id));
    expect(await sync()).toMatchObject({ earned: 1, rewards: 2 });
    const ref = await referralOf(r.leadId);
    const rewards = await db.select().from(referralRewards).where(eq(referralRewards.referralId, ref.id));
    expect(rewards.map((x) => [x.beneficiary, x.kind, x.status]).sort()).toEqual([["referred", "session_credits", "pending"], ["referrer", "account_credit", "pending"]]);

    // Approving the referred family's session credits uses the credit ledger, once.
    const rod = await viewerFor(ctx, "rod");
    const referred = rewards.find((x) => x.beneficiary === "referred")!;
    const results = await Promise.all(Array.from({ length: 4 }, () => db.transaction((tx) => approveReward(tx, rod, { rewardId: referred.id }))));
    expect(results.filter((x) => !x.alreadyApproved)).toHaveLength(1);
    const buckets = await db.select().from(creditBuckets).where(and(eq(creditBuckets.athleteId, fam.athleteId), eq(creditBuckets.sourceKind, "staff_grant")));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ granted: 2, available: 2 });
    expect(buckets[0].expiresAt).not.toBeNull();
    await setGrowth(ctx.orgId, { referral: { earnedWhen: "first_paid_invoice", daysActive: null, referredReward: NO_REWARD } });
  });

  it("reward type none: the referral is earned and nothing is created (staff thank by hand)", async () => {
    await setGrowth(ctx.orgId, { referral: { reward: NO_REWARD } });
    const r = await refer(riveraCode, { email: "manual.thanks@example.test" });
    const fam = await convert(r.leadId);
    await payInFull((await invoiceFor(fam.payerAccountId, fam.athleteId)).id);
    expect(await sync()).toMatchObject({ earned: 1, rewards: 0 });
    await setGrowth(ctx.orgId, { referral: { reward: SAMPLE_CREDIT } });
  });
});

describe("approval", () => {
  async function earnedReward(email: string) {
    const r = await refer(parkerCode, { email });
    const fam = await convert(r.leadId);
    await payInFull((await invoiceFor(fam.payerAccountId, fam.athleteId)).id);
    await sync();
    const ref = await referralOf(r.leadId);
    const [rw] = await testDb().select().from(referralRewards).where(and(eq(referralRewards.referralId, ref.id), eq(referralRewards.beneficiary, "referrer")));
    return rw;
  }

  it("is idempotent under concurrent clicks: one ledger entry, one audit event", async () => {
    const db = testDb();
    const rw = await earnedReward("concurrent.approve@example.test");
    const before = (await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker]))[ctx.payers.parker] ?? 0;
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => db.transaction((tx) => approveReward(tx, i % 2 ? rod : erin, { rewardId: rw.id }))));
    expect(results.filter((r) => !r.alreadyApproved)).toHaveLength(1);
    expect(results.every((r) => r.reward.status === "approved")).toBe(true);
    const entries = await db.select().from(accountCreditLedger).where(eq(accountCreditLedger.rewardId, rw.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ deltaMinor: 2500, currency: "USD", kind: "referral_reward", payerAccountId: ctx.payers.parker });
    expect(((await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker]))[ctx.payers.parker] ?? 0) - before).toBe(2500);
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "growth.reward.approve"), eq(auditEvents.entityId, rw.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).not.toBeNull();
    // A later repeat click is a no-op too.
    expect((await db.transaction((tx) => approveReward(tx, rod, { rewardId: rw.id }))).alreadyApproved).toBe(true);
    expect(await db.select().from(accountCreditLedger).where(eq(accountCreditLedger.rewardId, rw.id))).toHaveLength(1);
    // Account credit is not money received.
    expect(await db.select().from(transactions).where(and(eq(transactions.payerAccountId, ctx.payers.parker), eq(transactions.kind, "adjustment")))).toHaveLength(0);
  });

  it("only billing staff approve or decline; a declined reward can never be issued", async () => {
    const db = testDb();
    const rw = await earnedReward("decline.me@example.test");
    for (const who of ["alex", "jordan", "marcus", "dana", "maya"]) {
      const v = await viewerFor(ctx, who);
      await expect(db.transaction((tx) => approveReward(tx, v, { rewardId: rw.id }))).rejects.toThrow();
      await expect(db.transaction((tx) => declineReward(tx, v, { rewardId: rw.id, reason: "x" }))).rejects.toThrow();
    }
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => declineReward(tx, erin, { rewardId: rw.id, reason: " " }))).rejects.toThrow(/reason is required/i);
    await db.transaction((tx) => declineReward(tx, erin, { rewardId: rw.id, reason: "Duplicate household (test)" }));
    await expect(db.transaction((tx) => approveReward(tx, erin, { rewardId: rw.id }))).rejects.toThrow(/declined/i);
    expect(await db.select().from(accountCreditLedger).where(eq(accountCreditLedger.rewardId, rw.id))).toHaveLength(0);
    // Another org's staff cannot touch it.
    const other = await seedOrg(T, { modules: [] });
    const otherRod = await viewerFor(other, "rod");
    await expect(db.transaction((tx) => approveReward(tx, otherRod, { rewardId: rw.id }))).rejects.toThrow(/not found/i);
  });

  it("staff apply account credit to an open invoice as a discount, never as a payment", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const alex = await viewerFor(ctx, "alex");
    const balance = (await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker]))[ctx.payers.parker];
    expect(balance).toBeGreaterThanOrEqual(2500);
    const inv = await invoiceFor(ctx.payers.parker, ctx.athletes.maya, 6000);
    await expect(db.transaction((tx) => applyAccountCredit(tx, alex, { invoiceId: inv.id, amountMinor: 1000, idempotencyKey: "k-alex" }))).rejects.toThrow();
    await expect(db.transaction((tx) => applyAccountCredit(tx, erin, { invoiceId: inv.id, amountMinor: balance + 1, idempotencyKey: "k-over" }))).rejects.toThrow(/more than the family's account credit/i);
    const two = await Promise.all([1, 2].map(() => db.transaction((tx) => applyAccountCredit(tx, erin, { invoiceId: inv.id, amountMinor: 2500, idempotencyKey: "k-1" }))));
    expect(two.filter((x) => x.applied)).toHaveLength(1);
    const [after] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(after).toMatchObject({ status: "open", subtotalMinor: 6000, discountMinor: 2500, totalMinor: 3500 });
    expect(await db.select().from(transactions).where(eq(transactions.invoiceId, inv.id))).toHaveLength(0);
    expect((await accountCreditBalances(db, ctx.orgId, [ctx.payers.parker]))[ctx.payers.parker]).toBe(balance - 2500);
    // Not on another family's invoice balance: Rivera has no credit.
    const rivInv = await invoiceFor(ctx.payers.rivera, ctx.athletes.leo, 4000);
    await expect(db.transaction((tx) => applyAccountCredit(tx, erin, { invoiceId: rivInv.id, amountMinor: 100, idempotencyKey: "k-riv" }))).rejects.toThrow(/more than the family's account credit/i);
  });
});

describe("what each person can see", () => {
  it("families see first name + last initial and a stage; never rejected referrals or other families", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const view = await db.transaction((tx) => familyReferralView(tx, alex, "https://hub.example.test/"));
    expect(view.enabled).toBe(true);
    expect(view.accounts).toHaveLength(1);
    const acct = view.accounts[0];
    expect(acct.link).toBe(`https://hub.example.test/r/${parkerCode}`);
    expect(acct.referrals.length).toBeGreaterThan(0);
    for (const r of acct.referrals) {
      expect(r.name).toMatch(/^\S+ [A-Z]\.$/);
      expect(["inquired", "started", "earned"]).toContain(r.stage);
      expect(Object.keys(r).sort()).toEqual(["date", "id", "name", "stage"]);
    }
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/@example\.test/);
    expect(json).not.toMatch(/Testfamily/); // full surnames never leave the server
    expect(json).not.toMatch(/rejected|self_referral|existing_member/);
    const mine = await db.select().from(referrals).where(and(eq(referrals.referrerPayerAccountId, ctx.payers.parker), sql`${referrals.status} <> 'rejected'`));
    expect(acct.referrals).toHaveLength(mine.length);

    // Chris (a different Parker family) sees only his own account and none of Alex's referrals.
    const chris = await viewerFor(ctx, "chris");
    const cv = await db.transaction((tx) => familyReferralView(tx, chris, "https://hub.example.test"));
    expect(cv.accounts.map((a) => a.payerAccountId)).toEqual([ctx.payers.chris_parker]);
    expect(cv.accounts[0].referrals).toHaveLength(0);
    // Casey has no billing account for Leo → no link at all.
    const casey = await viewerFor(ctx, "casey");
    expect((await db.transaction((tx) => familyReferralView(tx, casey, "https://hub.example.test"))).accounts).toHaveLength(0);
    // Staff and coaches do not use the family view.
    for (const who of ["rod", "marcus"]) await expect(familyReferralView(db, await viewerFor(ctx, who), "x")).rejects.toThrow();
  });

  it("the staff page is for CRM staff only and shows the funnel, leaderboard and pending rewards", async () => {
    const db = testDb();
    for (const who of ["alex", "marcus", "maya"]) await expect(staffReferralOverview(db, await viewerFor(ctx, who))).rejects.toThrow();
    const o = await staffReferralOverview(db, await viewerFor(ctx, "erin"));
    expect(o.funnel.inquired).toBeGreaterThanOrEqual(o.funnel.started);
    expect(o.funnel.started).toBeGreaterThanOrEqual(o.funnel.earned);
    expect(o.funnel.earned).toBeGreaterThan(0);
    expect(o.funnel.rejected).toBeGreaterThan(0);
    expect(o.leaderboard[0].name).toBeTruthy();
    expect(o.leaderboard.map((l) => l.payer_account_id)).toContain(ctx.payers.parker);
    expect(o.recent.some((r) => r.status === "rejected" && r.rejection_reason === "self_referral")).toBe(true);
  });
});

describe("trial passes", () => {
  it("issues session credits with an expiry through the credit ledger, with a reason, audited, once", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const leadId = ctx.extra.crm.lead_new;
    await expect(db.transaction((tx) => issueTrialPass(tx, erin, { leadId, credits: 2, expiresInDays: 14, reason: "  ", idempotencyKey: "pass-key-0001" }))).rejects.toThrow(/reason is required/i);
    await expect(db.transaction((tx) => issueTrialPass(tx, erin, { leadId, credits: 0, expiresInDays: 14, reason: "Open house", idempotencyKey: "pass-key-0001" }))).rejects.toThrow(/number of sessions/i);
    await expect(db.transaction((tx) => issueTrialPass(tx, erin, { leadId, credits: 2, expiresInDays: 0, reason: "Open house", idempotencyKey: "pass-key-0001" }))).rejects.toThrow(/days the pass is valid/i);
    for (const who of ["alex", "marcus", "dana", "maya"]) {
      const v = await viewerFor(ctx, who);
      await expect(db.transaction((tx) => issueTrialPass(tx, v, { leadId, credits: 2, expiresInDays: 14, reason: "Open house", idempotencyKey: "pass-key-0002" }))).rejects.toThrow();
    }
    expect(await db.select().from(trialPasses).where(eq(trialPasses.leadId, leadId))).toHaveLength(0);

    // Double click / two staff with the same form key → one pass, one bucket.
    const results = await Promise.all(Array.from({ length: 5 }, () => db.transaction((tx) => issueTrialPass(tx, erin, { leadId, credits: 2, expiresInDays: 14, reason: "Open house visit (test)", idempotencyKey: "pass-key-0003" }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const passes = await db.select().from(trialPasses).where(eq(trialPasses.leadId, leadId));
    expect(passes).toHaveLength(1);
    const pass = passes[0];
    expect(pass).toMatchObject({ credits: 2, reason: "Open house visit (test)", issuedBy: erin.userId });
    const [bucket] = await db.select().from(creditBuckets).where(eq(creditBuckets.id, pass.creditBucketId!));
    expect(bucket).toMatchObject({ athleteId: pass.athleteId, sourceKind: "staff_grant", granted: 2, available: 2, sourceInvoiceLineId: null });
    expect(Math.round((+bucket.expiresAt! - Date.now()) / 86_400_000)).toBe(14);
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "growth.trial_pass.issue"), eq(auditEvents.entityId, pass.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: erin.userId, orgId: ctx.orgId });
    expect(audits[0].summary).toMatch(/Open house visit \(test\)/);

    // The lead stays open, and converting it later reuses the same athlete record.
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead.convertedAt).toBeNull();
    const conv = await db.transaction((tx) => convertLead(tx, erin, { leadId, household: "new", payer: "new", dateOfBirth: "2013-02-02" }));
    expect(conv.athleteId).toBe(pass.athleteId);

    const rep = await reportByKey("growth-trial-passes")!.run(db, ctx.orgId, { from: addDaysYmd(T, -400), to: "2099-01-01", tz: ctx.tz });
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]).toMatchObject({ credits: 2, used: 0, converted: "Yes", joined: "No" });
  });

  it("refuses a lead from another organization", async () => {
    const other = await seedOrg(T, { modules: ["crm"] });
    const erin = await viewerFor(ctx, "erin");
    await expect(testDb().transaction((tx) => issueTrialPass(tx, erin, { leadId: other.extra.crm.lead_new, credits: 1, expiresInDays: 7, reason: "x", idempotencyKey: "pass-key-0009" }))).rejects.toThrow(/not found/i);
  });
});

describe("settings and reports", () => {
  it("defaults are off and empty; only owner/admin can save; amounts are validated and audited", async () => {
    const db = testDb();
    expect(DEFAULT_GROWTH.referral).toMatchObject({ enabled: false, reward: { type: "none", amountMinor: null, credits: null } });
    expect(growthFromSettings({}).referral.referredReward.type).toBe("none");
    const bad = parseGrowthSettings({ rewardType: "account_credit", rewardAmount: "free", referredRewardType: "session_credits", referredRewardCredits: "0", dismissalDays: "0", lowCreditsThreshold: "2", creditsExpiringDays: "14", monthToMonthMonths: "3", assessmentMonths: "6", inSeasonEndingDays: "21" });
    expect(Object.keys(bad.errors).sort()).toEqual(["dismissalDays", "referredRewardCredits", "rewardAmount"]);
    const form = { referralEnabled: "on", rewardType: "account_credit", rewardAmount: "25.00", referredRewardType: "none", earnedWhen: "first_paid_invoice", requireNewFamily: "on", blockSameHousehold: "on", howItWorks: "Thanks — really", familyFacing: "on", dismissalDays: "30", lowCreditsThreshold: "2", creditsExpiringDays: "14", monthToMonthMonths: "3", assessmentMonths: "6", inSeasonEndingDays: "21" };
    for (const who of ["erin", "marcus", "alex"]) await expect(db.transaction(async (tx) => saveGrowthSettings(tx, await viewerFor(ctx, who), form))).rejects.toThrow();
    const saved = await db.transaction(async (tx) => saveGrowthSettings(tx, await viewerFor(ctx, "rod"), form));
    expect(saved.referral.reward).toEqual({ type: "account_credit", amountMinor: 2500, credits: null, creditExpiryDays: null });
    expect(saved.referral.howItWorks).toBe("Thanks, really"); // family copy never keeps an em dash
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "growth.settings_update")));
    expect(audits).toHaveLength(1);
  });

  it("the referrals report has written definitions, runs for the org only, and exports CSV", async () => {
    const db = testDb();
    const def = reportByKey("growth-referrals")!;
    expect(def.category).toBe("Growth");
    expect(def.definition).toMatch(/only issued after staff approve/i);
    const res = await def.run(db, ctx.orgId, { from: addDaysYmd(T, -400), to: "2099-01-01", tz: ctx.tz });
    const parker = res.rows.find((r) => r.referrer === "Parker family" || String(r.referrer).includes("Parker"))!;
    expect(Number(parker.referred)).toBeGreaterThan(0);
    expect(Number(parker.rewards_approved)).toBeGreaterThan(0);
    expect(Number(parker.credit_approved_minor)).toBeGreaterThanOrEqual(2500);
    const csv = toCsv(def.columns, res.rows);
    expect(csv.split("\n")[0]).toBe("Referring family,Referred,Started,Earned,Not counted,Rewards pending,Rewards approved,Account credit approved (USD)");
    const other = await seedOrg(T, { modules: [] });
    expect((await def.run(db, other.orgId, { from: "2000-01-01", to: "2099-01-01", tz: ctx.tz })).rows).toHaveLength(0);
    for (const k of ["growth-referrals", "growth-shop-sales", "growth-offers", "growth-trial-passes"]) expect(reportByKey(k)!.cap).toBe("reports.financial");
  });
});
