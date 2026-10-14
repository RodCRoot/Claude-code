import type { ImportSource } from "@/db/schema";

/**
 * Import schema registry types. A schema describes one kind of source file
 * (e.g. a Zen Planner member list): its target fields, which are required,
 * how values are typed, and header aliases used for auto-mapping.
 */

export type FieldType = "text" | "date" | "datetime" | "time" | "number" | "integer" | "email" | "boolean" | "unit";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Lower-cased header aliases for auto-mapping. The label and key are always aliases too. */
  aliases?: string[];
  hint?: string;
};

/** How well a source-field mapping is known. */
export type Evidence = "existing Teamwork integration" | "vendor docs" | "unverified — configurable";

/** Parsed datetime: the instant plus the verbatim source text. */
export type ParsedDateTime = {
  /** UTC ISO instant. */
  iso: string;
  /** Exactly what the source said (offsets/timezones preserved). */
  raw: string;
  /** Offset in the source, e.g. "-04:00"; null when the source had none. */
  offset: string | null;
  /** Set when no offset was given and the facility timezone was assumed. */
  assumedTz?: string;
};

/** Number with the source text kept so precision is never lost. */
export type ParsedNumber = { value: number; raw: string };

export type FieldValue = string | number | boolean | ParsedDateTime | ParsedNumber | null;

/** Who a row is about, used for identity matching. */
export type IdentityInput = {
  /** external_ids.source_entity_type for the person (e.g. "member", "athlete"). */
  sourceEntityType: string;
  sourceId?: string | null;
  firstName: string | null;
  lastName: string | null;
  dob?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Adult rows (e.g. guardians) may match on exact email + exact name. */
  adult?: boolean;
  /** Should the matched person be an athlete (attendance, tests, maxes …)? */
  needsAthlete: boolean;
};

export type MetricCell = {
  /** Vendor label exactly as the header said, e.g. "Jump Height(m)". */
  header: string;
  label: string;
  key: string;
  unit: string;
  raw: string | null;
  value: number | null;
  /** Decimal places in the source text (precision check). */
  decimals: number | null;
};

export type NormalizedRow = {
  data: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  /** Stable id of this source record (vendor id or a deterministic synthetic id). */
  sourceRecordId: string | null;
  identity: IdentityInput | null;
  /** Calendar dates (YYYY-MM-DD) the row covers, for the coverage range. */
  dates: string[];
};

export type NormalizeCtx = { orgId: string; tz: string; options: Record<string, string> };

export type ImportSchemaDef = {
  id: string;
  source: ImportSource;
  /** external_ids.source used for identity and records. */
  idSource: string;
  label: string;
  description: string;
  evidence: Evidence;
  /** external_ids.source_entity_type of the records this schema creates. */
  recordEntityType: string;
  fields: FieldDef[];
  /** Any unmapped header shaped like "Label (unit)" is a vendor metric column. */
  dynamicMetrics?: boolean;
  /** May unmatched people be created as new records? */
  allowCreatePerson: boolean;
  /** Human-readable limitations shown on preview and stored on the batch. */
  limitations: string;
  /** Batch-level options shown on the mapping step (stored in the batch mapping as "$option.<key>"). */
  options?: { key: string; label: string; choices: { value: string; label: string }[]; hint?: string }[];
  /** Not offered in the upload wizard (e.g. API-fed schemas). */
  internal?: boolean;
  normalize(fields: Record<string, FieldValue>, raw: Record<string, string | null>, ctx: NormalizeCtx, metrics: MetricCell[]): NormalizedRow;
  /** Optional: one source line → several import rows (e.g. a GHL contact naming several siblings). */
  split?(row: NormalizedRow): NormalizedRow[];
};

export type RowAction = "create" | "link" | "update" | "skip" | "reject";
