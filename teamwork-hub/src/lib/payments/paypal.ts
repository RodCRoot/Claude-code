import {
  assertNotLiveOutsideProduction,
  decimalToMinor,
  minorToDecimal,
  ProviderNotConfiguredError,
  ProviderUnsupportedError,
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
    default:
      return { kind: "ignored", reason: `unhandled event type ${type}` };
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
  const token = await accessToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": idempotencyKey },
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  return { status: str(json.status) ?? `http_${res.status}` };
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
 * with the PayPal JavaScript SDK Venmo button (documented requirement) — that client page is not built yet,
 * so createCheckout refuses honestly even when PayPal credentials exist.
 */
export const venmoAdapter: PaymentProviderAdapter = {
  name: "venmo",
  isConfigured: configured,
  missingEnv: () => ENV.filter((n) => !process.env[n]),
  capabilities: venmoCapabilities,
  async createCheckout() {
    if (!configured()) throw new ProviderNotConfiguredError("venmo", ENV.filter((n) => !process.env[n]));
    throw new ProviderUnsupportedError(
      "Venmo checkout requires the PayPal JavaScript SDK Venmo button (US buyers, USD, Venmo app installed). That button page is not enabled yet — use PayPal or card checkout.",
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
    recurring: { supported: true, evidence: "partially_verified", note: "PayPal Subscriptions API bills at regular intervals. Supported funding sources are not listed on the overview page; not yet integrated here.", source: "https://developer.paypal.com/docs/subscriptions/" },
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
    recurring: { supported: "unknown", evidence: "unverified", note: "Not documented for PayPal Subscriptions; 'Save Venmo for purchase later' is listed as not supported. Use Stripe (card/ACH) or PayPal Subscriptions for recurring memberships.", source: "https://developer.paypal.com/docs/checkout/pay-with-venmo/" },
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
