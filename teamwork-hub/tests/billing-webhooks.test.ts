import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { creditBuckets, invoices, jobs, organizations, paymentAttempts, tasks, transactions, webhookEvents } from "@/db/schema";
import { createManualInvoice, invoiceMoney } from "@/lib/billing/invoices";
import { checkoutReturnView } from "@/lib/billing/checkout";
import { ingestWebhook, processStoredEvent } from "@/lib/billing/webhooks";
import { verifyStripeSignature, signStripePayload } from "@/lib/payments/stripe";
import { creditSummary } from "@/lib/credits";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { TEST_WHSEC, chargeRefundedEvent, checkoutSessionEvent, disputeEvent, evtId, signedHeaders } from "./fixtures/payments/stripe";

let ctx: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  ctx = await seedOrg();
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID;
});
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await closeTestDb();
});

/** An open invoice for a 10-pack for `athleteKey`, plus a Stripe attempt as if checkout had been created. */
async function invoiceWithAttempt(athleteKey = "maya", payerKey = "parker", credits = 10) {
  const db = testDb();
  const rod = await viewerFor(ctx, "rod");
  const { invoice } = await db.transaction((tx) =>
    createManualInvoice(tx, rod, {
      payerAccountId: ctx.payers[payerKey],
      lines: [{ description: "Sample — 10-Session Pack", unitAmountMinor: 25000, athleteId: ctx.athletes[athleteKey], entitlement: { credits, creditExpiryDays: 90 } }],
    }),
  );
  const id = randomUUID();
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({ id, orgId: ctx.orgId, invoiceId: invoice.id, provider: "stripe", providerRef: `cs_test_${id.slice(0, 8)}`, amountMinor: invoice.totalMinor, currency: "USD", status: "requires_action", idempotencyKey: `checkout:${id}` })
    .returning();
  return { invoice, attempt };
}

const send = (event: object) => {
  const body = JSON.stringify(event);
  return ingestWebhook(testDb(), "stripe", body, signedHeaders(body));
};

async function bucketsForInvoice(invoiceId: string) {
  return testDb().execute(sql`select b.* from credit_buckets b join invoice_lines l on l.id = b.source_invoice_line_id where l.invoice_id = ${invoiceId}`);
}

describe("Stripe signature verification (node:crypto HMAC)", () => {
  it("accepts a valid v1 signature and rejects tampering, wrong secret, and stale timestamps", () => {
    const body = '{"id":"evt_1","type":"x"}';
    const now = new Date();
    const header = signStripePayload(TEST_WHSEC, body, Math.floor(now.getTime() / 1000));
    expect(verifyStripeSignature(body, header, TEST_WHSEC, now).ok).toBe(true);
    expect(verifyStripeSignature(body + " ", header, TEST_WHSEC, now).ok).toBe(false);
    expect(verifyStripeSignature(body, header, "whsec_other", now).ok).toBe(false);
    expect(verifyStripeSignature(body, null, TEST_WHSEC, now).ok).toBe(false);
    const old = signStripePayload(TEST_WHSEC, body, Math.floor(now.getTime() / 1000) - 600);
    const r = verifyStripeSignature(body, old, TEST_WHSEC, now);
    expect(r.ok).toBe(false);
    // v0 (test-only scheme) is ignored even if it matches.
    const t = Math.floor(now.getTime() / 1000);
    const v0Only = signStripePayload(TEST_WHSEC, body, t).replace("v1=", "v0=");
    expect(verifyStripeSignature(body, v0Only, TEST_WHSEC, now).ok).toBe(false);
  });
});

describe("Stripe webhook ingestion", () => {
  it("processes a signed checkout.session.completed exactly once when delivered 3× concurrently and again later", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("maya");
    const ev = checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: invoice.totalMinor });
    const results = await Promise.all([send(ev), send(ev), send(ev)]);
    expect(results.every((r) => r.httpStatus === 200)).toBe(true);
    const outcomes = results.map((r) => r.body.outcome).sort();
    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(2);
    const again = await send(ev);
    expect(again.body.outcome).toBe("duplicate");

    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventId, ev.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("processed");
    const txns = await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ kind: "charge", status: "settled", verification: "provider_verified", amountMinor: 25000 });
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(inv.status).toBe("paid");
    const buckets = await bucketsForInvoice(invoice.id);
    expect(buckets.rows).toHaveLength(1);
    expect((buckets.rows[0] as { granted: number }).granted).toBe(10);
  });

  it("a different event for an already-settled payment does not double-grant", async () => {
    const { invoice, attempt } = await invoiceWithAttempt("eli");
    await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000 }));
    // e.g. async_payment_succeeded with a new event id for the same payment
    const r = await send(checkoutSessionEvent("checkout.session.async_payment_succeeded", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000 }));
    expect(r.httpStatus).toBe(200);
    expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(1);
    expect((await testDb().select().from(transactions).where(eq(transactions.invoiceId, invoice.id))).length).toBe(1);
  });

  it("out-of-order delivery (succeeded, then processing) never regresses", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("leo", "rivera");
    await send(checkoutSessionEvent("checkout.session.async_payment_succeeded", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, methods: ["us_bank_account"] }));
    const late = await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, paymentStatus: "unpaid", methods: ["us_bank_account"] }));
    expect(late.httpStatus).toBe(200);
    const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id));
    expect(a.status).toBe("succeeded");
    const txns = await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id));
    expect(txns.map((t) => t.status)).toEqual(["settled"]);
    expect((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].status).toBe("paid");
  });

  it("rejects bad signatures, records them without claiming the event id, and still accepts the genuine delivery", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("dana", "dana");
    const ev = checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000 });
    const body = JSON.stringify(ev);
    const bad = await ingestWebhook(db, "stripe", body, signedHeaders(body, "whsec_attacker"));
    expect(bad.httpStatus).toBe(400);
    const forged = await ingestWebhook(db, "stripe", body, new Headers({ "stripe-signature": "t=1,v1=deadbeef" }));
    expect(forged.httpStatus).toBe(400);
    const rejected = await db.select().from(webhookEvents).where(and(eq(webhookEvents.status, "rejected"), sql`${webhookEvents.payload}->>'claimedEventId' = ${ev.id}`));
    expect(rejected.length).toBe(2);
    expect(rejected.every((r) => !r.signatureVerified)).toBe(true);
    expect((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].status).toBe("open");
    const good = await send(ev);
    expect(good.body.outcome).toBe("processed");
  });

  it("without STRIPE_WEBHOOK_SECRET every delivery is rejected", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const body = JSON.stringify({ id: evtId(), type: "checkout.session.completed", data: { object: {} } });
    const r = await ingestWebhook(testDb(), "stripe", body, signedHeaders(body));
    expect(r.httpStatus).toBe(400);
    expect(r.body.notConfigured).toBe(true);
  });

  it("amount or currency mismatch is flagged for review and never granted", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("ava", "chris_parker");
    const r = await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 100 }));
    expect(r.body.detail).toMatch(/mismatch/);
    const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id));
    expect(a.status).toBe("failed");
    expect(a.failureCode).toBe("amount_mismatch");
    expect((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].status).toBe("open");
    expect((await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id))).length).toBe(0);
    expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(0);
    const t = await db.select().from(tasks).where(eq(tasks.dedupeKey, `billing:mismatch:${attempt.id}`));
    expect(t).toHaveLength(1);

    const second = await invoiceWithAttempt("ava", "chris_parker");
    await send(checkoutSessionEvent("checkout.session.completed", { attemptId: second.attempt.id, invoiceId: second.invoice.id, amount: 25000, currency: "cad" }));
    expect((await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, second.attempt.id)))[0].failureCode).toBe("amount_mismatch");
    expect((await bucketsForInvoice(second.invoice.id)).rows).toHaveLength(0);
  });

  it("the browser return view never marks anything paid", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const { invoice, attempt } = await invoiceWithAttempt("maya");
    const view = await db.transaction((tx) => checkoutReturnView(tx, alex, attempt.id));
    expect(view.state).toBe("confirming");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(inv.status).toBe("open");
    expect((await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id))).length).toBe(0);
    const [a] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id));
    expect(a.status).toBe("requires_action");
    // Someone without access cannot even read it.
    const casey = await viewerFor(ctx, "casey");
    await expect(db.transaction((tx) => checkoutReturnView(tx, casey, attempt.id))).rejects.toThrow();
  });

  it("pending ACH is not entitled until settlement under the default policy", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("harper", "harper");
    await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, paymentStatus: "unpaid", methods: ["us_bank_account"] }));
    let money = await invoiceMoney(db, invoice.id);
    expect(money).toMatchObject({ pendingMinor: 25000, settledMinor: 0, balanceMinor: 25000 });
    expect((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].status).toBe("open");
    expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(0);
    await send(checkoutSessionEvent("checkout.session.async_payment_succeeded", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, methods: ["us_bank_account"] }));
    money = await invoiceMoney(db, invoice.id);
    expect(money).toMatchObject({ pendingMinor: 0, settledMinor: 25000, balanceMinor: 0 });
    expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(1);
    const txns = await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id));
    expect(txns).toHaveLength(1);
    expect(txns[0].methodType).toBe("us_bank_account");
  });

  it("grant_on_pending policy grants at pending, and a later failure creates a staff task", async () => {
    const db = testDb();
    await db.execute(sql`update organizations set settings = settings || '{"pendingBankPaymentPolicy":"grant_on_pending"}'::jsonb where id = ${ctx.orgId}`);
    try {
      const { invoice, attempt } = await invoiceWithAttempt("ella", "ella");
      await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, paymentStatus: "unpaid", methods: ["us_bank_account"] }));
      expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(1);
      expect((await db.select().from(invoices).where(eq(invoices.id, invoice.id)))[0].status).toBe("open");
      await send(checkoutSessionEvent("checkout.session.async_payment_failed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, methods: ["us_bank_account"] }));
      const txns = await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id));
      expect(txns[0].status).toBe("failed");
      expect(await db.select().from(tasks).where(eq(tasks.dedupeKey, `billing:pending-failed:${attempt.id}`))).toHaveLength(1);
    } finally {
      await db.update(organizations).set({ settings: sql`${organizations.settings} || '{"pendingBankPaymentPolicy":"grant_on_settlement"}'::jsonb` }).where(eq(organizations.id, ctx.orgId));
    }
  });

  it("a refund that arrives before its charge is deferred, then applied once the charge is recorded", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("owen", "owen");
    const pi = `pi_test_${attempt.id.slice(0, 8)}`;
    const refund = chargeRefundedEvent({ pi, amount: 25000, amountRefunded: 5000 });
    const r1 = await send(refund);
    expect(r1.body.outcome).toBe("deferred");
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventId, refund.id));
    expect(row.status).toBe("received");
    const queued = await db.select().from(jobs).where(sql`${jobs.payload}->>'webhookEventId' = ${row.id}`);
    expect(queued.length).toBe(1);

    await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, pi }));
    const r2 = await processStoredEvent(db, row.id);
    expect(r2.outcome).toBe("processed");
    const again = await processStoredEvent(db, row.id);
    expect(again.outcome).toBe("duplicate");
    const money = await invoiceMoney(db, invoice.id);
    expect(money.refundedMinor).toBe(5000);
    // A later cumulative event (full refund) records only the delta.
    await send(chargeRefundedEvent({ pi, amount: 25000, amountRefunded: 25000 }));
    expect((await invoiceMoney(db, invoice.id)).refundedMinor).toBe(25000);
    // Credits are not auto-revoked; a review task exists instead.
    expect((await bucketsForInvoice(invoice.id)).rows).toHaveLength(1);
  });

  it("disputes create reversal entries and an urgent staff task", async () => {
    const db = testDb();
    const { invoice, attempt } = await invoiceWithAttempt("aria", "aria");
    const pi = `pi_test_${attempt.id.slice(0, 8)}`;
    await send(checkoutSessionEvent("checkout.session.completed", { attemptId: attempt.id, invoiceId: invoice.id, amount: 25000, pi }));
    const disputeId = `dp_test_${attempt.id.slice(0, 8)}`;
    await send(disputeEvent("charge.dispute.created", { pi, amount: 25000, status: "needs_response", disputeId }));
    await send(disputeEvent("charge.dispute.closed", { pi, amount: 25000, status: "won", disputeId }));
    const txns = await db.select().from(transactions).where(eq(transactions.invoiceId, invoice.id));
    expect(txns.map((t) => `${t.kind}:${t.amountMinor}`).sort()).toEqual(["charge:25000", "dispute:-25000", "dispute_reversal:25000"]);
    expect(await db.select().from(tasks).where(eq(tasks.dedupeKey, `billing:dispute:${disputeId}`))).toHaveLength(1);
  });

  it("PayPal webhooks are rejected and recorded when the verification API is not configured", async () => {
    const db = testDb();
    const body = JSON.stringify({ id: `WH-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "cap1", amount: { value: "250.00", currency_code: "USD" } } });
    const r = await ingestWebhook(db, "paypal", body, new Headers({ "paypal-transmission-id": "x", "paypal-transmission-sig": "y" }));
    expect(r.httpStatus).toBe(400);
    expect(r.body.notConfigured).toBe(true);
    const [row] = await db.select().from(webhookEvents).where(and(eq(webhookEvents.provider, "paypal"), eq(webhookEvents.status, "rejected")));
    expect(row.signatureVerified).toBe(false);
  });

  it("credit balances reflect only settled grants", async () => {
    const sum = await creditSummary(testDb(), ctx.athletes.maya);
    expect(Number.isInteger(sum.available)).toBe(true);
    const all = await testDb().select().from(creditBuckets).where(eq(creditBuckets.orgId, ctx.orgId));
    expect(all.every((b) => b.sourceInvoiceLineId === null || b.granted > 0)).toBe(true);
  });
});
