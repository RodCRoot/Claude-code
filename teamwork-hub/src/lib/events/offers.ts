import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, events, eventWaitlistEntries, payerAccounts, people } from "@/db/schema";
import { accessibleAthleteIds, can, type Viewer } from "@/lib/authz/policy";
import { familyName } from "@/lib/growth/shop";
import { orgTimezone } from "@/lib/scheduling/common";
import type { EventRow } from "./confirm";
import { registrableAthletes } from "./registration";

/**
 * Live waitlist offers, for the places people already look (family Home, staff Today).
 *
 * Read-only: nothing here sweeps or writes. "Live" is decided in the query (`status = offered` and
 * `offer_expires_at > now`, the same rule as `isLiveOffer`), so an offer that has run out is left
 * out even when no sweep has marked it expired yet.
 */
export type LiveOffer = {
  entryId: string;
  eventId: string;
  eventName: string;
  kind: EventRow["kind"];
  athleteId: string;
  personId: string;
  first: string;
  athleteName: string;
  payerName: string;
  offerExpiresAt: Date;
  /** Family only: this login may accept or decline for the athlete (pay and book, as for registering). */
  canAct: boolean;
};

async function liveOffers(tx: Tx, orgId: string, now: Date, athleteIds: string[] | "all"): Promise<Omit<LiveOffer, "canAct">[]> {
  if (athleteIds !== "all" && !athleteIds.length) return [];
  const rows = await tx
    .select({ e: eventWaitlistEntries, eventName: events.name, kind: events.kind, personId: people.id, first: people.firstName, last: people.lastName, payerName: payerAccounts.name })
    .from(eventWaitlistEntries)
    .innerJoin(events, eq(events.id, eventWaitlistEntries.eventId))
    .innerJoin(athletes, eq(athletes.id, eventWaitlistEntries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(payerAccounts, eq(payerAccounts.id, eventWaitlistEntries.payerAccountId))
    .where(
      and(
        eq(eventWaitlistEntries.orgId, orgId),
        eq(events.orgId, orgId),
        eq(events.status, "published"),
        eq(eventWaitlistEntries.status, "offered"),
        gt(eventWaitlistEntries.offerExpiresAt, now),
        athleteIds === "all" ? undefined : inArray(eventWaitlistEntries.athleteId, athleteIds),
      ),
    )
    .orderBy(asc(eventWaitlistEntries.offerExpiresAt), asc(eventWaitlistEntries.createdAt));
  return rows.map((r) => ({ entryId: r.e.id, eventId: r.e.eventId, eventName: r.eventName, kind: r.kind, athleteId: r.e.athleteId, personId: r.personId, first: r.first, athleteName: `${r.first} ${r.last}`, payerName: r.payerName, offerExpiresAt: r.e.offerExpiresAt! }));
}

/** A guardian's or athlete's own athletes with a live offer, soonest expiry first. Staff logins get none. */
export async function familyLiveOffers(tx: Tx, v: Viewer, now = new Date()): Promise<{ offers: LiveOffer[]; tz: string }> {
  const tz = await orgTimezone(tx, v.orgId);
  if (v.role !== "guardian" && v.role !== "athlete") return { offers: [], tz };
  const visible = await accessibleAthleteIds(tx, v, "profile.read");
  const rows = await liveOffers(tx, v.orgId, now, visible === "all" ? [] : visible);
  if (!rows.length) return { offers: [], tz };
  const actable = new Set((await registrableAthletes(tx, v)).map((a) => a.athleteId));
  return { offers: rows.map((r) => ({ ...r, eventName: familyName(r.eventName), canAct: actable.has(r.athleteId) })), tz };
}

/** Every live offer in the organization, soonest expiry first, for the front desk (`schedule.manage`). Others get none. */
export async function staffLiveOffers(tx: Tx, v: Viewer, now = new Date()): Promise<{ offers: LiveOffer[]; tz: string }> {
  const tz = await orgTimezone(tx, v.orgId);
  if (!can(v, "schedule.manage")) return { offers: [], tz };
  return { offers: (await liveOffers(tx, v.orgId, now, "all")).map((r) => ({ ...r, canAct: false })), tz };
}
