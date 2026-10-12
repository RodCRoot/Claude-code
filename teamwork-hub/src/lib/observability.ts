/**
 * Observability: structured JSON logs + optional Sentry error reporting.
 *
 * - `log(level, msg, fields)` writes one JSON line to stdout/stderr. Every field goes through
 *   `redact()` first, so secrets, tokens, email addresses, and health data never reach the logs.
 * - `reportError(err, context)` logs an unexpected error and, only when SENTRY_DSN is set and
 *   `initMonitoring()` has run (src/instrumentation.ts for the web app, scripts/worker.ts for the
 *   job worker), forwards it to Sentry. Sentry events are redacted the same way in `beforeSend`.
 * - Without SENTRY_DSN the Sentry SDK is never imported or initialised.
 *
 * Usable from the Next server, route handlers, scripts, and tests (no Next-only imports here).
 */
import type * as SentryNS from "@sentry/nextjs";

export type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTED = "[REDACTED]";
export const REDACTED_HEALTH = "[REDACTED:health]";
export const REDACTED_EMAIL = "[email]";

/*
 * Key classifiers run on the key split into lower-case words ("bodyMap" → "body map",
 * "api_key" → "api key"), matched on word boundaries so e.g. "purpose" is not "rpe" and
 * "authorId" is not "auth".
 */
/** Keys whose values are credentials or secrets. */
const SECRET_KEY =
  /\b(pass(word|wd|phrase)?s?|secrets?|tokens?|api ?keys?|access ?keys?|private ?keys?|authorization|auth|cookies?|set cookie|signatures?|sig|dsn|credentials?|otp|totp|mfa ?code|card ?number|cvc|cvv|iban|ssn|refresh|bearer|client ?secret)\b/;

/** Keys that carry health / wellness / medical data (never logged, never sent to Sentry). */
const HEALTH_KEY =
  /\b(health|wellness|injur(y|ies|ed)|medical|medications?|allerg(y|ies)|diagnos[ie]s|conditions?|symptoms?|soreness|pain|body ?map|illness|concussions?|rpe|sleep|mood|stress|readiness|menstrua\w*|heart ?rate|hrv|bodyweight|body ?weight|notes?)\b/;

/** Keys that hold an email address or other direct contact identifiers. */
const CONTACT_KEY = /\b(e ?mail|emails|phone|mobile|address|dob|date ?of ?birth|birth ?date)\b/;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const URL_CRED_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi;
const QUERY_SECRET_RE = /([?&](?:token|access_token|refresh_token|code|key|api_key|signature|sig|password|secret)=)[^&\s#]+/gi;
const PROVIDER_KEY_RE = /\b(sk|rk|pk|whsec)_(live|test)_[A-Za-z0-9]{6,}\b/g;
const LONG_HEX_RE = /\b[a-f0-9]{40,}\b/gi;

/** Scrub secrets and emails out of free text (error messages, stack traces, URLs). */
export function redactString(s: string): string {
  return s
    .replace(URL_CRED_RE, `$1${REDACTED}@`)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(PROVIDER_KEY_RE, REDACTED)
    .replace(QUERY_SECRET_RE, `$1${REDACTED}`)
    .replace(LONG_HEX_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED_EMAIL);
}

function normKey(k: string) {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

export function classifyKey(key: string): "secret" | "health" | "contact" | null {
  const k = normKey(key);
  if (SECRET_KEY.test(k)) return "secret";
  if (HEALTH_KEY.test(k)) return "health";
  if (CONTACT_KEY.test(k)) return "contact";
  return null;
}

/**
 * Deep-copy `value` with sensitive keys masked and secrets/emails scrubbed from strings.
 * Handles Errors, Maps, arrays, cycles, and depth (> 8 levels collapses to "[depth]").
 */
export function redact<T = unknown>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (typeof value === "bigint") return String(value) as T;
  if (typeof value !== "object") return value;
  if (depth > 8) return "[depth]" as T;
  if (seen.has(value as object)) return "[circular]" as T;
  seen.add(value as object);
  if (value instanceof Date) return value.toISOString() as T;
  if (value instanceof Error) return serializeError(value, depth, seen) as T;
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]` as T;
  if (value instanceof Map) return redact(Object.fromEntries(value), depth, seen);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cls = classifyKey(k);
    if (cls === "secret") out[k] = v == null || v === "" ? v : REDACTED;
    else if (cls === "health") out[k] = v == null ? v : REDACTED_HEALTH;
    else if (cls === "contact") out[k] = v == null || v === "" ? v : REDACTED;
    else out[k] = redact(v, depth + 1, seen);
  }
  return out as T;
}

export function serializeError(e: unknown, depth = 0, seen = new WeakSet<object>()): Fields {
  if (!(e instanceof Error)) return { message: redactString(String(e)) };
  const err = e as Error & { code?: unknown; digest?: unknown; cause?: unknown };
  const out: Fields = { name: err.name, message: redactString(err.message ?? "") };
  if (typeof err.code === "string" || typeof err.code === "number") out.code = err.code;
  if (typeof err.digest === "string") out.digest = err.digest;
  if (err.stack) out.stack = redactString(err.stack).split("\n").slice(0, 12).join("\n");
  if (err.cause && depth < 3) out.cause = err.cause instanceof Error ? serializeError(err.cause, depth + 1, seen) : redact(err.cause, depth + 1, seen);
  return out;
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
function minLevel(): number {
  const l = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[l] ?? LEVELS.info;
}

/** Build the JSON log line (exported for tests). */
export function formatLog(level: LogLevel, msg: string, fields: Fields = {}): string {
  return JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields) });
}

export function log(level: LogLevel, msg: string, fields: Fields = {}): void {
  if (LEVELS[level] < minLevel()) return;
  const line = formatLog(level, msg, fields);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, f?: Fields) => log("debug", msg, f),
  info: (msg: string, f?: Fields) => log("info", msg, f),
  warn: (msg: string, f?: Fields) => log("warn", msg, f),
  error: (msg: string, f?: Fields) => log("error", msg, f),
};

// ---------------------------------------------------------------------------
// Sentry (optional)
// ---------------------------------------------------------------------------

type Sentry = typeof SentryNS;
const g = globalThis as unknown as { __twSentry?: Sentry | null; __twSentryInit?: Promise<Sentry | null> };

export const monitoringEnabled = () => !!process.env.SENTRY_DSN;

/** Sentry event scrubber: drops cookies/headers/bodies and redacts everything else. */
export function scrubSentryEvent<E extends Record<string, unknown>>(event: E): E {
  const e = event as Record<string, unknown> & {
    request?: Record<string, unknown> & { headers?: Record<string, string> };
    user?: Record<string, unknown>;
  };
  if (e.request) {
    const headers = e.request.headers ?? {};
    const keep: Record<string, string> = {};
    for (const h of ["user-agent", "content-type", "x-request-id", "next-action"]) if (headers[h]) keep[h] = headers[h];
    e.request = { method: e.request.method, url: typeof e.request.url === "string" ? redactString(e.request.url.split("?")[0]) : undefined, headers: keep };
  }
  if (e.user) e.user = typeof e.user.id === "string" ? { id: e.user.id } : undefined;
  for (const k of ["extra", "contexts", "tags", "breadcrumbs", "exception", "message"]) {
    if (e[k] != null) e[k] = redact(e[k]);
  }
  return event;
}

/**
 * Initialise Sentry for this process when SENTRY_DSN is set. Idempotent; resolves to null
 * (and imports nothing) when monitoring is off.
 */
export function initMonitoring(component: "web" | "worker"): Promise<Sentry | null> {
  if (!monitoringEnabled()) return Promise.resolve(null);
  if (g.__twSentryInit) return g.__twSentryInit;
  g.__twSentryInit = (async () => {
    try {
      const mod = await import("@sentry/nextjs");
      // Under plain Node/tsx (the worker) the CJS build's re-exports only appear on `default`.
      const Sentry = (typeof mod.captureException === "function" ? mod : ((mod as { default?: Sentry }).default ?? mod)) as Sentry;
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_MODE ?? "development",
        release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
        // Errors only by default; tracing is opt-in (SENTRY_TRACES_SAMPLE_RATE).
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
        // Sentry 11 data-collection controls: collect nothing personal by default. Bodies, DB
        // query params and stack locals could hold minors' health data, so all are off.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: { request: { allow: ["user-agent", "content-type"] }, response: false },
          httpBodies: [],
          urlQueryParams: false,
          databaseQueryData: false,
          queues: false,
          stackFrameVariables: false,
          genAI: { inputs: false, outputs: false },
          graphQL: { document: false, variables: false },
        },
        initialScope: { tags: { component } },
        beforeSend: (event) => scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
        // Only used if tracing is turned on: span names and attributes (URLs, etc.) are redacted too.
        beforeSendSpan: (span) => ({ ...span, name: redactString(span.name), attributes: redact(span.attributes) }),
        beforeBreadcrumb: (b) => (b.category === "console" ? null : (redact(b) as typeof b)),
      });
      g.__twSentry = Sentry;
      log("info", "monitoring_enabled", { component, provider: "sentry" });
      return Sentry;
    } catch (e) {
      log("error", "monitoring_init_failed", { component, error: serializeError(e) });
      g.__twSentry = null;
      return null;
    }
  })();
  return g.__twSentryInit;
}

export function sentryClient(): Sentry | null {
  return g.__twSentry ?? null;
}

/**
 * Log an unexpected error (redacted) and report it to Sentry when enabled.
 * `context.where` names the boundary ("action", "route:/api/…", "job:messaging.send", …).
 */
export function reportError(err: unknown, context: Fields & { where: string }): void {
  log("error", "unexpected_error", { ...context, error: serializeError(err) });
  const Sentry = sentryClient();
  if (!Sentry) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("where", context.where);
      const extra = redact(context) as Fields;
      for (const [k, v] of Object.entries(extra)) if (k !== "where") scope.setExtra(k, v);
      Sentry.captureException(err);
    });
  } catch {
    // Monitoring must never break the request.
  }
}

/** Flush pending Sentry events (worker shutdown). */
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  const Sentry = sentryClient();
  if (Sentry) await Sentry.flush(timeoutMs).catch(() => undefined);
}
