import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { busyBlocks, calendarConnections, calendarEventLinks, resources, scheduleSessions } from "@/db/schema";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { googleConfigured } from "./google";
import { CalendarConflictError, CalendarProviderError, type BusyInterval, type CalendarProvider } from "./types";

type Connection = typeof calendarConnections.$inferSelect;

export const CALENDAR_SYNC_JOB = "calendar.sync_session";
export const CALENDAR_FREEBUSY_JOB = "calendar.import_freebusy";

/**
 * Queue a push of this session's current state to every connected calendar of its coach
 * (and of the previous coach after a substitution, so their copy gets deleted).
 * Runs inside the business transaction (transactional outbox). No-op without connections.
 */
export async function queueCalendarSync(tx: Tx, sessionId: string, opts: { previousCoachUserId?: string | null } = {}) {
  const [s] = await tx.select().from(scheduleSessions).where(eq(scheduleSessions.id, sessionId));
  if (!s) return 0;
  const userIds = [s.coachUserId, opts.previousCoachUserId].filter((x): x is string => !!x);
  const linkedConnIds = (await tx.select({ id: calendarEventLinks.connectionId }).from(calendarEventLinks).where(eq(calendarEventLinks.sessionId, s.id))).map((r) => r.id);
  if (!userIds.length && !linkedConnIds.length) return 0;
  const conns = await tx
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.orgId, s.orgId),
        eq(calendarConnections.status, "connected"),
        inArray(calendarConnections.syncDirection, ["push_events", "both"]),
        sql`(${userIds.length ? inArray(calendarConnections.userId, userIds) : sql`false`} or ${linkedConnIds.length ? inArray(calendarConnections.id, linkedConnIds) : sql`false`})`,
      ),
    );
  for (const c of conns) {
    await tx
      .insert(calendarEventLinks)
      .values({ connectionId: c.id, sessionId: s.id, status: "pending" })
      .onConflictDoUpdate({ target: [calendarEventLinks.connectionId, calendarEventLinks.sessionId], set: { status: "pending", updatedAt: new Date() } });
    await enqueue(tx, {
      type: CALENDAR_SYNC_JOB,
      orgId: s.orgId,
      payload: { connectionId: c.id, sessionId: s.id },
      dedupeKey: `${CALENDAR_SYNC_JOB}:${c.id}:${s.id}:v${s.version}:${s.status}`,
      maxAttempts: 8,
    });
  }
  return conns.length;
}

export type ProviderFactory = (connection: Connection) => Promise<CalendarProvider | null>;

/**
 * Default factory: returns null until Google OAuth is configured AND a token store exists for the
 * connection. (The OAuth connect flow/token storage is a documented follow-up; until then sync
 * honestly reports "not configured" and internal scheduling is unaffected.)
 */
export const defaultProviderFactory: ProviderFactory = async () => {
  if (!googleConfigured()) return null;
  return null;
};

/** Push/update/delete one session copy. Teamwork wins conflicts: an externally edited event is overwritten. */
export async function syncSessionToCalendar(tx: Tx, provider: CalendarProvider | null, input: { connectionId: string; sessionId: string }) {
  const [conn] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, input.connectionId));
  const [link] = await tx
    .select()
    .from(calendarEventLinks)
    .where(and(eq(calendarEventLinks.connectionId, input.connectionId), eq(calendarEventLinks.sessionId, input.sessionId)))
    .for("update");
  const [s] = await tx.select().from(scheduleSessions).where(eq(scheduleSessions.id, input.sessionId));
  if (!conn || !link || !s) return { action: "skipped" as const, reason: "missing" };
  const fail = async (msg: string, status: "error" | "conflict" = "error") => {
    await tx
      .update(calendarEventLinks)
      .set({ status, lastError: msg.slice(0, 500), attempts: link.attempts + 1, updatedAt: new Date() })
      .where(eq(calendarEventLinks.id, link.id));
  };
  if (!provider || !conn.externalCalendarId) {
    await fail("Google Calendar is not configured for this connection.");
    return { action: "skipped" as const, reason: "not_configured" };
  }
  const shouldExist = s.status !== "cancelled" && s.coachUserId === conn.userId;
  try {
    if (!shouldExist) {
      if (link.externalEventId) await provider.deleteEvent(conn.externalCalendarId, link.externalEventId);
      await tx
        .update(calendarEventLinks)
        .set({ status: "deleted", pushedVersion: s.version, lastError: null, attempts: link.attempts + 1, updatedAt: new Date() })
        .where(eq(calendarEventLinks.id, link.id));
      return { action: "deleted" as const };
    }
    let location: string | undefined;
    if (s.resourceId) location = (await tx.select({ name: resources.name }).from(resources).where(eq(resources.id, s.resourceId)))[0]?.name;
    const event = {
      teamworkSessionId: s.id,
      summary: s.title,
      description: "Managed by Teamwork Hub — edit this session in Teamwork; changes made here will be overwritten.",
      location,
      start: s.startsAt,
      end: s.endsAt,
      timezone: s.timezone,
    };
    let pushed;
    let note: string | null = null;
    if (link.externalEventId) {
      try {
        pushed = await provider.updateEvent(conn.externalCalendarId, link.externalEventId, event, link.etag);
      } catch (e) {
        if (!(e instanceof CalendarConflictError)) throw e;
        // Source of truth is Teamwork: overwrite the external edit and note it.
        pushed = await provider.updateEvent(conn.externalCalendarId, link.externalEventId, event, null);
        note = "External edit overwritten (Teamwork is the source of truth).";
      }
    } else {
      pushed = await provider.pushEvent(conn.externalCalendarId, event);
    }
    await tx
      .update(calendarEventLinks)
      .set({ status: "synced", externalEventId: pushed.externalEventId, etag: pushed.etag, pushedVersion: s.version, lastError: note, attempts: link.attempts + 1, updatedAt: new Date() })
      .where(eq(calendarEventLinks.id, link.id));
    await tx.update(calendarConnections).set({ lastSyncAt: new Date(), lastError: null }).where(eq(calendarConnections.id, conn.id));
    return { action: link.externalEventId ? ("updated" as const) : ("pushed" as const), note };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail(msg);
    // Retryable errors go back to the job queue (exponential backoff); permanent ones stop here.
    if (e instanceof CalendarProviderError && !e.retryable) return { action: "failed" as const, reason: msg };
    throw e;
  }
}

/** Replace a coach's imported Google busy time inside [from, to) with fresh intervals. */
export async function importFreeBusy(tx: Tx, input: { orgId: string; coachUserId: string; from: Date; to: Date; busy: BusyInterval[] }) {
  await tx
    .delete(busyBlocks)
    .where(
      and(
        eq(busyBlocks.orgId, input.orgId),
        eq(busyBlocks.coachUserId, input.coachUserId),
        eq(busyBlocks.source, "google_freebusy"),
        lt(busyBlocks.startsAt, input.to),
        gt(busyBlocks.endsAt, input.from),
      ),
    );
  const rows = input.busy.filter((b) => b.end > b.start);
  if (rows.length) {
    await tx.insert(busyBlocks).values(
      rows.map((b) => ({ orgId: input.orgId, coachUserId: input.coachUserId, startsAt: b.start, endsAt: b.end, source: "google_freebusy" as const, reason: "Busy (Google Calendar)", fetchedAt: new Date() })),
    );
  }
  return { imported: rows.length };
}

export async function syncFreeBusy(tx: Tx, provider: CalendarProvider | null, input: { connectionId: string; from: Date; to: Date }) {
  const [conn] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, input.connectionId));
  if (!conn) return { imported: 0, skipped: "missing" as const };
  if (!provider || !conn.externalCalendarId || conn.status !== "connected" || conn.syncDirection === "push_events") return { imported: 0, skipped: "not_configured" as const };
  try {
    const busy = await provider.freeBusy(conn.externalCalendarId, input.from, input.to);
    const r = await importFreeBusy(tx, { orgId: conn.orgId, coachUserId: conn.userId, from: input.from, to: input.to, busy });
    await tx.update(calendarConnections).set({ lastSyncAt: new Date(), lastError: null }).where(eq(calendarConnections.id, conn.id));
    return r;
  } catch (e) {
    await tx.update(calendarConnections).set({ lastError: (e as Error).message.slice(0, 500) }).where(eq(calendarConnections.id, conn.id));
    throw e;
  }
}

/** Job handlers for the worker (`runJobs(tx, { ...calendarJobHandlers(tx) })`). */
export function calendarJobHandlers(tx: Tx, factory: ProviderFactory = defaultProviderFactory): Record<string, JobHandler> {
  return {
    [CALENDAR_SYNC_JOB]: async (payload) => {
      const connectionId = String(payload.connectionId);
      const [conn] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId));
      return syncSessionToCalendar(tx, conn ? await factory(conn) : null, { connectionId, sessionId: String(payload.sessionId) });
    },
    [CALENDAR_FREEBUSY_JOB]: async (payload) => {
      const connectionId = String(payload.connectionId);
      const [conn] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId));
      const from = new Date(String(payload.from));
      const to = new Date(String(payload.to));
      return syncFreeBusy(tx, conn ? await factory(conn) : null, { connectionId, from, to });
    },
  };
}

/** Integration status for Settings → Calendar. */
export async function calendarStatus(tx: Tx, orgId: string) {
  const conns = await tx.select().from(calendarConnections).where(eq(calendarConnections.orgId, orgId));
  const counts = conns.length
    ? ((
        await tx.execute(sql`select status, count(*)::int as n from calendar_event_links where connection_id in ${conns.map((c) => c.id)} group by status`)
      ).rows as { status: string; n: number }[])
    : [];
  return { configured: googleConfigured(), connections: conns, linkCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number> };
}
