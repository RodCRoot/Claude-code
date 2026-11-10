import { date, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, people, users } from "./core";

/**
 * Showcase module (docs/modules/showcase.md): the shareable athlete Showcase and the Monthly
 * Progress Recap. Nothing here stores wellness, body map, injury, notes, billing, address or a
 * date of birth. The Showcase config is an allowlist of display choices; the numbers themselves
 * are read from the rows other modules already own.
 */

export type ShowcaseStatus = "draft" | "published";
export type ShowcaseNameDisplay = "first" | "first_initial" | "full";

/** The only keys a Showcase config may hold (src/lib/showcase/allowlist.ts validates and strips). */
export type ShowcaseConfig = {
  nameDisplay: ShowcaseNameDisplay;
  show: {
    sport: boolean;
    position: boolean;
    gradYear: boolean;
    school: boolean;
    ageBand: boolean;
    weight: boolean;
    sessions: boolean;
    streak: boolean;
    memberSince: boolean;
    relativeStrength: boolean;
  };
  /** metric_definitions ids (test metrics). */
  metricIds: string[];
  /** exercises ids (lift maxes). */
  exerciseIds: string[];
  bio: string;
  /** https only; rendered as a link, never embedded. */
  videoUrl: string | null;
  /** Typed by the publisher. Account emails and phones are never used. */
  contactEmail: string | null;
};

/** One Showcase per athlete. The share token is stored as a SHA-256 hash only. */
export const showcases = pgTable(
  "showcases",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    status: text("status").$type<ShowcaseStatus>().notNull().default("draft"),
    config: jsonb("config").$type<ShowcaseConfig>().notNull(),
    /** SHA-256 (hex) of the share token. The token itself is shown once and never stored. */
    tokenHash: text("token_hash"),
    publishedAt: ts("published_at"),
    publishedBy: uuid("published_by").references(() => users.id),
    /** Null = no expiry. */
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("showcases_athlete_uq").on(t.athleteId), uniqueIndex("showcases_token_uq").on(t.tokenHash), index("showcases_org_idx").on(t.orgId, t.status)],
);

export type ShowcaseConsentKind = "granted" | "withdrawn";

/**
 * Append-only consent trail (DB trigger blocks UPDATE/DELETE): who allowed sharing, when, exactly
 * which fields, and under which policy text. A withdrawal (revoke) is its own row.
 */
export const showcaseConsents = pgTable(
  "showcase_consents",
  {
    id: id(),
    orgId: orgId(),
    showcaseId: uuid("showcase_id")
      .notNull()
      .references(() => showcases.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<ShowcaseConsentKind>().notNull(),
    /** "guardian" | "self" for grants; "guardian" | "self" | "staff" for withdrawals. */
    actorRelationship: text("actor_relationship").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actorPersonId: uuid("actor_person_id").references(() => people.id),
    /** The exact config consented to (grants) or in force when withdrawn. */
    fields: jsonb("fields").$type<ShowcaseConfig>().notNull(),
    policyVersion: text("policy_version").notNull(),
    policyText: text("policy_text").notNull(),
    expiresAt: ts("expires_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("showcase_consents_showcase_idx").on(t.showcaseId, t.createdAt)],
);

/** Coarse view counter: one row per Showcase per facility-local day. No visitor data of any kind. */
export const showcaseViewDays = pgTable(
  "showcase_view_days",
  {
    showcaseId: uuid("showcase_id")
      .notNull()
      .references(() => showcases.id),
    orgId: orgId(),
    day: date("day").notNull(),
    views: integer("views").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.showcaseId, t.day] })],
);

export type RecapStatus = "open" | "final";

/**
 * Monthly Progress Recap for one athlete. While `open` the numbers are computed live and only the
 * coach note is stored. Finalizing writes the snapshot once; a DB trigger then blocks any change
 * to the snapshot, note, month or calculation key.
 */
export const monthlyRecaps = pgTable(
  "monthly_recaps",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    /** Facility-local calendar month, "YYYY-MM". */
    month: text("month").notNull(),
    status: text("status").$type<RecapStatus>().notNull().default("open"),
    /** Versioned calculation key of the snapshot, e.g. "tw_recap_v1". */
    calcKey: text("calc_key").notNull(),
    /** Frozen numbers (src/lib/showcase/recap.ts → RecapSnapshot). Null until finalized. */
    snapshot: jsonb("snapshot"),
    coachNote: text("coach_note"),
    coachNoteBy: uuid("coach_note_by").references(() => users.id),
    coachNoteAt: ts("coach_note_at"),
    finalizedAt: ts("finalized_at"),
    /** How it was finalized: "job" | "on_demand" | "staff" | "seed". */
    finalizedVia: text("finalized_via"),
    /** In-app notice for the family (Athlete Home) from this moment. Never an external send. */
    noticeAt: ts("notice_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("monthly_recaps_uq").on(t.orgId, t.athleteId, t.month), index("monthly_recaps_month_idx").on(t.orgId, t.month, t.status)],
);
