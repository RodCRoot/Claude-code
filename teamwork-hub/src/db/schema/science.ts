import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts } from "./_common";
import { athletes, groups, users } from "./core";
import { storedObjects } from "./documents";
import { workouts } from "./training";

// ---------------------------------------------------------------------------
// Wellness questionnaires
// ---------------------------------------------------------------------------

export type QuestionDef = {
  key: string;
  label: string;
  kind: "scale" | "number" | "text" | "boolean";
  min?: number;
  max?: number;
  /** "higher_better" (e.g. sleep quality) or "lower_better" (e.g. soreness). */
  polarity?: "higher_better" | "lower_better" | "neutral";
  unit?: string;
  anchors?: Record<string, string>;
  required?: boolean;
};

export const questionnaires = pgTable("questionnaires", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  /** { frequency: "daily" | "weekdays" | "pre_session", groupIds?: string[] } */
  schedule: jsonb("schedule").$type<Record<string, unknown>>().notNull().default({}),
  currentVersionId: uuid("current_version_id"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const questionnaireVersions = pgTable(
  "questionnaire_versions",
  {
    id: id(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    version: integer("version").notNull(),
    questions: jsonb("questions").$type<QuestionDef[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("q_versions_uq").on(t.questionnaireId, t.version)],
);

/** One response per athlete per questionnaire per day; a missing row means "no response", never "fine". */
export const questionnaireResponses = pgTable(
  "questionnaire_responses",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => questionnaireVersions.id),
    forDate: date("for_date").notNull(),
    /** Unanswered optional items are stored as null. */
    answers: jsonb("answers").$type<Record<string, number | string | boolean | null>>().notNull(),
    note: text("note"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
    source: text("source").notNull().default("teamwork"),
    sourceRecordId: text("source_record_id"),
    isDemo: isDemo(),
  },
  (t) => [
    uniqueIndex("q_response_day_uq").on(t.athleteId, t.versionId, t.forDate),
    index("q_response_athlete_idx").on(t.athleteId, t.forDate),
  ],
);

// ---------------------------------------------------------------------------
// Body heat map (self-reported; never a diagnosis or clearance)
// ---------------------------------------------------------------------------

export const bodyRegionReports = pgTable(
  "body_region_reports",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    region: text("region").notNull(),
    side: text("side").$type<"left" | "right" | "center" | "bilateral">().notNull(),
    view: text("view").$type<"front" | "back">().notNull(),
    kind: text("kind").$type<"soreness" | "pain">().notNull(),
    /** 0–10 self-reported severity. */
    severity: integer("severity").notNull(),
    note: text("note"),
    reportedAt: ts("reported_at").notNull().defaultNow(),
    reportedBy: uuid("reported_by").references(() => users.id),
    reviewStatus: text("review_status").$type<"new" | "reviewed" | "follow_up" | "referred_out">().notNull().default("new"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    reviewTaskId: uuid("review_task_id"),
    isDemo: isDemo(),
  },
  (t) => [index("body_reports_athlete_idx").on(t.athleteId, t.reportedAt)],
);

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export const habits = pgTable("habits", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  description: text("description"),
  targetValue: doublePrecision("target_value"),
  targetUnit: text("target_unit"),
  frequency: text("frequency").$type<"daily" | "weekdays" | "weekly">().notNull().default("daily"),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export const habitAssignments = pgTable("habit_assignments", {
  id: id(),
  habitId: uuid("habit_id")
    .notNull()
    .references(() => habits.id, { onDelete: "cascade" }),
  athleteId: uuid("athlete_id").references(() => athletes.id),
  groupId: uuid("group_id").references(() => groups.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
});

/** Explicit check-ins only. Absence of a row = missing, distinct from status "missed". */
export const habitCheckins = pgTable(
  "habit_checkins",
  {
    id: id(),
    orgId: orgId(),
    habitId: uuid("habit_id")
      .notNull()
      .references(() => habits.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    forDate: date("for_date").notNull(),
    status: text("status").$type<"done" | "partial" | "missed">().notNull(),
    value: doublePrecision("value"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("habit_checkin_uq").on(t.habitId, t.athleteId, t.forDate)],
);

// ---------------------------------------------------------------------------
// Metrics, tests, trials, KPIs (vendor vs Teamwork-derived kept separate)
// ---------------------------------------------------------------------------

export type MetricSource = "teamwork_manual" | "teamwork_derived" | "hawkin" | "teambuildr" | "wearable" | "other_vendor";

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: id(),
    orgId: orgId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    higherIsBetter: boolean("higher_is_better"),
    category: text("category").$type<"sprint" | "jump" | "strength" | "force_plate" | "wearable" | "attendance" | "anthropometric" | "other">().notNull(),
    /** Which system defines this metric. Vendor metrics are never relabeled as Teamwork results. */
    definedBy: text("defined_by").$type<MetricSource>().notNull(),
    vendorMetricId: text("vendor_metric_id"),
    precision: integer("precision").notNull().default(2),
    description: text("description"),
    formulaKey: text("formula_key"),
  },
  (t) => [uniqueIndex("metric_def_uq").on(t.orgId, t.definedBy, t.key)],
);

export const testTypes = pgTable(
  "test_types",
  {
    id: id(),
    orgId: orgId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    vendor: text("vendor").$type<"teamwork" | "hawkin" | "teambuildr" | "other">().notNull(),
    vendorTestTypeId: text("vendor_test_type_id"),
    protocol: text("protocol"),
    /** Default trial-selection rule for KPI summaries. */
    trialSelection: text("trial_selection").$type<"best" | "mean" | "latest">().notNull().default("best"),
  },
  (t) => [uniqueIndex("test_types_uq").on(t.orgId, t.vendor, t.key)],
);

export const testSessions = pgTable(
  "test_sessions",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    testTypeId: uuid("test_type_id")
      .notNull()
      .references(() => testTypes.id),
    testedAt: ts("tested_at").notNull(),
    /** Original timezone/offset string from the source, preserved verbatim. */
    sourceTimestamp: text("source_timestamp"),
    source: text("source").$type<MetricSource>().notNull(),
    sourceRecordId: text("source_record_id"),
    importBatchId: uuid("import_batch_id"),
    device: text("device"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    isDemo: isDemo(),
  },
  (t) => [uniqueIndex("test_sessions_src_uq").on(t.source, t.sourceRecordId), index("test_sessions_athlete_idx").on(t.athleteId, t.testedAt)],
);

export const trials = pgTable(
  "trials",
  {
    id: id(),
    testSessionId: uuid("test_session_id")
      .notNull()
      .references(() => testSessions.id, { onDelete: "cascade" }),
    trialNumber: integer("trial_number"),
    performedAt: ts("performed_at"),
    /** Vendor-provided averages are stored as aggregate rows, never as an extra trial. */
    isAggregate: boolean("is_aggregate").notNull().default(false),
    aggregateKind: text("aggregate_kind").$type<"vendor_mean" | "vendor_best">(),
    excluded: boolean("excluded").notNull().default(false),
    exclusionReason: text("exclusion_reason"),
    sourceTrialId: text("source_trial_id"),
    rawPayload: jsonb("raw_payload"),
    sourceActive: boolean("source_active").notNull().default(true),
  },
  (t) => [uniqueIndex("trials_src_uq").on(t.testSessionId, t.sourceTrialId)],
);

/** Every measured or derived number. value null = missing / not calculable (never 0). */
export const metricValues = pgTable(
  "metric_values",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    metricDefinitionId: uuid("metric_definition_id")
      .notNull()
      .references(() => metricDefinitions.id),
    testSessionId: uuid("test_session_id").references(() => testSessions.id, { onDelete: "cascade" }),
    trialId: uuid("trial_id").references(() => trials.id, { onDelete: "cascade" }),
    value: doublePrecision("value"),
    /** Source string preserved (e.g. "0.4312") so precision is not lost. */
    rawValue: text("raw_value"),
    unit: text("unit").notNull(),
    recordedAt: ts("recorded_at").notNull(),
    source: text("source").$type<MetricSource>().notNull(),
    aggregation: text("aggregation").$type<"single" | "trial" | "vendor_mean" | "vendor_best" | "derived">().notNull(),
    formulaVersion: text("formula_version"),
    /** Lineage for derived values: ids of inputs used. */
    inputs: jsonb("inputs"),
    importBatchId: uuid("import_batch_id"),
    sourceRecordId: text("source_record_id"),
    enteredBy: uuid("entered_by"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    index("metric_values_athlete_idx").on(t.athleteId, t.metricDefinitionId, t.recordedAt),
    uniqueIndex("metric_values_src_uq").on(t.source, t.sourceRecordId, t.metricDefinitionId),
  ],
);

/** Raw force/velocity time series files with sampling metadata. */
export const rawSignals = pgTable("raw_signals", {
  id: id(),
  orgId: orgId(),
  trialId: uuid("trial_id")
    .notNull()
    .references(() => trials.id, { onDelete: "cascade" }),
  objectId: uuid("object_id")
    .notNull()
    .references(() => storedObjects.id),
  sampleRateHz: doublePrecision("sample_rate_hz"),
  channels: jsonb("channels").$type<{ name: string; unit: string }[]>().notNull(),
  sampleCount: integer("sample_count"),
  createdAt: createdAt(),
});

export const kpiTargets = pgTable("kpi_targets", {
  id: id(),
  orgId: orgId(),
  athleteId: uuid("athlete_id").references(() => athletes.id),
  groupId: uuid("group_id").references(() => groups.id),
  metricDefinitionId: uuid("metric_definition_id")
    .notNull()
    .references(() => metricDefinitions.id),
  baselineValue: doublePrecision("baseline_value"),
  baselineDate: date("baseline_date"),
  targetValue: doublePrecision("target_value").notNull(),
  goalDate: date("goal_date"),
  trialSelection: text("trial_selection").$type<"best" | "mean" | "latest">().notNull().default("best"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export const goals = pgTable("goals", {
  id: id(),
  orgId: orgId(),
  athleteId: uuid("athlete_id")
    .notNull()
    .references(() => athletes.id),
  title: text("title").notNull(),
  metricDefinitionId: uuid("metric_definition_id").references(() => metricDefinitions.id),
  targetValue: doublePrecision("target_value"),
  dueDate: date("due_date"),
  status: text("status").$type<"active" | "achieved" | "abandoned">().notNull().default("active"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Load monitoring & wearables
// ---------------------------------------------------------------------------

/** Practice/game/training exposure. Session load (AU) = duration_min × sRPE (CR-10), formula srpe_load_v1. */
export const activitySessions = pgTable(
  "activity_sessions",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    activityDate: date("activity_date").notNull(),
    kind: text("kind").$type<"training" | "practice" | "game" | "conditioning" | "other">().notNull(),
    durationMinutes: integer("duration_minutes"),
    sessionRpe: integer("session_rpe"),
    workoutId: uuid("workout_id").references(() => workouts.id),
    notes: text("notes"),
    enteredBy: uuid("entered_by"),
    source: text("source").notNull().default("teamwork"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_athlete_idx").on(t.athleteId, t.activityDate), uniqueIndex("activity_workout_uq").on(t.workoutId)],
);

export const wearableObservations = pgTable(
  "wearable_observations",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    provider: text("provider").notNull(),
    metricKey: text("metric_key").notNull(),
    observedOn: date("observed_on"),
    observedAt: ts("observed_at"),
    value: doublePrecision("value"),
    unit: text("unit").notNull(),
    /** "measured" | "missing" | "device_estimate" — missingness is explicit. */
    quality: text("quality").$type<"measured" | "missing" | "device_estimate">().notNull().default("measured"),
    sourceRecordId: text("source_record_id"),
    importBatchId: uuid("import_batch_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("wearable_src_uq").on(t.provider, t.athleteId, t.metricKey, t.sourceRecordId),
    index("wearable_athlete_idx").on(t.athleteId, t.metricKey, t.observedOn),
  ],
);

export const progressReports = pgTable("progress_reports", {
  id: id(),
  orgId: orgId(),
  athleteId: uuid("athlete_id")
    .notNull()
    .references(() => athletes.id),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  /** Frozen snapshot of what the parent will see. Sensitive sections excluded unless approved. */
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  includeWellness: boolean("include_wellness").notNull().default(false),
  coachSummary: text("coach_summary"),
  status: text("status").$type<"draft" | "approved" | "shared">().notNull().default("draft"),
  createdBy: uuid("created_by"),
  approvedBy: uuid("approved_by"),
  approvedAt: ts("approved_at"),
  createdAt: createdAt(),
});
