import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import { alerts, athletes, bookings, people, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { localDayBounds, todayLocal } from "@/lib/time";
import { markAttendance } from "./booking";
import { orgTimezone } from "./common";

/** Exactly what the kiosk may show. No ids of people, no birthdates, no contact info, no health data. */
export type KioskAthlete = { bookingId: string; displayName: string; status: "booked" | "attended"; alerts: string[] };
export type KioskSession = { id: string; title: string; startsAt: Date; endsAt: Date; athletes: KioskAthlete[] };

export function kioskName(first: string, last: string) {
  const initial = last.trim().charAt(0);
  return initial ? `${first.trim()} ${initial.toUpperCase()}.` : first.trim();
}

function assertKioskAccess(v: Viewer) {
  if (!can(v, "schedule.checkin")) throw new AuthzError();
}

/** Today's (facility-local) sessions with booked/checked-in athletes, minimal fields only. */
export async function kioskRoster(tx: Tx, v: Viewer, opts: { now?: Date; q?: string } = {}): Promise<KioskSession[]> {
  assertKioskAccess(v);
  const tz = await orgTimezone(tx, v.orgId);
  const { start, end } = localDayBounds(todayLocal(tz, opts.now ?? new Date()), tz);
  const sessions = await tx
    .select({ id: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt })
    .from(scheduleSessions)
    .where(and(eq(scheduleSessions.orgId, v.orgId), ne(scheduleSessions.status, "cancelled"), gte(scheduleSessions.startsAt, start), lt(scheduleSessions.startsAt, end)))
    .orderBy(asc(scheduleSessions.startsAt));
  if (!sessions.length) return [];
  const rows = await tx
    .select({ bookingId: bookings.id, sessionId: bookings.sessionId, status: bookings.status, first: people.firstName, last: people.lastName, personId: people.id })
    .from(bookings)
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(inArray(bookings.sessionId, sessions.map((s) => s.id)), inArray(bookings.status, ["booked", "attended"])))
    .orderBy(asc(people.firstName), asc(people.lastName));
  const personIds = [...new Set(rows.map((r) => r.personId))];
  const kioskAlerts = personIds.length
    ? await tx
        .select({ personId: alerts.personId, message: alerts.message })
        .from(alerts)
        .where(and(eq(alerts.orgId, v.orgId), inArray(alerts.personId, personIds), eq(alerts.active, true), eq(alerts.showAtKiosk, true)))
    : [];
  const q = opts.q?.trim().toLowerCase() ?? "";
  return sessions
    .map((s) => ({
      ...s,
      athletes: rows
        .filter((r) => r.sessionId === s.id)
        .map((r) => ({
          bookingId: r.bookingId,
          displayName: kioskName(r.first, r.last),
          status: r.status as "booked" | "attended",
          alerts: kioskAlerts.filter((a) => a.personId === r.personId).map((a) => a.message),
        }))
        .filter((a) => !q || a.displayName.toLowerCase().includes(q)),
    }))
    .filter((s) => !q || s.athletes.length > 0);
}

/** One-tap kiosk check-in: today's sessions only; consumes the reserved credit. */
export async function kioskCheckIn(tx: Tx, v: Viewer, input: { bookingId: string; now?: Date }) {
  assertKioskAccess(v);
  const now = input.now ?? new Date();
  const [b] = await tx
    .select({ status: bookings.status, startsAt: scheduleSessions.startsAt, tz: scheduleSessions.timezone })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.orgId, v.orgId)));
  if (!b) throw new UserError("Booking not found.");
  if (todayLocal(b.tz, b.startsAt) !== todayLocal(b.tz, now)) throw new UserError("Only today's sessions can be checked in here.");
  if (b.status === "attended") return { status: "attended" as const, changed: false };
  if (b.status !== "booked") throw new UserError("This booking can't be checked in. Please see the front desk.");
  return markAttendance(tx, v, { bookingId: input.bookingId, outcome: "attended", method: "kiosk", now });
}
