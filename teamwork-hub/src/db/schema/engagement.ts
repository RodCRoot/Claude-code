import { date, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, users } from "./core";
import { metricDefinitions } from "./science";
import { exercises } from "./training";

/**
 * Engagement module: XP ledger, badges and athlete goals (docs/modules/engagement.md).
 * XP and badges are DERIVED from rows other modules already write (attendance, workouts,
 * check-ins, maxes, forms, goals); nothing here stores a health value.
 */

export type XpKind = "session_attended" | "workout_completed" | "wellness_checkin" | "pr_set" | "goal_achieved" | "form_signed" | "on_your_own_completed" | "coach_shoutout" | "win_approved";
export const XP_KINDS: XpKind[] = ["session_attended", "workout_completed", "wellness_checkin", "pr_set", "goal_achieved", "form_signed", "on_your_own_completed", "coach_shoutout", "win_approved"];

/** Append-only XP ledger (DB trigger blocks UPDATE/DELETE). One row per awarded event. */
export const xpEvents = pgTable(
  "xp_events",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<XpKind>().notNull(),
    /** Points at the time of the award (later setting changes never rewrite history). */
    points: integer("points").notNull(),
    /** The row that earned it, e.g. "booking" / "workout" / "max" / "form_request" / "athlete_goal" / "checkin_day". */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** Unique per org so re-processing the same source never double-awards. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** When the underlying activity happened (not when the ledger row was written). */
    occurredAt: ts("occurred_at").notNull(),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("xp_events_idem_uq").on(t.orgId, t.idempotencyKey), index("xp_events_athlete_idx").on(t.athleteId, t.occurredAt)],
);

/** Badges an athlete has earned. Keys are versioned in code (src/lib/engagement/badges.ts). Never revoked. */
export const athleteBadges = pgTable(
  "athlete_badges",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    badgeKey: text("badge_key").notNull(),
    earnedAt: ts("earned_at").notNull(),
    /** What qualified the athlete, e.g. { rule: "sessions", count: 10 }. Never contains health values. */
    source: jsonb("source").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("athlete_badges_uq").on(t.athleteId, t.badgeKey), index("athlete_badges_org_idx").on(t.orgId, t.athleteId)],
);

export type GoalStatus = "active" | "achieved" | "archived";
export type GoalDirection = "increase" | "decrease";
/** How the starting value was measured, so progress never compares across protocols (science/comparability.ts). */
export type GoalBaselineContext = {
  testTypeId: string | null;
  protocol: string | null;
  source: string;
  formulaVersion?: string | null;
  unit: string;
  aggregation: string;
  relativeToBodyMass?: boolean;
  bodyMassKnown?: boolean | null;
};

/**
 * A goal for one athlete. Optional link to ONE of: a test metric, or an exercise max.
 * Visible to the athlete and their coaches; guardians see it when they have profile access
 * (measured values only with training access). Free-text goals are checked off by hand.
 */
export const athleteGoals = pgTable(
  "athlete_goals",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    title: text("title").notNull(),
    metricDefinitionId: uuid("metric_definition_id").references(() => metricDefinitions.id),
    exerciseId: uuid("exercise_id").references(() => exercises.id),
    targetValue: doublePrecision("target_value"),
    targetUnit: text("target_unit"),
    direction: text("direction").$type<GoalDirection>(),
    /** Latest comparable value when the goal was set (null = nothing measured yet). In target_unit. */
    baselineValue: doublePrecision("baseline_value"),
    baselineContext: jsonb("baseline_context").$type<GoalBaselineContext>(),
    /** Exercise-max goals: "measured" (tested/manual/imported) or "estimated" maxes; the two are never mixed. */
    maxBasis: text("max_basis").$type<"measured" | "estimated">(),
    targetDate: date("target_date"),
    status: text("status").$type<GoalStatus>().notNull().default("active"),
    achievedAt: ts("achieved_at"),
    /** Value that met the target (metric/max goals), in target_unit. */
    achievedValue: doublePrecision("achieved_value"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("athlete_goals_athlete_idx").on(t.orgId, t.athleteId, t.status)],
);
