import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { jobs } from "@/db/schema";

/**
 * Durable job queue / outbox in Postgres.
 * - enqueue() inside the same transaction as the business change (transactional outbox)
 * - dedupeKey makes enqueue idempotent
 * - workers claim with FOR UPDATE SKIP LOCKED; failures back off exponentially
 */
export async function enqueue(
  tx: Tx,
  job: { type: string; payload: Record<string, unknown>; orgId?: string | null; dedupeKey?: string; runAt?: Date; maxAttempts?: number },
) {
  const rows = await tx
    .insert(jobs)
    .values({
      type: job.type,
      payload: job.payload,
      orgId: job.orgId ?? null,
      dedupeKey: job.dedupeKey ?? null,
      runAt: job.runAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export type JobHandler = (payload: Record<string, unknown>, job: typeof jobs.$inferSelect) => Promise<unknown>;

export async function claimJobs(tx: Tx, workerId: string, limit = 10) {
  const res = await tx.execute(sql`
    update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    where id in (
      select id from jobs where status = 'pending' and run_at <= now()
      order by run_at limit ${limit} for update skip locked
    )
    returning id`);
  const ids = res.rows.map((r) => (r as { id: string }).id);
  if (!ids.length) return [];
  return tx.select().from(jobs).where(sql`${jobs.id} in ${ids}`);
}

export function backoffMs(attempts: number) {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export async function runJobs(tx: Tx, handlers: Record<string, JobHandler>, workerId = `worker-${process.pid}`, limit = 10) {
  const claimed = await claimJobs(tx, workerId, limit);
  const results: { id: string; type: string; status: string; error?: string }[] = [];
  for (const job of claimed) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      const result = await handler(job.payload, job);
      await tx
        .update(jobs)
        .set({ status: "done", result: (result ?? null) as never, finishedAt: new Date(), lockedAt: null })
        .where(eq(jobs.id, job.id));
      results.push({ id: job.id, type: job.type, status: "done" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const dead = job.attempts >= job.maxAttempts;
      await tx
        .update(jobs)
        .set({
          status: dead ? "dead" : "pending",
          lastError: msg.slice(0, 2000),
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lockedAt: null,
        })
        .where(and(eq(jobs.id, job.id)));
      results.push({ id: job.id, type: job.type, status: dead ? "dead" : "retry", error: msg });
    }
  }
  return results;
}
