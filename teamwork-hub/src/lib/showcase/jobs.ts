import { db, type Tx } from "@/db";
import { organizations } from "@/db/schema";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";
import { runMonthlyRecaps } from "./recap";

/** payload: { orgId }. Finalizes last month's recaps once the grace period has passed. Idempotent. */
export const RECAP_MONTHLY_JOB = "recap.monthly";

/**
 * Called by the worker's housekeeping pass: one job per organization per facility-local day
 * (deduped), so the month closes on the first pass after the grace period whatever day that is.
 */
export async function enqueueRecapJobs(tx: Tx, now = new Date()): Promise<number> {
  const orgs = await tx.select({ id: organizations.id, tz: organizations.timezone }).from(organizations);
  let n = 0;
  for (const o of orgs) {
    const id = await enqueue(tx, { type: RECAP_MONTHLY_JOB, orgId: o.id, payload: { orgId: o.id }, dedupeKey: `${RECAP_MONTHLY_JOB}:${o.id}:${todayLocal(o.tz || DEFAULT_TZ, now)}` });
    if (id) n++;
  }
  return n;
}

export const recapJobHandlers: Record<string, JobHandler> = {
  [RECAP_MONTHLY_JOB]: async (payload, job) => {
    const orgId = (typeof payload.orgId === "string" && payload.orgId) || job.orgId;
    if (!orgId) throw new Error("payload.orgId is required");
    // Creates recap records and their in-app notice only. No external message is sent from here.
    return db.transaction((tx) => runMonthlyRecaps(tx, orgId));
  },
};
