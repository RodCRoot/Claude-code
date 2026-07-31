import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, roles } from "@/db/schema";
import type { Permission } from "./permissions";

const COOKIE_NAME = "tb_session";
const SESSION_DAYS = 14;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET must be set in production");
    }
    return new TextEncoder().encode("dev-only-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  title: string | null;
  roleId: number;
  roleName: string;
  permissions: string[];
}

export async function verifyCredentials(
  email: string,
  password: string
): Promise<SessionUser | null> {
  const row = db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .get();
  if (!row || !row.active) return null;
  const ok = await bcrypt.compare(password, row.passwordHash);
  if (!ok) return null;
  return loadSessionUser(row.id);
}

export function loadSessionUser(userId: number): SessionUser | null {
  const row = db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      title: users.title,
      active: users.active,
      roleId: users.roleId,
      roleName: roles.name,
      permissions: roles.permissions,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .get();
  if (!row || !row.active) return null;
  let perms: string[] = [];
  try {
    perms = JSON.parse(row.permissions);
  } catch {
    perms = [];
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    title: row.title,
    roleId: row.roleId,
    roleName: row.roleName,
    permissions: perms,
  };
}

export async function createSession(userId: number): Promise<void> {
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Returns the logged-in user or null. Never throws. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const uid = Number(payload.uid);
    if (!Number.isInteger(uid)) return null;
    return loadSessionUser(uid);
  } catch {
    return null;
  }
}

/** For server components/actions: redirect to login when not authenticated. */
export async function requireUser(perm?: Permission): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (perm && !user.permissions.includes(perm)) redirect("/denied");
  return user;
}

/** For API routes: returns a Response error instead of redirecting. */
export async function requireApiUser(
  perm?: Permission
): Promise<{ user: SessionUser } | { error: Response }> {
  const user = await getSessionUser();
  if (!user) {
    return { error: Response.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  if (perm && !user.permissions.includes(perm)) {
    return { error: Response.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { user };
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}
