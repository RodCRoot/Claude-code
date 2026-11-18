/**
 * GoHighLevel (LeadConnector) API v2 client. Server-side only.
 *
 * Evidence (vendor docs, fetched 2026-10-12 from the official OpenAPI specs that back
 * https://highlevel.stoplight.io/docs/integrations, raw files in GitHub GoHighLevel/highlevel-api-docs):
 * - Base URL `https://services.leadconnectorhq.com` (apps/conversations.json `servers`).
 * - Auth: `Authorization: Bearer <token>`; "Use the Access Token generated with user type as
 *   Sub-Account (OR) Private Integration Token of Sub-Account" (securitySchemes.bearer).
 * - Send: `POST /conversations/messages`, header `Version: 2021-04-15`, body `SendMessageBodyDto`
 *   { type: "SMS", contactId, message, fromNumber?, toNumber? }, scope `conversations/message.write`.
 *   200 → `SendMessageResponseDto` { conversationId, messageId, status, msg? } (required:
 *   conversationId, messageId, status).
 * - Lookup: `GET /contacts/search/duplicate?locationId=&number=|&email=`, header `Version: 2021-07-28`,
 *   scope `contacts.readonly`. Phone must be URL-encoded (+1… → %2B1…). The 200 response body is NOT
 *   documented in the spec ("description": ""); we read `{ contact }` defensively and treat anything
 *   else as "no match" (unverified).
 *
 * Never fakes success: every call either returns what GHL returned or throws a GhlError.
 */

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";
export const GHL_VERSION_CONVERSATIONS = "2021-04-15";
export const GHL_VERSION_CONTACTS = "2021-07-28";

export type GhlConfig = { configured: boolean; missing: string[]; locationId: string | null; fromNumber: string | null };

export function ghlConfig(): GhlConfig {
  const missing: string[] = [];
  if (!process.env.GHL_API_KEY) missing.push("GHL_API_KEY");
  if (!process.env.GHL_LOCATION_ID) missing.push("GHL_LOCATION_ID");
  return { configured: missing.length === 0, missing, locationId: process.env.GHL_LOCATION_ID || null, fromNumber: process.env.GHL_FROM_NUMBER || null };
}

export class GhlError extends Error {
  constructor(
    message: string,
    public status: number | null,
    /** False when retrying cannot help (auth, validation, no such contact). */
    public retryable: boolean,
  ) {
    super(message);
    this.name = "GhlError";
  }
}

export class GhlNotConfiguredError extends GhlError {
  constructor(missing: string[]) {
    super(`GoHighLevel is not configured: set ${missing.join(", ")}`, null, false);
    this.name = "GhlNotConfiguredError";
  }
}

async function ghlFetch(path: string, init: { method: "GET" | "POST"; version: string; body?: unknown }): Promise<unknown> {
  const cfg = ghlConfig();
  if (!cfg.configured) throw new GhlNotConfiguredError(cfg.missing);
  let res: Response;
  try {
    res = await fetch(`${GHL_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: init.version,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new GhlError(`GoHighLevel request failed: ${e instanceof Error ? e.message : String(e)}`, null, true);
  }
  if (!res.ok) {
    // 429 (rate limit) and 5xx may succeed later; 4xx (auth/scope/validation) will not.
    const retryable = res.status === 429 || res.status >= 500;
    let detail = "";
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j?.message === "string") detail = `: ${j.message}`;
      else if (Array.isArray(j?.message)) detail = `: ${j.message.join("; ")}`;
    } catch {
      /* body not JSON */
    }
    throw new GhlError(`GoHighLevel responded ${res.status}${detail}`, res.status, retryable);
  }
  try {
    return await res.json();
  } catch {
    throw new GhlError("GoHighLevel returned a non-JSON response", res.status, true);
  }
}

export type GhlContact = { id: string; firstName: string | null; lastName: string | null; contactName: string | null; phone: string | null; email: string | null };

function toContact(raw: unknown): GhlContact | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" ? c.id : typeof c._id === "string" ? c._id : null;
  if (!id) return null;
  const s = (k: string) => (typeof c[k] === "string" && (c[k] as string).trim() ? (c[k] as string).trim() : null);
  return { id, firstName: s("firstName"), lastName: s("lastName"), contactName: s("contactName") ?? s("name"), phone: s("phone"), email: s("email") };
}

/**
 * Find the GHL contact for a phone or email (exactly one of them). Returns null when GHL reports
 * no match. Uses GHL's own duplicate rules (email first, then phone, when duplicates are allowed).
 */
export async function findGhlContact(q: { phone?: string | null; email?: string | null }): Promise<GhlContact | null> {
  const cfg = ghlConfig();
  if (!cfg.configured) throw new GhlNotConfiguredError(cfg.missing);
  const params = new URLSearchParams({ locationId: cfg.locationId! });
  if (q.email) params.set("email", q.email.trim());
  else if (q.phone) params.set("number", q.phone.trim());
  else throw new GhlError("A phone number or email is required to look up a GoHighLevel contact.", null, false);
  // URLSearchParams encodes "+" as %2B and "@" as %40, as the spec requires.
  const body = (await ghlFetch(`/contacts/search/duplicate?${params.toString()}`, { method: "GET", version: GHL_VERSION_CONTACTS })) as Record<string, unknown> | null;
  return toContact(body?.contact);
}

export type GhlSendResult = { messageId: string; conversationId: string | null; status: string | null };

/** Send an SMS to an existing GHL contact. */
export async function sendGhlSms(input: { contactId: string; message: string; toNumber?: string | null; fromNumber?: string | null }): Promise<GhlSendResult> {
  const cfg = ghlConfig();
  const body: Record<string, unknown> = { type: "SMS", contactId: input.contactId, message: input.message };
  const from = input.fromNumber ?? cfg.fromNumber;
  if (from) body.fromNumber = from;
  if (input.toNumber) body.toNumber = input.toNumber;
  const r = (await ghlFetch("/conversations/messages", { method: "POST", version: GHL_VERSION_CONVERSATIONS, body })) as Record<string, unknown> | null;
  const messageId = typeof r?.messageId === "string" ? r.messageId : null;
  if (!messageId) throw new GhlError("GoHighLevel accepted the request but returned no messageId; not treated as sent.", 200, false);
  return {
    messageId,
    conversationId: typeof r?.conversationId === "string" ? r.conversationId : null,
    status: typeof r?.status === "string" ? r.status : null,
  };
}

/**
 * SMS via GHL for the messaging channel: look the recipient up by phone (Teamwork never creates or
 * merges GHL contacts), then send. A number with no GHL contact fails without retry.
 */
export async function ghlSmsTransport(msg: { to: string; body: string }): Promise<{ providerMessageId: string }> {
  const contact = await findGhlContact({ phone: msg.to });
  if (!contact) throw new GhlError("No GoHighLevel contact has this phone number. Add the family in GHL first (Teamwork never creates GHL contacts).", 404, false);
  const r = await sendGhlSms({ contactId: contact.id, message: msg.body, toNumber: msg.to });
  return { providerMessageId: `ghl:${r.messageId}` };
}
