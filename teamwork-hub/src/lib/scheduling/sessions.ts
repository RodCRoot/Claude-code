import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings, classSeries, resources, scheduleSessions, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, STAFF, type Viewer } from "@/lib/authz/policy";
import { settleReservation } from "@/lib/credits";
import { enqueue } from "@/lib/jobs";
import { addDaysYmd, fmt, todayLocal } from "@/lib/time";
import { seriesOccurrences } from "./recurrence";

export { seriesOccurrences, type SeriesShape } from "./recurrence";
import { queueCalendarSync } from "@/lib/calendar/sync";
import { actorOf, getServiceType, lockSession, orgTimezone, withConflictMessage, type Session } from "./common";

/** Generate concrete sessions for a series. Idempotent via unique (series_id, starts_at). */
export async function generateSeriesSessions(
  tx: Tx,
  v: Viewer,
  input: { seriesId: string; weeks?: number; fromYmd?: string; toYmd?: string; isDemo?: boolean },
): Promise<{ created: number; skipped: number }> {
  assertCan(v, "schedule.manage");
  const [series] = await tx.select().from(classSeries).where(and(eq(classSeries.id, input.seriesId), eq(classSeries.orgId, v.orgId)));
  if (!series) throw new UserError("Series not found.");
  if (!series.active) throw new UserError("This series is inactive. Reactivate it before generating sessions.");
  const weeks = input.weeks ?? 4;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new UserError("Choose between 1 and 52 weeks.", { weeks: "1–52" });
  const st = await getServiceType(tx, v.orgId, series.serviceTypeId);
  let exclusiveResource = false;
  if (series.resourceId) {
    const [r] = await tx.select({ exclusive: resources.exclusive }).from(resources).where(eq(resources.id, series.resourceId));
    exclusiveResource = !!r?.exclusive;
  }
  const from = input.fromYmd ?? todayLocal(series.timezone);
  const to = input.toYmd ?? addDaysYmd(from, weeks * 7 - 1);
  const occ = seriesOccurrences(series, from, to);
  if (!occ.length) return { created: 0, skipped: 0 };
  const rows = await withConflictMessage(
    () =>
      tx
        .insert(scheduleSessions)
        .values(
          occ.map((o) => ({
            orgId: v.orgId,
            serviceTypeId: series.serviceTypeId,
            seriesId: series.id,
            title: series.title,
            startsAt: o.startsAt,
            endsAt: o.endsAt,
            timezone: series.timezone,
            coachUserId: series.coachUserId,
            resourceId: series.resourceId,
            capacity: series.capacity,
            waitlistCapacity: series.waitlistCapacity,
            bufferBeforeMinutes: st.bufferBeforeMinutes,
            bufferAfterMinutes: st.bufferAfterMinutes,
            exclusiveCoach: st.exclusiveCoach,
            exclusiveResource,
            visibility: st.publicBookable ? ("public" as const) : ("members" as const),
            isDemo: input.isDemo ?? series.isDemo,
          })),
        )
        .onConflictDoNothing({ target: [scheduleSessions.seriesId, scheduleSessions.startsAt] })
        .returning({ id: scheduleSessions.id }),
    "Some generated sessions conflict with another session for the same coach or an exclusive room. Nothing was generated.",
  );
  for (const r of rows) await queueCalendarSync(tx, r.id);
  await audit(tx, actorOf(v), "series.generate", "class_series", series.id, { summary: `Generated ${rows.length} session(s) for "${series.title}" ${from} → ${to}` });
  return { created: rows.length, skipped: occ.length - rows.length };
}

export type CreateSessionInput = {
  serviceTypeId: string;
  title?: string | null;
  startsAt: Date;
  durationMinutes?: number | null;
  coachUserId?: string | null;
  resourceId?: string | null;
  capacity?: number | null;
  waitlistCapacity?: number | null;
  visibility?: "public" | "members" | "private";
  notes?: string | null;
};

async function assertCoach(tx: Tx, orgId: string, userId: string) {
  const [u] = await tx.select({ role: users.role, orgId: users.orgId }).from(users).where(eq(users.id, userId));
  if (!u || u.orgId !== orgId || !STAFF.includes(u.role)) throw new UserError("Choose a staff member as the coach.");
}

/** Create a one-off session (private session, assessment, camp day, event). Overlaps → friendly 23P01 error. */
export async function createSession(tx: Tx, v: Viewer, input: CreateSessionInput, opts: { asSystem?: boolean; isDemo?: boolean } = {}): Promise<Session> {
  if (!opts.asSystem) assertCan(v, "schedule.manage");
  const st = await getServiceType(tx, v.orgId, input.serviceTypeId);
  if (input.coachUserId) await assertCoach(tx, v.orgId, input.coachUserId);
  let exclusiveResource = false;
  if (input.resourceId) {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, input.resourceId), eq(resources.orgId, v.orgId)));
    if (!r) throw new UserError("Resource not found.");
    exclusiveResource = r.exclusive;
  }
  const duration = input.durationMinutes ?? st.defaultDurationMinutes;
  if (!(duration > 0)) throw new UserError("Duration must be positive.", { durationMinutes: "Must be > 0" });
  const tz = await orgTimezone(tx, v.orgId);
  const [s] = await withConflictMessage(() =>
    tx
      .insert(scheduleSessions)
      .values({
        orgId: v.orgId,
        serviceTypeId: st.id,
        title: input.title?.trim() || st.name,
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + duration * 60_000),
        timezone: tz,
        coachUserId: input.coachUserId ?? null,
        resourceId: input.resourceId ?? null,
        capacity: input.capacity ?? st.defaultCapacity,
        waitlistCapacity: input.waitlistCapacity ?? 0,
        bufferBeforeMinutes: st.bufferBeforeMinutes,
        bufferAfterMinutes: st.bufferAfterMinutes,
        exclusiveCoach: st.exclusiveCoach,
        exclusiveResource,
        visibility: input.visibility ?? (st.kind === "private" || st.kind === "semi_private" || st.kind === "assessment" ? "private" : st.publicBookable ? "public" : "members"),
        notes: input.notes ?? null,
        isDemo: opts.isDemo ?? false,
      })
      .returning(),
  );
  await queueCalendarSync(tx, s.id);
  await audit(tx, actorOf(v), "session.create", "schedule_session", s.id, { summary: `Created ${s.title} ${fmt(s.startsAt, "EEE MMM d h:mm a", tz)}` });
  return s;
}

/** Substitute the coach; the originally scheduled coach is preserved for history/payroll. */
export async function substituteCoach(tx: Tx, v: Viewer, input: { sessionId: string; coachUserId: string; reason?: string }) {
  assertCan(v, "schedule.manage");
  const s = await lockSession(tx, v.orgId, input.sessionId);
  if (s.status === "cancelled") throw new UserError("This session is cancelled.");
  if (s.coachUserId === input.coachUserId) throw new UserError("That coach is already assigned.");
  await assertCoach(tx, v.orgId, input.coachUserId);
  const [updated] = await withConflictMessage(
    () =>
      tx
        .update(scheduleSessions)
        .set({ coachUserId: input.coachUserId, originalCoachUserId: s.originalCoachUserId ?? s.coachUserId, version: s.version + 1, updatedAt: new Date() })
        .where(eq(scheduleSessions.id, s.id))
        .returning(),
    "That coach already has an exclusive session at this time.",
  );
  await queueCalendarSync(tx, s.id, { previousCoachUserId: s.coachUserId });
  await audit(tx, actorOf(v), "session.substitute_coach", "schedule_session", s.id, {
    summary: `Coach substituted on ${s.title}${input.reason ? `: ${input.reason}` : ""}`,
    before: { coachUserId: s.coachUserId },
    after: { coachUserId: input.coachUserId, originalCoachUserId: updated.originalCoachUserId },
  });
  return updated;
}

/** Cancel a whole session: every live booking is cancelled with its credit released, families are notified via the outbox. */
export async function cancelSession(tx: Tx, v: Viewer, input: { sessionId: string; reason: string; now?: Date }) {
  assertCan(v, "schedule.manage");
  if (!input.reason.trim()) throw new UserError("A reason is required to cancel a session.", { reason: "Required" });
  const now = input.now ?? new Date();
  const s = await lockSession(tx, v.orgId, input.sessionId);
  if (s.status === "cancelled") throw new UserError("This session is already cancelled.");
  const live = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.sessionId, s.id), inArray(bookings.status, ["booked", "waitlisted"])))
    .for("update");
  for (const b of live) {
    if (b.status === "booked") await settleReservation(tx, { bookingId: b.id, outcome: "release", actorUserId: v.userId, reason: "Session cancelled by staff" });
    await tx.update(bookings).set({ status: "cancelled", waitlistPosition: null, cancelledAt: now, cancelledBy: v.userId, updatedAt: now }).where(eq(bookings.id, b.id));
  }
  await tx.update(scheduleSessions).set({ status: "cancelled", cancelReason: input.reason, version: s.version + 1, updatedAt: now }).where(eq(scheduleSessions.id, s.id));
  await enqueue(tx, {
    type: "notify.session_cancelled",
    orgId: v.orgId,
    payload: { sessionId: s.id, reason: input.reason, bookingIds: live.map((b) => b.id), athleteIds: live.map((b) => b.athleteId) },
    dedupeKey: `notify.session_cancelled:${s.id}`,
  });
  await queueCalendarSync(tx, s.id);
  await audit(tx, actorOf(v), "session.cancel", "schedule_session", s.id, {
    summary: `Cancelled ${s.title} (${live.length} booking(s) released): ${input.reason}`,
    before: { status: s.status },
    after: { status: "cancelled" },
  });
  return { released: live.length };
}

/** Edit time/capacity/notes of a single session (optimistic concurrency via version). */
export async function updateSession(
  tx: Tx,
  v: Viewer,
  input: { sessionId: string; version: number; title?: string; startsAt?: Date; durationMinutes?: number; capacity?: number; waitlistCapacity?: number; resourceId?: string | null; notes?: string | null; visibility?: "public" | "members" | "private" },
) {
  assertCan(v, "schedule.manage");
  const s = await lockSession(tx, v.orgId, input.sessionId);
  if (s.version !== input.version) throw new UserError("Someone else changed this session. Reload and try again.");
  if (s.status === "cancelled") throw new UserError("This session is cancelled.");
  const startsAt = input.startsAt ?? s.startsAt;
  const duration = input.durationMinutes ?? Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000);
  let exclusiveResource = s.exclusiveResource;
  if (input.resourceId !== undefined && input.resourceId !== s.resourceId) {
    exclusiveResource = false;
    if (input.resourceId) {
      const [r] = await tx.select().from(resources).where(and(eq(resources.id, input.resourceId), eq(resources.orgId, v.orgId)));
      if (!r) throw new UserError("Resource not found.");
      exclusiveResource = r.exclusive;
    }
  }
  if (input.capacity != null && input.capacity < 0) throw new UserError("Capacity can't be negative.");
  const [u] = await withConflictMessage(() =>
    tx
      .update(scheduleSessions)
      .set({
        title: input.title?.trim() || s.title,
        startsAt,
        endsAt: new Date(startsAt.getTime() + duration * 60_000),
        capacity: input.capacity ?? s.capacity,
        waitlistCapacity: input.waitlistCapacity ?? s.waitlistCapacity,
        resourceId: input.resourceId === undefined ? s.resourceId : input.resourceId,
        exclusiveResource,
        notes: input.notes === undefined ? s.notes : input.notes,
        visibility: input.visibility ?? s.visibility,
        version: s.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(scheduleSessions.id, s.id))
      .returning(),
  );
  await queueCalendarSync(tx, s.id);
  await audit(tx, actorOf(v), "session.update", "schedule_session", s.id, {
    summary: `Updated ${u.title}`,
    before: { startsAt: s.startsAt, capacity: s.capacity, resourceId: s.resourceId },
    after: { startsAt: u.startsAt, capacity: u.capacity, resourceId: u.resourceId },
  });
  return u;
}

