import Papa from "papaparse";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  leads,
  athletes,
  attendance,
  payments,
  kpiValues,
  metrics,
} from "@/db/schema";
import { eq } from "drizzle-orm";

/** Canonical import targets and their fields (used by the mapping wizard). */
export const IMPORT_TARGETS: Record<
  string,
  { label: string; fields: { key: string; label: string; required?: boolean }[] }
> = {
  leads: {
    label: "Leads",
    fields: [
      { key: "name", label: "Lead name", required: true },
      { key: "contact_name", label: "Parent/guardian name" },
      { key: "phone", label: "Phone" },
      { key: "email", label: "Email" },
      { key: "source", label: "Source (referral/website/paid_ads/…)" },
      { key: "stage", label: "Pipeline stage" },
      { key: "created_at", label: "Created date" },
      { key: "first_contacted_at", label: "First contacted date" },
      { key: "notes", label: "Notes" },
    ],
  },
  athletes: {
    label: "Athletes",
    fields: [
      { key: "name", label: "Athlete name", required: true },
      { key: "guardian_name", label: "Parent/guardian" },
      { key: "birth_year", label: "Birth year" },
      { key: "program", label: "Program" },
      { key: "start_date", label: "Start date", required: true },
      { key: "status", label: "Status (active/hold/canceled)" },
      { key: "lead_source", label: "Lead source" },
      { key: "expected_sessions_per_week", label: "Expected sessions/week" },
    ],
  },
  attendance: {
    label: "Attendance",
    fields: [
      { key: "athlete_name", label: "Athlete name", required: true },
      { key: "date", label: "Date", required: true },
      { key: "status", label: "Status (attended/no_show)" },
    ],
  },
  payments: {
    label: "Payments",
    fields: [
      { key: "athlete_name", label: "Athlete name" },
      { key: "date", label: "Date", required: true },
      { key: "amount", label: "Amount", required: true },
      { key: "category", label: "Category (membership/private_training/…)" },
      { key: "status", label: "Status (paid/failed/recovered/refunded)" },
      { key: "note", label: "Note" },
    ],
  },
  kpi_values: {
    label: "KPI values",
    fields: [
      { key: "metric_key", label: "Metric key (see Admin → Metrics)", required: true },
      { key: "period_start", label: "Period start", required: true },
      { key: "period_end", label: "Period end" },
      { key: "value", label: "Value", required: true },
      { key: "source_note", label: "Source note" },
    ],
  },
};

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  const headers = res.meta.fields ?? [];
  return { headers, rows: res.data };
}

/** Normalize a variety of date formats to YYYY-MM-DD (null if unparseable). */
export function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdY = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdY) {
    const [, m, d, y] = mdY;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function findAthleteId(name: string): number | null {
  const row = db.get<{ id: number }>(
    sql`SELECT id FROM athletes WHERE LOWER(name) = LOWER(${name.trim()}) LIMIT 1`
  );
  return row?.id ?? null;
}

export interface ImportOutcome {
  processed: number;
  rejected: number;
  /** Rows skipped because an identical record already exists (dedupe mode). */
  skipped: number;
  errors: string[];
}

/**
 * Commit mapped CSV rows into the target entity.
 * mapping: { csvColumn: canonicalField }
 * opts.dedupe: skip rows that already exist — required for scheduled pulls
 * (browser sync / re-imported reports) so nothing is ever double-counted.
 */
export function commitImport(
  target: string,
  parsed: ParsedCsv,
  mapping: Record<string, string>,
  enteredByUserId: number | null,
  opts: { dedupe?: boolean } = {}
): ImportOutcome {
  const dedupe = opts.dedupe === true;
  const errors: string[] = [];
  let processed = 0;
  let rejected = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();
  const exists = (q: ReturnType<typeof sql>) => db.get<{ one: number }>(q) !== undefined;

  const get = (row: Record<string, string>, field: string): string => {
    for (const [col, f] of Object.entries(mapping)) {
      if (f === field) return (row[col] ?? "").trim();
    }
    return "";
  };

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const fail = (why: string) => {
      rejected++;
      if (errors.length < 20) errors.push(`Row ${i + 2}: ${why}`);
    };
    try {
      if (target === "leads") {
        const name = get(row, "name");
        if (!name) {
          fail("missing lead name");
          continue;
        }
        const createdDate = normalizeDate(get(row, "created_at"));
        if (
          dedupe &&
          exists(
            createdDate
              ? sql`SELECT 1 AS one FROM leads WHERE LOWER(name) = LOWER(${name})
                    AND substr(created_at, 1, 10) = ${createdDate} LIMIT 1`
              : sql`SELECT 1 AS one FROM leads WHERE LOWER(name) = LOWER(${name}) LIMIT 1`
          )
        ) {
          skipped++;
          continue;
        }
        db.insert(leads)
          .values({
            name,
            contactName: get(row, "contact_name") || null,
            phone: get(row, "phone") || null,
            email: get(row, "email") || null,
            source: get(row, "source").toLowerCase() || "other",
            stage: get(row, "stage").toLowerCase() || "new",
            createdAt: normalizeDate(get(row, "created_at")) ?? nowIso,
            firstContactedAt: normalizeDate(get(row, "first_contacted_at")),
            notes: get(row, "notes") || null,
          })
          .run();
        processed++;
      } else if (target === "athletes") {
        const name = get(row, "name");
        const startDate = normalizeDate(get(row, "start_date"));
        if (!name || !startDate) {
          fail("missing athlete name or start date");
          continue;
        }
        if (
          dedupe &&
          exists(sql`SELECT 1 AS one FROM athletes WHERE LOWER(name) = LOWER(${name}) LIMIT 1`)
        ) {
          skipped++;
          continue;
        }
        const by = parseInt(get(row, "birth_year"), 10);
        const exp = parseInt(get(row, "expected_sessions_per_week"), 10);
        db.insert(athletes)
          .values({
            name,
            guardianName: get(row, "guardian_name") || null,
            birthYear: Number.isFinite(by) ? by : null,
            program: get(row, "program") || null,
            startDate,
            status: get(row, "status").toLowerCase() || "active",
            leadSource: get(row, "lead_source") || null,
            expectedSessionsPerWeek: Number.isFinite(exp) ? exp : 2,
          })
          .run();
        processed++;
      } else if (target === "attendance") {
        const athleteName = get(row, "athlete_name");
        const date = normalizeDate(get(row, "date"));
        if (!athleteName || !date) {
          fail("missing athlete name or date");
          continue;
        }
        const athleteId = findAthleteId(athleteName);
        if (!athleteId) {
          fail(`athlete "${athleteName}" not found`);
          continue;
        }
        const status = get(row, "status").toLowerCase() === "no_show" ? "no_show" : "attended";
        if (
          dedupe &&
          exists(sql`SELECT 1 AS one FROM attendance
                     WHERE athlete_id = ${athleteId} AND date = ${date} AND status = ${status} LIMIT 1`)
        ) {
          skipped++;
          continue;
        }
        db.insert(attendance).values({ athleteId, date, status }).run();
        processed++;
      } else if (target === "payments") {
        const date = normalizeDate(get(row, "date"));
        const amount = parseFloat(get(row, "amount").replace(/[$,]/g, ""));
        if (!date || !Number.isFinite(amount)) {
          fail("missing/invalid date or amount");
          continue;
        }
        const athleteName = get(row, "athlete_name");
        const athleteId = athleteName ? findAthleteId(athleteName) : null;
        const payStatus = get(row, "status").toLowerCase() || "paid";
        if (
          dedupe &&
          exists(sql`SELECT 1 AS one FROM payments
                     WHERE date = ${date} AND amount = ${amount} AND status = ${payStatus}
                       AND (athlete_id = ${athleteId} OR (athlete_id IS NULL AND ${athleteId} IS NULL))
                     LIMIT 1`)
        ) {
          skipped++;
          continue;
        }
        db.insert(payments)
          .values({
            athleteId,
            date,
            amount,
            category: get(row, "category").toLowerCase() || "membership",
            status: payStatus,
            note: get(row, "note") || null,
          })
          .run();
        processed++;
      } else if (target === "kpi_values") {
        const key = get(row, "metric_key");
        const periodStart = normalizeDate(get(row, "period_start"));
        const value = parseFloat(get(row, "value").replace(/[$,%]/g, ""));
        if (!key || !periodStart || !Number.isFinite(value)) {
          fail("missing metric_key, period_start, or value");
          continue;
        }
        const metric = db.select().from(metrics).where(eq(metrics.key, key)).get();
        if (!metric) {
          fail(`unknown metric key "${key}"`);
          continue;
        }
        if (dedupe) {
          // Upsert per (metric, period, source=import): repeated pulls refresh
          // the value instead of stacking rows that would double-count in sums.
          const existing = db.get<{ id: number; value: number }>(
            sql`SELECT id, value FROM kpi_values
                WHERE metric_id = ${metric.id} AND period_start = ${periodStart}
                  AND source = 'import' LIMIT 1`
          );
          if (existing) {
            if (existing.value === value) {
              skipped++;
            } else {
              db.update(kpiValues)
                .set({ value, createdAt: nowIso })
                .where(eq(kpiValues.id, existing.id))
                .run();
              processed++;
            }
            continue;
          }
        }
        db.insert(kpiValues)
          .values({
            metricId: metric.id,
            periodStart,
            periodEnd: normalizeDate(get(row, "period_end")) ?? periodStart,
            value,
            source: "import",
            enteredByUserId,
            sourceNote: get(row, "source_note") || "CSV import",
            createdAt: nowIso,
          })
          .run();
        processed++;
      } else {
        fail(`unknown target "${target}"`);
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : "unknown error");
    }
  }
  return { processed, rejected, skipped, errors };
}
