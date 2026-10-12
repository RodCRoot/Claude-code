import { deliveryEnabled, testRecipients, type ChannelConfig, type ChannelResult, type OutboundMessage, type Transport } from "./types";

/** Providers with an implemented HTTP transport. SMTP is accepted by env() but has no transport yet. */
const IMPLEMENTED = ["postmark", "sendgrid"] as const;

export function emailConfig(): ChannelConfig {
  const provider = process.env.EMAIL_PROVIDER && process.env.EMAIL_PROVIDER !== "none" ? process.env.EMAIL_PROVIDER : null;
  const missing: string[] = [];
  if (!provider) missing.push("EMAIL_PROVIDER");
  if (!process.env.EMAIL_API_KEY) missing.push("EMAIL_API_KEY");
  if (!process.env.EMAIL_FROM) missing.push("EMAIL_FROM");
  if (!deliveryEnabled()) missing.push("DELIVERY_ENABLED=true");
  if (provider && !(IMPLEMENTED as readonly string[]).includes(provider)) missing.push(`a transport for EMAIL_PROVIDER=${provider} (supported: ${IMPLEMENTED.join(", ")})`);
  return { configured: missing.length === 0, missing, provider };
}

const httpTransport: Transport = async (msg) => {
  const provider = process.env.EMAIL_PROVIDER;
  const key = process.env.EMAIL_API_KEY!;
  const from = process.env.EMAIL_FROM!;
  if (provider === "postmark") {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": key },
      body: JSON.stringify({ From: from, To: msg.to, Subject: msg.subject, TextBody: msg.body, MessageStream: "outbound" }),
    });
    if (!res.ok) throw new Error(`Postmark responded ${res.status}`);
    const json = (await res.json()) as { MessageID?: string };
    return { providerMessageId: json.MessageID ?? "postmark" };
  }
  if (provider === "sendgrid") {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from },
        subject: msg.subject,
        content: [{ type: "text/plain", value: msg.body }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid responded ${res.status}`);
    return { providerMessageId: res.headers.get("x-message-id") ?? "sendgrid" };
  }
  throw new Error(`No transport for EMAIL_PROVIDER=${provider}`);
};

let transport: Transport = httpTransport;

/** Test seam: replace the provider call (never used by the app at runtime). */
export function __setEmailTransport(t: Transport | null) {
  transport = t ?? httpTransport;
}

export async function sendEmail(msg: OutboundMessage): Promise<ChannelResult> {
  const cfg = emailConfig();
  if (!cfg.configured) {
    return { status: "not_configured", address: msg.to, reason: `Email not configured: set ${cfg.missing.join(", ")}` };
  }
  const redirect = testRecipients();
  let to = msg.to;
  if (redirect.length) {
    const testAddr = redirect.find((r) => r.includes("@"));
    if (!testAddr) return { status: "not_configured", address: null, reason: "DELIVERY_TEST_RECIPIENTS has no email address; nothing was sent." };
    to = testAddr;
  }
  try {
    const subject = redirect.length ? `[TEST → originally ${msg.to}] ${msg.subject}` : msg.subject;
    const { providerMessageId } = await transport({ ...msg, to, subject });
    return { status: redirect.length ? "test_redirected" : "sent", address: to, providerMessageId };
  } catch (e) {
    return { status: "failed", address: to, reason: e instanceof Error ? e.message : String(e), retryable: true };
  }
}
