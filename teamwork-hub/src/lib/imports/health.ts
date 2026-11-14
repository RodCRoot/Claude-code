import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { importBatches, integrations, syncRuns } from "@/db/schema";
import { can, type Viewer } from "@/lib/authz/policy";

export type ImportHealth = {
  batchesAwaitingReview: number;
  rowsAwaitingReview: number;
  validatedNotCommitted: number;
  lastCommittedAt: Date | null;
  hawkin: { status: string; configured: boolean; lastRunAt: Date | null; lastRunStatus: string | null; lastError: string | null };
  href: string;
};

/**
 * Compact import/integration health for the staff dashboard (Today / Settings).
 * Returns null for viewers without imports.manage so callers can render nothing.
 */
export async function importHealthSummary(tx: Tx, v: Viewer): Promise<ImportHealth | null> {
  if (!can(v, "imports.manage")) return null;
  const [agg] = await tx
    .select({
      awaiting: sql<number>`count(*) filter (where ${importBatches.status} = 'validated' and coalesce((${importBatches.stats}->>'needs_review')::int, 0) > 0)::int`,
      rows: sql<number>`coalesce(sum(case when ${importBatches.status} = 'validated' then coalesce((${importBatches.stats}->>'needs_review')::int, 0) else 0 end), 0)::int`,
      pending: sql<number>`count(*) filter (where ${importBatches.status} in ('uploaded','mapped','validated'))::int`,
      lastCommitted: sql<Date | null>`max(${importBatches.committedAt})`,
    })
    .from(importBatches)
    .where(eq(importBatches.orgId, v.orgId));
  const [integ] = await tx.select().from(integrations).where(and(eq(integrations.orgId, v.orgId), eq(integrations.provider, "hawkin")));
  const [run] = await tx
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.orgId, v.orgId), eq(syncRuns.provider, "hawkin")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return {
    batchesAwaitingReview: agg?.awaiting ?? 0,
    rowsAwaitingReview: agg?.rows ?? 0,
    validatedNotCommitted: agg?.pending ?? 0,
    lastCommittedAt: agg?.lastCommitted ? new Date(agg.lastCommitted) : null,
    hawkin: {
      status: integ?.status ?? "not_configured",
      configured: !!process.env.HAWKIN_REFRESH_TOKEN,
      lastRunAt: run?.startedAt ?? null,
      lastRunStatus: run?.status ?? null,
      lastError: integ?.lastError ?? null,
    },
    href: "/imports",
  };
}
