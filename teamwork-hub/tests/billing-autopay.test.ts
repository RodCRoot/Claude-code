import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { auditEvents, disputes, invoices, jobs, memberships, organizations, paymentAttempts, paymentMethods, tasks, transactions } from "@/db/schema";
import { AUTOPAY_JOB, chargeInvoiceAutopay, chargeInvoiceNow, chargeNowView, classifyAchFailure, failedAutopayNotices, FEE_JOB, processingFeesByMonth, recordProcessorFee, unpaidAutopayBills } from "@/lib/billing/autopay";
import { autopaySettingsOf, bankPayDiscountMinor, DEFAULT_AUTOPAY_SETTINGS, estimateFeeMinor, saveAutopaySettings } from "@/lib/billing/autopay-settings";
import { createProduct } from "@/lib/billing/catalog";
import { classifyDecline } from "@/lib/billing/declines";
import { invoiceMoney } from "@/lib/billing/invoices";
import { createMembership } from "@/lib/billing/memberships";
import { setMembershipAutopay } from "@/lib/billing/payment-methods";
import { generateRenewals } from "@/lib/billing/renewals";
import { addDaysYmd, localYmd } from "@/lib/time";
import { TEST_WHSEC } from "./fixtures/payments/stripe";
import { achDisputeCreated, paymentIntentEvent, stripeMethodsApi } from "./fixtures/payments/methods";
import { activeMethod, sendStripe } from "./billing-helpers";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-03-02";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let versionId: string;
const db = () => testDb();
const who = (k: string) => viewerFor(ctx, k);
const PRICE = 20000;

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["billing"] });
  const p = await db().transaction(async (tx) => createProduct(tx, await who("rod"), { name: "Test Autopay Monthly", kind: "recurring_membership", version: { priceMinor: PRICE, interval: "month", unlimited: true, effectiveFrom: "2020-01-01" } }));
  versionId = p.version.id;
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_real";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  await closeTestDb();
});

let dayOffset = 10;
/**
 * A membership for `athleteKey` whose first bill is issued by the renewal job with autopay already on.
 * Each call uses a later start date so the family discount and earlier invoices never interfere.
 */
async function autopayBill(athleteKey: string, payerKey: string, type: "card" | "us_bank_account") {
  const rod = await who("rod");
  const start = addDaysYmd(T, (dayOffset += 3));
  await db().update(paymentMethods).set({ status: "removed", isDefault: false }).where(eq(paymentMethods.payerAccountId, ctx.payers[payerKey]));
  await db().update(memberships).set({ status: "cancelled", autopay: false }).where(and(eq(memberships.athleteId, ctx.athletes[athleteKey]), eq(memberships.orgId, ctx.orgId)));
  const method = await activeMethod(ctx.payers[payerKey], { type });
  const { membership } = await db().transaction((tx) =>
    createMembership(tx, rod, { athleteId: ctx.athletes[athleteKey], payerAccountId: ctx.payers[payerKey], productVersionId: versionId, startDate: start, billingAnchorDay: Number(start.slice(8, 10)), today: T }),
  );
  await db().transaction((tx) => setMembershipAutopay(tx, rod, { membershipId: membership.id, autopay: true }));
  await db().transaction((tx) => generateRenewals(tx, ctx.orgId, start));
  const [inv] = await db().select().from(invoices).where(eq(invoices.membershipId, membership.id));
  return { membership, inv, method, start };
}
const charge = (invoiceId: string, attemptNumber = 1) => chargeInvoiceAutopay(db(), { orgId: ctx.orgId, invoiceId, attemptNumber });
const attemptsOf = (invoiceId: string) => db().select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId)).orderBy(paymentAttempts.createdAt);
const jobFor = async (invoiceId: string, n: number) => (await db().select().from(jobs).where(eq(jobs.dedupeKey, `${AUTOPAY_JOB}:${invoiceId}:${n}`)))[0];
const invRow = async (id: string) => (await db().select().from(invoices).where(eq(invoices.id, id)))[0];
const tasksLike = (s: string) => db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), like(tasks.title, s)));

describe("issuing a bill with autopay on", () => {
  it("queues exactly one charge per invoice, and charging is idempotent under repeats and concurrency", async () => {
    const { inv, start, method } = await autopayBill("ava", "chris_parker", "card");
    expect(inv.status).toBe("open");
    expect((await jobFor(inv.id, 1)).payload).toMatchObject({ invoiceId: inv.id, attemptNumber: 1 });
    // Issuing again (job re-run, same day) creates no new invoice and no second job.
    const again = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, start));
    expect(again.invoicesCreated).toBe(0);
    expect(await db().select().from(jobs).where(like(jobs.dedupeKey, `${AUTOPAY_JOB}:${inv.id}:%`))).toHaveLength(1);

    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    const results = await Promise.all([charge(inv.id), charge(inv.id), charge(inv.id), charge(inv.id)]);
    expect(results.filter((r) => r.charged)).toHaveLength(1);
    expect((await charge(inv.id)).charged).toBe(false);
    const posts = api.calls.filter((c) => c.path === "/v1/payment_intents" && c.method === "POST");
    expect(posts).toHaveLength(1);
    const p = posts[0].params;
    expect(p.get("amount")).toBe(String(PRICE));
    expect(p.get("off_session")).toBe("true");
    expect(p.get("confirm")).toBe("true");
    expect(p.get("payment_method")).toBe(method.providerMethodId);
    expect(p.get("customer")).toBe(method.providerCustomerId);
    expect(p.get("metadata[origin]")).toBe("autopay");
    expect(posts[0].idempotencyKey).toBe(`autopay:${inv.id}:1`);
    const atts = await attemptsOf(inv.id);
    expect(atts).toHaveLength(1);
    // Stripe answered "succeeded", but nothing is paid until the verified webhook says so.
    expect(atts[0]).toMatchObject({ origin: "autopay", status: "created", paymentMethodId: method.id, methodType: "card" });
    expect((await invRow(inv.id)).status).toBe("open");

    const ok = paymentIntentEvent("payment_intent.succeeded", { pi: atts[0].providerRef!, attemptId: atts[0].id, invoiceId: inv.id, amount: PRICE, methodType: "card" });
    await Promise.all([sendStripe(ok), sendStripe(ok)]);
    expect((await invRow(inv.id)).status).toBe("paid");
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, inv.id));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ kind: "charge", status: "settled", amountMinor: PRICE, methodType: "card", verification: "provider_verified", feeMinor: 0, feeReportedAt: null });
    // Paid: a late or duplicated job does nothing.
    expect(await charge(inv.id, 2)).toMatchObject({ charged: false, reason: "not_open" });
    expect(api.calls.filter((c) => c.path === "/v1/payment_intents" && c.method === "POST")).toHaveLength(1);

    // The processor's fee is recorded from Stripe's balance transaction, once.
    expect((await db().select().from(jobs).where(eq(jobs.dedupeKey, `${FEE_JOB}:${atts[0].providerRef}`)))).toHaveLength(1);
    const feeApi = stripeMethodsApi({ feeMinor: 610 });
    vi.stubGlobal("fetch", feeApi.fn);
    expect(await recordProcessorFee(db(), { orgId: ctx.orgId, providerTxnId: atts[0].providerRef! })).toMatchObject({ recorded: true, feeMinor: 610 });
    expect(await recordProcessorFee(db(), { orgId: ctx.orgId, providerTxnId: atts[0].providerRef! })).toMatchObject({ recorded: false, reason: "already_recorded" });
    const [t] = await db().select().from(transactions).where(eq(transactions.invoiceId, inv.id));
    expect(t.feeMinor).toBe(610);
    expect(t.feeReportedAt).not.toBeNull();
    const month = localYmd(new Date()).slice(0, 7);
    const fees = await db().transaction((tx) => processingFeesByMonth(tx, ctx.orgId));
    expect(fees.find((f) => f.month === month && f.methodType === "card")).toMatchObject({ feeMinor: 610, paymentsWithFee: 1 }); // seeded card payments have no reported fee and are counted as "fee unknown"
  });

  it("an attempt left behind by a crash before Stripe answered is resumed with the same idempotency key", async () => {
    const { inv, method } = await autopayBill("ava", "chris_parker", "card");
    const old = new Date(Date.now() - 30 * 60_000);
    await db().insert(paymentAttempts).values({ orgId: ctx.orgId, invoiceId: inv.id, provider: "stripe", amountMinor: PRICE, currency: "USD", methodType: "card", status: "created", idempotencyKey: `autopay:${inv.id}:1`, origin: "autopay", paymentMethodId: method.id, createdAt: old });
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    expect((await charge(inv.id)).charged).toBe(true);
    expect(api.calls.filter((c) => c.path === "/v1/payment_intents").map((c) => c.idempotencyKey)).toEqual([`autopay:${inv.id}:1`]);
    expect(await attemptsOf(inv.id)).toHaveLength(1);
  });

  it("a stale or out-of-sequence attempt number is a no-op, and a PaymentIntent event not created by autopay is ignored", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "card");
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    expect(await charge(inv.id, 2)).toMatchObject({ charged: false, reason: "stale" });
    expect(api.calls).toHaveLength(0);
    const r = await sendStripe(paymentIntentEvent("payment_intent.succeeded", { pi: "pi_checkout_like", attemptId: "00000000-0000-4000-8000-000000000001", invoiceId: inv.id, amount: PRICE, methodType: "card", origin: null }));
    expect(r.body).toMatchObject({ outcome: "ignored" });
    expect((await invRow(inv.id)).status).toBe("open");
  });

  it("without Stripe keys nothing is attempted or written, and the bill stays payable manually", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "card");
    delete process.env.STRIPE_SECRET_KEY;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await charge(inv.id)).toMatchObject({ charged: false, reason: "not_configured" });
    expect(f).not.toHaveBeenCalled();
    expect(await attemptsOf(inv.id)).toHaveLength(0);
    expect((await invRow(inv.id)).status).toBe("open");
  });

  it("autopay on but no active method: no attempt, a staff task", async () => {
    const { inv, method } = await autopayBill("ava", "chris_parker", "card");
    await db().update(paymentMethods).set({ status: "failed", isDefault: false }).where(eq(paymentMethods.id, method.id));
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    expect(await charge(inv.id)).toMatchObject({ charged: false, reason: "no_method" });
    expect(api.calls).toHaveLength(0);
    expect(await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-nomethod:${inv.id}`))).toHaveLength(1);
  });
});

describe("bank debits (ACH)", () => {
  it("stays 'pending bank payment' for days and is paid only on payment_intent.succeeded; the mandate is sent with the charge", async () => {
    const { inv, method, membership } = await autopayBill("ava", "chris_parker", "us_bank_account");
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    expect((await charge(inv.id)).charged).toBe(true);
    const post = api.calls.find((c) => c.path === "/v1/payment_intents")!;
    expect(post.params.get("payment_method_types[0]")).toBe("us_bank_account");
    expect(post.params.get("mandate")).toBe(method.mandateRef);
    const [a] = await attemptsOf(inv.id);
    const ev = { pi: a.providerRef!, attemptId: a.id, invoiceId: inv.id, amount: PRICE, methodType: "us_bank_account" as const };
    await sendStripe(paymentIntentEvent("payment_intent.processing", ev));
    expect((await attemptsOf(inv.id))[0].status).toBe("processing");
    expect((await invRow(inv.id)).status).toBe("open");
    let money = await db().transaction((tx) => invoiceMoney(tx, inv.id));
    expect(money).toMatchObject({ pendingMinor: PRICE, settledMinor: 0, balanceMinor: PRICE });
    // Pending money grants nothing under the default policy: the membership is not activated.
    expect((await db().select().from(memberships).where(eq(memberships.id, membership.id)))[0].status).toBe("pending");
    // While the debit is in flight a second charge is refused.
    expect(await charge(inv.id, 2)).toMatchObject({ charged: false });
    expect(api.calls.filter((c) => c.path === "/v1/payment_intents")).toHaveLength(1);
    await sendStripe(paymentIntentEvent("payment_intent.succeeded", ev));
    // A late duplicate of the processing event cannot regress it.
    await sendStripe(paymentIntentEvent("payment_intent.processing", ev));
    expect((await invRow(inv.id)).status).toBe("paid");
    money = await db().transaction((tx) => invoiceMoney(tx, inv.id));
    expect(money).toMatchObject({ pendingMinor: 0, settledMinor: PRICE, balanceMinor: 0 });
    expect((await db().select().from(memberships).where(eq(memberships.id, membership.id)))[0].status).toBe("active");
  });

  it("pending then failed for insufficient funds: nothing is paid, one retry is scheduled after the configured wait, a second failure stops", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "us_bank_account");
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    await charge(inv.id);
    const [a] = await attemptsOf(inv.id);
    const ev = { pi: a.providerRef!, attemptId: a.id, invoiceId: inv.id, amount: PRICE, methodType: "us_bank_account" as const };
    await sendStripe(paymentIntentEvent("payment_intent.processing", ev));
    const failed = paymentIntentEvent("payment_intent.payment_failed", { ...ev, code: "insufficient_funds", message: "The account has insufficient funds." });
    await Promise.all([sendStripe(failed), sendStripe(failed)]);
    expect((await attemptsOf(inv.id))[0]).toMatchObject({ status: "failed", failureCode: "insufficient_funds" });
    expect((await invRow(inv.id)).status).toBe("open");
    expect(await db().transaction((tx) => invoiceMoney(tx, inv.id))).toMatchObject({ pendingMinor: 0, settledMinor: 0, balanceMinor: PRICE });
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, inv.id));
    expect(txns.map((t) => t.status)).toEqual(["failed"]);
    const retry = await jobFor(inv.id, 2);
    expect(retry).toBeTruthy();
    const waitDays = (retry.runAt.getTime() - Date.now()) / 86_400_000;
    expect(waitDays).toBeGreaterThan(DEFAULT_AUTOPAY_SETTINGS.achRetryWaitDays - 1.5);
    expect(waitDays).toBeLessThan(DEFAULT_AUTOPAY_SETTINGS.achRetryWaitDays + 1);
    expect(await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-fail:${a.id}`))).toHaveLength(1);
    const notices = await db().transaction((tx) => failedAutopayNotices(tx, ctx.orgId, [ctx.payers.chris_parker]));
    expect(notices.find((n) => n.invoiceId === inv.id)!.text).toMatch(/insufficient funds.*try once more/);
    // The retry runs and fails the same way: no third attempt is queued.
    expect((await charge(inv.id, 2)).charged).toBe(true);
    const [, b] = await attemptsOf(inv.id);
    expect(api.calls.filter((c) => c.path === "/v1/payment_intents").map((c) => c.idempotencyKey)).toEqual([`autopay:${inv.id}:1`, `autopay:${inv.id}:2`]);
    await sendStripe(paymentIntentEvent("payment_intent.payment_failed", { ...ev, pi: b.providerRef! + "_2", attemptId: b.id, code: "insufficient_funds" }));
    expect(await jobFor(inv.id, 3)).toBeUndefined();
    const [t2] = await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-fail:${b.id}`));
    expect(t2.priority).toBe("high");
    expect(t2.title).toMatch(/failed again/);
  });

  it("account closed or authorization revoked: the saved method is marked failed, there is no retry, and the family is asked for a new one", async () => {
    for (const code of ["account_closed", "debit_not_authorized"]) {
      const { inv, method } = await autopayBill("ava", "chris_parker", "us_bank_account");
      vi.stubGlobal("fetch", stripeMethodsApi().fn);
      await charge(inv.id);
      const [a] = await attemptsOf(inv.id);
      const ev = { pi: a.providerRef!, attemptId: a.id, invoiceId: inv.id, amount: PRICE, methodType: "us_bank_account" as const };
      await sendStripe(paymentIntentEvent("payment_intent.processing", ev));
      await sendStripe(paymentIntentEvent("payment_intent.payment_failed", { ...ev, code }));
      expect((await db().select().from(paymentMethods).where(eq(paymentMethods.id, method.id)))[0]).toMatchObject({ status: "failed", failureCode: code, isDefault: false });
      expect(await jobFor(inv.id, 2)).toBeUndefined();
      const [t] = await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-fail:${a.id}`));
      expect(t.title).toMatch(/can no longer be debited/);
      const notices = await db().transaction((tx) => failedAutopayNotices(tx, ctx.orgId, [ctx.payers.chris_parker]));
      expect(notices.find((n) => n.invoiceId === inv.id)!.text).toMatch(/needs to be replaced/);
      // With the method dead, a manual retry request finds no method.
      expect(await charge(inv.id, 2)).toMatchObject({ charged: false, reason: "no_method" });
    }
  });

  it("a late return after the bill was paid reopens it through the dispute machinery and creates a staff follow-up", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "us_bank_account");
    vi.stubGlobal("fetch", stripeMethodsApi().fn);
    await charge(inv.id);
    const [a] = await attemptsOf(inv.id);
    const ev = { pi: a.providerRef!, attemptId: a.id, invoiceId: inv.id, amount: PRICE, methodType: "us_bank_account" as const };
    await sendStripe(paymentIntentEvent("payment_intent.processing", ev));
    await sendStripe(paymentIntentEvent("payment_intent.succeeded", ev));
    expect((await invRow(inv.id)).status).toBe("paid");
    const ret = achDisputeCreated({ pi: a.providerRef!, amount: PRICE, disputeId: `dp_test_${a.id.slice(0, 8)}`, reason: "insufficient_funds" });
    await Promise.all([sendStripe(ret), sendStripe(ret)]);
    const after = await invRow(inv.id);
    expect(after.status).toBe("open");
    expect(after.paidAt).toBeNull();
    expect(await db().transaction((tx) => invoiceMoney(tx, inv.id))).toMatchObject({ settledMinor: 0, bankReturnedMinor: PRICE, balanceMinor: PRICE });
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, inv.id));
    expect(txns.map((t) => `${t.kind}:${t.amountMinor}`).sort()).toEqual([`charge:${PRICE}`, `dispute:${-PRICE}`]);
    expect(await db().select().from(disputes).where(eq(disputes.providerDisputeId, `dp_test_${a.id.slice(0, 8)}`))).toHaveLength(1);
    expect(await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:ach-return:dp_test_${a.id.slice(0, 8)}`))).toHaveLength(1);
    // Not retried automatically.
    expect(await jobFor(inv.id, 2)).toBeUndefined();
  });

  it("classifies bank failures", () => {
    expect(classifyAchFailure("insufficient_funds").action).toBe("retry_once");
    for (const c of ["account_closed", "no_account", "debit_not_authorized", "revocation_of_authorization", "bank_account_restricted"]) expect(classifyAchFailure(c).action).toBe("method_failed");
    expect(classifyAchFailure("something_new").action).toBe("staff_review");
    expect(classifyAchFailure(null).action).toBe("staff_review");
  });
});

describe("charge now / retry now", () => {
  const view = async (u: string, invoiceId: string) => db().transaction(async (tx) => chargeNowView(tx, await who(u), invoiceId));
  const nowAudits = (invoiceId: string) => db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "billing.autopay.charge_now"), eq(auditEvents.entityId, invoiceId)));
  const posts = (api: ReturnType<typeof stripeMethodsApi>) => api.calls.filter((c) => c.path === "/v1/payment_intents" && c.method === "POST");

  it("staff charge an unpaid autopay bill once: same key as the scheduled attempt, double clicks and the later job are no-ops, audited", async () => {
    const { inv, method } = await autopayBill("ava", "chris_parker", "card");
    const erin = await who("erin");
    const v = (await view("erin", inv.id))!;
    expect(v).toMatchObject({ label: "Charge now", attemptNumber: 1, balanceMinor: PRICE, configured: true, blocked: null, lastFailure: null });
    expect(v.methodLabel).toContain(method.last4!);
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    const results = await Promise.allSettled([1, 2, 3].map(() => chargeInvoiceNow(db(), erin, { invoiceId: inv.id, attemptNumber: v.attemptNumber })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason.message)).toMatch(/Nothing more was charged/);
    expect(posts(api)).toHaveLength(1);
    expect(posts(api)[0].idempotencyKey).toBe(`autopay:${inv.id}:1`);
    const atts = await attemptsOf(inv.id);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({ origin: "autopay", status: "created", idempotencyKey: `autopay:${inv.id}:1` });
    // Stripe's synchronous answer never marks the bill paid.
    expect((await invRow(inv.id)).status).toBe("open");
    // The scheduled job for the same attempt arrives later: nothing more happens.
    expect((await charge(inv.id, 1)).charged).toBe(false);
    expect(posts(api)).toHaveLength(1);
    // While that charge is in flight the page says so instead of offering another.
    expect((await view("erin", inv.id))!.blocked).toMatch(/in flight/);
    const audits = await nowAudits(inv.id);
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actorUserId === erin.userId && a.actorRole === "operations")).toBe(true);
    expect(audits.filter((a) => /sent to Stripe/.test(a.summary ?? ""))).toHaveLength(1);
    // The webhook settles it; after that there is nothing to charge and no action is offered.
    await sendStripe(paymentIntentEvent("payment_intent.succeeded", { pi: atts[0].providerRef!, attemptId: atts[0].id, invoiceId: inv.id, amount: PRICE, methodType: "card" }));
    expect((await invRow(inv.id)).status).toBe("paid");
    expect(await view("erin", inv.id)).toBeNull();
    await expect(chargeInvoiceNow(db(), erin, { invoiceId: inv.id, attemptNumber: 2 })).rejects.toThrow(/no longer open/);
    expect(posts(api)).toHaveLength(1);
  });

  it("retry now after a decline is the next numbered attempt; the scheduled retry and a stale page then do nothing", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "card");
    const rod = await who("rod");
    const api = stripeMethodsApi({ charge: (p) => ({ status: 200, body: { id: `pi_test_${p.get("metadata[attempt_id]")!.slice(0, 8)}`, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds." } } }) });
    vi.stubGlobal("fetch", api.fn);
    await charge(inv.id, 1); // the scheduled attempt, declined; a retry is queued as attempt 2
    expect(await jobFor(inv.id, 2)).toBeDefined();
    const v = (await view("rod", inv.id))!;
    expect(v).toMatchObject({ label: "Retry now", attemptNumber: 2, blocked: null });
    expect(v.lastFailure!.message).toMatch(/Insufficient funds/);
    const r = await chargeInvoiceNow(db(), rod, { invoiceId: inv.id, attemptNumber: 2 });
    expect(r.status).toBe("declined");
    expect(r.message).toMatch(/Nothing was collected/);
    expect(posts(api).map((c) => c.idempotencyKey)).toEqual([`autopay:${inv.id}:1`, `autopay:${inv.id}:2`]);
    // The retry that was already scheduled as attempt 2 is now stale.
    expect(await charge(inv.id, 2)).toMatchObject({ charged: false, reason: "stale" });
    // A page opened before the retry still carries attempt 2: refused, nothing sent.
    await expect(chargeInvoiceNow(db(), rod, { invoiceId: inv.id, attemptNumber: 2 })).rejects.toThrow(/already charged or retried/);
    expect(posts(api)).toHaveLength(2);
    expect((await attemptsOf(inv.id)).map((a) => a.status)).toEqual(["failed", "failed"]);
    await expect(chargeInvoiceNow(db(), rod, { invoiceId: inv.id, attemptNumber: 0 })).rejects.toThrow(/Reload/);
  });

  it("only billing staff and the paying family may ask; another organization cannot", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "card");
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    for (const u of ["marcus", "tess", "alex", "jordan", "casey", "dana", "maya", "kiosk"]) {
      expect(`${u}:${(await view(u, inv.id)) === null}`).toBe(`${u}:true`);
      await expect(chargeInvoiceNow(db(), await who(u), { invoiceId: inv.id, attemptNumber: 1 })).rejects.toMatchObject({ name: "AuthzError" });
    }
    const other = await seedOrg(T, { modules: [] });
    await expect(chargeInvoiceNow(db(), await viewerFor(other, "rod"), { invoiceId: inv.id, attemptNumber: 1 })).rejects.toMatchObject({ name: "AuthzError" });
    expect(posts(api)).toHaveLength(0);
    expect(await attemptsOf(inv.id)).toHaveLength(0);
    for (const u of ["rod", "erin", "chris"]) expect((await view(u, inv.id))?.label).toBe("Charge now");
    // The family's own request goes through the same path.
    expect((await chargeInvoiceNow(db(), await who("chris"), { invoiceId: inv.id, attemptNumber: 1 })).status).toBe("submitted");
    expect(posts(api)).toHaveLength(1);
  });

  it("without Stripe keys it says so, sends nothing, writes no attempt, and the request is still audited", async () => {
    const { inv } = await autopayBill("ava", "chris_parker", "card");
    delete process.env.STRIPE_SECRET_KEY;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const v = (await view("erin", inv.id))!;
    expect(v.configured).toBe(false);
    expect(v.missingEnv).toContain("STRIPE_SECRET_KEY");
    await expect(chargeInvoiceNow(db(), await who("erin"), { invoiceId: inv.id, attemptNumber: 1 })).rejects.toThrow(/Stripe is not connected, so nothing was charged/);
    expect(f).not.toHaveBeenCalled();
    expect(await attemptsOf(inv.id)).toHaveLength(0);
    expect((await invRow(inv.id)).status).toBe("open");
    expect((await nowAudits(inv.id)).map((a) => a.summary)).toEqual([expect.stringMatching(/refused, Stripe is not connected/)]);
  });

  it("autopay switched on for a membership that already has an unpaid bill: the bill is listed for a decision, never charged silently", async () => {
    const rod = await who("rod");
    const start = addDaysYmd(T, (dayOffset += 3));
    await db().update(paymentMethods).set({ status: "removed", isDefault: false }).where(eq(paymentMethods.payerAccountId, ctx.payers.chris_parker));
    await db().update(memberships).set({ status: "cancelled", autopay: false }).where(and(eq(memberships.athleteId, ctx.athletes.ava), eq(memberships.orgId, ctx.orgId)));
    await activeMethod(ctx.payers.chris_parker, { type: "card" });
    const { membership } = await db().transaction((tx) => createMembership(tx, rod, { athleteId: ctx.athletes.ava, payerAccountId: ctx.payers.chris_parker, productVersionId: versionId, startDate: start, billingAnchorDay: Number(start.slice(8, 10)), today: T }));
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, start)); // billed with autopay OFF
    const [inv] = await db().select().from(invoices).where(eq(invoices.membershipId, membership.id));
    const list = (u: string) => db().transaction(async (tx) => unpaidAutopayBills(tx, await who(u), membership.id));
    expect(await list("rod")).toEqual([]); // autopay off: nothing to offer
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    await db().transaction((tx) => setMembershipAutopay(tx, rod, { membershipId: membership.id, autopay: true }));
    // Turning it on charged nothing and queued nothing.
    expect(posts(api)).toHaveLength(0);
    expect(await jobFor(inv.id, 1)).toBeUndefined();
    expect(await attemptsOf(inv.id)).toHaveLength(0);
    const offered = await list("rod");
    expect(offered).toMatchObject([{ invoiceId: inv.id, number: inv.number, balanceMinor: PRICE, label: "Charge now", attemptNumber: 1, blocked: null }]);
    expect(await list("chris")).toHaveLength(1);
    expect(await list("jordan")).toEqual([]);
    await chargeInvoiceNow(db(), rod, { invoiceId: inv.id, attemptNumber: offered[0].attemptNumber });
    expect(posts(api).map((c) => c.idempotencyKey)).toEqual([`autopay:${inv.id}:1`]);
  });
});

describe("card declines", () => {
  it("a card that needs updating is not retried; a retryable decline follows the configured schedule and then stops", async () => {
    expect(classifyDecline("expired_card").category).toBe("card_needs_update");
    expect(classifyDecline("insufficient_funds").category).toBe("retryable");
    // 1) Synchronous decline: expired card.
    let bill = await autopayBill("ava", "chris_parker", "card");
    let api = stripeMethodsApi({ charge: () => ({ status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "expired_card", message: "Your card has expired.", payment_intent: { id: "pi_test_expired" } } } }) });
    vi.stubGlobal("fetch", api.fn);
    expect(await charge(bill.inv.id)).toMatchObject({ charged: true, status: "declined" });
    let [a] = await attemptsOf(bill.inv.id);
    expect(a).toMatchObject({ status: "failed", failureCode: "expired_card", providerRef: "pi_test_expired" });
    expect(await jobFor(bill.inv.id, 2)).toBeUndefined();
    expect((await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-fail:${a.id}`)))[0].title).toMatch(/Card needs updating/);
    // Stripe's webhook for the same failure arrives afterwards: handled once, no second task or retry.
    await sendStripe(paymentIntentEvent("payment_intent.payment_failed", { pi: "pi_test_expired", attemptId: a.id, invoiceId: bill.inv.id, amount: PRICE, methodType: "card", code: "card_declined", declineCode: "expired_card" }));
    expect(await jobFor(bill.inv.id, 2)).toBeUndefined();
    expect((await db().transaction((tx) => failedAutopayNotices(tx, ctx.orgId, [ctx.payers.chris_parker]))).find((n) => n.invoiceId === bill.inv.id)!.text).toMatch(/needs to be updated/);

    // 2) Retryable (insufficient funds) reported by webhook: retries on the schedule [3, 7], then stops.
    bill = await autopayBill("ava", "chris_parker", "card");
    api = stripeMethodsApi({ charge: (p) => ({ status: 200, body: { id: `pi_test_${p.get("metadata[attempt_id]")!.slice(0, 8)}`, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds." } } }) });
    vi.stubGlobal("fetch", api.fn);
    const expectWait = async (n: number, days: number) => {
      const j = await jobFor(bill.inv.id, n);
      const d = (j.runAt.getTime() - Date.now()) / 86_400_000;
      expect(d).toBeGreaterThan(days - 1.5);
      expect(d).toBeLessThan(days + 1);
    };
    await charge(bill.inv.id, 1);
    await expectWait(2, 3);
    await charge(bill.inv.id, 2);
    await expectWait(3, 7);
    await charge(bill.inv.id, 3);
    expect(await jobFor(bill.inv.id, 4)).toBeUndefined();
    const atts = await attemptsOf(bill.inv.id);
    expect(atts.map((x) => x.status)).toEqual(["failed", "failed", "failed"]);
    [a] = atts.slice(-1);
    expect((await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:autopay-fail:${a.id}`)))[0].title).toMatch(/retries used up/);
    expect((await invRow(bill.inv.id)).status).toBe("open");
    expect(await tasksLike("%No message%")).toHaveLength(0); // titles never claim a send
  });
});

describe("bank pay discount and fee settings", () => {
  it("is off by default, applies a named discount only to bank-paid monthly bills when enabled, and never surcharges cards", async () => {
    expect(DEFAULT_AUTOPAY_SETTINGS.bankPayDiscount.enabled).toBe(false);
    expect(bankPayDiscountMinor(DEFAULT_AUTOPAY_SETTINGS, PRICE)).toBe(0);
    let bill = await autopayBill("ava", "chris_parker", "us_bank_account");
    expect(bill.inv).toMatchObject({ totalMinor: PRICE, discountMinor: 0 });

    await expect(db().transaction(async (tx) => saveAutopaySettings(tx, await who("erin"), { ...DEFAULT_AUTOPAY_SETTINGS, bankPayDiscount: { enabled: true, kind: "fixed", value: 500 } }))).rejects.toMatchObject({ name: "AuthzError" });
    await db().transaction(async (tx) => saveAutopaySettings(tx, await who("rod"), { ...DEFAULT_AUTOPAY_SETTINGS, bankPayDiscount: { enabled: true, kind: "fixed", value: 500 } }));
    bill = await autopayBill("ava", "chris_parker", "us_bank_account");
    expect(bill.inv).toMatchObject({ subtotalMinor: PRICE, discountMinor: 500, totalMinor: PRICE - 500 });
    expect(bill.inv.memo).toMatch(/Bank pay discount: \$5\.00/);
    // Autopay charges the discounted balance.
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    await charge(bill.inv.id);
    expect(api.calls.find((c) => c.path === "/v1/payment_intents")!.params.get("amount")).toBe(String(PRICE - 500));
    // Card autopay: full price, no surcharge.
    bill = await autopayBill("ava", "chris_parker", "card");
    expect(bill.inv).toMatchObject({ discountMinor: 0, totalMinor: PRICE });

    await db().transaction(async (tx) => saveAutopaySettings(tx, await who("rod"), { ...DEFAULT_AUTOPAY_SETTINGS, bankPayDiscount: { enabled: true, kind: "percent", value: 2 } }));
    bill = await autopayBill("ava", "chris_parker", "us_bank_account");
    expect(bill.inv.discountMinor).toBe(400);
    await db().transaction(async (tx) => saveAutopaySettings(tx, await who("rod"), { ...DEFAULT_AUTOPAY_SETTINGS }));
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(autopaySettingsOf(org.settings).unconfirmed).toEqual([]);
  });

  it("fee estimates come only from owner-entered settings", () => {
    expect(DEFAULT_AUTOPAY_SETTINGS.feeEstimates).toEqual({ card: null, us_bank_account: null });
    expect(estimateFeeMinor(null, 20000)).toBeNull();
    expect(estimateFeeMinor({ percentBps: 100, fixedMinor: 10, capMinor: null }, 20000)).toBe(210);
    expect(estimateFeeMinor({ percentBps: 100, fixedMinor: 0, capMinor: 150 }, 20000)).toBe(150);
    const s = autopaySettingsOf({ autopay: { feeEstimates: { card: { percentBps: 250, fixedMinor: 25 } }, cardRetryDays: [2, "x", 9] } });
    expect(s.feeEstimates.card).toEqual({ percentBps: 250, fixedMinor: 25, capMinor: null });
    expect(s.cardRetryDays).toEqual([2, 9]);
  });
});
