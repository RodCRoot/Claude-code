import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveTokenKey, tokenKeyValid } from "./crypto";

/**
 * Google OAuth 2.0 for web server applications (authorization-code flow), per
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 * - authorization: https://accounts.google.com/o/oauth2/v2/auth  (access_type=offline, prompt=consent)
 * - token / refresh: POST https://oauth2.googleapis.com/token (application/x-www-form-urlencoded)
 * - revoke: POST https://oauth2.googleapis.com/revoke  (token=<refresh or access token>)
 *
 * CSRF: `state` is an HMAC-signed, short-lived payload bound to the signed-in user + org and to a
 * random nonce that is also kept in an httpOnly cookie (binding the flow to the browser that
 * started it). PKCE (S256) is added as defense in depth; the verifier is derived server-side from
 * the nonce with a server secret, so it never leaves the server.
 *
 * Every function takes an injectable `fetchImpl`, so tests never touch the network.
 * Nothing here logs tokens, and error messages never include token values.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Create secondary calendars and manage events on them — only the calendar Teamwork creates. */
export const SCOPE_APP_CALENDAR = "https://www.googleapis.com/auth/calendar.app.created";
/** Read free/busy (no event details) from the coach's own calendars. */
export const SCOPE_FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
export const CALENDAR_SCOPES = [SCOPE_APP_CALENDAR, SCOPE_FREEBUSY];

export const OAUTH_COOKIE = "tw_gcal_oauth";
export const STATE_TTL_MS = 10 * 60_000;
export const CALLBACK_PATH = "/api/calendar/google/callback";

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** AES key derived from CALENDAR_TOKEN_KEY. */
  tokenKey: Buffer;
  /** HMAC key for `state` + PKCE, derived from SESSION_SECRET. */
  stateKey: Buffer;
};

type EnvLike = Record<string, string | undefined>;

/** Env variable names that are missing or invalid for live Google Calendar sync. */
export function missingCalendarEnv(env: EnvLike = process.env): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!tokenKeyValid(env.CALENDAR_TOKEN_KEY)) missing.push("CALENDAR_TOKEN_KEY");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) missing.push("SESSION_SECRET");
  return missing;
}

export function googleOAuthConfig(env: EnvLike = process.env): GoogleOAuthConfig | null {
  if (missingCalendarEnv(env).length) return null;
  const appUrl = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    redirectUri: `${appUrl}${CALLBACK_PATH}`,
    tokenKey: deriveTokenKey(env.CALENDAR_TOKEN_KEY),
    stateKey: Buffer.from(hkdfSync("sha256", Buffer.from(env.SESSION_SECRET!, "utf8"), Buffer.alloc(0), "teamwork-hub/calendar-oauth-state/v1", 32)),
  };
}

const b64u = (b: Buffer) => b.toString("base64url");
const hmac = (key: Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export function pkceVerifier(stateKey: Buffer, nonce: string): string {
  return b64u(hmac(stateKey, `pkce:${nonce}`)); // 43 chars, within RFC 7636's 43–128
}
export function pkceChallenge(verifier: string): string {
  return b64u(createHash("sha256").update(verifier).digest());
}

export class OAuthStateError extends Error {
  constructor(
    public code: "malformed" | "bad_signature" | "expired" | "wrong_user" | "nonce_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "OAuthStateError";
  }
}

type StatePayload = { u: string; o: string; n: string; e: number };

/** Build the Google consent URL for the signed-in user. Store `nonce` in the httpOnly OAuth cookie. */
export function createAuthRequest(cfg: GoogleOAuthConfig, who: { userId: string; orgId: string }, now = Date.now()) {
  const nonce = b64u(randomBytes(24));
  const payload: StatePayload = { u: who.userId, o: who.orgId, n: nonce, e: now + STATE_TTL_MS };
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const state = `${body}.${b64u(hmac(cfg.stateKey, `state:${body}`))}`;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPES.join(" "),
    access_type: "offline",
    // Always show consent so Google returns a refresh token, also on reconnect.
    prompt: "consent",
    state,
    code_challenge: pkceChallenge(pkceVerifier(cfg.stateKey, nonce)),
    code_challenge_method: "S256",
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state, nonce };
}

/** Validate `state` on the callback: signature, expiry, same user/org, same browser (cookie nonce). */
export function verifyState(cfg: GoogleOAuthConfig, state: string | null | undefined, expect: { userId: string; orgId: string; cookieNonce: string | null | undefined }, now = Date.now()): { nonce: string } {
  if (!state || typeof state !== "string") throw new OAuthStateError("malformed", "Missing OAuth state.");
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) throw new OAuthStateError("malformed", "Malformed OAuth state.");
  const want = hmac(cfg.stateKey, `state:${body}`);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new OAuthStateError("bad_signature", "OAuth state signature is invalid.");
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw new OAuthStateError("malformed", "Malformed OAuth state.");
  }
  if (typeof p.e !== "number" || p.e < now) throw new OAuthStateError("expired", "The Google sign-in took too long. Please try connecting again.");
  if (p.u !== expect.userId || p.o !== expect.orgId) throw new OAuthStateError("wrong_user", "This Google authorization was started by a different user.");
  const cn = expect.cookieNonce ?? "";
  const a = Buffer.from(cn);
  const b = Buffer.from(p.n ?? "");
  if (!cn || a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthStateError("nonce_mismatch", "This Google authorization was not started from this browser.");
  return { nonce: p.n };
}

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

/** Token endpoint failure. `revoked` = the grant is no longer valid (user must reconnect). */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public revoked: boolean,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

async function tokenRequest(fetchImpl: typeof fetch, params: Record<string, string>, what: string): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new OAuthTokenError(`Network error during Google ${what}: ${(e as Error).message}`, null, false, true);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Only Google's error code is surfaced — never the request or response body.
    const code = typeof json.error === "string" ? json.error.replace(/[^a-z_]/gi, "").slice(0, 40) : "unknown_error";
    const revoked = code === "invalid_grant" || code === "unauthorized_client" || res.status === 401;
    throw new OAuthTokenError(`Google ${what} failed (${res.status} ${code}).`, res.status, revoked, res.status === 429 || res.status >= 500);
  }
  if (typeof json.access_token !== "string" || !json.access_token) throw new OAuthTokenError(`Google ${what} returned no access token.`, res.status, false, false);
  return {
    access_token: json.access_token,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in) || 3600,
    refresh_token: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    token_type: typeof json.token_type === "string" ? json.token_type : undefined,
  };
}

export function exchangeCode(cfg: GoogleOAuthConfig, code: string, nonce: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(
    fetchImpl,
    {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: pkceVerifier(cfg.stateKey, nonce),
    },
    "code exchange",
  );
}

export function refreshAccessToken(cfg: GoogleOAuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(fetchImpl, { client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }, "token refresh");
}

/** Revoke a refresh (or access) token. Returns true when Google confirmed (200) or the token was already invalid (400 invalid_token). */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (res.ok) return true;
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return res.status === 400 && json.error === "invalid_token";
  } catch {
    return false;
  }
}

export function grantedScopes(scope: string | undefined | null): Set<string> {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean));
}
