import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, updatedAt } from "./_common";
import { athletes, tasks, users } from "./core";
import { bookings, scheduleSessions } from "./scheduling";

/** One risk signal as it stood when staff logged an outcome (plain-language evidence, never health values). */
export type RetentionSignalSnapshot = { key: string; label: string; evidence: string; weight: "high" | "medium" };

export const RETENTION_OUTCOMES = ["saved", "still_at_risk", "lost"] as const;
export type RetentionOutcome = (typeof RETENTION_OUTCOMES)[number];

/**
 * Save log: what staff did about an at-risk member and how it turned out. Append-only in practice
 * (a new row per outcome); every insert is audited. `signals` is a snapshot so the log stays
 * readable after the underlying facts change. `value_at_risk_minor` is an ESTIMATE (monthly plan
 * price after discounts at the time), null when staff logging it may not see billing.
 */
export const retentionActions = pgTable(
  "retention_actions",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    /** Risk level when logged: low | watch | at_risk. */
    level: text("level").notNull(),
    signals: jsonb("signals").$type<RetentionSignalSnapshot[]>().notNull().default([]),
    valueAtRiskMinor: bigint("value_at_risk_minor", { mode: "number" }),
    currency: text("currency").notNull().default("USD"),
    /** What staff did (see RETENTION_ACTION_KINDS in src/lib/retention/common.ts). */
    action: text("action").notNull(),
    outcome: text("outcome").$type<RetentionOutcome>().notNull(),
    /** Required when outcome = lost (see LOSS_REASONS). */
    reasonCode: text("reason_code"),
    notes: text("notes"),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("retention_actions_org_time_idx").on(t.orgId, t.createdAt), index("retention_actions_athlete_idx").on(t.athleteId)],
);

/**
 * Athlete / guardian feedback on one attended booking: a 1–5 rating, optional comment, and an
 * optional "tell my coach" flag. One response per booking (unique). Coaches only ever see
 * averages unless `tell_coach` is set. Never used for messaging.
 */
export const sessionFeedback = pgTable(
  "session_feedback",
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
    rating: integer("rating").notNull(),
    comment: text("comment"),
    tellCoach: boolean("tell_coach").notNull().default(false),
    submittedByUserId: uuid("submitted_by_user_id")
      .notNull()
      .references(() => users.id),
    submittedByRole: text("submitted_by_role").$type<"athlete" | "guardian">().notNull(),
    /** Staff task created because the rating was at or below the follow-up threshold. */
    followUpTaskId: uuid("follow_up_task_id").references(() => tasks.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("session_feedback_booking_uq").on(t.bookingId),
    index("session_feedback_session_idx").on(t.sessionId),
    index("session_feedback_org_time_idx").on(t.orgId, t.createdAt),
    index("session_feedback_athlete_idx").on(t.athleteId),
  ],
);
