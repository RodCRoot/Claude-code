import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, bookings, eventRegistrations, events, eventSessions, eventWaitlistEntries, invoices, people, scheduleSessions } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { billingTask } from "@/lib/billing/tasks";

/**
 * Confirmation side of event registration. Kept free of imports from billing/invoices so the
 * invoice settlement path can call it without an import cycle.
 */

export type EventRow = typeof events.$inferSelect;
export type RegistrationRow = typeof eventRegistrations.$inferSelect;

/** Load + lock the event row. Every capacity decision for an event happens under this lock. */
export async function lockEvent(tx: Tx, orgId: string, eventId: string): Promise<EventRow | null> {
  const [e] = await tx.select().from(events).where(and(eq(events.id, eventId), eq(events.orgId, orgId))).for("update");
  return e ?? null;
}

/**
 * Seats taken: confirmed registrations, held ones (expired holds are released by `releaseExpiredHolds`),
 * and spots currently offered to someone on the waitlist (an offer reserves its seat until it is
 * accepted, declined or runs out).
 */
export async function seatsTaken(tx: Tx, eventId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.eventId, eventId), inArray(eventRegistrations.status, ["held", "confirmed"])));
  const [o] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, eventId), eq(eventWaitlistEntries.status, "offered")));
  return (r?.n ?? 0) + (o?.n ?? 0);
}

export async function eventSessionRows(tx: Tx, eventId: string) {
  return tx
    .select({ id: scheduleSessions.id, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, status: scheduleSessions.status, timezone: scheduleSessions.timezone, title: scheduleSessions.title })
    .from(eventSessions)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, eventSessions.sessionId))
    .where(eq(eventSessions.eventId, eventId))
    .orderBy(asc(scheduleSessions.startsAt));
}

export const eventBookingKey = (registrationId: string, sessionId: string) => `event-reg:${registrationId}:${sessionId}`;

/**
 * Book a confirmed registration into the event's scheduled sessions (all, or just `sessionIds`).
 * No membership or credits are used: the booking is paid by the event invoice
 * (`entitlement_source = drop_in_invoice`). The event's own capacity already admitted the athlete,
 * so the session's capacity is not re-checked. Idempotent per registration and session.
 */
export async function bookRegistrationIntoSessions(tx: Tx, reg: RegistrationRow, sessionIds?: string[]): Promise<number> {
  const sessions = (await eventSessionRows(tx, reg.eventId)).filter((s) => s.status === "scheduled" && (!sessionIds || sessionIds.includes(s.id)));
  if (!sessions.length) return 0;
  // Same lock the booking flow takes, in id order.
  const ids = sessions.map((s) => s.id).sort();
  await tx.select({ id: scheduleSessions.id }).from(scheduleSessions).where(inArray(scheduleSessions.id, ids)).orderBy(asc(scheduleSessions.id)).for("update");
  const rows = await tx
    .insert(bookings)
    .values(
      sessions.map((s) => ({
        orgId: reg.orgId,
        sessionId: s.id,
        athleteId: reg.athleteId,
        bookedByUserId: reg.registeredByUserId,
        status: "booked" as const,
        entitlementSource: "drop_in_invoice" as const,
        idempotencyKey: eventBookingKey(reg.id, s.id),
        source: "event",
        isDemo: reg.isDemo,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: bookings.id });
  return rows.length;
}

async function athleteLabel(tx: Tx, athleteId: string) {
  const [a] = await tx.select({ first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.id, athleteId));
  return a ? `${a.first} ${a.last}` : "Athlete";
}

/**
 * Called by the invoice settlement path for each invoice line that carries an event registration.
 * A registration is confirmed only when its invoice is PAID (settled money covers the total: a
 * verified provider webhook or a staff-recorded payment). Money still processing, a browser
 * redirect, or the "grant on pending" credit policy never confirm it.
 * Safe to call repeatedly. Lock order here: invoice (caller) → event → registration.
 */
export async function confirmEventRegistration(tx: Tx, registrationId: string, invoiceId: string, actor: AuditActor): Promise<{ confirmed: boolean }> {
  const [peek] = await tx.select().from(eventRegistrations).where(eq(eventRegistrations.id, registrationId));
  if (!peek || peek.invoiceId !== invoiceId) return { confirmed: false };
  const [inv] = await tx.select({ status: invoices.status, number: invoices.number, orgId: invoices.orgId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || inv.orgId !== peek.orgId || inv.status !== "paid") return { confirmed: false };
  const event = await lockEvent(tx, peek.orgId, peek.eventId);
  if (!event) return { confirmed: false };
  const [reg] = await tx.select().from(eventRegistrations).where(eq(eventRegistrations.id, registrationId)).for("update");
  if (reg.status === "confirmed") return { confirmed: true };
  const a = { ...actor, orgId: reg.orgId };
  const who = await athleteLabel(tx, reg.athleteId);

  let reinstated = false;
  if (reg.status === "expired") {
    // The hold had run out but the payment still arrived. Honour it while a seat is free.
    const [again] = await tx
      .select({ id: eventRegistrations.id })
      .from(eventRegistrations)
      .where(and(eq(eventRegistrations.eventId, event.id), eq(eventRegistrations.athleteId, reg.athleteId), inArray(eventRegistrations.status, ["held", "confirmed"])));
    reinstated = !again && (await seatsTaken(tx, event.id)) < event.capacity;
  }
  if (reg.status === "cancelled" || (reg.status === "expired" && !reinstated)) {
    await billingTask(tx, reg.orgId, {
      title: `Payment received for a released ${event.name} spot (${inv.number})`,
      description: `${who}'s registration was ${reg.status} before invoice ${inv.number} was paid${reg.status === "expired" ? " and the event is now full" : ""}. Refund the payment from the invoice page, or register the athlete again if a spot opens.`,
      relatedType: "invoice",
      relatedId: invoiceId,
      dedupeKey: `event-paid-released:${reg.id}`,
      priority: "high",
      isDemo: reg.isDemo,
    });
    return { confirmed: false };
  }

  const [confirmed] = await tx
    .update(eventRegistrations)
    .set({ status: "confirmed", confirmedAt: new Date(), holdExpiresAt: null, releasedAt: null, updatedAt: new Date() })
    .where(eq(eventRegistrations.id, reg.id))
    .returning();
  const booked = await bookRegistrationIntoSessions(tx, confirmed);
  await audit(tx, a, "events.registration.confirm", "event_registration", reg.id, {
    summary: `${who} confirmed for ${event.name}: invoice ${inv.number} paid, booked into ${booked} session(s)${reinstated ? " (hold had expired; seat was still free)" : ""}`,
    before: { status: reg.status },
    after: { status: "confirmed", invoiceId, sessionsBooked: booked },
  });
  return { confirmed: true };
}
