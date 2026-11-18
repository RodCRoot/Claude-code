/**
 * Small fixed-window rate limiter for the public Showcase route (pure; no imports, so it can run
 * in src/proxy.ts). Counters live in process memory only: the client key is never written to the
 * database, a file or a log, and the whole map is dropped when the window rolls over.
 *
 * One limiter per server process. Behind several instances the effective limit is per instance;
 * a shared store would be needed for a hard global limit.
 */
export type RateLimiter = { check(key: string, now?: number): boolean; size(): number };

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const maxKeys = opts.maxKeys ?? 10_000;
  let windowStart = 0;
  let counts = new Map<string, number>();
  return {
    check(key, now = Date.now()) {
      if (now - windowStart >= opts.windowMs) {
        windowStart = now;
        counts = new Map();
      }
      // A flood of distinct keys cannot grow memory without bound: past the cap, everyone new shares one bucket.
      const k = !counts.has(key) && counts.size >= maxKeys ? "*overflow*" : key;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n <= opts.limit;
    },
    size: () => counts.size,
  };
}

/** 60 page loads a minute per client is far more than a coach reading a page needs. */
export const SHOWCASE_RATE = { limit: 60, windowMs: 60_000 };

const g = globalThis as unknown as { __twShowcaseLimiter?: RateLimiter };

/** True when this request may proceed. `forwardedFor` is the X-Forwarded-For header, if any. */
export function showcaseRateOk(forwardedFor: string | null | undefined, now?: number): boolean {
  if (!g.__twShowcaseLimiter) g.__twShowcaseLimiter = createRateLimiter(SHOWCASE_RATE);
  const client = (forwardedFor ?? "").split(",")[0].trim() || "direct";
  return g.__twShowcaseLimiter.check(client, now);
}
