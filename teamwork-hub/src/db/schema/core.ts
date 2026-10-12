import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("America/Indiana/Indianapolis"),
  currency: text("currency").notNull().default("USD"),
  country: text("country").notNull().default("US"),
  /** { primaryColor, accentColor, logoUrl, displayName } — configurable, no assets assumed. */
  branding: jsonb("branding").$type<Record<string, string>>().notNull().default({}),
  /** Business policies (cancellation windows, entitlement policy for pending bank payments, quiet hours…). */
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Identity: person ≠ login ≠ athlete ≠ guardian ≠ household ≠ payer
// ---------------------------------------------------------------------------

export type PersonStatus = "lead" | "prospect" | "active" | "inactive" | "archived";

/** A human being. Never merged automatically — shared surname/email does not imply identity. */
export const people = pgTable(
  "people",
  {
    id: id(),
    orgId: orgId(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    dateOfBirth: date("date_of_birth"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").$type<PersonStatus>().notNull().default("active"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source").notNull().default("teamwork"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [
    index("people_org_name_idx").on(t.orgId, t.lastName, t.firstName),
    index("people_org_email_idx").on(t.orgId, t.email),
  ],
);

export type Role = "owner" | "admin" | "operations" | "coach" | "guardian" | "athlete" | "kiosk";

/** A login. Optional link to a person (kiosks have none). */
export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id").references(() => people.id),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").$type<Role>().notNull(),
    displayName: text("display_name").notNull(),
    mfaSecret: text("mfa_secret"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: ts("invite_expires_at"),
    resetTokenHash: text("reset_token_hash"),
    resetExpiresAt: ts("reset_expires_at"),
    disabledAt: ts("disabled_at"),
    lastLoginAt: ts("last_login_at"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_org_email_uq").on(t.orgId, sql`lower(${t.email})`),
    uniqueIndex("users_person_uq").on(t.personId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const athletes = pgTable(
  "athletes",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    sport: text("sport"),
    position: text("position"),
    gradYear: integer("grad_year"),
    school: text("school"),
    active: boolean("active").notNull().default(true),
    inactiveReason: text("inactive_reason"),
    /** Zen Planner-style rank/level; configurable list in settings. */
    level: text("level"),
    bodyMassKg: text("body_mass_kg"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("athletes_person_uq").on(t.personId), index("athletes_org_idx").on(t.orgId)],
);

export const households = pgTable("households", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  notes: text("notes"),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    role: text("role").$type<"guardian" | "child" | "adult">().notNull(),
    isPrimaryContact: boolean("is_primary_contact").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.personId] })],
);

/**
 * Guardian ↔ athlete relationship with explicit, independent permissions.
 * Multiple independent guardians per athlete are supported; one guardian's
 * permissions never imply another's.
 */
export const guardianships = pgTable(
  "guardianships",
  {
    id: id(),
    orgId: orgId(),
    guardianPersonId: uuid("guardian_person_id")
      .notNull()
      .references(() => people.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    relationship: text("relationship").notNull().default("parent"),
    canViewTraining: boolean("can_view_training").notNull().default(true),
    canViewHealth: boolean("can_view_health").notNull().default(false),
    canBook: boolean("can_book").notNull().default(true),
    canSignForms: boolean("can_sign_forms").notNull().default(true),
    canMessageStaff: boolean("can_message_staff").notNull().default(true),
    isEmergencyContact: boolean("is_emergency_contact").notNull().default(true),
    status: text("status").$type<"active" | "pending" | "revoked">().notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    uniqueIndex("guardianships_pair_uq")
      .on(t.guardianPersonId, t.athleteId)
      .where(sql`${t.status} <> 'revoked'`),
    index("guardianships_athlete_idx").on(t.athleteId),
  ],
);

/** Who pays. Distinct from household and guardian. */
export const payerAccounts = pgTable("payer_accounts", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  householdId: uuid("household_id").references(() => households.id),
  billingEmail: text("billing_email"),
  /** { stripeCustomerId, paypalPayerId } — provider references only, never card data. */
  providerRefs: jsonb("provider_refs").$type<Record<string, string>>().notNull().default({}),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

/** People allowed to act on a payer account. Payment access never implies health-data access. */
export const payerAuthorizations = pgTable(
  "payer_authorizations",
  {
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    canViewInvoices: boolean("can_view_invoices").notNull().default(true),
    canPay: boolean("can_pay").notNull().default(true),
    canManageMethods: boolean("can_manage_methods").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.payerAccountId, t.personId] })],
);

export const payerBeneficiaries = pgTable(
  "payer_beneficiaries",
  {
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
  },
  (t) => [primaryKey({ columns: [t.payerAccountId, t.athleteId] })],
);

// ---------------------------------------------------------------------------
// Staff, groups, assignment scope
// ---------------------------------------------------------------------------

export const groups = pgTable("groups", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<"team" | "program" | "training_group">().notNull().default("training_group"),
  sport: text("sport"),
  active: boolean("active").notNull().default(true),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.athleteId] })],
);

/** Coach scope: a coach may access athletes assigned directly or via a group. */
export const coachAssignments = pgTable(
  "coach_assignments",
  {
    id: id(),
    orgId: orgId(),
    coachUserId: uuid("coach_user_id")
      .notNull()
      .references(() => users.id),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    groupId: uuid("group_id").references(() => groups.id),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    createdAt: createdAt(),
  },
  (t) => [index("coach_assignments_coach_idx").on(t.coachUserId)],
);

// ---------------------------------------------------------------------------
// Notes, tags, custom fields, skills, alerts, tasks, audit
// ---------------------------------------------------------------------------

export type NoteVisibility = "staff" | "coaches_assigned" | "owner_only" | "sensitive";

export const notes = pgTable(
  "notes",
  {
    id: id(),
    orgId: orgId(),
    subjectPersonId: uuid("subject_person_id")
      .notNull()
      .references(() => people.id),
    authorUserId: uuid("author_user_id").references(() => users.id),
    body: text("body").notNull(),
    category: text("category").notNull().default("general"),
    visibility: text("visibility").$type<NoteVisibility>().notNull().default("staff"),
    createdAt: createdAt(),
  },
  (t) => [index("notes_subject_idx").on(t.subjectPersonId)],
);

export const tags = pgTable(
  "tags",
  { id: id(), orgId: orgId(), name: text("name").notNull(), color: text("color") },
  (t) => [uniqueIndex("tags_org_name_uq").on(t.orgId, t.name)],
);

export const personTags = pgTable(
  "person_tags",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.personId, t.tagId] })],
);

export type CustomFieldType = "text" | "number" | "date" | "select" | "boolean";
export type CustomFieldAppliesTo = "person" | "athlete" | "lead";
/** staff = staff only; family = also shown (read-only) to the person's guardians / the athlete. */
export type CustomFieldVisibility = "staff" | "family";

/** Org-defined fields; values live in people.custom_fields keyed by `key`. Key and type are fixed after creation. */
export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: id(),
    orgId: orgId(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").$type<CustomFieldType>().notNull(),
    options: jsonb("options").$type<string[]>(),
    appliesTo: text("applies_to").$type<CustomFieldAppliesTo>().notNull().default("person"),
    required: boolean("required").notNull().default(false),
    visibility: text("visibility").$type<CustomFieldVisibility>().notNull().default("staff"),
    showInList: boolean("show_in_list").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [uniqueIndex("custom_field_defs_org_key_uq").on(t.orgId, t.key)],
);

export const skillDefinitions = pgTable("skill_definitions", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  category: text("category").notNull().default("level"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const personSkills = pgTable("person_skills", {
  id: id(),
  athleteId: uuid("athlete_id")
    .notNull()
    .references(() => athletes.id),
  skillId: uuid("skill_id")
    .notNull()
    .references(() => skillDefinitions.id),
  awardedAt: ts("awarded_at").notNull().defaultNow(),
  awardedBy: uuid("awarded_by"),
});

/** Check-in alerts (e.g. "collect updated waiver"). Shown to staff and minimal-form at kiosk. */
export const alerts = pgTable("alerts", {
  id: id(),
  orgId: orgId(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  message: text("message").notNull(),
  level: text("level").$type<"info" | "warning" | "critical">().notNull().default("info"),
  showAtKiosk: boolean("show_at_kiosk").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    description: text("description"),
    dueAt: ts("due_at"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    relatedPersonId: uuid("related_person_id").references(() => people.id),
    relatedType: text("related_type"),
    relatedId: uuid("related_id"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    priority: text("priority").$type<"low" | "normal" | "high">().notNull().default("normal"),
    source: text("source").notNull().default("manual"),
    /** Prevents automation from creating the same task twice. */
    dedupeKey: text("dedupe_key"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
    completedBy: uuid("completed_by"),
    isDemo: isDemo(),
  },
  (t) => [
    index("tasks_assignee_idx").on(t.orgId, t.assigneeUserId, t.status),
    uniqueIndex("tasks_dedupe_uq").on(t.orgId, t.dedupeKey),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: uuid("org_id"),
    actorUserId: uuid("actor_user_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_org_time_idx").on(t.orgId, t.createdAt),
  ],
);
