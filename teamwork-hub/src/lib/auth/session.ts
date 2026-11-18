import "server-only";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { db } from "@/db";
import { authSessions, users, type Role } from "@/db/schema";
import { audit } from "@/lib/audit";

export const SESSION_COOKIE = "tw_session";
const SESSION_TTL_HOURS = 12;
const KIOSK_TTL_HOURS = 24 * 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const STAFF_ROLES: Role[] = ["owner", "admin", "operations", "coach"];

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 11);
}

export type LoginResult =
  | { ok: true; userId: string; needsMfa: boolean }
  | { ok: false; error: string };

/**
 * Verifies credentials with lockout. Returns a generic error so login does not
 * reveal whether an email exists.
 */
export async function verifyCredentials(email: string, password: string): Promise<LoginResult> {
  const generic = { ok: false as const, error: "Email or password is incorrect." };
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email.trim()})`)
    .limit(1);
  if (!user || !user.passwordHash || user.disabledAt) {
    await bcrypt.compare(password, "$2b$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // Same message and bcrypt cost as an unknown email: a lock-specific reply would confirm the account exists.
    await bcrypt.compare(password, "$2b$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return generic;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await audit(db, { orgId: user.orgId, actorUserId: user.id, actorRole: user.role }, "auth.login_failed", "user", user.id);
    return generic;
  }
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
  return { ok: true, userId: user.id, needsMfa: user.mfaEnabled };
}

/**
 * Second-factor attempts share the password lockout budget: without it a stolen password allows
 * unlimited guessing of 6-digit codes. Returns true when this failure locked the account.
 */
export async function recordMfaFailure(user: { id: string; failedLoginCount: number }): Promise<boolean> {
  const failed = user.failedLoginCount + 1;
  const lock = failed >= MAX_FAILED;
  await db
    .update(users)
    .set({ failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
    .where(eq(users.id, user.id));
  return lock;
}

export async function createSession(userId: string, opts: { mfaVerified: boolean }) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const token = newToken();
  const ttl = user.role === "kiosk" ? KIOSK_TTL_HOURS : SESSION_TTL_HOURS;
  const h = await headers();
  await db.insert(authSessions).values({
    userId,
    tokenHash: sha256(token),
    mfaVerified: opts.mfaVerified,
    expiresAt: new Date(Date.now() + ttl * 3600_000),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttl * 3600,
  });
  await audit(db, { orgId: user.orgId, actorUserId: user.id, actorRole: user.role }, "auth.login", "user", user.id);
}

export async function markSessionMfaVerified() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return;
  await db.update(authSessions).set({ mfaVerified: true }).where(eq(authSessions.tokenHash, sha256(token)));
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.tokenHash, sha256(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export async function sessionUserFromToken(token: string | undefined) {
  if (!token) return null;
  const rows = await db
    .select({ session: authSessions, user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, sha256(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
