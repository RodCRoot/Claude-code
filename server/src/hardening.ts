// Dependency-free API hardening: security headers and in-memory rate limiting.
// Deliberately small — this app deploys as a single instance (Render), so a
// per-process limiter is adequate; swap for a shared store if it ever scales out.
import { Request, Response, NextFunction } from "express";

const PROD = process.env.NODE_ENV === "production";

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (PROD) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    // The SPA bundles all JS/CSS; React/Recharts set inline style attributes.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    );
  }
  next();
}

interface Bucket { count: number; resetAt: number; }

// Fixed-window per-IP limiter. Returns 429 with Retry-After when exceeded.
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const buckets = new Map<string, Bucket>();
  // Bound memory: sweep expired buckets occasionally.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, opts.windowMs);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: `Too many requests (${opts.name}). Try again shortly.` });
    }
    next();
  };
}
