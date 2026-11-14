import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Compare against itself so timing doesn't reveal the length mismatch path.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + concat(sorted key+value))).
 * `url` must be the exact public URL Twilio was configured with (incl. query string).
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false;
  return safeEqual(twilioSignature(authToken, url, params), signature);
}

/**
 * HTTP Basic auth check for webhooks that support credentials in the URL but not signatures
 * (Postmark webhooks, SendGrid Inbound Parse). Any username; the password must equal `secret`.
 */
export function verifyBasicSecret(authorization: string | null, secret: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(i + 1), secret);
}

/**
 * SendGrid Signed Event Webhook: ECDSA (P-256, SHA-256) over `timestamp + rawBody`.
 * `publicKey` is the base64 DER (SPKI) key shown in SendGrid's Mail Settings, or a PEM.
 */
export function verifySendgrid(publicKey: string, raw: string, signature: string | null, timestamp: string | null): boolean {
  if (!signature || !timestamp) return false;
  try {
    const key = publicKey.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
    return cryptoVerify("sha256", Buffer.from(timestamp + raw, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
