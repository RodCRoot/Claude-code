import { db, type DB } from "@/db";
import type { JobHandler } from "@/lib/jobs";
import { todayLocal } from "@/lib/time";
import { generateRenewals, RENEWAL_JOB } from "./renewals";
import { processStoredEvent, REPROCESS_JOB } from "./webhooks";
import { AUTOPAY_JOB, chargeInvoiceAutopay, FEE_JOB, recordProcessorFee } from "./autopay";

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
    [AUTOPAY_JOB]: async (payload) => chargeInvoiceAutopay(database, { orgId: String(payload.orgId), invoiceId: String(payload.invoiceId), attemptNumber: Number(payload.attemptNumber ?? 1) }),
    [FEE_JOB]: async (payload, job) => {
      const r = await recordProcessorFee(database, { orgId: String(payload.orgId), providerTxnId: String(payload.providerTxnId) });
      // The balance transaction can lag the payment: let the queue retry, then give up quietly (fee stays unknown).
      if (!r.recorded && r.reason === "fee_not_available_yet" && job.attempts + 1 < job.maxAttempts) throw new Error("fee not available yet");
      return r;
    },
  };
}
