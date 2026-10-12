import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings, creditLedger, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, athleteCapabilities, can, type Viewer } from "@/lib/authz/policy";
import { InsufficientCreditsError, reserveCredits, restoreCredit, settleReservation, type Settlement } from "@/lib/credits";
import { enqueue } from "@/lib/jobs";
import { fmt } from "@/lib/time";
import {
  actorOf,
  athleteName,
  bookingSettings,
  canRunSession,
  compactWaitlist,
  getServiceType,
  lockSession,
  occupancy,
  policyFor,
  recordPendingFee,
  type Booking,
  type Session,
} from "./common";
import { checkEligibility, resolveEntitlement, requiresEntitlement } from "./eligibility";

export type BookInput = {
  sessionId: string;
  athleteId: string;
  /** Client-generated key; a retry with the same key returns the original booking. */
  idempotencyKey?: string | null;
  /** Staff only: book without membership/credits. A reason is required. */
  comp?: { reason: string } | null;
  /** Staff only: bypass eligibility (forms/age) and the family booking window. A reason is required. */
  override?: { reason: string } | null;
  /** When the session is full, join the waitlist (default) instead of failing. */
  allowWaitlist?: boolean;
  rescheduledFromBookingId?: string | null;
  now?: Date;
};

export type BookResult = { booking: Booking; status: "booked" | "waitlisted"; reused: boolean };

const NEEDS_ENTITLEMENT = "needs an active membership or available session credits for this service. Buy a package or membership, or ask the front desk.";

/**
 * Book an athlete into a session. Must run inside a transaction (`db.transaction`).
 * The session row is locked FOR UPDATE, so capacity/waitlist decisions are serialized.
 */
export async function bookSession(tx: Tx, v: Viewer, input: BookInput): Promise<BookResult> {
  return bookInternal(tx, v, input, { allowPrivate: false });
}

/** Internal entry that the private-slot flow uses (it creates a private session for the family). */
export async function bookInternal(tx: Tx, v: Viewer, input: BookInput, opts: { allowPrivate: boolean }): Promise<BookResult> {
  const now = input.now ?? new Date();
  const session = await lockSession(tx, v.orgId, input.sessionId);

  // Idempotent retry: same key → same booking (checked after the lock so concurrent retries serialize).
  if (input.idempotencyKey) {
    const [prior] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.orgId, v.orgId), eq(bookings.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.sessionId !== session.id || prior.athleteId !== input.athleteId) {
        throw new UserError("This request key was already used for a different booking. Refresh and try again.");
      }
      return { booking: prior, status: prior.status === "waitlisted" ? "waitlisted" : "booked", reused: true };
    }
  }

  // --- Authorization --------------------------------------------------------------
  const caps = await athleteCapabilities(tx, v, input.athleteId);
  const staffActor = canRunSession(v, session);
  if (v.role === "kiosk") throw new AuthzError();
  if (v.role === "coach" && !staffActor) throw new AuthzError("Coaches can only add athletes to their own sessions.");
  if (!caps.has("booking.create")) throw new AuthzError("You don't have permission to book for this athlete.");
  if ((input.comp || input.override) && !staffActor) throw new AuthzError("Only staff can comp a booking or override eligibility.");
  if (input.comp && !input.comp.reason.trim()) throw new UserError("A reason is required to comp a booking.", { compReason: "Required" });
  if (input.override && !input.override.reason.trim()) throw new UserError("A reason is required to override eligibility.", { overrideReason: "Required" });

  const who = await athleteName(tx, input.athleteId);
  if (!who) throw new UserError("Athlete not found.");
  const label = `${who.first} ${who.last}`;

  // --- Session state & booking window -------------------------------------------------
  if (session.status !== "scheduled") throw new UserError("This session is cancelled and can't be booked.");
  if (now >= session.endsAt) throw new UserError("This session has already ended.");
  const st = await getServiceType(tx, v.orgId, session.serviceTypeId);
  const settings = await bookingSettings(tx, v.orgId);
  if (!staffActor) {
    if (session.visibility === "private" && !opts.allowPrivate) throw new UserError("This session isn't open for online booking.");
    if (!st.active) throw new UserError("This service isn't available for booking.");
    if (settings.bookingWindowDays != null && session.startsAt.getTime() > now.getTime() + settings.bookingWindowDays * 86_400_000) {
      throw new UserError(`Online booking opens ${settings.bookingWindowDays} days before the session.`);
    }
    const cutoff = settings.familyBookingCutoffMinutes ?? 0;
    if (now.getTime() > session.startsAt.getTime() - cutoff * 60_000) {
      throw new UserError(
        cutoff > 0
          ? `Online booking closes ${cutoff} minutes before the session starts. Please contact the front desk.`
          : "This session has already started. Please contact the front desk.",
      );
    }
  }

  // --- Duplicate --------------------------------------------------------------------
  const [dup] = await tx
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.athleteId, input.athleteId), inArray(bookings.status, ["booked", "waitlisted", "attended", "no_show"])));
  if (dup) throw new UserError(`${label} is already ${dup.status === "waitlisted" ? "on the waitlist" : "booked"} for this session.`);

  // --- Eligibility --------------------------------------------------------------------
  if (!input.override) {
    const el = await checkEligibility(tx, { orgId: v.orgId, athleteId: input.athleteId, serviceType: st, at: session.startsAt, tz: settings.timezone });
    if (!el.ok) throw new UserError(`${label} can't be booked yet: ${el.reasons.join(" ")}`);
  }

  // --- Capacity → booked or waitlisted ------------------------------------------------
  const occ = await occupancy(tx, session.id);
  let status: "booked" | "waitlisted";
  if (occ.occupying < session.capacity) status = "booked";
  else if ((input.allowWaitlist ?? true) && occ.waitlisted < session.waitlistCapacity) status = "waitlisted";
  else throw new UserError(session.waitlistCapacity > 0 ? "This session and its waitlist are full." : "This session is full.");

  // --- Entitlement ----------------------------------------------------------------------
  const ent = input.comp
    ? ({ kind: "comp" } as const)
    : await resolveEntitlement(tx, { orgId: v.orgId, athleteId: input.athleteId, serviceType: st, at: session.startsAt, tz: settings.timezone });
  if (ent.kind === "none") {
    throw new UserError(staffActor ? `${label} has no membership or credits for ${st.name}. Book as a comp (with a reason) or sell a package first.` : `${label} ${NEEDS_ENTITLEMENT}`);
  }

  const waitPos = status === "waitlisted" ? occ.waitlisted + 1 : null;
  const [booking] = await tx
    .insert(bookings)
    .values({
      orgId: v.orgId,
      sessionId: session.id,
      athleteId: input.athleteId,
      bookedByUserId: v.userId,
      status,
      waitlistPosition: waitPos,
      entitlementSource: ent.kind === "comp" ? "comp" : ent.kind === "unlimited" ? "unlimited" : null,
      membershipId: ent.kind === "unlimited" ? ent.membershipId : null,
      idempotencyKey: input.idempotencyKey ?? null,
      rescheduledFromBookingId: input.rescheduledFromBookingId ?? null,
    })
    .returning();

  let final = booking;
  if (status === "booked" && ent.kind === "credits") {
    try {
      const r = await reserveCredits(tx, { orgId: v.orgId, athleteId: input.athleteId, bookingId: booking.id, serviceTypeId: st.id, cost: st.creditCost, sessionStartsAt: session.startsAt, actorUserId: v.userId });
      [final] = await tx.update(bookings).set({ creditBucketId: r.bucketId, entitlementSource: "credit" }).where(eq(bookings.id, booking.id)).returning();
    } catch (e) {
      if (e instanceof InsufficientCreditsError) throw new UserError(`${label} ${NEEDS_ENTITLEMENT}`);
      throw e;
    }
  }

  await audit(tx, actorOf(v), status === "booked" ? "booking.create" : "booking.waitlist", "booking", final.id, {
    summary: `${label} ${status === "booked" ? "booked into" : `waitlisted (#${waitPos}) for`} ${session.title} ${fmt(session.startsAt, "EEE MMM d h:mm a", session.timezone)}${input.comp ? ` — comp: ${input.comp.reason}` : ""}${input.override ? ` — eligibility override: ${input.override.reason}` : ""}`,
    after: { status, entitlementSource: final.entitlementSource, creditBucketId: final.creditBucketId, sessionId: session.id, athleteId: input.athleteId },
  });
  return { booking: final, status, reused: false };
}

async function lockBooking(tx: Tx, v: Viewer, bookingId: string): Promise<{ booking: Booking; session: Session }> {
  const [b0] = await tx.select({ sessionId: bookings.sessionId }).from(bookings).where(and(eq(bookings.id, bookingId), eq(bookings.orgId, v.orgId)));
  if (!b0) throw new UserError("That booking was not found.");
  // Lock order everywhere: session, then booking.
  const session = await lockSession(tx, v.orgId, b0.sessionId);
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  return { booking, session };
}

export type CancelMode = "auto" | "late" | "waive";

export type CancelInput = {
  bookingId: string;
  /** auto: policy decides by time. late: staff marks it late. waive: staff cancels without penalty (reason required). */
  mode?: CancelMode;
  reason?: string;
  now?: Date;
};

export type CancelResult = {
  status: "cancelled" | "late_cancelled";
  late: boolean;
  penalty: "none" | "forfeit_credit" | "fee";
  creditOutcome: Settlement | "none";
  promoted: string[];
  skipped: { bookingId: string; reason: string }[];
};

/** Cancel a booking (or leave the waitlist) applying the session's cancellation policy. */
export async function cancelBooking(tx: Tx, v: Viewer, input: CancelInput): Promise<CancelResult> {
  const now = input.now ?? new Date();
  const mode = input.mode ?? "auto";
  const { booking, session } = await lockBooking(tx, v, input.bookingId);
  const staffActor = canRunSession(v, session);
  if (!staffActor) {
    const caps = await athleteCapabilities(tx, v, booking.athleteId);
    if (!caps.has("booking.create")) throw new AuthzError("You don't have permission to change this booking.");
    if (mode !== "auto") throw new AuthzError("Only staff can waive or force a late cancellation.");
    if (now >= session.startsAt) throw new UserError("This session has already started. Please contact the front desk.");
  }
  if (mode === "waive" && !input.reason?.trim()) throw new UserError("A reason is required to waive the cancellation policy.", { reason: "Required" });
  if (booking.status !== "booked" && booking.status !== "waitlisted") throw new UserError(`This booking is already ${booking.status.replace("_", " ")}.`);

  const who = await athleteName(tx, booking.athleteId);
  const label = who ? `${who.first} ${who.last}` : "Athlete";

  if (booking.status === "waitlisted") {
    await tx.update(bookings).set({ status: "cancelled", waitlistPosition: null, cancelledAt: now, cancelledBy: v.userId, updatedAt: now }).where(eq(bookings.id, booking.id));
    await compactWaitlist(tx, session.id);
    await audit(tx, actorOf(v), "booking.waitlist_leave", "booking", booking.id, { summary: `${label} removed from the waitlist for ${session.title}`, before: { status: "waitlisted" } });
    return { status: "cancelled", late: false, penalty: "none", creditOutcome: "none", promoted: [], skipped: [] };
  }

  const st = await getServiceType(tx, v.orgId, session.serviceTypeId);
  const policy = await policyFor(tx, st);
  const inLateWindow = !!policy && now.getTime() > session.startsAt.getTime() - policy.lateCancelWindowMinutes * 60_000;
  const late = mode === "late" || (mode === "auto" && inLateWindow);
  const penalty = late ? (policy?.lateCancelPenalty ?? "none") : "none";
  const outcome: Settlement = penalty === "forfeit_credit" ? "forfeit" : "release";
  const settled = await settleReservation(tx, { bookingId: booking.id, outcome, actorUserId: v.userId, reason: late ? "Late cancellation" : mode === "waive" ? `Waived: ${input.reason}` : "Cancelled in time" });
  const status = late ? "late_cancelled" : "cancelled";
  await tx.update(bookings).set({ status, cancelledAt: now, cancelledBy: v.userId, updatedAt: now }).where(eq(bookings.id, booking.id));
  if (penalty === "fee" && policy) await recordPendingFee(tx, v, { booking, session, policy, kind: "late_cancel", athleteLabel: label });

  await audit(tx, actorOf(v), late ? "booking.late_cancel" : "booking.cancel", "booking", booking.id, {
    summary: `${label} ${late ? "late-cancelled" : "cancelled"} ${session.title}${mode === "waive" ? ` (policy waived: ${input.reason})` : ""}${penalty !== "none" ? ` — penalty: ${penalty}` : ""}`,
    before: { status: booking.status },
    after: { status, penalty, credit: settled.settled ? outcome : "none" },
  });

  const promo = now < session.startsAt ? await promoteWaitlist(tx, v, session.id, { now }) : { promoted: [], skipped: [] };
  return { status, late, penalty, creditOutcome: settled.settled ? outcome : "none", ...promo };
}

/**
 * Fill open spots from the waitlist, in order. Each candidate is re-checked for eligibility and
 * entitlement (credits are reserved now); candidates who can't be charged are skipped (and stay
 * on the waitlist) with the reason recorded in the audit log. Runs inside the caller's transaction.
 */
export async function promoteWaitlist(tx: Tx, v: Viewer, sessionId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const session = await lockSession(tx, v.orgId, sessionId);
  const promoted: string[] = [];
  const skipped: { bookingId: string; reason: string }[] = [];
  if (session.status !== "scheduled" || now >= session.startsAt) return { promoted, skipped };
  const st = await getServiceType(tx, v.orgId, session.serviceTypeId);
  const settings = await bookingSettings(tx, v.orgId);

  const waiting = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.status, "waitlisted")))
    .orderBy(sql`${bookings.waitlistPosition} asc nulls last`, asc(bookings.createdAt))
    .for("update");
  let { occupying } = await occupancy(tx, session.id);
  for (const w of waiting) {
    if (occupying >= session.capacity) break;
    const who = await athleteName(tx, w.athleteId);
    const label = who ? `${who.first} ${who.last}` : "Athlete";
    let reason: string | null = null;
    const el = await checkEligibility(tx, { orgId: v.orgId, athleteId: w.athleteId, serviceType: st, at: session.startsAt, tz: settings.timezone });
    if (!el.ok) reason = el.reasons.join(" ");
    let entitlementSource = w.entitlementSource;
    let membershipId = w.membershipId;
    let creditBucketId: string | null = null;
    if (!reason && entitlementSource !== "comp" && requiresEntitlement(st)) {
      const ent = await resolveEntitlement(tx, { orgId: v.orgId, athleteId: w.athleteId, serviceType: st, at: session.startsAt, tz: settings.timezone });
      if (ent.kind === "unlimited") {
        entitlementSource = "unlimited";
        membershipId = ent.membershipId;
      } else {
        try {
          const r = await reserveCredits(tx, { orgId: v.orgId, athleteId: w.athleteId, bookingId: w.id, serviceTypeId: st.id, cost: st.creditCost, sessionStartsAt: session.startsAt, actorUserId: v.userId });
          entitlementSource = "credit";
          creditBucketId = r.bucketId;
        } catch (e) {
          if (!(e instanceof InsufficientCreditsError)) throw e;
          reason = "No active membership or available credits.";
        }
      }
    }
    if (reason) {
      skipped.push({ bookingId: w.id, reason });
      await audit(tx, actorOf(v), "booking.waitlist_skipped", "booking", w.id, { summary: `${label} skipped for waitlist promotion on ${session.title}: ${reason}` });
      continue;
    }
    await tx
      .update(bookings)
      .set({ status: "booked", waitlistPosition: null, entitlementSource, membershipId, creditBucketId, updatedAt: now })
      .where(eq(bookings.id, w.id));
    occupying += 1;
    promoted.push(w.id);
    await enqueue(tx, {
      type: "notify.waitlist_promoted",
      orgId: v.orgId,
      payload: { bookingId: w.id, sessionId: session.id, athleteId: w.athleteId },
      dedupeKey: `notify.waitlist_promoted:${w.id}`,
    });
    await audit(tx, actorOf(v), "booking.waitlist_promote", "booking", w.id, {
      summary: `${label} promoted from the waitlist into ${session.title}`,
      before: { status: "waitlisted", waitlistPosition: w.waitlistPosition },
      after: { status: "booked", entitlementSource },
    });
  }
  await compactWaitlist(tx, session.id);
  return { promoted, skipped };
}

export type AttendanceOutcome = "attended" | "no_show";

/**
 * Record attendance. attended → credit consumed. no_show → policy (forfeit / release / fee).
 * Corrections between attended and no_show are allowed for staff and keep credits consistent.
 */
export async function markAttendance(
  tx: Tx,
  v: Viewer,
  input: { bookingId: string; outcome: AttendanceOutcome; method?: "staff" | "kiosk" | "self"; now?: Date },
) {
  const now = input.now ?? new Date();
  const { booking, session } = await lockBooking(tx, v, input.bookingId);
  const kiosk = v.role === "kiosk";
  if (kiosk) {
    if (!can(v, "schedule.checkin")) throw new AuthzError();
    if (input.outcome !== "attended") throw new AuthzError("The kiosk can only check athletes in.");
  } else if (!canRunSession(v, session)) {
    throw new AuthzError("Only schedule managers or this session's coach can take attendance.");
  }
  if (session.status === "cancelled") throw new UserError("This session was cancelled.");
  if (input.outcome === "attended" && now.getTime() < session.startsAt.getTime() - 60 * 60_000 && kiosk) {
    throw new UserError("Check-in opens 60 minutes before the session.");
  }
  if (input.outcome === "no_show" && now < session.startsAt) throw new UserError("You can mark a no-show once the session has started.");

  const who = await athleteName(tx, booking.athleteId);
  const label = who ? `${who.first} ${who.last}` : "Athlete";
  const st = await getServiceType(tx, v.orgId, session.serviceTypeId);
  const policy = await policyFor(tx, st);

  if (booking.status === input.outcome) return { status: booking.status, changed: false };
  if (booking.status === "booked") {
    let outcome: Settlement;
    if (input.outcome === "attended") outcome = "consume";
    else outcome = policy?.noShowPenalty === "forfeit_credit" ? "forfeit" : "release";
    await settleReservation(tx, { bookingId: booking.id, outcome, actorUserId: v.userId, reason: input.outcome === "attended" ? "Attended" : "No-show" });
    if (input.outcome === "no_show" && policy?.noShowPenalty === "fee") await recordPendingFee(tx, v, { booking, session, policy, kind: "no_show", athleteLabel: label });
  } else if ((booking.status === "attended" || booking.status === "no_show") && !kiosk) {
    // Correction. attended→no_show under a non-forfeit policy gives the credit back.
    if (booking.status === "attended" && input.outcome === "no_show" && policy?.noShowPenalty !== "forfeit_credit") {
      await restoreCredit(tx, { bookingId: booking.id, actorUserId: v.userId, reason: "Corrected attendance to no-show (policy: no forfeit)" });
      if (policy?.noShowPenalty === "fee") await recordPendingFee(tx, v, { booking, session, policy, kind: "no_show", athleteLabel: label });
    }
  } else {
    throw new UserError(`Can't record attendance for a ${booking.status.replace("_", " ")} booking.`);
  }
  await tx
    .update(bookings)
    .set({
      status: input.outcome,
      checkedInAt: input.outcome === "attended" ? now : null,
      checkInMethod: input.outcome === "attended" ? (input.method ?? (kiosk ? "kiosk" : "staff")) : null,
      updatedAt: now,
    })
    .where(eq(bookings.id, booking.id));
  await audit(tx, actorOf(v), input.outcome === "attended" ? "booking.check_in" : "booking.no_show", "booking", booking.id, {
    summary: `${label} ${input.outcome === "attended" ? "checked in" : "marked no-show"} — ${session.title}${kiosk ? " (kiosk)" : ""}`,
    before: { status: booking.status },
    after: { status: input.outcome },
  });
  return { status: input.outcome, changed: true };
}

/** Staff override: give back a consumed/forfeited credit (e.g. excused no-show). Once per booking; reason required. */
export async function restoreBookingCredit(tx: Tx, v: Viewer, input: { bookingId: string; reason: string }) {
  if (!can(v, "schedule.manage")) throw new AuthzError("Only schedule managers can restore credits.");
  if (!input.reason.trim()) throw new UserError("A reason is required to restore a credit.", { reason: "Required" });
  const { booking, session } = await lockBooking(tx, v, input.bookingId);
  const r = await restoreCredit(tx, { bookingId: booking.id, actorUserId: v.userId, reason: input.reason });
  if (!r.restored) throw new UserError("There is no used or forfeited credit on this booking to restore (or it was already restored).");
  await audit(tx, actorOf(v), "booking.credit_restore", "booking", booking.id, { summary: `Credit restored for ${session.title}: ${input.reason}` });
  return r;
}

/** Credit ledger state for a set of bookings (for roster display). */
export async function creditStateFor(tx: Tx, bookingIds: string[]) {
  if (!bookingIds.length) return new Map<string, string[]>();
  const rows = await tx.select({ bookingId: creditLedger.bookingId, kind: creditLedger.kind }).from(creditLedger).where(inArray(creditLedger.bookingId, bookingIds));
  const m = new Map<string, string[]>();
  for (const r of rows) if (r.bookingId) m.set(r.bookingId, [...(m.get(r.bookingId) ?? []), r.kind]);
  return m;
}

/** Atomic move: cancel the old booking (policy applies; staff may waive) and book the new session. */
export async function rescheduleBooking(
  tx: Tx,
  v: Viewer,
  input: { bookingId: string; toSessionId: string; idempotencyKey?: string | null; waiveReason?: string; now?: Date },
) {
  const [b] = await tx.select().from(bookings).where(and(eq(bookings.id, input.bookingId), eq(bookings.orgId, v.orgId)));
  if (!b) throw new UserError("That booking was not found.");
  if (b.sessionId === input.toSessionId) throw new UserError("Pick a different session to reschedule to.");
  // Lock both sessions in a stable order to avoid deadlocks between concurrent reschedules.
  const ids = [b.sessionId, input.toSessionId].sort();
  for (const id of ids) await lockSession(tx, v.orgId, id);
  if (input.idempotencyKey) {
    const [prior] = await tx.select().from(bookings).where(and(eq(bookings.orgId, v.orgId), eq(bookings.idempotencyKey, input.idempotencyKey)));
    if (prior) return { cancelled: null, booked: { booking: prior, status: prior.status as "booked" | "waitlisted", reused: true } };
  }
  const cancelled = await cancelBooking(tx, v, { bookingId: b.id, mode: input.waiveReason ? "waive" : "auto", reason: input.waiveReason, now: input.now });
  const booked = await bookSession(tx, v, {
    sessionId: input.toSessionId,
    athleteId: b.athleteId,
    idempotencyKey: input.idempotencyKey,
    rescheduledFromBookingId: b.id,
    allowWaitlist: false,
    comp: b.entitlementSource === "comp" && canRunSession(v, { coachUserId: null }) ? { reason: "Rescheduled comp booking" } : null,
    now: input.now,
  });
  return { cancelled, booked };
}

/** Upcoming live bookings for the given athletes (family "My bookings"). */
export async function upcomingBookingsFor(tx: Tx, orgId: string, athleteIds: string[], now = new Date()) {
  if (!athleteIds.length) return [];
  return tx
    .select({ booking: bookings, session: scheduleSessions })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.orgId, orgId),
        inArray(bookings.athleteId, athleteIds),
        inArray(bookings.status, ["booked", "waitlisted"]),
        sql`${scheduleSessions.endsAt} > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt));
}

