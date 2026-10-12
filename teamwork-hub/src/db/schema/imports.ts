import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./_common";
import { people } from "./core";
import { storedObjects } from "./documents";

export type ImportSource = "zenplanner" | "teambuildr" | "hawkin_file" | "hawkin_api" | "generic_csv" | "generic_json" | "wearable_csv";
export type ImportStatus = "uploaded" | "mapped" | "validated" | "committed" | "reverted" | "failed";

export const importBatches = pgTable("import_batches", {
  id: id(),
  orgId: orgId(),
  source: text("source").$type<ImportSource>().notNull(),
  entityType: text("entity_type").notNull(),
  status: text("status").$type<ImportStatus>().notNull().default("uploaded"),
  objectId: uuid("object_id").references(() => storedObjects.id),
  originalFilename: text("original_filename"),
  checksum: text("checksum"),
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull().default({}),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  /** Explicit historical coverage. */
  coverageStart: date("coverage_start"),
  coverageEnd: date("coverage_end"),
  limitations: text("limitations"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  committedAt: ts("committed_at"),
  committedBy: uuid("committed_by"),
  revertedAt: ts("reverted_at"),
  revertedBy: uuid("reverted_by"),
});

export type ImportRowStatus = "pending" | "valid" | "invalid" | "duplicate" | "needs_review" | "ready" | "committed" | "skipped" | "reverted";

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>(),
    status: text("status").$type<ImportRowStatus>().notNull().default("pending"),
    errors: jsonb("errors").$type<string[]>().notNull().default([]),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    sourceRecordId: text("source_record_id"),
    matchPersonId: uuid("match_person_id").references(() => people.id),
    matchConfidence: text("match_confidence").$type<"exact_source_id" | "strong" | "ambiguous" | "none">(),
    matchCandidates: jsonb("match_candidates").$type<{ personId: string; reason: string }[]>(),
    /** Staff decision for ambiguous rows. */
    resolution: text("resolution").$type<"link" | "create_new" | "skip">(),
    resolvedBy: uuid("resolved_by"),
    createdEntities: jsonb("created_entities").$type<{ type: string; id: string }[]>().notNull().default([]),
  },
  (t) => [index("import_rows_batch_idx").on(t.batchId, t.status)],
);

/** Source identity registry: re-imports find existing records here, so they never duplicate. */
export const externalIds = pgTable(
  "external_ids",
  {
    id: id(),
    orgId: orgId(),
    source: text("source").notNull(),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceId: text("source_id").notNull(),
    localEntityType: text("local_entity_type").notNull(),
    localId: uuid("local_id").notNull(),
    firstImportBatchId: uuid("first_import_batch_id"),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_ids_uq").on(t.orgId, t.source, t.sourceEntityType, t.sourceId),
    index("external_ids_local_idx").on(t.localEntityType, t.localId),
  ],
);

export type IntegrationProvider =
  | "stripe"
  | "paypal"
  | "venmo"
  | "hawkin"
  | "google_calendar"
  | "email"
  | "sms"
  | "teambuildr"
  | "zenplanner"
  | "object_storage";

export type IntegrationStatus = "not_configured" | "configured_unverified" | "verified_sandbox" | "connected" | "error" | "disabled";

/** Non-secret integration state. Secrets live only in environment variables. */
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    orgId: orgId(),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    status: text("status").$type<IntegrationStatus>().notNull().default("not_configured"),
    mode: text("mode").$type<"sandbox" | "live" | "test" | "none">().notNull().default("none"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Sync checkpoint (e.g. Hawkin last "syncFrom" timestamp). */
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().notNull().default({}),
    lastCheckedAt: ts("last_checked_at"),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("integrations_uq").on(t.orgId, t.provider)],
);

export const syncRuns = pgTable("sync_runs", {
  id: id(),
  orgId: orgId(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  status: text("status").$type<"running" | "succeeded" | "partial" | "failed">().notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  cursorBefore: jsonb("cursor_before"),
  cursorAfter: jsonb("cursor_after"),
  error: text("error"),
  importBatchId: uuid("import_batch_id"),
});
