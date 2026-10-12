import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  bookings,
  cancellationPolicies,
  organizations,
  people,
  scheduleSessions,
  serviceTypes,
  tasks,
  type BookingStatus,
} from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import type { AuditActor } from "@/lib/audit";
import { DEFAULT_TZ } from "@/lib/time";

export type Session = typeof scheduleSessions.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type ServiceType = typeof serviceTypes.$inferSelect;
export type CancellationPolicy = typeof cancellationPolicies.$inferSelect;

/** Statuses that occupy a spot in the session (count against capacity). */
export const OCCUPYING: BookingStatus[] = ["booked", "attended", "no_show"];

/** Raised for exclusion-constraint conflicts (coach/room overlap); keeps the Postgres code for callers/tests. */
export class ScheduleConflictError extends UserError {
  code = "23P01";
  constructor(message = "That time conflicts with another session for the same coach or room.") {
    super(message);
    this.name = "ScheduleConflictError";
  }
}

export function pgCode(e: unknown): string | undefined {
  return (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
}

/** Re-throws a 23P01 exclusion violation as a friendly ScheduleConflictError. */
export async function withConflictMessage<T>(fn: () => Promise<T>, message?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (pgCode(e) === "23P01") throw new ScheduleConflictError(message);
    throw e;
  }
}

export function actorOf(v: Viewer): AuditActor {
  return { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role };
}

/** Booking policy knobs from organization settings. Null = not configured = no restriction. */
export type BookingSettings = { bookingWindowDays: number | null; familyBookingCutoffMinutes: number | null; timezone: string };

export async function bookingSettings(tx: Tx, orgId: string): Promise<BookingSettings> {
  const [o] = await tx.select({ settings: organizations.settings, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  const s = (o?.settings ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    bookingWindowDays: num(s.bookingWindowDays),
    familyBookingCutoffMinutes: num(s.familyBookingCutoffMinutes),
    timezone: o?.timezone ?? DEFAULT_TZ,
  };
}

export async function orgTimezone(tx: Tx, orgId: string): Promise<string> {
  const [o] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return o?.timezone ?? DEFAULT_TZ;
}

/** Load + lock a session row in the viewer's org. Every capacity decision happens under this lock. */
export async function lockSession(tx: Tx, orgId: string, sessionId: string): Promise<Session> {
  const [s] = await tx
    .select()
    .from(scheduleSessions)
    .where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, orgId)))
    .for("update");
  if (!s) throw new UserError("That session was not found.");
  return s;
}

export async function getSession(tx: Tx, orgId: string, sessionId: string): Promise<Session> {
  const [s] = await tx.select().from(scheduleSessions).where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, orgId)));
  if (!s) throw new UserError("That session was not found.");
  return s;
}

export async function getServiceType(tx: Tx, orgId: string, id: string): Promise<ServiceType> {
  const [st] = await tx.select().from(serviceTypes).where(and(eq(serviceTypes.id, id), eq(serviceTypes.orgId, orgId)));
  if (!st) throw new UserError("That service type was not found.");
  return st;
}

export async function policyFor(tx: Tx, st: ServiceType): Promise<CancellationPolicy | null> {
  if (!st.cancellationPolicyId) return null;
  const [p] = await tx.select().from(cancellationPolicies).where(eq(cancellationPolicies.id, st.cancellationPolicyId));
  return p ?? null;
}

export async function occupancy(tx: Tx, sessionId: string): Promise<{ occupying: number; waitlisted: number }> {
  const res = await tx.execute(sql`
    select
      count(*) filter (where status in ('booked','attended','no_show'))::int as occupying,
      count(*) filter (where status = 'waitlisted')::int as waitlisted
    from bookings where session_id = ${sessionId}`);
  const r = res.rows[0] as { occupying: number; waitlisted: number };
  return { occupying: r.occupying, waitlisted: r.waitlisted };
}

/** Is the viewer allowed to run this session (roster, attendance, staff booking)? */
export function canRunSession(v: Viewer, s: Pick<Session, "coachUserId">): boolean {
  return can(v, "schedule.manage") || (v.role === "coach" && s.coachUserId === v.userId);
}

export function assertCanRunSession(v: Viewer, s: Pick<Session, "coachUserId">) {
  if (!canRunSession(v, s)) throw new AuthzError("Only schedule managers or this session's coach can do that.");
}

export async function athleteName(tx: Tx, athleteId: string): Promise<{ first: string; last: string; personId: string; dob: string | null; active: boolean; orgId: string } | null> {
  const [r] = await tx
    .select({ first: people.firstName, last: people.lastName, personId: people.id, dob: people.dateOfBirth, active: athletes.active, orgId: athletes.orgId })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(athletes.id, athleteId));
  return r ?? null;
}

/** Renumber the waitlist 1..n by current order (position, then join time). */
export async function compactWaitlist(tx: Tx, sessionId: string) {
  await tx.execute(sql`
    update bookings b set waitlist_position = r.rn, updated_at = now()
    from (
      select id, row_number() over (order by waitlist_position nulls last, created_at)::int as rn
      from bookings where session_id = ${sessionId} and status = 'waitlisted'
    ) r
    where b.id = r.id and b.waitlist_position is distinct from r.rn`);
}

/**
 * Billing is another module: a cancellation/no-show fee is recorded as a pending
 * charge task (deduped per booking) that the billing team/module turns into an invoice.
 */
export async function recordPendingFee(
  tx: Tx,
  v: Viewer,
  input: { booking: Booking; session: Session; policy: CancellationPolicy; kind: "late_cancel" | "no_show"; athleteLabel: string },
) {
  const { booking, session, policy, kind } = input;
  const amount = policy.feeMinor;
  await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title: `Pending ${kind === "late_cancel" ? "late-cancel" : "no-show"} fee: ${input.athleteLabel}`,
      description: `Policy "${policy.name}" charges a fee of ${amount > 0 ? `${(amount / 100).toFixed(2)} (minor units: ${amount})` : "an amount not yet configured"} for ${kind.replace("_", " ")} on "${session.title}" (${session.startsAt.toISOString()}). Billing: create the charge or waive it. bookingId=${booking.id}`,
      relatedType: "booking_fee",
      relatedId: booking.id,
      status: "open",
      priority: "normal",
      source: "scheduling",
      dedupeKey: `sched-fee:${booking.id}`,
      createdBy: v.userId,
    })
    .onConflictDoNothing();
}

export async function bookingsForSessions(tx: Tx, sessionIds: string[]) {
  if (!sessionIds.length) return [];
  return tx.select().from(bookings).where(inArray(bookings.sessionId, sessionIds));
}
