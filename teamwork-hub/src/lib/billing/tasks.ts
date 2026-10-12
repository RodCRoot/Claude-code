import type { Tx } from "@/db";
import { tasks } from "@/db/schema";

/** Staff follow-up created by billing automation. Deduped so retries never create duplicates. */
export async function billingTask(
  tx: Tx,
  orgId: string,
  t: { title: string; description?: string; relatedType?: string; relatedId?: string | null; dedupeKey: string; priority?: "low" | "normal" | "high"; isDemo?: boolean; dueAt?: Date | null },
) {
  await tx
    .insert(tasks)
    .values({
      orgId,
      title: t.title,
      description: t.description ?? null,
      dueAt: t.dueAt ?? null,
      relatedType: t.relatedType ?? null,
      relatedId: t.relatedId ?? null,
      priority: t.priority ?? "normal",
      source: "billing",
      dedupeKey: `billing:${t.dedupeKey}`,
      isDemo: t.isDemo ?? false,
    })
    .onConflictDoNothing();
}
