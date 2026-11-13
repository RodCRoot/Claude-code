/**
 * Stripe saved payment methods and off-session charges.
 *
 * - Collection is on Stripe-hosted Checkout in `setup` mode: no card or bank number reaches this app.
 *   https://docs.stripe.com/payments/save-and-reuse and
 *   https://docs.stripe.com/payments/ach-direct-debit/set-up-payment?payment-ui=checkout
 * - Autopay charges a saved method with an off-session PaymentIntent (`off_session=true`, `confirm=true`).
 * - No request shape here has been exercised against a Stripe sandbox (no keys exist in this build).
 */
import {
  assertNotLiveOutsideProduction,
  ProviderNotConfiguredError,
  type OffSessionChargeRequest,
  type OffSessionChargeResult,
  type SavedMethodProviderAdapter,
  type SetupSessionRequest,
} from "./provider";
import { stripeCall } from "./stripe";

const ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const idOf = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? str((v as Obj).id) : null);

function secret(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !process.env.STRIPE_WEBHOOK_SECRET) throw new ProviderNotConfiguredError("stripe", ENV.filter((n) => !process.env[n]));
  assertNotLiveOutsideProduction("stripe", key.startsWith("sk_live_") || key.startsWith("rk_live_"));
  return key;
}

export const stripeSavedMethods: SavedMethodProviderAdapter = {
  name: "stripe",
  isConfigured: () => ENV.every((n) => !!process.env[n]),
  missingEnv: () => ENV.filter((n) => !process.env[n]),

  async ensureCustomer(req) {
    const c = await stripeCall(
      "POST",
      "/v1/customers",
      { name: req.name.slice(0, 200), email: req.email ?? undefined, "metadata[payer_account_id]": req.payerAccountId, "metadata[org_id]": req.orgId },
      req.idempotencyKey,
    );
    const id = str(c.id);
    if (!id) throw new Error("Stripe did not return a customer id");
    return id;
  },

  async createSetupSession(req: SetupSessionRequest) {
    const session = await stripeCall(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "setup",
        customer: req.providerCustomerId,
        "payment_method_types[0]": req.type,
        // Instant verification through Financial Connections, with Stripe's manual-entry + microdeposit fallback.
        "payment_method_options[us_bank_account][financial_connections][permissions][0]": req.type === "us_bank_account" ? "payment_method" : undefined,
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        client_reference_id: req.setupId,
        "metadata[setup_id]": req.setupId,
        "setup_intent_data[metadata][setup_id]": req.setupId,
      },
      req.idempotencyKey,
    );
    if (!str(session.url)) throw new Error("Stripe did not return a Checkout URL");
    return { providerSessionId: String(session.id), url: String(session.url), providerSetupIntentId: idOf(session.setup_intent) };
  },

  async chargeSavedMethod(req: OffSessionChargeRequest): Promise<OffSessionChargeResult> {
    const key = secret();
    const u = new URLSearchParams();
    const add = (k: string, v: string | number | null | undefined) => {
      if (v != null && v !== "") u.append(k, String(v));
    };
    add("amount", req.amountMinor);
    add("currency", req.currency.toLowerCase());
    add("customer", req.providerCustomerId);
    add("payment_method", req.providerMethodId);
    add("payment_method_types[0]", req.methodType);
    add("off_session", "true");
    add("confirm", "true");
    add("mandate", req.methodType === "us_bank_account" ? req.mandateRef : null);
    add("description", `Invoice ${req.invoiceNumber}`);
    add("metadata[origin]", "autopay");
    add("metadata[attempt_id]", req.attemptId);
    add("metadata[invoice_id]", req.invoiceId);
    add("metadata[method_type]", req.methodType);
    const res = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": req.idempotencyKey },
      body: u.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) {
      const err = (json.error ?? {}) as Obj;
      // A card decline comes back as HTTP 402 with the PaymentIntent inside the error.
      if (res.status === 402 || str(err.type) === "card_error") {
        return { providerRef: idOf(err.payment_intent), status: "declined", failureCode: str(err.decline_code) ?? str(err.code) ?? "card_declined", failureMessage: str(err.message) };
      }
      throw new Error(`Stripe POST /v1/payment_intents failed (${res.status}): ${str(err.message) ?? "unknown error"}`);
    }
    const status = str(json.status);
    const last = (json.last_payment_error ?? {}) as Obj;
    if (status === "requires_payment_method" || status === "canceled") {
      return { providerRef: str(json.id), status: "declined", failureCode: str(last.decline_code) ?? str(last.code) ?? "provider_failed", failureMessage: str(last.message) };
    }
    if (status === "requires_action" || status === "requires_confirmation") {
      return { providerRef: str(json.id), status: "requires_action", failureCode: "authentication_required", failureMessage: "The bank asked the cardholder to approve this payment in person." };
    }
    // succeeded / processing: money state still comes only from the verified webhook.
    return { providerRef: str(json.id), status: "submitted", failureCode: null, failureMessage: null };
  },

  async detachMethod(req) {
    await stripeCall("POST", `/v1/payment_methods/${encodeURIComponent(req.providerMethodId)}/detach`, {}, req.idempotencyKey);
  },

  async fetchFee(paymentIntentId) {
    // The fee lives on the charge's balance transaction (https://docs.stripe.com/api/balance_transactions/object).
    const pi = await stripeCall("GET", `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, { "expand[0]": "latest_charge.balance_transaction" });
    const charge = (pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : {}) as Obj;
    const bt = (charge.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null) as Obj | null;
    if (!bt || typeof bt.fee !== "number" || !Number.isInteger(bt.fee)) return null;
    return { feeMinor: bt.fee, currency: String(bt.currency ?? "usd").toUpperCase() };
  },
};
