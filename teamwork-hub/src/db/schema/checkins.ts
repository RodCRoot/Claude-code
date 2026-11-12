import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, tasks, users } from "./core";
import { bookings, scheduleSessions } from "./scheduling";

/**
 * Session check-ins (docs/modules/checkins.md): a short "Ready check" before an in-gym session
 * and an "After check" once it is over, one row per booking and phase.
 *
 * Where each answer lives, so nothing is stored twice:
 * - the 1 to 5 session rating and "tell my coach" stay in `session_feedback` (retention module);
 * - the session RPE also writes ONE `activity_sessions` row (source `session_checkin`) so it feeds
 *   the existing srpe_load_v1 numbers;
 * - a marked body spot is a `body_region_reports` row pointing back here (`source_checkin_id`).
 *
 * Health columns (readiness, sleep, soreness, tiredness, mood, stress, hurt, the ready-check note)
 * are only ever returned to viewers with `health.read` on the athlete. Unanswered = NULL, never 0.
 */
export type CheckinPhase = "pre" | "post";
/** Parts of a check-in that may be answered by different people (athlete at the gym, parent at home). */
export type CheckinSection = "ready" | "effort" | "body" | "experience";
export type CheckinAnsweredBy = Partial<Record<CheckinSection, { userId: string | null; role: "athlete" | "guardian" | "kiosk"; at: string }>>;
/** A quick-pick chip as it read when it was tapped, so later edits to the list never rewrite history. */
export type CheckinChip = { key: string; label: string };
export type CheckinAlertReason = "sharp_pain" | "hurt_no_location" | "pain_two_sessions" | "soreness_above_baseline" | "readiness_below_baseline" | "disliked_comment";

export const sessionCheckins = pgTable(
  "session_checkins",
  {
    id: id(),
    orgId: orgId(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => scheduleSessions.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    phase: text("phase").$type<CheckinPhase>().notNull(),
    /** Wording version + the organization's chip / optional-question revision, e.g. "1.3". */
    questionSetVersion: text("question_set_version").notNull(),

    // ---- Ready check (health) ----
    /** 1 (not ready) to 5 (ready to go). */
    readiness: integer("readiness"),
    /** 1 to 5, same item as the daily wellness `sleep_quality`. */
    sleepQuality: integer("sleep_quality"),
    sleepHours: doublePrecision("sleep_hours"),
    /** 1 (fresh) to 5 (exhausted), same item as the daily wellness `fatigue`. */
    fatigue: integer("fatigue"),
    /** 1 (low) to 5 (great), same item as the daily wellness `mood`. */
    mood: integer("mood"),
    /** 1 (relaxed) to 5 (very stressed), same item as the daily wellness `stress`. */
    stress: integer("stress"),
    /** "How sore were you the day after your last session?" 0 to 10, asked in the next ready check. */
    priorSoreness: integer("prior_soreness"),
    /** The earlier attended booking that `prior_soreness` is about. */
    priorBookingId: uuid("prior_booking_id").references(() => bookings.id),
    /** Wellness keys that were copied from today's daily wellness response instead of asked again. */
    prefilled: jsonb("prefilled").$type<string[]>().notNull().default([]),

    // ---- Both phases (health) ----
    /** Soreness right now, 0 (none) to 10 (very sore). */
    soreness: integer("soreness"),
    /** "Does anything hurt?" true / false; NULL = not answered. */
    hurt: boolean("hurt"),
    /** After check only: did it start during this session? */
    hurtStartedInSession: boolean("hurt_started_in_session"),
    /** Ready check: "anything your coach should know today?". After check: "any other notes". */
    note: text("note"),

    // ---- After check (training + experience) ----
    /** Session RPE, 0 (rest) to 10 (max effort). */
    rpe: integer("rpe"),
    /** Session length used for srpe_load_v1 (scheduled minutes at the time of the answer). */
    durationMinutes: integer("duration_minutes"),
    likedChips: jsonb("liked_chips").$type<CheckinChip[]>().notNull().default([]),
    likedText: text("liked_text"),
    dislikedChips: jsonb("disliked_chips").$type<CheckinChip[]>().notNull().default([]),
    dislikedText: text("disliked_text"),
    /** The one-tap "Nothing, it was good" answer to "anything you did not like?". */
    nothingToChange: boolean("nothing_to_change"),
    /** Family chose to show their name with likes, dislikes and rating to the coach (same rule as session_feedback.tell_coach). */
    tellCoach: boolean("tell_coach").notNull().default(false),

    // ---- Bookkeeping ----
    answeredBy: jsonb("answered_by").$type<CheckinAnsweredBy>().notNull().default({}),
    /** Any section was entered by a parent / guardian on the athlete's behalf. */
    loggedByParent: boolean("logged_by_parent").notNull().default(false),
    source: text("source").$type<"app" | "kiosk">().notNull().default("app"),
    /** The activity_sessions row carrying this session's sRPE load (null when the workout logger's own load wins or no RPE yet). */
    activitySessionId: uuid("activity_session_id"),
    alertReasons: jsonb("alert_reasons").$type<CheckinAlertReason[]>().notNull().default([]),
    /** Coach task for training reasons (dedupe key `checkin_review:<id>`). */
    reviewTaskId: uuid("review_task_id").references(() => tasks.id),
    /** Owner / front desk task for a "did not like" comment (dedupe key `checkin_dislike:<id>`). */
    experienceTaskId: uuid("experience_task_id").references(() => tasks.id),
    reviewedAt: ts("reviewed_at"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("session_checkins_booking_phase_uq").on(t.bookingId, t.phase),
    index("session_checkins_session_idx").on(t.sessionId, t.phase),
    index("session_checkins_athlete_idx").on(t.athleteId, t.createdAt),
    index("session_checkins_org_time_idx").on(t.orgId, t.createdAt),
    check("session_checkins_phase_ck", sql`${t.phase} in ('pre','post')`),
    check("session_checkins_ranges_ck", sql`
      (${t.readiness} is null or ${t.readiness} between 1 and 5)
      and (${t.sleepQuality} is null or ${t.sleepQuality} between 1 and 5)
      and (${t.fatigue} is null or ${t.fatigue} between 1 and 5)
      and (${t.mood} is null or ${t.mood} between 1 and 5)
      and (${t.stress} is null or ${t.stress} between 1 and 5)
      and (${t.soreness} is null or ${t.soreness} between 0 and 10)
      and (${t.priorSoreness} is null or ${t.priorSoreness} between 0 and 10)
      and (${t.rpe} is null or ${t.rpe} between 0 and 10)`),
  ],
);

/**
 * A short-lived, single-use pass issued by the kiosk right after a PIN matched, so that athlete
 * can answer the ready check for the booking they just checked in for. Only the SHA-256 of the
 * token is stored. The kiosk login itself holds no capability on any athlete.
 */
export const checkinKioskPasses = pgTable(
  "checkin_kiosk_passes",
  {
    id: id(),
    orgId: orgId(),
    tokenHash: text("token_hash").notNull(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("checkin_kiosk_passes_token_uq").on(t.tokenHash), index("checkin_kiosk_passes_expiry_idx").on(t.expiresAt)],
);
