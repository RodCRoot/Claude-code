import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import {
  disputes,
  invoices,
  paymentAttempts,
  payouts,
  refunds,
  transactions,
  webhookEvents,
  type AttemptStatus,
  type PaymentProvider,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs";
import { getProvider } from "@/lib/payments";
import type { NormalizedEvent, ParsedWebhook } from "@/lib/payments/provider";
import { DeferError } from "./errors";
import { applyInvoiceEntitlements, settleInvoiceIfCovered } from "./invoices";
import { applySubscriptionInvoice, applySubscriptionStatus } from "./subscriptions";
import { billingTask } from "./tasks";
import { billingSettings, int } from "./util";

export const REPROCESS_JOB = "billing.reprocess_webhook";
const MAX_DEFERRALS = 8;

type WebhookProvider = "stripe" | "paypal";
/** Which local providers a webhook endpoint speaks for (Venmo settles through PayPal). */
const PROVIDER_GROUP: Record<WebhookProvider, PaymentProvider[]> = { stripe: ["stripe"], paypal: ["paypal", "venmo"] };

export { DeferError };

export type IngestResult = { httpStatus: number; body: Record<string, unknown> };

/**
 * Webhook ingestion pipeline:
 * 1. Verify signature on the raw body (reject + record on failure; rejected rows never occupy the real event id).
 * 2. Persist to webhook_events (unique provider+event id → duplicates are acknowledged, not reprocessed).
 * 3. Process under a row lock in one transaction with a monotonic state machine.
 */
export async function ingestWebhook(db: DB, provider: WebhookProvider, rawBody: string, headers: Headers, now = new Date()): Promise<IngestResult> {
  const adapter = getProvider(provider);
  let verified: Awaited<ReturnType<typeof adapter.verifyWebhook>>;
  try {
    verified = await adapter.verifyWebhook(rawBody, headers, now);
  } catch (e) {
    verified = { ok: false, reason: `verification error: ${(e as Error).message}` };
  }
  if (!verified.ok) {
    await recordRejected(db, provider, rawBody, verified.reason);
    return { httpStatus: 400, body: { error: "signature verification failed", notConfigured: !!verified.notConfigured } };
  }
  let parsed: ParsedWebhook;
  try {
    parsed = adapter.parseEvent(rawBody);
    if (!parsed.providerEventId) throw new Error("missing event id");
  } catch (e) {
    await recordRejected(db, provider, rawBody, `unparseable payload: ${(e as Error).message}`);
    return { httpStatus: 400, body: { error: "invalid payload" } };
  }
  await db
    .insert(webhookEvents)
    .values({
      provider,
      providerEventId: parsed.providerEventId,
      type: parsed.type,
      payload: parsed.payload as never,
      signatureVerified: true,
      providerCreatedAt: parsed.createdAt,
      status: "received",
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] });
  const [row] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.providerEventId, parsed.providerEventId)));
  const r = await processStoredEvent(db, row.id);
  return { httpStatus: r.outcome === "failed" ? 500 : 200, body: { received: true, ...r } };
}

async function recordRejected(db: DB, provider: string, rawBody: string, reason: string) {
  let claimedId: string | null = null;
  let claimedType = "unknown";
  try {
    const j = JSON.parse(rawBody) as Record<string, unknown>;
    claimedId = typeof j.id === "string" ? j.id : null;
    claimedType = String(j.type ?? j.event_type ?? "unknown");
  } catch {
    /* not JSON */
  }
  await db.insert(webhookEvents).values({
    provider,
    // Never occupy the real event id with an unverified delivery.
    providerEventId: `rejected:${randomUUID()}`,
    type: claimedType,
    payload: { claimedEventId: claimedId, bytes: rawBody.length } as never,
    signatureVerified: false,
    status: "rejected",
    error: reason.slice(0, 500),
  });
}

export type ProcessOutcome = { outcome: "processed" | "ignored" | "duplicate" | "deferred" | "failed"; detail?: string };

/** Process a stored event exactly once. Concurrent callers serialize on the row lock. */
export async function processStoredEvent(db: DB, webhookEventId: string): Promise<ProcessOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [ev] = await tx.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).for("update");
      if (!ev) return { outcome: "ignored", detail: "missing" } as ProcessOutcome;
      if (ev.status === "processed" || ev.status === "ignored") return { outcome: "duplicate" } as ProcessOutcome;
      if (!ev.signatureVerified || ev.status === "rejected") return { outcome: "ignored", detail: "unverified" } as ProcessOutcome;
      const adapter = getProvider(ev.provider as WebhookProvider);
      const parsed = adapter.parseEvent(JSON.stringify(ev.payload));
      const result = await applyEvent(tx, ev.provider as WebhookProvider, parsed.event, parsed.createdAt ?? ev.receivedAt);
      await tx
        .update(webhookEvents)
        .set({ status: result.outcome === "ignored" ? "ignored" : "processed", processedAt: new Date(), error: result.detail ?? null, attempts: ev.attempts + 1 })
        .where(eq(webhookEvents.id, ev.id));
      return result;
    });
  } catch (e) {
    const deferred = e instanceof DeferError;
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId));
    const attempts = (ev?.attempts ?? 0) + 1;
    const giveUp = deferred && attempts >= MAX_DEFERRALS;
    await db.transaction(async (tx) => {
      await tx
        .update(webhookEvents)
        .set({ status: deferred && !giveUp ? "received" : "failed", error: `${deferred ? "deferred: " : ""}${(e as Error).message}`.slice(0, 1000), attempts })
        .where(eq(webhookEvents.id, webhookEventId));
      if (deferred && !giveUp) {
        await enqueue(tx, {
          type: REPROCESS_JOB,
          payload: { webhookEventId },
          dedupeKey: `${REPROCESS_JOB}:${webhookEventId}:${attempts}`,
          runAt: new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** attempts)),
        });
      }
    });
    return { outcome: deferred && !giveUp ? "deferred" : "failed", detail: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

const RANK: Record<AttemptStatus, number> = {
  created: 0,
  requires_action: 1,
  processing: 2,
  pending: 2,
  succeeded: 9,
  failed: 9,
  cancelled: 9,
  expired: 9,
};

/** Monotonic: a terminal attempt never moves again; in-flight states only move forward. */
export function canTransition(from: AttemptStatus, to: AttemptStatus) {
  return RANK[to] > RANK[from];
}

const SYSTEM = (orgId: string | null) => ({ orgId, actorUserId: null, actorRole: "webhook" });

/**
 * Apply a payment result that did not arrive as a webhook but came back from PayPal over our own
 * authenticated server-to-server call (Orders v2 capture). It runs through the exact same idempotent,
 * amount-checked settlement path, so a later webhook for the same capture is a no-op.
 */
export async function applyVerifiedPayment(db: DB, provider: WebhookProvider, ev: Extract<NormalizedEvent, { kind: "payment" }>): Promise<ProcessOutcome> {
  return db.transaction((tx) => applyPayment(tx, provider, ev));
}

async function applyEvent(tx: Tx, provider: WebhookProvider, ev: NormalizedEvent, eventAt: Date): Promise<ProcessOutcome> {
  switch (ev.kind) {
    case "payment":
      return applyPayment(tx, provider, ev);
    case "refund":
      return applyRefund(tx, provider, ev);
    case "dispute":
      return applyDispute(tx, provider, ev);
    case "payout":
      return applyPayout(tx, provider, ev);
    case "subscription_invoice":
      return applySubscriptionInvoice(tx, provider, ev, eventAt);
    case "subscription_status":
      return applySubscriptionStatus(tx, provider, ev, eventAt);
    case "ignored":
      return { outcome: "ignored", detail: ev.reason };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applyPayment(tx: Tx, provider: WebhookProvider, ev: Extract<NormalizedEvent, { kind: "payment" }>): Promise<ProcessOutcome> {
  const group = PROVIDER_GROUP[provider];
  let [attempt] = ev.attemptId && UUID.test(ev.attemptId)
    ? await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.id, ev.attemptId), inArray(paymentAttempts.provider, group))).for("update")
    : [];
  if (!attempt && ev.providerRef) {
    [attempt] = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.providerRef, ev.providerRef), inArray(paymentAttempts.provider, group))).for("update");
  }
  if (!attempt) return { outcome: "ignored", detail: "unmatched: no local payment attempt for this event" };
  const actor = SYSTEM(attempt.orgId);
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, attempt.invoiceId));

  // Amount/currency must equal what we asked for. A mismatch is never granted.
  if (ev.status !== "failed" && ev.status !== "expired" && ev.amountMinor != null) {
    const cur = (ev.currency ?? "").toUpperCase();
    if (ev.amountMinor !== attempt.amountMinor || cur !== attempt.currency.toUpperCase()) {
      const msg = `Provider reported ${ev.amountMinor} ${cur}; expected ${attempt.amountMinor} ${attempt.currency}`;
      if (attempt.status !== "succeeded") {
        await tx
          .update(paymentAttempts)
          .set({ status: "failed", failureCode: "amount_mismatch", failureMessage: msg, lastEventAt: new Date(), updatedAt: new Date() })
          .where(eq(paymentAttempts.id, attempt.id));
      }
      await billingTask(tx, attempt.orgId, {
        title: `Review payment mismatch on invoice ${inv?.number ?? ""}`,
        description: `${msg}. Nothing was granted. Reconcile in the provider dashboard and refund or adjust.`,
        relatedType: "payment_attempt",
        relatedId: attempt.id,
        dedupeKey: `mismatch:${attempt.id}`,
        priority: "high",
      });
      await audit(tx, actor, "billing.webhook.amount_mismatch", "payment_attempt", attempt.id, { summary: msg });
      return { outcome: "processed", detail: "amount_mismatch flagged for review" };
    }
  }

  const target: AttemptStatus = ev.status === "processing" ? "processing" : ev.status;
  const moved = canTransition(attempt.status, target);
  if (moved) {
    await tx
      .update(paymentAttempts)
      .set({
        status: target,
        methodType: ev.methodType ?? attempt.methodType,
        providerRef: attempt.providerRef ?? ev.providerRef,
        failureCode: ev.failureCode ?? (target === "failed" ? "provider_failed" : attempt.failureCode),
        failureMessage: ev.failureMessage ?? attempt.failureMessage,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, attempt.id));
  }
  const txnId = ev.providerTxnId ?? attempt.providerRef ?? attempt.id;
  const txnProvider = attempt.provider;

  if (target === "processing") {
    if (!moved) return { outcome: "processed", detail: `ignored regression ${attempt.status}→processing` };
    await tx
      .insert(transactions)
      .values({
        orgId: attempt.orgId,
        payerAccountId: inv.payerAccountId,
        invoiceId: inv.id,
        paymentAttemptId: attempt.id,
        kind: "charge",
        status: "pending",
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        provider: txnProvider,
        providerTxnId: txnId,
        methodType: ev.methodType,
        verification: "provider_verified",
        isDemo: inv.isDemo,
      })
      .onConflictDoNothing();
    const { pendingBankPaymentPolicy } = await billingSettings(tx, attempt.orgId);
    if (pendingBankPaymentPolicy === "grant_on_pending") await applyInvoiceEntitlements(tx, inv.id, actor);
    await audit(tx, actor, "billing.payment.pending", "payment_attempt", attempt.id, { summary: `Payment processing for ${inv.number} (${ev.methodType ?? "delayed method"}); not counted as paid` });
    return { outcome: "processed", detail: "pending" };
  }

  if (target === "succeeded") {
    // Settle: promote an existing pending row or insert a settled one. Never regress a settled row.
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.provider, txnProvider), eq(transactions.kind, "charge"), eq(transactions.providerTxnId, txnId)))
      .for("update");
    if (existing) {
      if (existing.status === "pending") {
        await tx.update(transactions).set({ status: "settled", settledAt: new Date(), methodType: existing.methodType ?? ev.methodType }).where(eq(transactions.id, existing.id));
      }
    } else {
      await tx.insert(transactions).values({
        orgId: attempt.orgId,
        payerAccountId: inv.payerAccountId,
        invoiceId: inv.id,
        paymentAttemptId: attempt.id,
        kind: "charge",
        status: "settled",
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        provider: txnProvider,
        providerTxnId: txnId,
        methodType: ev.methodType,
        settledAt: new Date(),
        verification: "provider_verified",
        isDemo: inv.isDemo,
      });
    }
    const r = await settleInvoiceIfCovered(tx, inv.id, actor);
    if (moved) await audit(tx, actor, "billing.payment.succeeded", "payment_attempt", attempt.id, { summary: `Verified ${provider} payment for ${inv.number}${r.paid ? " — invoice paid" : ""}` });
    return { outcome: "processed", detail: moved ? "settled" : "settled (already succeeded)" };
  }

  if (target === "failed") {
    if (!moved) return { outcome: "processed", detail: `ignored ${attempt.status}→failed` };
    const pend = await tx
      .update(transactions)
      .set({ status: "failed" })
      .where(and(eq(transactions.paymentAttemptId, attempt.id), eq(transactions.kind, "charge"), eq(transactions.status, "pending")))
      .returning();
    const { pendingBankPaymentPolicy } = await billingSettings(tx, attempt.orgId);
    if (pend.length && pendingBankPaymentPolicy === "grant_on_pending") {
      await billingTask(tx, attempt.orgId, {
        title: `Bank payment failed after credits were granted (${inv.number})`,
        description: "Policy grant_on_pending granted entitlements while the payment was processing. Review credits/membership and collect payment.",
        relatedType: "invoice",
        relatedId: inv.id,
        dedupeKey: `pending-failed:${attempt.id}`,
        priority: "high",
      });
    }
    await audit(tx, actor, "billing.payment.failed", "payment_attempt", attempt.id, { summary: `Payment failed for ${inv.number}: ${ev.failureCode ?? "provider reported failure"}` });
    return { outcome: "processed", detail: "failed" };
  }

  // expired
  return { outcome: "processed", detail: moved ? "expired" : `ignored ${attempt.status}→expired` };
}

async function findCharge(tx: Tx, provider: WebhookProvider, providerTxnId: string) {
  const [t] = await tx
    .select()
    .from(transactions)
    .where(and(inArray(transactions.provider, PROVIDER_GROUP[provider]), eq(transactions.kind, "charge"), eq(transactions.providerTxnId, providerTxnId)))
    .for("update");
  return t ?? null;
}

async function applyRefund(tx: Tx, provider: WebhookProvider, ev: Extract<NormalizedEvent, { kind: "refund" }>): Promise<ProcessOutcome> {
  const charge = await findCharge(tx, provider, ev.providerTxnId);
  if (!charge) throw new DeferError(`refund for ${ev.providerTxnId} arrived before its charge was recorded`);
  const actor = SYSTEM(charge.orgId);
  const prior = await tx
    .select({ total: sql<string>`coalesce(sum(-${transactions.amountMinor}),0)::bigint` })
    .from(transactions)
    .where(and(eq(transactions.kind, "refund"), eq(transactions.invoiceId, charge.invoiceId!), eq(transactions.provider, charge.provider), sql`${transactions.notes} = ${"refund-of:" + charge.id}`));
  const already = int(prior[0]?.total);
  const delta = ev.cumulative ? ev.amountMinor - already : ev.amountMinor;
  if (delta <= 0) return { outcome: "processed", detail: "refund already recorded" };
  if (already + delta > charge.amountMinor) throw new Error(`refund total ${already + delta} exceeds charge ${charge.amountMinor}`);
  const ins = await tx
    .insert(transactions)
    .values({
      orgId: charge.orgId,
      payerAccountId: charge.payerAccountId,
      invoiceId: charge.invoiceId,
      kind: "refund",
      status: "settled",
      amountMinor: -delta,
      currency: charge.currency,
      provider: charge.provider,
      providerTxnId: ev.providerRefundId,
      settledAt: new Date(),
      verification: "provider_verified",
      notes: `refund-of:${charge.id}`,
      isDemo: charge.isDemo,
    })
    .onConflictDoNothing()
    .returning();
  if (!ins.length) return { outcome: "processed", detail: "refund already recorded" };
  // Close out a matching staff-requested refund, or record one initiated in the provider dashboard.
  const [req] = await tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.transactionId, charge.id), inArray(refunds.status, ["pending", "requested"]), eq(refunds.amountMinor, delta)))
    .limit(1);
  if (req) await tx.update(refunds).set({ status: "succeeded" }).where(eq(refunds.id, req.id));
  else
    await tx.insert(refunds).values({ orgId: charge.orgId, transactionId: charge.id, amountMinor: delta, currency: charge.currency, status: "succeeded", reason: "Refund initiated at provider" });
  await billingTask(tx, charge.orgId, {
    title: "Review entitlements after refund",
    description: "A refund settled. Credits are NOT auto-revoked (some may be used). Review the athlete's credits/membership and adjust if appropriate.",
    relatedType: "invoice",
    relatedId: charge.invoiceId,
    dedupeKey: `refund-review:${ins[0].id}`,
  });
  await audit(tx, actor, "billing.refund.settled", "transaction", ins[0].id, { summary: `Provider refund of ${delta} settled` });
  return { outcome: "processed", detail: "refund recorded" };
}

async function applyDispute(tx: Tx, provider: WebhookProvider, ev: Extract<NormalizedEvent, { kind: "dispute" }>): Promise<ProcessOutcome> {
  const charge = ev.providerTxnId ? await findCharge(tx, provider, ev.providerTxnId) : null;
  if (!charge) throw new DeferError(`dispute ${ev.providerDisputeId} references an unrecorded charge`);
  const actor = SYSTEM(charge.orgId);
  await tx
    .insert(disputes)
    .values({
      orgId: charge.orgId,
      transactionId: charge.id,
      provider,
      providerDisputeId: ev.providerDisputeId,
      amountMinor: ev.amountMinor,
      currency: ev.currency,
      status: ev.status,
      reason: ev.reason,
      evidenceDueBy: ev.evidenceDueBy,
    })
    .onConflictDoUpdate({ target: disputes.providerDisputeId, set: { status: ev.status, updatedAt: new Date(), evidenceDueBy: ev.evidenceDueBy } });
  // Reversal entries: funds withdrawn on dispute; returned if won.
  await tx
    .insert(transactions)
    .values({
      orgId: charge.orgId,
      payerAccountId: charge.payerAccountId,
      invoiceId: charge.invoiceId,
      kind: "dispute",
      status: "settled",
      amountMinor: -ev.amountMinor,
      currency: ev.currency,
      provider: charge.provider,
      providerTxnId: ev.providerDisputeId,
      settledAt: new Date(),
      verification: "provider_verified",
      notes: `dispute-of:${charge.id}`,
      isDemo: charge.isDemo,
    })
    .onConflictDoNothing();
  if (ev.phase === "closed" && ev.status === "won") {
    await tx
      .insert(transactions)
      .values({
        orgId: charge.orgId,
        payerAccountId: charge.payerAccountId,
        invoiceId: charge.invoiceId,
        kind: "dispute_reversal",
        status: "settled",
        amountMinor: ev.amountMinor,
        currency: ev.currency,
        provider: charge.provider,
        providerTxnId: ev.providerDisputeId,
        settledAt: new Date(),
        verification: "provider_verified",
        notes: `dispute-won:${charge.id}`,
        isDemo: charge.isDemo,
      })
      .onConflictDoNothing();
  }
  if (ev.phase === "created") {
    await billingTask(tx, charge.orgId, {
      title: `Payment disputed (${ev.reason ?? "no reason given"})`,
      description: `Respond in the ${provider} dashboard${ev.evidenceDueBy ? ` before ${ev.evidenceDueBy.toISOString().slice(0, 10)}` : ""}. Credits are not auto-revoked.`,
      relatedType: "dispute",
      relatedId: charge.invoiceId,
      dedupeKey: `dispute:${ev.providerDisputeId}`,
      priority: "high",
    });
  }
  await audit(tx, actor, `billing.dispute.${ev.phase}`, "dispute", ev.providerDisputeId, { summary: `Dispute ${ev.status} for ${ev.amountMinor} ${ev.currency}` });
  return { outcome: "processed", detail: `dispute ${ev.phase}` };
}

async function applyPayout(tx: Tx, provider: WebhookProvider, ev: Extract<NormalizedEvent, { kind: "payout" }>): Promise<ProcessOutcome> {
  // Payouts carry no customer reference; route to the single org that transacts with this provider.
  const orgs = await tx.execute(sql`select distinct org_id from transactions where provider = ${provider} limit 2`);
  if (orgs.rows.length !== 1) return { outcome: "ignored", detail: "unroutable payout (no single org for provider)" };
  const orgId = (orgs.rows[0] as { org_id: string }).org_id;
  await tx
    .insert(payouts)
    .values({ orgId, provider, providerPayoutId: ev.providerPayoutId, amountMinor: ev.amountMinor, currency: ev.currency, status: ev.status, arrivalDate: ev.arrivalDate })
    .onConflictDoUpdate({ target: payouts.providerPayoutId, set: { status: ev.status } });
  return { outcome: "processed", detail: "payout recorded" };
}

