import { db } from "@/db";
import { leads, connectors, syncRuns } from "@/db/schema";
import { ensureConnectorRows } from "@/lib/connectors";
import { eq } from "drizzle-orm";

/**
 * Inbound lead webhook for GoHighLevel / Automatic Members / Zen Planner Engage.
 * Configure the CRM workflow to POST contact JSON here with the shared secret:
 *   POST /api/webhooks/crm
 *   Header: x-webhook-secret: $CRM_WEBHOOK_SECRET
 * Accepted payload fields (flexible): full_name | name | first_name+last_name,
 * phone, email, source, contact_source, date_created.
 */
export async function POST(req: Request) {
  const secret = process.env.CRM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Webhook disabled: CRM_WEBHOOK_SECRET is not set on the server." },
      { status: 503 }
    );
  }
  const provided =
    req.headers.get("x-webhook-secret") ??
    new URL(req.url).searchParams.get("secret");
  if (provided !== secret) {
    return Response.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const s = (k: string) => {
    const v = payload[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const name =
    s("full_name") || s("name") || [s("first_name"), s("last_name")].filter(Boolean).join(" ");
  if (!name) {
    return Response.json({ error: "Payload has no contact name" }, { status: 400 });
  }

  const sourceRaw = (s("source") || s("contact_source") || "other").toLowerCase();
  const known = ["referral", "reactivation", "community", "website", "paid_ads", "organic_social"];
  const source = known.find((k) => sourceRaw.includes(k.replace("_", " ")) || sourceRaw.includes(k)) ?? "other";

  const nowIso = new Date().toISOString();
  db.insert(leads)
    .values({
      name,
      phone: s("phone") || null,
      email: s("email") || null,
      source,
      stage: "new",
      createdAt: s("date_created") || nowIso,
      notes: "Created by CRM webhook",
    })
    .run();

  ensureConnectorRows();
  const crm = db.select().from(connectors).where(eq(connectors.key, "crm")).get();
  if (crm) {
    db.insert(syncRuns)
      .values({
        connectorId: crm.id,
        startedAt: nowIso,
        finishedAt: nowIso,
        status: "success",
        trigger: "webhook",
        recordsProcessed: 1,
        recordsRejected: 0,
        message: `Webhook lead: ${name}`,
      })
      .run();
    db.update(connectors)
      .set({ lastSyncAt: nowIso, lastSyncStatus: "success" })
      .where(eq(connectors.id, crm.id))
      .run();
  }

  return Response.json({ ok: true });
}
