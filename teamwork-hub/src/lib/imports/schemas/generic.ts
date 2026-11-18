import { asDT, asNum, asText, canonicalUnit, decimalsOf, localDateOf, slug, syntheticId } from "../normalize";
import type { FieldValue, ImportSchemaDef } from "../types";
import { emptyRow, identityFrom, personFields, resolveName } from "./common";

const key = (f: Record<string, FieldValue>) => asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.email) ?? ""}`.toLowerCase();

export const genericPeople: ImportSchemaDef = {
  id: "generic.people",
  source: "generic_csv",
  idSource: "generic",
  label: "Generic — People",
  description: "Any CSV/JSON list of people. Creates people (and athlete records when marked) or links to existing people.",
  evidence: "unverified — configurable",
  recordEntityType: "person",
  allowCreatePerson: true,
  limitations: "Generic files have no vendor identity; supply a stable external ID column so re-imports link instead of asking again. Existing people are never overwritten — only empty fields are filled.",
  fields: [
    ...personFields(),
    { key: "phone", label: "Phone", type: "text", aliases: ["phone", "mobile", "cell"] },
    { key: "is_athlete", label: "Is athlete", type: "boolean", aliases: ["is athlete", "athlete?", "athlete"] },
    { key: "sport", label: "Sport", type: "text", aliases: ["sport"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const isAthlete = f.is_athlete === null || f.is_athlete === undefined ? true : Boolean(f.is_athlete);
    r.identity = identityFrom(f, ctx, { sourceEntityType: "person", needsAthlete: isAthlete }, r.errors);
    const { first, last } = resolveName(f);
    r.data = { firstName: first, lastName: last, dob: asText(f.dob), email: asText(f.email), phone: asText(f.phone), status: null, isAthlete, sport: asText(f.sport) };
    r.sourceRecordId = asText(f.source_person_id) ?? syntheticId(ctx.orgId, "gen-person", key(f), asText(f.dob));
    return r;
  },
};

export const genericMetricValues: ImportSchemaDef = {
  id: "generic.metric_values",
  source: "generic_csv",
  idSource: "generic",
  label: "Generic — Metric values",
  description: "Long-format measurements (athlete, metric, value, unit, time). Stored as single metric values from 'other vendor' with the source text preserved.",
  evidence: "unverified — configurable",
  recordEntityType: "metric_value",
  allowCreatePerson: false,
  limitations: "Metrics are created as vendor ('other_vendor') definitions keyed by name + unit; they are never relabeled as Teamwork-derived results. Values are not converted between units.",
  fields: [
    ...personFields(),
    { key: "record_id", label: "Record ID", type: "text", aliases: ["record id", "measurement id", "row id"] },
    { key: "metric", label: "Metric", type: "text", required: true, aliases: ["metric", "metric name", "measure", "test", "variable"] },
    { key: "value", label: "Value", type: "number", aliases: ["value", "result", "score"] },
    { key: "unit", label: "Unit", type: "text", required: true, aliases: ["unit", "units"] },
    { key: "recorded_at", label: "Recorded at", type: "datetime", required: true, aliases: ["recorded at", "date", "timestamp", "measured at", "time"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "person", needsAthlete: true }, r.errors);
    const v = asNum(f.value);
    const unitRaw = asText(f.unit);
    const unit = canonicalUnit(unitRaw) ?? unitRaw;
    if (unitRaw && !canonicalUnit(unitRaw)) r.warnings.push(`Unit "${unitRaw}" not recognized; kept as written.`);
    const at = asDT(f.recorded_at);
    if (!v) r.warnings.push("Value is empty — stored as null (missing), not 0.");
    const metric = asText(f.metric);
    r.data = {
      metricName: metric,
      metricKey: metric && unit ? `${slug(metric)}__${slug(unit)}` : null,
      value: v?.value ?? null,
      rawValue: v?.raw ?? null,
      decimals: v ? decimalsOf(v.raw) : null,
      unit,
      recordedAt: at?.iso ?? null,
      sourceTimestamp: at?.raw ?? null,
    };
    if (at) r.dates.push(localDateOf(at, ctx.tz));
    r.sourceRecordId = asText(f.record_id) ?? syntheticId(ctx.orgId, "gen-metric", key(f), metric?.toLowerCase(), unit, at?.raw);
    return r;
  },
};

export const wearableDaily: ImportSchemaDef = {
  id: "wearable.daily_csv",
  source: "wearable_csv",
  // Person IDs in generic/wearable files share one staff-defined namespace.
  idSource: "generic",
  label: "Wearable — Daily summary CSV",
  description: "Long-format daily wearable values (athlete, provider, date, metric, value, unit). Empty values are stored as explicitly missing.",
  evidence: "unverified — configurable",
  recordEntityType: "wearable_observation",
  allowCreatePerson: false,
  limitations: "No wearable vendor connection is claimed — this reads files exported by the athlete or vendor. Device estimates are not distinguished unless the file says so.",
  fields: [
    ...personFields(),
    { key: "provider", label: "Provider / device", type: "text", required: true, aliases: ["provider", "device", "source", "vendor"] },
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "day", "summary date"] },
    { key: "metric", label: "Metric", type: "text", required: true, aliases: ["metric", "metric key", "measure", "type"] },
    { key: "value", label: "Value", type: "number", aliases: ["value", "result"] },
    { key: "unit", label: "Unit", type: "text", required: true, aliases: ["unit", "units"] },
    { key: "quality", label: "Quality", type: "text", aliases: ["quality", "estimate", "is estimate"] },
    { key: "record_id", label: "Record ID", type: "text", aliases: ["record id", "id"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "person", needsAthlete: true }, r.errors);
    const v = asNum(f.value);
    const unitRaw = asText(f.unit);
    const q = (asText(f.quality) ?? "").toLowerCase();
    const provider = asText(f.provider)?.toLowerCase() ?? null;
    r.data = {
      provider,
      date: asText(f.date),
      metricKey: asText(f.metric) ? slug(asText(f.metric)!) : null,
      value: v?.value ?? null,
      rawValue: v?.raw ?? null,
      unit: canonicalUnit(unitRaw) ?? unitRaw,
      quality: !v ? "missing" : /estim/.test(q) ? "device_estimate" : "measured",
    };
    if (!v) r.warnings.push("Value is empty — stored with quality 'missing', not 0.");
    if (asText(f.date)) r.dates.push(asText(f.date)!);
    r.sourceRecordId = asText(f.record_id) ?? syntheticId(ctx.orgId, "wear", key(f), provider, asText(f.date), asText(f.metric)?.toLowerCase());
    return r;
  },
};
