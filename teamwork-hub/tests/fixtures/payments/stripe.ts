/**
 * Stripe webhook fixtures shaped like documented snapshot events (https://docs.stripe.com/api/events/types).
 * Values are synthetic. Signed locally with a test secret — no Stripe account is involved.
 */
import { signStripePayload } from "@/lib/payments/stripe";

export const TEST_WHSEC = "whsec_test_fixture_secret_not_real";

let n = 0;
export const evtId = (p = "evt_test") => `${p}_${Date.now()}_${++n}`;

export function checkoutSessionEvent(
  type: "checkout.session.completed" | "checkout.session.async_payment_succeeded" | "checkout.session.async_payment_failed" | "checkout.session.expired",
  o: { attemptId: string; invoiceId: string; amount: number; currency?: string; paymentStatus?: "paid" | "unpaid"; pi?: string; methods?: string[]; id?: string },
) {
  return {
    id: o.id ?? evtId(),
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: `cs_test_${o.attemptId.slice(0, 8)}`,
        object: "checkout.session",
        mode: "payment",
        client_reference_id: o.attemptId,
        amount_total: o.amount,
        currency: (o.currency ?? "usd").toLowerCase(),
        payment_status: o.paymentStatus ?? (type === "checkout.session.async_payment_failed" ? "unpaid" : "paid"),
        payment_intent: o.pi ?? `pi_test_${o.attemptId.slice(0, 8)}`,
        payment_method_types: o.methods ?? ["card"],
        metadata: { attempt_id: o.attemptId, invoice_id: o.invoiceId },
      },
    },
  };
}

export function chargeRefundedEvent(o: { pi: string; amount: number; amountRefunded: number; id?: string }) {
  return {
    id: o.id ?? evtId(),
    object: "event",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `ch_test_${o.pi.slice(-8)}`, object: "charge", amount: o.amount, amount_refunded: o.amountRefunded, currency: "usd", payment_intent: o.pi, refunded: o.amount === o.amountRefunded } },
  };
}

export function disputeEvent(type: "charge.dispute.created" | "charge.dispute.closed", o: { pi: string; amount: number; status: string; disputeId: string }) {
  return {
    id: evtId(),
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: o.disputeId, object: "dispute", amount: o.amount, currency: "usd", payment_intent: o.pi, charge: "ch_x", reason: "fraudulent", status: o.status, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400 } } },
  };
}

export function signedHeaders(body: string, secret = TEST_WHSEC, t?: number) {
  return new Headers({ "stripe-signature": signStripePayload(secret, body, t), "content-type": "application/json" });
}
