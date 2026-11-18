import { getPool } from "@/db";
import { log, serializeError } from "@/lib/observability";

/**
 * GET /api/health — liveness + database connectivity for the load balancer / Render health check.
 * Public and unauthenticated, so it says only "ok" or "unavailable": no versions, hostnames,
 * error messages, or counts. Failures are logged (redacted) server-side.
 */
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3000;

export async function GET() {
  let ok = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database check timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    });
    const res = await Promise.race([getPool().query<{ ok: number }>("select 1 as ok"), timeout]);
    ok = res.rows[0]?.ok === 1;
  } catch (e) {
    log("error", "health_check_failed", { check: "database", error: serializeError(e) });
  } finally {
    clearTimeout(timer);
  }
  return Response.json(
    { status: ok ? "ok" : "unavailable" },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

export const HEAD = GET;
