import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, people, users } from "./core";
import { storedObjects } from "./documents";
import { alumni, newsItems } from "./newswatch";

/**
 * Wins and Competitions (docs/modules/wins.md): staff-entered team schedules for the competition
 * calendar, wins (achievements outside the gym), the marketing-consent ledger, the marketing
 * queue's "posted" log and staff leads. Nothing here stores a health value, a body weight or a
 * school grade, and nothing here is fetched from another site.
 */

export const TEAM_KINDS = ["school", "club", "other"] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

/** A school or club team whose schedule staff enter once and attach to several athletes. */
export const competitionTeams = pgTable(
  "competition_teams",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    sport: text("sport").notNull(),
    kind: text("kind").$type<TeamKind>().notNull().default("school"),
    /** Free text such as "Fall 2026". */
    seasonLabel: text("season_label"),
    archivedAt: ts("archived_at"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("competition_teams_org_idx").on(t.orgId, t.archivedAt)],
);

export const TEAM_EVENT_KINDS = ["game", "meet", "tournament"] as const;
export type TeamEventKind = (typeof TEAM_EVENT_KINDS)[number];

/** One date on a team schedule. Opponent and location are free text staff typed; never looked up. */
export const competitionTeamEvents = pgTable(
  "competition_team_events",
  {
    id: id(),
    orgId: orgId(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => competitionTeams.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TeamEventKind>().notNull().default("game"),
    /** Facility-local calendar date. */
    eventDate: date("event_date").notNull(),
    /** "HH:MM" facility-local, or null when no time is known. */
    startTimeLocal: text("start_time_local"),
    opponent: text("opponent"),
    location: text("location"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("competition_team_events_idx").on(t.orgId, t.eventDate), index("competition_team_events_team_idx").on(t.teamId, t.eventDate)],
);

/** Which athletes are on a team schedule. */
export const competitionTeamAthletes = pgTable(
  "competition_team_athletes",
  {
    id: id(),
    orgId: orgId(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => competitionTeams.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    addedBy: uuid("added_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("competition_team_athletes_uq").on(t.teamId, t.athleteId), index("competition_team_athletes_athlete_idx").on(t.orgId, t.athleteId)],
);

export const WIN_TYPES = ["personal_best", "placing", "selection", "commitment", "team_championship", "character", "other", "in_the_news"] as const;
/** "in_the_news" wins are only ever created by approving a news clip (docs/modules/newswatch.md). */
export const SUBMITTABLE_WIN_TYPES = WIN_TYPES.filter((t) => t !== "in_the_news");
export type WinType = (typeof WIN_TYPES)[number];

/**
 * awaiting_family: a staff lead turned into a draft; nothing is shown until the family confirms.
 * pending: submitted (or confirmed) and waiting for staff approval.
 * approved: may be shown, subject to the sharing levels below and the display-name setting.
 * declined: the family said a staff draft is wrong or unwanted.
 * removed: taken down by staff or withdrawn by the family (soft delete, audited).
 */
export type WinStatus = "awaiting_family" | "pending" | "approved" | "declined" | "removed";
export const WIN_STATUSES: WinStatus[] = ["awaiting_family", "pending", "approved", "declined", "removed"];

/** none = never asked or answered (the default, treated as no). */
export type MarketingConsentState = "none" | "granted" | "declined" | "revoked";
export const MARKETING_CONSENT_STATES: MarketingConsentState[] = ["none", "granted", "declined", "revoked"];

export type WinSubmitter = "athlete" | "guardian" | "staff";

/** An achievement outside the gym. Shown nowhere until a staff member approves it. */
export const wins = pgTable(
  "wins",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    /** Facility-local date it happened. */
    occurredOn: date("occurred_on").notNull(),
    sport: text("sport").notNull(),
    type: text("type").$type<WinType>().notNull(),
    headline: text("headline").notNull(),
    detail: text("detail"),
    /** https link the submitter pasted. Shown to staff and the athlete's own family only; never fetched. */
    sourceUrl: text("source_url"),
    /** "in_the_news" only: the publication the headline came from. Shown with the link out. */
    newsSource: text("news_source"),
    photoObjectId: uuid("photo_object_id").references(() => storedObjects.id),
    photoApprovedAt: ts("photo_approved_at"),
    photoApprovedBy: uuid("photo_approved_by").references(() => users.id),
    status: text("status").$type<WinStatus>().notNull().default("pending"),
    /** Level (a): the in-app Wins feed other families see, under the display name. */
    showInApp: boolean("show_in_app").notNull().default(true),
    /** Level (b): the gym TV board, under the display name. */
    showOnTv: boolean("show_on_tv").notNull().default(true),
    /** Level (c): the gym's public marketing. Current state; history is in win_consent_events. */
    marketingConsent: text("marketing_consent").$type<MarketingConsentState>().notNull().default("none"),
    marketingConsentAt: ts("marketing_consent_at"),
    marketingConsentBy: uuid("marketing_consent_by").references(() => users.id),
    /** Staff asked the family for level (c). Shown to the family in the app; no message is sent. */
    consentRequestedAt: ts("consent_requested_at"),
    consentRequestedBy: uuid("consent_requested_by").references(() => users.id),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAs: text("submitted_as").$type<WinSubmitter>().notNull(),
    familyConfirmedAt: ts("family_confirmed_at"),
    familyConfirmedBy: uuid("family_confirmed_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    approvedBy: uuid("approved_by").references(() => users.id),
    removedAt: ts("removed_at"),
    removedBy: uuid("removed_by").references(() => users.id),
    removedReason: text("removed_reason"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("wins_athlete_idx").on(t.orgId, t.athleteId, t.occurredOn), index("wins_status_idx").on(t.orgId, t.status, t.occurredOn)],
);

export type WinConsentAction = "requested" | "granted" | "declined" | "revoked";

/**
 * Append-only ledger for marketing consent (database trigger blocks UPDATE and DELETE): who,
 * in what relationship, when, and the exact wording they agreed to.
 */
export const winConsentEvents = pgTable(
  "win_consent_events",
  {
    id: id(),
    orgId: orgId(),
    winId: uuid("win_id")
      .notNull()
      .references(() => wins.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    action: text("action").$type<WinConsentAction>().notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actorPersonId: uuid("actor_person_id").references(() => people.id),
    relationship: text("relationship").$type<"guardian" | "self" | "staff">().notNull(),
    policyVersion: text("policy_version").notNull(),
    policyText: text("policy_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("win_consent_events_win_idx").on(t.winId, t.createdAt)],
);

export const MARKETING_CHANNELS = ["instagram", "facebook", "website", "newsletter", "other"] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/** Staff noted that they posted a win somewhere. The Hub itself posts nothing. */
export const winMarketingPosts = pgTable(
  "win_marketing_posts",
  {
    id: id(),
    orgId: orgId(),
    winId: uuid("win_id")
      .notNull()
      .references(() => wins.id),
    channel: text("channel").$type<MarketingChannel>().notNull(),
    postedOn: date("posted_on").notNull(),
    markedBy: uuid("marked_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("win_marketing_posts_uq").on(t.winId, t.channel, t.postedOn), index("win_marketing_posts_org_idx").on(t.orgId, t.winId)],
);

export type WinLeadStatus = "open" | "converted" | "dismissed";

/** staff: typed in by a staff member. news: a headline News watch matched to a watched name. */
export type WinLeadKind = "staff" | "news";
/**
 * News clips only. suggested: the matcher's guess. confirmed: a staff member says it is our
 * athlete (triage; this alone shows nothing to anyone). approved: a person allowed to approve
 * clips approved it, so it may be shown. rejected / not_ours / ignored: closed. withdrawn: the
 * opt-in was withdrawn or the alumnus was taken off the watch list. removed: taken down after
 * approval.
 */
export type NewsClipStatus = "suggested" | "confirmed" | "approved" | "rejected" | "not_ours" | "ignored" | "withdrawn" | "removed";
export const NEWS_CLIP_STATUSES: NewsClipStatus[] = ["suggested", "confirmed", "approved", "rejected", "not_ours", "ignored", "withdrawn", "removed"];
export type NewsMatchLevel = "likely" | "possible";

/** Something staff heard or a link they pasted. Staff-only until it becomes a draft win. */
export const winLeads = pgTable(
  "win_leads",
  {
    id: id(),
    orgId: orgId(),
    note: text("note").notNull(),
    sourceUrl: text("source_url"),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    status: text("status").$type<WinLeadStatus>().notNull().default("open"),
    winId: uuid("win_id").references(() => wins.id),
    createdBy: uuid("created_by").references(() => users.id),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id),
    kind: text("kind").$type<WinLeadKind>().notNull().default("staff"),
    // --- News clips (kind "news") only; all null on a staff lead ---------------------------
    newsItemId: uuid("news_item_id").references(() => newsItems.id),
    alumniId: uuid("alumni_id").references(() => alumni.id),
    newsStatus: text("news_status").$type<NewsClipStatus>(),
    matchLevel: text("match_level").$type<NewsMatchLevel>(),
    matchScore: integer("match_score"),
    /** Plain sentences: why the matcher suggested it. */
    matchReasons: jsonb("match_reasons").$type<string[]>(),
    /** A label when the headline mentions an arrest, a court, a death or discipline. Staff see it as a warning. */
    sensitiveNote: text("sensitive_note"),
    triagedBy: uuid("triaged_by").references(() => users.id),
    triagedAt: ts("triaged_at"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: ts("approved_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    index("win_leads_org_idx").on(t.orgId, t.status, t.createdAt),
    index("win_leads_news_idx").on(t.orgId, t.kind, t.newsStatus, t.createdAt),
    uniqueIndex("win_leads_news_athlete_uq").on(t.newsItemId, t.athleteId),
    uniqueIndex("win_leads_news_alumni_uq").on(t.newsItemId, t.alumniId),
  ],
);
