import type { Instrumentation } from "next";

/**
 * Next.js instrumentation hook (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation).
 * - register(): turns on Sentry for the Node server when SENTRY_DSN is set (no-op otherwise).
 * - onRequestError(): every uncaught server error (Server Components, Route Handlers, Server
 *   Actions, Proxy) is logged as redacted JSON and, when enabled, sent to Sentry.
 * Server-only by design: no browser SDK is shipped, so no health data can leave from the client.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initMonitoring } = await import("./lib/observability");
    await initMonitoring("web");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : "";
  // redirect()/notFound() are control flow, not failures.
  if (digest.startsWith("NEXT_")) return;
  const { log, serializeError, sentryClient } = await import("./lib/observability");
  log("error", "request_error", {
    where: `${context.routeType}:${context.routePath}`,
    method: request.method,
    path: request.path.split("?")[0],
    renderSource: context.renderSource,
    error: serializeError(err),
  });
  const Sentry = sentryClient();
  if (Sentry) {
    // Only the path + method go to Sentry; headers (cookies, auth) are dropped by beforeSend too.
    Sentry.captureRequestError(err, { path: request.path.split("?")[0], method: request.method, headers: {} }, context);
  }
};
