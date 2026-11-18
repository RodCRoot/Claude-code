import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, groups, users } from "./core";
import { activitySessions } from "./science";
import { exercises } from "./training";

/**
 * Anywhere module (docs/modules/anywhere.md): what an athlete does on days they are NOT in the
 * gym. On Your Own sessions (coach-curated, built from the existing exercise library), the
 * athlete's own sport season, and logs of outside practice and games. No health values live
 * here; RPE and duration follow the same access as the existing load data (training.read/log).
 */

export const ANYWHERE_CATEGORIES = ["mobility", "recovery", "core", "speed_agility", "bodyweight_strength", "travel", "pre_game_warmup"] as const;
export type AnywhereCategory = (typeof ANYWHERE_CATEGORIES)[number];
export const ANYWHERE_EQUIPMENT = ["none", "band", "ball", "field"] as const;
export type AnywhereEquipment = (typeof ANYWHERE_EQUIPMENT)[number];
export type AnywhereSessionStatus = "draft" | "published" | "archived";

/** A short coach-curated session an athlete can do anywhere. */
export const anywhereSessions = pgTable(
  "anywhere_sessions",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").$type<AnywhereCategory>().notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    /** Everything the athlete needs. ["none"] means no equipment at all. */
    equipment: jsonb("equipment").$type<AnywhereEquipment[]>().notNull().default(["none"]),
    /** Athletes under 13 (or with no birthday on file) only ever see sessions with this set. */
    suitableUnder13: boolean("suitable_under_13").notNull().default(false),
    status: text("status").$type<AnywhereSessionStatus>().notNull().default("draft"),
    /** Seeded starting points for coaches to edit; labelled "Sample" everywhere. */
    isSample: boolean("is_sample").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("anywhere_sessions_org_idx").on(t.orgId, t.status, t.category)],
);

/** One step = one exercise from the existing library, plus what to do. Cues and media come from the exercise. */
export const anywhereSessionSteps = pgTable(
  "anywhere_session_steps",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => anywhereSessions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    /** Plain text, e.g. "2 rounds of 30 seconds each side". */
    prescription: text("prescription").notNull(),
    /** Optional extra cue for this session; the exercise's own coaching notes are shown as well. */
    cue: text("cue"),
  },
  (t) => [index("anywhere_steps_session_idx").on(t.sessionId, t.sortOrder)],
);

/**
 * "Do this on your own": one specific session, or any session from a category, a number of
 * times inside a date window, for one athlete or one group.
 */
export const anywhereAssignments = pgTable(
  "anywhere_assignments",
  {
    id: id(),
    orgId: orgId(),
    sessionId: uuid("session_id").references(() => anywhereSessions.id),
    category: text("category").$type<AnywhereCategory>(),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    groupId: uuid("group_id").references(() => groups.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    targetCount: integer("target_count").notNull().default(1),
    note: text("note"),
    assignedBy: uuid("assigned_by").references(() => users.id),
    cancelledAt: ts("cancelled_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("anywhere_assign_athlete_idx").on(t.orgId, t.athleteId, t.endDate), index("anywhere_assign_group_idx").on(t.orgId, t.groupId, t.endDate)],
);

/**
 * A finished On Your Own session. Its own record (never a workout or a booking). `clientKey`
 * comes from the device so an offline retry can never create a second row.
 */
export const anywhereCompletions = pgTable(
  "anywhere_completions",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => anywhereSessions.id),
    /** Snapshots, so history reads the same after a coach edits or archives the session. */
    sessionTitle: text("session_title").notNull(),
    category: text("category").$type<AnywhereCategory>().notNull(),
    clientKey: text("client_key").notNull(),
    completedAt: ts("completed_at").notNull(),
    /** Facility-local calendar date of completion. */
    localDate: date("local_date").notNull(),
    stepsDone: integer("steps_done").notNull(),
    stepsTotal: integer("steps_total").notNull(),
    /** Optional. Null means "not given", never 0. */
    durationMinutes: integer("duration_minutes"),
    rpe: integer("rpe"),
    /** Set only when both RPE and duration were given: the load row with source "on_your_own". */
    activitySessionId: uuid("activity_session_id").references(() => activitySessions.id, { onDelete: "set null" }),
    loggedBy: uuid("logged_by").references(() => users.id),
    /** Who entered it: the athlete, a guardian on behalf of an athlete under 13, or staff. */
    loggedAs: text("logged_as").$type<"athlete" | "guardian" | "staff">().notNull().default("athlete"),
    reviewedAt: ts("reviewed_at"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("anywhere_completions_key_uq").on(t.orgId, t.clientKey), index("anywhere_completions_athlete_idx").on(t.orgId, t.athleteId, t.localDate)],
);

/** An athlete's outside sport season, typed in by the family. */
export const anywhereSeasons = pgTable(
  "anywhere_seasons",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    teamName: text("team_name").notNull(),
    sport: text("sport").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("anywhere_seasons_athlete_idx").on(t.orgId, t.athleteId, t.endsOn)],
);

export const SEASON_EVENT_KINDS = ["game", "practice", "tournament", "travel", "rest"] as const;
export type SeasonEventKind = (typeof SEASON_EVENT_KINDS)[number];

/**
 * A season event. One-off when `weekdays` is null (happens on `startsOn`), otherwise weekly on
 * those ISO weekdays between `startsOn` and `endsOn`. Times are local to `timezone` and each
 * occurrence is converted on its own, so a 4:00 PM practice stays 4:00 PM across DST.
 * Opponent and location are free text the family typed. Never geocoded, never looked up.
 */
export const anywhereSeasonEvents = pgTable(
  "anywhere_season_events",
  {
    id: id(),
    orgId: orgId(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => anywhereSeasons.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<SeasonEventKind>().notNull(),
    title: text("title"),
    opponent: text("opponent"),
    location: text("location"),
    weekdays: jsonb("weekdays").$type<number[]>(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** "HH:MM" local. Null = no time given (all day). */
    startTimeLocal: text("start_time_local"),
    durationMinutes: integer("duration_minutes"),
    timezone: text("timezone").notNull(),
    /** Local dates of a weekly event that were removed. */
    skipDates: jsonb("skip_dates").$type<string[]>().notNull().default([]),
    /** UID from an imported .ics file: re-importing the same file updates instead of duplicating. */
    icsUid: text("ics_uid"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("anywhere_events_athlete_idx").on(t.orgId, t.athleteId, t.startsOn), uniqueIndex("anywhere_events_uid_uq").on(t.seasonId, t.icsUid)],
);

export type IcsStagedEvent = {
  uid: string;
  kind: SeasonEventKind;
  title: string | null;
  location: string | null;
  weekdays: number[] | null;
  startsOn: string;
  endsOn: string;
  startTimeLocal: string | null;
  durationMinutes: number | null;
};

/** An uploaded .ics file, parsed and held for preview. Nothing reaches the season until confirmed. */
export const anywhereIcsImports = pgTable(
  "anywhere_ics_imports",
  {
    id: id(),
    orgId: orgId(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => anywhereSeasons.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    fileName: text("file_name").notNull(),
    status: text("status").$type<"staged" | "imported" | "discarded">().notNull().default("staged"),
    events: jsonb("events").$type<IcsStagedEvent[]>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("anywhere_ics_season_idx").on(t.seasonId, t.status)],
);

/**
 * Duration + RPE for an outside practice or game. Each one owns an activity_sessions row with
 * source "sport", which is what the load and ACWR views read. No row = not logged (never zero).
 */
export const anywhereSportLogs = pgTable(
  "anywhere_sport_logs",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    eventId: uuid("event_id").references(() => anywhereSeasonEvents.id, { onDelete: "set null" }),
    occurrenceDate: date("occurrence_date").notNull(),
    kind: text("kind").$type<"practice" | "game">().notNull(),
    clientKey: text("client_key").notNull(),
    activitySessionId: uuid("activity_session_id")
      .notNull()
      .references(() => activitySessions.id, { onDelete: "cascade" }),
    loggedBy: uuid("logged_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("anywhere_sport_logs_key_uq").on(t.orgId, t.clientKey),
    uniqueIndex("anywhere_sport_logs_event_uq").on(t.eventId, t.occurrenceDate),
    index("anywhere_sport_logs_athlete_idx").on(t.orgId, t.athleteId, t.occurrenceDate),
  ],
);
