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
    clientMutationId: text("client_mutation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt), uniqueIndex("messages_client_uq").on(t.clientMutationId)],
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
