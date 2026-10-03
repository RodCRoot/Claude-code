/**
 * Removes all demo/sample records (rows with demo = 1) while keeping real
 * configuration: users, roles, settings, metric dictionary, task templates,
 * onboarding steps, scorecard templates, and connectors.
 *   npm run db:clear-demo
 *
 * The same operation is available without a terminal at
 * Admin → Demo mode → Remove demo data.
 */
import { clearDemoRows } from "../src/lib/demo-data";

const { total, perTable } = clearDemoRows();
for (const { table, removed } of perTable) {
  console.log(`  ${table}: removed ${removed}`);
}

console.log(`✔ Removed ${total} demo records. Configuration (users, metrics, templates, settings) kept.`);
console.log("  Tip: turn off the demo label in Admin → Demo mode.");
