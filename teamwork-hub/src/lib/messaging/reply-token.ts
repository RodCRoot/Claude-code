import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reply-to addressing for inbound email threading: `reply+<token>@EMAIL_INBOUND_DOMAIN`, where the
 * token is the thread id plus a truncated HMAC (SESSION_SECRET) so it can't be guessed or forged
 * for another conversation. The sender's address must still match a thread participant.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for reply tokens");
  return s;
}

const mac = (hex: string) => createHmac("sha256", secret()).update(`reply:${hex}`).digest("hex").slice(0, 16);

export function replyToken(threadId: string): string {
  const hex = threadId.replace(/-/g, "").toLowerCase();
  return `${hex}${mac(hex)}`;
}

/** Thread id for a valid token, else null. */
export function threadIdFromToken(token: string | null | undefined): string | null {
  const t = (token ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(t)) return null;
  const hex = t.slice(0, 32);
  const given = Buffer.from(t.slice(32));
  const want = Buffer.from(mac(hex));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extracts the token from `reply+<token>@domain` (any of several recipient addresses). */
export function tokenFromAddresses(addresses: (string | null | undefined)[]): string | null {
  for (const a of addresses) {
    for (const m of (a ?? "").toLowerCase().matchAll(/reply\+([0-9a-f]{48})@/g)) return m[1];
  }
  return null;
}

export function inboundDomain(): string | null {
  const d = (process.env.EMAIL_INBOUND_DOMAIN ?? "").trim();
  return d || null;
}

/** Reply-To header for outbound email about a thread, or null when inbound email isn't set up. */
export function replyToForThread(threadId: string): string | null {
  const d = inboundDomain();
  return d ? `reply+${replyToken(threadId)}@${d}` : null;
}
