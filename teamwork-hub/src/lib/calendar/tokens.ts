import { and, eq } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { calendarConnections, calendarOauthTokens, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { decryptToken, encryptToken, TokenDecryptError } from "./crypto";
import { GoogleCalendarProvider } from "./google";
import { googleOAuthConfig, OAuthTokenError, refreshAccessToken, revokeToken, type GoogleOAuthConfig, type TokenResponse } from "./oauth";
import { CalendarProviderError, type CalendarProvider } from "./types";

type Connection = typeof calendarConnections.$inferSelect;

/** Refresh this long before Google's stated expiry to absorb clock skew and request latency. */
const EXPIRY_SKEW_MS = 60_000;

export const RECONNECT_MESSAGE = "Google Calendar access was revoked or expired. The coach needs to reconnect Google Calendar in Schedule settings.";

export type TokenDeps = { cfg: GoogleOAuthConfig; fetchImpl?: typeof fetch; now?: () => Date };

/** Encrypt and upsert the tokens for a connection (AAD = connection id). */
export async function storeTokens(tx: Tx, cfg: GoogleOAuthConfig, conn: { id: string; orgId: string }, t: TokenResponse & { refresh_token: string }, now = new Date()) {
  const values = {
    connectionId: conn.id,
    orgId: conn.orgId,
    refreshTokenEnc: encryptToken(t.refresh_token, cfg.tokenKey, conn.id),
    accessTokenEnc: encryptToken(t.access_token, cfg.tokenKey, conn.id),
    accessTokenExpiresAt: new Date(now.getTime() + t.expires_in * 1000),
    scopes: t.scope ?? "",
    refreshedAt: now,
    updatedAt: now,
  };
  await tx.insert(calendarOauthTokens).values(values).onConflictDoUpdate({ target: calendarOauthTokens.connectionId, set: values });
}

async function markConnectionError(tx: Tx, conn: Connection, message: string, reason: string) {
  await tx.update(calendarConnections).set({ status: "error", lastError: message }).where(eq(calendarConnections.id, conn.id));
  // The grant is useless now; drop it so nothing keeps retrying with it.
  await tx.delete(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
  await audit(tx, { orgId: conn.orgId, actorUserId: null, actorRole: "system" }, "calendar.token_refresh_failed", "calendar_connection", conn.id, {
    summary: `Google Calendar authorization failed (${reason}); connection marked error until the coach reconnects.`,
  });
}

/**
 * A valid access token for the connection: the cached one if it has > 60 s left, otherwise a
 * refreshed one. Refresh-token rotation is honored (a returned refresh_token replaces the stored one).
 * A revoked/expired grant (invalid_grant) or unreadable ciphertext marks the connection `error`
 * with a reconnect message and throws a non-retryable CalendarProviderError; network/5xx errors
 * throw a retryable one and leave the connection alone.
 */
export async function getAccessToken(tx: Tx, connectionId: string, deps: TokenDeps): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const [conn] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId));
  if (!conn) throw new CalendarProviderError("Calendar connection not found.", null, false);
  const [row] = await tx.select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, connectionId)).for("update");
  if (!row || conn.status !== "connected") throw new CalendarProviderError("Google Calendar is not connected for this coach.", null, false);
  const key = deps.cfg.tokenKey;
  try {
    if (row.accessTokenEnc && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime()) {
      return decryptToken(row.accessTokenEnc, key, conn.id);
    }
    const refreshToken = decryptToken(row.refreshTokenEnc, key, conn.id);
    let t: TokenResponse;
    try {
      t = await refreshAccessToken(deps.cfg, refreshToken, deps.fetchImpl);
    } catch (e) {
      if (e instanceof OAuthTokenError && e.revoked) {
        await markConnectionError(tx, conn, RECONNECT_MESSAGE, e.message);
        throw new CalendarProviderError(RECONNECT_MESSAGE, e.status, false);
      }
      const retryable = e instanceof OAuthTokenError ? e.retryable : true;
      throw new CalendarProviderError((e as Error).message, e instanceof OAuthTokenError ? e.status : null, retryable);
    }
    await tx
      .update(calendarOauthTokens)
      .set({
        accessTokenEnc: encryptToken(t.access_token, key, conn.id),
        accessTokenExpiresAt: new Date(now.getTime() + t.expires_in * 1000),
        ...(t.refresh_token ? { refreshTokenEnc: encryptToken(t.refresh_token, key, conn.id) } : {}),
        ...(t.scope ? { scopes: t.scope } : {}),
        refreshedAt: now,
        updatedAt: now,
      })
      .where(eq(calendarOauthTokens.connectionId, conn.id));
    return t.access_token;
  } catch (e) {
    if (e instanceof TokenDecryptError) {
      const msg = "Stored Google Calendar credentials could not be decrypted (CALENDAR_TOKEN_KEY changed?). The coach needs to reconnect.";
      await markConnectionError(tx, conn, msg, "decrypt_failed");
      throw new CalendarProviderError(msg, null, false);
    }
    throw e;
  }
}

/** Forget the cached access token so the next call refreshes. */
export async function invalidateAccessToken(tx: Tx, connectionId: string) {
  await tx.update(calendarOauthTokens).set({ accessTokenEnc: null, accessTokenExpiresAt: null, updatedAt: new Date() }).where(eq(calendarOauthTokens.connectionId, connectionId));
}

export type ProviderFactory = (connection: Connection, tx: Tx) => Promise<CalendarProvider | null>;

/**
 * Real provider for a connected coach: null (→ honest "not configured") unless the OAuth client
 * and token key are configured and this connection holds stored tokens.
 */
export function googleProviderFactory(opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => Date } = {}): ProviderFactory {
  return async (conn, tx) => {
    const cfg = googleOAuthConfig(opts.env);
    if (!cfg || conn.status !== "connected") return null;
    const [row] = await tx.select({ id: calendarOauthTokens.connectionId }).from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
    if (!row) return null;
    return new GoogleCalendarProvider({
      getAccessToken: () => getAccessToken(tx, conn.id, { cfg, fetchImpl: opts.fetchImpl, now: opts.now }),
      onUnauthorized: () => invalidateAccessToken(tx, conn.id),
      fetchImpl: opts.fetchImpl,
    });
  };
}

/** Coaches manage their own calendar; owner/admin (integrations.manage) may disconnect anyone's. */
export function assertCanManageConnection(v: Viewer, conn: { orgId: string; userId: string }) {
  if (conn.orgId !== v.orgId) throw new AuthzError();
  if (conn.userId === v.userId && ["owner", "admin", "operations", "coach"].includes(v.role)) return;
  if (can(v, "integrations.manage")) return;
  throw new AuthzError("You can only disconnect your own calendar.");
}

/**
 * Disconnect: revoke the grant at Google (best effort), then delete the stored tokens and mark the
 * connection disabled. Runs revocation outside any transaction (network), then commits locally
 * even if Google could not be reached — the stored tokens are deleted either way.
 */
export async function disconnectCalendar(dbh: DB, v: Viewer, input: { connectionId: string }, deps: { cfg?: GoogleOAuthConfig | null; fetchImpl?: typeof fetch } = {}) {
  const [conn] = await dbh.select().from(calendarConnections).where(and(eq(calendarConnections.id, input.connectionId), eq(calendarConnections.orgId, v.orgId)));
  if (!conn) throw new AuthzError("Calendar connection not found.");
  assertCanManageConnection(v, conn);
  const cfg = deps.cfg === undefined ? googleOAuthConfig() : deps.cfg;
  const [row] = await dbh.select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
  let revoked: boolean | null = null;
  if (row && cfg) {
    try {
      revoked = await revokeToken(decryptToken(row.refreshTokenEnc, cfg.tokenKey, conn.id), deps.fetchImpl);
    } catch {
      revoked = false; // undecryptable: nothing usable to revoke
    }
  }
  const [owner] = await dbh.select({ name: users.displayName }).from(users).where(eq(users.id, conn.userId));
  await dbh.transaction(async (tx) => {
    await tx.delete(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
    await tx.update(calendarConnections).set({ status: "disabled", lastError: null }).where(eq(calendarConnections.id, conn.id));
    await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "calendar.disconnected", "calendar_connection", conn.id, {
      summary:
        `Disconnected Google Calendar for ${owner?.name ?? "staff member"}; stored tokens deleted. ` +
        (revoked === true ? "Google access revoked." : revoked === false ? "Google revocation could not be confirmed — remove “Teamwork Hub” under Google Account → Security → Third-party access." : "No stored tokens to revoke."),
      after: { status: "disabled", revoked },
    });
  });
  return { revoked };
}
