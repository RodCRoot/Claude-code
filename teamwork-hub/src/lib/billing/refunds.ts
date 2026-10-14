import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { refunds, transactions } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { getProvider, ProviderNotConfiguredError } from "@/lib/payments";
import { billingTask } from "./tasks";
import { actorOf, assertMinor, int } from "./util";

/** Amount still refundable on a settled charge (counts requested/pending/succeeded refunds). */
export async function refundableMinor(tx: Tx, chargeId: string, chargeAmount: number) {
  const [r] = await tx
    .select({ s: sql<string>`coalesce(sum(${refunds.amountMinor}),0)::bigint` })
    .from(refunds)
    .where(and(eq(refunds.transactionId, chargeId), inArray(refunds.status, ["requested", "pending", "succeeded"])));
  return chargeAmount - int(r?.s);
}

export type RefundOutcome = { status: "succeeded" | "pending" | "blocked_config" | "failed"; refundId: string; message: string };

/**
 * Refund a settled payment.
 * - Manual/offline payments (or `offline: true`): recorded as a staff_attested refund with a required reference.
 * - Provider payments: sent through the adapter with an idempotency key; when the provider is not
 *   configured the refund is recorded as blocked_config and NOTHING is sent. The money entry is only
 *   written when the provider's verified refund webhook arrives.
 * Credits are never auto-revoked; a staff review task is created.
 */
export async function requestRefund(
  db: DB,
  v: Viewer,
  input: { transactionId: string; amountMinor: number; reason: string; offline?: boolean; reference?: string | null },
): Promise<RefundOutcome> {
  assertCan(v, "billing.refund");
  assertMinor(input.amountMinor);
  if (input.amountMinor <= 0) throw new UserError("Refund amount must be greater than $0.");
  if (!input.reason.trim()) throw new UserError("A refund reason is required.");

  const prep = await db.transaction(async (tx) => {
    const [charge] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, input.transactionId), eq(transactions.orgId, v.orgId)))
      .for("update");
    if (!charge || !["charge", "manual_payment"].includes(charge.kind)) throw new UserError("Payment not found.");
    if (charge.status !== "settled") throw new UserError("Only settled payments can be refunded.");
    const refundable = await refundableMinor(tx, charge.id, charge.amountMinor);
    if (input.amountMinor > refundable) throw new UserError(`At most ${refundable} cents can still be refunded on this payment.`);
    const offline = charge.provider === "manual" || input.offline;
    const refundId = randomUUID();

    if (offline) {
      const reference = (input.reference ?? "").trim();
      if (!reference) throw new UserError("Offline refunds need a reference (check #, cash receipt #…).", { reference: "Required" });
      await tx.insert(refunds).values({
        id: refundId,
        orgId: v.orgId,
        transactionId: charge.id,
        amountMinor: input.amountMinor,
        currency: charge.currency,
        status: "succeeded",
        reason: input.reason.trim(),
        requestedBy: v.userId,
        idempotencyKey: `refund:${refundId}`,
      });
      const [rt] = await tx
        .insert(transactions)
        .values({
          orgId: v.orgId,
          payerAccountId: charge.payerAccountId,
          invoiceId: charge.invoiceId,
          kind: "refund",
          status: "settled",
          amountMinor: -input.amountMinor,
          currency: charge.currency,
          provider: "manual",
          methodType: "offline_refund",
          settledAt: new Date(),
          recordedBy: v.userId,
          manualReference: reference,
          verification: "staff_attested",
          notes: `refund-of:${charge.id}`,
          isDemo: charge.isDemo,
        })
        .returning();
      await reviewTask(tx, v.orgId, charge.invoiceId, rt.id);
      await audit(tx, actorOf(v), "billing.refund.manual", "refund", refundId, { summary: `Offline refund ${input.amountMinor} (staff attested, ref ${reference}): ${input.reason}` });
      return { done: { status: "succeeded" as const, refundId, message: "Offline refund recorded (staff attested)." } };
    }

    const adapter = getProvider(charge.provider);
    if (!adapter.isConfigured()) {
      const why = `${adapter.capabilities().label} is not configured (${adapter.missingEnv().join(", ")}). Nothing was sent. Refund in the provider dashboard once connected, or record an offline refund.`;
      await tx.insert(refunds).values({
        id: refundId,
        orgId: v.orgId,
        transactionId: charge.id,
        amountMinor: input.amountMinor,
        currency: charge.currency,
        status: "blocked_config",
        reason: `${input.reason.trim()} — ${why}`,
        requestedBy: v.userId,
        idempotencyKey: `refund:${refundId}`,
      });
      await audit(tx, actorOf(v), "billing.refund.blocked_config", "refund", refundId, { summary: why });
      return { done: { status: "blocked_config" as const, refundId, message: why } };
    }
    if (!charge.providerTxnId) throw new UserError("This payment has no provider reference to refund against.");
    await tx.insert(refunds).values({
      id: refundId,
      orgId: v.orgId,
      transactionId: charge.id,
      amountMinor: input.amountMinor,
      currency: charge.currency,
      status: "requested",
      reason: input.reason.trim(),
      requestedBy: v.userId,
      idempotencyKey: `refund:${refundId}`,
    });
    await audit(tx, actorOf(v), "billing.refund.request", "refund", refundId, { summary: `Refund ${input.amountMinor} requested via ${charge.provider}: ${input.reason}` });
    return { send: { refundId, charge } };
  });

  if ("done" in prep && prep.done) return prep.done;
  const { refundId, charge } = (prep as { send: { refundId: string; charge: typeof transactions.$inferSelect } }).send;
  try {
    const res = await getProvider(charge.provider).refund({
      providerTxnId: charge.providerTxnId!,
      amountMinor: input.amountMinor,
      currency: charge.currency,
      idempotencyKey: `refund:${refundId}`,
      reason: input.reason,
    });
    // Money is recorded when the verified refund webhook arrives; this is just the request status.
    await db.update(refunds).set({ status: res.status === "failed" ? "failed" : "pending", providerRefundId: res.providerRefundId }).where(eq(refunds.id, refundId));
    return { status: res.status === "failed" ? "failed" : "pending", refundId, message: "Refund submitted to the provider; it will show as refunded when the provider confirms." };
  } catch (e) {
    const blocked = e instanceof ProviderNotConfiguredError;
    await db.update(refunds).set({ status: blocked ? "blocked_config" : "failed", reason: `${input.reason} — ${(e as Error).message}`.slice(0, 1000) }).where(eq(refunds.id, refundId));
    return { status: blocked ? "blocked_config" : "failed", refundId, message: (e as Error).message };
  }
}

async function reviewTask(tx: Tx, orgId: string, invoiceId: string | null, txnId: string) {
  await billingTask(tx, orgId, {
    title: "Review entitlements after refund",
    description: "Credits are NOT auto-revoked on refund (some may already be used). Review the athlete's credits/membership and adjust if appropriate.",
    relatedType: "invoice",
    relatedId: invoiceId,
    dedupeKey: `refund-review:${txnId}`,
  });
}
