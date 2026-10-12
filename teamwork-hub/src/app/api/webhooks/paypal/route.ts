import { db } from "@/db";
import { ingestWebhook } from "@/lib/billing/webhooks";

/**
 * PayPal (and Venmo-via-PayPal) webhook endpoint. Verification uses PayPal's
 * verify-webhook-signature API; without PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID every delivery is
 * rejected and recorded (never trusted).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const res = await ingestWebhook(db, "paypal", raw, request.headers);
  return Response.json(res.body, { status: res.httpStatus });
}
