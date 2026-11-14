import { db } from "@/db";
import { ingestWebhook } from "@/lib/billing/webhooks";

/**
 * Stripe webhook endpoint. Reads the RAW body (the signature covers the exact bytes), verifies the
 * Stripe-Signature HMAC locally, persists idempotently and processes. No session auth: the signature
 * is the authentication. Responds non-2xx only when Stripe should retry.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const res = await ingestWebhook(db, "stripe", raw, request.headers);
  return Response.json(res.body, { status: res.httpStatus });
}
