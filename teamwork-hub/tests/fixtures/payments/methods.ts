/**
 * Saved-method / autopay webhook fixtures, shaped like documented Stripe snapshot events:
 * - Checkout Session in setup mode (https://docs.stripe.com/payments/ach-direct-debit/set-up-payment?payment-ui=checkout)
 * - SetupIntent (`payment_method`, `mandate`, `customer`, `metadata`, `next_action.verify_with_microdeposits.hosted_verification_url`,
 *   `last_setup_error`), PaymentMethod (`card.brand/last4/exp_month/exp_year`, `us_bank_account.bank_name/last4`), Mandate (`status`),
 *   PaymentIntent (`metadata`, `amount_received`, `last_payment_error.code/decline_code`).
 * Field names are from the API reference and prior knowledge; none was captured from a real account (no keys exist).
 * Values are synthetic. Events are signed locally with a test secret.
 */
import { evtId } from "./stripe";

const now = () => Math.floor(Date.now() / 1000);
const wrap = (type: string, object: Record<string, unknown>, id?: string) => ({ id: id ?? evtId("evt_pm"), object: "event", type, created: now(), livemode: false, data: { object } });

export function setupSessionCompleted(o: { setupId: string; sessionId: string; setupIntent: string; customer: string; expired?: boolean }) {
  return wrap(o.expired ? "checkout.session.expired" : "checkout.session.completed", {
    id: o.sessionId,
    object: "checkout.session",
    mode: "setup",
    client_reference_id: o.setupId,
    setup_intent: o.setupIntent,
    customer: o.customer,
    payment_status: "no_payment_required",
    metadata: { setup_id: o.setupId },
  });
}

export function setupIntentEvent(
  type: "setup_intent.succeeded" | "setup_intent.requires_action" | "setup_intent.setup_failed",
  o: { setupId: string; setupIntent: string; customer: string; pm?: string | null; mandate?: string | null; verificationUrl?: string; errorCode?: string; id?: string },
) {
  return wrap(
    type,
    {
      id: o.setupIntent,
      object: "setup_intent",
      customer: o.customer,
      payment_method: o.pm ?? null,
      mandate: o.mandate ?? null,
      status: type === "setup_intent.succeeded" ? "succeeded" : type === "setup_intent.requires_action" ? "requires_action" : "requires_payment_method",
      metadata: { setup_id: o.setupId },
      next_action: type === "setup_intent.requires_action" ? { type: "verify_with_microdeposits", verify_with_microdeposits: { hosted_verification_url: o.verificationUrl ?? "https://payments.stripe.com/microdeposit/sample", microdeposit_type: "descriptor_code" } } : null,
      last_setup_error: type === "setup_intent.setup_failed" ? { code: o.errorCode ?? "setup_intent_authentication_failure", message: "Sample setup failure." } : null,
    },
    o.id,
  );
}

export function paymentMethodEvent(
  type: "payment_method.attached" | "payment_method.detached" | "payment_method.updated" | "payment_method.automatically_updated",
  o: { pm: string; customer: string | null; card?: { brand: string; last4: string; expMonth: number; expYear: number }; bank?: { bankName: string; last4: string }; id?: string },
) {
  return wrap(
    type,
    {
      id: o.pm,
      object: "payment_method",
      customer: o.customer,
      type: o.bank ? "us_bank_account" : "card",
      card: o.card ? { brand: o.card.brand, last4: o.card.last4, exp_month: o.card.expMonth, exp_year: o.card.expYear, fingerprint: "fp_never_stored", funding: "credit" } : undefined,
      // routing_number is present on real events; the app must not store it.
      us_bank_account: o.bank ? { bank_name: o.bank.bankName, last4: o.bank.last4, routing_number: "110000000", account_type: "checking", fingerprint: "fp_never_stored" } : undefined,
    },
    o.id,
  );
}

export function mandateUpdated(o: { mandate: string; pm: string; status: "active" | "inactive" | "pending" }) {
  return wrap("mandate.updated", { id: o.mandate, object: "mandate", payment_method: o.pm, status: o.status, type: "multi_use" });
}

export function paymentIntentEvent(
  type: "payment_intent.processing" | "payment_intent.succeeded" | "payment_intent.payment_failed",
  o: { pi: string; attemptId: string; invoiceId: string; amount: number; methodType: "card" | "us_bank_account"; code?: string; declineCode?: string; message?: string; origin?: string | null; id?: string },
) {
  return wrap(
    type,
    {
      id: o.pi,
      object: "payment_intent",
      amount: o.amount,
      amount_received: type === "payment_intent.succeeded" ? o.amount : 0,
      currency: "usd",
      status: type === "payment_intent.succeeded" ? "succeeded" : type === "payment_intent.processing" ? "processing" : "requires_payment_method",
      payment_method_types: [o.methodType],
      metadata: { ...(o.origin === null ? {} : { origin: o.origin ?? "autopay" }), attempt_id: o.attemptId, invoice_id: o.invoiceId, method_type: o.methodType },
      last_payment_error: type === "payment_intent.payment_failed" ? { code: o.code ?? "card_declined", decline_code: o.declineCode, message: o.message ?? "Sample failure.", payment_method: { type: o.methodType } } : null,
    },
    o.id,
  );
}

export function achDisputeCreated(o: { pi: string; amount: number; disputeId: string; reason?: string }) {
  return wrap("charge.dispute.created", { id: o.disputeId, object: "dispute", amount: o.amount, currency: "usd", payment_intent: o.pi, charge: "ch_sample", reason: o.reason ?? "insufficient_funds", status: "lost", evidence_details: { due_by: null } });
}

/** Mock of the Stripe HTTP API for the calls the saved-method adapter makes. Records every request. */
export function stripeMethodsApi(opts: { charge?: (params: URLSearchParams) => { status: number; body: Record<string, unknown> }; feeMinor?: number | null } = {}) {
  const calls: { method: string; path: string; params: URLSearchParams; idempotencyKey: string | null }[] = [];
  let n = Math.floor(Math.random() * 1e9);
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const params = new URLSearchParams(method === "POST" ? String(init?.body ?? "") : url.search);
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, params, idempotencyKey: headers.get("idempotency-key") });
    const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/customers") return json(200, { id: `cus_test_${(params.get("metadata[payer_account_id]") ?? "x").slice(0, 8)}`, object: "customer" });
    if (url.pathname === "/v1/checkout/sessions") return json(200, { id: `cs_test_setup_${++n}`, object: "checkout.session", mode: params.get("mode"), url: `https://checkout.stripe.com/c/pay/cs_test_setup_${n}`, setup_intent: null });
    if (url.pathname === "/v1/payment_intents" && method === "POST") {
      const r = opts.charge?.(params) ?? { status: 200, body: { id: `pi_test_${(params.get("metadata[attempt_id]") ?? "").slice(0, 8)}`, object: "payment_intent", status: params.get("payment_method_types[0]") === "us_bank_account" ? "processing" : "succeeded" } };
      return json(r.status, r.body);
    }
    if (url.pathname.startsWith("/v1/payment_intents/") && method === "GET") {
      return json(200, { id: url.pathname.split("/").pop(), object: "payment_intent", latest_charge: { id: "ch_sample", balance_transaction: opts.feeMinor == null ? null : { id: "txn_sample", fee: opts.feeMinor, currency: "usd" } } });
    }
    if (/\/v1\/payment_methods\/.+\/detach/.test(url.pathname)) return json(200, { id: url.pathname.split("/")[3], object: "payment_method", customer: null });
    return json(404, { error: { message: `unmocked ${method} ${url.pathname}` } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
