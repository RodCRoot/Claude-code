import { ensureTaskInstances } from "@/lib/tasks";
import { ensureConnectorRows, runSync, ADAPTERS, SYNCABLE_MODES } from "@/lib/connectors";
import { db } from "@/db";
import { connectors } from "@/db/schema";

/**
 * Scheduled-job endpoint. Point a scheduler at this daily (or hourly):
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron
 * - Generates recurring task instances (operations, cleaning, marketing)
 * - Attempts a sync for every API connector marked ready
 * Works with Vercel Cron, system cron, or any uptime pinger.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get("authorization");
    const url = new URL(req.url);
    if (header !== `Bearer ${secret}` && url.searchParams.get("secret") !== secret) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return Response.json(
      { error: "Set CRON_SECRET to enable the cron endpoint in production." },
      { status: 503 }
    );
  }

  const tasksCreated = ensureTaskInstances();
  ensureConnectorRows();

  const results: Record<string, string> = {};
  const apiConnectors = ADAPTERS.filter((a) => SYNCABLE_MODES.includes(a.mode)).map(
    (a) => a.key
  );
  for (const key of apiConnectors) {
    const row = db.select().from(connectors).all().find((c) => c.key === key);
    if (row?.status === "ready") {
      const r = await runSync(key, "scheduled");
      results[key] = r.message;
    } else {
      results[key] = "skipped (not configured)";
    }
  }

  return Response.json({ ok: true, tasksCreated, syncs: results });
}

export const POST = GET;
