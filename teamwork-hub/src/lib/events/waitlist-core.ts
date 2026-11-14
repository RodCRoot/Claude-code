import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { eventWaitlistEntries } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { orgTimezone } from "@/lib/scheduling/common";
import { fmt } from "@/lib/time";
import { eventSessionRows, seatsTaken, type EventRow } from "./confirm";
import { registrationClosedReason } from "./window";

/**
 * The part of the waitlist that the registration paths call. Kept apart from `waitlist.ts` (which
 * calls back into registration to accept an offer) so there is no import cycle.
 *
 * An offer RESERVES a seat: `seatsTaken` counts held and confirmed registrations plus live offers.
 * Every function here expects the caller to hold the event row lock (`lockEvent`).
 */
export type WaitlistRow = typeof eventWaitlistEntries.$inferSelect;

const SYSTEM = (orgId: string): AuditActor => ({ orgId, actorUserId: null, actorRole: "system" });

/** Live offers on an event, optionally leaving some out (the one being accepted right now). */
export async function liveOfferCount(tx: Tx, eventId: string, exceptIds: string[] = []): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, eventId), eq(eventWaitlistEntries.status, "offered"), exceptIds.length ? sql`${eventWaitlistEntries.id} not in (${sql.join(exceptIds.map((i) => sql`${i}`), sql`, `)})` : sql`true`));
  return r?.n ?? 0;
}

/**
 * 1. Offers whose time ran out are marked expired (their seat is free again).
 * 2. While a seat is free and someone is waiting, the first in line is OFFERED the seat, with an
 *    expiry of `waitlist_offer_hours` (never past the first session). Nothing is charged, no
 *    registration or invoice is created and no message is sent: the family sees the offer in the
 *    app and accepts it there.
 * No new offers are made once registration is closed or the event has started.
 */
export async function advanceWaitlist(tx: Tx, event: EventRow, now: Date, actor?: AuditActor): Promise<{ expired: number; offered: number }> {
  const who = actor ?? SYSTEM(event.orgId);
  const due = await tx
    .select()
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.status, "offered"), lte(eventWaitlistEntries.offerExpiresAt, now)))
    .for("update");
  if (due.length) {
    await tx
      .update(eventWaitlistEntries)
      .set({ status: "expired", closedAt: now, closedReason: "The offer was not accepted in time", updatedAt: now })
      .where(inArray(eventWaitlistEntries.id, due.map((d) => d.id)));
    for (const d of due) {
      await audit(tx, SYSTEM(event.orgId), "events.waitlist.offer_expired", "event_waitlist_entry", d.id, {
        summary: `Waitlist offer for ${event.name} expired without an answer; the spot passes to the next in line`,
        before: { status: "offered" },
        after: { status: "expired" },
      });
    }
  }

  const [anyWaiting] = await tx.select({ id: eventWaitlistEntries.id }).from(eventWaitlistEntries).where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.status, "waiting"))).limit(1);
  if (!anyWaiting) return { expired: due.length, offered: 0 };
  const tz = await orgTimezone(tx, event.orgId);
  const firstStart = (await eventSessionRows(tx, event.id)).filter((s) => s.status === "scheduled")[0]?.startsAt ?? null;
  if (!firstStart || registrationClosedReason(event, firstStart, now, tz)) return { expired: due.length, offered: 0 };

  const free = event.capacity - (await seatsTaken(tx, event.id));
  if (free <= 0) return { expired: due.length, offered: 0 };
  const next = await tx
    .select()
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.eventId, event.id), eq(eventWaitlistEntries.status, "waiting")))
    .orderBy(asc(eventWaitlistEntries.position), asc(eventWaitlistEntries.createdAt))
    .limit(free)
    .for("update");
  const offerExpiresAt = new Date(Math.min(now.getTime() + event.waitlistOfferHours * 3_600_000, firstStart.getTime()));
  for (const n of next) {
    await tx.update(eventWaitlistEntries).set({ status: "offered", offeredAt: now, offerExpiresAt, updatedAt: now }).where(eq(eventWaitlistEntries.id, n.id));
    await audit(tx, who, "events.waitlist.offer", "event_waitlist_entry", n.id, {
      summary: `A spot in ${event.name} opened and was offered to the first athlete on the waitlist until ${fmt(offerExpiresAt, "MMM d h:mm a", tz)}. Nothing was charged and no message was sent.`,
      before: { status: "waiting" },
      after: { status: "offered", offerExpiresAt: offerExpiresAt.toISOString() },
    });
  }
  return { expired: due.length, offered: next.length };
}
