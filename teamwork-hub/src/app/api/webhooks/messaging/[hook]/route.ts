import { db } from "@/db";
import { HOOKS, type HookName } from "@/lib/messaging/webhooks/adapters";
import { ingestMessagingWebhook } from "@/lib/messaging/webhooks/ingest";

/**
 * Messaging provider webhooks (no session auth — each request is verified):
 *   /api/webhooks/messaging/postmark-events   bounces + spam complaints   (HTTP Basic: EMAIL_WEBHOOK_SECRET)
 *   /api/webhooks/messaging/postmark-inbound  inbound email replies       (HTTP Basic: EMAIL_WEBHOOK_SECRET)
 *   /api/webhooks/messaging/sendgrid-events   bounces + spam reports      (signed: SENDGRID_WEBHOOK_PUBLIC_KEY)
 *   /api/webhooks/messaging/sendgrid-inbound  Inbound Parse replies       (HTTP Basic: EMAIL_WEBHOOK_SECRET)
 *   /api/webhooks/messaging/twilio-sms        incoming SMS, STOP/START/HELP (X-Twilio-Signature: SMS_AUTH_TOKEN)
 * Optional `?org=<slug>` places messages from unknown senders (single-tenant default: first org).
 * Nothing here ever sends a message.
 */
export async function POST(request: Request, { params }: { params: Promise<{ hook: string }> }) {
  const { hook } = await params;
  if (!HOOKS.includes(hook as HookName)) return Response.json({ error: "Unknown webhook" }, { status: 404 });
  const reqUrl = new URL(request.url);
  // Twilio signs the public URL it was configured with; behind a proxy that's APP_URL + path.
  const base = process.env.APP_URL?.replace(/\/$/, "");
  const publicUrl = base ? `${base}${reqUrl.pathname}${reqUrl.search}` : request.url;
  let raw = "";
  let form: Record<string, string> | undefined;
  if (hook === "sendgrid-inbound") {
    const fd = await request.formData();
    form = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") form[k] = v;
  } else {
    raw = await request.text();
  }
  const res = await ingestMessagingWebhook(db, hook as HookName, { raw, headers: request.headers, url: publicUrl, form, orgSlug: reqUrl.searchParams.get("org") });
  return new Response(res.body, { status: res.httpStatus, headers: { "content-type": res.contentType, "cache-control": "no-store" } });
}
