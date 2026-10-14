import { createHmac, hkdfSync } from "node:crypto";

/**
 * Pure kiosk-PIN helpers (no DB, no server-only imports) so seeds and tests can use them.
 *
 * Storage is HMAC-SHA256 keyed with a key derived (HKDF) from SESSION_SECRET over "<orgId>:<pin>".
 * A deterministic keyed hash is what makes lookup-by-PIN possible without listing names; with only
 * 10^4–10^6 possible PINs a salted slow hash would not resist offline guessing anyway — the secret
 * key does. Rotating SESSION_SECRET invalidates every PIN (families/staff set them again).
 */

export const PIN_PATTERN = /^\d{4,6}$/;

let cachedKey: { secret: string; key: Buffer } | null = null;
function pinKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET is not configured; kiosk PINs are unavailable.");
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "teamwork-hub/kiosk-checkin-pin/v1", 32)) };
  return cachedKey.key;
}

export function hashCheckInPin(orgId: string, pin: string): string {
  return createHmac("sha256", pinKey()).update(`${orgId}:${pin}`).digest("base64url");
}

/** Same digit repeated, or a straight run up/down (1234, 98765, 0123…). */
export function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}
