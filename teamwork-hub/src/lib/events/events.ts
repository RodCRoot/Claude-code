import { and, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { events, eventRegistrations, eventSessions, formTemplates, organizations, scheduleSessions, serviceTypes, type EventKind, type EventStatus } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { actorOf } from "@/lib/billing/util";
import { orgTimezone } from "@/lib/scheduling/common";
import { createSession } from "@/lib/scheduling/sessions";
import { localToUtc } from "@/lib/time";
import { bookRegistrationIntoSessions, eventSessionRows, lockEvent, seatsTaken } from "./confirm";
import { DEFAULT_HOLD_HOURS } from "./pricing";

export const EVENT_KINDS: { value: EventKind; label: string }[] = [
  { value: "camp", label: "Camp" },
  { value: "clinic", label: "Clinic" },
  { value: "event", label: "Event" },
];
export const EVENT_KIND_LABEL: Record<EventKind, string> = { camp: "Camp", clinic: "Clinic", event: "Event" };

export type EventSessionInput = { date: string; startTime: string; endTime: string };

export type EventInput = {
  name: string;
  description?: string | null;
  kind: EventKind;
  capacity: number;
  /** Integer minor units, entered by staff. 0 = free. */
  priceMinor: number;
  earlyBirdPriceMinor?: number | null;
  earlyBirdUntil?: string | null;
  siblingDiscountPercent?: number | null;
  registrationOpensOn?: string | null;
  registrationClosesOn?: string | null;
  minAge?: number | null;
  maxAge?: number | null;
  requiredFormTemplateIds?: string[];
  holdHours?: number | null;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

async function validate(tx: Tx, orgId: string, i: EventInput) {
  const name = i.name.trim();
  if (!name) throw new UserError("Give the event a name.", { name: "Required" });
  if (name.length > 120) throw new UserError("Keep the name under 120 characters.", { name: "Too long" });
  if (!EVENT_KINDS.some((k) => k.value === i.kind)) throw new UserError("Choose a kind.", { kind: "Required" });
  if (!isInt(i.capacity) || i.capacity < 1 || i.capacity > 1000) throw new UserError("Capacity must be a whole number from 1 to 1000.", { capacity: "1 to 1000" });
  if (!isInt(i.priceMinor) || i.priceMinor < 0) throw new UserError("Enter the price (0 for a free event).", { price: "Required" });
  const early = i.earlyBirdPriceMinor ?? null;
  const earlyUntil = i.earlyBirdUntil || null;
  if ((early == null) !== (earlyUntil == null)) throw new UserError("An early bird price needs both a price and a last day.", { earlyBirdUntil: "Both or neither" });
  if (early != null) {
    if (!isInt(early) || early < 0 || early >= i.priceMinor) throw new UserError("The early bird price must be lower than the regular price.", { earlyBirdPrice: "Must be lower" });
    if (!YMD.test(earlyUntil!)) throw new UserError("Choose the last early bird day.", { earlyBirdUntil: "Invalid date" });
  }
  const sib = i.siblingDiscountPercent ?? null;
  if (sib != null && (!isInt(sib) || sib < 1 || sib > 100)) throw new UserError("Sibling discount must be a whole percent from 1 to 100, or empty.", { siblingDiscountPercent: "1 to 100" });
  const opens = i.registrationOpensOn || null;
  const closes = i.registrationClosesOn || null;
  for (const [k, d] of [["registrationOpensOn", opens], ["registrationClosesOn", closes]] as const) if (d && !YMD.test(d)) throw new UserError("Enter a valid date.", { [k]: "Invalid date" });
  if (opens && closes && opens > closes) throw new UserError("Registration must open before it closes.", { registrationClosesOn: "Before the open date" });
  const minAge = i.minAge ?? null;
  const maxAge = i.maxAge ?? null;
  for (const [k, a] of [["minAge", minAge], ["maxAge", maxAge]] as const) if (a != null && (!isInt(a) || a < 0 || a > 120)) throw new UserError("Ages must be whole numbers.", { [k]: "Invalid" });
  if (minAge != null && maxAge != null && minAge > maxAge) throw new UserError("Minimum age cannot be above the maximum age.", { maxAge: "Below minimum" });
  const holdHours = i.holdHours ?? DEFAULT_HOLD_HOURS;
  if (!isInt(holdHours) || holdHours < 1 || holdHours > 720) throw new UserError("The unpaid hold must be between 1 and 720 hours.", { holdHours: "1 to 720" });
  const formIds = [...new Set(i.requiredFormTemplateIds ?? [])];
  if (formIds.length) {
    const found = await tx.select({ id: formTemplates.id }).from(formTemplates).where(and(inArray(formTemplates.id, formIds), eq(formTemplates.orgId, orgId)));
    if (found.length !== formIds.length) throw new UserError("One of the required forms was not found.");
  }
  return {
    name,
    description: i.description?.trim() || null,
    kind: i.kind,
    capacity: i.capacity,
    priceMinor: i.priceMinor,
    earlyBirdPriceMinor: early,
    earlyBirdUntil: earlyUntil,
    siblingDiscountPercent: sib,
    registrationOpensOn: opens,
    registrationClosesOn: closes,
    minAge,
    maxAge,
    requiredFormTemplateIds: formIds,
    holdHours,
  };
}

/** One service type per kind for event sessions: no membership or credits are ever needed for them. */
async function eventServiceTypeId(tx: Tx, orgId: string, kind: EventKind): Promise<string> {
  const name = `${EVENT_KIND_LABEL[kind]} session`;
  const stKind = kind === "event" ? ("event" as const) : ("camp" as const);
  const rows = await tx.select().from(serviceTypes).where(and(eq(serviceTypes.orgId, orgId), eq(serviceTypes.name, name), eq(serviceTypes.kind, stKind)));
  const ok = rows.find((r) => r.creditCost === 0 && r.eligibility?.requiresEntitlement === false);
  if (ok) return ok.id;
  const [st] = await tx
    .insert(serviceTypes)
    .values({ orgId, name, kind: stKind, description: "Sessions that belong to a camp, clinic or event. Sold by registration, not by credits.", creditCost: 0, eligibility: { requiresEntitlement: false }, publicBookable: false, color: "#ea580c" })
    .returning();
  return st.id;
}

function sessionTimes(s: EventSessionInput, tz: string) {
  if (!YMD.test(s.date) || !HM.test(s.startTime) || !HM.test(s.endTime)) throw new UserError("Each session needs a date, a start time and an end time.", { sessions: "Incomplete" });
  const startsAt = localToUtc(s.date, s.startTime, tz);
  const endsAt = localToUtc(s.date, s.endTime, tz);
  const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  if (!(minutes > 0)) throw new UserError("A session must end after it starts.", { sessions: "End before start" });
  return { startsAt, minutes };
}

async function insertSessions(tx: Tx, v: Viewer, event: typeof events.$inferSelect, list: EventSessionInput[], opts: { coachUserId?: string | null; resourceId?: string | null }) {
  const tz = await orgTimezone(tx, v.orgId);
  const serviceTypeId = await eventServiceTypeId(tx, v.orgId, event.kind);
  const ids: string[] = [];
  for (const s of list) {
    const { startsAt, minutes } = sessionTimes(s, tz);
    // Private: families cannot book these with credits; the only way in is the event registration.
    const session = await createSession(
      tx,
      v,
      { serviceTypeId, title: event.name, startsAt, durationMinutes: minutes, capacity: event.capacity, waitlistCapacity: 0, visibility: "private", coachUserId: opts.coachUserId || null, resourceId: opts.resourceId || null },
      { isDemo: event.isDemo },
    );
    await tx.insert(eventSessions).values({ sessionId: session.id, eventId: event.id, orgId: v.orgId });
    ids.push(session.id);
  }
  return ids;
}

/** Create a draft event with its sessions. Staff with schedule.manage. */
export async function createEvent(
  tx: Tx,
  v: Viewer,
  input: EventInput & { sessions: EventSessionInput[]; coachUserId?: string | null; resourceId?: string | null },
  opts: { isDemo?: boolean } = {},
) {
  assertCan(v, "schedule.manage");
  const values = await validate(tx, v.orgId, input);
  if (!input.sessions.length) throw new UserError("Add at least one session date.", { sessions: "Required" });
  if (input.sessions.length > 60) throw new UserError("An event can have up to 60 sessions.", { sessions: "Too many" });
  const [org] = await tx.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, v.orgId));
  const [event] = await tx
    .insert(events)
    .values({ ...values, orgId: v.orgId, status: "draft", currency: (org?.currency ?? "USD").toUpperCase(), createdBy: v.userId, isDemo: opts.isDemo ?? false })
    .returning();
  const sessionIds = await insertSessions(tx, v, event, input.sessions, input);
  await audit(tx, actorOf(v), "events.create", "event", event.id, { summary: `Created ${EVENT_KIND_LABEL[event.kind].toLowerCase()} "${event.name}" (draft, ${sessionIds.length} session(s), capacity ${event.capacity})`, after: values });
  return { event, sessionIds };
}

export async function updateEvent(tx: Tx, v: Viewer, eventId: string, input: EventInput) {
  assertCan(v, "schedule.manage");
  const before = await lockEvent(tx, v.orgId, eventId);
  if (!before) throw new UserError("Event not found.");
  const values = await validate(tx, v.orgId, input);
  const taken = await seatsTaken(tx, before.id);
  if (values.capacity < taken) throw new UserError(`${taken} spots are already taken. Capacity cannot go below that.`, { capacity: `At least ${taken}` });
  const [event] = await tx.update(events).set({ ...values, updatedAt: new Date() }).where(eq(events.id, before.id)).returning();
  if (values.capacity !== before.capacity || values.name !== before.name) {
    const upcoming = (await eventSessionRows(tx, event.id)).filter((s) => s.status === "scheduled" && s.endsAt > new Date()).map((s) => s.id);
    if (upcoming.length) await tx.update(scheduleSessions).set({ capacity: values.capacity, title: values.name, updatedAt: new Date() }).where(and(inArray(scheduleSessions.id, upcoming), eq(scheduleSessions.orgId, v.orgId)));
  }
  const pick = (e: typeof before) => Object.fromEntries(Object.keys(values).map((k) => [k, e[k as keyof typeof e]]));
  await audit(tx, actorOf(v), "events.update", "event", event.id, { summary: `Updated "${event.name}"`, before: pick(before), after: values });
  return event;
}

/** Add a session to an event. Athletes who are already confirmed are booked into it. */
export async function addEventSession(tx: Tx, v: Viewer, input: { eventId: string; session: EventSessionInput; coachUserId?: string | null; resourceId?: string | null }) {
  assertCan(v, "schedule.manage");
  const event = await lockEvent(tx, v.orgId, input.eventId);
  if (!event) throw new UserError("Event not found.");
  const [sessionId] = await insertSessions(tx, v, event, [input.session], input);
  const confirmed = await tx.select().from(eventRegistrations).where(and(eq(eventRegistrations.eventId, event.id), eq(eventRegistrations.status, "confirmed")));
  for (const r of confirmed) await bookRegistrationIntoSessions(tx, r, [sessionId]);
  await audit(tx, actorOf(v), "events.session.add", "event", event.id, { summary: `Added a session to "${event.name}" (${input.session.date} ${input.session.startTime}); ${confirmed.length} confirmed athlete(s) booked in`, after: { sessionId } });
  return sessionId;
}

/** draft → published (families can see and register) → closed (no new registrations; existing ones stand). */
export async function setEventStatus(tx: Tx, v: Viewer, input: { eventId: string; status: EventStatus; now?: Date }) {
  assertCan(v, "schedule.manage");
  const event = await lockEvent(tx, v.orgId, input.eventId);
  if (!event) throw new UserError("Event not found.");
  if (!["draft", "published", "closed"].includes(input.status)) throw new UserError("Unknown status.");
  if (event.status === input.status) return event;
  const now = input.now ?? new Date();
  if (input.status === "published") {
    const [upcoming] = await tx
      .select({ id: scheduleSessions.id })
      .from(eventSessions)
      .innerJoin(scheduleSessions, eq(scheduleSessions.id, eventSessions.sessionId))
      .where(and(eq(eventSessions.eventId, event.id), eq(scheduleSessions.status, "scheduled"), gt(scheduleSessions.startsAt, now)))
      .limit(1);
    if (!upcoming) throw new UserError("Add at least one upcoming session before publishing.");
  }
  if (input.status === "draft" && (await seatsTaken(tx, event.id)) > 0) throw new UserError("This event has registrations, so it cannot go back to draft. Close it instead.");
  const [updated] = await tx
    .update(events)
    .set({ status: input.status, publishedAt: input.status === "published" ? (event.publishedAt ?? now) : event.publishedAt, updatedAt: now })
    .where(eq(events.id, event.id))
    .returning();
  await audit(tx, actorOf(v), `events.${input.status === "published" ? "publish" : input.status === "closed" ? "close" : "unpublish"}`, "event", event.id, {
    summary: `"${event.name}" is now ${input.status}`,
    before: { status: event.status },
    after: { status: input.status },
  });
  return updated;
}
