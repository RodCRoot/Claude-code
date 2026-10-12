"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { verify } from "otplib";
import { db } from "@/db";
import { users } from "@/db/schema";
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
  redirect(res.needsMfa ? "/login/mfa" : "/today");
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
