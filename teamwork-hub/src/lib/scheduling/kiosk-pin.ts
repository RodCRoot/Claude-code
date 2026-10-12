import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import { alerts, athleteCheckinPins, athletes, bookings, kioskPinAttempts, people, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, can, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { localDayBounds, todayLocal } from "@/lib/time";
import { markAttendance } from "./booking";
import { actorOf, orgTimezone, pgCode } from "./common";
import { kioskName } from "./kiosk";
import { hashCheckInPin, isTrivialPin, PIN_PATTERN } from "./pin-hash";

/**
 * Kiosk check-in by PIN.
 *
 * - PINs are 4–6 digits, optional, one per athlete, set by staff or a guardian who can book for the
 *   athlete (`booking.create`). Trivial PINs (1111, 1234, 4321…) are refused.
 * - Storage: keyed hash only (see ./pin-hash.ts for why HMAC and not bcrypt).
 * - A PIN is unique within an org, so a match identifies exactly one athlete.
 * - Rate limit per kiosk login session: MAX_FAILED wrong PINs within WINDOW_MINUTES lock PIN entry
 *   for LOCK_MINUTES. Attempts are counted in `kiosk_pin_attempts` under a row lock, and a wrong PIN
 *   returns (never throws) so the counter commits.
 * - After a match the kiosk sees only "First L.", kiosk-flagged alerts, and that athlete's sessions today.
 */

export { PIN_PATTERN, hashCheckInPin, isTrivialPin };
export const KIOSK_PIN_MAX_FAILED = 5;
export const KIOSK_PIN_WINDOW_MINUTES = 15;
export const KIOSK_PIN_LOCK_MINUTES = 5;

/** Set (or clear with pin = null) an athlete's kiosk check-in PIN. */
export async function setCheckInPin(tx: Tx, v: Viewer, input: { athleteId: string; pin: string | null }) {
  if (v.role === "kiosk") throw new AuthzError();
  await requireOnAthlete(tx, v, input.athleteId, "booking.create");
  if (input.pin === null) {
    const del = await tx.delete(athleteCheckinPins).where(and(eq(athleteCheckinPins.athleteId, input.athleteId), eq(athleteCheckinPins.orgId, v.orgId))).returning();
    if (del.length) await audit(tx, actorOf(v), "athlete.checkin_pin_clear", "athlete", input.athleteId, { summary: "Kiosk check-in PIN removed" });
    return { set: false };
  }
  const pin = input.pin.trim();
  if (!PIN_PATTERN.test(pin)) throw new UserError("A check-in PIN is 4 to 6 digits.", { pin: "4–6 digits" });
  if (isTrivialPin(pin)) throw new UserError("That PIN is too easy to guess. Avoid repeated digits and straight runs like 1234.", { pin: "Too easy to guess" });
  const pinHash = hashCheckInPin(v.orgId, pin);
  const [taken] = await tx
    .select({ athleteId: athleteCheckinPins.athleteId })
    .from(athleteCheckinPins)
    .where(and(eq(athleteCheckinPins.orgId, v.orgId), eq(athleteCheckinPins.pinHash, pinHash), ne(athleteCheckinPins.athleteId, input.athleteId)));
  const unavailable = new UserError("That PIN isn't available. Please choose a different one.", { pin: "Choose another PIN" });
  if (taken) throw unavailable;
  try {
    await tx
      .insert(athleteCheckinPins)
      .values({ athleteId: input.athleteId, orgId: v.orgId, pinHash, setByUserId: v.userId })
      .onConflictDoUpdate({ target: athleteCheckinPins.athleteId, set: { pinHash, setByUserId: v.userId, updatedAt: new Date() } });
  } catch (e) {
    // Concurrent set of the same PIN for another athlete: the unique index is the backstop.
    if (pgCode(e) === "23505") throw unavailable;
    throw e;
  }
  // Never log or audit the PIN itself.
  await audit(tx, actorOf(v), "athlete.checkin_pin_set", "athlete", input.athleteId, { summary: "Kiosk check-in PIN set" });
  return { set: true };
}

export async function hasCheckInPin(tx: Tx, v: Viewer, athleteId: string): Promise<boolean> {
  await requireOnAthlete(tx, v, athleteId, "profile.read");
  const [r] = await tx.select({ a: athleteCheckinPins.athleteId }).from(athleteCheckinPins).where(and(eq(athleteCheckinPins.athleteId, athleteId), eq(athleteCheckinPins.orgId, v.orgId)));
  return !!r;
}

export type KioskPinSession = { title: string; startsAt: Date; endsAt: Date; result: "checked_in" | "already_checked_in" | "not_open_yet" | "ended" | "see_front_desk" };
export type KioskPinResult =
  | { ok: true; displayName: string; alerts: string[]; sessions: KioskPinSession[] }
  | { ok: false; reason: "invalid_format" }
  | { ok: false; reason: "no_match"; attemptsLeft: number }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

/**
 * Check in by PIN. `sessionKey` identifies the kiosk login session (the auth session token hash);
 * attempts are rate limited per (org, sessionKey). Returns a result instead of throwing for
 * wrong/locked PINs so the attempt counter is committed with the transaction.
 */
export async function kioskPinCheckIn(tx: Tx, v: Viewer, input: { pin: string; sessionKey: string; now?: Date }): Promise<KioskPinResult> {
  if (!can(v, "schedule.checkin")) throw new AuthzError();
  if (!input.sessionKey) throw new UserError("Kiosk session not found. Please sign the kiosk in again.");
  const now = input.now ?? new Date();
  const pin = input.pin.trim();
  if (!PIN_PATTERN.test(pin)) return { ok: false, reason: "invalid_format" };

  await tx.insert(kioskPinAttempts).values({ orgId: v.orgId, sessionKey: input.sessionKey, windowStartedAt: now }).onConflictDoNothing();
  const [att] = await tx
    .select()
    .from(kioskPinAttempts)
    .where(and(eq(kioskPinAttempts.orgId, v.orgId), eq(kioskPinAttempts.sessionKey, input.sessionKey)))
    .for("update");
  if (att.lockedUntil && att.lockedUntil > now) {
    return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((att.lockedUntil.getTime() - now.getTime()) / 1000) };
  }
  const windowExpired = now.getTime() - att.windowStartedAt.getTime() > KIOSK_PIN_WINDOW_MINUTES * 60_000;
  const failedSoFar = windowExpired || att.lockedUntil ? 0 : att.failedCount;

  const [match] = await tx
    .select({ athleteId: athleteCheckinPins.athleteId, first: people.firstName, last: people.lastName, personId: people.id })
    .from(athleteCheckinPins)
    .innerJoin(athletes, eq(athletes.id, athleteCheckinPins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athleteCheckinPins.orgId, v.orgId), eq(athleteCheckinPins.pinHash, hashCheckInPin(v.orgId, pin)), eq(athletes.orgId, v.orgId), eq(athletes.active, true)));

  if (!match) {
    const failed = failedSoFar + 1;
    const lock = failed >= KIOSK_PIN_MAX_FAILED;
    await tx
      .update(kioskPinAttempts)
      .set({
        failedCount: lock ? 0 : failed,
        windowStartedAt: failedSoFar === 0 ? now : att.windowStartedAt,
        lockedUntil: lock ? new Date(now.getTime() + KIOSK_PIN_LOCK_MINUTES * 60_000) : null,
        updatedAt: now,
      })
      .where(and(eq(kioskPinAttempts.orgId, v.orgId), eq(kioskPinAttempts.sessionKey, input.sessionKey)));
    if (lock) {
      await audit(tx, actorOf(v), "kiosk.pin_lockout", "user", v.userId, { summary: `Kiosk PIN entry locked for ${KIOSK_PIN_LOCK_MINUTES} minutes after ${KIOSK_PIN_MAX_FAILED} wrong PINs` });
      return { ok: false, reason: "locked", retryAfterSeconds: KIOSK_PIN_LOCK_MINUTES * 60 };
    }
    return { ok: false, reason: "no_match", attemptsLeft: KIOSK_PIN_MAX_FAILED - failed };
  }

  await tx
    .update(kioskPinAttempts)
    .set({ failedCount: 0, lockedUntil: null, windowStartedAt: now, updatedAt: now })
    .where(and(eq(kioskPinAttempts.orgId, v.orgId), eq(kioskPinAttempts.sessionKey, input.sessionKey)));

  const tz = await orgTimezone(tx, v.orgId);
  const { start, end } = localDayBounds(todayLocal(tz, now), tz);
  const todays = await tx
    .select({ bookingId: bookings.id, status: bookings.status, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.orgId, v.orgId),
        eq(bookings.athleteId, match.athleteId),
        inArray(bookings.status, ["booked", "attended"]),
        ne(scheduleSessions.status, "cancelled"),
        gte(scheduleSessions.startsAt, start),
        lt(scheduleSessions.startsAt, end),
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt));

  const sessions: KioskPinSession[] = [];
  for (const b of todays) {
    const base = { title: b.title, startsAt: b.startsAt, endsAt: b.endsAt };
    if (b.status === "attended") sessions.push({ ...base, result: "already_checked_in" });
    else if (now.getTime() < b.startsAt.getTime() - 60 * 60_000) sessions.push({ ...base, result: "not_open_yet" });
    else if (now > b.endsAt) sessions.push({ ...base, result: "ended" });
    else {
      try {
        // Savepoint: a refused check-in must not abort the attempt bookkeeping above.
        await tx.transaction((sp) => markAttendance(sp, v, { bookingId: b.bookingId, outcome: "attended", method: "kiosk", now }));
        sessions.push({ ...base, result: "checked_in" });
      } catch (e) {
        if (!(e instanceof UserError) && !(e instanceof AuthzError)) throw e;
        sessions.push({ ...base, result: "see_front_desk" });
      }
    }
  }
  const kioskAlerts = await tx
    .select({ message: alerts.message })
    .from(alerts)
    .where(and(eq(alerts.orgId, v.orgId), eq(alerts.personId, match.personId), eq(alerts.active, true), eq(alerts.showAtKiosk, true)));
  await audit(tx, actorOf(v), "kiosk.pin_check_in", "athlete", match.athleteId, {
    summary: `Kiosk PIN matched: ${sessions.filter((s) => s.result === "checked_in").length} check-in(s)`,
  });
  return { ok: true, displayName: kioskName(match.first, match.last), alerts: kioskAlerts.map((a) => a.message), sessions };
}

/** Count of failed attempts (tests/diagnostics). */
export async function kioskPinAttemptState(tx: Tx, orgId: string, sessionKey: string) {
  const [r] = await tx
    .select({ failedCount: kioskPinAttempts.failedCount, lockedUntil: kioskPinAttempts.lockedUntil })
    .from(kioskPinAttempts)
    .where(and(eq(kioskPinAttempts.orgId, orgId), eq(kioskPinAttempts.sessionKey, sessionKey)));
  return r ?? null;
}
