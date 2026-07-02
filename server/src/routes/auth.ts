import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "../hardening";
import { prisma } from "../db";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  AuthedRequest,
} from "../auth";
import { ROLES, Role } from "../constants";

export const authRouter = Router();

// Credential endpoints get a much stricter ceiling than the general API:
// 10 attempts per 5 minutes per IP blunts password guessing.
const credentialLimiter = rateLimit({ windowMs: 5 * 60_000, max: 10, name: "auth" });

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(ROLES).default("ATHLETE"),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
});

// Register a user. If no orgId is given, a new organization is created
// (first user becomes its admin-capable coach).
authRouter.post("/register", credentialLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, name, role } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  let orgId = parsed.data.orgId;
  if (!orgId) {
    const org = await prisma.organization.create({
      data: { name: parsed.data.orgName || `${name}'s Team` },
    });
    orgId = org.id;
  }

  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), name, role, orgId },
  });

  const token = signToken({ userId: user.id, role: user.role as Role, orgId });
  res.status(201).json({ token, user: publicUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post("/login", credentialLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    include: { athlete: true },
  });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({
    userId: user.id,
    role: user.role as Role,
    orgId: user.orgId,
    athleteId: user.athlete?.id ?? null,
  });
  res.json({ token, user: publicUser(user) });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    include: { athlete: true, org: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user), athleteId: user.athlete?.id ?? null });
});

function publicUser(u: { id: string; email: string; name: string; role: string; orgId: string }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.orgId };
}
