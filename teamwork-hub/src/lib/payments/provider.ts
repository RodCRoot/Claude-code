/**
 * Payment provider adapter contract.
 *
 * Rules every adapter follows:
 * - Amount and currency always come from our invoice, server-side. Never from the browser.
 * - Collection is hosted/tokenized by the provider. We never see or store card/bank numbers.
 * - Without credentials an adapter throws ProviderNotConfiguredError — it never fakes success.
 * - Only a verified webhook can move money state. Browser redirects never do.
 */

import { localYmd } from "@/lib/time";

export type ProviderName = "stripe" | "paypal" | "venmo" | "manual";

export type Evidence = "verified_docs" | "partially_verified" | "unverified" | "not_supported";

export type Capability = {
  supported: boolean | "unknown";
  evidence: Evidence;
  note: string;
  source?: string;
};

export type ProviderCapabilities = {
  label: string;
  oneTimeCheckout: Capability;
  recurring: Capability;
  savedMethods: Capability;
  bankDebit: Capability;
  refundsViaApi: Capability;
  disputesViaWebhook: Capability;
  webhookVerification: Capability;
  currencies: string[];
  regions: string;
  envVars: string[];
};

export type CheckoutLine = { description: string; amountMinor: number; quantity: number };

export type CheckoutRequest = {
  attemptId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  lines: CheckoutLine[];
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type CheckoutResult = { providerRef: string; checkoutUrl: string; status: "created" | "requires_action" };

export type RefundRequest = {
  providerTxnId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reason?: string | null;
};

export type RefundResult = { providerRefundId: string; status: "pending" | "succeeded" | "failed" };

export type VerifyResult = { ok: true } | { ok: false; reason: string; notConfigured?: boolean };

/** Provider-agnostic event after parsing a verified webhook. */
export type NormalizedEvent =
  | {
      kind: "payment";
      status: "processing" | "succeeded" | "failed" | "expired";
      attemptId: string | null;
      providerRef: string | null;
      providerTxnId: string | null;
      amountMinor: number | null;
      currency: string | null;
      methodType: string | null;
      failureCode?: string | null;
      failureMessage?: string | null;
    }
  | {
      kind: "refund";
      providerTxnId: string;
      /** Provider's refund id, or a stable synthetic id for cumulative refund totals. */
      providerRefundId: string;
      /** true when amountMinor is the charge's cumulative refunded total (Stripe charge.refunded). */
      cumulative: boolean;
      amountMinor: number;
      currency: string;
      status: "succeeded" | "pending" | "failed";
    }
  | {
      kind: "dispute";
      phase: "created" | "updated" | "closed";
      providerDisputeId: string;
      providerTxnId: string | null;
      amountMinor: number;
      currency: string;
      status: string;
      reason: string | null;
      evidenceDueBy: Date | null;
    }
  | { kind: "payout"; providerPayoutId: string; amountMinor: number; currency: string; status: string; arrivalDate: string | null }
  | {
      kind: "subscription_invoice";
      status: "paid" | "payment_failed" | "action_required";
      providerInvoiceId: string;
      providerSubscriptionId: string | null;
      providerTxnId: string | null;
      amountMinor: number;
      currency: string;
      periodStart: string | null;
      periodEnd: string | null;
      /** Our own ids echoed back by the provider (Stripe subscription metadata / PayPal custom_id). */
      hint?: SubscriptionHint | null;
      billingReason?: string | null;
    }
  | {
      kind: "subscription_status";
      providerSubscriptionId: string;
      hint: SubscriptionHint | null;
      /** null = the event only links the subscription (e.g. Checkout completion) and carries no status. */
      status: LocalSubscriptionStatus | null;
      rawStatus: string | null;
      cancelAtPeriodEnd: boolean | null;
      /** Local calendar date the provider will stop billing (cancel at period end), if scheduled. */
      cancelAt: string | null;
      currentPeriodEnd: string | null;
    }
  | { kind: "ignored"; reason: string };

/** Ids we attach to a provider subscription so its webhooks can be matched back to a membership request. */
export type SubscriptionHint = { membershipId: string; requestId: string | null };

/**
 * Provider subscription status mapped to what it means locally.
 * - pending: approval/first payment not completed yet (Stripe incomplete, PayPal APPROVAL_PENDING/APPROVED)
 * - setup_expired: never activated and will not bill (Stripe incomplete_expired) → revert to Teamwork billing
 * - paused: provider is not invoicing (Stripe paused)
 */
export type LocalSubscriptionStatus = "pending" | "trialing" | "active" | "past_due" | "paused" | "cancelled" | "setup_expired";

// ---------------------------------------------------------------------------
// Provider subscriptions (Stripe Billing / PayPal Subscriptions)
// ---------------------------------------------------------------------------

export type RecurringPlanRequest = {
  orgId: string;
  productVersionId: string;
  productName: string;
  versionNumber: number;
  amountMinor: number;
  currency: string;
  interval: "week" | "month" | "year";
  intervalCount: number;
  idempotencyKey: string;
};

export type RecurringPlan = { providerProductId: string; providerPlanId: string; created: boolean };

export type SubscriptionStartRequest = {
  membershipId: string;
  requestId: string;
  providerPlanId: string;
  description: string;
  customerEmail: string | null;
  /** First date the provider should charge (YYYY-MM-DD, facility time). Null = charge on approval. */
  firstChargeDate: string | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type SubscriptionStartResult = {
  /** Stripe Checkout Session id or PayPal subscription id. */
  providerRef: string;
  /** Hosted approval page for the payer. */
  approvalUrl: string;
  /** Known immediately for PayPal (subscription created before approval); null for Stripe Checkout. */
  providerSubscriptionId: string | null;
};

export type SubscriptionCancelResult = {
  /** Last local date covered by what the payer already paid, when the provider tells us. */
  paidThrough: string | null;
  immediate: boolean;
};

export interface SubscriptionProviderAdapter {
  name: "stripe" | "paypal";
  label: string;
  isConfigured(): boolean;
  missingEnv(): string[];
  /** Find or create the provider product + recurring price/plan for a product version at an amount. */
  ensurePlan(req: RecurringPlanRequest): Promise<RecurringPlan>;
  /** Create the hosted approval step (Stripe Checkout subscription mode / PayPal subscription approve link). */
  startSubscription(req: SubscriptionStartRequest): Promise<SubscriptionStartResult>;
  /** Stop future billing. Stripe: cancel_at_period_end. PayPal: cancel (no further cycles are billed). */
  cancelAtPeriodEnd(req: { providerSubscriptionId: string; reason: string; idempotencyKey: string }): Promise<SubscriptionCancelResult>;
}

/** Encode/decode the PayPal custom_id (max 127 chars) that carries our membership + request ids. */
export function encodeHint(h: SubscriptionHint): string {
  return h.requestId ? `${h.membershipId}.${h.requestId}` : h.membershipId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeHint(membershipId: unknown, requestId?: unknown): SubscriptionHint | null {
  if (typeof membershipId !== "string") return null;
  let m = membershipId;
  let r = typeof requestId === "string" ? requestId : null;
  if (r == null && m.includes(".")) [m, r] = m.split(".", 2) as [string, string];
  if (!UUID_RE.test(m)) return null;
  return { membershipId: m, requestId: r && UUID_RE.test(r) ? r : null };
}

/** Facility-local YYYY-MM-DD for a provider timestamp (unix seconds or ISO string). */
export function providerLocalYmd(v: unknown): string | null {
  let d: Date | null = null;
  if (typeof v === "number") d = new Date(v * 1000);
  else if (typeof v === "string" && v) d = new Date(v);
  if (!d || Number.isNaN(d.getTime())) return null;
  return localYmd(d);
}

export type ParsedWebhook = {
  providerEventId: string;
  type: string;
  createdAt: Date | null;
  payload: unknown;
  event: NormalizedEvent;
};

export interface PaymentProviderAdapter {
  name: ProviderName;
  isConfigured(): boolean;
  missingEnv(): string[];
  capabilities(): ProviderCapabilities;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(rawBody: string, headers: Headers, now?: Date): Promise<VerifyResult>;
  parseEvent(rawBody: string): ParsedWebhook;
  refund(req: RefundRequest): Promise<RefundResult>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(
    public provider: ProviderName,
    public envVars: string[],
  ) {
    super(`${provider} is not configured. Set ${envVars.join(", ")} on the server. Nothing was sent or charged.`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnsupportedError";
  }
}

/** Live-mode guard: outside APP_MODE=production we refuse live keys, so the build can never move real money. */
export function assertNotLiveOutsideProduction(provider: ProviderName, isLive: boolean) {
  if (isLive && process.env.APP_MODE !== "production") {
    throw new ProviderUnsupportedError(`${provider} live credentials are refused outside APP_MODE=production. Use sandbox/test keys.`);
  }
}

/** "12.34" → 1234 without floating point. */
export function decimalToMinor(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}

export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new Error("amount must be a non-negative integer of cents");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
