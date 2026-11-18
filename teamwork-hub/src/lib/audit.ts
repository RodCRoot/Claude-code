import type { Tx } from "@/db";
import { auditEvents } from "@/db/schema";

export type AuditActor = { orgId: string | null; actorUserId: string | null; actorRole?: string | null };

/** Append-only audit trail (enforced by a DB trigger). Never include secrets in before/after. */
export async function audit(
  tx: Tx,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | null,
  extra: { summary?: string; before?: unknown; after?: unknown } = {},
) {
  await tx.insert(auditEvents).values({
    orgId: actor.orgId,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole ?? null,
    action,
    entityType,
    entityId,
    summary: extra.summary ?? null,
    before: (extra.before ?? null) as never,
    after: (extra.after ?? null) as never,
  });
}
