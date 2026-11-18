import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { invoiceLines, invoices, memberships, paymentAttempts, payerAccounts } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { getProvider, ONLINE_PROVIDERS, ProviderNotConfiguredError, ProviderUnsupportedError, type ProviderName } from "@/lib/payments";
import { assertCanPayPayer, loadInvoiceForViewer } from "./access";
import { invoiceMoney } from "./invoices";
import { actorOf } from "./util";

export type CheckoutOutcome =
  | { ok: true; checkoutUrl: string; attemptId: string; reused: boolean }
  | { ok: false; error: string; notConfigured?: { provider: ProviderName; envVars: string[] } };

/**
 * Server-side checkout creation. Amount/currency come from the invoice balance (never the client),
 * collection is hosted by the provider, and the provider call carries our idempotency key.
 * Without credentials we return an honest error and create nothing.
 */
export async function startCheckout(db: DB, v: Viewer, input: { invoiceId: string; provider: ProviderName; appUrl: string }): Promise<CheckoutOutcome> {
  if (!ONLINE_PROVIDERS.includes(input.provider)) return { ok: false, error: "Choose Stripe, PayPal or Venmo for online payment." };
  const adapter = getProvider(input.provider);
  const prep = await db.transaction(async (tx) => {
    const inv = await loadInvoiceForViewer(tx, v, input.invoiceId);
    await assertCanPayPayer(tx, v, inv.payerAccountId);
    if (inv.status !== "open") throw new UserError(`This invoice is ${inv.status}; nothing to pay.`);
    if (inv.membershipId) {
      const [m] = await tx.select({ bp: memberships.billingProvider }).from(memberships).where(eq(memberships.id, inv.membershipId));
      if (m?.bp === "external_zenplanner") throw new UserError("This membership is billed by Zen Planner until cutover.");
    }
    const money = await invoiceMoney(tx, inv.id);
    if (money.pendingMinor > 0) throw new UserError("A payment for this invoice is still processing. We'll update it when the provider confirms.");
    if (money.balanceMinor <= 0) throw new UserError("Nothing is due on this invoice.");
    if (!adapter.isConfigured()) return { notConfigured: true as const, inv };
    // Reuse a still-open attempt for the same amount (double-click / back button) instead of creating another.
    const [open] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.invoiceId, inv.id),
          eq(paymentAttempts.provider, input.provider),
          eq(paymentAttempts.amountMinor, money.balanceMinor),
          inArray(paymentAttempts.status, ["created", "requires_action"]),
          gt(paymentAttempts.createdAt, new Date(Date.now() - 20 * 3_600_000)),
        ),
      )
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(1);
    if (open?.checkoutUrl) return { reuse: open, inv };
    const id = randomUUID();
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        id,
        orgId: inv.orgId,
        invoiceId: inv.id,
        provider: input.provider,
        amountMinor: money.balanceMinor,
        currency: inv.currency,
        status: "created",
        idempotencyKey: `checkout:${id}`,
        createdBy: v.userId,
      })
      .returning();
    const [payer] = await tx.select({ email: payerAccounts.billingEmail }).from(payerAccounts).where(eq(payerAccounts.id, inv.payerAccountId));
    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    await audit(tx, actorOf(v), "billing.checkout.create", "payment_attempt", attempt.id, { summary: `${input.provider} checkout for ${inv.number} (${money.balanceMinor} ${inv.currency})` });
    return { attempt, inv, email: payer?.email ?? null, lines };
  });

  if ("notConfigured" in prep) {
    return {
      ok: false,
      error: `${adapter.capabilities().label} is not configured, so online payment is unavailable. Nothing was charged. Staff can still record an offline payment.`,
      notConfigured: { provider: input.provider, envVars: adapter.missingEnv() },
    };
  }
  if ("reuse" in prep && prep.reuse) return { ok: true, checkoutUrl: prep.reuse.checkoutUrl!, attemptId: prep.reuse.id, reused: true };
  const { attempt, inv } = prep as { attempt: typeof paymentAttempts.$inferSelect; inv: typeof invoices.$inferSelect; email: string | null; lines: unknown[] };
  try {
    const res = await adapter.createCheckout({
      attemptId: attempt.id,
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      lines: [{ description: `Invoice ${inv.number}`, amountMinor: attempt.amountMinor, quantity: 1 }],
      customerEmail: (prep as { email: string | null }).email,
      successUrl: `${input.appUrl}/api/payments/return?attempt=${attempt.id}`,
      cancelUrl: `${input.appUrl}/billing/invoices/${inv.id}?checkout=cancelled`,
      idempotencyKey: attempt.idempotencyKey,
    });
    await db
      .update(paymentAttempts)
      .set({ providerRef: res.providerRef, checkoutUrl: res.checkoutUrl, status: res.status, updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "created")));
    return { ok: true, checkoutUrl: res.checkoutUrl, attemptId: attempt.id, reused: false };
  } catch (e) {
    await db
      .update(paymentAttempts)
      .set({ status: "failed", failureCode: e instanceof ProviderUnsupportedError ? "unsupported" : "checkout_error", failureMessage: (e as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt.id));
    if (e instanceof ProviderNotConfiguredError) return { ok: false, error: e.message, notConfigured: { provider: e.provider, envVars: e.envVars } };
    if (e instanceof ProviderUnsupportedError) return { ok: false, error: e.message };
    return { ok: false, error: "The payment provider did not accept the request. Nothing was charged; please try again or contact the front desk." };
  }
}

export type ReturnView = {
  invoiceId: string;
  attemptId: string;
  provider: ProviderName;
  /** "confirming" until a verified webhook moves the attempt; the redirect itself changes nothing. */
  state: "confirming" | "paid" | "pending_bank" | "failed";
};

/**
 * Browser return from a hosted checkout. READ-ONLY by design: query parameters are attacker-controlled,
 * so this never marks anything paid. It only reports what verified webhooks have already recorded.
 */
export async function checkoutReturnView(tx: Tx, v: Viewer, attemptId: string): Promise<ReturnView> {
  const [a] = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.orgId, v.orgId)));
  if (!a) throw new UserError("Payment not found.");
  const inv = await loadInvoiceForViewer(tx, v, a.invoiceId);
  const state: ReturnView["state"] =
    inv.status === "paid" ? "paid" : a.status === "processing" || a.status === "pending" ? "pending_bank" : a.status === "failed" || a.status === "expired" ? "failed" : "confirming";
  return { invoiceId: inv.id, attemptId: a.id, provider: a.provider, state };
}
