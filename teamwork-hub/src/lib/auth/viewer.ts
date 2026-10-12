import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, sessionUserFromToken, STAFF_ROLES } from "./session";
import { can, type OrgCapability, type Viewer } from "@/lib/authz/policy";
import type { Role } from "@/db/schema";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";

/** Resolve the current viewer once per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const jar = await cookies();
  const row = await sessionUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!row) return null;
  const { user, session } = row;
  // Staff with MFA enabled must complete the second factor before the session is usable.
  if (user.mfaEnabled && !session.mfaVerified) return null;
  return {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    personId: user.personId,
    displayName: user.displayName,
    mfaVerified: session.mfaVerified,
    mfaEnabled: user.mfaEnabled,
  } as Viewer & { mfaEnabled: boolean };
});

/** Session exists but MFA is pending — used by the /login/mfa page. */
export async function getPendingMfaUser() {
  const jar = await cookies();
  const row = await sessionUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!row || !row.user.mfaEnabled || row.session.mfaVerified) return null;
  return row.user;
}

export async function requireViewer(roles?: Role[]): Promise<Viewer> {
  const v = await getViewer();
  if (!v) {
    if (await getPendingMfaUser()) redirect("/login/mfa");
    redirect("/login");
  }
  if (roles && !roles.includes(v.role)) redirect("/denied");
  return v;
}

export async function requireStaff(): Promise<Viewer> {
  return requireViewer(STAFF_ROLES);
}

export async function requireCap(cap: OrgCapability): Promise<Viewer> {
  const v = await requireViewer();
  if (!can(v, cap)) redirect("/denied");
  return v;
}

export const getOrg = cache(async (orgId: string) => {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return o;
});
