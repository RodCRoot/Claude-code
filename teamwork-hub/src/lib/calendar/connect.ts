import { and, asc, eq, gt, lt, ne } from "drizzle-orm";
import type { DB } from "@/db";
import { calendarConnections, calendarEventLinks, organizations, scheduleSessions } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { enqueue } from "@/lib/jobs";
import { DEFAULT_TZ } from "@/lib/time";
import { GoogleCalendarProvider } from "./google";
import { CALENDAR_SCOPES, exchangeCode, grantedScopes, SCOPE_APP_CALENDAR, SCOPE_FREEBUSY, verifyState, type GoogleOAuthConfig } from "./oauth";
import { CALENDAR_FREEBUSY_JOB, queueCalendarSync } from "./sync";
import { storeTokens } from "./tokens";

const CONNECT_ROLES = ["owner", "admin", "operations", "coach"];
export const TEAMWORK_CALENDAR_NAME = "Teamwork Hub";
/** How far ahead to push existing sessions / import busy time right after connecting. */
const INITIAL_PUSH_DAYS = 60;
const INITIAL_FREEBUSY_DAYS = 28;

export class CalendarConnectError extends Error {
  constructor(
    public code: "no_refresh_token" | "no_scopes",
    message: string,
  ) {
    super(message);
    this.name = "CalendarConnectError";
  }
}

/** Only staff may connect, and only their own calendar (the connection is always for the signed-in user). */
export function assertCanConnect(v: Viewer) {
  if (!CONNECT_ROLES.includes(v.role)) throw new AuthzError("Only staff can connect a Google Calendar.");
}

/**
 * OAuth callback: validate `state` (signed, unexpired, same user + browser), exchange the code
 * server-side (with the PKCE verifier), make sure the Teamwork-owned calendar exists, store the
 * tokens encrypted, mark the connection `connected`, then queue an initial push + free/busy import.
 * The connection is always the signed-in viewer's — no user id is ever taken from the request.
 */
export async function completeGoogleConnection(
  dbh: DB,
  v: Viewer,
  input: { code: string; state: string | null; cookieNonce: string | null | undefined },
  deps: { cfg: GoogleOAuthConfig; fetchImpl?: typeof fetch; now?: Date },
) {
  assertCanConnect(v);
  const now = deps.now ?? new Date();
  const { nonce } = verifyState(deps.cfg, input.state, { userId: v.userId, orgId: v.orgId, cookieNonce: input.cookieNonce }, now.getTime());
  const t = await exchangeCode(deps.cfg, input.code, nonce, deps.fetchImpl);
  if (!t.refresh_token) {
    throw new CalendarConnectError("no_refresh_token", "Google did not return a long-lived authorization. Remove “Teamwork Hub” under Google Account → Security → Third-party access, then connect again.");
  }
  // Granular consent: the coach may untick a permission. Work with what was actually granted.
  const granted = t.scope ? grantedScopes(t.scope) : new Set(CALENDAR_SCOPES);
  const canPush = granted.has(SCOPE_APP_CALENDAR);
  const canFreeBusy = granted.has(SCOPE_FREEBUSY);
  if (!canPush && !canFreeBusy) throw new CalendarConnectError("no_scopes", "No calendar permissions were granted, so nothing was connected.");
  const syncDirection = canPush && canFreeBusy ? "both" : canPush ? "push_events" : "freebusy_only";

  const [existing] = await dbh
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.orgId, v.orgId), eq(calendarConnections.userId, v.userId), eq(calendarConnections.provider, "google")));

  // Ensure the Teamwork-owned calendar exists (network, outside the DB transaction).
  let externalCalendarId = existing?.externalCalendarId ?? null;
  let calendarReplaced = false;
  if (canPush) {
    const provider = new GoogleCalendarProvider({ getAccessToken: async () => t.access_token, fetchImpl: deps.fetchImpl });
    if (!externalCalendarId || !(await provider.calendarExists(externalCalendarId))) {
      const [org] = await dbh.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, v.orgId));
      calendarReplaced = !!externalCalendarId;
      externalCalendarId = await provider.createCalendar(TEAMWORK_CALENDAR_NAME, org?.tz ?? DEFAULT_TZ);
    }
  }

  return dbh.transaction(async (tx) => {
    const values = {
      orgId: v.orgId,
      userId: v.userId,
      provider: "google",
      externalCalendarId,
      freebusyCalendarId: canFreeBusy ? "primary" : null,
      status: "connected" as const,
      syncDirection: syncDirection as "both" | "push_events" | "freebusy_only",
      lastError: null,
      connectedAt: now,
    };
    const [conn] = await tx
      .insert(calendarConnections)
      .values(values)
      .onConflictDoUpdate({ target: [calendarConnections.orgId, calendarConnections.userId, calendarConnections.provider], set: values })
      .returning();
    // Old event copies lived in a calendar that no longer exists: forget them so sessions re-push.
    if (calendarReplaced) await tx.delete(calendarEventLinks).where(eq(calendarEventLinks.connectionId, conn.id));
    await storeTokens(tx, deps.cfg, conn, { ...t, refresh_token: t.refresh_token!, scope: [...granted].join(" ") }, now);
    await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "calendar.connected", "calendar_connection", conn.id, {
      summary: `Connected Google Calendar (${syncDirection === "both" ? "push sessions + import busy time" : syncDirection === "push_events" ? "push sessions only" : "import busy time only"}).`,
      after: { status: "connected", syncDirection, scopes: [...granted] },
    });

    let queued = 0;
    if (canPush) {
      const upcoming = await tx
        .select({ id: scheduleSessions.id })
        .from(scheduleSessions)
        .where(
          and(
            eq(scheduleSessions.orgId, v.orgId),
            eq(scheduleSessions.coachUserId, v.userId),
            ne(scheduleSessions.status, "cancelled"),
            gt(scheduleSessions.startsAt, now),
            lt(scheduleSessions.startsAt, new Date(now.getTime() + INITIAL_PUSH_DAYS * 86_400_000)),
          ),
        )
        .orderBy(asc(scheduleSessions.startsAt))
        .limit(500);
      for (const s of upcoming) queued += (await queueCalendarSync(tx, s.id)) > 0 ? 1 : 0;
    }
    if (canFreeBusy) {
      const from = now;
      const to = new Date(now.getTime() + INITIAL_FREEBUSY_DAYS * 86_400_000);
      await enqueue(tx, {
        type: CALENDAR_FREEBUSY_JOB,
        orgId: v.orgId,
        payload: { connectionId: conn.id, from: from.toISOString(), to: to.toISOString() },
        dedupeKey: `${CALENDAR_FREEBUSY_JOB}:${conn.id}:${from.toISOString().slice(0, 16)}`,
        maxAttempts: 5,
      });
    }
    return { connectionId: conn.id, syncDirection, queuedSessions: queued };
  });
}
