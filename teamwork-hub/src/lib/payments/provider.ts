/**
 * Payment provider adapter contract.
 *
 * Rules every adapter follows:
 * - Amount and currency always come from our invoice, server-side. Never from the browser.
 * - Collection is hosted/tokenized by the provider. We never see or store card/bank numbers.
 * - Without credentials an adapter throws ProviderNotConfiguredError — it never fakes success.
 * - Only a verified webhook can move money state. Browser redirects never do.
 */

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
      status: "paid" | "payment_failed";
      providerInvoiceId: string;
      providerSubscriptionId: string | null;
      providerTxnId: string | null;
      amountMinor: number;
      currency: string;
      periodStart: string | null;
      periodEnd: string | null;
    }
  | { kind: "ignored"; reason: string };

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
