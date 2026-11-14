import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { organizations, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { newToken, sha256 } from "./session";

const INVITE_HOURS = 72;

/**
 * First-run setup for a staging/production database: creates the organization and its owner
 * login as an INVITE (no password is ever chosen or printed by the operator; the owner sets it
 * on /invite/<token>). Refuses once any organization exists, so it can't be used to add a
 * second owner or take over an existing install.
 */
export async function bootstrapOwner(tx: Tx, raw: unknown) {
  const input = z
    .object({
      orgName: z.string().trim().min(2).max(120),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, "slug: lowercase letters, digits, dashes"),
      email: z.string().trim().email(),
      displayName: z.string().trim().min(1).max(100),
    })
    .parse(raw);
  // Serialize concurrent bootstraps, then check emptiness inside the lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('teamwork-hub:bootstrap-owner'))`);
  const [{ n }] = (await tx.execute(sql`select count(*)::int as n from organizations`)).rows as { n: number }[];
  if (n > 0) throw new UserError("An organization already exists — bootstrap only runs on an empty database. Invite more users from Settings → Users.");
  const [org] = await tx.insert(organizations).values({ name: input.orgName, slug: input.slug, isDemo: false }).returning();
  const token = newToken();
  const [owner] = await tx
    .insert(users)
    .values({
      orgId: org.id,
      email: input.email,
      role: "owner",
      displayName: input.displayName,
      inviteTokenHash: sha256(token),
      inviteExpiresAt: new Date(Date.now() + INVITE_HOURS * 3600_000),
    })
    .returning();
  await audit(tx, { orgId: org.id, actorUserId: null, actorRole: "system" }, "org.bootstrap", "organization", org.id, {
    summary: `Organization created with owner invite for ${input.email}`,
  });
  return { orgId: org.id, userId: owner.id, token, expiresInHours: INVITE_HOURS };
}
