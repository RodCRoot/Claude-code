/**
 * Provider subscription fixtures. Shapes follow the documented objects:
 * - Stripe Subscription / Invoice objects and event types (https://docs.stripe.com/api/subscriptions/object,
 *   https://docs.stripe.com/api/invoices/object — `parent.subscription_details.{subscription,metadata}`,
 *   per-item `current_period_end`, line `period`), https://docs.stripe.com/billing/subscriptions/webhooks
 * - PayPal Subscriptions v1 subscription resource (OpenAPI schema: id, status, custom_id, billing_info) and
 *   event names (https://developer.paypal.com/api/rest/webhooks/event-names/). The PAYMENT.SALE.COMPLETED
 *   sale fields (billing_agreement_id, amount.total/currency) are NOT in a schema we could verify.
 * Values are synthetic; nothing here came from a real account.
 */
import { evtId } from "./stripe";

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
export const at = (iso: string) => unix(new Date(iso));

type Hint = { membershipId: string; requestId: string } | null;
const md = (h: Hint) => (h ? { membership_id: h.membershipId, request_id: h.requestId } : {});

export function stripeCheckoutSubscriptionCompleted(o: { sessionId: string; subId: string; hint: Hint; created?: number }) {
  return {
    id: evtId("evt_cs_sub"),
    object: "event",
    type: "checkout.session.completed",
    created: o.created ?? unix(new Date()),
    data: { object: { id: o.sessionId, object: "checkout.session", mode: "subscription", subscription: o.subId, client_reference_id: o.hint?.membershipId ?? null, payment_status: "paid", amount_total: 0, currency: "usd", metadata: md(o.hint) } },
  };
}

export function stripeSubscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted" | "customer.subscription.paused",
  o: { subId: string; hint: Hint; status: string; periodStart: number; periodEnd: number; cancelAtPeriodEnd?: boolean; created?: number; id?: string },
) {
  return {
    id: o.id ?? evtId("evt_sub"),
    object: "event",
    type,
    created: o.created ?? unix(new Date()),
    data: {
      object: {
        id: o.subId,
        object: "subscription",
        status: o.status,
        cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
        cancel_at: o.cancelAtPeriodEnd ? o.periodEnd : null,
        customer: "cus_test_fixture",
        metadata: md(o.hint),
        items: { object: "list", data: [{ id: "si_test", object: "subscription_item", current_period_start: o.periodStart, current_period_end: o.periodEnd, price: { id: "price_test", unit_amount: 10000, currency: "usd" } }] },
      },
    },
  };
}

export function stripeInvoiceEvent(
  type: "invoice.paid" | "invoice.payment_failed" | "invoice.payment_action_required",
  o: { invoiceId: string; subId: string; hint: Hint; amount: number; periodStart: number; periodEnd: number; billingReason?: string; created?: number; id?: string; currency?: string },
) {
  return {
    id: o.id ?? evtId("evt_inv"),
    object: "event",
    type,
    created: o.created ?? unix(new Date()),
    data: {
      object: {
        id: o.invoiceId,
        object: "invoice",
        billing_reason: o.billingReason ?? "subscription_cycle",
        currency: o.currency ?? "usd",
        amount_due: o.amount,
        amount_paid: type === "invoice.paid" ? o.amount : 0,
        status: type === "invoice.paid" ? "paid" : "open",
        customer: "cus_test_fixture",
        parent: { type: "subscription_details", subscription_details: { subscription: o.subId, metadata: md(o.hint) } },
        lines: { object: "list", data: [{ id: "il_test", amount: o.amount, period: { start: o.periodStart, end: o.periodEnd }, parent: { type: "subscription_item_details" } }] },
      },
    },
  };
}

export function paypalSubscriptionEvent(
  type: "BILLING.SUBSCRIPTION.CREATED" | "BILLING.SUBSCRIPTION.ACTIVATED" | "BILLING.SUBSCRIPTION.UPDATED" | "BILLING.SUBSCRIPTION.SUSPENDED" | "BILLING.SUBSCRIPTION.CANCELLED" | "BILLING.SUBSCRIPTION.EXPIRED",
  o: { subId: string; customId?: string | null; status: string; nextBillingTime?: string; createTime?: string },
) {
  return {
    id: `WH-${evtId("SUB")}`,
    event_version: "1.0",
    create_time: o.createTime ?? new Date().toISOString(),
    resource_type: "subscription",
    event_type: type,
    resource: { id: o.subId, status: o.status, plan_id: "P-TESTPLAN", custom_id: o.customId ?? undefined, billing_info: { outstanding_balance: { currency_code: "USD", value: "0.00" }, failed_payments_count: 0, next_billing_time: o.nextBillingTime } },
  };
}

export function paypalPaymentFailedEvent(o: { subId: string; customId?: string | null; amount: string; time: string }) {
  return {
    id: `WH-${evtId("FAIL")}`,
    event_version: "1.0",
    create_time: o.time,
    resource_type: "subscription",
    event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    resource: { id: o.subId, status: "ACTIVE", custom_id: o.customId ?? undefined, billing_info: { outstanding_balance: { currency_code: "USD", value: o.amount }, failed_payments_count: 1, last_failed_payment: { amount: { currency_code: "USD", value: o.amount }, time: o.time } } },
  };
}

export function paypalSaleCompletedEvent(o: { saleId: string; subId: string; total: string; createTime?: string }) {
  return {
    id: `WH-${evtId("SALE")}`,
    event_version: "1.0",
    create_time: o.createTime ?? new Date().toISOString(),
    resource_type: "sale",
    event_type: "PAYMENT.SALE.COMPLETED",
    resource: { id: o.saleId, state: "completed", billing_agreement_id: o.subId, amount: { total: o.total, currency: "USD" }, create_time: o.createTime ?? new Date().toISOString() },
  };
}

export function paypalCaptureCompletedEvent(o: { captureId: string; orderId: string; attemptId: string; value: string }) {
  return {
    id: `WH-${evtId("CAP")}`,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: o.captureId, status: "COMPLETED", custom_id: o.attemptId, amount: { currency_code: "USD", value: o.value }, supplementary_data: { related_ids: { order_id: o.orderId } } },
  };
}

export const paypalHeaders = () =>
  new Headers({
    "content-type": "application/json",
    "paypal-transmission-id": `tx-${evtId("t")}`,
    "paypal-transmission-time": new Date().toISOString(),
    "paypal-transmission-sig": "fixture-signature",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fixture",
    "paypal-auth-algo": "SHA256withRSA",
  });

// ---------------------------------------------------------------------------
// fetch mock: records every call, answers from a route table, refuses anything unrouted.
// ---------------------------------------------------------------------------

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };
export type Route = (call: FetchCall) => { status?: number; json?: unknown } | undefined;

export function mockFetch(routes: Route[]) {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k] = v));
    const call: FetchCall = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return new Response(res.json === undefined ? null : JSON.stringify(res.json), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unmocked provider call: ${call.method} ${url}`);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

export const paypalOAuth: Route = (c) => (c.url.endsWith("/v1/oauth2/token") ? { json: { access_token: "A21-fixture-token", token_type: "Bearer" } } : undefined);
export const paypalVerify = (status: "SUCCESS" | "FAILURE"): Route => (c) =>
  c.url.endsWith("/v1/notifications/verify-webhook-signature") ? { json: { verification_status: status } } : undefined;
