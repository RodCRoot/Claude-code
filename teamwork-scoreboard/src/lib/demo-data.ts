import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Tables that hold sample records. Every row seeded by scripts/seed.ts carries
 * demo = 1; everything imported or entered for real carries demo = 0, so this
 * list can be cleared without touching live data. Configuration (users, roles,
 * settings, metric dictionary, templates, connectors) is deliberately absent —
 * those are real setup, not sample data.
 *
 * Shared by `npm run db:clear-demo` and the Admin → Remove demo data button so
 * the two can never diverge.
 */
export const DEMO_TABLES = [
  "sync_runs",
  "import_mappings",
  "kpi_values",
  "scorecard_entries",
  "scorecard_weeks",
  "report_comments",
  "reports_515",
  "tasks",
  "athlete_onboarding",
  "attendance",
  "outreach",
  "payments",
  "memberships",
  "appointments",
  "lead_activities",
  "leads",
  "class_sessions",
  "athletes",
  "campaigns",
  "marketing_items",
  "cancellations",
] as const;

export interface ClearDemoResult {
  total: number;
  perTable: { table: string; removed: number }[];
}

/** Delete every demo row. Returns what was removed, per table. */
export function clearDemoRows(): ClearDemoResult {
  const perTable: { table: string; removed: number }[] = [];
  let total = 0;
  for (const table of DEMO_TABLES) {
    const res = db.run(sql.raw(`DELETE FROM ${table} WHERE demo = 1`));
    const removed = Number(res.changes ?? 0);
    if (removed > 0) perTable.push({ table, removed });
    total += removed;
  }
  // Connectors whose only sync history was demo rows should not keep claiming
  // a last-sync time that no longer has a run behind it.
  db.run(sql`
    UPDATE connectors SET last_sync_at = NULL, last_sync_status = NULL
    WHERE id NOT IN (SELECT DISTINCT connector_id FROM sync_runs)
  `);
  return { total, perTable };
}

/** How many demo rows are still present (for showing a count before deleting). */
export function countDemoRows(): number {
  let total = 0;
  for (const table of DEMO_TABLES) {
    const row = db.get<{ n: number }>(
      sql.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE demo = 1`)
    );
    total += row?.n ?? 0;
  }
  return total;
}
