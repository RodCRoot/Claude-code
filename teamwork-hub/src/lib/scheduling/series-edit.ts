import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { classSeries, resources, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { queueCalendarSync } from "@/lib/calendar/sync";
import { enqueue } from "@/lib/jobs";
import { addDaysYmd, fmt, localToUtc, localYmd } from "@/lib/time";
import { actorOf, getSession, withConflictMessage, type Session } from "./common";
import { assertCoach, cancelSession } from "./sessions";

/**
 * Series edits: "this session only" / "this and all future" / "entire series (all upcoming)".
 *
 * Rules
 * - Only sessions that haven't started and aren't cancelled are edited; history is never rewritten.
 * - Every session to be touched is locked FOR UPDATE in id order (same lock bookings take), so
 *   capacity checks and edits can't race bookings or another bulk edit.
 * - Bookings are always kept. A capacity/waitlist decrease below what a session already holds is a
 *   conflict, listed per session; nothing is written unless the staff member chose how to resolve it:
 *     refuse (default)              → no changes, conflicts returned
 *     skip_conflicting              → those sessions keep their current capacity/waitlist size
 *     keep_bookings_over_capacity   → apply the new size; existing bookings stay (session is over
 *                                     capacity, so new bookings join the waitlist / are refused)
 * - Each changed session gets version+1, a calendar sync, an audit row and — when time, coach or
 *   room changed — a `notify.session_changed` job deduped by `<sessionId>:<version>`.
 * - "following"/"all" also update the series template so future generation matches.
 */

export type SeriesEditScope = "this" | "following" | "all";
export type CapacityConflictMode = "refuse" | "skip_conflicting" | "keep_bookings_over_capacity";

export type SeriesEditChanges = {
  /** Local start time "HH:MM", applied on each session's own local date (DST-safe). */
  startTimeLocal?: string;
  durationMinutes?: number;
  coachUserId?: string | null;
  resourceId?: string | null;
  capacity?: number;
  waitlistCapacity?: number;
};

export type CapacityConflict = {
  sessionId: string;
  title: string;
  startsAt: Date;
  occupying: number;
  waitlisted: number;
  capacity: number;
  waitlistCapacity: number;
  newCapacity: number;
  newWaitlistCapacity: number;
};

export type SeriesEditResult =
  | { applied: false; conflicts: CapacityConflict[]; sessionCount: number }
  | { applied: true; conflicts: CapacityConflict[]; sessionCount: number; updated: number; notified: number; keptCapacity: string[] };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(c: SeriesEditChanges) {
  const keys = (Object.keys(c) as (keyof SeriesEditChanges)[]).filter((k) => c[k] !== undefined);
  if (!keys.length) throw new UserError("Nothing to change. Pick a new time, coach, room or capacity.");
  if (c.startTimeLocal !== undefined && !HHMM.test(c.startTimeLocal)) throw new UserError("Enter the start time as HH:MM.", { startTimeLocal: "HH:MM" });
  if (c.durationMinutes !== undefined && (!Number.isInteger(c.durationMinutes) || c.durationMinutes < 5 || c.durationMinutes > 24 * 60)) {
    throw new UserError("Duration must be 5–1440 minutes.", { durationMinutes: "5–1440" });
  }
  if (c.capacity !== undefined && (!Number.isInteger(c.capacity) || c.capacity < 0 || c.capacity > 500)) throw new UserError("Capacity must be 0–500.", { capacity: "0–500" });
  if (c.waitlistCapacity !== undefined && (!Number.isInteger(c.waitlistCapacity) || c.waitlistCapacity < 0 || c.waitlistCapacity > 200)) {
    throw new UserError("Waitlist size must be 0–200.", { waitlistCapacity: "0–200" });
  }
}

/** Sessions a scope covers (ids only, unlocked). */
async function scopeSessionIds(tx: Tx, v: Viewer, anchor: Session, scope: SeriesEditScope, now: Date): Promise<string[]> {
  if (scope === "this") return [anchor.id];
  if (!anchor.seriesId) throw new UserError("This session isn't part of a series. Edit it on its own.");
  const rows = await tx
    .select({ id: scheduleSessions.id })
    .from(scheduleSessions)
    .where(
      and(
        eq(scheduleSessions.orgId, v.orgId),
        eq(scheduleSessions.seriesId, anchor.seriesId),
        eq(scheduleSessions.status, "scheduled"),
        gt(scheduleSessions.startsAt, now),
        scope === "following" ? gte(scheduleSessions.startsAt, anchor.startsAt) : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

/** Lock sessions FOR UPDATE in id order (deadlock-free against other multi-session operations). */
export async function lockSessionsInOrder(tx: Tx, orgId: string, ids: string[]): Promise<Session[]> {
  if (!ids.length) return [];
  return tx
    .select()
    .from(scheduleSessions)
    .where(and(eq(scheduleSessions.orgId, orgId), inArray(scheduleSessions.id, ids)))
    .orderBy(asc(scheduleSessions.id))
    .for("update");
}

async function counts(tx: Tx, ids: string[]) {
  const m = new Map<string, { occupying: number; waitlisted: number }>();
  if (!ids.length) return m;
  const res = await tx.execute(sql`
    select session_id,
      count(*) filter (where status in ('booked','attended','no_show'))::int as occupying,
      count(*) filter (where status = 'waitlisted')::int as waitlisted
    from bookings where session_id in ${ids} group by session_id`);
  for (const r of res.rows as { session_id: string; occupying: number; waitlisted: number }[]) m.set(r.session_id, { occupying: r.occupying, waitlisted: r.waitlisted });
  return m;
}

export async function editSeriesSessions(
  tx: Tx,
  v: Viewer,
  input: { sessionId: string; version: number; scope: SeriesEditScope; changes: SeriesEditChanges; onCapacityConflict?: CapacityConflictMode; now?: Date },
): Promise<SeriesEditResult> {
  assertCan(v, "schedule.manage");
  const now = input.now ?? new Date();
  const mode = input.onCapacityConflict ?? "refuse";
  const c = input.changes;
  validate(c);
  if (c.coachUserId) await assertCoach(tx, v.orgId, c.coachUserId);
  let exclusiveResource: boolean | undefined;
  if (c.resourceId !== undefined) {
    exclusiveResource = false;
    if (c.resourceId) {
      const [r] = await tx.select().from(resources).where(and(eq(resources.id, c.resourceId), eq(resources.orgId, v.orgId)));
      if (!r) throw new UserError("Room / area not found.");
      exclusiveResource = r.exclusive;
    }
  }

  const anchor0 = await getSession(tx, v.orgId, input.sessionId);
  const ids = await scopeSessionIds(tx, v, anchor0, input.scope, now);
  if (!ids.includes(anchor0.id)) ids.push(anchor0.id);
  const locked = await lockSessionsInOrder(tx, v.orgId, ids);
  const anchor = locked.find((s) => s.id === anchor0.id)!;
  if (anchor.version !== input.version) throw new UserError("Someone else changed this session. Reload and try again.");
  if (anchor.status !== "scheduled") throw new UserError("This session is cancelled.");
  if (anchor.startsAt <= now) throw new UserError("This session has already started; past sessions can't be edited from here.");
  // Re-check scope membership under the lock (a concurrent cancel may have removed some).
  const targets = locked
    .filter((s) => s.status === "scheduled" && s.startsAt > now && (input.scope !== "following" || s.startsAt >= anchor.startsAt))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  // --- Capacity conflicts (never drop booked or waitlisted athletes) --------------------------
  const occ = await counts(tx, targets.map((s) => s.id));
  const conflicts: CapacityConflict[] = [];
  for (const s of targets) {
    const o = occ.get(s.id) ?? { occupying: 0, waitlisted: 0 };
    const newCapacity = c.capacity ?? s.capacity;
    const newWaitlistCapacity = c.waitlistCapacity ?? s.waitlistCapacity;
    if ((c.capacity !== undefined && o.occupying > newCapacity) || (c.waitlistCapacity !== undefined && o.waitlisted > newWaitlistCapacity)) {
      conflicts.push({ sessionId: s.id, title: s.title, startsAt: s.startsAt, ...o, capacity: s.capacity, waitlistCapacity: s.waitlistCapacity, newCapacity, newWaitlistCapacity });
    }
  }
  if (conflicts.length && mode === "refuse") return { applied: false, conflicts, sessionCount: targets.length };
  const conflictIds = new Set(conflicts.map((x) => x.sessionId));

  // --- Apply ---------------------------------------------------------------------------------
  let updated = 0;
  let notified = 0;
  const keptCapacity: string[] = [];
  for (const s of targets) {
    const tz = s.timezone;
    const duration = c.durationMinutes ?? Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000);
    const startsAt = c.startTimeLocal ? localToUtc(localYmd(s.startsAt, tz), c.startTimeLocal, tz) : s.startsAt;
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    if (startsAt <= now) throw new UserError(`The new time for ${fmt(s.startsAt, "EEE MMM d", tz)} would already have started. Choose a later time or edit from a later session.`);
    const skipCap = conflictIds.has(s.id) && mode === "skip_conflicting";
    if (skipCap) keptCapacity.push(s.id);
    const capacity = skipCap ? s.capacity : (c.capacity ?? s.capacity);
    const waitlistCapacity = skipCap ? s.waitlistCapacity : (c.waitlistCapacity ?? s.waitlistCapacity);
    const coachUserId = c.coachUserId !== undefined ? c.coachUserId : s.coachUserId;
    const resourceId = c.resourceId !== undefined ? c.resourceId : s.resourceId;

    const timeChanged = startsAt.getTime() !== s.startsAt.getTime() || endsAt.getTime() !== s.endsAt.getTime();
    const coachChanged = coachUserId !== s.coachUserId;
    const roomChanged = resourceId !== s.resourceId;
    const capChanged = capacity !== s.capacity || waitlistCapacity !== s.waitlistCapacity;
    if (!timeChanged && !coachChanged && !roomChanged && !capChanged) continue;

    // One session = substitution (original coach kept for history); following/all = reassignment.
    const originalCoachUserId = coachChanged ? (input.scope === "this" ? (s.originalCoachUserId ?? s.coachUserId) : null) : s.originalCoachUserId;
    const version = s.version + 1;
    await withConflictMessage(
      () =>
        tx
          .update(scheduleSessions)
          .set({
            startsAt,
            endsAt,
            coachUserId,
            originalCoachUserId,
            resourceId,
            exclusiveResource: roomChanged ? (exclusiveResource ?? false) : s.exclusiveResource,
            capacity,
            waitlistCapacity,
            version,
            updatedAt: now,
          })
          .where(eq(scheduleSessions.id, s.id)),
      `${s.title} on ${fmt(s.startsAt, "EEE MMM d", tz)} would overlap another session for the same coach or an exclusive room. Nothing was changed.`,
    );
    updated++;
    await queueCalendarSync(tx, s.id, coachChanged ? { previousCoachUserId: s.coachUserId } : {});
    const what = [timeChanged && "time", coachChanged && "coach", roomChanged && "room", capChanged && "capacity"].filter(Boolean) as string[];
    if (timeChanged || coachChanged || roomChanged) {
      const id = await enqueue(tx, {
        type: "notify.session_changed",
        orgId: v.orgId,
        payload: { sessionId: s.id, version, changes: what.filter((w) => w !== "capacity") },
        dedupeKey: `notify.session_changed:${s.id}:${version}`,
      });
      if (id) notified++;
    }
    await audit(tx, actorOf(v), "session.series_edit", "schedule_session", s.id, {
      summary: `Edited ${s.title} ${fmt(s.startsAt, "EEE MMM d h:mm a", tz)} (${input.scope === "this" ? "this session only" : input.scope === "following" ? "this and following" : "entire series"}): ${what.join(", ")}${skipCap ? " — capacity kept (bookings exceed new size)" : ""}`,
      before: { startsAt: s.startsAt, endsAt: s.endsAt, coachUserId: s.coachUserId, resourceId: s.resourceId, capacity: s.capacity, waitlistCapacity: s.waitlistCapacity, version: s.version },
      after: { startsAt, endsAt, coachUserId, resourceId, capacity, waitlistCapacity, version },
    });
  }

  // --- Template ------------------------------------------------------------------------------
  if (input.scope !== "this" && anchor.seriesId) {
    const [series] = await tx.select().from(classSeries).where(and(eq(classSeries.id, anchor.seriesId), eq(classSeries.orgId, v.orgId))).for("update");
    if (series) {
      const set: Partial<typeof classSeries.$inferInsert> = {};
      if (c.startTimeLocal) set.startTimeLocal = c.startTimeLocal;
      if (c.durationMinutes !== undefined) set.durationMinutes = c.durationMinutes;
      if (c.coachUserId !== undefined) set.coachUserId = c.coachUserId;
      if (c.resourceId !== undefined) set.resourceId = c.resourceId;
      if (c.capacity !== undefined) set.capacity = c.capacity;
      if (c.waitlistCapacity !== undefined) set.waitlistCapacity = c.waitlistCapacity;
      await tx.update(classSeries).set(set).where(eq(classSeries.id, series.id));
      await audit(tx, actorOf(v), "series.update", "class_series", series.id, {
        summary: `Series "${series.title}" updated from ${fmt(anchor.startsAt, "MMM d", anchor.timezone)} (${input.scope}); ${updated} upcoming session(s) changed`,
        before: { startTimeLocal: series.startTimeLocal, durationMinutes: series.durationMinutes, coachUserId: series.coachUserId, resourceId: series.resourceId, capacity: series.capacity, waitlistCapacity: series.waitlistCapacity },
        after: set,
      });
    }
  }
  return { applied: true, conflicts, sessionCount: targets.length, updated, notified, keptCapacity };
}

/**
 * Cancel every upcoming session of a series from a local date (inclusive) and end the series
 * the day before, so generation stops. Each session goes through `cancelSession` (credits released,
 * waitlist cleared, one `notify.session_cancelled` per session). Sessions are locked in id order first.
 */
export async function cancelSeriesFrom(tx: Tx, v: Viewer, input: { seriesId: string; fromYmd: string; reason: string; now?: Date }) {
  assertCan(v, "schedule.manage");
  const now = input.now ?? new Date();
  if (!input.reason.trim()) throw new UserError("A reason is required to cancel sessions.", { reason: "Required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromYmd)) throw new UserError("Pick a start date.", { fromYmd: "Required" });
  const [series] = await tx.select().from(classSeries).where(and(eq(classSeries.id, input.seriesId), eq(classSeries.orgId, v.orgId))).for("update");
  if (!series) throw new UserError("Series not found.");
  const from = localToUtc(input.fromYmd, "00:00", series.timezone);
  const candidates = await tx
    .select({ id: scheduleSessions.id })
    .from(scheduleSessions)
    .where(and(eq(scheduleSessions.orgId, v.orgId), eq(scheduleSessions.seriesId, series.id), eq(scheduleSessions.status, "scheduled"), gte(scheduleSessions.startsAt, from)));
  const locked = await lockSessionsInOrder(tx, v.orgId, candidates.map((r) => r.id));
  const targets = locked.filter((s) => s.status === "scheduled" && s.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let released = 0;
  for (const s of targets) released += (await cancelSession(tx, v, { sessionId: s.id, reason: input.reason, now })).released;
  const endsOn = addDaysYmd(input.fromYmd, -1);
  const endSeries = !series.endsOn || series.endsOn > endsOn;
  if (endSeries) {
    const deactivate = endsOn < series.startsOn;
    await tx
      .update(classSeries)
      .set(deactivate ? { active: false } : { endsOn })
      .where(eq(classSeries.id, series.id));
  }
  await audit(tx, actorOf(v), "series.cancel_from", "class_series", series.id, {
    summary: `Cancelled ${targets.length} upcoming session(s) of "${series.title}" from ${input.fromYmd} (${released} booking(s) released): ${input.reason}`,
    before: { endsOn: series.endsOn, active: series.active },
    after: endSeries ? (endsOn < series.startsOn ? { active: false } : { endsOn }) : {},
  });
  return { cancelled: targets.length, released, sessionIds: targets.map((s) => s.id) };
}
