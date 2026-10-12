import { aliasedTable, and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  bookings,
  cancellationPolicies,
  people,
  resources,
  scheduleSessions,
  serviceTypes,
  users,
  type BookingStatus,
} from "@/db/schema";
import { AuthzError, accessibleAthleteIds, athleteCapabilities, athleteScopeFilter, isStaff, type Viewer } from "@/lib/authz/policy";
import { creditSummary } from "@/lib/credits";
import { creditStateFor } from "./booking";
import { resolveEntitlement } from "./eligibility";

export type SessionFilters = { coachUserId?: string | null; serviceTypeId?: string | null; resourceId?: string | null };

const coachUser = aliasedTable(users, "coach_user");

/** Sessions in [from, to) with capacity/waitlist counts. Families see only bookable/visible sessions (+ ones they're booked in). */
export async function listSessions(tx: Tx, v: Viewer, input: { from: Date; to: Date; filters?: SessionFilters; familyAthleteIds?: string[] }) {
  const f = input.filters ?? {};
  const staff = isStaff(v);
  const familyIds = input.familyAthleteIds ?? [];
  const visibility = staff
    ? sql`true`
    : familyIds.length
      ? sql`((${scheduleSessions.visibility} <> 'private' and ${scheduleSessions.status} = 'scheduled') or exists (select 1 from bookings fb where fb.session_id = ${scheduleSessions.id} and fb.athlete_id in ${familyIds}))`
      : sql`(${scheduleSessions.visibility} <> 'private' and ${scheduleSessions.status} = 'scheduled')`;
  return tx
    .select({
      id: scheduleSessions.id,
      title: scheduleSessions.title,
      seriesId: scheduleSessions.seriesId,
      startsAt: scheduleSessions.startsAt,
      endsAt: scheduleSessions.endsAt,
      status: scheduleSessions.status,
      capacity: scheduleSessions.capacity,
      waitlistCapacity: scheduleSessions.waitlistCapacity,
      visibility: scheduleSessions.visibility,
      coachUserId: scheduleSessions.coachUserId,
      originalCoachUserId: scheduleSessions.originalCoachUserId,
      coachName: coachUser.displayName,
      resourceName: resources.name,
      serviceTypeId: serviceTypes.id,
      serviceName: serviceTypes.name,
      serviceKind: serviceTypes.kind,
      color: serviceTypes.color,
      creditCost: serviceTypes.creditCost,
      booked: sql<number>`(select count(*) from bookings b where b.session_id = ${scheduleSessions.id} and b.status in ('booked','attended','no_show'))::int`,
      waitlisted: sql<number>`(select count(*) from bookings b where b.session_id = ${scheduleSessions.id} and b.status = 'waitlisted')::int`,
    })
    .from(scheduleSessions)
    .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
    .leftJoin(coachUser, eq(coachUser.id, scheduleSessions.coachUserId))
    .leftJoin(resources, eq(resources.id, scheduleSessions.resourceId))
    .where(
      and(
        eq(scheduleSessions.orgId, v.orgId),
        gte(scheduleSessions.startsAt, input.from),
        lt(scheduleSessions.startsAt, input.to),
        f.coachUserId ? eq(scheduleSessions.coachUserId, f.coachUserId) : sql`true`,
        f.serviceTypeId ? eq(scheduleSessions.serviceTypeId, f.serviceTypeId) : sql`true`,
        f.resourceId ? eq(scheduleSessions.resourceId, f.resourceId) : sql`true`,
        visibility,
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt), asc(scheduleSessions.title));
}
export type SessionListItem = Awaited<ReturnType<typeof listSessions>>[number];

/** Live bookings of the given athletes in the given sessions (for family "Booked"/"Waitlisted" chips). */
export async function athleteBookingsIn(tx: Tx, orgId: string, athleteIds: string[], sessionIds: string[]) {
  if (!athleteIds.length || !sessionIds.length) return [];
  return tx
    .select({ id: bookings.id, sessionId: bookings.sessionId, athleteId: bookings.athleteId, status: bookings.status, waitlistPosition: bookings.waitlistPosition })
    .from(bookings)
    .where(and(eq(bookings.orgId, orgId), inArray(bookings.athleteId, athleteIds), inArray(bookings.sessionId, sessionIds)));
}

/** Athletes a family viewer can see on the schedule, with what they may do and how they'd pay. */
export async function familyAthletes(tx: Tx, v: Viewer, at = new Date()) {
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  if (ids === "all" || !ids.length) return [];
  const rows = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, active: athletes.active })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, ids)))
    .orderBy(asc(people.firstName));
  const out = [];
  for (const r of rows) {
    const caps = await athleteCapabilities(tx, v, r.id);
    const credits = await creditSummary(tx, r.id, at);
    out.push({ ...r, canBook: caps.has("booking.create"), credits: credits.available });
  }
  return out;
}

/** How an athlete would pay for a given service type right now (for the family booking card). */
export async function entitlementLabel(tx: Tx, orgId: string, athleteId: string, st: { id: string; eligibility: typeof serviceTypes.$inferSelect.eligibility; creditCost: number }, at: Date) {
  const e = await resolveEntitlement(tx, { orgId, athleteId, serviceType: st, at });
  return e;
}

export async function sessionDetail(tx: Tx, v: Viewer, sessionId: string) {
  if (!isStaff(v)) throw new AuthzError();
  const [row] = await tx
    .select({ session: scheduleSessions, service: serviceTypes, policy: cancellationPolicies, coachName: coachUser.displayName, resourceName: resources.name })
    .from(scheduleSessions)
    .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
    .leftJoin(cancellationPolicies, eq(cancellationPolicies.id, serviceTypes.cancellationPolicyId))
    .leftJoin(coachUser, eq(coachUser.id, scheduleSessions.coachUserId))
    .leftJoin(resources, eq(resources.id, scheduleSessions.resourceId))
    .where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, v.orgId)));
  if (!row) return null;
  let originalCoachName: string | null = null;
  if (row.session.originalCoachUserId) {
    const [u] = await tx.select({ n: users.displayName }).from(users).where(eq(users.id, row.session.originalCoachUserId));
    originalCoachName = u?.n ?? null;
  }
  const roster = await tx
    .select({ booking: bookings, first: people.firstName, last: people.lastName, personId: people.id })
    .from(bookings)
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(bookings.sessionId, sessionId))
    .orderBy(sql`case ${bookings.status} when 'waitlisted' then 1 else 0 end`, asc(bookings.waitlistPosition), asc(people.lastName), asc(people.firstName));
  const ledger = await creditStateFor(tx, roster.map((r) => r.booking.id));
  return { ...row, originalCoachName, roster: roster.map((r) => ({ ...r, ledger: ledger.get(r.booking.id) ?? [] })) };
}

/** Staff athlete search for "add booking" — limited to athletes the viewer may book for. */
export async function searchBookableAthletes(tx: Tx, v: Viewer, q: string, limit = 20) {
  const ids = await accessibleAthleteIds(tx, v, "booking.create");
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, sport: athletes.sport, dob: people.dateOfBirth })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(
      and(
        eq(athletes.orgId, v.orgId),
        eq(athletes.active, true),
        athleteScopeFilter(ids, athletes.id),
        or(ilike(people.firstName, like), ilike(people.lastName, like), ilike(sql`${people.firstName} || ' ' || ${people.lastName}`, like)),
      ),
    )
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(limit);
}

/** Athletes the viewer may book for (select lists in the slot finder). */
export async function bookableAthletes(tx: Tx, v: Viewer, limit = 300) {
  const ids = await accessibleAthleteIds(tx, v, "booking.create");
  return tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(ids, athletes.id)))
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(limit);
}

export const MILESTONES = [10, 25, 50, 100, 250, 500];

/** Attendance history + milestone progress. Visible to anyone with profile.read on the athlete. */
export async function attendanceHistory(tx: Tx, v: Viewer, athleteId: string, opts: { limit?: number } = {}) {
  const caps = await athleteCapabilities(tx, v, athleteId);
  if (!caps.has("profile.read")) throw new AuthzError();
  const [who] = await tx
    .select({ first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(athletes.id, athleteId));
  const counts = (
    await tx.execute(sql`select status, count(*)::int as n from bookings where athlete_id = ${athleteId} and org_id = ${v.orgId} group by status`)
  ).rows as { status: BookingStatus; n: number }[];
  const by = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<BookingStatus, number>>;
  const attended = by.attended ?? 0;
  // Date each milestone was reached = the Nth attended session's start.
  const attendedDates = (
    await tx.execute(sql`
      select s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
      where b.athlete_id = ${athleteId} and b.org_id = ${v.orgId} and b.status = 'attended'
      order by s.starts_at asc`)
  ).rows as { starts_at: Date | string }[];
  const milestones = MILESTONES.map((m) => ({ count: m, reachedAt: attendedDates[m - 1] ? new Date(attendedDates[m - 1].starts_at) : null }));
  const next = MILESTONES.find((m) => m > attended) ?? null;
  const history = await tx
    .select({
      bookingId: bookings.id,
      status: bookings.status,
      checkedInAt: bookings.checkedInAt,
      checkInMethod: bookings.checkInMethod,
      entitlementSource: bookings.entitlementSource,
      sessionId: scheduleSessions.id,
      title: scheduleSessions.title,
      startsAt: scheduleSessions.startsAt,
      sessionStatus: scheduleSessions.status,
      coachName: coachUser.displayName,
    })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .leftJoin(coachUser, eq(coachUser.id, scheduleSessions.coachUserId))
    .where(and(eq(bookings.athleteId, athleteId), eq(bookings.orgId, v.orgId)))
    .orderBy(desc(scheduleSessions.startsAt))
    .limit(opts.limit ?? 100);
  const finished = attended + (by.no_show ?? 0) + (by.late_cancelled ?? 0);
  return {
    athlete: who ? { id: athleteId, name: `${who.first} ${who.last}` } : null,
    counts: { attended, noShow: by.no_show ?? 0, lateCancelled: by.late_cancelled ?? 0, cancelled: by.cancelled ?? 0, upcoming: (by.booked ?? 0) + (by.waitlisted ?? 0) },
    /** Share of sessions that were attended out of attended + no-show + late-cancel; null when none yet. */
    attendanceRate: finished ? attended / finished : null,
    milestones,
    nextMilestone: next,
    history,
  };
}
export type AttendanceHistory = Awaited<ReturnType<typeof attendanceHistory>>;
