/**
 * Removes all demo/sample records (rows with demo = 1) while keeping real
 * configuration: users, roles, settings, metric dictionary, task templates,
 * onboarding steps, scorecard templates, and connectors.
 *   npm run db:clear-demo
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

const DEMO_TABLES = [
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
];

let total = 0;
for (const table of DEMO_TABLES) {
  const res = db.run(sql.raw(`DELETE FROM ${table} WHERE demo = 1`));
  const n = Number(res.changes ?? 0);
  if (n > 0) console.log(`  ${table}: removed ${n}`);
  total += n;
}

// Reset connector last-sync markers that pointed at demo runs
db.run(sql`
  UPDATE connectors SET last_sync_at = NULL, last_sync_status = NULL
  WHERE id NOT IN (SELECT DISTINCT connector_id FROM sync_runs)
`);

// Demo users (none seeded with demo=1 by default, but honor the flag)
db.run(sql`DELETE FROM users WHERE demo = 1`);

console.log(`✔ Removed ${total} demo records. Configuration (users, metrics, templates, settings) kept.`);
console.log("  Tip: turn off the demo label in Admin → Demo mode.");
