import { db, type DB } from "@/db";
import type { JobHandler } from "@/lib/jobs";
import { todayLocal } from "@/lib/time";
import { generateRenewals, RENEWAL_JOB } from "./renewals";
import { processStoredEvent, REPROCESS_JOB } from "./webhooks";

/**
 * Job handlers owned by billing. Register these in the worker (scripts/worker.ts):
 *   import { billingJobHandlers } from "@/lib/billing/jobs";  runJobs(tx, { ...billingJobHandlers() })
 */
export function billingJobHandlers(database: DB = db): Record<string, JobHandler> {
  return {
    [RENEWAL_JOB]: async (payload) => {
      const orgId = String(payload.orgId);
      const today = typeof payload.today === "string" ? payload.today : todayLocal();
      return database.transaction((tx) => generateRenewals(tx, orgId, today));
    },
    [REPROCESS_JOB]: async (payload) => processStoredEvent(database, String(payload.webhookEventId)),
  };
}
