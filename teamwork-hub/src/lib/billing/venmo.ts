/**
 * Pay an invoice with Venmo through the PayPal JavaScript SDK button.
 *
 * - The button page only renders when PayPal is configured. The client id is public; the secret never
 *   leaves the server.
 * - The order is created here, server-side, for the invoice balance (never an amount from the browser).
 * - Capture happens here, server-side. Its result comes from PayPal over our authenticated API call and is
 *   applied through the same idempotent, amount-checked settlement path as a verified webhook
 *   (`applyVerifiedPayment`). The later PAYMENT.CAPTURE.* webhook for the same capture is a no-op.
 * - The browser never reports "paid": it only shows what the server recorded.
 * - One-time only. Recurring Venmo is not offered (not documented for PayPal Subscriptions).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { invoices, memberships, paymentAttempts } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { getProvider, ProviderNotConfiguredError, ProviderUnsupportedError } from "@/lib/payments";
import { capturePaypalOrderDetailed, createSdkOrder } from "@/lib/payments/paypal";
import { assertCanPayPayer, loadInvoiceForViewer } from "./access";
import { UserError } from "./errors";
import { invoiceMoney } from "./invoices";
import { actorOf } from "./util";
import { applyVerifiedPayment } from "./webhooks";

export type VenmoOrderOutcome = { ok: true; orderId: string; attemptId: string } | { ok: false; error: string; notConfigured?: boolean };

/** Public config for the SDK script. Null when PayPal is not fully configured (secret + webhook id too). */
export function venmoButtonConfig(): { clientId: string; sandbox: boolean } | null {
  const a = getProvider("venmo");
  if (!a.isConfigured()) return null;
  return { clientId: process.env.PAYPAL_CLIENT_ID!, sandbox: process.env.PAYPAL_ENV !== "live" };
}

export async function createVenmoOrder(db: DB, v: Viewer, input: { invoiceId: string }): Promise<VenmoOrderOutcome> {
  if (!getProvider("venmo").isConfigured()) return { ok: false, error: "Venmo (via PayPal) is not configured. Nothing was created or charged.", notConfigured: true };
  const prep = await db.transaction(async (tx) => {
    const inv = await loadInvoiceForViewer(tx, v, input.invoiceId);
    await assertCanPayPayer(tx, v, inv.payerAccountId);
    if (inv.status !== "open") throw new UserError(`This invoice is ${inv.status}; nothing to pay.`);
    if (inv.currency.toUpperCase() !== "USD") throw new UserError("Venmo is available for USD invoices only.");
    if (inv.membershipId) {
      const [m] = await tx.select({ bp: memberships.billingProvider }).from(memberships).where(eq(memberships.id, inv.membershipId));
      if (m?.bp === "external_zenplanner") throw new UserError("This membership is billed by Zen Planner until cutover.");
    }
    const money = await invoiceMoney(tx, inv.id);
    if (money.pendingMinor > 0) throw new UserError("A payment for this invoice is still processing.");
    if (money.balanceMinor <= 0) throw new UserError("Nothing is due on this invoice.");
    // Reuse an open Venmo order for the same amount (double tap / reload) instead of creating another.
    const [open] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.invoiceId, inv.id),
          eq(paymentAttempts.provider, "venmo"),
          eq(paymentAttempts.amountMinor, money.balanceMinor),
          inArray(paymentAttempts.status, ["requires_action"]),
          gt(paymentAttempts.createdAt, new Date(Date.now() - 3 * 3_600_000)),
        ),
      )
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(1);
    if (open?.providerRef) return { reuse: open };
    const id = randomUUID();
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({ id, orgId: inv.orgId, invoiceId: inv.id, provider: "venmo", amountMinor: money.balanceMinor, currency: "USD", status: "created", methodType: "venmo", idempotencyKey: `checkout:${id}`, createdBy: v.userId })
      .returning();
    await audit(tx, actorOf(v), "billing.checkout.create", "payment_attempt", attempt.id, { summary: `Venmo (PayPal SDK) order for ${inv.number} (${money.balanceMinor} USD)` });
    return { attempt, inv };
  });
  if ("reuse" in prep && prep.reuse) return { ok: true, orderId: prep.reuse.providerRef!, attemptId: prep.reuse.id };
  const { attempt, inv } = prep as { attempt: typeof paymentAttempts.$inferSelect; inv: typeof invoices.$inferSelect };
  try {
    const order = await createSdkOrder({ attemptId: attempt.id, invoiceId: inv.id, invoiceNumber: inv.number, amountMinor: attempt.amountMinor, currency: "USD", lines: [], idempotencyKey: attempt.idempotencyKey });
    await db.update(paymentAttempts).set({ providerRef: order.orderId, status: "requires_action", updatedAt: new Date() }).where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "created")));
    return { ok: true, orderId: order.orderId, attemptId: attempt.id };
  } catch (e) {
    await db
      .update(paymentAttempts)
      .set({ status: "failed", failureCode: e instanceof ProviderUnsupportedError ? "unsupported" : "checkout_error", failureMessage: (e as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt.id));
    if (e instanceof ProviderNotConfiguredError) return { ok: false, error: e.message, notConfigured: true };
    if (e instanceof ProviderUnsupportedError) return { ok: false, error: e.message };
    return { ok: false, error: "PayPal did not accept the request. Nothing was charged." };
  }
}

export type VenmoCaptureOutcome = { ok: boolean; state: "paid" | "pending" | "failed" | "confirming"; message: string };

/** Capture the approved order server-side and settle from PayPal's response (never from the browser). */
export async function captureVenmoOrder(db: DB, v: Viewer, input: { attemptId: string; orderId: string }): Promise<VenmoCaptureOutcome> {
  const attempt = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.orgId, v.orgId)));
    if (!a || a.provider !== "venmo") throw new UserError("Payment not found.");
    const inv = await loadInvoiceForViewer(tx, v, a.invoiceId);
    await assertCanPayPayer(tx, v, inv.payerAccountId);
    if (!a.providerRef || a.providerRef !== input.orderId) throw new UserError("This order does not belong to this payment.");
    return a;
  });
  if (attempt.status === "succeeded") return { ok: true, state: "paid", message: "Payment already recorded." };
  const res = await capturePaypalOrderDetailed(attempt.providerRef!, `capture:${attempt.idempotencyKey}`);
  if (!res.payment) {
    return { ok: false, state: "confirming", message: `PayPal reported ${res.orderStatus}. We'll update the invoice when PayPal confirms; nothing was marked paid.` };
  }
  // Bind the capture to this attempt even if PayPal omitted custom_id on the capture object.
  const outcome = await applyVerifiedPayment(db, "paypal", { ...res.payment, attemptId: attempt.id, providerRef: attempt.providerRef });
  const [after] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id));
  const [inv] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, attempt.invoiceId));
  if (inv?.status === "paid") return { ok: true, state: "paid", message: "Paid with Venmo. Thank you!" };
  if (after?.status === "processing" || after?.status === "pending") return { ok: true, state: "pending", message: "Venmo/PayPal is still processing this payment. It is not counted as paid until it completes." };
  if (after?.status === "failed") return { ok: false, state: "failed", message: after.failureCode === "amount_mismatch" ? "The captured amount did not match the invoice. Staff have been notified; nothing was granted." : "Venmo declined the payment. Nothing was charged." };
  return { ok: true, state: "confirming", message: `Recorded: ${outcome.detail ?? outcome.outcome}.` };
}
