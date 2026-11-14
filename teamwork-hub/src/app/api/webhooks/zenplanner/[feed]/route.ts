import { db } from "@/db";
import { ingestZpWebhook } from "@/lib/zenplanner/webhooks";

/**
 * Zen Planner outbound webhooks (no session auth; each request must carry the shared secret):
 *   /api/webhooks/zenplanner/people
 *   /api/webhooks/zenplanner/class-sessions
 *   /api/webhooks/zenplanner/attendance
 * Off by default (404 until an owner or admin turns the receiver on in Settings → Integrations).
 * Optional `?org=<slug>`; single-tenant default is the first organization.
 * Receive only: nothing here ever calls Zen Planner.
 */
export async function POST(request: Request, { params }: { params: Promise<{ feed: string }> }) {
  const { feed } = await params;
  const reqUrl = new URL(request.url);
  const raw = await request.text();
  const res = await ingestZpWebhook(db, { feed, raw, headers: request.headers, url: request.url, orgSlug: reqUrl.searchParams.get("org") });
  return Response.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
