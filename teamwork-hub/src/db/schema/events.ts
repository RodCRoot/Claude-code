import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, payerAccounts, users } from "./core";
import { invoices } from "./billing";
import { scheduleSessions } from "./scheduling";

export type EventKind = "camp" | "clinic" | "event";
export type EventStatus = "draft" | "published" | "closed";

/**
 * A camp, clinic or similar thing a family registers for as a whole: one price, one capacity,
 * one or more scheduled sessions (event_sessions). All prices are entered by staff.
 */
export const events = pgTable(
  "events",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<EventKind>().notNull().default("camp"),
    status: text("status").$type<EventStatus>().notNull().default("draft"),
    /** Seats for the whole event. Decided under a row lock on this row. */
    capacity: integer("capacity").notNull(),
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    /** Optional lower price through the end of `early_bird_until` (facility local date, inclusive). */
    earlyBirdPriceMinor: integer("early_bird_price_minor"),
    earlyBirdUntil: date("early_bird_until"),
    /** Percent off for the second and later athlete on the same billing account. */
    siblingDiscountPercent: integer("sibling_discount_percent"),
    /** Facility local dates, inclusive. Null = no limit on that side. */
    registrationOpensOn: date("registration_opens_on"),
    registrationClosesOn: date("registration_closes_on"),
    minAge: integer("min_age"),
    maxAge: integer("max_age"),
    requiredFormTemplateIds: jsonb("required_form_template_ids").$type<string[]>().notNull().default([]),
    /** How long an unpaid registration holds its spot. */
    holdHours: integer("hold_hours").notNull().default(48),
    isDemo: isDemo(),
    createdBy: uuid("created_by").references(() => users.id),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_org_status_idx").on(t.orgId, t.status),
    check("events_capacity_ck", sql`${t.capacity} > 0`),
    check("events_price_ck", sql`${t.priceMinor} >= 0 and (${t.earlyBirdPriceMinor} is null or ${t.earlyBirdPriceMinor} >= 0)`),
    check("events_sibling_ck", sql`${t.siblingDiscountPercent} is null or (${t.siblingDiscountPercent} between 1 and 100)`),
    check("events_hold_ck", sql`${t.holdHours} between 1 and 720`),
  ],
);

/** The scheduled sessions that make up an event (a multi-day camp is several). A session belongs to at most one event. */
export const eventSessions = pgTable(
  "event_sessions",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => scheduleSessions.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    orgId: orgId(),
  },
  (t) => [index("event_sessions_event_idx").on(t.eventId)],
);

/**
 * held      = spot reserved, invoice not yet paid (until hold_expires_at)
 * confirmed = invoice settled; athlete is booked into every session
 * expired   = hold ran out unpaid; spot released
 * cancelled = staff cancelled; spot released
 */
export type EventRegistrationStatus = "held" | "confirmed" | "expired" | "cancelled";

export const eventRegistrations = pgTable(
  "event_registrations",
  {
    id: id(),
    orgId: orgId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    status: text("status").$type<EventRegistrationStatus>().notNull().default("held"),
    /** Price before the sibling discount (list or early bird), what was discounted, and what was billed. */
    basePriceMinor: integer("base_price_minor").notNull(),
    earlyBird: boolean("early_bird").notNull().default(false),
    siblingDiscountMinor: integer("sibling_discount_minor").notNull().default(0),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    holdExpiresAt: ts("hold_expires_at"),
    registeredByUserId: uuid("registered_by_user_id").references(() => users.id),
    /** One per submitted form; a retry of the same form returns the same registrations. */
    submitKey: text("submit_key").notNull(),
    confirmedAt: ts("confirmed_at"),
    releasedAt: ts("released_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live registration per athlete per event.
    uniqueIndex("event_reg_live_uq").on(t.eventId, t.athleteId).where(sql`${t.status} in ('held','confirmed')`),
    index("event_reg_event_idx").on(t.eventId, t.status),
    index("event_reg_invoice_idx").on(t.invoiceId),
    index("event_reg_submit_idx").on(t.orgId, t.submitKey),
    check("event_reg_amount_ck", sql`${t.amountMinor} >= 0 and ${t.basePriceMinor} >= 0 and ${t.siblingDiscountMinor} >= 0`),
  ],
);
