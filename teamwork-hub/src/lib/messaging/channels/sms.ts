import { deliveryEnabled, testRecipients, type ChannelConfig, type ChannelResult, type OutboundMessage, type Transport } from "./types";

export function smsConfig(): ChannelConfig {
  const provider = process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== "none" ? process.env.SMS_PROVIDER : null;
  const missing: string[] = [];
  if (!provider) missing.push("SMS_PROVIDER");
  if (!process.env.SMS_ACCOUNT_SID) missing.push("SMS_ACCOUNT_SID");
  if (!process.env.SMS_AUTH_TOKEN) missing.push("SMS_AUTH_TOKEN");
  if (!process.env.SMS_FROM) missing.push("SMS_FROM");
  if (!deliveryEnabled()) missing.push("DELIVERY_ENABLED=true");
  if (provider && provider !== "twilio") missing.push(`a transport for SMS_PROVIDER=${provider} (supported: twilio)`);
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

let transport: Transport = twilioTransport;

/** Test seam: replace the provider call (never used by the app at runtime). */
export function __setSmsTransport(t: Transport | null) {
  transport = t ?? twilioTransport;
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
    return { status: "failed", address: to, reason: e instanceof Error ? e.message : String(e), retryable: true };
  }
}
