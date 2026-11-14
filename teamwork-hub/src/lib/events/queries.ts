import Papa from "papaparse";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, eventRegistrations, events, eventSessions, eventWaitlistEntries, formTemplates, invoices, payerAccounts, people, scheduleSessions, users, type EventRegistrationStatus } from "@/db/schema";
import { accessibleAthleteIds, assertCan, athleteCapabilities, can, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";
import { int } from "@/lib/billing/util";
import { CSV_FORMULA_ESCAPE } from "@/lib/csv";
import { familyName, shopAthletes } from "@/lib/growth/shop";
import { ageOn, checkEligibility } from "@/lib/scheduling/eligibility";
import { orgTimezone } from "@/lib/scheduling/common";
import { fmt, localYmd } from "@/lib/time";
import type { EventRow } from "./confirm";
import { eventPriceOn } from "./pricing";
import { eventEligibilitySpec, registrationClosedReason } from "./registration";
import { familyWaitlistEntries, type FamilyWaitlistEntry } from "./waitlist";

export type EventSessionView = { id: string; startsAt: Date; endsAt: Date; status: string };

async function sessionsByEvent(tx: Tx, eventIds: string[]): Promise<Map<string, EventSessionView[]>> {
  const out = new Map<string, EventSessionView[]>();
  if (!eventIds.length) return out;
  const rows = await tx
    .select({ eventId: eventSessions.eventId, id: scheduleSessions.id, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, status: scheduleSessions.status })
    .from(eventSessions)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, eventSessions.sessionId))
    .where(inArray(eventSessions.eventId, eventIds))
    .orderBy(asc(scheduleSessions.startsAt));
  for (const r of rows) out.set(r.eventId, [...(out.get(r.eventId) ?? []), r]);
  return out;
}

/** `offered` = spots reserved by a live waitlist offer; `waiting` = athletes still in line. */
export type EventCounts = { confirmed: number; held: number; cancelled: number; expired: number; heldMinor: number; paidMinor: number; offered: number; waiting: number };

async function countsByEvent(tx: Tx, orgId: string, eventIds: string[]): Promise<Map<string, EventCounts>> {
  const out = new Map<string, EventCounts>();
  if (!eventIds.length) return out;
  const rows = await tx
    .select({
      eventId: eventRegistrations.eventId,
      confirmed: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'confirmed')::int`,
      held: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'held')::int`,
      cancelled: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'cancelled')::int`,
      expired: sql<number>`count(*) filter (where ${eventRegistrations.status} = 'expired')::int`,
      heldMinor: sql<string>`coalesce(sum(${eventRegistrations.amountMinor}) filter (where ${eventRegistrations.status} = 'held'),0)::bigint`,
      paidMinor: sql<string>`coalesce(sum(${eventRegistrations.amountMinor}) filter (where ${invoices.status} = 'paid'),0)::bigint`,
    })
    .from(eventRegistrations)
    .leftJoin(invoices, eq(invoices.id, eventRegistrations.invoiceId))
    .where(and(eq(eventRegistrations.orgId, orgId), inArray(eventRegistrations.eventId, eventIds)))
    .groupBy(eventRegistrations.eventId);
  for (const r of rows) out.set(r.eventId, { confirmed: r.confirmed, held: r.held, cancelled: r.cancelled, expired: r.expired, heldMinor: int(r.heldMinor), paidMinor: int(r.paidMinor), offered: 0, waiting: 0 });
  const line = await tx
    .select({
      eventId: eventWaitlistEntries.eventId,
      offered: sql<number>`count(*) filter (where ${eventWaitlistEntries.status} = 'offered')::int`,
      waiting: sql<number>`count(*) filter (where ${eventWaitlistEntries.status} = 'waiting')::int`,
    })
    .from(eventWaitlistEntries)
    .where(and(eq(eventWaitlistEntries.orgId, orgId), inArray(eventWaitlistEntries.eventId, eventIds)))
    .groupBy(eventWaitlistEntries.eventId);
  for (const l of line) out.set(l.eventId, { ...(out.get(l.eventId) ?? NO_COUNTS), offered: l.offered, waiting: l.waiting });
  return out;
}

const NO_COUNTS: EventCounts = { confirmed: 0, held: 0, cancelled: 0, expired: 0, heldMinor: 0, paidMinor: 0, offered: 0, waiting: 0 };

/** "Ages 10 to 14", "Ages 10 and up", "Ages 14 and under" or null. */
export function ageLabel(e: Pick<EventRow, "minAge" | "maxAge">): string | null {
  if (e.minAge != null && e.maxAge != null) return `Ages ${e.minAge} to ${e.maxAge}`;
  if (e.minAge != null) return `Ages ${e.minAge} and up`;
  if (e.maxAge != null) return `Ages ${e.maxAge} and under`;
  return null;
}

/** "Mon, Dec 21" or "Dec 21 to Dec 23 (3 days)". */
export function dateRangeLabel(sessions: { startsAt: Date }[], tz: string): string {
  if (!sessions.length) return "Dates to be announced";
  const days = [...new Set(sessions.map((s) => localYmd(s.startsAt, tz)))];
  if (days.length === 1) return fmt(sessions[0].startsAt, "EEE, MMM d", tz);
  return `${fmt(sessions[0].startsAt, "MMM d", tz)} to ${fmt(sessions[sessions.length - 1].startsAt, "MMM d", tz)} (${days.length} days)`;
}

export type FamilyEvent = {
  id: string;
  name: string;
  kind: EventRow["kind"];
  description: string | null;
  tz: string;
  sessions: EventSessionView[];
  dates: string;
  ages: string | null;
  priceMinor: number;
  regularPriceMinor: number;
  earlyBird: boolean;
  earlyBirdUntil: string | null;
  siblingDiscountPercent: number | null;
  currency: string;
  capacity: number;
  spotsLeft: number;
  /** Null when registration is open. */
  closedReason: string | null;
  holdHours: number;
  waitlistOfferHours: number;
  /** The viewer's own athletes on this event's waitlist (waiting or offered a spot). */
  waitlist: FamilyWaitlistEntry[];
  mine: { athleteId: string; first: string; status: EventRegistrationStatus; invoiceId: string | null; holdExpiresAt: Date | null }[];
};

async function toFamilyEvents(tx: Tx, v: Viewer, rows: EventRow[], now: Date): Promise<FamilyEvent[]> {
  if (!rows.length) return [];
  const tz = await orgTimezone(tx, v.orgId);
  const ids = rows.map((r) => r.id);
  const [sess, counts] = await Promise.all([sessionsByEvent(tx, ids), countsByEvent(tx, v.orgId, ids)]);
  // The viewer's own family: athletes they can see, and registrations on billing accounts they can view.
  const visible = await accessibleAthleteIds(tx, v, "profile.read");
  const viewablePayers = v.role === "guardian" || v.role === "athlete" ? await payerAccountIdsFor(tx, v, "view") : [];
  const athleteIds = visible === "all" ? [] : visible;
  const mineRows =
    athleteIds.length || viewablePayers.length
      ? await tx
          .select({ eventId: eventRegistrations.eventId, athleteId: eventRegistrations.athleteId, first: people.firstName, status: eventRegistrations.status, invoiceId: eventRegistrations.invoiceId, payerAccountId: eventRegistrations.payerAccountId, holdExpiresAt: eventRegistrations.holdExpiresAt })
          .from(eventRegistrations)
          .innerJoin(athletes, eq(athletes.id, eventRegistrations.athleteId))
          .innerJoin(people, eq(people.id, athletes.personId))
          .where(
            and(
              eq(eventRegistrations.orgId, v.orgId),
              inArray(eventRegistrations.eventId, ids),
              inArray(eventRegistrations.status, ["held", "confirmed"]),
              sql`(${athleteIds.length ? inArray(eventRegistrations.athleteId, athleteIds) : sql`false`} or ${viewablePayers.length ? inArray(eventRegistrations.payerAccountId, viewablePayers) : sql`false`})`,
            ),
          )
      : [];
  const myWaitlist = await familyWaitlistEntries(tx, v, ids, athleteIds);
  const today = localYmd(now, tz);
  return rows
    .map((e) => {
      const sessions = (sess.get(e.id) ?? []).filter((s) => s.status === "scheduled");
      const c = counts.get(e.id) ?? NO_COUNTS;
      const price = eventPriceOn(e, today);
      return {
        id: e.id,
        name: familyName(e.name),
        kind: e.kind,
        description: e.description ? familyName(e.description) : null,
        tz,
        sessions,
        dates: dateRangeLabel(sessions, tz),
        ages: ageLabel(e),
        priceMinor: price.baseMinor,
        regularPriceMinor: e.priceMinor,
        earlyBird: price.earlyBird,
        earlyBirdUntil: price.earlyBird ? e.earlyBirdUntil : null,
        siblingDiscountPercent: e.siblingDiscountPercent,
        currency: e.currency,
        capacity: e.capacity,
        spotsLeft: Math.max(0, e.capacity - c.confirmed - c.held - c.offered),
        closedReason: registrationClosedReason(e, sessions[0]?.startsAt ?? null, now, tz),
        holdHours: e.holdHours,
        waitlistOfferHours: e.waitlistOfferHours,
        waitlist: myWaitlist.filter((w) => w.eventId === e.id),
        mine: mineRows.filter((m) => m.eventId === e.id).map((m) => ({ athleteId: m.athleteId, first: m.first, status: m.status, invoiceId: viewablePayers.includes(m.payerAccountId) ? m.invoiceId : null, holdExpiresAt: m.holdExpiresAt })),
      };
    })
    .sort((a, b) => (a.sessions[0]?.startsAt.getTime() ?? Infinity) - (b.sessions[0]?.startsAt.getTime() ?? Infinity));
}

/** Published events that have not finished, soonest first. */
export async function listFamilyEvents(tx: Tx, v: Viewer, now = new Date()): Promise<FamilyEvent[]> {
  const rows = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.orgId, v.orgId),
        eq(events.status, "published"),
        sql`exists (select 1 from event_sessions es join schedule_sessions s on s.id = es.session_id where es.event_id = ${events.id} and s.status = 'scheduled' and s.ends_at > ${now.toISOString()}::timestamptz)`,
      ),
    );
  return toFamilyEvents(tx, v, rows, now);
}

export type AthleteOption = {
  athleteId: string;
  name: string;
  first: string;
  /** registered = paid and confirmed; held = spot held, invoice unpaid; open = may register now; blocked = cannot, see reasons. */
  state: "registered" | "held" | "open" | "blocked" | "waitlisted" | "offered";
  reasons: string[];
  invoiceId: string | null;
  holdExpiresAt: Date | null;
  /** Waitlist entry (states waitlisted and offered): its id, place in line, and when an offer runs out. */
  entryId?: string;
  place?: number | null;
  offerExpiresAt?: Date | null;
  /** This login may accept or leave for the athlete (same rule as registering: pay and book). */
  canAct?: boolean;
};

/** One published (or closed, if the family is already registered) event with the viewer's athletes and what each may do. */
export async function familyEventDetail(tx: Tx, v: Viewer, eventId: string, now = new Date()): Promise<{ event: FamilyEvent; athletes: AthleteOption[]; canRegisterAny: boolean } | null> {
  const [row] = await tx.select().from(events).where(and(eq(events.id, eventId), eq(events.orgId, v.orgId)));
  if (!row || row.status === "draft") return null;
  const [event] = await toFamilyEvents(tx, v, [row], now);
  if (row.status === "closed" && !event.mine.length && !event.waitlist.length) return null;

  const payable = await shopAthletes(tx, v);
  const visible = await accessibleAthleteIds(tx, v, "profile.read");
  const ids = [...new Set([...(visible === "all" ? [] : visible), ...payable.map((p) => p.athleteId)])];
  const rows = ids.length
    ? await tx
        .select({ id: athletes.id, first: people.firstName, last: people.lastName })
        .from(athletes)
        .innerJoin(people, eq(people.id, athletes.personId))
        .where(and(inArray(athletes.id, ids), eq(athletes.orgId, v.orgId), eq(athletes.active, true)))
        .orderBy(asc(people.firstName))
    : [];
  const firstStart = event.sessions[0]?.startsAt ?? null;
  const out: AthleteOption[] = [];
  for (const a of rows) {
    const name = `${a.first} ${a.last}`;
    const mine = event.mine.find((m) => m.athleteId === a.id);
    if (mine) {
      out.push({ athleteId: a.id, name, first: a.first, state: mine.status === "confirmed" ? "registered" : "held", reasons: [], invoiceId: mine.invoiceId, holdExpiresAt: mine.holdExpiresAt });
      continue;
    }
    const reasons: string[] = [];
    const canPay = payable.some((p) => p.athleteId === a.id);
    const canBook = (await athleteCapabilities(tx, v, a.id)).has("booking.create");
    const entry = event.waitlist.find((w) => w.athleteId === a.id);
    if (entry) {
      out.push({ athleteId: a.id, name, first: a.first, state: entry.status === "offered" ? "offered" : "waitlisted", reasons: [], invoiceId: null, holdExpiresAt: null, entryId: entry.id, place: entry.place, offerExpiresAt: entry.offerExpiresAt, canAct: canPay && canBook });
      continue;
    }
    if (!canPay) reasons.push(`Your login can view ${a.first}'s account but cannot pay on it. The adult who pays on the billing account can register ${a.first}, or the front desk can help.`);
    else if (!canBook) reasons.push(`Your login is not set up to book for ${a.first}. The front desk can help.`);
    else if (firstStart) {
      const el = await checkEligibility(tx, { orgId: v.orgId, athleteId: a.id, serviceType: eventEligibilitySpec(row), at: firstStart, tz: event.tz });
      reasons.push(...el.reasons.map(familyName));
    }
    out.push({ athleteId: a.id, name, first: a.first, state: reasons.length ? "blocked" : "open", reasons, invoiceId: null, holdExpiresAt: null });
  }
  return { event, athletes: out, canRegisterAny: out.some((a) => a.state === "open") };
}

// --- Staff ---------------------------------------------------------------------------------------

export type StaffEventRow = {
  event: EventRow;
  sessions: EventSessionView[];
  dates: string;
  counts: EventCounts;
  spotsLeft: number;
  refundedMinor: number;
  /** Paid registrations minus settled refunds on their invoices. */
  netRevenueMinor: number;
  /** Published or closed, with a session that has not ended. */
  upcoming: boolean;
};

async function refundedByEvent(tx: Tx, orgId: string, eventIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!eventIds.length) return out;
  const res = await tx.execute(sql`
    select r.event_id, coalesce(sum(-t.amount_minor), 0)::bigint as refunded
    from (select distinct event_id, invoice_id from event_registrations where org_id = ${orgId} and invoice_id is not null and event_id in (${sql.join(eventIds.map((i) => sql`${i}`), sql`, `)})) r
    join transactions t on t.invoice_id = r.invoice_id and t.kind = 'refund' and t.status = 'settled'
    group by r.event_id`);
  for (const r of res.rows as { event_id: string; refunded: unknown }[]) out.set(r.event_id, int(r.refunded));
  return out;
}

export async function listStaffEvents(tx: Tx, v: Viewer, now = new Date()): Promise<{ rows: StaffEventRow[]; tz: string }> {
  assertCan(v, "schedule.manage");
  const all = await tx.select().from(events).where(eq(events.orgId, v.orgId)).orderBy(desc(events.createdAt));
  const ids = all.map((e) => e.id);
  const tz = await orgTimezone(tx, v.orgId);
  const [sess, counts, refunds] = await Promise.all([sessionsByEvent(tx, ids), countsByEvent(tx, v.orgId, ids), refundedByEvent(tx, v.orgId, ids)]);
  const rows = all.map((event) => {
    const sessions = sess.get(event.id) ?? [];
    const c = counts.get(event.id) ?? NO_COUNTS;
    const refundedMinor = refunds.get(event.id) ?? 0;
    return { event, sessions, dates: dateRangeLabel(sessions.filter((s) => s.status === "scheduled"), tz), counts: c, spotsLeft: Math.max(0, event.capacity - c.confirmed - c.held - c.offered), refundedMinor, netRevenueMinor: c.paidMinor - refundedMinor, upcoming: event.status !== "draft" && sessions.some((s) => s.status === "scheduled" && s.endsAt > now) };
  });
  rows.sort((a, b) => (b.sessions[0]?.startsAt.getTime() ?? 0) - (a.sessions[0]?.startsAt.getTime() ?? 0));
  return { rows, tz };
}

export type StaffRegistration = {
  id: string;
  athleteId: string;
  personId: string;
  athleteName: string;
  dateOfBirth: string | null;
  status: EventRegistrationStatus;
  amountMinor: number;
  basePriceMinor: number;
  earlyBird: boolean;
  siblingDiscountMinor: number;
  holdExpiresAt: Date | null;
  createdAt: Date;
  cancelReason: string | null;
  payerName: string;
  billingEmail: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  registeredBy: string | null;
};

export async function staffEventDetail(tx: Tx, v: Viewer, eventId: string) {
  assertCan(v, "schedule.manage");
  const [event] = await tx.select().from(events).where(and(eq(events.id, eventId), eq(events.orgId, v.orgId)));
  if (!event) return null;
  const tz = await orgTimezone(tx, v.orgId);
  const [sess, counts, refunds] = await Promise.all([sessionsByEvent(tx, [event.id]), countsByEvent(tx, v.orgId, [event.id]), refundedByEvent(tx, v.orgId, [event.id])]);
  const sessions = sess.get(event.id) ?? [];
  const c = counts.get(event.id) ?? NO_COUNTS;
  const registrations: StaffRegistration[] = (
    await tx
      .select({
        reg: eventRegistrations,
        personId: people.id,
        first: people.firstName,
        last: people.lastName,
        dob: people.dateOfBirth,
        payerName: payerAccounts.name,
        billingEmail: payerAccounts.billingEmail,
        invoiceNumber: invoices.number,
        invoiceStatus: invoices.status,
        registeredBy: users.displayName,
      })
      .from(eventRegistrations)
      .innerJoin(athletes, eq(athletes.id, eventRegistrations.athleteId))
      .innerJoin(people, eq(people.id, athletes.personId))
      .innerJoin(payerAccounts, eq(payerAccounts.id, eventRegistrations.payerAccountId))
      .leftJoin(invoices, eq(invoices.id, eventRegistrations.invoiceId))
      .leftJoin(users, eq(users.id, eventRegistrations.registeredByUserId))
      .where(and(eq(eventRegistrations.eventId, event.id), eq(eventRegistrations.orgId, v.orgId)))
      .orderBy(asc(people.lastName), asc(people.firstName), asc(eventRegistrations.createdAt))
  ).map((r) => ({
    id: r.reg.id,
    athleteId: r.reg.athleteId,
    personId: r.personId,
    athleteName: `${r.first} ${r.last}`,
    dateOfBirth: r.dob,
    status: r.reg.status,
    amountMinor: r.reg.amountMinor,
    basePriceMinor: r.reg.basePriceMinor,
    earlyBird: r.reg.earlyBird,
    siblingDiscountMinor: r.reg.siblingDiscountMinor,
    holdExpiresAt: r.reg.holdExpiresAt,
    createdAt: r.reg.createdAt,
    cancelReason: r.reg.cancelReason,
    payerName: r.payerName,
    billingEmail: r.billingEmail,
    invoiceId: r.reg.invoiceId,
    invoiceNumber: r.invoiceNumber,
    invoiceStatus: r.invoiceStatus,
    registeredBy: r.registeredBy,
  }));
  const forms = event.requiredFormTemplateIds.length ? await tx.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(inArray(formTemplates.id, event.requiredFormTemplateIds)) : [];
  const refundedMinor = refunds.get(event.id) ?? 0;
  return {
    event,
    tz,
    sessions,
    dates: dateRangeLabel(sessions.filter((s) => s.status === "scheduled"), tz),
    counts: c,
    spotsLeft: Math.max(0, event.capacity - c.confirmed - c.held - c.offered),
    refundedMinor,
    netRevenueMinor: c.paidMinor - refundedMinor,
    registrations,
    forms,
    canSeeMoney: can(v, "billing.view_all"),
  };
}

const PAYMENT_LABEL = (r: StaffRegistration) => (r.invoiceStatus === "paid" ? "Paid" : r.status === "held" ? "Unpaid" : r.invoiceStatus === "void" ? "Invoice voided" : r.invoiceStatus ? `Invoice ${r.invoiceStatus}` : "");

export function paymentLabel(r: StaffRegistration) {
  return PAYMENT_LABEL(r);
}

/** Roster CSV for coaches and the front desk: who is coming, and whether they have paid. */
export async function eventRosterCsv(tx: Tx, v: Viewer, eventId: string): Promise<{ csv: string; filename: string } | null> {
  const d = await staffEventDetail(tx, v, eventId);
  if (!d) return null;
  const firstDay = d.sessions[0] ? localYmd(d.sessions[0].startsAt, d.tz) : null;
  const rows = d.registrations
    .filter((r) => r.status === "confirmed" || r.status === "held")
    .map((r) => ({
      Athlete: r.athleteName,
      "Age at start": r.dateOfBirth && firstDay ? ageOn(r.dateOfBirth, firstDay) : "",
      Registration: r.status === "confirmed" ? "Confirmed" : "Spot held",
      Payment: paymentLabel(r),
      Amount: (r.amountMinor / 100).toFixed(2),
      Invoice: r.invoiceNumber ?? "",
      "Billing account": r.payerName,
      "Billing email": r.billingEmail ?? "",
      "Registered on": fmt(r.createdAt, "yyyy-MM-dd", d.tz),
    }));
  const columns = ["Athlete", "Age at start", "Registration", "Payment", "Amount", "Invoice", "Billing account", "Billing email", "Registered on"] as const;
  const csv = Papa.unparse({ fields: [...columns], data: rows.map((r) => columns.map((c) => r[c])) }, { escapeFormulae: CSV_FORMULA_ESCAPE });
  const slug = d.event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
  return { csv, filename: `roster-${slug}.csv` };
}
