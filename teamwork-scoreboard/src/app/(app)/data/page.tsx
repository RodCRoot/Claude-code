import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { ensureConnectorRows } from "@/lib/connectors";
import { runSyncNow } from "@/app/actions/data";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  ButtonLink,
  Table,
} from "@/components/ui";

export const metadata = { title: "Data & Sync" };

const STATUS_BADGE: Record<string, "green" | "yellow" | "red" | "neutral"> = {
  ready: "green",
  not_configured: "yellow",
  error: "red",
  disabled: "neutral",
};

export default async function DataPage() {
  await requireUser("manage_imports");
  ensureConnectorRows();

  const rows = db.all<{
    id: number;
    key: string;
    name: string;
    description: string | null;
    mode: string;
    status: string;
    env_vars: string;
    config_note: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    sync_interval_minutes: number;
  }>(sql`SELECT * FROM connectors ORDER BY id`);

  const history = db.all<{
    id: number;
    connector: string;
    started_at: string;
    status: string;
    trigger: string;
    records_processed: number;
    records_rejected: number;
    message: string | null;
  }>(sql`
    SELECT s.id, c.name AS connector, s.started_at, s.status, s.trigger,
      s.records_processed, s.records_rejected, s.message
    FROM sync_runs s JOIN connectors c ON c.id = s.connector_id
    ORDER BY s.started_at DESC LIMIT 40
  `);

  const mappings = db.all<{ id: number; name: string; target_entity: string; created_at: string }>(
    sql`SELECT id, name, target_entity, created_at FROM import_mappings ORDER BY created_at DESC LIMIT 20`
  );

  return (
    <>
      <PageHeader
        kicker="Integrations"
        title="Data & Sync"
        subtitle="Connector status is honest: nothing shows as connected until real credentials are configured and verified."
        actions={<ButtonLink href="/data/import">Import CSV / Google Sheets</ButtonLink>}
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {rows.map((c) => {
          const envVars: string[] = JSON.parse(c.env_vars || "[]");
          const missing = envVars.filter((v) => !process.env[v]);
          return (
            <Card key={c.id}>
              <CardHeader
                kicker={c.mode.toUpperCase()}
                title={c.name}
                action={<Badge variant={STATUS_BADGE[c.status] ?? "neutral"}>{c.status.replace("_", " ")}</Badge>}
              />
              <CardBody className="space-y-2 text-sm">
                <p className="text-ink-2">{c.description}</p>
                {envVars.length > 0 && (
                  <p className="text-xs text-ink-3">
                    Env vars:{" "}
                    {envVars.map((v) => (
                      <code
                        key={v}
                        className={`mr-1 rounded px-1 py-0.5 ${missing.includes(v) ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}
                      >
                        {v}
                        {missing.includes(v) ? " (missing)" : " ✓"}
                      </code>
                    ))}
                  </p>
                )}
                {c.config_note && <p className="text-xs text-ink-3">{c.config_note}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-xs text-ink-3">
                    Last sync:{" "}
                    {c.last_sync_at
                      ? `${c.last_sync_at.slice(0, 16).replace("T", " ")} (${c.last_sync_status})`
                      : "never"}
                    {" · "}every {c.sync_interval_minutes >= 1440 ? `${c.sync_interval_minutes / 1440}d` : `${c.sync_interval_minutes}m`} when configured
                  </span>
                  {c.mode === "api" ? (
                    <form action={runSyncNow}>
                      <input type="hidden" name="connectorKey" value={c.key} />
                      <Button size="sm" variant="secondary" type="submit">
                        Sync now
                      </Button>
                    </form>
                  ) : (
                    <ButtonLink size="sm" variant="secondary" href="/data/import">
                      Import
                    </ButtonLink>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <Card className="mb-6">
        <CardHeader kicker="Audit trail" title="Sync history" />
        <CardBody>
          <Table
            columns={["When", "Connector", "Trigger", "Status", "In", "Rejected", "Message", ""]}
            rows={history.map((h) => [
              h.started_at.slice(0, 16).replace("T", " "),
              h.connector,
              h.trigger,
              <Badge
                key="s"
                variant={h.status === "success" ? "green" : h.status === "partial" ? "yellow" : "red"}
              >
                {h.status}
              </Badge>,
              h.records_processed,
              h.records_rejected,
              <span key="m" className="block max-w-md whitespace-normal text-xs text-ink-3">
                {h.message ?? "—"}
              </span>,
              h.status === "error" ? (
                <form key="r" action={runSyncNow}>
                  <input
                    type="hidden"
                    name="connectorKey"
                    value={rows.find((r) => r.name === h.connector)?.key ?? ""}
                  />
                  <Button size="sm" variant="ghost" type="submit">Retry</Button>
                </form>
              ) : (
                ""
              ),
            ])}
            empty="No sync runs recorded yet."
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader kicker="Reusable" title="Saved field mappings" />
          <CardBody>
            <Table
              columns={["Name", "Target", "Saved"]}
              rows={mappings.map((m) => [m.name, m.target_entity, m.created_at.slice(0, 10)])}
              empty="No saved mappings yet — created automatically when you name a mapping during import."
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader kicker="Real-time" title="CRM webhook endpoint" />
          <CardBody className="space-y-2 text-sm text-ink-2">
            <p>
              Point a GoHighLevel / Automatic Members / ZP Engage workflow at:
            </p>
            <code className="block rounded-lg bg-surface-3 px-3 py-2 text-xs">
              POST /api/webhooks/crm — header <b>x-webhook-secret</b>: value of{" "}
              <b>CRM_WEBHOOK_SECRET</b>
            </code>
            <p className="text-xs text-ink-3">
              New contacts arrive as leads instantly and appear in sync history. The
              endpoint stays disabled until CRM_WEBHOOK_SECRET is set — no secret, no
              ingestion.
            </p>
            <p className="text-xs text-ink-3">
              Scheduled syncs: point any scheduler at <code>/api/cron</code> with{" "}
              <code>CRON_SECRET</code> (see README → Deployment).
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
