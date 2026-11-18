import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, people, users } from "./core";

/**
 * News watch (docs/modules/newswatch.md): feed sources, the alumni list, who is watched, the
 * headlines that matched a watched name, and what staff taught the matcher. Only feed data is
 * stored: a headline, the publication, a date, a link and at most a short summary the feed itself
 * carried. No article text and no images. A matched headline becomes a row in `win_leads`
 * (kind "news"); nothing is shown to anyone until a person approves it.
 */

/** rss: an RSS or Atom feed the publisher offers. search: a news search feed queried by name. */
export const NEWS_SOURCE_KINDS = ["rss", "search"] as const;
export type NewsSourceKind = (typeof NEWS_SOURCE_KINDS)[number];
/** Whose names a source is checked for. */
export const NEWS_AUDIENCES = ["all", "athletes", "alumni"] as const;
export type NewsAudience = (typeof NEWS_AUDIENCES)[number];

export const newsSources = pgTable(
  "news_sources",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    kind: text("kind").$type<NewsSourceKind>().notNull(),
    /** rss: the feed address. search: the search feed address containing `{query}`. https only. */
    url: text("url").notNull(),
    /** search only: publication domains the query is restricted to (site: filters). */
    sites: jsonb("sites").$type<string[]>().notNull().default([]),
    audience: text("audience").$type<NewsAudience>().notNull().default("all"),
    enabled: boolean("enabled").notNull().default(true),
    /** Never fetched more often than this. */
    minIntervalMinutes: integer("min_interval_minutes").notNull().default(720),
    lastFetchedAt: ts("last_fetched_at"),
    lastStatus: text("last_status").$type<"ok" | "error">(),
    /** One plain line for Settings: "50 headlines read" or the error. */
    lastResult: text("last_result"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** After a failure the source is left alone until this time (doubling, capped). */
    backoffUntil: ts("backoff_until"),
    /** True for the sample defaults created for the organization. */
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("news_sources_org_idx").on(t.orgId, t.enabled)],
);

/** How many feed requests the organization made on one facility-local date (the daily cap). */
export const newsFetchDays = pgTable(
  "news_fetch_days",
  {
    id: id(),
    orgId: orgId(),
    day: text("day").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [uniqueIndex("news_fetch_days_uq").on(t.orgId, t.day)],
);

/**
 * A former athlete now competing in college. Adults in public competition: staff add them and
 * record on what basis they are watched. Shown as first name and last initial unless staff
 * record that the alumnus said the full name is fine.
 */
export const alumni = pgTable(
  "alumni",
  {
    id: id(),
    orgId: orgId(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    sport: text("sport"),
    college: text("college"),
    gradYear: integer("grad_year"),
    /** Optional link to the athlete record they had here. */
    athleteId: uuid("athlete_id").references(() => athletes.id),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    /** On the news watch list. */
    watch: boolean("watch").notNull().default(false),
    /** Why staff may watch this person, e.g. "gave permission at alumni day". Required while watch is on. */
    watchBasis: text("watch_basis"),
    watchSetBy: uuid("watch_set_by").references(() => users.id),
    watchSetAt: ts("watch_set_at"),
    /** The alumnus agreed to their full name being shown. Default: first name and last initial. */
    fullNameOk: boolean("full_name_ok").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("alumni_org_idx").on(t.orgId, t.active), uniqueIndex("alumni_athlete_uq").on(t.athleteId)],
);

/**
 * News watch for one current athlete: the family's opt-in (default off) and the words staff add
 * to tell this athlete apart from someone else with the same name. History is in
 * `news_watch_events`.
 */
export const newsWatchAthletes = pgTable(
  "news_watch_athletes",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    optedIn: boolean("opted_in").notNull().default(false),
    decidedAt: ts("decided_at"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAs: text("decided_as").$type<"guardian" | "self" | "staff">(),
    /** Staff asked the family. Shown to the family in the app; no message is sent. */
    requestedAt: ts("requested_at"),
    requestedBy: uuid("requested_by").references(() => users.id),
    /** Disambiguators. School and sport fall back to the athlete record when empty. */
    school: text("school"),
    sport: text("sport"),
    town: text("town"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("news_watch_athletes_uq").on(t.athleteId), index("news_watch_athletes_org_idx").on(t.orgId, t.optedIn)],
);

export type NewsWatchAction = "requested" | "granted" | "declined" | "revoked" | "alumni_added" | "alumni_removed";

/** Append-only (database trigger): every opt-in, opt-out and watch-list change, with the wording shown. */
export const newsWatchEvents = pgTable(
  "news_watch_events",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    alumniId: uuid("alumni_id").references(() => alumni.id),
    action: text("action").$type<NewsWatchAction>().notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actorPersonId: uuid("actor_person_id").references(() => people.id),
    relationship: text("relationship").$type<"guardian" | "self" | "staff">().notNull(),
    /** The opt-in wording version and text (athletes), or the recorded basis (alumni). */
    policyVersion: text("policy_version"),
    policyText: text("policy_text"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("news_watch_events_athlete_idx").on(t.orgId, t.athleteId, t.createdAt), index("news_watch_events_alumni_idx").on(t.orgId, t.alumniId, t.createdAt)],
);

/**
 * One headline that matched a watched name. Kept so the same article is not suggested twice.
 * Headlines that matched nobody are not stored at all.
 */
export const newsItems = pgTable(
  "news_items",
  {
    id: id(),
    orgId: orgId(),
    sourceId: uuid("source_id").references(() => newsSources.id, { onDelete: "set null" }),
    /** sha256 of the normalized link. */
    linkKey: text("link_key").notNull(),
    /** sha256 of the normalized headline and publication: the same article arriving another way. */
    titleKey: text("title_key").notNull(),
    headline: text("headline").notNull(),
    /** The publication, e.g. "Sample County Gazette". */
    sourceName: text("source_name").notNull(),
    publishedAt: ts("published_at"),
    link: text("link").notNull(),
    /** The feed's own short summary, cut to two sentences. Never article text. */
    snippet: text("snippet"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("news_items_link_uq").on(t.orgId, t.linkKey), index("news_items_title_idx").on(t.orgId, t.titleKey)],
);

/**
 * "Not our athlete": what staff taught the matcher about one watched person. The article itself
 * is never suggested for them again, each one lowers the score of later headlines from the same
 * publication, and an optional word (a town, a school) drops any later headline that contains it.
 */
export const newsNegatives = pgTable(
  "news_negatives",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    alumniId: uuid("alumni_id").references(() => alumni.id),
    newsItemId: uuid("news_item_id").references(() => newsItems.id, { onDelete: "set null" }),
    titleKey: text("title_key"),
    /** Normalized publication name. */
    publication: text("publication"),
    /** A word or phrase that marks the other person with this name. */
    term: text("term"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("news_negatives_athlete_idx").on(t.orgId, t.athleteId), index("news_negatives_alumni_idx").on(t.orgId, t.alumniId)],
);
