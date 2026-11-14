import { ghlConfig, ghlSmsTransport } from "@/lib/integrations/gohighlevel/client";
import { deliveryEnabled, testRecipients, type ChannelConfig, type ChannelResult, type OutboundMessage, type Transport } from "./types";

const SUPPORTED = ["twilio", "gohighlevel"] as const;

export function smsConfig(): ChannelConfig {
  const provider = process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== "none" ? process.env.SMS_PROVIDER : null;
  const missing: string[] = [];
  if (!provider) missing.push("SMS_PROVIDER");
  if (provider === "gohighlevel") {
    // GoHighLevel sends from the sub-account's own numbers; no Twilio credentials involved.
    missing.push(...ghlConfig().missing);
  } else {
    if (!process.env.SMS_ACCOUNT_SID) missing.push("SMS_ACCOUNT_SID");
    if (!process.env.SMS_AUTH_TOKEN) missing.push("SMS_AUTH_TOKEN");
    if (!process.env.SMS_FROM) missing.push("SMS_FROM");
  }
  if (!deliveryEnabled()) missing.push("DELIVERY_ENABLED=true");
  if (provider && !(SUPPORTED as readonly string[]).includes(provider)) missing.push(`a transport for SMS_PROVIDER=${provider} (supported: ${SUPPORTED.join(", ")})`);
  return { configured: missing.length === 0, missing, provider };
}

const PHONE = /^\+?[\d\s().-]{7,}$/;

const twilioTransport: Transport = async (msg) => {
  const sid = process.env.SMS_ACCOUNT_SID!;
  const token = process.env.SMS_AUTH_TOKEN!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
    },
    body: new URLSearchParams({ To: msg.to, From: process.env.SMS_FROM!, Body: msg.body }).toString(),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
  const json = (await res.json()) as { sid?: string };
  return { providerMessageId: json.sid ?? "twilio" };
};

/** Provider transport for the configured SMS_PROVIDER (read at call time). */
const providerTransport: Transport = (msg) => (process.env.SMS_PROVIDER === "gohighlevel" ? ghlSmsTransport(msg) : twilioTransport(msg));

let transport: Transport = providerTransport;

/** Test seam: replace the provider call (never used by the app at runtime). */
export function __setSmsTransport(t: Transport | null) {
  transport = t ?? providerTransport;
}

export async function sendSms(msg: OutboundMessage): Promise<ChannelResult> {
  const cfg = smsConfig();
  if (!cfg.configured) {
    return { status: "not_configured", address: msg.to, reason: `SMS not configured: set ${cfg.missing.join(", ")}` };
  }
  const redirect = testRecipients();
  let to = msg.to;
  if (redirect.length) {
    const testNum = redirect.find((r) => !r.includes("@") && PHONE.test(r));
    if (!testNum) return { status: "not_configured", address: null, reason: "DELIVERY_TEST_RECIPIENTS has no phone number; nothing was sent." };
    to = testNum;
  }
  try {
    const body = redirect.length ? `[TEST → ${msg.to}] ${msg.body}` : msg.body;
    const { providerMessageId } = await transport({ ...msg, to, body: body.slice(0, 1500) });
    return { status: redirect.length ? "test_redirected" : "sent", address: to, providerMessageId };
  } catch (e) {
    // Errors that say retrying can't help (e.g. GHL: no contact for this number, bad token) are final.
    const retryable = (e as { retryable?: unknown })?.retryable !== false;
    return { status: "failed", address: to, reason: e instanceof Error ? e.message : String(e), retryable };
  }
}
