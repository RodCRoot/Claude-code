import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, people, users } from "./core";

export const leadStages = pgTable("lead_stages", {
  id: id(),
  orgId: orgId(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull(),
  isWon: boolean("is_won").notNull().default(false),
  isLost: boolean("is_lost").notNull().default(false),
});

export const leads = pgTable(
  "leads",
  {
    id: id(),
    orgId: orgId(),
    /** The prospective athlete or the inquiring adult. */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    /** Parent/guardian who inquired, if the lead is a minor. */
    contactPersonId: uuid("contact_person_id").references(() => people.id),
    stage: text("stage").notNull().default("new"),
    source: text("source"),
    interest: text("interest"),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    lostReason: text("lost_reason"),
    convertedAthleteId: uuid("converted_athlete_id").references(() => athletes.id),
    convertedAt: ts("converted_at"),
    assessmentSessionId: uuid("assessment_session_id"),
    inquiry: jsonb("inquiry").$type<Record<string, unknown>>().notNull().default({}),
    lastContactedAt: ts("last_contacted_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("leads_org_stage_idx").on(t.orgId, t.stage)],
);

export const threads = pgTable(
  "threads",
  {
    id: id(),
    orgId: orgId(),
    subject: text("subject").notNull(),
    /** Athlete context determines which guardians may be participants. */
    athleteId: uuid("athlete_id").references(() => athletes.id),
    leadId: uuid("lead_id").references(() => leads.id),
    kind: text("kind").$type<"family" | "athlete" | "lead" | "staff">().notNull(),
    assignedUserId: uuid("assigned_user_id").references(() => users.id),
    status: text("status").$type<"open" | "snoozed" | "closed">().notNull().default("open"),
    lastMessageAt: ts("last_message_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("threads_org_status_idx").on(t.orgId, t.status, t.lastMessageAt)],
);

export const threadParticipants = pgTable(
  "thread_participants",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id),
    userId: uuid("user_id").references(() => users.id),
    role: text("role").$type<"staff" | "guardian" | "athlete" | "lead_contact">().notNull(),
    lastReadAt: ts("last_read_at"),
  },
  (t) => [index("thread_participants_thread_idx").on(t.threadId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    senderUserId: uuid("sender_user_id").references(() => users.id),
    senderPersonId: uuid("sender_person_id").references(() => people.id),
    body: text("body").notNull(),
    /** Internal notes are visible to staff only and are never delivered externally. */
    isInternalNote: boolean("is_internal_note").notNull().default(false),
    automationRuleId: uuid("automation_rule_id"),
    /** Broadcast campaign that produced this message (email then requires explicit opt-in). */
    campaignId: uuid("campaign_id"),
    /** Set when the message arrived by email/SMS reply through a provider webhook. */
    inboundChannel: text("inbound_channel").$type<"email" | "sms">(),
    clientMutationId: text("client_mutation_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("messages_client_uq").on(t.clientMutationId),
    index("messages_campaign_idx").on(t.campaignId),
  ],
);

export type DeliveryStatus = "queued" | "suppressed" | "test_redirected" | "sent" | "delivered" | "failed" | "not_configured";

export const messageDeliveries = pgTable("message_deliveries", {
  id: id(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id),
  recipientPersonId: uuid("recipient_person_id").references(() => people.id),
  channel: text("channel").$type<"in_app" | "email" | "sms">().notNull(),
  address: text("address"),
  status: text("status").$type<DeliveryStatus>().notNull(),
  statusReason: text("status_reason"),
  providerMessageId: text("provider_message_id"),
  attempts: integer("attempts").notNull().default(0),
  updatedAt: updatedAt(),
});

export const commPreferences = pgTable(
  "comm_preferences",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    channel: text("channel").$type<"email" | "sms">().notNull(),
    consent: text("consent").$type<"opted_in" | "opted_out" | "unknown">().notNull().default("unknown"),
    consentSource: text("consent_source"),
    capturedAt: ts("captured_at"),
    quietStartLocal: time("quiet_start_local"),
    quietEndLocal: time("quiet_end_local"),
  },
  (t) => [uniqueIndex("comm_pref_uq").on(t.personId, t.channel)],
);

export type ConsentState = "opted_in" | "opted_out" | "unknown";

/**
 * Append-only history of consent / quiet-hours changes (DB trigger forbids UPDATE/DELETE).
 * `source` says where the change came from: family_portal, staff, sms_keyword, email_complaint,
 * inquiry_form, lead_conversion, seed, backfill.
 */
export const commConsentEvents = pgTable(
  "comm_consent_events",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    channel: text("channel").$type<"email" | "sms">().notNull(),
    kind: text("kind").$type<"consent" | "quiet_hours">().notNull(),
    consent: text("consent").$type<ConsentState>(),
    previousConsent: text("previous_consent").$type<ConsentState>(),
    quietStartLocal: time("quiet_start_local"),
    quietEndLocal: time("quiet_end_local"),
    source: text("source").notNull(),
    detail: text("detail"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("comm_consent_events_person_idx").on(t.personId, t.createdAt)],
);

/**
 * Addresses a provider told us cannot receive mail (hard bounce / spam complaint). While an
 * uncleared row exists, deliveries to that address are suppressed. Staff can clear it once the
 * family fixes their address.
 */
export const undeliverableAddresses = pgTable(
  "undeliverable_addresses",
  {
    id: id(),
    orgId: orgId(),
    channel: text("channel").$type<"email" | "sms">().notNull(),
    /** Normalized: lower-cased email, or +digits phone. */
    address: text("address").notNull(),
    reason: text("reason").$type<"hard_bounce" | "spam_complaint">().notNull(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id"),
    detail: text("detail"),
    createdAt: createdAt(),
    clearedAt: ts("cleared_at"),
    clearedByUserId: uuid("cleared_by_user_id").references(() => users.id),
  },
  (t) => [index("undeliverable_lookup_idx").on(t.orgId, t.channel, t.address)],
);

/** Raw messaging-provider webhooks; (provider, provider_event_id) uniqueness makes ingestion idempotent. */
export const messagingProviderEvents = pgTable(
  "messaging_provider_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    kind: text("kind").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    status: text("status").$type<"processed" | "ignored" | "rejected" | "failed">().notNull(),
    summary: text("summary"),
    error: text("error"),
    payload: jsonb("payload"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [uniqueIndex("messaging_provider_events_uq").on(t.provider, t.providerEventId)],
);

/**
 * Inbound email/SMS replies. Threaded into the matching conversation when the sender is a known,
 * still-eligible participant; otherwise held in a staff-only "unmatched" queue.
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: id(),
    orgId: orgId(),
    channel: text("channel").$type<"email" | "sms">().notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address"),
    subject: text("subject"),
    body: text("body").notNull(),
    status: text("status").$type<"threaded" | "unmatched" | "attached" | "dismissed">().notNull(),
    reason: text("reason"),
    matchedPersonId: uuid("matched_person_id").references(() => people.id),
    threadId: uuid("thread_id").references(() => threads.id),
    messageId: uuid("message_id").references(() => messages.id),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    resolvedAt: ts("resolved_at"),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("inbound_messages_provider_uq").on(t.provider, t.providerMessageId), index("inbound_messages_org_status_idx").on(t.orgId, t.status)],
);

export type SegmentFilters = {
  audience: "athletes" | "leads";
  /** Recipient role after guardian routing (athlete audience): guardians only, or adult athletes themselves. */
  recipientRole?: "guardian" | "athlete";
  groupId?: string;
  sport?: string;
  membershipStatus?: "active" | "trialing" | "on_hold" | "past_due" | "cancelled" | "expired" | "pending" | "none";
  productId?: string;
  athleteActive?: "active" | "inactive";
  attendance?: { mode: "attended" | "not_attended"; days: number };
  /** "any" = any outstanding non-medical form; a template id = that form (medical forms need health access). */
  missingForm?: string;
  leadStage?: string;
  tagId?: string;
};

export const segments = pgTable("segments", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  description: text("description"),
  filters: jsonb("filters").$type<SegmentFilters>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  archivedAt: ts("archived_at"),
  isDemo: isDemo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type CampaignStatus = "draft" | "pending_approval" | "approved" | "sending" | "sent" | "cancelled";

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id),
    channels: jsonb("channels").$type<("in_app" | "email" | "sms")[]>().notNull().default(["in_app"]),
    /** null = send as soon as it is approved. */
    scheduledAt: ts("scheduled_at"),
    status: text("status").$type<CampaignStatus>().notNull().default("draft"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id),
    submittedAt: ts("submitted_at"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: ts("approved_at"),
    reviewNote: text("review_note"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    recipientCount: integer("recipient_count"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_org_status_idx").on(t.orgId, t.status)],
);

/** One row per person per campaign — the unique index is the per-recipient dedupe. */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: id(),
    orgId: orgId(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    role: text("role").notNull(),
    athleteIds: jsonb("athlete_ids").$type<string[]>().notNull().default([]),
    leadId: uuid("lead_id"),
    messageId: uuid("message_id").references(() => messages.id),
    threadId: uuid("thread_id").references(() => threads.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("campaign_recipients_uq").on(t.campaignId, t.personId)],
);

export const messageTemplates = pgTable("message_templates", {
  id: id(),
  orgId: orgId(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  channel: text("channel").$type<"in_app" | "email" | "sms">().notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  isSample: boolean("is_sample").notNull().default(true),
  updatedAt: updatedAt(),
});

export type AutomationTrigger =
  | "session_changed"
  | "session_cancelled"
  | "assessment_completed"
  | "form_missing"
  | "payment_failed"
  | "renewal_upcoming"
  | "attendance_lapsed"
  | "lead_created";

export const automationRules = pgTable("automation_rules", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  trigger: text("trigger").$type<AutomationTrigger>().notNull(),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
  templateId: uuid("template_id").references(() => messageTemplates.id),
  createTask: boolean("create_task").notNull().default(false),
  delayMinutes: integer("delay_minutes").notNull().default(0),
  channels: jsonb("channels").$type<("in_app" | "email" | "sms")[]>().notNull().default(["in_app"]),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: createdAt(),
});

export type JobStatus = "pending" | "running" | "done" | "failed" | "dead" | "cancelled";

/** Durable outbox / job queue (claimed with FOR UPDATE SKIP LOCKED). */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: uuid("org_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key"),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    result: jsonb("result"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey), index("jobs_ready_idx").on(t.status, t.runAt)],
);
