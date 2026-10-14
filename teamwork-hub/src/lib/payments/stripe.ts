import { createHmac, timingSafeEqual } from "node:crypto";
import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import {
  assertNotLiveOutsideProduction,
  decodeHint,
  providerLocalYmd,
  ProviderNotConfiguredError,
  type CheckoutRequest,
  type CheckoutResult,
  type LocalSubscriptionStatus,
  type NormalizedEvent,
  type ParsedWebhook,
  type PaymentProviderAdapter,
  type ProviderCapabilities,
  type RecurringPlan,
  type RecurringPlanRequest,
  type RefundRequest,
  type RefundResult,
  type SubscriptionCancelResult,
  type SubscriptionProviderAdapter,
  type SubscriptionStartRequest,
  type SubscriptionStartResult,
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
      if (o.mode === "subscription") {
        // Subscription mode: money state arrives via invoice.paid; the completed session only links the subscription.
        const subId = idOf(o.subscription);
        if (type !== "checkout.session.completed" || !subId) return { kind: "ignored", reason: `subscription-mode ${type} carries no money state` };
        return {
          kind: "subscription_status",
          providerSubscriptionId: subId,
          hint: decodeHint(meta(o).membership_id ?? o.client_reference_id, meta(o).request_id),
          status: null,
          rawStatus: null,
          cancelAtPeriodEnd: null,
          cancelAt: null,
          currentPeriodEnd: null,
        };
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
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const lines = ((o.lines as Obj | undefined)?.data ?? []) as Obj[];
      // Prefer the subscription item line (prorations are listed first); fall back to the first line.
      const subLine = lines.find((l) => ((l.parent ?? {}) as Obj).type === "subscription_item_details") ?? lines[0];
      const period = (subLine?.period ?? {}) as Obj;
      const parent = (o.parent ?? {}) as Obj;
      const subDetails = (parent.subscription_details ?? {}) as Obj;
      const subMeta = (subDetails.metadata ?? {}) as Obj;
      // Line periods are [start, end) instants; the local service period ends the day before `end`.
      const endYmd = providerLocalYmd(period.end);
      return {
        kind: "subscription_invoice",
        status: type === "invoice.paid" ? "paid" : type === "invoice.payment_failed" ? "payment_failed" : "action_required",
        providerInvoiceId: str(o.id) ?? "unknown",
        // `invoice.subscription` / `invoice.payment_intent` exist only on API versions before 2025-03-31.basil.
        providerSubscriptionId: idOf(subDetails.subscription) ?? idOf(o.subscription),
        providerTxnId: idOf(o.payment_intent) ?? str(o.id),
        amountMinor: num(type === "invoice.paid" ? o.amount_paid : o.amount_due) ?? 0,
        currency: cur(o.currency) ?? "USD",
        periodStart: providerLocalYmd(period.start),
        periodEnd: endYmd ? addDaysYmd(endYmd, -1) : null,
        hint: decodeHint(subMeta.membership_id, subMeta.request_id),
        billingReason: str(o.billing_reason),
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const items = ((o.items as Obj | undefined)?.data ?? []) as Obj[];
      const periodEnd = providerLocalYmd(items[0]?.current_period_end ?? o.current_period_end);
      const raw = str(o.status);
      const cancelAtPeriodEnd = typeof o.cancel_at_period_end === "boolean" ? o.cancel_at_period_end : null;
      const cancelAt = providerLocalYmd(o.cancel_at) ?? (cancelAtPeriodEnd && periodEnd ? periodEnd : null);
      return {
        kind: "subscription_status",
        providerSubscriptionId: str(o.id) ?? "unknown",
        hint: decodeHint(meta(o).membership_id, meta(o).request_id),
        status: type === "customer.subscription.deleted" ? "cancelled" : mapStripeSubscriptionStatus(raw),
        rawStatus: raw,
        cancelAtPeriodEnd,
        // Same meaning as memberships.cancel_at: the first local day no longer covered.
        cancelAt,
        currentPeriodEnd: periodEnd ? addDaysYmd(periodEnd, -1) : null,
      };
    }
    default:
      return { kind: "ignored", reason: `unhandled event type ${type}` };
  }
}

/** https://docs.stripe.com/api/subscriptions/object (status enum) → local meaning. */
export function mapStripeSubscriptionStatus(raw: string | null): LocalSubscriptionStatus | null {
  switch (raw) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "incomplete":
      return "pending";
    case "incomplete_expired":
      return "setup_expired";
    case "paused":
      return "paused";
    default:
      return null;
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
    recurring: { supported: true, evidence: "verified_docs", note: "Stripe Billing: recurring Price per product version (lookup_key), Checkout Session mode=subscription with subscription_data.metadata + billing_cycle_anchor; invoice.paid / invoice.payment_failed / customer.subscription.* drive local state. Contract-tested with signed fixtures only; never exercised against a sandbox.", source: "https://docs.stripe.com/billing/subscriptions/webhooks" },
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

// ---------------------------------------------------------------------------
// Stripe Billing subscriptions (Checkout Session in subscription mode)
// ---------------------------------------------------------------------------

function stripeSecret(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !process.env.STRIPE_WEBHOOK_SECRET) throw new ProviderNotConfiguredError("stripe", ENV.filter((n) => !process.env[n]));
  assertNotLiveOutsideProduction("stripe", key.startsWith("sk_live_") || key.startsWith("rk_live_"));
  return key;
}

async function stripeCall(method: "GET" | "POST", path: string, params: Record<string, string | number | undefined | null>, idempotencyKey?: string): Promise<Obj> {
  const key = stripeSecret();
  const body = form(params);
  const url = method === "GET" ? `https://api.stripe.com${path}${body ? `?${body}` : ""}` : `https://api.stripe.com${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  }
  const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${str((json.error as Obj | undefined)?.message) ?? "unknown error"}`);
  return json;
}

/**
 * Deterministic lookup key for the recurring price of one immutable product version at one net amount.
 * https://docs.stripe.com/api/prices/create (lookup_key ≤ 200 chars) and /api/prices/list (lookup_keys filter).
 */
export function stripeLookupKey(req: Pick<RecurringPlanRequest, "orgId" | "productVersionId" | "amountMinor" | "currency">) {
  return `twhub:${req.orgId}:${req.productVersionId}:${req.amountMinor}:${req.currency.toLowerCase()}`;
}

/** Unix seconds for local midnight of a facility date (Stripe timestamps are UTC instants). */
export function unixAtLocalMidnight(ymd: string): number {
  return Math.floor(localToUtc(ymd, "00:00").getTime() / 1000);
}

export const stripeSubscriptions: SubscriptionProviderAdapter = {
  name: "stripe",
  label: "Stripe subscription",
  isConfigured: () => ENV.every((n) => !!process.env[n]),
  missingEnv: () => ENV.filter((n) => !process.env[n]),

  async ensurePlan(req: RecurringPlanRequest): Promise<RecurringPlan> {
    const lookupKey = stripeLookupKey(req);
    const found = await stripeCall("GET", "/v1/prices", { "lookup_keys[0]": lookupKey, limit: 1 });
    const existing = Array.isArray(found.data) ? (found.data as Obj[])[0] : undefined;
    if (existing && str(existing.id)) {
      if (num(existing.unit_amount) !== req.amountMinor || cur(existing.currency) !== req.currency.toUpperCase()) {
        throw new Error(`Stripe price ${String(existing.id)} for ${lookupKey} does not match ${req.amountMinor} ${req.currency}; refusing to reuse it.`);
      }
      return { providerProductId: idOf(existing.product) ?? "", providerPlanId: String(existing.id), created: false };
    }
    const price = await stripeCall(
      "POST",
      "/v1/prices",
      {
        currency: req.currency.toLowerCase(),
        unit_amount: req.amountMinor,
        "recurring[interval]": req.interval,
        "recurring[interval_count]": req.intervalCount,
        lookup_key: lookupKey,
        "product_data[name]": `${req.productName} (v${req.versionNumber})`,
        "metadata[product_version_id]": req.productVersionId,
        "metadata[org_id]": req.orgId,
      },
      req.idempotencyKey,
    );
    return { providerProductId: idOf(price.product) ?? "", providerPlanId: String(price.id), created: true };
  },

  async startSubscription(req: SubscriptionStartRequest): Promise<SubscriptionStartResult> {
    // A future billing_cycle_anchor with proration_behavior=none defers the first charge to the date
    // Teamwork would otherwise have billed next (https://docs.stripe.com/api/checkout/sessions/create, subscription_data).
    const anchor = req.firstChargeDate && req.firstChargeDate > todayLocal() ? unixAtLocalMidnight(req.firstChargeDate) : null;
    const session = await stripeCall(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        "line_items[0][price]": req.providerPlanId,
        "line_items[0][quantity]": 1,
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        customer_email: req.customerEmail ?? undefined,
        client_reference_id: req.membershipId,
        "metadata[membership_id]": req.membershipId,
        "metadata[request_id]": req.requestId,
        "subscription_data[metadata][membership_id]": req.membershipId,
        "subscription_data[metadata][request_id]": req.requestId,
        "subscription_data[description]": req.description.slice(0, 500),
        "subscription_data[billing_cycle_anchor]": anchor ?? undefined,
        "subscription_data[proration_behavior]": anchor ? "none" : undefined,
      },
      req.idempotencyKey,
    );
    if (!str(session.url)) throw new Error("Stripe did not return a Checkout URL");
    return { providerRef: String(session.id), approvalUrl: String(session.url), providerSubscriptionId: idOf(session.subscription) };
  },

  async cancelAtPeriodEnd(req): Promise<SubscriptionCancelResult> {
    const sub = await stripeCall(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(req.providerSubscriptionId)}`,
      { cancel_at_period_end: "true", "metadata[teamwork_cancel_reason]": req.reason.slice(0, 500) },
      req.idempotencyKey,
    );
    const items = ((sub.items as Obj | undefined)?.data ?? []) as Obj[];
    const end = providerLocalYmd(items[0]?.current_period_end ?? sub.current_period_end);
    return { paidThrough: end ? addDaysYmd(end, -1) : null, immediate: false };
  },
};
