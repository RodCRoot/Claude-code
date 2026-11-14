import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, eventRegistrations, eventWaitlistEntries, payerAccounts, people, users, type EventWaitlistStatus } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { actorOf } from "@/lib/billing/util";
import { checkEligibility } from "@/lib/scheduling/eligibility";
import { orgTimezone } from "@/lib/scheduling/common";
import { eventSessionRows, lockEvent, seatsTaken } from "./confirm";
import { eventEligibilitySpec, registerForEvent, registrableAthletes, releaseExpiredHoldsForEvent, resolveSeats, type RegisterResult } from "./registration";
import { advanceWaitlist, type WaitlistRow } from "./waitlist-core";
import { registrationClosedReason } from "./window";

/**
 * Camp and clinic waitlist.
 *
 * A family joins for named athletes with exactly the checks registering uses (who may pay and book,
 * age and required forms). When a held or confirmed spot is released, the first athlete in line is
 * OFFERED it (see `advanceWaitlist`): the seat is reserved for them until the offer runs out, nothing
 * is charged and no message is sent. Accepting creates the normal registration and bill through
 * `registerForEvent`. Declining, or letting the offer run out, passes the spot to the next in line.
 *
 * Every decision is made under the event row lock, like registration.
 */

const KIND_WORD = { camp: "camp", clinic: "clinic", event: "event" } as const;

export type JoinInput = { eventId: string; athleteIds: string[]; override?: { reason: string } | null; now?: Date };

export async function joinEventWaitlist(tx: Tx, v: Viewer, input: JoinInput): Promise<{ entryIds: string[]; positions: number[] }> {
  const now = input.now ?? new Date();
  const family = v.role === "guardian" || v.role === "athlete";
  const staff = can(v, "billing.manage");
  if (!family && !staff) throw new AuthzError("You don't have permission to add athletes to a waitlist.");
  if (input.override && !staff) throw new AuthzError("Only staff can override eligibility.");
  if (input.override && !input.override.reason.trim()) throw new UserError("A reason is required to override eligibility.", { overrideReason: "Required" });
  const athleteIds = [...new Set(input.athleteIds.filter(Boolean))];
  if (!athleteIds.length) throw new UserError("Choose at least one athlete.");
  if (athleteIds.length > 10) throw new UserError("Add up to 10 athletes at a time.");

  const event = await lockEvent(tx, v.orgId, input.eventId);
  if (!event || (event.status === "draft" && !staff)) throw new UserError("That event was not found.");
  const tz = await orgTimezone(tx, v.orgId);
  const firstStart = (await eventSessionRows(tx, event.id)).filter((s) => s.status === "scheduled")[0]?.startsAt ?? null;
  const closed = registrationClosedReason(event, firstStart, now, tz);
  if (closed) throw new UserError(closed);
  await releaseExpiredHoldsForEvent(tx, event, now);

  const seats = await resolveSeats(tx, v, athleteIds, family);
  const regs = await tx
    .select({ athleteId: eventRegistrations.athleteId, status: eventRegistrations.status })
    .from(eventRegistrations)
    .where(and(eq(eventRegistrations.eventId, event.id), inArray(eventRegistrations.status, ["held", "confirmed"])));
  const liveEntries = await tx
    .select()
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, event.id), inArray(eventWaitlistEntries.status, ["waiting", "offered"])));
  for (const s of seats) {
    if (regs.some((r) => r.athleteId === s.athleteId)) throw new UserError(`${s.name} already has a spot.`);
    if (liveEntries.some((e) => e.athleteId === s.athleteId)) throw new UserError(`${s.name} is already on the waitlist.`);
    if (!input.override) {
      const el = await checkEligibility(tx, { orgId: v.orgId, athleteId: s.athleteId, serviceType: eventEligibilitySpec(event), at: firstStart!, tz });
      if (!el.ok) throw new UserError(`${s.name} can't join the waitlist yet: ${el.reasons.join(" ")}`);
    }
  }
  // A waitlist only exists while the event is full. With a free seat and nobody ahead, register instead.
  const free = event.capacity - (await seatsTaken(tx, event.id));
  const waitingAhead = liveEntries.some((e) => e.status === "waiting");
  if (free > 0 && !waitingAhead) throw new UserError(`This ${KIND_WORD[event.kind]} has ${free} spot${free === 1 ? "" : "s"} open. Register instead of joining the waitlist.`);

  const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${eventWaitlistEntries.position}), 0)::int` }).from(eventWaitlistEntries).where(eq(eventWaitlistEntries.eventId, event.id));
  const rows = await tx
    .insert(eventWaitlistEntries)
    .values(seats.map((s, i) => ({ orgId: v.orgId, eventId: event.id, athleteId: s.athleteId, payerAccountId: s.payerAccountId, status: "waiting" as const, position: max + 1 + i, addedByUserId: v.userId, isDemo: event.isDemo })))
    .returning();
  for (const [i, r] of rows.entries()) {
    await audit(tx, actorOf(v), "events.waitlist.join", "event_waitlist_entry", r.id, {
      summary: `${seats[i].name} joined the waitlist for ${event.name}${input.override ? `, eligibility override: ${input.override.reason}` : ""}`,
      after: { eventId: event.id, athleteId: r.athleteId, position: r.position },
    });
  }
  // If a seat is free (a hold was just released), the head of the line is offered it now.
  await advanceWaitlist(tx, event, now);
  const waitingIds = (
    await tx
      .select({ id: eventWaitlistEntries.id })
      .from(eventWaitlistEntries)
      .where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.status, "waiting")))
      .orderBy(asc(eventWaitlistEntries.position), asc(eventWaitlistEntries.createdAt))
  ).map((w) => w.id);
  return { entryIds: rows.map((r) => r.id), positions: rows.map((r) => waitingIds.indexOf(r.id) + 1) };
}

/** Load an entry in the viewer's organization and lock its event, then the entry. */
async function lockEntry(tx: Tx, v: Viewer, entryId: string) {
  if (!/^[0-9a-f-]{36}$/.test(entryId)) throw new UserError("That waitlist entry was not found.");
  const [peek] = await tx.select().from(eventWaitlistEntries).where(and(eq(eventWaitlistEntries.id, entryId), eq(eventWaitlistEntries.orgId, v.orgId)));
  if (!peek) throw new UserError("That waitlist entry was not found.");
  const event = await lockEvent(tx, v.orgId, peek.eventId);
  if (!event) throw new UserError("That waitlist entry was not found.");
  const [entry] = await tx.select().from(eventWaitlistEntries).where(eq(eventWaitlistEntries.id, peek.id)).for("update");
  return { event, entry };
}

/** A family login may act on an entry only for an athlete they could register (pay and book). */
async function assertFamilyMayAct(tx: Tx, v: Viewer, entry: WaitlistRow) {
  const allowed = await registrableAthletes(tx, v);
  if (!allowed.some((a) => a.athleteId === entry.athleteId)) throw new AuthzError("You can view this athlete but are not authorized to register and pay for them. Please ask the adult on the billing account, or the front desk.");
}

/**
 * Accept an offered spot: creates the normal held registration and its bill (same permission,
 * eligibility and pricing as registering today). Nothing is charged here.
 */
export async function acceptWaitlistOffer(tx: Tx, v: Viewer, input: { entryId: string; idempotencyKey: string; override?: { reason: string } | null; now?: Date }): Promise<RegisterResult> {
  const now = input.now ?? new Date();
  const { event, entry } = await lockEntry(tx, v, input.entryId);
  const family = v.role === "guardian" || v.role === "athlete";
  if (family) await assertFamilyMayAct(tx, v, entry);
  else assertCan(v, "billing.manage");
  if (entry.status === "accepted" && entry.registrationId) {
    // A second tap: answer with the registration the first one made.
    return registerForEvent(tx, v, { eventId: event.id, athleteIds: [entry.athleteId], idempotencyKey: input.idempotencyKey, override: input.override, now });
  }
  if (entry.status !== "offered") throw new UserError(entry.status === "expired" ? "That offer has run out and the spot went to the next family in line." : "There is no spot on offer for this athlete right now.");
  if (!entry.offerExpiresAt || entry.offerExpiresAt <= now) throw new UserError("That offer has run out and the spot went to the next family in line.");
  const result = await registerForEvent(tx, v, { eventId: event.id, athleteIds: [entry.athleteId], idempotencyKey: input.idempotencyKey, override: input.override, now }, { reservedWaitlistEntryIds: [entry.id] });
  // registerForEvent closes the athlete's waitlist entry (accepted + registration id).
  await audit(tx, actorOf(v), "events.waitlist.accept", "event_waitlist_entry", entry.id, {
    summary: `Waitlist offer for ${event.name} accepted: a registration and bill were created the normal way`,
    before: { status: "offered" },
    after: { status: "accepted", registrationId: result.registrationIds[0] ?? null },
  });
  return result;
}

/** A family says no to an offer, or leaves the line. The spot (if one was reserved) passes on. */
export async function leaveEventWaitlist(tx: Tx, v: Viewer, input: { entryId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const { event, entry } = await lockEntry(tx, v, input.entryId);
  const family = v.role === "guardian" || v.role === "athlete";
  if (family) await assertFamilyMayAct(tx, v, entry);
  else assertCan(v, "schedule.manage");
  if (entry.status !== "waiting" && entry.status !== "offered") throw new UserError("This athlete is not on the waitlist any more.");
  await tx
    .update(eventWaitlistEntries)
    .set({ status: "declined", closedAt: now, closedByUserId: v.userId, closedReason: entry.status === "offered" ? "Offer declined" : "Left the waitlist", offerExpiresAt: null, updatedAt: now })
    .where(eq(eventWaitlistEntries.id, entry.id));
  await audit(tx, actorOf(v), "events.waitlist.leave", "event_waitlist_entry", entry.id, {
    summary: entry.status === "offered" ? `Waitlist offer for ${event.name} declined; the spot passes to the next in line` : `Left the waitlist for ${event.name}`,
    before: { status: entry.status },
    after: { status: "declined" },
  });
  await advanceWaitlist(tx, event, now);
}

/** Staff remove an entry, with a reason. */
export async function removeWaitlistEntry(tx: Tx, v: Viewer, input: { entryId: string; reason: string; now?: Date }) {
  assertCan(v, "schedule.manage");
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) throw new UserError("A reason is required to remove someone from the waitlist.", { reason: "Required" });
  const { event, entry } = await lockEntry(tx, v, input.entryId);
  if (entry.status !== "waiting" && entry.status !== "offered") throw new UserError("This entry is already closed.");
  await tx
    .update(eventWaitlistEntries)
    .set({ status: "removed", closedAt: now, closedByUserId: v.userId, closedReason: reason.slice(0, 500), offerExpiresAt: null, updatedAt: now })
    .where(eq(eventWaitlistEntries.id, entry.id));
  await audit(tx, actorOf(v), "events.waitlist.remove", "event_waitlist_entry", entry.id, {
    summary: `Removed from the waitlist for ${event.name}: ${reason}`,
    before: { status: entry.status },
    after: { status: "removed" },
  });
  await advanceWaitlist(tx, event, now);
}

/** Staff move a waiting entry one place up or down the line. Offers already made are not affected. */
export async function moveWaitlistEntry(tx: Tx, v: Viewer, input: { entryId: string; direction: "up" | "down" }) {
  assertCan(v, "schedule.manage");
  if (input.direction !== "up" && input.direction !== "down") throw new UserError("Choose up or down.");
  const { event, entry } = await lockEntry(tx, v, input.entryId);
  if (entry.status !== "waiting") throw new UserError("Only athletes still waiting can be moved.");
  const line = await tx
    .select()
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.status, "waiting")))
    .orderBy(asc(eventWaitlistEntries.position), asc(eventWaitlistEntries.createdAt))
    .for("update");
  const i = line.findIndex((l) => l.id === entry.id);
  const j = input.direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= line.length) return { moved: false };
  // Renumber the whole line so positions stay unique and gap-free even after earlier edits.
  const order = [...line];
  [order[i], order[j]] = [order[j], order[i]];
  const base = Math.min(...line.map((l) => l.position));
  for (const [k, l] of order.entries()) {
    if (l.position !== base + k) await tx.update(eventWaitlistEntries).set({ position: base + k, updatedAt: new Date() }).where(eq(eventWaitlistEntries.id, l.id));
  }
  await audit(tx, actorOf(v), "events.waitlist.reorder", "event_waitlist_entry", entry.id, {
    summary: `Waitlist for ${event.name}: moved ${input.direction} one place (now ${j + 1} of ${line.length})`,
    before: { place: i + 1 },
    after: { place: j + 1 },
  });
  return { moved: true };
}

export type StaffWaitlistEntry = {
  id: string;
  athleteId: string;
  personId: string;
  athleteName: string;
  payerName: string;
  status: EventWaitlistStatus;
  /** 1-based place among those still waiting; null once offered or closed. */
  place: number | null;
  offerExpiresAt: Date | null;
  joinedAt: Date;
  addedBy: string | null;
  closedReason: string | null;
};

/** The line for one event: offers first, then waiting in order, then recent closed entries. */
export async function staffWaitlist(tx: Tx, v: Viewer, eventId: string): Promise<StaffWaitlistEntry[]> {
  assertCan(v, "schedule.manage");
  const rows = await tx
    .select({ e: eventWaitlistEntries, personId: people.id, first: people.firstName, last: people.lastName, payerName: payerAccounts.name, addedBy: users.displayName })
    .from(eventWaitlistEntries)
    .innerJoin(athletes, eq(athletes.id, eventWaitlistEntries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(payerAccounts, eq(payerAccounts.id, eventWaitlistEntries.payerAccountId))
    .leftJoin(users, eq(users.id, eventWaitlistEntries.addedByUserId))
    .where(and(eq(eventWaitlistEntries.eventId, eventId), eq(eventWaitlistEntries.orgId, v.orgId)))
    .orderBy(asc(eventWaitlistEntries.position), asc(eventWaitlistEntries.createdAt));
  const rank = (s: EventWaitlistStatus) => (s === "offered" ? 0 : s === "waiting" ? 1 : 2);
  let place = 0;
  return rows
    .map((r) => ({
      id: r.e.id,
      athleteId: r.e.athleteId,
      personId: r.personId,
      athleteName: `${r.first} ${r.last}`,
      payerName: r.payerName,
      status: r.e.status,
      place: r.e.status === "waiting" ? ++place : null,
      offerExpiresAt: r.e.status === "offered" ? r.e.offerExpiresAt : null,
      joinedAt: r.e.createdAt,
      addedBy: r.addedBy,
      closedReason: r.e.closedReason,
    }))
    .sort((a, b) => rank(a.status) - rank(b.status));
}

export type FamilyWaitlistEntry = { id: string; eventId: string; athleteId: string; first: string; status: "waiting" | "offered"; place: number | null; offerExpiresAt: Date | null };

/** The viewer's own athletes' live entries on the given events (never anyone else's, never the length of the line). */
export async function familyWaitlistEntries(tx: Tx, v: Viewer, eventIds: string[], athleteIds: string[]): Promise<FamilyWaitlistEntry[]> {
  if (!eventIds.length || !athleteIds.length) return [];
  const rows = await tx
    .select({ e: eventWaitlistEntries, first: people.firstName })
    .from(eventWaitlistEntries)
    .innerJoin(athletes, eq(athletes.id, eventWaitlistEntries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(eventWaitlistEntries.orgId, v.orgId), inArray(eventWaitlistEntries.eventId, eventIds), inArray(eventWaitlistEntries.status, ["waiting", "offered"])))
    .orderBy(asc(eventWaitlistEntries.eventId), asc(eventWaitlistEntries.position), asc(eventWaitlistEntries.createdAt));
  const placeBy = new Map<string, number>();
  const out: FamilyWaitlistEntry[] = [];
  for (const r of rows) {
    let place: number | null = null;
    if (r.e.status === "waiting") {
      place = (placeBy.get(r.e.eventId) ?? 0) + 1;
      placeBy.set(r.e.eventId, place);
    }
    if (athleteIds.includes(r.e.athleteId)) out.push({ id: r.e.id, eventId: r.e.eventId, athleteId: r.e.athleteId, first: r.first, status: r.e.status as "waiting" | "offered", place, offerExpiresAt: r.e.offerExpiresAt });
  }
  return out;
}
