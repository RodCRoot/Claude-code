import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Token encryption at rest: AES-256-GCM with a key derived (HKDF-SHA256) from CALENDAR_TOKEN_KEY,
 * a 32-byte base64 secret. Ciphertext format: `v1.<iv>.<ciphertext>.<tag>` (base64url parts).
 * The calendar connection id is bound in as additional authenticated data, so a ciphertext copied
 * onto another row (or any modified byte) fails authentication instead of decrypting.
 */
const VERSION = "v1";
const HKDF_INFO = "teamwork-hub/calendar-oauth-tokens/v1";

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenKeyError";
  }
}

export class TokenDecryptError extends Error {
  constructor() {
    super("Stored calendar credentials could not be decrypted (wrong CALENDAR_TOKEN_KEY or tampered data).");
    this.name = "TokenDecryptError";
  }
}

/** Parse CALENDAR_TOKEN_KEY (base64 of exactly 32 bytes) and derive the AES key. */
export function deriveTokenKey(base64Key: string | undefined | null): Buffer {
  if (!base64Key) throw new TokenKeyError("CALENDAR_TOKEN_KEY is not set.");
  const trimmed = base64Key.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) throw new TokenKeyError("CALENDAR_TOKEN_KEY must be base64.");
  const raw = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length !== 32) throw new TokenKeyError("CALENDAR_TOKEN_KEY must decode to exactly 32 bytes (openssl rand -base64 32).");
  return Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), HKDF_INFO, 32));
}

export function tokenKeyValid(base64Key: string | undefined | null): boolean {
  try {
    deriveTokenKey(base64Key);
    return true;
  } catch {
    return false;
  }
}

export function encryptToken(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptToken(payload: string, key: Buffer, aad: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenDecryptError();
  try {
    const [, ivB, ctB, tagB] = parts;
    const iv = Buffer.from(ivB, "base64url");
    const tag = Buffer.from(tagB, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new TokenDecryptError();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenDecryptError();
  }
}
