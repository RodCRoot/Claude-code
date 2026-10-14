import { asDT, asText, localDateOf, splitName, syntheticId, zonedLocalToInstant } from "../normalize";
import type { FieldValue, ImportSchemaDef, MetricCell, NormalizeCtx, NormalizedRow } from "../types";
import { emptyRow } from "./common";

const FIELDS: ImportSchemaDef["fields"] = [
  { key: "athlete_id", label: "Hawkin athlete ID", type: "text", aliases: ["athlete id", "athlete_id", "athleteid", "external id", "id code"] },
  { key: "athlete_name", label: "Athlete name", type: "text", required: true, aliases: ["athlete", "name", "athlete name", "athlete_name"] },
  { key: "athlete_active", label: "Athlete active", type: "boolean", aliases: ["athlete active", "athlete_active"] },
  { key: "test_id", label: "Test ID", type: "text", aliases: ["test id", "test_id", "testid"] },
  { key: "test_type", label: "Test type", type: "text", required: true, aliases: ["test type", "test_type", "type", "test", "movement", "test type name"] },
  { key: "test_type_id", label: "Test type ID", type: "text", aliases: ["test type id", "test_type_id", "testtypeid"] },
  { key: "tested_at", label: "Timestamp (date + time)", type: "datetime", aliases: ["timestamp", "date/time", "datetime", "test time", "tested at"], hint: "Unix seconds (API) or a date-time; offsets are kept verbatim." },
  { key: "date", label: "Date (if separate)", type: "date", aliases: ["date", "test date"] },
  { key: "time", label: "Time (if separate)", type: "time", aliases: ["time"] },
  { key: "trial", label: "Trial # / row type", type: "text", aliases: ["trial", "trial #", "trial number", "rep", "row type", "segment"], hint: "Rows whose value says Average/Avg/Mean are stored as vendor aggregates, not trials." },
  { key: "active", label: "Test active", type: "boolean", aliases: ["active", "test active"] },
];

/** Shared normalizer for Hawkin Cloud CSV rows and flattened Hawkin API tests. */
function normalizeHawkin(f: Record<string, FieldValue>, raw: Record<string, string | null>, ctx: NormalizeCtx, metrics: MetricCell[]): NormalizedRow {
  const r = emptyRow();
  const name = asText(f.athlete_name);
  const athleteId = asText(f.athlete_id);
  const { first, last } = splitName(name);
  if (!first || !last) r.errors.push("Athlete name must include first and last name.");
  r.identity = {
    // Hawkin Cloud CSV exports carry only the athlete name. A staff-confirmed name is recorded as an alias.
    sourceEntityType: athleteId ? "athlete" : "athlete_name",
    sourceId: athleteId ?? (name ? name.trim().toLowerCase().replace(/\s+/g, " ") : null),
    firstName: first,
    lastName: last,
    needsAthlete: true,
  };

  let tested = asDT(f.tested_at);
  const date = asText(f.date);
  const time = asText(f.time);
  if (!tested && date) {
    const z = zonedLocalToInstant(date, time ?? "00:00:00", ctx.tz);
    if (z.warning) r.warnings.push(z.warning);
    tested = { iso: z.date.toISOString(), raw: [date, time].filter(Boolean).join(" "), offset: null, assumedTz: ctx.tz };
  }
  if (!tested) r.errors.push("Test date/time is required.");
  else {
    if (tested.assumedTz && !/^\d{10}/.test(tested.raw)) r.warnings.push(`No UTC offset in "${tested.raw}"; read as ${ctx.tz} local time.`);
    r.dates.push(localDateOf(tested, ctx.tz));
  }

  const trialText = asText(f.trial);
  const isAggregate = !!trialText && /avg|average|mean/i.test(trialText);
  // "3", "Trial 3", or the API segment "Countermovement Jump:3".
  const tm = trialText ? /(\d+)\s*$/.exec(trialText) : null;
  const trialNumber = tm ? Number(tm[1]) : null;
  const testType = asText(f.test_type);
  const athleteActive = f.athlete_active === null || f.athlete_active === undefined ? null : Boolean(f.athlete_active);
  const testActive = f.active === null || f.active === undefined ? true : Boolean(f.active);
  if (athleteActive === false) r.warnings.push("Athlete is inactive in Hawkin; kept and flagged.");
  if (!testActive) r.warnings.push("Test is inactive (hidden/deleted) in Hawkin; kept and flagged.");
  if (!metrics.length) r.warnings.push("No metric columns found (expected headers like 'Jump Height(m)').");
  const nulls = metrics.filter((m) => m.raw === null).length;
  if (nulls) r.warnings.push(`${nulls} metric(s) empty/N/A — stored as null, not 0.`);
  const unparsable = metrics.filter((m) => m.raw !== null && m.value === null);
  for (const m of unparsable) r.errors.push(`Metric "${m.header}" value "${m.raw}" is not numeric.`);

  const day = tested ? localDateOf(tested, ctx.tz) : null;
  const athleteKey = athleteId ?? name?.toLowerCase();
  const testId = asText(f.test_id);
  const sessionKey = isAggregate
    ? `avg:${syntheticId(ctx.orgId, "hk-avg", athleteKey, testType?.toLowerCase(), day)}`
    : (testId ?? syntheticId(ctx.orgId, "hk-test", athleteKey, testType?.toLowerCase(), tested?.raw, trialText));
  r.sourceRecordId = sessionKey;
  r.data = {
    athleteName: name,
    athleteSourceId: athleteId,
    athleteActive,
    testType,
    testTypeId: asText(f.test_type_id),
    testedAt: tested?.iso ?? null,
    sourceTimestamp: tested?.raw ?? null,
    isAggregate,
    trialNumber,
    trialText,
    active: testActive,
    metrics,
    payload: raw._payload ? safeJson(raw._payload) : null,
  };
  return r;
}

function safeJson(s: string | null) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const HAWKIN_LIMITS =
  "Hawkin vendor metrics are stored exactly as exported (vendor-defined, units from the column header) and are never relabeled as Teamwork results. Vendor averages are stored as aggregate rows, not as extra trials. Raw force-time curves are not in the CSV export (single-test export or API only).";

export const hawkinCsv: ImportSchemaDef = {
  id: "hawkin.tests_csv",
  source: "hawkin_file",
  idSource: "hawkin",
  label: "Hawkin Dynamics — Cloud export (tests / averages)",
  description:
    "CSV from Hawkin Cloud export (Tests, Averages, or Averages and Tests). Each test becomes a test session with one trial; average rows become vendor aggregate rows. Metric columns are detected from headers like 'Jump Height(m)'.",
  evidence: "unverified — configurable",
  recordEntityType: "test",
  allowCreatePerson: true,
  dynamicMetrics: true,
  limitations:
    HAWKIN_LIMITS +
    " The Cloud export is identified by athlete name only (unless you include an ID column); every name needs one staff confirmation, after which it is remembered as a Hawkin alias. Without a Test ID column, re-exports are de-duplicated by athlete + test type + timestamp, so overlap with API-synced tests cannot be detected.",
  fields: FIELDS,
  normalize: normalizeHawkin,
};

export const hawkinApi: ImportSchemaDef = {
  ...hawkinCsv,
  id: "hawkin.api_tests",
  source: "hawkin_api",
  label: "Hawkin Dynamics — API sync",
  description: "Tests fetched from the Hawkin Cloud API (GET /api/v1). Created by the Hawkin sync, not uploaded.",
  evidence: "vendor docs",
  internal: true,
  limitations: HAWKIN_LIMITS.replace("Raw force-time curves are not in the CSV export (single-test export or API only).", "Raw force-time curves are fetched only when enabled (GET /api/v1/forcetime/{id}, 1000 Hz)."),
};
