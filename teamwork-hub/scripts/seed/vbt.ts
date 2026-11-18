import { randomUUID } from "node:crypto";
import { importBatches, vbtReadings } from "../../src/db/schema";
import { addDaysYmd, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic bar-speed (velocity) readings so the demo shows the "Estimated max from bar speed"
 * card, the live %1RM line in the logger and relative strength. Every number is invented: each
 * lift follows a made-up straight load-velocity line with a little scatter. No device was used.
 */
const SAMPLE: { athlete: string; lift: string; sets: [loadKg: number, speeds: number[]][] }[] = [
  // Back Squat: line reaches the 0.30 m/s threshold near 112 kg.
  { athlete: "maya", lift: "Back Squat", sets: [[60, [0.81, 0.79]], [80, [0.61, 0.6]], [95, [0.47]]] },
  // Bench Press: line reaches the 0.17 m/s threshold near 74 kg.
  { athlete: "maya", lift: "Bench Press", sets: [[40, [0.63, 0.61]], [52.5, [0.46]], [62.5, [0.32]]] },
];

export async function seedVbt(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const ex = ctx.extra.exercises ?? {};
  const batchId = randomUUID();
  const rows: (typeof vbtReadings.$inferInsert)[] = [];
  for (const s of SAMPLE) {
    const athleteId = ctx.athletes[s.athlete];
    const exerciseId = ex[s.lift];
    if (!athleteId || !exerciseId) continue;
    s.sets.forEach(([loadKg, speeds], si) =>
      speeds.forEach((v, ri) =>
        rows.push({
          orgId,
          athleteId,
          exerciseId,
          performedAt: localToUtc(addDaysYmd(today, si === 2 ? -2 : -9), `16:${String(10 + si * 6 + ri).padStart(2, "0")}`),
          load: String(loadKg),
          loadUnit: "kg",
          repNumber: ri + 1,
          meanVelocityMs: v,
          device: "Sample bar-speed sensor (synthetic)",
          importBatchId: batchId,
          sourceRecordId: `seed-vbt:${orgId}:${s.athlete}:${s.lift}:${si}:${ri}`,
        }),
      ),
    );
  }
  if (!rows.length) return;
  await tx.insert(importBatches).values({
    id: batchId,
    orgId,
    source: "generic_csv",
    entityType: "vbt_readings",
    status: "committed",
    originalFilename: "sample-bar-speed.csv",
    stats: { rows: rows.length, imported: rows.length },
    limitations: "Synthetic demo data. No device connectivity; no real athlete was measured.",
    committedAt: new Date(),
  });
  await tx.insert(vbtReadings).values(rows);
}
