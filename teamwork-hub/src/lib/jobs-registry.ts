/**
 * Central job handler registry used by the worker (`scripts/worker.ts`).
 *
 * Enqueue from any module inside your business transaction:
 *   await enqueue(tx, { type: "notify.session_cancelled", orgId, payload: { sessionId }, dedupeKey: `notify.session_cancelled:${sessionId}` });
 *
 * To add a handler: add ONE entry below, keyed by job type, whose body lives in your
 * module (`src/lib/<module>/…`). Handlers receive the job payload and run outside any
 * transaction (open your own with `db.transaction`). Throwing makes the queue retry
 * with exponential backoff; after `maxAttempts` the job is dead-lettered and shown in
 * Messages → Outbox with a Retry button. Handlers must be idempotent.
 *
 * Do not import `server-only` modules from handlers — the worker runs in plain Node.
 */
import { db } from "@/db";
import type { AutomationTrigger } from "@/db/schema";
import type { JobHandler } from "@/lib/jobs";
import { dispatch, evaluate, notifySession, type EvaluatePayload } from "@/lib/automation/engine";
import { onLeadConverted } from "@/lib/crm/handlers";
import { deliverOne } from "@/lib/messaging/delivery";
import { billingJobHandlers } from "@/lib/billing/jobs";
import { calendarJobHandlers } from "@/lib/calendar/sync";

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`payload.${name} is required`);
  return v;
};

export const JOB_TYPES = {
  /** payload: { sessionId, version? } — enqueued by Schedule when a session is cancelled. */
  NOTIFY_SESSION_CANCELLED: "notify.session_cancelled",
  /** payload: { sessionId, version? } — enqueued by Schedule when time/coach/location changes. Use dedupeKey `notify.session_changed:${sessionId}:${version}`. */
  NOTIFY_SESSION_CHANGED: "notify.session_changed",
  /** payload: { orgId, trigger?, ruleId?, sessionId?, leadId?, athleteId?, formRequestId?, paymentAttemptId?, membershipId? }. No trigger = scan every enabled rule. */
  AUTOMATION_EVALUATE: "automation.evaluate",
  /** internal: one automation message to one recipient (enqueued by automation.evaluate). */
  AUTOMATION_DISPATCH: "automation.dispatch",
  /** payload: { deliveryId } — one external email/SMS delivery (enqueued by messaging). */
  MESSAGING_DELIVER: "messaging.deliver",
  /** payload: { orgId, leadId, athleteId, … } — enqueued by CRM lead conversion. */
  CRM_LEAD_CONVERTED: "crm.lead_converted",
} as const;

export const jobHandlers: Record<string, JobHandler> = {
  // Billing renewals / webhook reprocessing and Google Calendar push/free-busy jobs.
  ...billingJobHandlers(db),
  ...calendarJobHandlers(db),
  [JOB_TYPES.NOTIFY_SESSION_CANCELLED]: (p) =>
    db.transaction((tx) => notifySession(tx, "session_cancelled", { sessionId: str(p.sessionId, "sessionId"), version: typeof p.version === "number" ? p.version : undefined })),

  [JOB_TYPES.NOTIFY_SESSION_CHANGED]: (p) =>
    db.transaction((tx) => notifySession(tx, "session_changed", { sessionId: str(p.sessionId, "sessionId"), version: typeof p.version === "number" ? p.version : undefined })),

  [JOB_TYPES.AUTOMATION_EVALUATE]: async (p, job) => {
    const orgId = (typeof p.orgId === "string" && p.orgId) || job.orgId;
    if (!orgId) throw new Error("payload.orgId is required");
    return db.transaction((tx) => evaluate(tx, { ...(p as Omit<EvaluatePayload, "orgId">), orgId, trigger: p.trigger as AutomationTrigger | undefined }));
  },

  [JOB_TYPES.AUTOMATION_DISPATCH]: (p) =>
    db.transaction((tx) =>
      dispatch(tx, {
        orgId: str(p.orgId, "orgId"),
        ruleId: str(p.ruleId, "ruleId"),
        dedupeKey: str(p.dedupeKey, "dedupeKey"),
        recipientPersonId: str(p.recipientPersonId, "recipientPersonId"),
        entityType: str(p.entityType, "entityType"),
        entityId: str(p.entityId, "entityId"),
        period: str(p.period, "period"),
        scope: (p.scope ?? {}) as Record<string, string>,
      }),
    ),

  [JOB_TYPES.MESSAGING_DELIVER]: async (p, job) => {
    const res = await db.transaction((tx) => deliverOne(tx, str(p.deliveryId, "deliveryId"), job));
    // Throw only after the delivery row update committed, so backoff/dead-letter applies.
    if (res.error) throw new Error(res.error);
    return res;
  },

  [JOB_TYPES.CRM_LEAD_CONVERTED]: (p) =>
    db.transaction((tx) => onLeadConverted(tx, { orgId: str(p.orgId, "orgId"), leadId: str(p.leadId, "leadId"), athleteId: str(p.athleteId, "athleteId") })),
};
