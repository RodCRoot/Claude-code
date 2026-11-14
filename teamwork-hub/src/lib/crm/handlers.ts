import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { leads, people, tasks } from "@/db/schema";
import { audit } from "@/lib/audit";

/**
 * Job body for `crm.lead_converted`: creates the onboarding follow-up task for the lead
 * owner (forms, membership, first session). Idempotent through the task dedupe key.
 * Other modules may register their own reactions under a different job type.
 */
export async function onLeadConverted(tx: Tx, p: { orgId: string; leadId: string; athleteId: string }) {
  const [l] = await tx.select().from(leads).where(and(eq(leads.id, p.leadId), eq(leads.orgId, p.orgId)));
  if (!l || !l.convertedAt) return { skipped: "lead not converted" };
  const [person] = await tx.select({ first: people.firstName, last: people.lastName }).from(people).where(eq(people.id, l.personId));
  const rows = await tx
    .insert(tasks)
    .values({
      orgId: p.orgId,
      title: `Onboard ${person?.first ?? "new athlete"} ${person?.last ?? ""}`.trim(),
      description: "Send required forms/waivers, set up a membership or package, and book a first session.",
      assigneeUserId: l.ownerUserId,
      relatedPersonId: l.personId,
      relatedType: "athlete",
      relatedId: p.athleteId,
      source: "crm_conversion",
      dedupeKey: `lead-onboard:${l.id}`,
      dueAt: new Date(Date.now() + 2 * 86_400_000),
      isDemo: l.isDemo,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  if (rows.length) {
    await audit(tx, { orgId: p.orgId, actorUserId: null, actorRole: "system" }, "crm.onboarding_task_created", "lead", l.id, { after: { taskId: rows[0].id } });
  }
  return { taskId: rows[0]?.id ?? null };
}
