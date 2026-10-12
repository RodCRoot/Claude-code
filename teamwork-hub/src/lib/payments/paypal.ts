import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import {
  assertNotLiveOutsideProduction,
  decimalToMinor,
  decodeHint,
  encodeHint,
  minorToDecimal,
  providerLocalYmd,
  ProviderNotConfiguredError,
  ProviderUnsupportedError,
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

const ENV = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"];

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function paypalBase() {
  return process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function configured() {
  return ENV.every((n) => !!process.env[n]);
}

async function accessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new ProviderNotConfiguredError("paypal", ENV.filter((n) => !process.env[n]));
  assertNotLiveOutsideProduction("paypal", process.env.PAYPAL_ENV === "live");
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok || !str(json.access_token)) throw new Error(`PayPal auth failed (${res.status})`);
  return String(json.access_token);
}

/**
 * PayPal webhook verification via the documented postback API
 * (POST /v1/notifications/verify-webhook-signature). The webhook_event is spliced in
 * as the exact raw body because PayPal requires it "posted back exactly as it was received".
 */
async function verifyViaApi(rawBody: string, headers: Headers): Promise<VerifyResult> {
  if (!configured()) return { ok: false, reason: "PayPal verification API not configured (PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID)", notConfigured: true };
  const h = (n: string) => headers.get(n) ?? "";
  if (!h("paypal-transmission-id") || !h("paypal-transmission-sig")) return { ok: false, reason: "missing PayPal transmission headers" };
  const token = await accessToken();
  const body =
    `{"transmission_id":${JSON.stringify(h("paypal-transmission-id"))},"transmission_time":${JSON.stringify(h("paypal-transmission-time"))},` +
    `"cert_url":${JSON.stringify(h("paypal-cert-url"))},"auth_algo":${JSON.stringify(h("paypal-auth-algo"))},` +
    `"transmission_sig":${JSON.stringify(h("paypal-transmission-sig"))},"webhook_id":${JSON.stringify(process.env.PAYPAL_WEBHOOK_ID)},"webhook_event":${rawBody}}`;
  const res = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) return { ok: false, reason: `verify API error ${res.status}` };
  return json.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: `verification_status=${String(json.verification_status)}` };
}

function amountOf(r: Obj) {
  const a = (r.amount ?? {}) as Obj;
  return { amountMinor: decimalToMinor(a.value as string), currency: str(a.currency_code)?.toUpperCase() ?? null };
}

function upLinkId(r: Obj): string | null {
  const links = Array.isArray(r.links) ? (r.links as Obj[]) : [];
  const up = links.find((l) => l.rel === "up");
  const href = str(up?.href);
  return href ? href.split("/").filter(Boolean).pop() ?? null : null;
}

export function normalizePaypalEvent(type: string, r: Obj): NormalizedEvent {
  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      const { amountMinor, currency } = amountOf(r);
      const related = ((r.supplementary_data as Obj | undefined)?.related_ids ?? {}) as Obj;
      const status = type.endsWith("COMPLETED") ? "succeeded" : type.endsWith("PENDING") ? "processing" : "failed";
      const sd = (r.status_details ?? {}) as Obj;
      return {
        kind: "payment",
        status,
        attemptId: str(r.custom_id),
        providerRef: str(related.order_id),
        providerTxnId: str(r.id),
        amountMinor,
        currency,
        methodType: status === "processing" && sd.reason === "ECHECK" ? "echeck" : null,
        failureCode: str(sd.reason),
      };
    }
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      const { amountMinor, currency } = amountOf(r);
      const captureId = upLinkId(r);
      if (!captureId || amountMinor == null) return { kind: "ignored", reason: "refund without capture link/amount" };
      return { kind: "refund", providerTxnId: captureId, providerRefundId: str(r.id) ?? `${captureId}:${amountMinor}`, cumulative: false, amountMinor, currency: currency ?? "USD", status: "succeeded" };
    }
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED":
    case "CUSTOMER.DISPUTE.RESOLVED": {
      const amt = (r.dispute_amount ?? {}) as Obj;
      const txns = Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as Obj[]) : [];
      return {
        kind: "dispute",
        phase: type.endsWith("CREATED") ? "created" : type.endsWith("RESOLVED") ? "closed" : "updated",
        providerDisputeId: str(r.dispute_id) ?? "unknown",
        providerTxnId: str(txns[0]?.seller_transaction_id),
        amountMinor: decimalToMinor(amt.value as string) ?? 0,
        currency: str(amt.currency_code)?.toUpperCase() ?? "USD",
        status: str(r.status) ?? (str((r.dispute_outcome as Obj | undefined)?.outcome_code) ?? "unknown"),
        reason: str(r.reason),
        evidenceDueBy: str(r.seller_response_due_date) ? new Date(String(r.seller_response_due_date)) : null,
      };
    }
    case "BILLING.SUBSCRIPTION.CREATED":
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED": {
      const id = str(r.id);
      if (!id) return { kind: "ignored", reason: `${type} without subscription id` };
      const raw = str(r.status);
      const billing = (r.billing_info ?? {}) as Obj;
      const next = providerLocalYmd(billing.next_billing_time);
      const status = type.endsWith("CANCELLED") || type.endsWith("EXPIRED") ? "cancelled" : mapPaypalSubscriptionStatus(raw);
      return {
        kind: "subscription_status",
        providerSubscriptionId: id,
        hint: decodeHint(r.custom_id),
        status,
        rawStatus: raw,
        cancelAtPeriodEnd: null,
        cancelAt: null,
        currentPeriodEnd: next ? addDaysYmd(next, -1) : null,
      };
    }
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const id = str(r.id);
      if (!id) return { kind: "ignored", reason: "payment failure without subscription id" };
      const billing = (r.billing_info ?? {}) as Obj;
      const failed = (billing.last_failed_payment ?? {}) as Obj;
      const amt = (failed.amount ?? billing.outstanding_balance ?? {}) as Obj;
      return {
        kind: "subscription_invoice",
        status: "payment_failed",
        providerInvoiceId: `${id}:failed:${str(failed.time) ?? str(r.update_time) ?? "unknown"}`,
        providerSubscriptionId: id,
        providerTxnId: null,
        amountMinor: decimalToMinor(amt.value as string) ?? 0,
        currency: str(amt.currency_code)?.toUpperCase() ?? "USD",
        periodStart: null,
        periodEnd: null,
        hint: decodeHint(r.custom_id),
      };
    }
    case "PAYMENT.SALE.COMPLETED": {
      // Sale resource (v1 payments) field names are not in the current OpenAPI schemas we checked;
      // shape follows PayPal's published sample events and must be confirmed against sandbox deliveries.
      const amt = (r.amount ?? {}) as Obj;
      const saleId = str(r.id);
      const subId = str(r.billing_agreement_id);
      if (!saleId || !subId) return { kind: "ignored", reason: "sale not linked to a subscription" };
      const amountMinor = decimalToMinor((amt.total ?? amt.value) as string);
      if (amountMinor == null) return { kind: "ignored", reason: "sale without parseable amount" };
      return {
        kind: "subscription_invoice",
        status: "paid",
        providerInvoiceId: saleId,
        providerSubscriptionId: subId,
        providerTxnId: saleId,
        amountMinor,
        currency: (str(amt.currency) ?? str(amt.currency_code) ?? "USD").toUpperCase(),
        periodStart: null,
        periodEnd: null,
        hint: decodeHint(r.custom),
      };
    }
    default:
      return { kind: "ignored", reason: `unhandled event type ${type}` };
  }
}

/** Subscription status enum from the Subscriptions v1 OpenAPI schema (subscription_status.status). */
export function mapPaypalSubscriptionStatus(raw: string | null): LocalSubscriptionStatus | null {
  switch (raw) {
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "pending";
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
    case "EXPIRED":
      return "cancelled";
    default:
      return null;
  }
}

function parse(rawBody: string): ParsedWebhook {
  const payload = JSON.parse(rawBody) as Obj;
  const type = String(payload.event_type ?? "unknown");
  return {
    providerEventId: String(payload.id ?? ""),
    type,
    createdAt: str(payload.create_time) ? new Date(String(payload.create_time)) : null,
    payload,
    event: normalizePaypalEvent(type, (payload.resource ?? {}) as Obj),
  };
}

async function createOrder(req: CheckoutRequest, fundingSource: "paypal" | "venmo"): Promise<CheckoutResult> {
  if (!configured()) throw new ProviderNotConfiguredError(fundingSource === "venmo" ? "venmo" : "paypal", ENV.filter((n) => !process.env[n]));
  const token = await accessToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": req.idempotencyKey },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        { custom_id: req.attemptId, invoice_id: req.invoiceNumber, amount: { currency_code: req.currency, value: minorToDecimal(req.amountMinor) } },
      ],
      payment_source: { paypal: { experience_context: { return_url: req.successUrl, cancel_url: req.cancelUrl, user_action: "PAY_NOW" } } },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) throw new Error(`PayPal order failed (${res.status})`);
  const links = Array.isArray(json.links) ? (json.links as Obj[]) : [];
  const approve = links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return { providerRef: String(json.id), checkoutUrl: String(approve?.href ?? ""), status: "requires_action" };
}

/**
 * Called from the return URL after the buyer approves. Capturing asks PayPal to move money;
 * our records still change only when the verified PAYMENT.CAPTURE.* webhook arrives.
 */
export async function capturePaypalOrder(orderId: string, idempotencyKey: string): Promise<{ status: string }> {
  const r = await capturePaypalOrderDetailed(orderId, idempotencyKey);
  return { status: r.orderStatus };
}

export type CaptureOutcome = {
  httpStatus: number;
  orderStatus: string;
  /** Normalized from purchase_units[0].payments.captures[0] of the server-to-server capture response. */
  payment: Extract<NormalizedEvent, { kind: "payment" }> | null;
};

/**
 * Server-side capture (Orders v2 `POST /v2/checkout/orders/{id}/capture`, PayPal-Request-Id for idempotency).
 * The response comes from PayPal over our authenticated API call, so its capture status can be applied
 * through the same idempotent settlement path as a verified webhook. The browser never reports payment.
 */
export async function capturePaypalOrderDetailed(orderId: string, idempotencyKey: string): Promise<CaptureOutcome> {
  if (!configured()) throw new ProviderNotConfiguredError("paypal", ENV.filter((n) => !process.env[n]));
  const token = await accessToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": idempotencyKey },
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  const units = Array.isArray(json.purchase_units) ? (json.purchase_units as Obj[]) : [];
  const captures = (((units[0]?.payments ?? {}) as Obj).captures ?? []) as Obj[];
  const c = captures[0];
  let payment: CaptureOutcome["payment"] = null;
  if (res.ok && c && str(c.id)) {
    const st = str(c.status);
    const type = st === "COMPLETED" ? "PAYMENT.CAPTURE.COMPLETED" : st === "PENDING" ? "PAYMENT.CAPTURE.PENDING" : st === "DECLINED" || st === "FAILED" ? "PAYMENT.CAPTURE.DECLINED" : null;
    if (type) {
      const ev = normalizePaypalEvent(type, { ...c, custom_id: c.custom_id ?? units[0]?.custom_id, supplementary_data: { related_ids: { order_id: str(json.id) ?? orderId } } });
      if (ev.kind === "payment") payment = { ...ev, methodType: ev.methodType ?? fundingSourceOf(json) };
    }
  }
  return { httpStatus: res.status, orderStatus: str(json.status) ?? `http_${res.status}`, payment };
}

function fundingSourceOf(order: Obj): string | null {
  const ps = (order.payment_source ?? {}) as Obj;
  const k = Object.keys(ps)[0];
  return k ?? null;
}

/**
 * Create an order for the PayPal JS SDK button (Venmo funding source). No `payment_source` is sent:
 * the SDK button collects the buyer's approval; we only return the order id to the SDK.
 */
export async function createSdkOrder(req: Omit<CheckoutRequest, "successUrl" | "cancelUrl">): Promise<{ orderId: string; status: string }> {
  if (!configured()) throw new ProviderNotConfiguredError("venmo", ENV.filter((n) => !process.env[n]));
  if (req.currency.toUpperCase() !== "USD") throw new ProviderUnsupportedError("Venmo is available for USD payments only.");
  const token = await accessToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": req.idempotencyKey },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ custom_id: req.attemptId, invoice_id: req.invoiceNumber, amount: { currency_code: "USD", value: minorToDecimal(req.amountMinor) } }],
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok || !str(json.id)) throw new Error(`PayPal order failed (${res.status})`);
  return { orderId: String(json.id), status: str(json.status) ?? "CREATED" };
}

async function refundCapture(req: RefundRequest, name: "paypal" | "venmo"): Promise<RefundResult> {
  if (!configured()) throw new ProviderNotConfiguredError(name, ENV.filter((n) => !process.env[n]));
  const token = await accessToken();
  const res = await fetch(`${paypalBase()}/v2/payments/captures/${encodeURIComponent(req.providerTxnId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": req.idempotencyKey },
    body: JSON.stringify({ amount: { value: minorToDecimal(req.amountMinor), currency_code: req.currency }, note_to_payer: req.reason ?? undefined }),
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) throw new Error(`PayPal refund failed (${res.status})`);
  return { providerRefundId: String(json.id), status: json.status === "COMPLETED" ? "succeeded" : json.status === "CANCELLED" || json.status === "FAILED" ? "failed" : "pending" };
}

export const paypalAdapter: PaymentProviderAdapter = {
  name: "paypal",
  isConfigured: configured,
  missingEnv: () => ENV.filter((n) => !process.env[n]),
  capabilities: paypalCapabilities,
  createCheckout: (req) => createOrder(req, "paypal"),
  verifyWebhook: (raw, headers) => verifyViaApi(raw, headers),
  parseEvent: parse,
  refund: (req) => refundCapture(req, "paypal"),
};

/**
 * Venmo is a PayPal Checkout funding source. Its webhooks/refunds are PayPal's. Checkout must be rendered
 * with the PayPal JavaScript SDK Venmo button (documented requirement), so there is no redirect checkout:
 * the invoice's "Pay with Venmo" page (`/billing/invoices/[id]/venmo`) renders the SDK button, creates the
 * order server-side (`createSdkOrder`) and captures server-side (`capturePaypalOrderDetailed`).
 */
export const venmoAdapter: PaymentProviderAdapter = {
  name: "venmo",
  isConfigured: configured,
  missingEnv: () => ENV.filter((n) => !process.env[n]),
  capabilities: venmoCapabilities,
  async createCheckout() {
    if (!configured()) throw new ProviderNotConfiguredError("venmo", ENV.filter((n) => !process.env[n]));
    throw new ProviderUnsupportedError(
      "Venmo has no redirect checkout. Open the invoice's “Pay with Venmo” page, which uses the PayPal JavaScript SDK Venmo button (US buyers, USD, Venmo app).",
    );
  },
  verifyWebhook: (raw, headers) => verifyViaApi(raw, headers),
  parseEvent: parse,
  refund: (req) => refundCapture(req, "venmo"),
};

export function paypalCapabilities(): ProviderCapabilities {
  return {
    label: "PayPal",
    oneTimeCheckout: { supported: true, evidence: "partially_verified", note: "Orders v2: POST /v2/checkout/orders (intent CAPTURE), capture via /orders/{id}/capture; PayPal-Request-Id header for idempotency (schema). Retention window of request ids not verified.", source: "https://developer.paypal.com/api/orders/v2/" },
    recurring: { supported: true, evidence: "partially_verified", note: "PayPal Subscriptions v1: catalog product + billing plan per product version, subscription → approve link, BILLING.SUBSCRIPTION.* / PAYMENT.SALE.COMPLETED webhooks (endpoints + statuses from the OpenAPI schema; sale payload fields and the approve link rel not verified; never exercised against a sandbox).", source: "https://developer.paypal.com/docs/api/subscriptions/v1/" },
    savedMethods: { supported: true, evidence: "partially_verified", note: "Vaulting exists (save during purchase); requires PayPal eligibility review.", source: "https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/js-sdk/venmo/" },
    bankDebit: { supported: "unknown", evidence: "partially_verified", note: "Captures can be PENDING with reason ECHECK (bank-funded); treated as pending until COMPLETED.", source: "https://developer.paypal.com/api/orders/v2/" },
    refundsViaApi: { supported: true, evidence: "unverified", note: "POST /v2/payments/captures/{id}/refund — from prior knowledge; not re-verified in this build.", source: "https://developer.paypal.com/docs/api/payments/v2/" },
    disputesViaWebhook: { supported: true, evidence: "unverified", note: "CUSTOMER.DISPUTE.* events — event names not re-verified in this build." },
    webhookVerification: { supported: true, evidence: "verified_docs", note: "Postback to /v1/notifications/verify-webhook-signature with transmission headers + webhook_id (or self-verify CRC32+cert). Without API credentials we reject every PayPal webhook.", source: "https://developer.paypal.com/api/rest/webhooks/rest/" },
    currencies: ["USD"],
    regions: "US business account",
    envVars: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_ENV"],
  };
}

export function venmoCapabilities(): ProviderCapabilities {
  return {
    label: "Venmo (via PayPal Checkout)",
    oneTimeCheckout: { supported: true, evidence: "verified_docs", note: "US merchants and US buyers only; USD only; must use the PayPal JavaScript SDK; buyer needs the Venmo app (mobile: Safari iOS / Chrome Android; desktop: QR scan).", source: "https://developer.paypal.com/docs/checkout/pay-with-venmo/" },
    recurring: { supported: "unknown", evidence: "unverified", note: "Not documented for PayPal Subscriptions (the subscriptions guide names PayPal and cards only; the v6 SDK reference lists no Venmo subscription session). Not offered for recurring memberships — use Stripe (card/ACH) or PayPal Subscriptions.", source: "https://developer.paypal.com/docs/checkout/pay-with-venmo/" },
    savedMethods: { supported: "unknown", evidence: "partially_verified", note: "'Save Venmo during purchase' = Yes (vault, US only, eligibility review); 'Save for purchase later' = No. Merchant-initiated recurring use not documented.", source: "https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/js-sdk/venmo/" },
    bankDebit: { supported: false, evidence: "not_supported", note: "N/A" },
    refundsViaApi: { supported: true, evidence: "unverified", note: "Refunds go through the PayPal capture refund API (not re-verified)." },
    disputesViaWebhook: { supported: true, evidence: "unverified", note: "Via PayPal dispute webhooks (not re-verified)." },
    webhookVerification: { supported: true, evidence: "verified_docs", note: "Same as PayPal (verify-webhook-signature).", source: "https://developer.paypal.com/api/rest/webhooks/rest/" },
    currencies: ["USD"],
    regions: "US only",
    envVars: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"],
  };
}

// ---------------------------------------------------------------------------
// PayPal Subscriptions v1 (https://developer.paypal.com/docs/api/subscriptions/v1/)
// ---------------------------------------------------------------------------

async function paypalJson(method: "POST" | "GET", path: string, body: unknown, requestId?: string): Promise<{ status: number; json: Obj }> {
  const token = await accessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId; // stored by PayPal for 72 hours (OpenAPI parameter description)
  const res = await fetch(`${paypalBase()}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${str(json.message) ?? str(json.name) ?? "unknown error"}`);
  return { status: res.status, json };
}

const PAYPAL_INTERVAL: Record<RecurringPlanRequest["interval"], "WEEK" | "MONTH" | "YEAR"> = { week: "WEEK", month: "MONTH", year: "YEAR" };

export const paypalSubscriptions: SubscriptionProviderAdapter = {
  name: "paypal",
  label: "PayPal subscription",
  isConfigured: configured,
  missingEnv: () => ENV.filter((n) => !process.env[n]),

  /** PayPal has no lookup key: the local provider_plans cache + PayPal-Request-Id keep this to one plan per key. */
  async ensurePlan(req: RecurringPlanRequest): Promise<RecurringPlan> {
    if (!configured()) throw new ProviderNotConfiguredError("paypal", ENV.filter((n) => !process.env[n]));
    const product = await paypalJson("POST", "/v1/catalogs/products", { name: `${req.productName} (v${req.versionNumber})`.slice(0, 127), type: "SERVICE" }, `${req.idempotencyKey}:product`);
    const productId = str(product.json.id);
    if (!productId) throw new Error("PayPal did not return a product id");
    const plan = await paypalJson(
      "POST",
      "/v1/billing/plans",
      {
        product_id: productId,
        name: `${req.productName} v${req.versionNumber} — ${minorToDecimal(req.amountMinor)} ${req.currency}`.slice(0, 127),
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: PAYPAL_INTERVAL[req.interval], interval_count: req.intervalCount },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0, // 0 = until cancelled
            pricing_scheme: { fixed_price: { value: minorToDecimal(req.amountMinor), currency_code: req.currency.toUpperCase() } },
          },
        ],
        // Required object; we invent no retry/suspension policy, so PayPal's schema defaults apply
        // (auto_bill_outstanding=true, payment_failure_threshold=0). Failures still arrive as webhooks.
        payment_preferences: {},
      },
      `${req.idempotencyKey}:plan`,
    );
    const planId = str(plan.json.id);
    if (!planId) throw new Error("PayPal did not return a plan id");
    return { providerProductId: productId, providerPlanId: planId, created: true };
  },

  async startSubscription(req: SubscriptionStartRequest): Promise<SubscriptionStartResult> {
    if (!configured()) throw new ProviderNotConfiguredError("paypal", ENV.filter((n) => !process.env[n]));
    const start = req.firstChargeDate && req.firstChargeDate > todayLocal() ? localToUtc(req.firstChargeDate, "00:00").toISOString() : undefined;
    const { json } = await paypalJson(
      "POST",
      "/v1/billing/subscriptions",
      {
        plan_id: req.providerPlanId,
        custom_id: encodeHint({ membershipId: req.membershipId, requestId: req.requestId }),
        start_time: start,
        subscriber: req.customerEmail ? { email_address: req.customerEmail } : undefined,
        // application_context is marked DEPRECATED in the current schema but is still the documented REST
        // way to set return/cancel URLs for the approve redirect; verify in sandbox before go-live.
        application_context: { return_url: req.successUrl, cancel_url: req.cancelUrl, user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING" },
      },
      req.idempotencyKey,
    );
    const id = str(json.id);
    const links = Array.isArray(json.links) ? (json.links as Obj[]) : [];
    const approve = links.find((l) => l.rel === "approve");
    if (!id || !str(approve?.href)) throw new Error("PayPal did not return a subscription approval link");
    return { providerRef: id, approvalUrl: String(approve!.href), providerSubscriptionId: id };
  },

  async cancelAtPeriodEnd(req): Promise<SubscriptionCancelResult> {
    if (!configured()) throw new ProviderNotConfiguredError("paypal", ENV.filter((n) => !process.env[n]));
    // Cancel returns 204; no further cycles are billed. What was already paid stays paid.
    await paypalJson("POST", `/v1/billing/subscriptions/${encodeURIComponent(req.providerSubscriptionId)}/cancel`, { reason: req.reason.slice(0, 127) || "Cancelled by staff" }, req.idempotencyKey);
    return { paidThrough: null, immediate: true };
  },
};
