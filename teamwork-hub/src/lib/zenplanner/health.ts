import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, zpPersonHealth } from "@/db/schema";
import { canOnAthlete, isAdmin, type Viewer } from "@/lib/authz/policy";

export type ImportedHealth = { specialNeeds: string | null; medications: string | null; allergies: string | null; importedAt: Date };

/**
 * Special Needs / Medications / Allergies imported from Zen Planner. HEALTH DATA: returned only
 * to a viewer with `health.read` on the athlete (owner, admin, an assigned coach, the athlete, or
 * a guardian whose link grants health access). A person without an athlete record (a prospect or
 * a parent) is readable by owner/admin only. Everyone else gets null, the same as "nothing on file".
 */
export async function importedHealthForPerson(tx: Tx, v: Viewer, personId: string): Promise<ImportedHealth | null> {
  const [a] = await tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.personId, personId), eq(athletes.orgId, v.orgId)));
  const allowed = a ? await canOnAthlete(tx, v, a.id, "health.read") : isAdmin(v);
  if (!allowed) return null;
  const [h] = await tx.select().from(zpPersonHealth).where(and(eq(zpPersonHealth.personId, personId), eq(zpPersonHealth.orgId, v.orgId)));
  if (!h) return null;
  return { specialNeeds: h.specialNeeds, medications: h.medications, allergies: h.allergies, importedAt: h.createdAt };
}
