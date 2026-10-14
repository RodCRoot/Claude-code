import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { auditEvents, calendarConnections, calendarEventLinks, calendarOauthTokens, jobs } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { runJobs } from "@/lib/jobs";
import { completeGoogleConnection, TEAMWORK_CALENDAR_NAME } from "@/lib/calendar/connect";
import { decryptToken, deriveTokenKey, encryptToken, TokenDecryptError, TokenKeyError } from "@/lib/calendar/crypto";
import { googleConfigured } from "@/lib/calendar/google";
import {
  CALENDAR_SCOPES,
  createAuthRequest,
  googleOAuthConfig,
  missingCalendarEnv,
  OAuthStateError,
  pkceChallenge,
  SCOPE_APP_CALENDAR,
  SCOPE_FREEBUSY,
  verifyState,
} from "@/lib/calendar/oauth";
import { CALENDAR_FREEBUSY_JOB, CALENDAR_SYNC_JOB, calendarJobHandlers } from "@/lib/calendar/sync";
import { disconnectCalendar, getAccessToken, googleProviderFactory, RECONNECT_MESSAGE } from "@/lib/calendar/tokens";
import { createSession } from "@/lib/scheduling";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const TZ = "America/Indiana/Indianapolis";
const ENV = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret-value",
  CALENDAR_TOKEN_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  APP_URL: "https://hub.example.test",
};
const cfg = googleOAuthConfig(ENV)!;
const NOW = new Date("2026-03-02T12:00:00Z");

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** Mock Google: token endpoint, revoke endpoint and Calendar API. No network. */
function mockGoogle(opts: { tokens?: () => Response; refresh?: () => Response; revokeStatus?: number } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token") {
        return opts.refresh?.() ?? Response.json({ access_token: `access-refreshed-${++n}`, expires_in: 3599, token_type: "Bearer", scope: CALENDAR_SCOPES.join(" ") });
      }
      return opts.tokens?.() ?? Response.json({ access_token: "access-initial-AAA", refresh_token: "refresh-initial-RRR", expires_in: 3599, token_type: "Bearer", scope: CALENDAR_SCOPES.join(" ") });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("{}", { status: opts.revokeStatus ?? 200 });
    if (url === "https://www.googleapis.com/calendar/v3/calendars" && init.method === "POST") return Response.json({ id: "teamwork-cal@group.calendar.google.com", summary: TEAMWORK_CALENDAR_NAME });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/") && init.method === "GET") return Response.json({ id: "x" });
    if (url.endsWith("/events") && init.method === "POST") return Response.json({ id: `ev-${++n}`, etag: `"e${n}"` });
    if (url.endsWith("/freeBusy")) return Response.json({ calendars: { primary: { busy: [{ start: "2026-03-05T15:00:00Z", end: "2026-03-05T16:00:00Z" }] } } });
    return new Response("not mocked", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Start the flow for a user and return what the browser would carry back. */
function startFlow(userId: string, orgId: string, at = NOW) {
  const req = createAuthRequest(cfg, { userId, orgId }, at.getTime());
  return { ...req, cookieNonce: req.nonce };
}

const SECRETS = ["access-initial-AAA", "refresh-initial-RRR", "refresh-rotated-ZZZ", "access-refreshed-", ENV.GOOGLE_CLIENT_SECRET];

describe("configuration", () => {
  it("is honest about missing configuration (including an invalid token key)", () => {
    expect(googleConfigured(ENV)).toBe(true);
    expect(missingCalendarEnv({ ...ENV, GOOGLE_CLIENT_ID: "" })).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(missingCalendarEnv({ ...ENV, CALENDAR_TOKEN_KEY: undefined })).toEqual(["CALENDAR_TOKEN_KEY"]);
    expect(missingCalendarEnv({ ...ENV, CALENDAR_TOKEN_KEY: randomBytes(16).toString("base64") })).toEqual(["CALENDAR_TOKEN_KEY"]);
    expect(googleOAuthConfig({ ...ENV, GOOGLE_CLIENT_SECRET: undefined })).toBeNull();
    expect(cfg.redirectUri).toBe("https://hub.example.test/api/calendar/google/callback");
  });
});

describe("token encryption (AES-256-GCM)", () => {
  const key = deriveTokenKey(ENV.CALENDAR_TOKEN_KEY);
  it("round-trips and never stores plaintext; IV is random", () => {
    const a = encryptToken("ya29.secret-token", key, "conn-1");
    const b = encryptToken("ya29.secret-token", key, "conn-1");
    expect(a).not.toContain("secret-token");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptToken(a, key, "conn-1")).toBe("ya29.secret-token");
  });

  it("detects tampering, row swaps and wrong keys", () => {
    const enc = encryptToken("1//refresh-token", key, "conn-1");
    const [v, iv, ct, tag] = enc.split(".");
    const flip = (s: string) => {
      const buf = Buffer.from(s, "base64url");
      buf[0] ^= 0x01;
      return buf.toString("base64url");
    };
    expect(() => decryptToken([v, iv, flip(ct), tag].join("."), key, "conn-1")).toThrow(TokenDecryptError);
    expect(() => decryptToken([v, iv, ct, flip(tag)].join("."), key, "conn-1")).toThrow(TokenDecryptError);
    expect(() => decryptToken([v, flip(iv), ct, tag].join("."), key, "conn-1")).toThrow(TokenDecryptError);
    expect(() => decryptToken(enc, key, "conn-2")).toThrow(TokenDecryptError); // copied onto another connection
    expect(() => decryptToken(enc, deriveTokenKey(randomBytes(32).toString("base64")), "conn-1")).toThrow(TokenDecryptError);
    expect(() => decryptToken("garbage", key, "conn-1")).toThrow(TokenDecryptError);
    expect(() => deriveTokenKey("short")).toThrow(TokenKeyError);
  });
});

describe("OAuth state (CSRF) and consent URL", () => {
  it("builds a minimal-scope, offline, PKCE consent URL", () => {
    const { url } = createAuthRequest(cfg, { userId: ctx.users.marcus, orgId: ctx.orgId });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")!.split(" ").sort()).toEqual([SCOPE_APP_CALENDAR, SCOPE_FREEBUSY].sort());
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(url).not.toContain(ENV.GOOGLE_CLIENT_SECRET);
  });

  it("accepts only an unexpired, correctly signed state for the same user, org and browser", () => {
    const f = startFlow(ctx.users.marcus, ctx.orgId);
    const who = { userId: ctx.users.marcus, orgId: ctx.orgId, cookieNonce: f.cookieNonce };
    expect(verifyState(cfg, f.state, who, NOW.getTime()).nonce).toBe(f.nonce);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as OAuthStateError).code;
      }
      return "ok";
    };
    const [body, sig] = f.state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: ctx.users.tess })).toString("base64url");
    expect(code(() => verifyState(cfg, `${forged}.${sig}`, { ...who, userId: ctx.users.tess }, NOW.getTime()))).toBe("bad_signature");
    expect(code(() => verifyState(cfg, f.state, { ...who, userId: ctx.users.tess }, NOW.getTime()))).toBe("wrong_user");
    expect(code(() => verifyState(cfg, f.state, { ...who, cookieNonce: null }, NOW.getTime()))).toBe("nonce_mismatch");
    expect(code(() => verifyState(cfg, f.state, { ...who, cookieNonce: "other-browser-nonce-xxxxxxxxxxxx" }, NOW.getTime()))).toBe("nonce_mismatch");
    expect(code(() => verifyState(cfg, f.state, who, NOW.getTime() + 11 * 60_000))).toBe("expired");
    expect(code(() => verifyState(cfg, null, who, NOW.getTime()))).toBe("malformed");
    const otherServer = googleOAuthConfig({ ...ENV, SESSION_SECRET: randomBytes(32).toString("hex") })!;
    expect(code(() => verifyState(otherServer, f.state, who, NOW.getTime()))).toBe("bad_signature");
  });
});

describe("connect, refresh, sync and disconnect (mocked Google)", () => {
  it("rejects a callback whose state belongs to another user without calling Google or storing anything", async () => {
    const tess = await viewerFor(ctx, "tess");
    const g = mockGoogle();
    const f = startFlow(ctx.users.marcus, ctx.orgId);
    await expect(completeGoogleConnection(db(), tess, { code: "c", state: f.state, cookieNonce: f.cookieNonce }, { cfg, fetchImpl: g.fetchImpl, now: NOW })).rejects.toBeInstanceOf(OAuthStateError);
    expect(g.calls).toHaveLength(0);
    expect(await db().select().from(calendarConnections).where(eq(calendarConnections.userId, ctx.users.tess))).toHaveLength(0);
    // Guardians can't connect a calendar at all.
    const alex = await viewerFor(ctx, "alex");
    const fa = startFlow(ctx.users.alex, ctx.orgId);
    await expect(completeGoogleConnection(db(), alex, { code: "c", state: fa.state, cookieNonce: fa.cookieNonce }, { cfg, fetchImpl: g.fetchImpl, now: NOW })).rejects.toBeInstanceOf(AuthzError);
  });

  it("connects a coach: server-side code exchange with PKCE, Teamwork calendar created, tokens encrypted, sync queued", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const g = mockGoogle();
    const f = startFlow(ctx.users.marcus, ctx.orgId);
    const r = await completeGoogleConnection(db(), marcus, { code: "auth-code-123", state: f.state, cookieNonce: f.cookieNonce }, { cfg, fetchImpl: g.fetchImpl, now: NOW });
    expect(r.syncDirection).toBe("both");
    const tokenCall = g.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    const p = new URLSearchParams(tokenCall.body);
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("auth-code-123");
    expect(p.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(pkceChallenge(p.get("code_verifier")!)).toBe(new URL(f.url).searchParams.get("code_challenge"));
    expect(g.calls.some((c) => c.method === "POST" && c.url.endsWith("/calendar/v3/calendars") && c.headers.Authorization === "Bearer access-initial-AAA")).toBe(true);

    const [conn] = await db().select().from(calendarConnections).where(eq(calendarConnections.id, r.connectionId));
    expect(conn).toMatchObject({ userId: ctx.users.marcus, status: "connected", syncDirection: "both", externalCalendarId: "teamwork-cal@group.calendar.google.com", freebusyCalendarId: "primary" });
    const [tok] = await db().select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
    expect(JSON.stringify(tok)).not.toContain("refresh-initial-RRR");
    expect(JSON.stringify(tok)).not.toContain("access-initial-AAA");
    expect(decryptToken(tok.refreshTokenEnc, cfg.tokenKey, conn.id)).toBe("refresh-initial-RRR");

    const queued = await db().select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), inArray(jobs.type, [CALENDAR_SYNC_JOB, CALENDAR_FREEBUSY_JOB])));
    expect(queued.filter((j) => j.type === CALENDAR_FREEBUSY_JOB)).toHaveLength(1);
    expect(r.queuedSessions).toBeGreaterThan(0); // Marcus's seeded upcoming classes
    expect(queued.filter((j) => j.type === CALENDAR_SYNC_JOB).length).toBe(r.queuedSessions);

    // Reconnecting reuses the same row and the existing Teamwork calendar.
    const f2 = startFlow(ctx.users.marcus, ctx.orgId);
    const g2 = mockGoogle();
    const r2 = await completeGoogleConnection(db(), marcus, { code: "auth-code-456", state: f2.state, cookieNonce: f2.cookieNonce }, { cfg, fetchImpl: g2.fetchImpl, now: NOW });
    expect(r2.connectionId).toBe(r.connectionId);
    expect(g2.calls.some((c) => c.method === "POST" && c.url.endsWith("/calendars"))).toBe(false);
  });

  it("uses the cached access token, refreshes on expiry (with rotation), and pushes sessions with the real token", async () => {
    const [conn] = await db().select().from(calendarConnections).where(eq(calendarConnections.userId, ctx.users.marcus));
    const g = mockGoogle({ refresh: () => Response.json({ access_token: "access-refreshed-1", refresh_token: "refresh-rotated-ZZZ", expires_in: 3599, scope: CALENDAR_SCOPES.join(" ") }) });
    // Fresh token: no network.
    expect(await getAccessToken(db(), conn.id, { cfg, fetchImpl: g.fetchImpl, now: () => NOW })).toBe("access-initial-AAA");
    expect(g.calls).toHaveLength(0);
    // 59 minutes later the token is within the 60 s skew → refresh.
    const later = new Date(NOW.getTime() + 59 * 60_000 + 30_000);
    expect(await getAccessToken(db(), conn.id, { cfg, fetchImpl: g.fetchImpl, now: () => later })).toBe("access-refreshed-1");
    const p = new URLSearchParams(g.calls[0].body);
    expect(p.get("grant_type")).toBe("refresh_token");
    expect(p.get("refresh_token")).toBe("refresh-initial-RRR");
    const [tok] = await db().select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id));
    expect(decryptToken(tok.refreshTokenEnc, cfg.tokenKey, conn.id)).toBe("refresh-rotated-ZZZ");
    expect(tok.accessTokenExpiresAt!.getTime()).toBe(later.getTime() + 3599_000);

    // Job queue → real provider factory → Calendar API with the bearer token.
    const erin = await viewerFor(ctx, "erin");
    const s = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(addDaysYmd("2026-03-02", 15), "13:00", TZ), coachUserId: ctx.users.marcus }));
    const g2 = mockGoogle();
    const factory = googleProviderFactory({ env: ENV, fetchImpl: g2.fetchImpl, now: () => later });
    await db().transaction((tx) => runJobs(tx, calendarJobHandlers(tx, factory), "test-worker", 500, { orgId: ctx.orgId }));
    const [link] = await db().select().from(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, conn.id), eq(calendarEventLinks.sessionId, s.id)));
    expect(link.status).toBe("synced");
    const push = g2.calls.find((c) => c.method === "POST" && c.url.includes(encodeURIComponent("teamwork-cal@group.calendar.google.com")))!;
    expect(push.headers.Authorization).toBe("Bearer access-refreshed-1");
    const fb = g2.calls.find((c) => c.url.endsWith("/freeBusy"))!;
    expect(JSON.parse(fb.body).items).toEqual([{ id: "primary" }]);
  });

  it("marks the connection error with a reconnect message when the refresh token is revoked", async () => {
    const [conn] = await db().select().from(calendarConnections).where(eq(calendarConnections.userId, ctx.users.marcus));
    await db().update(calendarOauthTokens).set({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) }).where(eq(calendarOauthTokens.connectionId, conn.id));
    const g = mockGoogle({ refresh: () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }) });
    const err = await getAccessToken(db(), conn.id, { cfg, fetchImpl: g.fetchImpl, now: () => NOW }).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(RECONNECT_MESSAGE);
    const [after] = await db().select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(after.status).toBe("error");
    expect(after.lastError).toBe(RECONNECT_MESSAGE);
    expect(await db().select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, conn.id))).toHaveLength(0);
    // The factory now refuses to build a provider → honest "not connected" instead of retry storms.
    expect(await googleProviderFactory({ env: ENV })(after, db())).toBeNull();
  });

  it("a network error during refresh is retryable and leaves the connection alone", async () => {
    const tess = await viewerFor(ctx, "tess");
    const f = startFlow(ctx.users.tess, ctx.orgId);
    const r = await completeGoogleConnection(db(), tess, { code: "c-tess", state: f.state, cookieNonce: f.cookieNonce }, { cfg, fetchImpl: mockGoogle().fetchImpl, now: NOW });
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await getAccessToken(db(), r.connectionId, { cfg, fetchImpl: failing, now: () => new Date(NOW.getTime() + 2 * 3600_000) }).catch((e) => e);
    expect(err.retryable).toBe(true);
    const [c] = await db().select().from(calendarConnections).where(eq(calendarConnections.id, r.connectionId));
    expect(c.status).toBe("connected");
  });

  it("coaches disconnect only their own calendar (revoking at Google); owner/admin can disconnect anyone", async () => {
    const [tessConn] = await db().select().from(calendarConnections).where(eq(calendarConnections.userId, ctx.users.tess));
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin"); // operations: schedule.manage but not integrations.manage
    const g = mockGoogle();
    await expect(disconnectCalendar(db(), marcus, { connectionId: tessConn.id }, { cfg, fetchImpl: g.fetchImpl })).rejects.toBeInstanceOf(AuthzError);
    await expect(disconnectCalendar(db(), erin, { connectionId: tessConn.id }, { cfg, fetchImpl: g.fetchImpl })).rejects.toBeInstanceOf(AuthzError);
    expect(g.calls).toHaveLength(0);

    // Tess disconnects her own: the refresh token is revoked at Google, then deleted locally.
    const tess = await viewerFor(ctx, "tess");
    const res = await disconnectCalendar(db(), tess, { connectionId: tessConn.id }, { cfg, fetchImpl: g.fetchImpl });
    expect(res.revoked).toBe(true);
    const revoke = g.calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke")!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("refresh-initial-RRR");
    expect(await db().select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, tessConn.id))).toHaveLength(0);
    expect((await db().select().from(calendarConnections).where(eq(calendarConnections.id, tessConn.id)))[0].status).toBe("disabled");

    // Owner disconnects a coach; tokens are deleted even when Google can't be reached.
    const f = startFlow(ctx.users.tess, ctx.orgId);
    await completeGoogleConnection(db(), tess, { code: "c-tess-2", state: f.state, cookieNonce: f.cookieNonce }, { cfg, fetchImpl: mockGoogle().fetchImpl, now: NOW });
    const rod = await viewerFor(ctx, "rod");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r2 = await disconnectCalendar(db(), rod, { connectionId: tessConn.id }, { cfg, fetchImpl: down });
    expect(r2.revoked).toBe(false);
    expect(await db().select().from(calendarOauthTokens).where(eq(calendarOauthTokens.connectionId, tessConn.id))).toHaveLength(0);
    // Another org's admin can't touch it.
    await expect(disconnectCalendar(db(), { ...rod, orgId: "00000000-0000-0000-0000-000000000000" }, { connectionId: tessConn.id }, { cfg })).rejects.toBeInstanceOf(AuthzError);
  });

  it("tokens and the client secret never appear in audit events or job payloads", async () => {
    const events = await db().select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
    const cal = events.filter((e) => e.action.startsWith("calendar."));
    expect(cal.map((e) => e.action)).toEqual(expect.arrayContaining(["calendar.connected", "calendar.disconnected", "calendar.token_refresh_failed"]));
    const dump = JSON.stringify(events) + JSON.stringify(await db().select().from(jobs).where(eq(jobs.orgId, ctx.orgId)));
    for (const s of SECRETS) expect(dump).not.toContain(s);
    const links = JSON.stringify(await db().select().from(calendarConnections).where(eq(calendarConnections.orgId, ctx.orgId)));
    for (const s of SECRETS) expect(links).not.toContain(s);
  });
});

it("reports a decryption failure as a reconnect-required error, not a crash", async () => {
  const d = db();
  const [conn] = await d.insert(calendarConnections).values({ orgId: ctx.orgId, userId: ctx.users.rod, externalCalendarId: "x", status: "connected" }).returning();
  await d.insert(calendarOauthTokens).values({ connectionId: conn.id, orgId: ctx.orgId, refreshTokenEnc: encryptToken("r", deriveTokenKey(randomBytes(32).toString("base64")), conn.id), scopes: "" });
  const err = await getAccessToken(d, conn.id, { cfg, now: () => NOW }).catch((e) => e);
  expect(err.retryable).toBe(false);
  expect((await d.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id)))[0].status).toBe("error");
});
