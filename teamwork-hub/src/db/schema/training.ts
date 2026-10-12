import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, groups, users } from "./core";

export type TrackingType = "weight_reps" | "reps" | "time" | "distance" | "bodyweight_reps" | "time_distance";

export const exercises = pgTable(
  "exercises",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    movementPattern: text("movement_pattern"),
    equipment: jsonb("equipment").$type<string[]>().notNull().default([]),
    trackingType: text("tracking_type").$type<TrackingType>().notNull().default("weight_reps"),
    defaultUnit: text("default_unit").$type<"lb" | "kg" | "s" | "m" | "yd" | "reps">().notNull().default("lb"),
    isUnilateral: boolean("is_unilateral").notNull().default(false),
    /** Fraction of body mass counted as load for bodyweight movements (null = excluded from load volume). */
    bodyweightFactor: doublePrecision("bodyweight_factor"),
    /** Only authorized/owned media links; licensed vendor videos are not copied. */
    videoUrl: text("video_url"),
    coachingNotes: text("coaching_notes"),
    substitutionIds: jsonb("substitution_ids").$type<string[]>().notNull().default([]),
    /** Maxes for this exercise feed % loading for these exercise ids too. */
    maxSourceExerciseId: uuid("max_source_exercise_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("exercises_org_name_uq").on(t.orgId, t.name)],
);

export const programs = pgTable("programs", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  description: text("description"),
  sport: text("sport"),
  /** Bumped on every structural edit; assignments snapshot the version they used. */
  currentVersion: integer("current_version").notNull().default(1),
  status: text("status").$type<"draft" | "active" | "archived">().notNull().default("draft"),
  createdBy: uuid("created_by").references(() => users.id),
  isDemo: isDemo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const programPhases = pgTable("program_phases", {
  id: id(),
  programId: uuid("program_id")
    .notNull()
    .references(() => programs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  goal: text("goal"),
  sortOrder: integer("sort_order").notNull(),
  weeks: integer("weeks").notNull(),
});

export const programDays = pgTable("program_days", {
  id: id(),
  programId: uuid("program_id")
    .notNull()
    .references(() => programs.id, { onDelete: "cascade" }),
  phaseId: uuid("phase_id").references(() => programPhases.id, { onDelete: "set null" }),
  week: integer("week").notNull(),
  dayIndex: integer("day_index").notNull(),
  title: text("title").notNull(),
});

export type LoadPrescription =
  | { type: "absolute"; value: number; unit: "lb" | "kg" }
  | { type: "percent_max"; percent: number; maxExerciseId?: string }
  | { type: "rpe"; rpe: number }
  | { type: "rir"; rir: number }
  | { type: "bodyweight" }
  | { type: "none" };

export type SetPrescription = {
  sets: number;
  reps?: number;
  repsText?: string;
  load?: LoadPrescription;
  durationS?: number;
  distanceM?: number;
  tempo?: string;
  restS?: number;
  isWarmup?: boolean;
};

export type ProgressionRule = { kind: "linear_load"; perWeek: number; unit: "lb" | "kg" | "percent" } | { kind: "none" };

export const programItems = pgTable("program_items", {
  id: id(),
  dayId: uuid("day_id")
    .notNull()
    .references(() => programDays.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull(),
  exerciseId: uuid("exercise_id")
    .notNull()
    .references(() => exercises.id),
  /** "A1", "A2" = superset A; "C1".."C3" = circuit C. */
  blockLabel: text("block_label").notNull(),
  blockType: text("block_type").$type<"straight" | "superset" | "circuit">().notNull().default("straight"),
  prescription: jsonb("prescription").$type<SetPrescription[]>().notNull(),
  progression: jsonb("progression").$type<ProgressionRule>().notNull().default({ kind: "none" }),
  notes: text("notes"),
});

export const programAssignments = pgTable("program_assignments", {
  id: id(),
  orgId: orgId(),
  programId: uuid("program_id")
    .notNull()
    .references(() => programs.id),
  programVersion: integer("program_version").notNull(),
  athleteId: uuid("athlete_id").references(() => athletes.id),
  groupId: uuid("group_id").references(() => groups.id),
  startDate: date("start_date").notNull(),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull(),
  assignedBy: uuid("assigned_by").references(() => users.id),
  status: text("status").$type<"active" | "completed" | "cancelled">().notNull().default("active"),
  createdAt: createdAt(),
});

/** Annual plan: dated season blocks per athlete or group. */
export const trainingPlanBlocks = pgTable("training_plan_blocks", {
  id: id(),
  orgId: orgId(),
  athleteId: uuid("athlete_id").references(() => athletes.id),
  groupId: uuid("group_id").references(() => groups.id),
  name: text("name").notNull(),
  kind: text("kind").$type<"off_season" | "pre_season" | "in_season" | "post_season" | "transition">().notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  focus: text("focus"),
  programId: uuid("program_id").references(() => programs.id),
});

export type WorkoutStatus = "scheduled" | "in_progress" | "completed" | "skipped";

/** Concrete workout for one athlete: a frozen snapshot of the template at assignment time. */
export const workouts = pgTable(
  "workouts",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    assignmentId: uuid("assignment_id").references(() => programAssignments.id),
    programDayId: uuid("program_day_id"),
    scheduledDate: date("scheduled_date").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<WorkoutStatus>().notNull().default("scheduled"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    sessionRpe: integer("session_rpe"),
    durationMinutes: integer("duration_minutes"),
    athleteComment: text("athlete_comment"),
    coachFeedback: text("coach_feedback"),
    coachReviewedAt: ts("coach_reviewed_at"),
    coachReviewedBy: uuid("coach_reviewed_by"),
    source: text("source").notNull().default("teamwork"),
    sourceRecordId: text("source_record_id"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workouts_athlete_date_idx").on(t.athleteId, t.scheduledDate),
    uniqueIndex("workouts_assignment_day_uq").on(t.assignmentId, t.athleteId, t.programDayId),
  ],
);

export const workoutItems = pgTable("workout_items", {
  id: id(),
  workoutId: uuid("workout_id")
    .notNull()
    .references(() => workouts.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull(),
  exerciseId: uuid("exercise_id")
    .notNull()
    .references(() => exercises.id),
  substitutedExerciseId: uuid("substituted_exercise_id").references(() => exercises.id),
  blockLabel: text("block_label").notNull(),
  /** Snapshot with resolved loads: [{ sets, reps, targetLoad, targetUnit, loadMethod, maxUsed }] */
  prescription: jsonb("prescription").$type<Record<string, unknown>[]>().notNull(),
  notes: text("notes"),
  athleteModification: text("athlete_modification"),
});

export const setLogs = pgTable(
  "set_logs",
  {
    id: id(),
    orgId: orgId(),
    workoutItemId: uuid("workout_item_id")
      .notNull()
      .references(() => workoutItems.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    setIndex: integer("set_index").notNull(),
    side: text("side").$type<"both" | "left" | "right">().notNull().default("both"),
    isWarmup: boolean("is_warmup").notNull().default(false),
    reps: integer("reps"),
    /** Stored in the unit entered; never silently converted. */
    load: numeric("load", { precision: 8, scale: 2 }),
    loadUnit: text("load_unit").$type<"lb" | "kg">(),
    durationS: numeric("duration_s", { precision: 8, scale: 2 }),
    distanceM: numeric("distance_m", { precision: 8, scale: 2 }),
    rpe: numeric("rpe", { precision: 3, scale: 1 }),
    completed: boolean("completed").notNull().default(true),
    note: text("note"),
    /** Client-generated id makes offline retries idempotent. */
    clientMutationId: text("client_mutation_id").notNull(),
    loggedBy: uuid("logged_by").references(() => users.id),
    loggedVia: text("logged_via").$type<"athlete_app" | "weight_room" | "coach" | "import">().notNull(),
    loggedAt: ts("logged_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("set_logs_client_uq").on(t.clientMutationId),
    uniqueIndex("set_logs_slot_uq").on(t.workoutItemId, t.setIndex, t.side),
    index("set_logs_athlete_idx").on(t.athleteId),
  ],
);

/** Measured or estimated maxes with named method; history is append-only. */
export const maxes = pgTable(
  "maxes",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    value: numeric("value", { precision: 8, scale: 2 }).notNull(),
    unit: text("unit").$type<"lb" | "kg" | "s" | "m" | "reps">().notNull(),
    kind: text("kind").$type<"tested" | "estimated" | "manual" | "imported">().notNull(),
    /** e.g. "epley_v1", "brzycki_v1", "tested" */
    method: text("method").notNull(),
    sourceSetLogId: uuid("source_set_log_id").references(() => setLogs.id),
    recordedOn: date("recorded_on").notNull(),
    source: text("source").notNull().default("teamwork"),
    sourceRecordId: text("source_record_id"),
    importBatchId: uuid("import_batch_id"),
    enteredBy: uuid("entered_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("maxes_athlete_ex_idx").on(t.athleteId, t.exerciseId, t.recordedOn),
    uniqueIndex("maxes_source_uq").on(t.source, t.sourceRecordId),
  ],
);

/** Velocity-based training readings, imported from files (no device connectivity claimed). */
export const vbtReadings = pgTable("vbt_readings", {
  id: id(),
  orgId: orgId(),
  athleteId: uuid("athlete_id")
    .notNull()
    .references(() => athletes.id),
  exerciseId: uuid("exercise_id").references(() => exercises.id),
  setLogId: uuid("set_log_id").references(() => setLogs.id),
  performedAt: ts("performed_at").notNull(),
  load: numeric("load", { precision: 8, scale: 2 }),
  loadUnit: text("load_unit"),
  repNumber: integer("rep_number"),
  meanVelocityMs: doublePrecision("mean_velocity_ms"),
  peakVelocityMs: doublePrecision("peak_velocity_ms"),
  meanPowerW: doublePrecision("mean_power_w"),
  device: text("device"),
  importBatchId: uuid("import_batch_id"),
  sourceRecordId: text("source_record_id").unique(),
});
