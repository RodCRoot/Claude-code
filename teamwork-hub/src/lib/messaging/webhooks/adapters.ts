import { createHash } from "node:crypto";
import { tokenFromAddresses } from "../reply-token";

/** Provider-neutral events produced by the adapters below. */
export type MessagingEvent =
  | { kind: "bounce"; eventId: string; email: string; hard: boolean; detail: string; providerMessageId: string | null }
  | { kind: "complaint"; eventId: string; email: string; detail: string; providerMessageId: string | null }
  | { kind: "inbound_email"; eventId: string; from: string; to: string | null; subject: string | null; body: string; token: string | null }
  | { kind: "inbound_sms"; eventId: string; from: string; to: string | null; body: string; keyword: "stop" | "start" | "help" | null }
  | { kind: "ignored"; eventId: string; detail: string };

export type HookName = "postmark-events" | "postmark-inbound" | "sendgrid-events" | "sendgrid-inbound" | "twilio-sms";
export const HOOKS: HookName[] = ["postmark-events", "postmark-inbound", "sendgrid-events", "sendgrid-inbound", "twilio-sms"];

export const PROVIDER: Record<HookName, "postmark" | "sendgrid" | "twilio"> = {
  "postmark-events": "postmark",
  "postmark-inbound": "postmark",
  "sendgrid-events": "sendgrid",
  "sendgrid-inbound": "sendgrid",
  "twilio-sms": "twilio",
};

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const hash = (...parts: (string | null | undefined)[]) => createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 32);

// --- Postmark --------------------------------------------------------------------------------

/** Postmark bounce types that mean the address will not accept mail. */
const POSTMARK_HARD = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "Blocked", "DMARCPolicy"]);

export function parsePostmarkEvent(body: unknown): MessagingEvent[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const type = s(b.RecordType);
  const id = s(b.ID) ?? s(b.MessageID) ?? hash(JSON.stringify(b));
  if (type === "Bounce") {
    const email = s(b.Email);
    if (!email) return [{ kind: "ignored", eventId: `bounce:${id}`, detail: "Bounce without an email address" }];
    const bounceType = s(b.Type) ?? "Unknown";
    return [
      {
        kind: "bounce",
        eventId: `bounce:${id}`,
        email,
        hard: POSTMARK_HARD.has(bounceType) || b.Inactive === true,
        detail: `${bounceType}${s(b.Description) ? `: ${s(b.Description)}` : ""}`.slice(0, 300),
        providerMessageId: s(b.MessageID),
      },
    ];
  }
  if (type === "SpamComplaint") {
    const email = s(b.Email);
    if (!email) return [{ kind: "ignored", eventId: `complaint:${id}`, detail: "Complaint without an email address" }];
    return [{ kind: "complaint", eventId: `complaint:${id}`, email, detail: "Marked as spam", providerMessageId: s(b.MessageID) }];
  }
  return [{ kind: "ignored", eventId: `${type ?? "unknown"}:${id}`, detail: `Postmark ${type ?? "event"} (not used)` }];
}

export function parsePostmarkInbound(body: unknown): MessagingEvent[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const fromFull = (b.FromFull ?? {}) as Record<string, unknown>;
  const toFull = Array.isArray(b.ToFull) ? (b.ToFull as Record<string, unknown>[]) : [];
  const from = s(fromFull.Email) ?? s(b.From);
  const id = s(b.MessageID) ?? hash(s(b.From), s(b.Subject), s(b.TextBody));
  if (!from) return [{ kind: "ignored", eventId: `inbound:${id}`, detail: "Inbound email without a sender" }];
  const hashFromProvider = s(b.MailboxHash);
  const token = tokenFromAddresses([s(b.OriginalRecipient), s(b.To), ...toFull.map((t) => s(t.Email))]) ?? (hashFromProvider && /^[0-9a-f]{48}$/i.test(hashFromProvider) ? hashFromProvider.toLowerCase() : null);
  return [
    {
      kind: "inbound_email",
      eventId: `inbound:${id}`,
      from,
      to: s(b.OriginalRecipient) ?? s(b.To),
      subject: s(b.Subject),
      body: s(b.StrippedTextReply) ?? s(b.TextBody) ?? "",
      token,
    },
  ];
}

// --- SendGrid --------------------------------------------------------------------------------

export function parseSendgridEvents(body: unknown): MessagingEvent[] {
  const arr = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  return arr.map((e): MessagingEvent => {
    const ev = s(e.event) ?? "unknown";
    const id = s(e.sg_event_id) ?? hash(ev, s(e.email), s(e.timestamp));
    const email = s(e.email);
    const msgId = s(e.sg_message_id)?.split(".")[0] ?? null;
    if (ev === "bounce" && email) {
      // type "blocked" is a temporary/reputation block, not a bad address.
      const hard = s(e.type) !== "blocked";
      return { kind: "bounce", eventId: id, email, hard, detail: `${s(e.type) ?? "bounce"}${s(e.reason) ? `: ${s(e.reason)}` : ""}`.slice(0, 300), providerMessageId: msgId };
    }
    if (ev === "spamreport" && email) return { kind: "complaint", eventId: id, email, detail: "Marked as spam", providerMessageId: msgId };
    return { kind: "ignored", eventId: id, detail: `SendGrid ${ev} (not used)` };
  });
}

/** SendGrid Inbound Parse posts multipart form fields. */
export function parseSendgridInbound(fields: Record<string, string>): MessagingEvent[] {
  let envelopeTo: string[] = [];
  try {
    const env = JSON.parse(fields.envelope ?? "{}") as { to?: string[] };
    envelopeTo = env.to ?? [];
  } catch {
    envelopeTo = [];
  }
  const from = s(fields.from);
  const msgIdHeader = /^Message-ID:\s*(.+)$/im.exec(fields.headers ?? "")?.[1]?.trim();
  const id = msgIdHeader ?? hash(fields.from, fields.subject, fields.text);
  if (!from) return [{ kind: "ignored", eventId: `inbound:${id}`, detail: "Inbound email without a sender" }];
  return [
    {
      kind: "inbound_email",
      eventId: `inbound:${id}`,
      from,
      to: s(fields.to),
      subject: s(fields.subject),
      body: fields.text ?? "",
      token: tokenFromAddresses([...envelopeTo, fields.to]),
    },
  ];
}

// --- Twilio ----------------------------------------------------------------------------------

const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START = new Set(["START", "YES", "UNSTOP"]);
const HELP = new Set(["HELP", "INFO"]);

export function smsKeyword(body: string, optOutType?: string | null): "stop" | "start" | "help" | null {
  const t = (optOutType ?? "").toUpperCase();
  if (t === "STOP") return "stop";
  if (t === "START") return "start";
  if (t === "HELP") return "help";
  const w = body.trim().toUpperCase().replace(/[.!]+$/, "");
  if (STOP.has(w)) return "stop";
  if (START.has(w)) return "start";
  if (HELP.has(w)) return "help";
  return null;
}

export function parseTwilioSms(params: Record<string, string>): MessagingEvent[] {
  const sid = s(params.MessageSid) ?? s(params.SmsSid);
  const from = s(params.From);
  if (!sid || !from) return [{ kind: "ignored", eventId: sid ?? hash(JSON.stringify(params)), detail: "Not an inbound SMS" }];
  // Status callbacks (MessageStatus) carry no inbound body.
  if (params.MessageStatus && !("Body" in params)) return [{ kind: "ignored", eventId: `${sid}:${params.MessageStatus}`, detail: `Twilio status ${params.MessageStatus} (not used)` }];
  const body = params.Body ?? "";
  return [{ kind: "inbound_sms", eventId: sid, from, to: s(params.To), body, keyword: smsKeyword(body, params.OptOutType) }];
}
