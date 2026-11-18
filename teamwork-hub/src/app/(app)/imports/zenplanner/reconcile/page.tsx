import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
import { explain, hubCounts, hubFromSnapshot, listReconciliations, RECON_FIELDS, type ReconKey, type ReconLine } from "@/lib/zenplanner/reconcile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ImportTabs } from "../../tabs";
import { saveReconciliationAction } from "../actions";

export const metadata = { title: "Zen Planner reconciliation" };

const show = (l: ReconLine, v: number | null) => (v == null ? "not entered" : l.money ? formatMoney(v) : String(v));

function Lines({ lines, caption }: { lines: ReconLine[]; caption: string }) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>Figure</Th>
          <Th align="right">Zen Planner (typed in)</Th>
          <Th align="right">Hub</Th>
          <Th align="right">Difference (hub minus Zen Planner)</Th>
          <Th>Likely reasons</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <Td>{l.label}</Td>
            <Td align="right">{show(l, l.entered)}</Td>
            <Td align="right">{l.hub == null ? "not available" : l.money ? formatMoney(l.hub) : l.hub}</Td>
            <Td align="right">
              {l.difference == null ? "" : l.difference === 0 ? <Badge variant="green">matches</Badge> : <span className="font-semibold">{l.money ? formatMoney(l.difference) : (l.difference > 0 ? "+" : "") + l.difference}</span>}
            </Td>
            <Td className="text-xs">
              {l.reasons.length ? (
                <ul className="list-disc space-y-1 pl-4">
                  {l.reasons.map((r) => (
                    <li key={r.text}>
                      {r.exact ? <Badge variant="blue">explains the whole gap</Badge> : null} {r.text}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function ZpReconcilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireCap("imports.manage");
  const sp = await searchParams;
  const batchParam = typeof sp.batch === "string" ? sp.batch : "";
  const today = todayLocal();
  const [hub, saved, batches] = await Promise.all([
    hubCounts(db, v.orgId, today),
    listReconciliations(db, v),
    db
      .select({ id: importBatches.id, filename: importBatches.originalFilename, entityType: importBatches.entityType, committedAt: importBatches.committedAt })
      .from(importBatches)
      .where(and(eq(importBatches.orgId, v.orgId), eq(importBatches.source, "zenplanner"), eq(importBatches.status, "committed")))
      .orderBy(desc(importBatches.committedAt))
      .limit(30),
  ]);

  return (
    <>
      <PageHeader
        kicker="Zen Planner import"
        title="Reconciliation"
        description="Type in the figures from Zen Planner's dashboard and compare them with what the hub holds after an import. Zen Planner's own reports disagree with each other from day to day, so a difference is normal: the point is to know why."
      />
      <ImportTabs current="zenplanner" />
      {sp.saved ? (
        <Callout tone="ok" className="mb-4">
          <span role="status">Saved. The comparison is at the top of the history below.</span>
        </Callout>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="The hub right now" kicker={`As of ${fmtDate(today)}`} />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-3">Active members (athletes with a current membership)</dt>
              <dd className="text-right font-semibold">{hub.activeMembers}</dd>
              <dt className="text-ink-3">Memberships (active, trial, past due, on hold)</dt>
              <dd className="text-right font-semibold">{hub.memberships}</dd>
              <dt className="text-ink-3">On hold</dt>
              <dd className="text-right font-semibold">{hub.onHold}</dd>
              <dt className="text-ink-3">Past due on imported Zen Planner bills</dt>
              <dd className="text-right font-semibold">{hub.pastDueMinor == null ? "no bills imported" : formatMoney(hub.pastDueMinor)}</dd>
              <dt className="text-ink-3">People marked active</dt>
              <dd className="text-right">{hub.peopleActive}</dd>
              <dt className="text-ink-3">Prospects</dt>
              <dd className="text-right">{hub.prospects}</dd>
              <dt className="text-ink-3">Alumni / inactive</dt>
              <dd className="text-right">{hub.alumni}</dd>
              <dt className="text-ink-3">Active athletes with no current membership</dt>
              <dd className="text-right">{hub.activeWithoutMembership}</dd>
            </dl>
            {Object.keys(hub.membersByLocation).length ? (
              <p className="mt-3 text-xs text-ink-3">
                Active members by Zen Planner Primary Location:{" "}
                {Object.entries(hub.membersByLocation)
                  .map(([k, c]) => `${k} ${c}`)
                  .join(" · ")}
              </p>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Numbers from Zen Planner's dashboard" />
          <CardBody>
            <ActionForm action={saveReconciliationAction} className="grid gap-3 sm:grid-cols-2">
              <Field label="Import this is about" htmlFor="batchId" className="sm:col-span-2" hint="Optional. Ties the comparison to one committed Zen Planner import.">
                <Select id="batchId" name="batchId" defaultValue={batches.some((b) => b.id === batchParam) ? batchParam : ""}>
                  <option value="">Not tied to one import</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {(b.filename ?? "Import") + " · " + b.entityType.replace("zenplanner.", "") + " · " + fmt(b.committedAt)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date the numbers were read" htmlFor="asOf">
                <Input id="asOf" name="asOf" type="date" defaultValue={today} />
              </Field>
              <div className="hidden sm:block" />
              {RECON_FIELDS.map((f) => (
                <Field key={f.key} label={f.money ? `${f.label} ($)` : f.label} htmlFor={f.key} hint="Leave empty if you did not read it.">
                  <Input id={f.key} name={f.key} inputMode={f.money ? "decimal" : "numeric"} autoComplete="off" />
                </Field>
              ))}
              <Field label="Note" htmlFor="note" className="sm:col-span-2" hint="For example which Zen Planner report or filter the numbers came from.">
                <Input id="note" name="note" maxLength={500} />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton>Compare and save</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <h2 className="mb-3 text-lg font-semibold">History</h2>
      {saved.length === 0 ? (
        <p className="text-sm text-ink-3">No comparisons saved yet.</p>
      ) : (
        saved.map(({ r, filename, entityType }) => {
          const lines = explain(r.entered as Partial<Record<ReconKey, number | null>>, hubFromSnapshot(r.hub));
          return (
            <Card key={r.id} className="mb-4">
              <CardHeader
                title={`As of ${fmtDate(r.asOf)}`}
                kicker={filename ? `${filename} · ${(entityType ?? "").replace("zenplanner.", "")}` : "Not tied to one import"}
                action={<span className="text-xs text-ink-3">saved {fmt(r.createdAt)}</span>}
              />
              <CardBody>
                {r.note ? <p className="mb-2 text-sm">Note: {r.note}</p> : null}
                <Lines lines={lines} caption={`Comparison as of ${r.asOf}`} />
                <p className="mt-2 text-xs text-ink-3">Hub figures are the ones held when this comparison was saved.</p>
              </CardBody>
            </Card>
          );
        })
      )}
    </>
  );
}
