import { date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, groups, users } from "./core";

/**
 * Community module (docs/modules/community.md): display consent, gym TV board access, coach
 * shoutouts and team challenges. Nothing here stores a health value, an age or a billing fact.
 * Leaderboards and challenge progress are DERIVED read-only from rows other modules write.
 */

/** How an athlete may be named where other families can see it. */
export type DisplayNameMode = "first_last_initial" | "first_name_only" | "hidden";
export const DISPLAY_NAME_MODES: DisplayNameMode[] = ["first_last_initial", "first_name_only", "hidden"];

/** One row per athlete who has an explicit choice; no row means the organization default applies. */
export const communityDisplayPrefs = pgTable(
  "community_display_prefs",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    mode: text("mode").$type<DisplayNameMode>().notNull(),
    setBy: uuid("set_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("community_display_prefs_athlete_uq").on(t.athleteId), index("community_display_prefs_org_idx").on(t.orgId)],
);

/**
 * A facility TV. The device holds a random token (only its SHA-256 hash is stored) that can read
 * the board payload and nothing else. Revoking sets revoked_at; a revoked token never works again.
 */
export const communityDisplayTokens = pgTable(
  "community_display_tokens",
  {
    id: id(),
    orgId: orgId(),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("community_display_tokens_hash_uq").on(t.tokenHash), index("community_display_tokens_org_idx").on(t.orgId)],
);

export type ShoutoutTemplate = "great_effort" | "leader_today" | "new_pr" | "consistency";
export const SHOUTOUT_TEMPLATES: ShoutoutTemplate[] = ["great_effort", "leader_today", "new_pr", "consistency"];

/** A short, staff-authored shoutout for one athlete. Removal is a soft delete (audited). */
export const communityShoutouts = pgTable(
  "community_shoutouts",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    template: text("template").$type<ShoutoutTemplate>().notNull(),
    /** Optional short note, staff-authored, linted with the family style rules. */
    note: text("note"),
    /** Facility-local date it was posted (the per-coach daily limit counts on this). */
    localDate: date("local_date").notNull(),
    removedAt: ts("removed_at"),
    removedBy: uuid("removed_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("community_shoutouts_athlete_idx").on(t.orgId, t.athleteId, t.createdAt), index("community_shoutouts_author_day_idx").on(t.orgId, t.authorUserId, t.localDate)],
);

export type ChallengeMode = "individual" | "group_total";
export type ChallengeMetric = "attendance" | "workouts" | "streak_weeks";
export type ChallengeStatus = "active" | "archived";

/** A time-boxed challenge. Progress is computed from attendance, workouts and active weeks. No prizes. */
export const communityChallenges = pgTable(
  "community_challenges",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    mode: text("mode").$type<ChallengeMode>().notNull(),
    metric: text("metric").$type<ChallengeMetric>().notNull(),
    /** Individual: each athlete's target. Group total: the combined target. */
    target: integer("target").notNull(),
    /** Facility-local dates, inclusive. */
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** Limit to one training group; null = every active athlete. */
    groupId: uuid("group_id").references(() => groups.id),
    status: text("status").$type<ChallengeStatus>().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("community_challenges_org_idx").on(t.orgId, t.status, t.endsOn)],
);

/** One row per athlete who completed a challenge (the badge and audit entry hang off this). */
export const communityChallengeCompletions = pgTable(
  "community_challenge_completions",
  {
    id: id(),
    orgId: orgId(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => communityChallenges.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    /** The athlete's own count when the challenge was completed. */
    value: integer("value").notNull(),
    completedAt: ts("completed_at").notNull(),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("community_challenge_completions_uq").on(t.challengeId, t.athleteId), index("community_challenge_completions_athlete_idx").on(t.orgId, t.athleteId)],
);
