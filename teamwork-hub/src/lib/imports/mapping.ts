import { cleanCell, metricCell, typeField } from "./normalize";
import type { FieldValue, ImportSchemaDef, MetricCell, NormalizeCtx, NormalizedRow } from "./types";

export const OPTION_PREFIX = "$option.";

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** Suggest a target-field → header mapping from header names and schema aliases. */
export function autoMap(schema: ImportSchemaDef, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of schema.fields) {
    const aliases = [f.key, f.label, ...(f.aliases ?? [])].map(norm);
    // Exact alias match first (in alias priority order), never re-using a header.
    let hit: string | undefined;
    for (const a of aliases) {
      hit = headers.find((h) => !used.has(h) && norm(h) === a);
      if (hit) break;
    }
    if (hit) {
      out[f.key] = hit;
      used.add(hit);
    }
  }
  return out;
}

export function fieldMapping(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).filter(([k, v]) => !k.startsWith(OPTION_PREFIX) && v));
}

export function mappingOptions(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).filter(([k]) => k.startsWith(OPTION_PREFIX)).map(([k, v]) => [k.slice(OPTION_PREFIX.length), v]));
}

/** Headers treated as vendor metric columns: unmapped, shaped like "Label (unit)". */
export function metricHeaders(schema: ImportSchemaDef, headers: string[], mapping: Record<string, string>): { metrics: string[]; ignored: string[] } {
  const mapped = new Set(Object.values(fieldMapping(mapping)));
  const metrics: string[] = [];
  const ignored: string[] = [];
  for (const h of headers) {
    if (mapped.has(h) || h.startsWith("_")) continue;
    if (schema.dynamicMetrics && metricCell(h, null)) metrics.push(h);
    else ignored.push(h);
  }
  return { metrics, ignored };
}

export function missingRequired(schema: ImportSchemaDef, mapping: Record<string, string>): string[] {
  const m = fieldMapping(mapping);
  const missing = schema.fields.filter((f) => f.required && !m[f.key]).map((f) => f.label);
  // Person-bearing schemas need some way to identify the person.
  const hasPerson = schema.fields.some((f) => f.key === "full_name");
  if (hasPerson && !m.source_person_id && !m.full_name && !(m.first_name && m.last_name)) {
    missing.push("Person: source ID, full name, or first + last name");
  }
  return missing;
}

/** Map + type a raw row, then hand it to the schema normalizer. */
export function normalizeRow(schema: ImportSchemaDef, raw: Record<string, string | null>, mapping: Record<string, string>, ctx: NormalizeCtx, metricCols: string[]): NormalizedRow {
  const m = fieldMapping(mapping);
  const fields: Record<string, FieldValue> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const def of schema.fields) {
    const header = m[def.key];
    const cell = header ? cleanCell(raw[header]) : null;
    const t = typeField(def, cell, ctx.tz);
    fields[def.key] = t.value;
    if (t.error) errors.push(t.error);
    if (t.warning) warnings.push(t.warning);
    if (def.required && cell === null && header) errors.push(`${def.label} is empty.`);
  }
  const metrics: MetricCell[] = metricCols.map((h) => metricCell(h, raw[h])).filter((x): x is MetricCell => !!x);
  const r = schema.normalize(fields, raw, ctx, metrics);
  r.errors.unshift(...errors);
  r.warnings.unshift(...warnings);
  return r;
}
