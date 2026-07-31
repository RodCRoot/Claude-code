import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connectors, syncRuns } from "@/db/schema";

/**
 * Connector adapter framework.
 *
 * Design principle: NEVER pretend an integration is live. Each adapter
 * declares the environment variables it needs; until they are present the
 * connector reports `not_configured` and a "Sync Now" produces an honest
 * error entry in sync history explaining exactly what is missing.
 *
 * When credentials become available, implement the adapter's `sync()` to
 * pull records and upsert into the operational tables, returning counts.
 */

export interface SyncResult {
  processed: number;
  rejected: number;
  skipped?: number;
  message?: string;
}

export interface ConnectorAdapter {
  key: string;
  name: string;
  description: string;
  mode: "api" | "browser" | "webhook" | "sheets" | "csv" | "manual";
  envVars: string[];
  docs?: string;
  /** Throws with a clear message when not usable; returns counts on success. */
  sync(): Promise<SyncResult>;
}

/** Connector modes that can be driven by Sync Now and the cron scheduler. */
export const SYNCABLE_MODES = ["api", "browser"];

function missingEnv(vars: string[]): string[] {
  return vars.filter((v) => !process.env[v]);
}

class NotConfiguredError extends Error {}

export const ADAPTERS: ConnectorAdapter[] = [
  {
    key: "zen_planner",
    name: "Zen Planner (scheduled browser sync)",
    description:
      "Authoritative source for memberships, billing, attendance, scheduling, and client records. " +
      "No public API is available, so a headless Chrome session signs in on a schedule and pulls " +
      "the report exports configured in Admin → Settings.",
    mode: "browser",
    envVars: ["ZEN_PLANNER_EMAIL", "ZEN_PLANNER_PASSWORD"],
    docs:
      "Set staff-login credentials in .env, then configure report jobs in Admin → Settings → " +
      "“Zen Planner scrape jobs” (report URL + export link + saved mapping). Failures record the " +
      "reason here and save a screenshot under data/debug/. Repeated pulls dedupe automatically.",
    async sync() {
      const missing = missingEnv(this.envVars);
      if (missing.length > 0) {
        throw new NotConfiguredError(
          `Zen Planner browser sync is not connected: missing ${missing.join(", ")}. ` +
            "Add the staff-login credentials to .env, or use the CSV import fallback (Data → Import)."
        );
      }
      const { runZenPlannerScrape } = await import("./zenplanner-scraper");
      try {
        return await runZenPlannerScrape();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("Not configured:")) throw new NotConfiguredError(msg);
        throw e;
      }
    },
  },
  {
    key: "crm",
    name: "CRM (GoHighLevel / Automatic Members / ZP Engage)",
    description:
      "Authoritative source for leads, messaging, automations, and pipeline activity.",
    mode: "api",
    envVars: ["CRM_API_KEY", "CRM_LOCATION_ID"],
    docs: "Supports inbound webhooks now: point your CRM workflow at POST /api/webhooks/crm with the shared secret. Direct API pull requires an API key.",
    async sync() {
      const missing = missingEnv(this.envVars);
      if (missing.length > 0) {
        throw new NotConfiguredError(
          `CRM is not connected: missing ${missing.join(", ")}. ` +
            "New leads can still arrive in real time via the webhook endpoint " +
            "(/api/webhooks/crm) or the CSV import fallback."
        );
      }
      throw new Error(
        "CRM credentials detected, but the API adapter has not been verified " +
          "against a live account. Implement sync() in src/lib/connectors.ts before enabling."
      );
    },
  },
  {
    key: "teambuildr",
    name: "TeamBuildr",
    description: "Athlete programming. Used to confirm program assignment during onboarding.",
    mode: "api",
    envVars: ["TEAMBUILDR_API_KEY"],
    docs: "TeamBuildr has no public API; onboarding tracks program assignment manually until an export path exists.",
    async sync() {
      throw new NotConfiguredError(
        "TeamBuildr has no public API. Track program assignment via the onboarding checklist, " +
          "or import a roster CSV through the import wizard."
      );
    },
  },
  {
    key: "google_sheets",
    name: "Google Sheets",
    description:
      "Import ranges from shared Google Sheets (temporary data entry and legacy spreadsheets).",
    mode: "sheets",
    envVars: [],
    docs: "Works today for sheets shared as 'anyone with the link can view': paste the sheet URL in the import wizard.",
    async sync() {
      throw new NotConfiguredError(
        "Google Sheets imports run from the import wizard (Data → Import → Google Sheets URL), " +
          "not from Sync Now. Saved sheet imports can be re-run there."
      );
    },
  },
  {
    key: "csv",
    name: "CSV / Email Report Import",
    description:
      "Upload CSV exports (Zen Planner reports, CRM exports, Gmail-delivered reports).",
    mode: "csv",
    envVars: [],
    docs: "Fully working: Data → Import. Field mappings are saved for reuse.",
    async sync() {
      throw new NotConfiguredError(
        "CSV imports run from the import wizard (Data → Import), not from Sync Now."
      );
    },
  },
];

/** Ensure a DB row exists per adapter, with live configured-status. */
export function ensureConnectorRows(): void {
  for (const a of ADAPTERS) {
    const existing = db.select().from(connectors).where(eq(connectors.key, a.key)).get();
    const configured = a.envVars.length > 0 && missingEnv(a.envVars).length === 0;
    if (!existing) {
      db.insert(connectors)
        .values({
          key: a.key,
          name: a.name,
          description: a.description,
          mode: a.mode,
          status:
            a.mode === "csv" || a.mode === "sheets"
              ? "ready"
              : configured
              ? "ready"
              : "not_configured",
          envVars: JSON.stringify(a.envVars),
          configNote: a.docs,
          syncIntervalMinutes: a.key === "crm" ? 60 : 1440,
        })
        .run();
    } else {
      // keep configured-status current as env changes
      const shouldBe =
        a.mode === "csv" || a.mode === "sheets"
          ? existing.status === "error"
            ? "error"
            : "ready"
          : configured
          ? existing.status === "error"
            ? "error"
            : "ready"
          : "not_configured";
      const metaChanged =
        existing.name !== a.name ||
        existing.mode !== a.mode ||
        existing.description !== a.description ||
        existing.configNote !== (a.docs ?? null) ||
        existing.envVars !== JSON.stringify(a.envVars);
      if (
        (existing.status !== shouldBe && existing.status !== "disabled") ||
        metaChanged
      ) {
        db.update(connectors)
          .set({
            name: a.name,
            description: a.description,
            mode: a.mode,
            envVars: JSON.stringify(a.envVars),
            configNote: a.docs ?? null,
            ...(existing.status !== "disabled" ? { status: shouldBe } : {}),
          })
          .where(eq(connectors.id, existing.id))
          .run();
      }
    }
  }
}

/** Run a connector sync, recording an honest sync-history entry either way. */
export async function runSync(
  connectorKey: string,
  trigger: "manual" | "scheduled" | "webhook" | "import"
): Promise<{ ok: boolean; message: string }> {
  ensureConnectorRows();
  const row = db.select().from(connectors).where(eq(connectors.key, connectorKey)).get();
  const adapter = ADAPTERS.find((a) => a.key === connectorKey);
  if (!row || !adapter) return { ok: false, message: "Unknown connector" };

  const startedAt = new Date().toISOString();
  try {
    const result = await adapter.sync();
    db.insert(syncRuns)
      .values({
        connectorId: row.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: result.rejected > 0 ? "partial" : "success",
        trigger,
        recordsProcessed: result.processed,
        recordsRejected: result.rejected,
        message: result.message ?? null,
      })
      .run();
    db.update(connectors)
      .set({ lastSyncAt: new Date().toISOString(), lastSyncStatus: "success" })
      .where(eq(connectors.id, row.id))
      .run();
    return { ok: true, message: result.message ?? "Sync complete" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isConfig = e instanceof NotConfiguredError;
    db.insert(syncRuns)
      .values({
        connectorId: row.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "error",
        trigger,
        recordsProcessed: 0,
        recordsRejected: 0,
        message,
      })
      .run();
    db.update(connectors)
      .set({ lastSyncStatus: isConfig ? "not_configured" : "error" })
      .where(eq(connectors.id, row.id))
      .run();
    return { ok: false, message };
  }
}

/** Record a successful import as a sync run against a connector. */
export function recordImportRun(
  connectorKey: string,
  processed: number,
  rejected: number,
  message: string
): void {
  ensureConnectorRows();
  const row = db.select().from(connectors).where(eq(connectors.key, connectorKey)).get();
  if (!row) return;
  const t = new Date().toISOString();
  db.insert(syncRuns)
    .values({
      connectorId: row.id,
      startedAt: t,
      finishedAt: t,
      status: rejected > 0 ? "partial" : "success",
      trigger: "import",
      recordsProcessed: processed,
      recordsRejected: rejected,
      message,
    })
    .run();
  db.update(connectors)
    .set({ lastSyncAt: t, lastSyncStatus: rejected > 0 ? "partial" : "success" })
    .where(eq(connectors.id, row.id))
    .run();
}
