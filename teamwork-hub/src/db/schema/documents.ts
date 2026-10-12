import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts } from "./_common";
import { athletes, people, users } from "./core";

/** Files in object storage. Access is always checked server-side before streaming. */
export const storedObjects = pgTable(
  "stored_objects",
  {
    id: id(),
    orgId: orgId(),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    kind: text("kind")
      .$type<"completed_form_pdf" | "imported_archive" | "import_source" | "raw_signal" | "upload" | "export">()
      .notNull(),
    ownerPersonId: uuid("owner_person_id").references(() => people.id),
    accessLevel: text("access_level").$type<"staff" | "owner_only" | "subject_and_guardians">().notNull().default("staff"),
    uploadedBy: uuid("uploaded_by"),
    createdAt: createdAt(),
  },
  (t) => [index("stored_objects_owner_idx").on(t.ownerPersonId)],
);

export const formTemplates = pgTable("form_templates", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<"waiver" | "agreement" | "intake" | "medical" | "media_release" | "policy">().notNull(),
  /** Months until a completed form must be renewed; null = never. */
  renewalMonths: integer("renewal_months"),
  requiredForBooking: boolean("required_for_booking").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "date" | "checkbox" | "select" | "phone" | "email";
  required: boolean;
  options?: string[];
};

export type SignerRequirement = {
  role: "guardian" | "second_guardian" | "adult_athlete" | "athlete_assent" | "staff_witness";
  required: boolean;
};

/** Published versions are immutable; edits create a new version (and new signing records). */
export const formTemplateVersions = pgTable(
  "form_template_versions",
  {
    id: id(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplates.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    fields: jsonb("fields").$type<FormField[]>().notNull().default([]),
    signers: jsonb("signers").$type<SignerRequirement[]>().notNull(),
    /** SHA-256 of title+body+fields+signers — part of every signature's evidence. */
    contentHash: text("content_hash").notNull(),
    /** Sample language must be labeled until replaced by approved Teamwork text. */
    isSampleText: boolean("is_sample_text").notNull().default(true),
    status: text("status").$type<"draft" | "published" | "retired">().notNull().default("draft"),
    publishedAt: ts("published_at"),
    publishedBy: uuid("published_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("form_versions_uq").on(t.templateId, t.version)],
);

export type FormRequestStatus = "pending" | "partially_signed" | "completed" | "expired" | "superseded" | "voided";

export const formRequests = pgTable(
  "form_requests",
  {
    id: id(),
    orgId: orgId(),
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => formTemplateVersions.id),
    subjectPersonId: uuid("subject_person_id")
      .notNull()
      .references(() => people.id),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    status: text("status").$type<FormRequestStatus>().notNull().default("pending"),
    requestedBy: uuid("requested_by"),
    dueDate: date("due_date"),
    expiresAt: ts("expires_at"),
    completedAt: ts("completed_at"),
    supersededById: uuid("superseded_by_id"),
    /** Data submitted by the first signer (fields), frozen at completion. */
    submittedData: jsonb("submitted_data").$type<Record<string, unknown>>(),
    completedPdfObjectId: uuid("completed_pdf_object_id").references(() => storedObjects.id),
    /** SHA-256 over version hash + submitted data + all signature evidence. */
    integrityHash: text("integrity_hash"),
    lastReminderAt: ts("last_reminder_at"),
    reminderCount: integer("reminder_count").notNull().default(0),
    source: text("source").$type<"teamwork" | "imported_archive">().notNull().default("teamwork"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [index("form_requests_subject_idx").on(t.subjectPersonId, t.status)],
);

export const signatures = pgTable(
  "signatures",
  {
    id: id(),
    formRequestId: uuid("form_request_id")
      .notNull()
      .references(() => formRequests.id),
    signerRole: text("signer_role").notNull(),
    signerPersonId: uuid("signer_person_id")
      .notNull()
      .references(() => people.id),
    signerUserId: uuid("signer_user_id").references(() => users.id),
    relationship: text("relationship"),
    typedName: text("typed_name").notNull(),
    /** Exact e-sign consent statement shown to the signer. */
    consentText: text("consent_text").notNull(),
    consentGiven: boolean("consent_given").notNull(),
    templateContentHash: text("template_content_hash").notNull(),
    dataHash: text("data_hash").notNull(),
    authMethod: text("auth_method").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    signedAt: ts("signed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("signatures_role_uq").on(t.formRequestId, t.signerRole)],
);

export type StepUpChallengeStatus =
  /** Code delivered (or redirected to a test recipient); awaiting entry. */
  | "pending"
  /** Correct code entered; may be consumed by exactly one signature before it expires. */
  | "verified"
  /** Used by a signature (`signature_id`). */
  | "consumed"
  /** Too many wrong attempts. */
  | "locked"
  /** Replaced by a newer code for the same signer. */
  | "superseded"
  /** Email could not be sent (not configured / provider failure): never usable. */
  | "undeliverable";

/**
 * One-time codes for signer identity step-up. Only an HMAC of the code is stored.
 * Bound to (request, signer person, requesting user); a code is usable for one signature.
 */
export const signerStepUpChallenges = pgTable(
  "signer_step_up_challenges",
  {
    id: id(),
    orgId: orgId(),
    formRequestId: uuid("form_request_id")
      .notNull()
      .references(() => formRequests.id),
    signerPersonId: uuid("signer_person_id")
      .notNull()
      .references(() => people.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    signerRole: text("signer_role").notNull(),
    channel: text("channel").$type<"email">().notNull().default("email"),
    /** The address on file the code was sent to (before any test redirect). */
    address: text("address").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    status: text("status").$type<StepUpChallengeStatus>().notNull().default("pending"),
    /** Messaging adapter result: sent | test_redirected | not_configured | failed. */
    deliveryStatus: text("delivery_status"),
    deliveryReason: text("delivery_reason"),
    providerMessageId: text("provider_message_id"),
    verifiedAt: ts("verified_at"),
    consumedAt: ts("consumed_at"),
    signatureId: uuid("signature_id").references(() => signatures.id),
    createdAt: createdAt(),
  },
  (t) => [index("step_up_signer_idx").on(t.formRequestId, t.signerPersonId, t.createdAt)],
);

export const formAuditEvents = pgTable("form_audit_events", {
  id: id(),
  formRequestId: uuid("form_request_id")
    .notNull()
    .references(() => formRequests.id),
  event: text("event").notNull(),
  actorUserId: uuid("actor_user_id"),
  details: jsonb("details"),
  createdAt: createdAt(),
});

/** Historical signed documents imported as original archives — signatures are never recreated. */
export const archivedDocuments = pgTable("archived_documents", {
  id: id(),
  orgId: orgId(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  objectId: uuid("object_id")
    .notNull()
    .references(() => storedObjects.id),
  title: text("title").notNull(),
  originalSystem: text("original_system").notNull(),
  originalSignedAt: ts("original_signed_at"),
  originalEvidence: jsonb("original_evidence"),
  importBatchId: uuid("import_batch_id"),
  createdAt: createdAt(),
});
