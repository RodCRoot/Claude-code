import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { hawkinOverview } from "@/lib/integrations/hawkin/sync";
import { fmt, todayLocal, addDaysYmd } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, NotConfigured, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { hawkinOptionsAction, hawkinSyncAction } from "../actions";
import { ImportTabs } from "../tabs";

export const metadata = { title: "Hawkin API sync" };

const unix = (n: unknown) => (typeof n === "number" || (typeof n === "string" && /^\d+$/.test(n)) ? fmt(new Date(Number(n) * 1000)) : "—");

export default async function HawkinPage() {
  const v = await requireCap("imports.manage");
  const o = await hawkinOverview(db, v);
  const cp = o.integration.checkpoint as Record<string, unknown>;
  const hasCheckpoint = cp.lastSyncTime !== undefined || cp.historicalThrough !== undefined;
  const today = todayLocal();

  return (
    <>
      <PageHeader
        kicker="Import Center"
        title="Hawkin Dynamics API sync"
        description="Pulls force-plate tests from the Hawkin Cloud API into the same staged import pipeline as file uploads, so new athletes go through identity review before anything is written."
      />
      <ImportTabs current="hawkin" />

      {!o.configured ? (
        <NotConfigured provider="Hawkin Dynamics" envVars={o.envVars}>
          No Hawkin refresh token is set, so no sync can run and none is claimed to work. An org admin creates the token in Hawkin Cloud → Settings → Integrations. EU/APAC organizations also set HAWKIN_API_BASE (https://eu.cloud.hawkindynamics.com/api or https://apac.cloud.hawkindynamics.com/api). Until then, use the Hawkin Cloud CSV export on the Imports tab.
        </NotConfigured>
      ) : (
        <Callout tone={o.integration.status === "connected" ? "ok" : o.integration.status === "error" ? "bad" : "info"} title={`Status: ${o.integration.status.replaceAll("_", " ")}`}>
          API base {o.baseUrl}. {o.integration.status === "connected" ? `Last successful contact ${fmt(o.integration.lastCheckedAt)}.` : "Not verified yet — run a sync to check the credentials."}
          {o.integration.lastError ? <span className="mt-1 block text-bad">Last error: {o.integration.lastError}</span> : null}
        </Callout>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader kicker="Historical" title="Import a date window" />
          <CardBody>
            <p className="mb-3 text-sm text-ink-3">Fetches tests by their original creation date (from/to), in chunks of up to 30 days, including inactive athletes and tests.</p>
            <ActionForm action={hawkinSyncAction} className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <input type="hidden" name="mode" value="historical" />
              <Field label="From" htmlFor="from" required>
                <Input id="from" name="from" type="date" defaultValue={addDaysYmd(today, -90)} required />
              </Field>
              <Field label="To" htmlFor="to" required>
                <Input id="to" name="to" type="date" defaultValue={today} required />
              </Field>
              <Field label="Chunk (days)" htmlFor="chunkDays">
                <Input id="chunkDays" name="chunkDays" type="number" min={1} max={90} defaultValue={30} />
              </Field>
              <div className="sm:col-span-3">
                {o.configured ? <SubmitButton pendingText="Fetching from Hawkin…">Run historical import</SubmitButton> : <p className="text-sm text-warn">Needs HAWKIN_REFRESH_TOKEN on the server.</p>}
              </div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader kicker="Incremental" title="Sync changes since last checkpoint" />
          <CardBody>
            <dl className="mb-3 grid grid-cols-2 gap-1 text-sm">
              <dt className="text-ink-3">Last incremental checkpoint</dt>
              <dd>{unix(cp.lastSyncTime)}</dd>
              <dt className="text-ink-3">Historical imported through</dt>
              <dd>{unix(cp.historicalThrough)}</dd>
            </dl>
            <p className="mb-3 text-sm text-ink-3">
              Uses syncFrom/syncTo (tests created or modified). Hawkin does not allow those with team/group/athlete/test-type filters, so filters are applied here after fetching. The checkpoint only advances after the resulting import is committed.
            </p>
            <ActionForm action={hawkinSyncAction}>
              <input type="hidden" name="mode" value="incremental" />
              {!o.configured ? (
                <p className="text-sm text-warn">Needs HAWKIN_REFRESH_TOKEN on the server.</p>
              ) : !hasCheckpoint ? (
                <p className="text-sm text-warn">Run and commit a historical import first; it sets the starting checkpoint.</p>
              ) : (
                <SubmitButton pendingText="Syncing…">Sync now</SubmitButton>
              )}
            </ActionForm>
            <ActionForm action={hawkinOptionsAction} className="mt-5 space-y-2 border-t border-edge pt-4">
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <input type="checkbox" name="autoCommit" defaultChecked={o.integration.autoCommit} /> Commit automatically when every athlete is already linked (no review needed)
              </label>
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <input type="checkbox" name="fetchForceTime" defaultChecked={o.integration.fetchForceTime} /> Archive raw force-time curves (one extra request per new test; 1000 Hz JSON)
              </label>
              <SubmitButton variant="outline" size="sm">
                Save options
              </SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Sync runs" />
        <CardBody>
          {o.runs.length === 0 ? (
            <EmptyState title="No sync runs yet" />
          ) : (
            <Table caption="Hawkin sync runs">
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>Kind</Th>
                  <Th>Status</Th>
                  <Th>Counts</Th>
                  <Th>Warnings</Th>
                  <Th>Import</Th>
                </tr>
              </thead>
              <tbody>
                {o.runs.map((r) => {
                  const after = (r.cursorAfter ?? {}) as { warnings?: string[] };
                  return (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap">{fmt(r.startedAt, "MMM d, h:mm a")}</Td>
                      <Td>{r.kind}</Td>
                      <Td>
                        <StatusBadge status={r.status === "partial" ? "needs_review" : r.status} />
                      </Td>
                      <Td className="text-xs">
                        {Object.entries(r.counts)
                          .map(([k, n]) => `${k} ${n}`)
                          .join(" · ")}
                        {r.error ? <div className="text-bad">{r.error}</div> : null}
                      </Td>
                      <Td className="max-w-sm text-xs">
                        {after.warnings?.length ? (
                          <details>
                            <summary className="cursor-pointer">
                              <Badge variant="yellow">{after.warnings.length}</Badge>
                            </summary>
                            <ul className="mt-1 list-disc pl-4">
                              {after.warnings.slice(0, 20).map((w) => (
                                <li key={w}>{w}</li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        {r.importBatchId ? (
                          <Link href={`/imports/${r.importBatchId}`} className="text-brand underline">
                            open
                          </Link>
                        ) : (
                          "—"
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}
