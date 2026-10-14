import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations, syncRuns } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { integrationEnvVars, isDemoMode } from "@/lib/env";
import { INTEGRATION_INFO } from "@/lib/settings";
import { fmt } from "@/lib/time";
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader, StatusBadge } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { recheckIntegrationsAction } from "../actions";

export const metadata = { title: "Integrations" };

const STATUS_HELP: Record<string, string> = {
  not_configured: "Required server settings are missing. The rest of the Hub works without it.",
  configured_unverified: "Settings are present but no successful sandbox/live check has been recorded. Not treated as working.",
  verified_sandbox: "A sandbox round-trip succeeded. Live mode still needs production review.",
  connected: "Working.",
  error: "Last attempt failed — see the error.",
  disabled: "Turned off.",
};

export default async function IntegrationsPage() {
  const v = await requireCap("integrations.manage");
  const rows = await db.select().from(integrations).where(eq(integrations.orgId, v.orgId)).orderBy(asc(integrations.provider));
  const runs = await db.select().from(syncRuns).where(eq(syncRuns.orgId, v.orgId)).orderBy(asc(syncRuns.startedAt)).limit(20);
  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Integrations"
        description="Honest status for every external connection. Secrets are server environment variables only — they are never stored in the database or shown here."
        actions={
          <form action={recheckIntegrationsAction}>
            <button className="min-h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink" type="submit">
              Re-check configuration
            </button>
          </form>
        }
      />
      <SettingsTabs current="integrations" />
      {isDemoMode() ? (
        <Callout tone="info" className="mb-5" title="Demo / build mode">
          Outgoing email/SMS stays off unless <code>DELIVERY_ENABLED=true</code>. No live charges, refunds, or subscriptions are created during the build.
        </Callout>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => {
          const info = INTEGRATION_INFO[r.provider];
          return (
            <Card key={r.id}>
              <CardHeader
                title={info?.label ?? r.provider}
                action={
                  <div className="flex gap-1">
                    <StatusBadge status={r.status} />
                    {r.mode !== "none" ? <Badge>{r.mode}</Badge> : null}
                  </div>
                }
              />
              <CardBody className="space-y-2 text-sm">
                <p className="text-ink-2">{info?.purpose}</p>
                <p className="text-xs text-ink-3">{r.provider === "teambuildr" || r.provider === "zenplanner" ? "File-based: import exported reports in the Import Center. No live connection is assumed or claimed." : STATUS_HELP[r.status]}</p>
                {integrationEnvVars[r.provider] ? (
                  <p className="flex flex-wrap items-center gap-1 text-xs">
                    Server variables:{" "}
                    {integrationEnvVars[r.provider].map((n) => (
                      <code key={n} className="break-all rounded bg-surface-2 px-1">
                        {n}
                      </code>
                    ))}
                  </p>
                ) : null}
                {r.lastError ? <p className="text-xs text-bad">{r.lastError}</p> : null}
                <p className="text-xs text-ink-3">Last checked: {r.lastCheckedAt ? fmt(r.lastCheckedAt) : "never"}</p>
                {info?.module ? (
                  <Link href={info.module} className="text-xs text-brand underline">
                    Open related settings
                  </Link>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
      <Card className="mt-5">
        <CardHeader title="Recent sync runs" />
        <CardBody>
          {runs.length === 0 ? (
            <p className="text-sm text-ink-3">No sync runs yet.</p>
          ) : (
            <ul className="divide-y divide-edge text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {r.provider} · {r.kind}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-ink-3">
                    {fmt(r.startedAt)} <StatusBadge status={r.status} />
                  </span>
                  {r.error ? <span className="w-full text-xs text-bad">{r.error}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
