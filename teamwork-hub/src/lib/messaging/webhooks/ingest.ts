import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { messageDeliveries, messagingProviderEvents, undeliverableAddresses } from "@/db/schema";
import { audit } from "@/lib/audit";
import { normalizeEmail } from "../addresses";
import { peopleByAddress, receiveInbound, webhookOrg } from "../inbound";
import { recordConsent } from "../preferences";
import { parsePostmarkEvent, parsePostmarkInbound, parseSendgridEvents, parseSendgridInbound, parseTwilioSms, PROVIDER, type HookName, type MessagingEvent } from "./adapters";
import { verifyBasicSecret, verifySendgrid, verifyTwilio } from "./verify";

export type WebhookRequest = {
  /** Raw body (signatures cover the exact bytes). */
  raw: string;
  headers: Headers;
  /** Exact public URL the provider called (Twilio signs it). */
  url: string;
  /** Parsed multipart fields (SendGrid Inbound Parse). */
  form?: Record<string, string>;
  /** `?org=<slug>` — only used to place messages from unknown senders. */
  orgSlug?: string | null;
};

export type WebhookResponse = { httpStatus: number; body: string; contentType: string };

const json = (httpStatus: number, body: Record<string, unknown>): WebhookResponse => ({ httpStatus, body: JSON.stringify(body), contentType: "application/json" });
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Which env vars each webhook needs to verify requests. Values are never returned. */
export function webhookConfig(hook: HookName): { configured: boolean; missing: string[] } {
  const need: Record<HookName, string[]> = {
    "postmark-events": ["EMAIL_WEBHOOK_SECRET"],
    "postmark-inbound": ["EMAIL_WEBHOOK_SECRET"],
    "sendgrid-events": ["SENDGRID_WEBHOOK_PUBLIC_KEY"],
    "sendgrid-inbound": ["EMAIL_WEBHOOK_SECRET"],
    "twilio-sms": ["SMS_AUTH_TOKEN"],
  };
  const missing = need[hook].filter((k) => !process.env[k]);
  return { configured: missing.length === 0, missing };
}

function verified(hook: HookName, req: WebhookRequest, params: Record<string, string>): boolean {
  const h = (k: string) => req.headers.get(k);
  switch (hook) {
    case "postmark-events":
    case "postmark-inbound":
    case "sendgrid-inbound":
      return verifyBasicSecret(h("authorization"), process.env.EMAIL_WEBHOOK_SECRET!);
    case "sendgrid-events":
      return verifySendgrid(process.env.SENDGRID_WEBHOOK_PUBLIC_KEY!, req.raw, h("x-twilio-email-event-webhook-signature"), h("x-twilio-email-event-webhook-timestamp"));
    case "twilio-sms":
      return verifyTwilio(process.env.SMS_AUTH_TOKEN!, req.url, params, h("x-twilio-signature"));
  }
}

function parse(hook: HookName, req: WebhookRequest, params: Record<string, string>): MessagingEvent[] {
  switch (hook) {
    case "postmark-events":
      return parsePostmarkEvent(JSON.parse(req.raw || "{}"));
    case "postmark-inbound":
      return parsePostmarkInbound(JSON.parse(req.raw || "{}"));
    case "sendgrid-events":
      return parseSendgridEvents(JSON.parse(req.raw || "[]"));
    case "sendgrid-inbound":
      return parseSendgridInbound(req.form ?? {});
    case "twilio-sms":
      return parseTwilioSms(params);
  }
}

async function recordRejected(db: DB, provider: string, hook: HookName, reason: string) {
  await db.insert(messagingProviderEvents).values({
    provider,
    // Rejected rows never occupy a real event id, so a later valid delivery is still processed.
    providerEventId: `rejected:${randomUUID()}`,
    kind: hook,
    signatureVerified: false,
    status: "rejected",
    error: reason,
    processedAt: new Date(),
  });
}

/**
 * Messaging webhook pipeline: verify (reject + record when unverifiable or not configured) →
 * normalize via the provider adapter → per event, persist idempotently on (provider, event id)
 * and apply in one transaction. A processing error rolls back that event (including its record)
 * and returns 500 so the provider retries.
 */
export async function ingestMessagingWebhook(db: DB, hook: HookName, req: WebhookRequest): Promise<WebhookResponse> {
  const provider = PROVIDER[hook];
  const cfg = webhookConfig(hook);
  if (!cfg.configured) {
    await recordRejected(db, provider, hook, `Not configured: set ${cfg.missing.join(", ")}`);
    return json(503, { error: "Webhook not configured" });
  }
  const params = hook === "twilio-sms" ? Object.fromEntries(new URLSearchParams(req.raw)) : {};
  if (!verified(hook, req, params)) {
    await recordRejected(db, provider, hook, "Signature / credentials did not verify");
    return json(401, { error: "Invalid signature" });
  }
  let events: MessagingEvent[];
  try {
    events = parse(hook, req, params);
  } catch {
    await recordRejected(db, provider, hook, "Unparseable payload");
    return json(400, { error: "Unparseable payload" });
  }
  const org = await webhookOrg(db, req.orgSlug);
  if (!org) {
    await recordRejected(db, provider, hook, `Unknown organization${req.orgSlug ? ` "${req.orgSlug.slice(0, 60)}"` : ""}`);
    // 200: retrying won't help, and the event is recorded for operators.
    return json(200, { ok: false, error: "Unknown organization" });
  }
  const results: { eventId: string; status: string; summary?: string }[] = [];
  for (const ev of events) {
    try {
      const r = await db.transaction(async (tx) => {
        const [rec] = await tx
          .insert(messagingProviderEvents)
          .values({ provider, providerEventId: ev.eventId, kind: ev.kind, signatureVerified: true, status: "processed", payload: ev as unknown as Record<string, unknown> })
          .onConflictDoNothing()
          .returning({ id: messagingProviderEvents.id });
        if (!rec) return { status: "duplicate" };
        const out = await applyEvent(tx, provider, ev, org.id);
        await tx.update(messagingProviderEvents).set({ status: out.status, summary: out.summary.slice(0, 500), processedAt: new Date() }).where(eq(messagingProviderEvents.id, rec.id));
        return out;
      });
      results.push({ eventId: ev.eventId, ...r });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "messaging_webhook_failed", hook, eventId: ev.eventId, message: (e as Error)?.message }));
      return json(500, { error: "Processing failed; please retry" });
    }
  }
  if (hook === "twilio-sms") return { httpStatus: 200, body: TWIML_EMPTY, contentType: "text/xml" };
  return json(200, { ok: true, results });
}

type Outcome = { status: "processed" | "ignored"; summary: string };

/** Applies one verified, normalized provider event inside the caller's transaction (one org). */
export async function applyEvent(tx: Tx, provider: string, ev: MessagingEvent, orgId: string, now = new Date()): Promise<Outcome> {
  switch (ev.kind) {
    case "ignored":
      return { status: "ignored", summary: ev.detail };
    case "bounce": {
      if (!ev.hard) return { status: "ignored", summary: `Soft bounce (${ev.detail}) — address left active` };
      const flagged = await markUndeliverable(tx, orgId, provider, ev.eventId, ev.email, "hard_bounce", ev.detail, now);
      await failAcceptedDelivery(tx, orgId, ev.providerMessageId, `Bounced after the provider accepted it: ${ev.detail}`, now);
      return { status: "processed", summary: `Hard bounce: address ${flagged ? "flagged undeliverable" : "already flagged"}` };
    }
    case "complaint": {
      await markUndeliverable(tx, orgId, provider, ev.eventId, ev.email, "spam_complaint", ev.detail, now);
      const ppl = await peopleByAddress(tx, orgId, "email", ev.email);
      for (const p of ppl) {
        await recordConsent(tx, { orgId, personId: p.id, channel: "email", consent: "opted_out", source: "email_complaint", detail: `${provider} spam complaint`, now });
      }
      return { status: "processed", summary: `Spam complaint: address flagged, ${ppl.length} person(s) opted out of email` };
    }
    case "inbound_sms": {
      if (ev.keyword) return applyKeyword(tx, orgId, ev.keyword, ev.from, now);
      const r = await receiveInbound(tx, { channel: "sms", provider, providerMessageId: ev.eventId, from: ev.from, to: ev.to, subject: null, body: ev.body, token: null, orgId }, now);
      return { status: "processed", summary: `Inbound SMS ${r.status}` };
    }
    case "inbound_email": {
      const r = await receiveInbound(tx, { channel: "email", provider, providerMessageId: ev.eventId, from: ev.from, to: ev.to, subject: ev.subject, body: ev.body, token: ev.token, orgId }, now);
      return { status: "processed", summary: `Inbound email ${r.status}` };
    }
  }
}

/** STOP / START / HELP from a phone number — applies to every person in the org with that number. */
async function applyKeyword(tx: Tx, orgId: string, keyword: "stop" | "start" | "help", from: string, now: Date): Promise<Outcome> {
  const ppl = await peopleByAddress(tx, orgId, "sms", from);
  if (keyword === "help") return { status: "processed", summary: `HELP from ${ppl.length ? "a known number" : "an unknown number"} — no consent change (the help reply comes from the provider's opt-out settings)` };
  if (!ppl.length) return { status: "ignored", summary: `${keyword.toUpperCase()} from an unknown number` };
  let changed = 0;
  for (const p of ppl) {
    const r = await recordConsent(tx, {
      orgId,
      personId: p.id,
      channel: "sms",
      consent: keyword === "stop" ? "opted_out" : "opted_in",
      source: "sms_keyword",
      detail: `Replied ${keyword.toUpperCase()}`,
      now,
    });
    if (r.changed) changed++;
  }
  return { status: "processed", summary: `${keyword.toUpperCase()}: ${changed} of ${ppl.length} matching person(s) updated` };
}

/** Flags the address (even if no one has it yet — the provider says it is dead). True if newly flagged. */
async function markUndeliverable(tx: Tx, orgId: string, provider: string, eventId: string, email: string, reason: "hard_bounce" | "spam_complaint", detail: string, now: Date): Promise<boolean> {
  const addr = normalizeEmail(email);
  if (!addr) return false;
  const ins = await tx
    .insert(undeliverableAddresses)
    .values({ orgId, channel: "email", address: addr, reason, provider, providerEventId: eventId, detail: detail.slice(0, 300), createdAt: now })
    .onConflictDoNothing()
    .returning({ id: undeliverableAddresses.id });
  if (!ins.length) return false;
  const ppl = await peopleByAddress(tx, orgId, "email", addr);
  await audit(tx, { orgId, actorUserId: null, actorRole: "webhook" }, "messaging.address_undeliverable", "undeliverable_address", ins[0].id, {
    summary: `${provider}: ${reason === "hard_bounce" ? "hard bounce" : "spam complaint"} — email to this address is suppressed`,
    after: { personIds: ppl.map((p) => p.id), detail },
  });
  return true;
}

/** A delivery the provider accepted but then bounced is no longer shown as sent. */
async function failAcceptedDelivery(tx: Tx, orgId: string, providerMessageId: string | null, reason: string, now: Date) {
  if (!providerMessageId) return;
  await tx
    .update(messageDeliveries)
    .set({ status: "failed", statusReason: reason.slice(0, 300), updatedAt: now })
    .where(
      and(
        eq(messageDeliveries.providerMessageId, providerMessageId),
        eq(messageDeliveries.channel, "email"),
        inArray(messageDeliveries.status, ["sent", "test_redirected"]),
        sql`${messageDeliveries.messageId} in (select m.id from messages m join threads t on t.id = m.thread_id where t.org_id = ${orgId})`,
      ),
    );
}
