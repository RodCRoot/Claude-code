/**
 * Provider subscriptions (Stripe Billing, PayPal Subscriptions) and the Venmo SDK checkout.
 * Contract tests only: every provider HTTP call goes to a mocked fetch, every webhook is a locally signed
 * (Stripe) or mock-verified (PayPal) fixture. Nothing here proves the real providers accept these requests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { invoices, membershipEvents, memberships, paymentAttempts, providerPlans, tasks, transactions, webhookEvents } from "@/db/schema";
import { createProduct } from "@/lib/billing/catalog";
import { createInvoiceRecord, createManualInvoice, recordManualPayment } from "@/lib/billing/invoices";
import { addHold, cancelMembership, changePlan, createMembership } from "@/lib/billing/memberships";
import { generateRenewals } from "@/lib/billing/renewals";
import { cancelProviderSubscription, EV, startProviderSubscription, switchToTeamworkBilling, type RequestDetails } from "@/lib/billing/subscriptions";
import { addMonthsYmd } from "@/lib/billing/util";
import { captureVenmoOrder, createVenmoOrder, venmoButtonConfig } from "@/lib/billing/venmo";
import { ingestWebhook } from "@/lib/billing/webhooks";
import { unixAtLocalMidnight } from "@/lib/payments/stripe";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { TEST_WHSEC, signedHeaders } from "./fixtures/payments/stripe";
import {
  mockFetch,
  paypalCaptureCompletedEvent,
  paypalHeaders,
  paypalOAuth,
  paypalPaymentFailedEvent,
  paypalSaleCompletedEvent,
  paypalSubscriptionEvent,
  paypalVerify,
  stripeCheckoutSubscriptionCompleted,
  stripeInvoiceEvent,
  stripeSubscriptionEvent,
  type Route,
} from "./fixtures/payments/subscriptions";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let versionId: string;
const T = todayLocal();
const APP = "http://localhost:3102";

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_ENV"];
const stripeOn = () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_real";
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
};
const paypalOn = () => {
  process.env.PAYPAL_CLIENT_ID = "fixture-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "fixture-secret";
  process.env.PAYPAL_WEBHOOK_ID = "WH-FIXTURE";
  process.env.PAYPAL_ENV = "sandbox";
};

beforeAll(async () => {
  ctx = await seedOrg();
  const rod = await viewerFor(ctx, "rod");
  const p = await testDb().transaction((tx) =>
    createProduct(tx, rod, {
      name: "Test — Monthly Plan",
      kind: "recurring_membership",
      version: { priceMinor: 10000, interval: "month", creditsPerPeriod: 6, effectiveFrom: "2020-01-01" },
    }),
  );
  versionId = p.version.id;
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await closeTestDb();
});

const db = () => testDb();

async function newMembership(athlete = "dana", payer = "dana") {
  const rod = await viewerFor(ctx, "rod");
  const r = await db().transaction((tx) => createMembership(tx, rod, { athleteId: ctx.athletes[athlete], payerAccountId: ctx.payers[payer], productVersionId: versionId, startDate: T, today: T }));
  // Re-read: the first period was billed, which advanced next_bill_date.
  return membership(r.membership.id);
}

const stripeRoutes = (o: { priceExists?: boolean; sessionId?: string } = {}): Route[] => [
  (c) => (c.method === "GET" && c.url.startsWith("https://api.stripe.com/v1/prices") ? { json: { object: "list", data: o.priceExists ? [{ id: "price_fixture", product: "prod_fixture", unit_amount: 10000, currency: "usd" }] : [] } } : undefined),
  (c) => (c.method === "POST" && c.url === "https://api.stripe.com/v1/prices" ? { json: { id: "price_fixture", object: "price", product: "prod_fixture", unit_amount: 10000, currency: "usd" } } : undefined),
  (c) =>
    c.method === "POST" && c.url === "https://api.stripe.com/v1/checkout/sessions"
      ? { json: { id: o.sessionId ?? `cs_test_sub_${Math.random().toString(36).slice(2, 10)}`, object: "checkout.session", mode: "subscription", url: "https://checkout.stripe.com/c/pay/cs_test_fixture", subscription: null } }
      : undefined,
];

async function requestOf(membershipId: string) {
  const [e] = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, membershipId), eq(membershipEvents.type, EV.requested))).orderBy(sql`${membershipEvents.createdAt} desc`).limit(1);
  return e.details as RequestDetails;
}

async function startStripe(membershipId: string) {
  stripeOn();
  const f = mockFetch(stripeRoutes());
  vi.stubGlobal("fetch", f.fn);
  const rod = await viewerFor(ctx, "rod");
  const r = await startProviderSubscription(db(), rod, { membershipId, provider: "stripe", appUrl: APP, today: T });
  expect(r.ok).toBe(true);
  vi.unstubAllGlobals();
  return { calls: f.calls, req: await requestOf(membershipId) };
}

const sendStripe = (event: object) => {
  const body = JSON.stringify(event);
  return ingestWebhook(db(), "stripe", body, signedHeaders(body));
};

async function membership(id: string) {
  const [m] = await db().select().from(memberships).where(eq(memberships.id, id));
  return m;
}

async function providerInvoices(membershipId: string) {
  return db().select().from(invoices).where(and(eq(invoices.membershipId, membershipId), like(invoices.idempotencyKey, "%-invoice:%")));
}

async function bucketsFor(invoiceId: string) {
  const r = await db().execute(sql`select b.granted from credit_buckets b join invoice_lines l on l.id = b.source_invoice_line_id where l.invoice_id = ${invoiceId}`);
  return r.rows as { granted: number }[];
}

async function taskTitles() {
  return (await db().select({ title: tasks.title }).from(tasks).where(eq(tasks.orgId, ctx.orgId))).map((t) => t.title);
}

const period = (startYmd: string) => ({ periodStart: unixAtLocalMidnight(startYmd), periodEnd: unixAtLocalMidnight(addMonthsYmd(startYmd, 1)) });

describe("Stripe subscription creation (mocked API)", () => {
  it("without credentials: no provider call, no request recorded, honest not-configured result", async () => {
    const m = await newMembership();
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f.fn);
    const rod = await viewerFor(ctx, "rod");
    const r = await startProviderSubscription(db(), rod, { membershipId: m.id, provider: "stripe", appUrl: APP, today: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.notConfigured?.envVars).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    expect(f.calls).toHaveLength(0);
    const evs = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, EV.requested)));
    expect(evs).toHaveLength(0);
    expect((await membership(m.id)).billingProvider).toBe("manual");
  });

  it("refuses live keys outside production without calling Stripe", async () => {
    const m = await newMembership();
    process.env.STRIPE_SECRET_KEY = "sk_live_fixture";
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
    const f = mockFetch(stripeRoutes());
    vi.stubGlobal("fetch", f.fn);
    const r = await startProviderSubscription(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, provider: "stripe", appUrl: APP, today: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/live credentials are refused/);
    expect(f.calls).toHaveLength(0);
  });

  it("creates the recurring price once (lookup_key + idempotency key) and a subscription-mode Checkout Session anchored at the next Teamwork bill date", async () => {
    const m = await newMembership();
    expect(m.nextBillDate).toBe(addMonthsYmd(T, 1, Number(T.slice(8, 10))));
    const { calls, req } = await startStripe(m.id);
    const [lookup, price, session] = calls;
    expect(lookup.method).toBe("GET");
    expect(decodeURIComponent(lookup.url)).toContain(`lookup_keys[0]=twhub:${ctx.orgId}:${versionId}:10000:usd`);
    expect(price.url).toBe("https://api.stripe.com/v1/prices");
    const pb = new URLSearchParams(price.body);
    expect(pb.get("unit_amount")).toBe("10000");
    expect(pb.get("recurring[interval]")).toBe("month");
    expect(pb.get("lookup_key")).toBe(`twhub:${ctx.orgId}:${versionId}:10000:usd`);
    expect(price.headers["idempotency-key"]).toBe(`plan:${ctx.orgId}:${versionId}:10000:USD`);
    const sb = new URLSearchParams(session.body);
    expect(sb.get("mode")).toBe("subscription");
    expect(sb.get("line_items[0][price]")).toBe("price_fixture");
    expect(sb.get("subscription_data[metadata][membership_id]")).toBe(m.id);
    expect(sb.get("subscription_data[metadata][request_id]")).toBe(req.requestId);
    expect(sb.get("subscription_data[billing_cycle_anchor]")).toBe(String(unixAtLocalMidnight(m.nextBillDate!)));
    expect(sb.get("subscription_data[proration_behavior]")).toBe("none");
    expect(session.headers["idempotency-key"]).toBe(`subscription:${req.requestId}`);
    expect(req).toMatchObject({ provider: "stripe", state: "pending", amountMinor: 10000, firstChargeDate: m.nextBillDate, approvalUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture" });
    // Nothing changes locally until a verified webhook links the subscription.
    const after = await membership(m.id);
    expect(after).toMatchObject({ billingProvider: "manual", providerSubscriptionId: null, nextBillDate: m.nextBillDate });
    expect(await db().select().from(providerPlans).where(eq(providerPlans.productVersionId, versionId))).toHaveLength(1);

    // A second membership on the same version + amount reuses the cached price: no price calls.
    const m2 = await newMembership();
    const second = await startStripe(m2.id);
    expect(second.calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/checkout/sessions"]);
    // Starting again while a request is open reuses its approval link without calling Stripe.
    stripeOn();
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f.fn);
    const again = await startProviderSubscription(db(), await viewerFor(ctx, "rod"), { membershipId: m2.id, provider: "stripe", appUrl: APP, today: T });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(f.calls).toHaveLength(0);
  });
});

describe("Stripe subscription webhooks", () => {
  beforeEach(stripeOn);

  it("out-of-order + duplicate deliveries link once, record one invoice + one verified transaction, and grant credits once", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_${req.requestId.slice(0, 8)}`;
    const p = period(m.nextBillDate!);
    // invoice.paid arrives before customer.subscription.created / checkout.session.completed.
    const paid = stripeInvoiceEvent("invoice.paid", { invoiceId: `in_${req.requestId.slice(0, 8)}`, subId, hint, amount: 10000, ...p });
    const results = await Promise.all([sendStripe(paid), sendStripe(paid), sendStripe(paid)]);
    expect(results.map((r) => r.httpStatus)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.body.outcome === "processed")).toHaveLength(1);
    // Same provider invoice under a different event id (e.g. a resend) is also a no-op.
    const resend = stripeInvoiceEvent("invoice.paid", { invoiceId: `in_${req.requestId.slice(0, 8)}`, subId, hint, amount: 10000, ...p });
    expect((await sendStripe(resend)).body.detail).toBe("subscription invoice already recorded");
    await sendStripe(stripeCheckoutSubscriptionCompleted({ sessionId: "cs_x", subId, hint }));
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint, status: "active", ...p }));

    const after = await membership(m.id);
    // Verified provider payment activates the membership (first Teamwork invoice is not yet overdue).
    expect(after).toMatchObject({ billingProvider: "stripe", providerSubscriptionId: subId, nextBillDate: null, status: "active" });
    const inv = await providerInvoices(m.id);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: "paid", periodStart: m.nextBillDate, periodEnd: addDaysYmd(addMonthsYmd(m.nextBillDate!, 1), -1), totalMinor: 10000, idempotencyKey: `stripe-invoice:in_${req.requestId.slice(0, 8)}` });
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, inv[0].id));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ provider: "stripe", kind: "charge", status: "settled", verification: "provider_verified", amountMinor: 10000 });
    expect(await bucketsFor(inv[0].id)).toEqual([{ granted: 6 }]);
    const linked = await db().select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, EV.linked)));
    expect(linked).toHaveLength(1);
    expect((await requestOf(m.id)).state).toBe("linked");
  });

  it("the renewal job never bills a provider-billed membership, even long after its period", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const subId = `sub_r_${req.requestId.slice(0, 6)}`;
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint: { membershipId: m.id, requestId: req.requestId }, status: "active", ...period(m.nextBillDate!) }));
    const before = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
    const far = addMonthsYmd(T, 6);
    const s = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, far));
    expect(s.skippedProviderBilled).toBeGreaterThanOrEqual(1);
    const afterInv = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
    expect(afterInv.length).toBe(before.length);
    // DB-level guard: a provider-billed membership cannot get a Teamwork renewal date.
    await expect(db().update(memberships).set({ nextBillDate: far }).where(eq(memberships.id, m.id))).rejects.toThrow();
    // Domain guards: no Teamwork invoice, hold, plan change or plain cancellation.
    const rod = await viewerFor(ctx, "rod");
    await expect(db().transaction((tx) => createInvoiceRecord(tx, { orgId: ctx.orgId, actorUserId: rod.userId, actorRole: "owner" }, { orgId: ctx.orgId, payerAccountId: ctx.payers.dana, membershipId: m.id, lines: [{ description: "x", unitAmountMinor: 100 }] }))).rejects.toThrow(/Stripe subscription/);
    await expect(db().transaction((tx) => addHold(tx, rod, { membershipId: m.id, startDate: T, endDate: addDaysYmd(T, 7), reason: "x", today: T }))).rejects.toThrow(/Switch back to Teamwork/);
    await expect(db().transaction((tx) => changePlan(tx, rod, { membershipId: m.id, toVersionId: versionId, effectiveOn: T, today: T }))).rejects.toThrow();
    await expect(db().transaction((tx) => cancelMembership(tx, rod, { membershipId: m.id, requestedOn: T, reason: "x", today: T }))).rejects.toThrow(/Cancel subscription at period end/);
    await expect(
      db().transaction((tx) => createMembership(tx, rod, { athleteId: ctx.athletes.dana, payerAccountId: ctx.payers.dana, productVersionId: versionId, startDate: T, today: T, billingProvider: "stripe" as never })),
    ).rejects.toThrow(/switch it to a Stripe or PayPal subscription/);
  });

  it("payment failure → past_due (+task); an older failure delivered late never regresses a newer payment", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_f_${req.requestId.slice(0, 6)}`;
    const p = period(m.nextBillDate!);
    const t0 = Math.floor(Date.now() / 1000);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint, status: "active", ...p, created: t0 }));
    // pay the first Teamwork invoice so the membership is active
    const [first] = await db().select().from(invoices).where(and(eq(invoices.membershipId, m.id), eq(invoices.status, "open")));
    await db().transaction(async (tx) => recordManualPayment(tx, await viewerFor(ctx, "erin"), { invoiceId: first.id, amountMinor: first.totalMinor, method: "cash", reference: "R1" }));
    expect((await membership(m.id)).status).toBe("active");

    const failed = stripeInvoiceEvent("invoice.payment_failed", { invoiceId: "in_fail_1", subId, hint, amount: 10000, ...p, created: t0 + 10 });
    await sendStripe(failed);
    expect((await membership(m.id)).status).toBe("past_due");
    expect(await taskTitles()).toContain("Stripe subscription payment failed");
    await sendStripe(stripeInvoiceEvent("invoice.paid", { invoiceId: "in_fail_1", subId, hint, amount: 10000, ...p, created: t0 + 20 }));
    expect((await membership(m.id)).status).toBe("active");
    // An older failure (different invoice id, earlier timestamp) arriving late is ignored.
    const late = await sendStripe(stripeInvoiceEvent("invoice.payment_failed", { invoiceId: "in_fail_0", subId, hint, amount: 10000, ...p, created: t0 + 5 }));
    expect(late.body.detail).toMatch(/stale/);
    expect((await membership(m.id)).status).toBe("active");
    // The same invoice's failure re-delivered after it was paid is ignored too.
    const again = await sendStripe(stripeInvoiceEvent("invoice.payment_failed", { invoiceId: "in_fail_1", subId, hint, amount: 10000, ...p, created: t0 + 30 }));
    expect(again.body.detail).toMatch(/already paid/);
    expect((await membership(m.id)).status).toBe("active");
    // Action required: task only, no status change.
    await sendStripe(stripeInvoiceEvent("invoice.payment_action_required", { invoiceId: "in_sca_1", subId, hint, amount: 10000, ...p, created: t0 + 40 }));
    expect(await taskTitles()).toContain("Payer must confirm a Stripe subscription payment");
    expect((await membership(m.id)).status).toBe("active");
  });

  it("status events: a stale update never overrides a newer one; deleted is terminal", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_s_${req.requestId.slice(0, 6)}`;
    const p = period(m.nextBillDate!);
    const t0 = Math.floor(Date.now() / 1000);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "past_due", ...p, created: t0 + 100 }));
    expect((await membership(m.id)).status).toBe("past_due");
    const stale = await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "active", ...p, created: t0 + 50 }));
    expect(stale.body.detail).toMatch(/stale/);
    expect((await membership(m.id)).status).toBe("past_due");
    await sendStripe(stripeSubscriptionEvent("customer.subscription.deleted", { subId, hint, status: "canceled", ...p, created: t0 + 200 }));
    const ended = await membership(m.id);
    expect(ended.status).toBe("cancelled");
    expect(ended.endDate).toBe(T);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "active", ...p, created: t0 + 300 }));
    expect((await membership(m.id)).status).toBe("cancelled");
  });

  it("never links an unrequested, withdrawn or second subscription — flags it for cancellation instead", async () => {
    const m = await newMembership();
    // Unrequested: the membership exists but staff never started a switch.
    const r1 = await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId: "sub_rogue_1", hint: { membershipId: m.id, requestId: "00000000-0000-4000-8000-000000000000" }, status: "active", ...period(m.nextBillDate!) }));
    expect(r1.body.detail).toMatch(/not linked/);
    expect((await membership(m.id)).billingProvider).toBe("manual");

    // Withdrawn before the payer completed it.
    const { req } = await startStripe(m.id);
    const rod = await viewerFor(ctx, "rod");
    const w = await switchToTeamworkBilling(db(), rod, { membershipId: m.id, reason: "Family prefers invoices", today: T });
    expect(w.withdrawn).toBe(true);
    const r2 = await sendStripe(stripeCheckoutSubscriptionCompleted({ sessionId: "cs_late", subId: "sub_late_1", hint: { membershipId: m.id, requestId: req.requestId } }));
    expect(r2.body.detail).toMatch(/withdrawn/);
    expect((await membership(m.id))).toMatchObject({ billingProvider: "manual", providerSubscriptionId: null });

    // Second subscription for an already-linked membership.
    const m2 = await newMembership();
    const s2 = await startStripe(m2.id);
    const hint2 = { membershipId: m2.id, requestId: s2.req.requestId };
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId: "sub_first_2", hint: hint2, status: "active", ...period(m2.nextBillDate!) }));
    const dup = await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId: "sub_second_2", hint: hint2, status: "active", ...period(m2.nextBillDate!) }));
    expect(dup.body.detail).toMatch(/not linked/);
    expect((await membership(m2.id)).providerSubscriptionId).toBe("sub_first_2");
    // A charge on the rogue subscription is not recorded as membership revenue.
    const rogueCharge = await sendStripe(stripeInvoiceEvent("invoice.paid", { invoiceId: "in_rogue", subId: "sub_second_2", hint: hint2, amount: 10000, ...period(m2.nextBillDate!) }));
    expect(rogueCharge.body.detail).toMatch(/not linked/);
    expect(await db().select().from(invoices).where(eq(invoices.idempotencyKey, "stripe-invoice:in_rogue"))).toHaveLength(0);
    const titles = await taskTitles();
    expect(titles).toContain("Cancel unexpected Stripe subscription sub_rogue_1");
    expect(titles).toContain("Cancel unexpected Stripe subscription sub_late_1");
    expect(titles).toContain("Cancel unexpected Stripe subscription sub_second_2");
  });

  it("a provider charge for a period Teamwork already settled is applied to that invoice and flagged as double collection (no second grant)", async () => {
    const m = await newMembership();
    const [first] = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
    await db().transaction(async (tx) => recordManualPayment(tx, await viewerFor(ctx, "erin"), { invoiceId: first.id, amountMinor: first.totalMinor, method: "check", reference: "CHK-9" }));
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_d_${req.requestId.slice(0, 6)}`;
    await sendStripe(stripeInvoiceEvent("invoice.paid", { invoiceId: "in_dbl", subId, hint, amount: 10000, ...period(first.periodStart!) }));
    expect(await providerInvoices(m.id)).toHaveLength(0);
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, first.id));
    expect(txns.map((t) => t.provider).sort()).toEqual(["manual", "stripe"]);
    expect(await bucketsFor(first.id)).toEqual([{ granted: 6 }]);
    expect((await taskTitles()).some((t) => t.startsWith(`Period ${first.periodStart} was paid twice`))).toBe(true);
  });

  it("a subscription that never activates (incomplete_expired) hands billing back to Teamwork at the original date", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_x_${req.requestId.slice(0, 6)}`;
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint, status: "incomplete", ...period(m.nextBillDate!) }));
    expect((await membership(m.id)).billingProvider).toBe("stripe");
    await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "incomplete_expired", ...period(m.nextBillDate!) }));
    expect(await membership(m.id)).toMatchObject({ billingProvider: "manual", providerSubscriptionId: null, nextBillDate: m.nextBillDate });
    expect(await taskTitles()).toContain("Stripe subscription was never completed");
  });

  it("Teamwork cancel → Stripe cancel_at_period_end (idempotent) → membership ends after the paid period", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_c_${req.requestId.slice(0, 6)}`;
    const p = period(m.nextBillDate!);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint, status: "active", ...p }));
    await sendStripe(stripeInvoiceEvent("invoice.paid", { invoiceId: `in_c_${subId}`, subId, hint, amount: 10000, ...p }));
    const f = mockFetch([(c) => (c.url === `https://api.stripe.com/v1/subscriptions/${subId}` ? { json: { id: subId, cancel_at_period_end: true, items: { data: [{ current_period_end: p.periodEnd }] } } } : undefined)]);
    vi.stubGlobal("fetch", f.fn);
    const rod = await viewerFor(ctx, "rod");
    const r = await cancelProviderSubscription(db(), rod, { membershipId: m.id, reason: "Moving away", today: T });
    const nextStart = addMonthsYmd(m.nextBillDate!, 1);
    expect(r).toEqual({ cancelAt: nextStart, immediate: false });
    expect(f.calls).toHaveLength(1);
    expect(new URLSearchParams(f.calls[0].body).get("cancel_at_period_end")).toBe("true");
    expect(f.calls[0].headers["idempotency-key"]).toBe(`cancel:${m.id}:${subId}`);
    expect(await membership(m.id)).toMatchObject({ cancelAt: nextStart, status: "active", billingProvider: "stripe" });
    // Stripe echoes cancel_at_period_end on the subscription: no change.
    await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "active", ...p, cancelAtPeriodEnd: true }));
    expect((await membership(m.id)).cancelAt).toBe(nextStart);
    // If the provider reports the subscription ended early, the paid period still runs to cancel_at.
    const del = await sendStripe(stripeSubscriptionEvent("customer.subscription.deleted", { subId, hint, status: "canceled", ...p }));
    expect(del.body.detail).toBe(`provider billing stopped; membership ends ${nextStart}`);
    expect((await membership(m.id)).status).toBe("active");
    // The status sync ends it on cancel_at.
    const { syncMembershipStatuses } = await import("@/lib/billing/renewals");
    await db().transaction((tx) => syncMembershipStatuses(tx, ctx.orgId, nextStart));
    expect(await membership(m.id)).toMatchObject({ status: "cancelled", endDate: nextStart });
    // Not configured → honest refusal, nothing sent.
    delete process.env.STRIPE_SECRET_KEY;
    const m2 = await newMembership();
    const s2 = await startStripe(m2.id);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId: "sub_nc", hint: { membershipId: m2.id, requestId: s2.req.requestId }, status: "active", ...period(m2.nextBillDate!) }));
    delete process.env.STRIPE_SECRET_KEY;
    const g = mockFetch([]);
    vi.stubGlobal("fetch", g.fn);
    await expect(cancelProviderSubscription(db(), rod, { membershipId: m2.id, reason: "x", today: T })).rejects.toThrow(/not configured/);
    expect(g.calls).toHaveLength(0);
  });

  it("switch back to Teamwork invoices: Stripe stops at period end, then renewals resume the day after the paid period", async () => {
    const m = await newMembership();
    const { req } = await startStripe(m.id);
    const hint = { membershipId: m.id, requestId: req.requestId };
    const subId = `sub_b_${req.requestId.slice(0, 6)}`;
    const p = period(m.nextBillDate!);
    await sendStripe(stripeSubscriptionEvent("customer.subscription.created", { subId, hint, status: "active", ...p }));
    await sendStripe(stripeInvoiceEvent("invoice.paid", { invoiceId: `in_b_${subId}`, subId, hint, amount: 10000, ...p }));
    const f = mockFetch([(c) => (c.url === `https://api.stripe.com/v1/subscriptions/${subId}` ? { json: { id: subId, cancel_at_period_end: true, items: { data: [{ current_period_end: p.periodEnd }] } } } : undefined)]);
    vi.stubGlobal("fetch", f.fn);
    const r = await switchToTeamworkBilling(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, reason: "Back to invoices", today: T });
    const resume = addMonthsYmd(m.nextBillDate!, 1);
    expect(r).toEqual({ withdrawn: false, firstTeamworkBillDate: resume });
    // Still provider-billed (and not cancelled) until Stripe confirms.
    await sendStripe(stripeSubscriptionEvent("customer.subscription.updated", { subId, hint, status: "active", ...p, cancelAtPeriodEnd: true }));
    expect(await membership(m.id)).toMatchObject({ billingProvider: "stripe", cancelAt: null });
    await sendStripe(stripeSubscriptionEvent("customer.subscription.deleted", { subId, hint, status: "canceled", ...p }));
    const after = await membership(m.id);
    expect(after).toMatchObject({ billingProvider: "manual", providerSubscriptionId: null, nextBillDate: resume, cancelAt: null });
    expect(after.status).not.toBe("cancelled");
  });
});

describe("PayPal Subscriptions (mocked API + mocked verify-webhook-signature)", () => {
  beforeEach(paypalOn);

  const ppRoutes = (o: { subId: string }): Route[] => [
    paypalOAuth,
    paypalVerify("SUCCESS"),
    (c) => (c.url.endsWith("/v1/catalogs/products") ? { status: 201, json: { id: "PROD-FIXTURE0000000001", name: "x" } } : undefined),
    (c) => (c.url.endsWith("/v1/billing/plans") ? { status: 201, json: { id: "P-FIXTUREPLAN", status: "ACTIVE" } } : undefined),
    (c) =>
      c.url.endsWith("/v1/billing/subscriptions")
        ? { status: 201, json: { id: o.subId, status: "APPROVAL_PENDING", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${o.subId}`, method: "GET" }] } }
        : undefined,
    (c) => (c.url.includes("/v1/billing/subscriptions/") && c.url.endsWith("/cancel") ? { status: 204 } : undefined),
  ];
  const sendPaypal = (event: object) => ingestWebhook(db(), "paypal", JSON.stringify(event), paypalHeaders());

  it("creates product + plan + subscription with custom_id, PayPal-Request-Id, and returns the approve link", async () => {
    const m = await newMembership();
    const f = mockFetch(ppRoutes({ subId: "I-FIXTURE0001" }));
    vi.stubGlobal("fetch", f.fn);
    const r = await startProviderSubscription(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, provider: "paypal", appUrl: APP, today: T });
    expect(r).toMatchObject({ ok: true, approvalUrl: expect.stringContaining("I-FIXTURE0001") });
    const req = await requestOf(m.id);
    const plan = f.calls.find((c) => c.url.endsWith("/v1/billing/plans"))!;
    const pb = JSON.parse(plan.body);
    expect(pb.billing_cycles[0]).toMatchObject({ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "100.00", currency_code: "USD" } } });
    expect(plan.headers["paypal-request-id"]).toBe(`plan:${ctx.orgId}:${versionId}:10000:USD:plan`);
    const sub = f.calls.find((c) => c.url.endsWith("/v1/billing/subscriptions"))!;
    const sb = JSON.parse(sub.body);
    expect(sb).toMatchObject({ plan_id: "P-FIXTUREPLAN", custom_id: `${m.id}.${req.requestId}` });
    expect(sb.start_time).toBeDefined();
    expect(sub.headers["paypal-request-id"]).toBe(`subscription:${req.requestId}`);
    expect(req).toMatchObject({ state: "pending", providerSubscriptionId: "I-FIXTURE0001" });
    expect((await membership(m.id)).billingProvider).toBe("manual");
  });

  it("verifies every webhook via the API; a FAILURE verdict is rejected and changes nothing", async () => {
    const f = mockFetch([paypalOAuth, paypalVerify("FAILURE")]);
    vi.stubGlobal("fetch", f.fn);
    const r = await sendPaypal(paypalSubscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { subId: "I-FORGED", status: "ACTIVE" }));
    expect(r.httpStatus).toBe(400);
    const verify = f.calls.find((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    const vb = JSON.parse(verify.body);
    expect(vb).toMatchObject({ webhook_id: "WH-FIXTURE", auth_algo: "SHA256withRSA", transmission_sig: "fixture-signature" });
    expect(vb.webhook_event.event_type).toBe("BILLING.SUBSCRIPTION.ACTIVATED");
  });

  it("sale before activation links via the returned subscription id; duplicates bill once; failure → past_due; cancel → cancelled", async () => {
    const m = await newMembership();
    const subId = `I-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    vi.stubGlobal("fetch", mockFetch(ppRoutes({ subId })).fn);
    await startProviderSubscription(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, provider: "paypal", appUrl: APP, today: T });
    const sale = paypalSaleCompletedEvent({ saleId: `SALE-${subId}`, subId, total: "100.00" });
    const [a, b] = await Promise.all([sendPaypal(sale), sendPaypal(sale)]);
    expect([a.body.outcome, b.body.outcome].sort()).toEqual(["duplicate", "processed"]);
    let after = await membership(m.id);
    expect(after).toMatchObject({ billingProvider: "paypal", providerSubscriptionId: subId, nextBillDate: null });
    const inv = await providerInvoices(m.id);
    expect(inv).toHaveLength(1);
    // The sale carries no period: it starts where Teamwork billing stopped.
    expect(inv[0]).toMatchObject({ status: "paid", periodStart: m.nextBillDate, totalMinor: 10000 });
    expect(await bucketsFor(inv[0].id)).toEqual([{ granted: 6 }]);
    await sendPaypal(paypalSubscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { subId, customId: `${m.id}.${(await requestOf(m.id)).requestId}`, status: "ACTIVE" }));
    await sendPaypal(paypalPaymentFailedEvent({ subId, amount: "100.00", time: new Date(Date.now() + 60_000).toISOString() }));
    after = await membership(m.id);
    expect(after.status).toBe("past_due");
    await sendPaypal(paypalSubscriptionEvent("BILLING.SUBSCRIPTION.CANCELLED", { subId, status: "CANCELLED", createTime: new Date(Date.now() + 120_000).toISOString() }));
    expect((await membership(m.id)).status).toBe("cancelled");
    const rows = await db().select().from(webhookEvents).where(and(eq(webhookEvents.provider, "paypal"), eq(webhookEvents.status, "failed")));
    expect(rows).toHaveLength(0);
  });

  it("an unknown sale is deferred (retried), not dropped or guessed", async () => {
    vi.stubGlobal("fetch", mockFetch([paypalOAuth, paypalVerify("SUCCESS")]).fn);
    const r = await sendPaypal(paypalSaleCompletedEvent({ saleId: "SALE-UNKNOWN", subId: "I-UNKNOWN", total: "100.00" }));
    expect(r.body.outcome).toBe("deferred");
  });

  it("switch back: PayPal cancel (204) ends provider billing at once; Teamwork resumes after the paid period; the CANCELLED webhook is then a no-op", async () => {
    const m = await newMembership();
    const subId = `I-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const f = mockFetch(ppRoutes({ subId }));
    vi.stubGlobal("fetch", f.fn);
    await startProviderSubscription(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, provider: "paypal", appUrl: APP, today: T });
    await sendPaypal(paypalSubscriptionEvent("BILLING.SUBSCRIPTION.ACTIVATED", { subId, status: "ACTIVE" }));
    await sendPaypal(paypalSaleCompletedEvent({ saleId: `SALE-${subId}`, subId, total: "100.00" }));
    const r = await switchToTeamworkBilling(db(), await viewerFor(ctx, "rod"), { membershipId: m.id, reason: "Prefers invoices", today: T });
    const resume = addMonthsYmd(m.nextBillDate!, 1);
    expect(r.firstTeamworkBillDate).toBe(resume);
    const cancel = f.calls.find((c) => c.url.endsWith(`/v1/billing/subscriptions/${subId}/cancel`))!;
    expect(JSON.parse(cancel.body)).toEqual({ reason: "Prefers invoices" });
    expect(await membership(m.id)).toMatchObject({ billingProvider: "manual", providerSubscriptionId: null, nextBillDate: resume });
    const late = await sendPaypal(paypalSubscriptionEvent("BILLING.SUBSCRIPTION.CANCELLED", { subId, status: "CANCELLED" }));
    expect(late.body.detail).toMatch(/already ended/);
    expect((await membership(m.id)).status).not.toBe("cancelled");
  });
});

describe("Venmo via the PayPal JS SDK (server-side order + capture)", () => {
  async function openInvoice(amount = 4500) {
    const rod = await viewerFor(ctx, "rod");
    const { invoice } = await db().transaction((tx) =>
      createManualInvoice(tx, rod, { payerAccountId: ctx.payers.parker, lines: [{ description: "Sample — 2-session pack", unitAmountMinor: amount, athleteId: ctx.athletes.maya, entitlement: { credits: 2, creditExpiryDays: 30 } }] }),
    );
    return invoice;
  }

  it("is unavailable (no button config, no order, no call) until PayPal is configured", async () => {
    const inv = await openInvoice();
    expect(venmoButtonConfig()).toBeNull();
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f.fn);
    const r = await createVenmoOrder(db(), await viewerFor(ctx, "alex"), { invoiceId: inv.id });
    expect(r).toMatchObject({ ok: false, notConfigured: true });
    expect(f.calls).toHaveLength(0);
    paypalOn();
    expect(venmoButtonConfig()).toEqual({ clientId: "fixture-client-id", sandbox: true });
  });

  it("creates the order server-side for the balance, captures server-side, settles once; the later webhook is a no-op", async () => {
    paypalOn();
    const inv = await openInvoice(4500);
    const orderId = `ORDER-${inv.id.slice(0, 8)}`;
    const captureId = `CAP-${inv.id.slice(0, 8)}`;
    let attemptId = "";
    const f = mockFetch([
      paypalOAuth,
      paypalVerify("SUCCESS"),
      (c) => (c.url.endsWith("/v2/checkout/orders") ? { status: 201, json: { id: orderId, status: "CREATED" } } : undefined),
      (c) =>
        c.url.endsWith(`/v2/checkout/orders/${orderId}/capture`)
          ? { status: 201, json: { id: orderId, status: "COMPLETED", payment_source: { venmo: {} }, purchase_units: [{ custom_id: attemptId, payments: { captures: [{ id: captureId, status: "COMPLETED", custom_id: attemptId, amount: { currency_code: "USD", value: "45.00" } }] } }] } }
          : undefined,
    ]);
    vi.stubGlobal("fetch", f.fn);
    const alex = await viewerFor(ctx, "alex");
    const o = await createVenmoOrder(db(), alex, { invoiceId: inv.id });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    attemptId = o.attemptId;
    const orderCall = f.calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    const ob = JSON.parse(orderCall.body);
    expect(ob).toEqual({ intent: "CAPTURE", purchase_units: [{ custom_id: o.attemptId, invoice_id: inv.number, amount: { currency_code: "USD", value: "45.00" } }] });
    expect(orderCall.headers["paypal-request-id"]).toBe(`checkout:${o.attemptId}`);
    // A second tap reuses the open order.
    const again = await createVenmoOrder(db(), alex, { invoiceId: inv.id });
    expect(again).toEqual({ ok: true, orderId, attemptId: o.attemptId });
    // Wrong order id for the attempt is refused.
    await expect(captureVenmoOrder(db(), alex, { attemptId: o.attemptId, orderId: "ORDER-OTHER" })).rejects.toThrow(/does not belong/);
    const cap = await captureVenmoOrder(db(), alex, { attemptId: o.attemptId, orderId });
    expect(cap).toMatchObject({ ok: true, state: "paid" });
    const [after] = await db().select().from(invoices).where(eq(invoices.id, inv.id));
    expect(after.status).toBe("paid");
    const [a] = await db().select().from(paymentAttempts).where(eq(paymentAttempts.id, o.attemptId));
    expect(a).toMatchObject({ status: "succeeded", provider: "venmo" });
    // The verified PAYMENT.CAPTURE.COMPLETED webhook for the same capture changes nothing.
    await ingestWebhook(db(), "paypal", JSON.stringify(paypalCaptureCompletedEvent({ captureId, orderId, attemptId: o.attemptId, value: "45.00" })), paypalHeaders());
    const txns = await db().select().from(transactions).where(eq(transactions.invoiceId, inv.id));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ provider: "venmo", providerTxnId: captureId, verification: "provider_verified", status: "settled" });
    expect(await bucketsFor(inv.id)).toEqual([{ granted: 2 }]);
    // Capturing again (double submit) does not double anything.
    expect((await captureVenmoOrder(db(), alex, { attemptId: o.attemptId, orderId })).state).toBe("paid");
  });

  it("a capture for a different amount is never treated as paid", async () => {
    paypalOn();
    const inv = await openInvoice(4500);
    const orderId = `ORDER-M-${inv.id.slice(0, 6)}`;
    let attemptId = "";
    vi.stubGlobal(
      "fetch",
      mockFetch([
        paypalOAuth,
        (c) => (c.url.endsWith("/v2/checkout/orders") ? { status: 201, json: { id: orderId, status: "CREATED" } } : undefined),
        (c) => (c.url.endsWith("/capture") ? { status: 201, json: { id: orderId, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP-M-${inv.id.slice(0, 6)}`, status: "COMPLETED", custom_id: attemptId, amount: { currency_code: "USD", value: "1.00" } }] } }] } } : undefined),
      ]).fn,
    );
    const alex = await viewerFor(ctx, "alex");
    const o = await createVenmoOrder(db(), alex, { invoiceId: inv.id });
    if (!o.ok) throw new Error(o.error);
    attemptId = o.attemptId;
    const cap = await captureVenmoOrder(db(), alex, { attemptId: o.attemptId, orderId });
    expect(cap).toMatchObject({ ok: false, state: "failed" });
    expect((await db().select().from(invoices).where(eq(invoices.id, inv.id)))[0].status).toBe("open");
    expect(await bucketsFor(inv.id)).toEqual([]);
  });

  it("a guardian without pay permission cannot create or capture a Venmo order", async () => {
    paypalOn();
    const inv = await openInvoice();
    const f = mockFetch([]);
    vi.stubGlobal("fetch", f.fn);
    await expect(createVenmoOrder(db(), await viewerFor(ctx, "jordan"), { invoiceId: inv.id })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
