/**
 * Adds any metrics from the catalog that aren't in the database yet, without
 * touching existing metrics (your edited goals and thresholds are safe) and
 * without reseeding demo data.
 *   npm run db:sync-metrics
 * Run this after upgrading the app when new metrics have been added.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { metrics } from "../src/db/schema";
import { METRIC_CATALOG } from "../src/lib/metric-catalog";

const now = new Date().toISOString();
let added = 0;

METRIC_CATALOG.forEach((m, i) => {
  const existing = db.select().from(metrics).where(eq(metrics.key, m.key)).get();
  if (existing) return;
  db.insert(metrics)
    .values({
      key: m.key,
      name: m.name,
      groupKey: m.groupKey,
      definition: m.definition,
      formula: m.formula,
      sourceSystem: m.sourceSystem,
      sourceFields: m.sourceFields ?? null,
      dataOwner: m.dataOwner,
      frequency: m.frequency,
      unit: m.unit,
      direction: m.direction,
      goal: m.goal,
      kind: m.kind,
      autoCompute: m.autoCompute ? 1 : 0,
      sensitive: m.sensitive ? 1 : 0,
      notes: m.notes ?? null,
      sortOrder: i,
      updatedAt: now,
    })
    .run();
  console.log(`  + ${m.key} (${m.name})`);
  added++;
});

console.log(
  added === 0
    ? "✔ All catalog metrics already present — nothing to add."
    : `✔ Added ${added} new metric(s). Existing metrics and goals untouched.`
);
