import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Role } from "./constants";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
const TOKEN_TTL = "7d";

export interface AuthPayload {
  userId: string;
  role: Role;
  orgId: string;
  athleteId?: string | null;
}

export interface AuthedRequest extends Request {
  auth?: AuthPayload;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Require a valid bearer token. Attaches decoded payload to req.auth.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    req.auth = jwt.verify(header.slice(7), JWT_SECRET) as AuthPayload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Restrict a route to one or more roles. Use after requireAuth.
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
