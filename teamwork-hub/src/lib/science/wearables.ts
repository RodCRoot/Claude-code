import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, externalIds, importBatches, people, wearableObservations } from "@/db/schema";
import { assertCan, canOnAthlete, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { saveObject, sha256Bytes } from "@/lib/storage";
import { addDaysYmd } from "@/lib/time";
import { actorOf } from "./access";
import { isNum, mean } from "./formulas";
import { WEARABLE_METRICS } from "./wearables/provider";

/** Unit aliases accepted on import, normalized to the canonical unit with an explicit factor. */
const UNIT_ALIASES: Record<string, Record<string, number>> = {
  h: { h: 1, hr: 1, hrs: 1, hours: 1, min: 1 / 60, minutes: 1 / 60 },
  ms: { ms: 1 },
  bpm: { bpm: 1, "beats/min": 1 },
};

export function normalizeWearableValue(metricKey: string, value: number, unit: string): { value: number; unit: string } | null {
  const def = WEARABLE_METRICS[metricKey];
  if (!def) return null;
  const f = UNIT_ALIASES[def.unit]?.[unit.trim().toLowerCase()];
  return f === undefined ? null : { value: value * f, unit: def.unit };
}

export const mappingSchema = z.object({
  date: z.string().min(1),
  athlete: z.string().min(1),
  athleteMatch: z.enum(["email", "external_id"]),
  metric: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().min(1),
});
export type ColumnMapping = z.infer<typeof mappingSchema>;

export type ParsedRow = { row: number; raw: Record<string, string>; errors: string[]; athleteId?: string; metricKey?: string; date?: string; value?: number | null; unit?: string; quality?: "measured" | "missing" };

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Import a wearable CSV. Staff-only (science.manage) and every row is re-checked against
 * health.write for its athlete. Rows are idempotent per (provider, athlete, metric, date).
 * The original file is stored for provenance; each observation records its import batch.
 */
export async function importWearableCsv(tx: Tx, v: Viewer, input: { csvText: string; filename: string; provider: string; mapping: ColumnMapping; dryRun?: boolean }) {
  assertCan(v, "science.manage");
  const mapping = mappingSchema.parse(input.mapping);
  const provider = input.provider.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30) || "csv";
  const { headers, rows } = parseCsv(input.csvText);
  if (!rows.length) throw new UserError("The file has no data rows.");
  for (const col of [mapping.date, mapping.athlete, mapping.metric, mapping.value, mapping.unit]) {
    if (!headers.includes(col)) throw new UserError(`Column "${col}" isn't in the file. Found: ${headers.join(", ")}`);
  }
  if (rows.length > 5000) throw new UserError("Max 5,000 rows per import.");

  // Resolve athletes by email (person record) or external id registry — never by name.
  const refs = [...new Set(rows.map((r) => (r[mapping.athlete] ?? "").trim()).filter(Boolean))];
  const refToAthlete = new Map<string, string>();
  if (mapping.athleteMatch === "email") {
    const found = await tx
      .select({ id: athletes.id, email: people.email })
      .from(athletes)
      .innerJoin(people, eq(people.id, athletes.personId))
      .where(and(eq(athletes.orgId, v.orgId), inArray(sql`lower(${people.email})`, refs.map((r) => r.toLowerCase()))));
    const counts = new Map<string, number>();
    for (const f of found) counts.set(f.email!.toLowerCase(), (counts.get(f.email!.toLowerCase()) ?? 0) + 1);
    for (const f of found) if (counts.get(f.email!.toLowerCase()) === 1) refToAthlete.set(f.email!.toLowerCase(), f.id);
  } else {
    const found = await tx
      .select()
      .from(externalIds)
      .where(and(eq(externalIds.orgId, v.orgId), eq(externalIds.source, provider), eq(externalIds.localEntityType, "athlete"), inArray(externalIds.sourceId, refs)));
    for (const f of found) refToAthlete.set(f.sourceId.toLowerCase(), f.localId);
  }

  const parsed: ParsedRow[] = [];
  const allowedCache = new Map<string, boolean>();
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const p: ParsedRow = { row: i + 2, raw, errors: [] };
    const ref = (raw[mapping.athlete] ?? "").trim().toLowerCase();
    const athleteId = refToAthlete.get(ref);
    if (!athleteId) p.errors.push(`No unique athlete matches "${raw[mapping.athlete] ?? ""}"`);
    else {
      if (!allowedCache.has(athleteId)) allowedCache.set(athleteId, await canOnAthlete(tx, v, athleteId, "health.write"));
      if (!allowedCache.get(athleteId)) p.errors.push("You don't have health access for this athlete");
      else p.athleteId = athleteId;
    }
    const date = (raw[mapping.date] ?? "").trim().slice(0, 10);
    if (!dateRe.test(date)) p.errors.push(`Date "${raw[mapping.date] ?? ""}" must be YYYY-MM-DD`);
    else p.date = date;
    const metric = (raw[mapping.metric] ?? "").trim().toLowerCase();
    if (!WEARABLE_METRICS[metric]) p.errors.push(`Unknown metric "${metric}" (expected ${Object.keys(WEARABLE_METRICS).join(", ")})`);
    else p.metricKey = metric;
    const valueStr = (raw[mapping.value] ?? "").trim();
    const unit = (raw[mapping.unit] ?? "").trim();
    if (valueStr === "") {
      p.value = null;
      p.quality = "missing";
      p.unit = p.metricKey ? WEARABLE_METRICS[p.metricKey].unit : unit;
    } else {
      const n = Number(valueStr);
      if (!Number.isFinite(n)) p.errors.push(`Value "${valueStr}" is not a number`);
      else if (p.metricKey) {
        const norm = normalizeWearableValue(p.metricKey, n, unit);
        if (!norm) p.errors.push(`Unit "${unit}" can't be converted to ${WEARABLE_METRICS[p.metricKey].unit}`);
        else {
          p.value = norm.value;
          p.unit = norm.unit;
          p.quality = "measured";
        }
      }
    }
    parsed.push(p);
  }
  const valid = parsed.filter((p) => !p.errors.length);
  if (input.dryRun) return { batchId: null, total: parsed.length, valid: valid.length, inserted: 0, duplicates: 0, rows: parsed };

  const bytes = new TextEncoder().encode(input.csvText);
  const obj = await saveObject(tx, { orgId: v.orgId, bytes, filename: input.filename || "wearables.csv", mimeType: "text/csv", kind: "import_source", accessLevel: "staff", uploadedBy: v.userId });
  const dates = valid.map((p) => p.date!).sort();
  const [batch] = await tx
    .insert(importBatches)
    .values({
      orgId: v.orgId,
      source: "wearable_csv",
      entityType: "wearable_observation",
      status: "committed",
      objectId: obj.id,
      originalFilename: input.filename,
      checksum: sha256Bytes(bytes),
      mapping: { ...mapping, provider },
      coverageStart: dates[0] ?? null,
      coverageEnd: dates.at(-1) ?? null,
      createdBy: v.userId,
      committedAt: new Date(),
      committedBy: v.userId,
    })
    .returning();
  let inserted = 0;
  for (const p of valid) {
    const res = await tx
      .insert(wearableObservations)
      .values({ orgId: v.orgId, athleteId: p.athleteId!, provider, metricKey: p.metricKey!, observedOn: p.date!, value: p.value ?? null, unit: p.unit!, quality: p.quality!, sourceRecordId: `${p.date}:${p.metricKey}`, importBatchId: batch.id })
      .onConflictDoNothing()
      .returning({ id: wearableObservations.id });
    inserted += res.length;
  }
  const stats = { total: parsed.length, valid: valid.length, inserted, duplicates: valid.length - inserted, invalid: parsed.length - valid.length };
  await tx.update(importBatches).set({ stats }).where(eq(importBatches.id, batch.id));
  await audit(tx, actorOf(v), "science.wearables.import", "import_batch", batch.id, { summary: `Wearable CSV "${input.filename}": ${inserted} new, ${stats.duplicates} duplicate, ${stats.invalid} invalid`, after: stats });
  return { batchId: batch.id, ...stats, rows: parsed };
}

export const manualObservationInput = z.object({
  athleteId: z.string().uuid(),
  metricKey: z.enum(Object.keys(WEARABLE_METRICS) as [string, ...string[]]),
  observedOn: z.string().regex(dateRe),
  value: z.coerce.number().min(0).max(100000),
  quality: z.enum(["measured", "device_estimate"]),
});

export async function addManualObservation(tx: Tx, v: Viewer, raw: z.input<typeof manualObservationInput>) {
  const input = manualObservationInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "health.write");
  const unit = WEARABLE_METRICS[input.metricKey].unit;
  const [row] = await tx
    .insert(wearableObservations)
    .values({ orgId: v.orgId, athleteId: input.athleteId, provider: "manual", metricKey: input.metricKey, observedOn: input.observedOn, value: input.value, unit, quality: input.quality, sourceRecordId: `${input.observedOn}:${input.metricKey}` })
    .onConflictDoUpdate({ target: [wearableObservations.provider, wearableObservations.athleteId, wearableObservations.metricKey, wearableObservations.sourceRecordId], set: { value: input.value, quality: input.quality } })
    .returning();
  await audit(tx, actorOf(v), "science.wearables.manual", "wearable_observation", row.id, { summary: `Manual ${input.metricKey} for ${input.observedOn}` });
  return row;
}

export type WearableDay = { date: string; value: number | null; quality: "measured" | "missing" | "device_estimate" | "no_data"; provider: string | null; importBatchId: string | null };

/** Dense per-metric daily series. Days with no observation are explicit "no_data" (never 0 or carried forward). */
export async function wearableDashboard(tx: Tx, v: Viewer, athleteId: string, from: string, to: string) {
  await requireOnAthlete(tx, v, athleteId, "health.read");
  const rows = await tx
    .select()
    .from(wearableObservations)
    .where(and(eq(wearableObservations.orgId, v.orgId), eq(wearableObservations.athleteId, athleteId), gte(wearableObservations.observedOn, from), lte(wearableObservations.observedOn, to)))
    .orderBy(asc(wearableObservations.observedOn));
  const batchIds = [...new Set(rows.map((r) => r.importBatchId).filter((x): x is string => !!x))];
  const batches = batchIds.length ? await tx.select().from(importBatches).where(inArray(importBatches.id, batchIds)) : [];
  const metrics = Object.entries(WEARABLE_METRICS).map(([key, def]) => {
    const mine = rows.filter((r) => r.metricKey === key);
    const days: WearableDay[] = [];
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
      // Prefer a measured value over a device estimate if several providers reported the same day.
      const candidates = mine.filter((r) => r.observedOn === d);
      const pick = candidates.find((c) => c.quality === "measured" && isNum(c.value)) ?? candidates.find((c) => isNum(c.value)) ?? candidates[0];
      days.push(pick ? { date: d, value: pick.value, quality: pick.quality, provider: pick.provider, importBatchId: pick.importBatchId } : { date: d, value: null, quality: "no_data", provider: null, importBatchId: null });
    }
    const vals = days.map((x) => x.value);
    return {
      key,
      ...def,
      days,
      mean: mean(vals),
      daysWithValue: vals.filter(isNum).length,
      daysMissing: days.filter((x) => x.quality === "missing").length,
      daysNoData: days.filter((x) => x.quality === "no_data").length,
      providers: [...new Set(mine.map((r) => r.provider))],
    };
  });
  return { metrics, batches };
}
