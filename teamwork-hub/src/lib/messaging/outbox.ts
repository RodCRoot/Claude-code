import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { jobs, messageDeliveries, type JobStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "./errors";

export type OutboxFilter = "attention" | "pending" | "done" | "all";

/** Jobs for this org (plus org-less system jobs) for the Outbox admin tab. */
export async function listOutbox(tx: Tx, v: Viewer, filter: OutboxFilter = "attention") {
  assertCan(v, "settings.manage");
  const statuses: JobStatus[] | null =
    filter === "attention" ? ["dead", "failed"] : filter === "pending" ? ["pending", "running"] : filter === "done" ? ["done", "cancelled"] : null;
  const orgCond = sql`(${jobs.orgId} = ${v.orgId} or ${jobs.orgId} is null)`;
  const rows = await tx
    .select()
    .from(jobs)
    .where(statuses ? and(orgCond, inArray(jobs.status, statuses)) : orgCond)
    .orderBy(desc(jobs.createdAt))
    .limit(200);
  const counts = await tx
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(orgCond)
    .groupBy(jobs.status);
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Partial<Record<JobStatus, number>> };
}

/**
 * Manually retry a dead/failed job: back to pending, attempts reset so it gets a fresh
 * backoff budget. A failed delivery row is re-queued too so the handler will attempt it.
 */
export async function retryJob(tx: Tx, v: Viewer, jobId: string, now = new Date()) {
  assertCan(v, "settings.manage");
  const [j] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), sql`(${jobs.orgId} = ${v.orgId} or ${jobs.orgId} is null)`))
    .for("update");
  if (!j) throw new DomainError("Job not found.");
  if (!["dead", "failed", "cancelled"].includes(j.status)) throw new DomainError(`Only dead, failed or cancelled jobs can be retried (this one is ${j.status}).`);
  await tx.update(jobs).set({ status: "pending", attempts: 0, runAt: now, lockedAt: null, lockedBy: null, finishedAt: null }).where(eq(jobs.id, j.id));
  if (j.type === "messaging.deliver" && typeof j.payload.deliveryId === "string") {
    await tx
      .update(messageDeliveries)
      .set({ status: "queued", statusReason: "Manually retried from Outbox", updatedAt: now })
      .where(and(eq(messageDeliveries.id, j.payload.deliveryId), eq(messageDeliveries.status, "failed")));
  }
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "jobs.retried", "job", j.id, {
    summary: `Retried ${j.type}`,
    before: { status: j.status, attempts: j.attempts, lastError: j.lastError },
  });
}

export async function cancelJob(tx: Tx, v: Viewer, jobId: string) {
  assertCan(v, "settings.manage");
  const [j] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), sql`(${jobs.orgId} = ${v.orgId} or ${jobs.orgId} is null)`))
    .for("update");
  if (!j) throw new DomainError("Job not found.");
  if (!["pending", "dead", "failed"].includes(j.status)) throw new DomainError(`Cannot cancel a ${j.status} job.`);
  await tx.update(jobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(jobs.id, j.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "jobs.cancelled", "job", j.id, { summary: `Cancelled ${j.type}` });
}
