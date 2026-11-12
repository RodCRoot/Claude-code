import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, locations, tasks, users } from "./core";

/**
 * Member journey (docs/modules/journey.md): onboarding, touchpoints, visit milestones, review and
 * referral asks, holds and offboarding as checklists of steps.
 *
 * A step IS a row in the existing `tasks` table (source = 'journey'): status, assignee, due time
 * and completion live there, so the Tasks page and the person page keep working. `journey_steps`
 * only adds what a plain task cannot hold (which checklist it belongs to, the auto-complete rule,
 * skip reason, snooze date, the local due date). Templates are stored in
 * `organizations.settings.journey`, not in a table.
 */
export const JOURNEY_KINDS = ["onboarding", "touchpoints", "visit_milestones", "review_referral", "hold", "offboarding"] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export type JourneyStatus = "active" | "completed" | "closed";

/** One checklist run for one athlete. `anchor_key` makes generation idempotent (unique per org). */
export const journeys = pgTable(
  "journeys",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<JourneyKind>().notNull(),
    /** What started it: `onboarding:<membershipId>`, `hold:<holdId>`, `offboarding:<membershipId>`, `visit_milestones:<athleteId>` … */
    anchorKey: text("anchor_key").notNull(),
    /** Membership or hold the journey follows (null for per-athlete journeys). */
    anchorId: uuid("anchor_id"),
    /** Facility-local date the offsets count from. */
    startedOn: date("started_on").notNull(),
    status: text("status").$type<JourneyStatus>().notNull().default("active"),
    /** When the last step was finished or skipped (all steps resolved). */
    completedAt: ts("completed_at"),
    closedReason: text("closed_reason"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("journeys_anchor_uq").on(t.orgId, t.anchorKey), index("journeys_athlete_idx").on(t.athleteId), index("journeys_org_kind_idx").on(t.orgId, t.kind, t.status)],
);

export type JourneyOwnerRole = "owner" | "operations" | "coach";

/** Extension of one `tasks` row that is a journey step (1:1, the task id is the key). */
export const journeySteps = pgTable(
  "journey_steps",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orgId: orgId(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<JourneyKind>().notNull(),
    /** Template step key, e.g. `first_session_attended`, `touch_6_months`, `visits_50`. */
    stepKey: text("step_key").notNull(),
    name: text("name").notNull(),
    ownerRole: text("owner_role").$type<JourneyOwnerRole>().notNull(),
    /** One of AUTO_RULES (src/lib/journey/templates.ts) or null for a step only a person can tick. */
    autoRule: text("auto_rule"),
    /** Billing-related: never shown to coaches. */
    billing: boolean("billing").notNull().default(false),
    /** Facility-local due date (tasks.due_at is the end of this local day). */
    dueOn: date("due_on").notNull(),
    /** The due date before a hold moved it (touchpoints only); null when it never moved. */
    originalDueOn: date("original_due_on"),
    /** Hidden from the queue until this local date. */
    snoozedUntil: date("snoozed_until"),
    /** Required when the task is cancelled by "skip". */
    skipReason: text("skip_reason"),
    /** How a done step was finished. */
    completedVia: text("completed_via").$type<"staff" | "auto">(),
    /** Review / referral asks: asked | reviewed | referred | declined. */
    outcome: text("outcome"),
    note: text("note"),
    /** Review asks are held back while the member is at risk or past due. */
    suppressed: boolean("suppressed").notNull().default(false),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("journey_steps_key_uq").on(t.journeyId, t.stepKey), index("journey_steps_athlete_idx").on(t.athleteId), index("journey_steps_org_due_idx").on(t.orgId, t.dueOn)],
);

export const OPS_SECTIONS = ["opening", "closing", "cleaning", "weekly"] as const;
export type OpsSection = (typeof OPS_SECTIONS)[number];

/** One line of a location's daily / weekly operations checklist. location_id null = every location. */
export const opsChecklistItems = pgTable(
  "ops_checklist_items",
  {
    id: id(),
    orgId: orgId(),
    locationId: uuid("location_id").references(() => locations.id),
    section: text("section").$type<OpsSection>().notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("ops_checklist_items_org_idx").on(t.orgId, t.locationId), check("ops_checklist_items_section_ck", sql`${t.section} in ('opening','closing','cleaning','weekly')`)],
);

/** A tick: who did the item on which facility-local day (weekly items: the Monday of the week). */
export const opsChecklistTicks = pgTable(
  "ops_checklist_ticks",
  {
    id: id(),
    orgId: orgId(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => opsChecklistItems.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    tickedBy: uuid("ticked_by")
      .notNull()
      .references(() => users.id),
    tickedAt: createdAt(),
    isDemo: isDemo(),
  },
  (t) => [uniqueIndex("ops_checklist_ticks_uq").on(t.itemId, t.localDate), index("ops_checklist_ticks_org_date_idx").on(t.orgId, t.localDate)],
);

/** A coach's free-text reflection for one week (Monday date). The numbers are computed, never stored. */
export const coachReflections = pgTable(
  "coach_reflections",
  {
    id: id(),
    orgId: orgId(),
    coachUserId: uuid("coach_user_id")
      .notNull()
      .references(() => users.id),
    weekStart: date("week_start").notNull(),
    wentWell: text("went_well"),
    stuck: text("stuck"),
    helpNeeded: text("help_needed"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("coach_reflections_uq").on(t.orgId, t.coachUserId, t.weekStart)],
);
