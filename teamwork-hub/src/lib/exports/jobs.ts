import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { users } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { createExport, exportRights, EXPORT_JOB_TYPE, type ExportScope } from "./bundle";

/**
 * Background export for large organizations. The request is authorized when enqueued and
 * re-authorized when the job runs (the requester's role may have changed).
 */
export async function enqueueExport(tx: Tx, v: Viewer, scope: ExportScope) {
  await exportRights(tx, v, scope);
  return enqueue(tx, {
    type: EXPORT_JOB_TYPE,
    orgId: v.orgId,
    payload: { userId: v.userId, scope },
    dedupeKey: `export:${v.orgId}:${v.userId}:${JSON.stringify(scope)}:${new Date().toISOString().slice(0, 13)}`,
    maxAttempts: 3,
  });
}

export const exportJobHandlers: Record<string, JobHandler> = {
  [EXPORT_JOB_TYPE]: async (payload) => {
    const userId = String(payload.userId);
    const scope = payload.scope as ExportScope;
    return db.transaction(async (tx) => {
      const [u] = await tx.select().from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
      if (!u) throw new Error("Requesting user no longer exists or is disabled");
      const v: Viewer = { userId: u.id, orgId: u.orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
      const { object } = await createExport(tx, v, scope);
      return { objectId: object.id };
    });
  },
};
