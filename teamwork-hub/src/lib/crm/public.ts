import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";

/**
 * Organization for public (unauthenticated) pages. Teamwork Hub is deployed single-tenant,
 * so this is the org named by `?org=<slug>` if given, else the first organization.
 */
export async function publicOrg(tx: Tx, slug?: string | null) {
  if (slug) {
    const [o] = await tx.select().from(organizations).where(eq(organizations.slug, slug));
    if (o) return o;
  }
  const [first] = await tx.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  return first ?? null;
}
