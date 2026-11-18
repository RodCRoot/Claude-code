import { db } from "@/db";
import { can, type Viewer } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { recentZpWebhookEvents, ZP_WEBHOOK_SECRET_ENV, zpWebhookConfig, zpWebhookStatus } from "@/lib/zenplanner/webhooks";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, Select, Table, Td, Th } from "@/components/ui";
import { saveWebhookConfigAction, stageWebhookAction } from "../../imports/zenplanner/actions";

/** Settings → Integrations: Zen Planner webhook receiver (URLs to paste, on/off, last received, counts). */
export async function ZenPlannerWebhooksCard({ viewer }: { viewer: Viewer }) {
  const [cfg, feeds, recent] = await Promise.all([zpWebhookConfig(db, viewer.orgId), zpWebhookStatus(db, viewer), recentZpWebhookEvents(db, viewer, 5)]);
  const secretSet = !!process.env[ZP_WEBHOOK_SECRET_ENV];
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const canStage = can(viewer, "imports.manage");
  const suffix = cfg.secretIn === "query" ? `?${cfg.secretName}=<shared secret>` : "";

  return (
    <Card className="mt-5" id="zenplanner-webhooks">
      <CardHeader
        title="Zen Planner webhooks (transition)"
        kicker="Receive only"
        action={
          <div className="flex gap-1">
            <Badge variant={cfg.enabled ? "green" : "neutral"}>{cfg.enabled ? "on" : "off"}</Badge>
            <Badge variant={secretSet ? "green" : "yellow"}>{secretSet ? "secret set" : "secret not set"}</Badge>
          </div>
        }
      />
      <CardBody className="space-y-4 text-sm">
        <p className="text-ink-2">
          Zen Planner can push People, Class Sessions and Attendance / RSVP changes to a URL (Setup → Webhooks in Zen Planner: a URL, an Account ID and a Shared Secret per feed). While both systems run side by side this keeps the hub current without anyone logging in to Zen Planner. Deliveries are stored, then staged into the Import Center, where the same review, commit and revert steps apply. The hub never sends anything to Zen Planner.
        </p>
        <Callout tone="warn" title="Not verified against a real delivery">
          How Zen Planner presents the shared secret and what the payload looks like are not documented in the account map and have never been observed here. The receiver accepts the secret as a header or as a query value (choose below) and does not check a body signature. After the first real delivery, look at &ldquo;Recent deliveries&rdquo; to confirm it arrived and what it contained.
        </Callout>
        {!secretSet ? (
          <Callout tone="info" title="Shared secret is a server setting">
            Set <code>{ZP_WEBHOOK_SECRET_ENV}</code> on the server to the same Shared Secret you type into Zen Planner. It is never stored in the database or shown here. The receiver cannot be turned on without it.
          </Callout>
        ) : null}

        <Table caption="Zen Planner webhook feeds">
          <thead>
            <tr>
              <Th>Feed</Th>
              <Th>URL to paste into Zen Planner</Th>
              <Th>Last received</Th>
              <Th align="right">Last 24 h</Th>
              <Th align="right">Total</Th>
              <Th align="right">Waiting</Th>
              <Th>Import</Th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.feed}>
                <Td>{f.label}</Td>
                <Td>
                  <code className="break-all text-xs">
                    {base || "https://<this site>"}
                    {f.path}
                    {suffix}
                  </code>
                </Td>
                <Td>{f.lastReceivedAt ? fmt(f.lastReceivedAt) : "never"}</Td>
                <Td align="right">{f.last24h}</Td>
                <Td align="right">{f.total}</Td>
                <Td align="right">{f.importable ? f.waiting : ""}</Td>
                <Td>
                  {!f.importable ? (
                    <span className="text-xs text-ink-3">Kept for inspection only</span>
                  ) : f.waiting && canStage ? (
                    <ActionForm action={stageWebhookAction}>
                      <input type="hidden" name="feed" value={f.feed} />
                      <SubmitButton size="sm" variant="outline" pendingText="Staging…">
                        {`Stage ${f.waiting} for review`}
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    <span className="text-xs text-ink-3">Nothing waiting</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!base ? <p className="text-xs text-ink-3">APP_URL is not set, so the site address is shown as a placeholder.</p> : null}

        <ActionForm action={saveWebhookConfigAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <label className="flex min-h-10 items-center gap-2 sm:col-span-2 lg:col-span-4">
            <input type="checkbox" name="enabled" defaultChecked={cfg.enabled} className="size-4" />
            <span>Receive Zen Planner webhooks (off by default; while off the URLs answer &ldquo;not found&rdquo; and nothing is stored)</span>
          </label>
          <Field label="Shared secret arrives as" htmlFor="zp-secretIn">
            <Select id="zp-secretIn" name="secretIn" defaultValue={cfg.secretIn}>
              <option value="header">A request header</option>
              <option value="query">A value in the URL</option>
            </Select>
          </Field>
          <Field label="Header or parameter name" htmlFor="zp-secretName" hint="Letters, digits, dashes, underscores.">
            <Input id="zp-secretName" name="secretName" defaultValue={cfg.secretName} maxLength={64} autoComplete="off" />
          </Field>
          <Field label="Zen Planner Account ID" htmlFor="zp-accountId" hint="Optional. Deliveries stating another account are refused.">
            <Input id="zp-accountId" name="accountId" defaultValue={cfg.accountId ?? ""} maxLength={100} autoComplete="off" />
          </Field>
          <Field label="Deliveries per minute, per feed" htmlFor="zp-perMinute">
            <Input id="zp-perMinute" name="perMinute" inputMode="numeric" defaultValue={cfg.perMinute} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <SubmitButton>Save webhook settings</SubmitButton>
          </div>
        </ActionForm>

        <div>
          <h3 className="mb-1 text-sm font-semibold">Recent deliveries</h3>
          {recent.length === 0 ? (
            <p className="text-ink-3">None received yet.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {recent.map((e) => (
                <li key={e.id} className="py-2">
                  <span className="font-medium">{e.feed}</span> · {fmt(e.receivedAt)} · {e.records} record(s) · <Badge>{e.status}</Badge>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-ink-3">Stored payload (passwords, payment and health fields removed)</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-2 p-2 text-xs" tabIndex={0}>
                      {JSON.stringify(e.payload, null, 2).slice(0, 4000)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
