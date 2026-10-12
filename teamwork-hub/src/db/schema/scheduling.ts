import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, locations, users } from "./core";

export const resources = pgTable("resources", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<"room" | "area" | "equipment">().notNull().default("area"),
  capacity: integer("capacity"),
  /** Exclusive resources cannot be double-booked (enforced by an exclusion constraint). */
  exclusive: boolean("exclusive").notNull().default(false),
  locationId: uuid("location_id").references(() => locations.id),
  active: boolean("active").notNull().default(true),
});

/**
 * Configurable cancellation / no-show policy.
 * Penalties: "none" restores the credit, "forfeit_credit" consumes it, "fee" bills fee_minor.
 */
export const cancellationPolicies = pgTable("cancellation_policies", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  lateCancelWindowMinutes: integer("late_cancel_window_minutes").notNull().default(720),
  lateCancelPenalty: text("late_cancel_penalty").$type<"none" | "forfeit_credit" | "fee">().notNull().default("none"),
  noShowPenalty: text("no_show_penalty").$type<"none" | "forfeit_credit" | "fee">().notNull().default("none"),
  feeMinor: integer("fee_minor").notNull().default(0),
  description: text("description"),
});

export type ServiceKind = "class" | "private" | "semi_private" | "assessment" | "camp" | "event";

export const serviceTypes = pgTable("service_types", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<ServiceKind>().notNull(),
  description: text("description"),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(60),
  defaultCapacity: integer("default_capacity").notNull().default(12),
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  creditCost: integer("credit_cost").notNull().default(1),
  /** Booking requires these form template ids completed and/or an entitlement. */
  eligibility: jsonb("eligibility")
    .$type<{ requiredFormTemplateIds?: string[]; requiresEntitlement?: boolean; minAge?: number; maxAge?: number }>()
    .notNull()
    .default({}),
  cancellationPolicyId: uuid("cancellation_policy_id").references(() => cancellationPolicies.id),
  publicBookable: boolean("public_bookable").notNull().default(false),
  color: text("color").notNull().default("#2563eb"),
  /** Is the coach exclusively occupied (private/assessment) or can they overlap? */
  exclusiveCoach: boolean("exclusive_coach").notNull().default(false),
  /** Default location for new sessions of this service (series/resource/explicit choice win). */
  locationId: uuid("location_id").references(() => locations.id),
  active: boolean("active").notNull().default(true),
});

/** Recurring class definition; concrete sessions are generated from it in local time. */
export const classSeries = pgTable("class_series", {
  id: id(),
  orgId: orgId(),
  serviceTypeId: uuid("service_type_id")
    .notNull()
    .references(() => serviceTypes.id),
  title: text("title").notNull(),
  /** ISO weekdays 1=Mon … 7=Sun */
  weekdays: jsonb("weekdays").$type<number[]>().notNull(),
  startTimeLocal: time("start_time_local").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  timezone: text("timezone").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  coachUserId: uuid("coach_user_id").references(() => users.id),
  resourceId: uuid("resource_id").references(() => resources.id),
  locationId: uuid("location_id").references(() => locations.id),
  capacity: integer("capacity").notNull(),
  waitlistCapacity: integer("waitlist_capacity").notNull().default(5),
  active: boolean("active").notNull().default(true),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

export type SessionStatus = "scheduled" | "cancelled" | "completed";

export const scheduleSessions = pgTable(
  "schedule_sessions",
  {
    id: id(),
    orgId: orgId(),
    serviceTypeId: uuid("service_type_id")
      .notNull()
      .references(() => serviceTypes.id),
    seriesId: uuid("series_id").references(() => classSeries.id),
    title: text("title").notNull(),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    timezone: text("timezone").notNull(),
    coachUserId: uuid("coach_user_id").references(() => users.id),
    /** Substitution keeps the originally scheduled coach for history. */
    originalCoachUserId: uuid("original_coach_user_id").references(() => users.id),
    resourceId: uuid("resource_id").references(() => resources.id),
    /** Where the session happens. Null = org-wide / unassigned (any membership location covers it). */
    locationId: uuid("location_id").references(() => locations.id),
    capacity: integer("capacity").notNull(),
    waitlistCapacity: integer("waitlist_capacity").notNull().default(0),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    /** Copied from service type; drives the coach-interval exclusion constraint. */
    exclusiveCoach: boolean("exclusive_coach").notNull().default(false),
    exclusiveResource: boolean("exclusive_resource").notNull().default(false),
    status: text("status").$type<SessionStatus>().notNull().default("scheduled"),
    cancelReason: text("cancel_reason"),
    visibility: text("visibility").$type<"public" | "members" | "private">().notNull().default("members"),
    notes: text("notes"),
    /** Monotonic counter for optimistic concurrency on edits. */
    version: integer("version").notNull().default(1),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_org_time_idx").on(t.orgId, t.startsAt),
    index("sessions_org_location_time_idx").on(t.orgId, t.locationId, t.startsAt),
    uniqueIndex("sessions_series_start_uq").on(t.seriesId, t.startsAt),
  ],
);

export type BookingStatus =
  | "booked"
  | "waitlisted"
  | "cancelled"
  | "late_cancelled"
  | "attended"
  | "no_show";

export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["booked", "waitlisted", "attended", "no_show"];

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    orgId: orgId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => scheduleSessions.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    bookedByUserId: uuid("booked_by_user_id").references(() => users.id),
    status: text("status").$type<BookingStatus>().notNull(),
    waitlistPosition: integer("waitlist_position"),
    /** Credit bucket the reservation drew from (null = unlimited membership / staff comp). */
    creditBucketId: uuid("credit_bucket_id"),
    entitlementSource: text("entitlement_source").$type<"credit" | "unlimited" | "comp" | "drop_in_invoice">(),
    membershipId: uuid("membership_id"),
    idempotencyKey: text("idempotency_key"),
    checkedInAt: ts("checked_in_at"),
    checkInMethod: text("check_in_method").$type<"staff" | "kiosk" | "self">(),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by"),
    rescheduledFromBookingId: uuid("rescheduled_from_booking_id"),
    source: text("source").notNull().default("teamwork"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live booking per athlete per session.
    uniqueIndex("bookings_live_uq")
      .on(t.sessionId, t.athleteId)
      .where(sql`${t.status} in ('booked','waitlisted','attended','no_show')`),
    uniqueIndex("bookings_idem_uq").on(t.orgId, t.idempotencyKey),
    index("bookings_athlete_idx").on(t.athleteId),
  ],
);

export const coachAvailability = pgTable("coach_availability", {
  id: id(),
  orgId: orgId(),
  coachUserId: uuid("coach_user_id")
    .notNull()
    .references(() => users.id),
  weekday: integer("weekday").notNull(),
  startLocal: time("start_local").notNull(),
  endLocal: time("end_local").notNull(),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
});

/** Time off and external busy blocks (e.g. from Google Calendar free/busy). */
export const busyBlocks = pgTable(
  "busy_blocks",
  {
    id: id(),
    orgId: orgId(),
    coachUserId: uuid("coach_user_id")
      .notNull()
      .references(() => users.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    source: text("source").$type<"time_off" | "google_freebusy" | "manual">().notNull(),
    reason: text("reason"),
    fetchedAt: ts("fetched_at"),
  },
  (t) => [index("busy_blocks_coach_idx").on(t.coachUserId, t.startsAt)],
);

export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull().default("google"),
    /** The Teamwork-owned (app-created) calendar that receives session copies. */
    externalCalendarId: text("external_calendar_id"),
    /** Calendar queried for free/busy (the coach's own calendar, normally "primary"). Null = externalCalendarId. */
    freebusyCalendarId: text("freebusy_calendar_id"),
    status: text("status").$type<"not_configured" | "connected" | "error" | "disabled">().notNull(),
    syncDirection: text("sync_direction").$type<"push_events" | "freebusy_only" | "both">().notNull().default("both"),
    lastSyncAt: ts("last_sync_at"),
    lastError: text("last_error"),
    connectedAt: ts("connected_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cal_conn_user_provider_uq").on(t.orgId, t.userId, t.provider)],
);

/**
 * OAuth tokens for a calendar connection, AES-256-GCM encrypted (src/lib/calendar/crypto.ts).
 * Kept out of calendar_connections so status queries can never select a token by accident.
 */
export const calendarOauthTokens = pgTable("calendar_oauth_tokens", {
  connectionId: uuid("connection_id")
    .primaryKey()
    .references(() => calendarConnections.id, { onDelete: "cascade" }),
  orgId: orgId(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessTokenEnc: text("access_token_enc"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  /** Space-delimited scopes Google actually granted (granular consent may grant fewer). */
  scopes: text("scopes").notNull(),
  refreshedAt: ts("refreshed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Teamwork is the source of truth for sessions; Google receives copies. */
export const calendarEventLinks = pgTable(
  "calendar_event_links",
  {
    id: id(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => scheduleSessions.id),
    externalEventId: text("external_event_id"),
    etag: text("etag"),
    pushedVersion: integer("pushed_version"),
    status: text("status").$type<"pending" | "synced" | "conflict" | "error" | "deleted">().notNull(),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cal_link_uq").on(t.connectionId, t.sessionId)],
);

/**
 * Optional per-athlete kiosk check-in PIN (4–6 digits). Only a keyed hash is stored:
 * HMAC-SHA256(key derived from SESSION_SECRET, "<orgId>:<pin>") so the kiosk can look a PIN up
 * without listing names. Unique per org so a PIN identifies exactly one athlete.
 * Kept out of `athletes` so ordinary athlete queries can never select it.
 */
export const athleteCheckinPins = pgTable(
  "athlete_checkin_pins",
  {
    athleteId: uuid("athlete_id")
      .primaryKey()
      .references(() => athletes.id, { onDelete: "cascade" }),
    orgId: orgId(),
    pinHash: text("pin_hash").notNull(),
    setByUserId: uuid("set_by_user_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("checkin_pin_org_hash_uq").on(t.orgId, t.pinHash)],
);

/** Failed kiosk PIN attempts per kiosk login session (keyed by the session token hash), for rate limiting. */
export const kioskPinAttempts = pgTable(
  "kiosk_pin_attempts",
  {
    orgId: orgId(),
    sessionKey: text("session_key").notNull(),
    failedCount: integer("failed_count").notNull().default(0),
    windowStartedAt: ts("window_started_at").notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sessionKey] })],
);
