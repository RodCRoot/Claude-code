"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { verify } from "otplib";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { MFA_REQUIRED_REDIRECT, shouldRequireMfa } from "./mfa-policy";
import { createSession, destroySession, markSessionMfaVerified, recordMfaFailure } from "./session";
import { getPendingMfaUser } from "./viewer";
import type { ActionState } from "@/lib/actions";
import { audit } from "@/lib/audit";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return { ok: false, error: "Enter your email and password." };
  const { verifyCredentials } = await import("./session");
  const res = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!res.ok) return { ok: false, error: res.error };
  await createSession(res.userId, { mfaVerified: !res.needsMfa });
  redirect(res.needsMfa ? "/login/mfa" : await postLoginPath(res.userId));
}

/**
 * Staff whose organization requires two-step verification go straight to enrolment. (Sending them
 * to /today and letting the app layout redirect leaves the browser on a blank page after the
 * sign-in action's own redirect, so the policy is applied here as well.)
 */
async function postLoginPath(userId: string) {
  const [u] = await db.select({ role: users.role, orgId: users.orgId, mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, userId));
  const [org] = u ? await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, u.orgId)) : [];
  return u && shouldRequireMfa(u, org?.settings, "/today") ? MFA_REQUIRED_REDIRECT : "/today";
}

export async function mfaAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getPendingMfaUser();
  if (!user || !user.mfaSecret) return { ok: false, error: "Your sign-in expired. Please sign in again." };
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await destroySession();
    return { ok: false, error: "Too many incorrect codes. Sign in again in a few minutes." };
  }
  const token = String(fd.get("code") ?? "").replace(/\s/g, "");
  const result = await verify({ secret: user.mfaSecret, token });
  if (!result.valid) {
    await audit(db, { orgId: user.orgId, actorUserId: user.id, actorRole: user.role }, "auth.mfa_failed", "user", user.id);
    if (await recordMfaFailure(user)) {
      await destroySession();
      return { ok: false, error: "Too many incorrect codes. Sign in again in a few minutes." };
    }
    return { ok: false, error: "That code didn't match. Check your authenticator app and try again." };
  }
  await markSessionMfaVerified();
  await db.update(users).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
  redirect("/today");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
