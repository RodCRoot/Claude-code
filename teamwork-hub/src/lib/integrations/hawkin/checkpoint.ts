import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { importBatches, integrations, syncRuns } from "@/db/schema";

export const SYNC_TO_OPTION = "$option.syncTo";
export const SYNC_MODE_OPTION = "$option.syncMode";
export const SYNC_RUN_OPTION = "$option.syncRunId";

export async function hawkinIntegration(tx: Tx, orgId: string) {
  const [row] = await tx.select().from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "hawkin")));
  if (row) return row;
  const [created] = await tx.insert(integrations).values({ orgId, provider: "hawkin", status: "not_configured" }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await tx.select().from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "hawkin")));
  return again;
}

/**
 * Called inside the commit transaction of a hawkin_api batch. The incremental checkpoint only
 * moves forward after the data it covers has been committed, so a failed or unreviewed batch is
 * re-fetched next time instead of being skipped.
 */
export async function advanceHawkinCheckpoint(tx: Tx, orgId: string, batch: typeof importBatches.$inferSelect) {
  const syncTo = batch.mapping[SYNC_TO_OPTION];
  const mode = batch.mapping[SYNC_MODE_OPTION];
  const integ = await hawkinIntegration(tx, orgId);
  const cp = { ...(integ.checkpoint ?? {}) } as Record<string, unknown>;
  if (syncTo && mode === "incremental") {
    const n = Number(syncTo);
    if (!cp.lastSyncTime || Number(cp.lastSyncTime) < n) cp.lastSyncTime = n;
  }
  if (syncTo && mode === "historical") {
    const n = Number(syncTo);
    if (!cp.historicalThrough || Number(cp.historicalThrough) < n) cp.historicalThrough = n;
  }
  cp.lastCommittedBatchId = batch.id;
  await tx.update(integrations).set({ checkpoint: cp }).where(eq(integrations.id, integ.id));
  const runId = batch.mapping[SYNC_RUN_OPTION];
  if (runId) {
    await tx
      .update(syncRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        cursorAfter: sql`coalesce(${syncRuns.cursorAfter}, '{}'::jsonb) || ${JSON.stringify({ ...cp, committedBatchId: batch.id })}::jsonb`,
      })
      .where(and(eq(syncRuns.id, runId), eq(syncRuns.orgId, orgId)));
  }
}
