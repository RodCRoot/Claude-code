import { and, eq, inArray } from "drizzle-orm";
import Papa from "papaparse";
import type { Tx } from "@/db";
import { importRows, maxes, metricDefinitions, metricValues } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { getBatch } from "./batches";
import type { MetricCell } from "./types";

export type Reconciliation = Awaited<ReturnType<typeof reconcile>>;

/** File rows vs what was committed/linked/skipped/rejected, with value-level spot checks. */
export async function reconcile(tx: Tx, v: Viewer, batchId: string, sampleSize = 25) {
  const b = await getBatch(tx, v, batchId);
  const rows = await tx.select().from(importRows).where(eq(importRows.batchId, b.id)).orderBy(importRows.rowNumber);
  const byStatus: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const createdByType: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const n = (r.normalized ?? {}) as Record<string, unknown>;
    const res = (n._result as string) ?? (r.status === "invalid" ? "reject" : r.status === "duplicate" ? "duplicate" : r.status === "skipped" ? "skip" : null);
    if (res) byResult[res] = (byResult[res] ?? 0) + 1;
    for (const c of r.createdEntities) createdByType[c.type] = (createdByType[c.type] ?? 0) + 1;
  }

  // Per athlete × test type (or per athlete × exercise / metric) file rows vs stored.
  const groups = new Map<string, { athlete: string; item: string; fileRows: number; committed: number; skipped: number; rejected: number }>();
  for (const r of rows) {
    const n = (r.normalized ?? {}) as Record<string, unknown>;
    const ident = n._identity as { firstName?: string; lastName?: string } | undefined;
    const athlete = (n.athleteName as string) ?? (ident ? `${ident.firstName ?? ""} ${ident.lastName ?? ""}`.trim() : null) ?? `(row ${r.rowNumber})`;
    const item = (n.testType as string) ?? (n.exercise as string) ?? (n.metricName as string) ?? (n.metricKey as string) ?? (n.plan as string) ?? (n.className as string) ?? (n.questionnaire as string) ?? b.entityType;
    const k = `${athlete}|${item}`;
    const g = groups.get(k) ?? { athlete, item, fileRows: 0, committed: 0, skipped: 0, rejected: 0 };
    g.fileRows++;
    if (r.status === "committed") g.committed++;
    else if (r.status === "invalid") g.rejected++;
    else g.skipped++;
    groups.set(k, g);
  }

  // Value spot checks: source raw text vs stored value (precision, units, nulls).
  const samples: { rowNumber: number; field: string; sourceRaw: string | null; storedRaw: string | null; storedValue: number | string | null; sourceUnit: string | null; storedUnit: string | null; ok: boolean }[] = [];
  const checks = { sourceNulls: 0, storedNulls: 0, precisionMismatches: 0, unitMismatches: 0, nullCoercedToZero: 0, compared: 0 };
  const committed = rows.filter((r) => r.status === "committed" || (r.status === "skipped" && (r.normalized as Record<string, unknown>)?._existingLocalId));
  if (b.entityType.startsWith("hawkin.") || b.entityType === "generic.metric_values") {
    const ids = committed.map((r) => r.sourceRecordId!).filter(Boolean);
    const stored = ids.length
      ? await tx
          .select({ sourceRecordId: metricValues.sourceRecordId, key: metricDefinitions.key, raw: metricValues.rawValue, value: metricValues.value, unit: metricValues.unit, aggregation: metricValues.aggregation })
          .from(metricValues)
          .innerJoin(metricDefinitions, eq(metricDefinitions.id, metricValues.metricDefinitionId))
          .where(and(eq(metricValues.orgId, v.orgId), inArray(metricValues.sourceRecordId, ids)))
      : [];
    const idx = new Map(stored.map((s) => [`${s.sourceRecordId}|${s.key}`, s]));
    for (const r of committed) {
      const n = r.normalized as Record<string, unknown>;
      const cells: { key: string; header: string; raw: string | null; unit: string }[] = b.entityType === "generic.metric_values"
        ? [{ key: String(n.metricKey), header: String(n.metricName), raw: (n.rawValue as string) ?? null, unit: String(n.unit) }]
        : ((n.metrics as MetricCell[]) ?? []).map((m) => ({ key: m.key, header: m.header, raw: m.raw, unit: m.unit }));
      for (const c of cells) {
        const s = idx.get(`${r.sourceRecordId}|${c.key}`);
        if (!s) continue;
        checks.compared++;
        if (c.raw === null) checks.sourceNulls++;
        if (s.value === null) checks.storedNulls++;
        if (c.raw === null && s.value === 0) checks.nullCoercedToZero++;
        const precisionOk = c.raw === s.raw;
        const unitOk = c.unit === s.unit;
        if (!precisionOk) checks.precisionMismatches++;
        if (!unitOk) checks.unitMismatches++;
        if (samples.length < sampleSize || !precisionOk || !unitOk)
          samples.push({ rowNumber: r.rowNumber, field: c.header, sourceRaw: c.raw, storedRaw: s.raw, storedValue: s.value, sourceUnit: c.unit, storedUnit: s.unit, ok: precisionOk && unitOk });
      }
    }
  } else if (b.entityType === "teambuildr.maxes") {
    const ids = committed.map((r) => r.sourceRecordId!).filter(Boolean);
    const stored = ids.length ? await tx.select().from(maxes).where(and(eq(maxes.orgId, v.orgId), inArray(maxes.sourceRecordId, ids))) : [];
    const idx = new Map(stored.map((s) => [s.sourceRecordId, s]));
    for (const r of committed) {
      const n = r.normalized as Record<string, unknown>;
      const s = idx.get(r.sourceRecordId);
      if (!s) continue;
      checks.compared++;
      const valueOk = Number(String(n.rawValue).replace(/,/g, "")) === Number(s.value);
      const unitOk = n.unit === s.unit;
      if (!valueOk) checks.precisionMismatches++;
      if (!unitOk) checks.unitMismatches++;
      if (samples.length < sampleSize || !valueOk || !unitOk)
        samples.push({ rowNumber: r.rowNumber, field: String(n.exercise), sourceRaw: (n.rawValue as string) ?? null, storedRaw: s.value, storedValue: s.value, sourceUnit: (n.unit as string) ?? null, storedUnit: s.unit, ok: valueOk && unitOk });
    }
  }

  const duplicates = rows.filter((r) => r.status === "duplicate").map((r) => ({ rowNumber: r.rowNumber, note: r.warnings.join("; ") }));
  return {
    batch: b,
    fileRows: Number(b.stats.fileRows ?? rows.length),
    importRows: rows.length,
    byStatus,
    byResult,
    createdByType,
    groups: [...groups.values()].sort((a, c) => a.athlete.localeCompare(c.athlete) || a.item.localeCompare(c.item)),
    samples,
    checks,
    duplicates,
    coverage: { start: b.coverageStart, end: b.coverageEnd, confirmed: !!b.stats.coverageConfirmed },
    balanced: rows.length === Number(b.stats.fileRows ?? rows.length),
  };
}

/** CSV of rejected (invalid) and duplicate rows, with reasons and the original columns. */
export async function rejectedRowsCsv(tx: Tx, v: Viewer, batchId: string): Promise<string> {
  const b = await getBatch(tx, v, batchId);
  const rows = await tx
    .select()
    .from(importRows)
    .where(and(eq(importRows.batchId, b.id), inArray(importRows.status, ["invalid", "duplicate"])))
    .orderBy(importRows.rowNumber);
  const headers = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.raw)) if (!k.startsWith("_")) headers.add(k);
  const data = rows.map((r) => {
    const o: Record<string, unknown> = { row_number: r.rowNumber, status: r.status, errors: r.errors.join(" | "), warnings: r.warnings.join(" | ") };
    for (const h of headers) o[h] = r.raw[h] ?? "";
    return o;
  });
  return Papa.unparse({ fields: ["row_number", "status", "errors", "warnings", ...headers], data: data.map((d) => Object.values(d)) as unknown[][] });
}
