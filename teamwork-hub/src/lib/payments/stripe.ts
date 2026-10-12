import { createHmac, timingSafeEqual } from "node:crypto";
import {
  assertNotLiveOutsideProduction,
  ProviderNotConfiguredError,
  type CheckoutRequest,
  type CheckoutResult,
  type NormalizedEvent,
  type ParsedWebhook,
  type PaymentProviderAdapter,
  type ProviderCapabilities,
  type RefundRequest,
  type RefundResult,
  type VerifyResult,
} from "./provider";

/** Stripe's documented default tolerance for webhook timestamps (5 minutes). https://docs.stripe.com/webhooks */
export const STRIPE_TOLERANCE_SECONDS = 300;

const ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

/**
 * Parse `Stripe-Signature: t=…,v1=…,v1=…,v0=…`. Only v1 is honoured (v0 is a test-only
 * scheme and other schemes are ignored to prevent downgrade attacks).
 */
export function parseStripeSignatureHeader(header: string | null): { t: number | null; v1: string[] } {
  const out = { t: null as number | null, v1: [] as string[] };
  if (!header) return out;
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) out.t = Number(v);
    if (k === "v1" && /^[0-9a-f]+$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}

/** HMAC-SHA256 of `${t}.${rawBody}` with the endpoint secret, hex encoded. */
export function stripeSignature(secret: string, t: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
}

/** Build a header exactly like Stripe does — used by fixtures/tests only. */
export function signStripePayload(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${stripeSignature(secret, t, rawBody)}`;
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now: Date = new Date(),
  toleranceSeconds = STRIPE_TOLERANCE_SECONDS,
): VerifyResult {
  const { t, v1 } = parseStripeSignatureHeader(header);
  if (t == null || v1.length === 0) return { ok: false, reason: "missing or malformed Stripe-Signature header" };
  const expected = Buffer.from(stripeSignature(secret, t, rawBody), "hex");
  const match = v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!match) return { ok: false, reason: "signature mismatch" };
  const age = Math.abs(Math.floor(now.getTime() / 1000) - t);
  if (age > toleranceSeconds) return { ok: false, reason: `timestamp outside tolerance (${age}s)` };
  return { ok: true };
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const cur = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : null);
const idOf = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? str((v as Obj).id) : null);
const ymdFromUnix = (v: unknown) => (typeof v === "number" ? new Date(v * 1000).toISOString().slice(0, 10) : null);

function meta(o: Obj): Obj {
  return (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Obj;
}

/** Map a Stripe event to our provider-agnostic shape. Unknown types are explicitly ignored. */
export function normalizeStripeEvent(type: string, o: Obj): NormalizedEvent {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      if (o.mode === "subscription" && type === "checkout.session.completed") {
        // Subscription mode: money state arrives via invoice.paid; the session only links the subscription.
        return { kind: "ignored", reason: "subscription checkout completion is tracked via invoice.paid" };
      }
      const paymentStatus = str(o.payment_status);
      let status: "processing" | "succeeded" | "failed" | "expired";
      if (type === "checkout.session.async_payment_succeeded") status = "succeeded";
      else if (type === "checkout.session.async_payment_failed") status = "failed";
      else if (type === "checkout.session.expired") status = "expired";
      else if (paymentStatus === "paid") status = "succeeded";
      else if (paymentStatus === "unpaid") status = "processing"; // delayed-notification methods (e.g. ACH)
      else return { kind: "ignored", reason: `checkout.session.completed with payment_status=${paymentStatus}` };
      const types = Array.isArray(o.payment_method_types) ? (o.payment_method_types as string[]) : [];
      return {
        kind: "payment",
        status,
        attemptId: str(meta(o).attempt_id) ?? str(o.client_reference_id),
        providerRef: str(o.id),
        providerTxnId: idOf(o.payment_intent),
        amountMinor: num(o.amount_total),
        currency: cur(o.currency),
        methodType: str(meta(o).method_type) ?? (status === "processing" ? (types.includes("us_bank_account") ? "us_bank_account" : types[0] ?? null) : types.length === 1 ? types[0] : null),
      };
    }
    case "charge.refunded": {
      const pi = idOf(o.payment_intent) ?? str(o.id);
      const refunded = num(o.amount_refunded);
      if (!pi || refunded == null) return { kind: "ignored", reason: "charge.refunded without payment_intent/amount_refunded" };
      return { kind: "refund", providerTxnId: pi, providerRefundId: `${str(o.id)}:refunded:${refunded}`, cumulative: true, amountMinor: refunded, currency: cur(o.currency) ?? "USD", status: "succeeded" };
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const ev = (o.evidence_details ?? {}) as Obj;
      return {
        kind: "dispute",
        phase: type.endsWith("created") ? "created" : type.endsWith("closed") ? "closed" : "updated",
        providerDisputeId: str(o.id) ?? "unknown",
        providerTxnId: idOf(o.payment_intent) ?? idOf(o.charge),
        amountMinor: num(o.amount) ?? 0,
        currency: cur(o.currency) ?? "USD",
        status: str(o.status) ?? "unknown",
        reason: str(o.reason),
        evidenceDueBy: typeof ev.due_by === "number" ? new Date(ev.due_by * 1000) : null,
      };
    }
    case "payout.paid":
    case "payout.failed":
      return {
        kind: "payout",
        providerPayoutId: str(o.id) ?? "unknown",
        amountMinor: num(o.amount) ?? 0,
        currency: cur(o.currency) ?? "USD",
        status: str(o.status) ?? (type === "payout.paid" ? "paid" : "failed"),
        arrivalDate: ymdFromUnix(o.arrival_date),
      };
    case "invoice.paid":
    case "invoice.payment_failed": {
      const lines = ((o.lines as Obj | undefined)?.data ?? []) as Obj[];
      const period = (lines[0]?.period ?? {}) as Obj;
      const parent = (o.parent ?? {}) as Obj;
      const subDetails = (parent.subscription_details ?? {}) as Obj;
      return {
        kind: "subscription_invoice",
        status: type === "invoice.paid" ? "paid" : "payment_failed",
        providerInvoiceId: str(o.id) ?? "unknown",
        providerSubscriptionId: idOf(o.subscription) ?? idOf(subDetails.subscription),
        providerTxnId: idOf(o.payment_intent) ?? str(o.id),
        amountMinor: num(type === "invoice.paid" ? o.amount_paid : o.amount_due) ?? 0,
        currency: cur(o.currency) ?? "USD",
        periodStart: ymdFromUnix(period.start),
        periodEnd: ymdFromUnix(period.end),
      };
    }
    default:
      return { kind: "ignored", reason: `unhandled event type ${type}` };
  }
}

function form(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.append(k, String(v));
  return u.toString();
}

export const stripeAdapter: PaymentProviderAdapter = {
  name: "stripe",
  isConfigured: () => ENV.every((n) => !!process.env[n]),
  missingEnv: () => ENV.filter((n) => !process.env[n]),
  capabilities: stripeCapabilities,

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || !process.env.STRIPE_WEBHOOK_SECRET) throw new ProviderNotConfiguredError("stripe", this.missingEnv());
    assertNotLiveOutsideProduction("stripe", key.startsWith("sk_live_") || key.startsWith("rk_live_"));
    // One line for the exact invoice total (discounts already applied server-side).
    const body = form({
      mode: "payment",
      client_reference_id: req.attemptId,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      customer_email: req.customerEmail ?? undefined,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": req.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": req.amountMinor,
      "line_items[0][price_data][product_data][name]": `Invoice ${req.invoiceNumber}`,
      "metadata[attempt_id]": req.attemptId,
      "metadata[invoice_id]": req.invoiceId,
      "payment_intent_data[metadata][attempt_id]": req.attemptId,
      "payment_intent_data[metadata][invoice_id]": req.invoiceId,
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": req.idempotencyKey },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) throw new Error(`Stripe checkout failed (${res.status}): ${str((json.error as Obj | undefined)?.message) ?? "unknown error"}`);
    return { providerRef: String(json.id), checkoutUrl: String(json.url), status: "created" };
  },

  async verifyWebhook(rawBody, headers, now) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: "STRIPE_WEBHOOK_SECRET not configured", notConfigured: true };
    return verifyStripeSignature(rawBody, headers.get("stripe-signature"), secret, now);
  },

  parseEvent(rawBody: string): ParsedWebhook {
    const payload = JSON.parse(rawBody) as Obj;
    const type = String(payload.type ?? "unknown");
    const obj = ((payload.data as Obj | undefined)?.object ?? {}) as Obj;
    return {
      providerEventId: String(payload.id ?? ""),
      type,
      createdAt: typeof payload.created === "number" ? new Date(payload.created * 1000) : null,
      payload,
      event: normalizeStripeEvent(type, obj),
    };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ProviderNotConfiguredError("stripe", ["STRIPE_SECRET_KEY"]);
    assertNotLiveOutsideProduction("stripe", key.startsWith("sk_live_") || key.startsWith("rk_live_"));
    const res = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": req.idempotencyKey },
      body: form({ payment_intent: req.providerTxnId, amount: req.amountMinor, "metadata[reason]": req.reason ?? undefined }),
    });
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) throw new Error(`Stripe refund failed (${res.status}): ${str((json.error as Obj | undefined)?.message) ?? "unknown error"}`);
    const st = str(json.status);
    return { providerRefundId: String(json.id), status: st === "succeeded" ? "succeeded" : st === "failed" ? "failed" : "pending" };
  },
};

export function stripeCapabilities(): ProviderCapabilities {
  return {
    label: "Stripe",
    oneTimeCheckout: { supported: true, evidence: "verified_docs", note: "Checkout Sessions (mode=payment), hosted page; fulfilment must be webhook-driven.", source: "https://docs.stripe.com/checkout/fulfillment" },
    recurring: { supported: true, evidence: "verified_docs", note: "Stripe Billing subscriptions (card or ACH Direct Debit); invoice.paid / invoice.payment_failed drive state.", source: "https://docs.stripe.com/billing/subscriptions/overview" },
    savedMethods: { supported: true, evidence: "verified_docs", note: "Customer + PaymentMethod tokens; we store references only.", source: "https://docs.stripe.com/payments/ach-direct-debit" },
    bankDebit: { supported: true, evidence: "verified_docs", note: "ACH Direct Debit: delayed notification, up to 4 business days; can fail after initial success (arrives as a dispute). Disputes up to 60 days.", source: "https://docs.stripe.com/payments/ach-direct-debit" },
    refundsViaApi: { supported: true, evidence: "verified_docs", note: "Refunds API with Idempotency-Key (keys ≥24h old may be pruned). ACH: full refunds only, async up to 3 business days.", source: "https://docs.stripe.com/api/idempotent_requests" },
    disputesViaWebhook: { supported: true, evidence: "verified_docs", note: "charge.dispute.created / closed.", source: "https://docs.stripe.com/payments/ach-direct-debit" },
    webhookVerification: { supported: true, evidence: "verified_docs", note: "Stripe-Signature t=…,v1=…; HMAC-SHA256 of `${t}.${rawBody}`; constant-time compare; 5-minute default tolerance. Implemented locally with node:crypto.", source: "https://docs.stripe.com/webhooks" },
    currencies: ["USD"],
    regions: "US account; ACH customers must be in the US (USD).",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY"],
  };
}
