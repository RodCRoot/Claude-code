import { createHash, randomBytes } from "node:crypto";

/**
 * Share tokens: 32 random bytes (256 bits) from the OS generator, written as 43 base64url
 * characters. Only the SHA-256 hash is stored, so a database read never yields a working link.
 * A high-entropy random token needs no salt or slow hash: there is nothing to guess.
 */
export const TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const isWellFormedToken = (t: unknown): t is string => typeof t === "string" && TOKEN_PATTERN.test(t);

export const sharePath = (token: string) => `/s/${token}`;
