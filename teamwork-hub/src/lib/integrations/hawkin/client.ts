import "server-only";

/**
 * Hawkin Dynamics Cloud API client (server-only).
 *
 * Verified in vendor docs (https://connect.hawkindynamics.com/api, /faq — v1.17, fetched 2026-10-12):
 *  - Regions: https://cloud.hawkindynamics.com (Americas), https://eu.cloud.hawkindynamics.com,
 *    https://apac.cloud.hawkindynamics.com. Paths: /api/token, /api/v1/...
 *  - Auth: GET /api/token with "Authorization: Bearer <refresh token>" → { access_token }.
 *    Access tokens expire after 1 hour.
 *  - GET /api/v1 (tests): from/to filter by original creation time; syncFrom/syncTo return tests
 *    created OR modified in the window. syncFrom/syncTo cannot be combined with athleteId, teamId,
 *    groupId or testTypeId — filter client-side instead. teamId/groupId: up to 10 ids each.
 *    Opt-in cursor pagination: paginate=true&cursor=… (1,000 tests/page, hasMore + nextCursor).
 *    includeInactive (tests). Timestamps are Unix seconds. Non-calculable metrics are null
 *    (useNulls=true default). Response includes lastSyncTime for the next syncFrom.
 *  - GET /api/v1/athletes?includeInactive=true, /api/v1/test_types (bare array), /api/v1/metrics,
 *    /api/v1/forcetime/{testId} (time series sampled at 1000 Hz).
 * Not documented: rate limits. We back off exponentially (with jitter) on 429/5xx and honor Retry-After.
 *
 * The refresh token is read from the environment by the caller and is never logged, persisted,
 * or included in errors.
 */

export type HawkinFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class HawkinError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable = false,
  ) {
    super(message);
    this.name = "HawkinError";
  }
}

export type HawkinAthlete = { id: string; name: string; active?: boolean; dob?: string | null; teams?: unknown; groups?: unknown; [k: string]: unknown };
export type HawkinTestType = { id: string; name: string; canonicalId?: string; [k: string]: unknown };
export type HawkinTest = {
  id: string;
  timestamp: number;
  segment?: string;
  active?: boolean;
  testType?: HawkinTestType;
  athlete?: HawkinAthlete;
  [metric: string]: unknown;
};
export type HawkinTestPage = { data: HawkinTest[]; hasMore: boolean; nextCursor: string | null; lastSyncTime: number | null; lastTestTime: number | null; count: number | null };

export type TestQuery = {
  from?: number;
  to?: number;
  syncFrom?: number;
  syncTo?: number;
  athleteId?: string;
  teamId?: string[];
  groupId?: string[];
  testTypeId?: string;
  includeInactive?: boolean;
};

export function assertValidTestQuery(q: TestQuery) {
  const sync = q.syncFrom !== undefined || q.syncTo !== undefined;
  const filtered = !!q.athleteId || !!q.teamId?.length || !!q.groupId?.length || !!q.testTypeId;
  if (sync && filtered) {
    throw new HawkinError("syncFrom/syncTo cannot be combined with athleteId, teamId, groupId or testTypeId (Hawkin API rule). Fetch within the token scope and filter locally.", null);
  }
  if (sync && (q.from !== undefined || q.to !== undefined)) throw new HawkinError("Use either from/to (creation window) or syncFrom/syncTo (changes), not both.", null);
  if ((q.teamId?.length ?? 0) > 10 || (q.groupId?.length ?? 0) > 10) throw new HawkinError("teamId/groupId accept at most 10 ids each.", null);
}

export type HawkinClientOptions = {
  refreshToken: string;
  baseUrl: string;
  fetch?: HawkinFetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export class HawkinClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly f: HawkinFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  /** Request log without secrets (for tests/diagnostics). */
  readonly calls: { path: string; status: number | null; attempt: number }[] = [];

  constructor(private readonly opts: HawkinClientOptions) {
    if (!opts.refreshToken) throw new HawkinError("Hawkin refresh token missing", null);
    this.f = opts.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  private base() {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  /** Exchange the refresh token for a 1-hour access token (refreshed 5 minutes early). */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 5 * 60_000 > this.now()) return this.token.value;
    const res = await this.raw("/token", this.opts.refreshToken);
    const body = (await res.json()) as { access_token?: string; expires_at?: number };
    if (!body.access_token) throw new HawkinError("Hawkin token response had no access_token", res.status);
    const expiresAt = typeof body.expires_at === "number" ? body.expires_at * (body.expires_at < 1e12 ? 1000 : 1) : this.now() + 60 * 60_000;
    this.token = { value: body.access_token, expiresAt };
    return body.access_token;
  }

  /** One request with retry/backoff. `bearer` is the token to send. */
  private async raw(pathAndQuery: string, bearer: string): Promise<Response> {
    const max = this.opts.maxRetries ?? 5;
    const baseDelay = this.opts.baseDelayMs ?? 500;
    const cap = this.opts.maxDelayMs ?? 30_000;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let netErr: unknown = null;
      try {
        res = await this.f(this.base() + pathAndQuery, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } });
      } catch (e) {
        netErr = e;
      }
      const path = pathAndQuery.split("?")[0];
      this.calls.push({ path, status: res?.status ?? null, attempt });
      if (res && res.ok) return res;
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= max) {
        if (!res) throw new HawkinError(`Hawkin request to ${path} failed: ${(netErr as Error)?.message ?? "network error"}`, null, true);
        throw new HawkinError(`Hawkin ${path} returned HTTP ${res.status}`, res.status, retryable);
      }
      const retryAfter = res?.headers.get("retry-after");
      const ra = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
      const exp = Math.min(cap, baseDelay * 2 ** attempt);
      const jittered = exp / 2 + this.random() * (exp / 2);
      await this.sleep(ra ?? jittered);
    }
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const pq = `${path}${qs ? `?${qs}` : ""}`;
    let token = await this.accessToken();
    try {
      return (await (await this.raw(pq, token)).json()) as T;
    } catch (e) {
      if (e instanceof HawkinError && e.status === 401) {
        token = await this.accessToken(true);
        return (await (await this.raw(pq, token)).json()) as T;
      }
      throw e;
    }
  }

  async athletes(includeInactive = true): Promise<HawkinAthlete[]> {
    const r = await this.get<unknown>("/v1/athletes", { includeInactive });
    return unwrapArray<HawkinAthlete>(r);
  }

  async testTypes(): Promise<HawkinTestType[]> {
    return unwrapArray<HawkinTestType>(await this.get<unknown>("/v1/test_types"));
  }

  async metrics(): Promise<Record<string, unknown>[]> {
    return unwrapArray<Record<string, unknown>>(await this.get<unknown>("/v1/metrics"));
  }

  async testPage(q: TestQuery, cursor?: string | null): Promise<HawkinTestPage> {
    assertValidTestQuery(q);
    const r = await this.get<Record<string, unknown>>("/v1", {
      from: q.from,
      to: q.to,
      syncFrom: q.syncFrom,
      syncTo: q.syncTo,
      athleteId: q.athleteId,
      teamId: q.teamId?.join(","),
      groupId: q.groupId?.join(","),
      testTypeId: q.testTypeId,
      includeInactive: q.includeInactive ?? true,
      paginate: true,
      cursor: cursor ?? undefined,
    });
    return {
      data: unwrapArray<HawkinTest>(r),
      hasMore: Boolean(r.hasMore),
      nextCursor: (r.nextCursor as string | null) ?? null,
      lastSyncTime: typeof r.lastSyncTime === "number" ? r.lastSyncTime : null,
      lastTestTime: typeof r.lastTestTime === "number" ? r.lastTestTime : null,
      count: typeof r.count === "number" ? r.count : null,
    };
  }

  /** All pages for a query. */
  async tests(q: TestQuery, maxPages = 1000): Promise<{ tests: HawkinTest[]; lastSyncTime: number | null; pages: number }> {
    const tests: HawkinTest[] = [];
    let cursor: string | null = null;
    let lastSyncTime: number | null = null;
    let pages = 0;
    do {
      const page = await this.testPage(q, cursor);
      pages++;
      tests.push(...page.data);
      lastSyncTime = page.lastSyncTime ?? lastSyncTime;
      cursor = page.hasMore ? page.nextCursor : null;
      if (page.hasMore && !page.nextCursor) throw new HawkinError("Hawkin said hasMore but gave no nextCursor", null);
    } while (cursor && pages < maxPages);
    return { tests, lastSyncTime, pages };
  }

  async forceTime(testId: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/v1/forcetime/${encodeURIComponent(testId)}`);
  }
}

function unwrapArray<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === "object") {
    for (const k of ["data", "athletes", "tests", "items", "results"]) {
      const v = (r as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export const HAWKIN_ENV_VARS = ["HAWKIN_REFRESH_TOKEN", "HAWKIN_API_BASE"];
export const DEFAULT_HAWKIN_BASE = "https://cloud.hawkindynamics.com/api";

/** Client from server environment, or null when not configured. Never exposes the token. */
export function hawkinClientFromEnv(extra: Partial<HawkinClientOptions> = {}): HawkinClient | null {
  const token = process.env.HAWKIN_REFRESH_TOKEN;
  if (!token) return null;
  return new HawkinClient({ refreshToken: token, baseUrl: process.env.HAWKIN_API_BASE || DEFAULT_HAWKIN_BASE, ...extra });
}
