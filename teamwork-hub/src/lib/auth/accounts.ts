import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { generateSecret, generateURI, verify } from "otplib";
import type { Tx } from "@/db";
import { authSessions, people, users, type Role } from "@/db/schema";
import { assertCan, AuthzError, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { hashPassword, newToken, sha256 } from "./session";

const INVITE_HOURS = 72;
const RESET_HOURS = 2;

export const PASSWORD_RULE = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Include letters and numbers");

/** Only owners can grant owner/admin; admins can manage operations/coach/family/kiosk logins. */
function assertCanGrant(v: Viewer, role: Role) {
  assertCan(v, "settings.manage");
  if ((role === "owner" || role === "admin") && v.role !== "owner") throw new AuthzError("Only the owner can grant owner or admin access.");
}

/**
 * Create a login invite. Returns the raw token exactly once (shown to staff to send
 * manually when email delivery isn't configured). Only the hash is stored.
 */
export async function inviteUser(tx: Tx, v: Viewer, raw: unknown) {
  const input = z
    .object({
      email: z.string().trim().email(),
      role: z.enum(["owner", "admin", "operations", "coach", "guardian", "athlete", "kiosk"]),
      displayName: z.string().trim().min(1).max(100),
      personId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
    })
    .parse(raw);
  assertCanGrant(v, input.role);
  if (input.personId) {
    const [p] = await tx.select().from(people).where(and(eq(people.id, input.personId), eq(people.orgId, v.orgId)));
    if (!p) throw new UserError("Linked person not found.");
    const [existing] = await tx.select().from(users).where(eq(users.personId, input.personId));
    if (existing) throw new UserError("That person already has a login.");
  }
  const [dup] = await tx.select().from(users).where(and(eq(users.orgId, v.orgId), sql`lower(${users.email}) = lower(${input.email})`));
  if (dup) throw new UserError("A login with that email already exists.");
  const token = newToken();
  const [u] = await tx
    .insert(users)
    .values({
      orgId: v.orgId,
      email: input.email,
      role: input.role,
      displayName: input.displayName,
      personId: input.personId ?? null,
      inviteTokenHash: sha256(token),
      inviteExpiresAt: new Date(Date.now() + INVITE_HOURS * 3600_000),
    })
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "user.invite", "user", u.id, { summary: `${input.email} as ${input.role}` });
  return { userId: u.id, token };
}

export async function createResetToken(tx: Tx, v: Viewer, userId: string) {
  assertCan(v, "settings.manage");
  const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, v.orgId)));
  if (!u) throw new UserError("User not found.");
  if ((u.role === "owner" || u.role === "admin") && v.role !== "owner" && u.id !== v.userId) throw new AuthzError();
  const token = newToken();
  await tx.update(users).set({ resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + RESET_HOURS * 3600_000) }).where(eq(users.id, u.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "user.reset_link", "user", u.id);
  return token;
}

/** Accept an invite or reset: sets the password, clears the token, revokes old sessions. */
export async function redeemToken(tx: Tx, kind: "invite" | "reset", token: string, password: string) {
  const pw = PASSWORD_RULE.parse(password);
  const hash = sha256(token);
  const cond =
    kind === "invite"
      ? and(eq(users.inviteTokenHash, hash), gt(users.inviteExpiresAt, new Date()))
      : and(eq(users.resetTokenHash, hash), gt(users.resetExpiresAt, new Date()));
  const [u] = await tx.select().from(users).where(cond);
  if (!u) throw new UserError("This link is invalid or has expired. Ask the front desk for a new one.");
  await tx
    .update(users)
    .set({ passwordHash: await hashPassword(pw), inviteTokenHash: null, inviteExpiresAt: null, resetTokenHash: null, resetExpiresAt: null, failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, u.id));
  await tx.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.userId, u.id));
  await audit(tx, { orgId: u.orgId, actorUserId: u.id, actorRole: u.role }, kind === "invite" ? "user.invite_accepted" : "user.password_reset", "user", u.id);
  return u;
}

export async function setUserDisabled(tx: Tx, v: Viewer, userId: string, disabled: boolean) {
  assertCan(v, "settings.manage");
  if (userId === v.userId) throw new UserError("You can't disable your own login.");
  const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, v.orgId)));
  if (!u) throw new UserError("User not found.");
  if (u.role === "owner" && v.role !== "owner") throw new AuthzError();
  await tx.update(users).set({ disabledAt: disabled ? new Date() : null }).where(eq(users.id, userId));
  if (disabled) await tx.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.userId, userId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, disabled ? "user.disable" : "user.enable", "user", userId);
}

export async function changeRole(tx: Tx, v: Viewer, userId: string, role: Role) {
  assertCanGrant(v, role);
  const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, v.orgId)));
  if (!u) throw new UserError("User not found.");
  if (u.role === "owner" && v.role !== "owner") throw new AuthzError();
  if (userId === v.userId && role !== v.role) throw new UserError("Ask another owner to change your own role.");
  await tx.update(users).set({ role }).where(eq(users.id, userId));
  await tx.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.userId, userId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "user.role_change", "user", userId, { before: { role: u.role }, after: { role } });
}

// --- MFA (TOTP) --------------------------------------------------------------

export async function beginMfaEnrollment(tx: Tx, v: Viewer) {
  const [u] = await tx.select().from(users).where(eq(users.id, v.userId));
  if (u.mfaEnabled) throw new UserError("Two-step verification is already on.");
  const secret = generateSecret();
  await tx.update(users).set({ mfaSecret: secret }).where(eq(users.id, v.userId));
  return { secret, uri: generateURI({ issuer: "Teamwork Hub", label: u.email, secret }) };
}

export async function confirmMfaEnrollment(tx: Tx, v: Viewer, code: string) {
  const [u] = await tx.select().from(users).where(eq(users.id, v.userId));
  if (!u.mfaSecret) throw new UserError("Start enrollment first.");
  const r = await verify({ secret: u.mfaSecret, token: code.replace(/\s/g, "") });
  if (!r.valid) throw new UserError("That code didn't match. Try the newest code from your app.");
  await tx.update(users).set({ mfaEnabled: true }).where(eq(users.id, v.userId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "user.mfa_enabled", "user", v.userId);
}

export async function disableMfa(tx: Tx, v: Viewer, targetUserId: string) {
  if (targetUserId !== v.userId) {
    assertCan(v, "settings.manage");
    const [u] = await tx.select({ role: users.role }).from(users).where(and(eq(users.id, targetUserId), eq(users.orgId, v.orgId)));
    if (!u) throw new UserError("User not found.");
    // Same rule as disabling/resetting: only an owner can weaken another owner's or an admin's sign-in.
    if ((u.role === "owner" || u.role === "admin") && v.role !== "owner") throw new AuthzError();
  }
  await tx.update(users).set({ mfaEnabled: false, mfaSecret: null }).where(and(eq(users.id, targetUserId), eq(users.orgId, v.orgId)));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "user.mfa_disabled", "user", targetUserId);
}
