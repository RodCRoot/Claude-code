import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, importRows, people } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { UserError } from "@/lib/actions";
import { getBatch, listPresets, loadBatchFile, reviewGroups } from "@/lib/imports/batches";
import { describePeople } from "@/lib/imports/identity";
import { fieldMapping, mappingOptions, metricHeaders, missingRequired } from "@/lib/imports/mapping";
import { reconcile } from "@/lib/imports/reconcile";
import { findSchema, uploadableSchemas } from "@/lib/imports/schemas";
import type { ParsedFile } from "@/lib/imports/parse";
import { fmt, fmtDate } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, buttonClass, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Stat, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import {
  bulkReviewAction,
  commitAction,
  coverageAction,
  presetAction,
  resolveAction,
  revertAction,
  saveMappingAction,
  validateAction,
} from "../actions";
import { ImportTabs } from "../tabs";

export const metadata = { title: "Import" };

function summarize(n: Record<string, unknown> | null): string {
  if (!n) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith("_") || v === null || v === undefined || k === "payload") continue;
    if (k === "metrics" && Array.isArray(v)) {
      parts.push(`${v.length} metrics (${v.filter((m) => (m as { raw: unknown }).raw === null).length} null)`);
      continue;
    }
    if (typeof v === "object") continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(" · ").slice(0, 220);
}

const ACTION_LABEL: Record<string, string> = { create: "Create", link: "Link", update: "Update", skip: "Skip", reject: "Reject" };

export default async function ImportBatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireCap("imports.manage");
  const { id } = await params;
  const sp = await searchParams;
  let batch;
  try {
    batch = await getBatch(db, v, id);
  } catch (e) {
    if (e instanceof UserError) notFound();
    throw e;
  }
  const schema = findSchema(batch.entityType);
  if (!schema) notFound();
  let parsed: ParsedFile | null = null;
  let fileError: string | null = null;
  try {
    parsed = await loadBatchFile(db, batch);
  } catch (e) {
    fileError = e instanceof Error ? e.message : "Source file unavailable";
  }
  const stats = batch.stats as Record<string, number>;
  const editable = batch.status !== "committed" && batch.status !== "reverted";
  const mapping = fieldMapping(batch.mapping);
  const options = mappingOptions(batch.mapping);
  const missing = missingRequired(schema, batch.mapping);
  const cols = parsed ? metricHeaders(schema, parsed.headers, batch.mapping) : { metrics: [], ignored: [] };
  const presets = await listPresets(db, v.orgId, schema.id);
  const firstRow = parsed?.rows[0] ?? {};

  const validated = ["validated", "committed", "reverted"].includes(batch.status);
  const groups = batch.status === "validated" ? await reviewGroups(db, v, batch.id) : [];
  const candidateIds = [...new Set(groups.flatMap((g) => [...g.candidates.map((c) => c.personId), ...(g.suggested ? [g.suggested] : [])]))];
  const candidateInfo = await describePeople(db, v.orgId, candidateIds);
  const allPeople = groups.length
    ? await db.select({ id: people.id, first: people.firstName, last: people.lastName, dob: people.dateOfBirth }).from(people).where(eq(people.orgId, v.orgId)).orderBy(asc(people.lastName), asc(people.firstName)).limit(2000)
    : [];
  const sampleRows = validated
    ? await db
        .select()
        .from(importRows)
        .where(and(eq(importRows.batchId, batch.id), inArray(importRows.status, ["ready", "committed", "skipped", "needs_review"])))
        .orderBy(asc(importRows.rowNumber))
        .limit(12)
    : [];
  const badRows = validated
    ? await db
        .select()
        .from(importRows)
        .where(and(eq(importRows.batchId, batch.id), inArray(importRows.status, ["invalid", "duplicate"])))
        .orderBy(asc(importRows.rowNumber))
        .limit(15)
    : [];
  const warnRows = validated
    ? (await db.select().from(importRows).where(eq(importRows.batchId, batch.id)).orderBy(asc(importRows.rowNumber)).limit(2000)).filter((r) => r.warnings.length && r.status !== "invalid").slice(0, 15)
    : [];
  const rec = batch.status === "committed" || batch.status === "reverted" ? await reconcile(db, v, batch.id) : null;
  const dupUploads = Number(sp.duplicate ?? stats.duplicateUploads ?? 0);
  const earlier = dupUploads
    ? await db.select({ id: importBatches.id, createdAt: importBatches.createdAt, status: importBatches.status }).from(importBatches).where(and(eq(importBatches.orgId, v.orgId), eq(importBatches.checksum, batch.checksum ?? ""))).orderBy(asc(importBatches.createdAt))
    : [];

  return (
    <>
      <PageHeader
        kicker={schema.label}
        title={batch.originalFilename ?? "Import"}
        description={
          <>
            Uploaded {fmt(batch.createdAt)} · <StatusBadge status={batch.status} /> · checksum <code className="text-xs">{batch.checksum?.slice(0, 12)}…</code>
          </>
        }
        actions={
          <Link href="/imports" className={buttonClass("outline", "sm")}>
            All imports
          </Link>
        }
      />
      <ImportTabs current="imports" />

      {dupUploads && earlier.length > 1 ? (
        <Callout tone="warn" title="This exact file was uploaded before" className="mb-4">
          Same checksum as {earlier.length - 1} earlier upload(s):{" "}
          {earlier
            .filter((e) => e.id !== batch.id)
            .map((e) => (
              <Link key={e.id} href={`/imports/${e.id}`} className="mr-2 underline">
                {fmt(e.createdAt, "MMM d h:mm a")} ({e.status})
              </Link>
            ))}
          . Re-importing is safe — records already imported are skipped or updated, never duplicated.
        </Callout>
      ) : null}
      {typeof sp.flash === "string" ? (
        <Callout tone="ok" className="mb-4">
          <span role="status">{sp.flash.slice(0, 300)}</span>
        </Callout>
      ) : null}
      {fileError ? (
        <Callout tone="bad" title="Source file problem" className="mb-4">
          {fileError}
        </Callout>
      ) : null}

      {/* ---------------- Step 2–3: schema + mapping ---------------- */}
      <Card className="mb-6" id="mapping">
        <CardHeader kicker="Steps 2–3" title="Data type and field mapping" action={missing.length ? <Badge variant="yellow">{missing.length} required unmapped</Badge> : <Badge variant="green">required fields mapped</Badge>} />
        <CardBody>
          <p className="mb-3 text-sm text-ink-3">
            {schema.description} <Badge variant={schema.evidence === "existing Teamwork integration" ? "green" : schema.evidence === "vendor docs" ? "blue" : "yellow"}>{schema.evidence}</Badge>
          </p>
          {editable && !schema.internal ? (
            <ActionForm action={saveMappingAction} className="mb-5 flex flex-wrap items-end gap-3">
              <input type="hidden" name="batchId" value={batch.id} />
              <Field label="Data type" htmlFor="schemaId" className="min-w-64 flex-1">
                <Select id="schemaId" name="schemaId" defaultValue={schema.id}>
                  {uploadableSchemas().map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton variant="outline" pendingText="Switching…">
                Use this data type
              </SubmitButton>
            </ActionForm>
          ) : null}
          {parsed ? (
            <ActionForm action={saveMappingAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {schema.fields.map((f) => (
                  <Field
                    key={f.key}
                    label={`${f.label} (${f.type})`}
                    htmlFor={`map-${f.key}`}
                    required={f.required}
                    hint={mapping[f.key] ? `e.g. "${String(firstRow[mapping[f.key]] ?? "(empty)").slice(0, 40)}"` : (f.hint ?? "Not mapped")}
                  >
                    <Select id={`map-${f.key}`} name={`map.${f.key}`} defaultValue={mapping[f.key] ?? ""} disabled={!editable}>
                      <option value="">— not mapped —</option>
                      {parsed!.headers
                        .filter((h) => !h.startsWith("_"))
                        .map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                    </Select>
                  </Field>
                ))}
                {(schema.options ?? []).map((o) => (
                  <Field key={o.key} label={o.label} htmlFor={`opt-${o.key}`} hint={o.hint}>
                    <Select id={`opt-${o.key}`} name={`opt.${o.key}`} defaultValue={options[o.key] ?? ""} disabled={!editable}>
                      {o.choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              {schema.dynamicMetrics ? (
                <p className="mt-3 text-sm">
                  <span className="font-medium">{cols.metrics.length} vendor metric column(s)</span> detected from headers like &ldquo;Jump Height(m)&rdquo;
                  {cols.metrics.length ? `: ${cols.metrics.slice(0, 8).join(", ")}${cols.metrics.length > 8 ? "…" : ""}` : ""}.
                </p>
              ) : null}
              {cols.ignored.length ? <p className="mt-1 text-xs text-ink-3">Not imported (unmapped): {cols.ignored.join(", ")}</p> : null}
              {missing.length ? <p className="mt-2 text-sm text-warn">Required: {missing.join("; ")}</p> : null}
              {editable ? (
                <div className="mt-4">
                  <SubmitButton>Save mapping</SubmitButton>
                </div>
              ) : null}
            </ActionForm>
          ) : null}
          {editable && !schema.internal ? (
            <div className="mt-5 grid gap-4 border-t border-edge pt-4 md:grid-cols-2">
              <ActionForm action={presetAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="batchId" value={batch.id} />
                <input type="hidden" name="intent" value="apply" />
                <Field label="Reuse a saved mapping" htmlFor="preset" className="min-w-48 flex-1" hint={Object.keys(presets).length ? undefined : "No presets saved for this data type yet."}>
                  <Select id="preset" name="preset" defaultValue="" disabled={!Object.keys(presets).length}>
                    <option value="">Choose…</option>
                    {Object.keys(presets).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="outline">Apply preset</SubmitButton>
              </ActionForm>
              <ActionForm action={presetAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="batchId" value={batch.id} />
                <input type="hidden" name="intent" value="save" />
                <Field label="Save the current mapping as" htmlFor="presetName" className="min-w-48 flex-1" hint="Saved mappings are reused for the next export of the same report.">
                  <Input id="presetName" name="presetName" placeholder="e.g. ZP Attendance Export" required maxLength={60} />
                </Field>
                <SubmitButton variant="outline">Save preset</SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ---------------- Step 4: validate ---------------- */}
      <Card className="mb-6" id="validate">
        <CardHeader kicker="Step 4" title="Validate rows" />
        <CardBody>
          <p className="mb-3 text-sm text-ink-3">
            Parses every row: dates (offsets kept verbatim), units, numbers (source text kept), empty cells as null (never 0), duplicates within the file, then matches each person.
          </p>
          {editable ? (
            <ActionForm action={validateAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              {missing.length ? (
                <p className="text-sm text-warn">Map the required fields above first.</p>
              ) : (
                <SubmitButton pendingText="Validating…">{batch.status === "validated" ? "Re-validate" : "Validate rows"}</SubmitButton>
              )}
            </ActionForm>
          ) : null}
          {validated ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="File rows" value={stats.fileRows ?? 0} />
              <Stat label="Create" value={stats.action_create ?? 0} />
              <Stat label="Link" value={stats.action_link ?? 0} />
              <Stat label="Update" value={stats.action_update ?? 0} />
              <Stat label="Skip / duplicate" value={(stats.action_skip ?? 0) + (stats.status_duplicate ?? 0)} />
              <Stat label="Rejected" value={stats.status_invalid ?? 0} tone={(stats.status_invalid ?? 0) > 0 ? "bad" : undefined} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ---------------- Step 5: identity review ---------------- */}
      {batch.status === "validated" ? (
        <Card className="mb-6" id="review">
          <CardHeader
            kicker="Step 5"
            title={`Identity review${groups.length ? ` — ${groups.length} ${groups.length === 1 ? "person" : "people"}` : ""}`}
            action={groups.length ? <Badge variant="yellow">{stats.needs_review ?? 0} rows waiting</Badge> : <Badge variant="green">nothing to review</Badge>}
          />
          <CardBody>
            <p className="mb-3 text-sm text-ink-3">
              Teamwork never matches by name alone and never merges records silently. Strong matches (exact name + date of birth, or exact name + email for adults, with a single candidate) are suggested but still need your confirmation.
            </p>
            {/* Always rendered so their confirmation message stays visible after the list empties. */}
            <div className="mb-4 flex flex-wrap gap-2">
              <ActionForm action={bulkReviewAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <input type="hidden" name="intent" value="confirm_strong" />
                {groups.some((g) => g.confidence === "strong") ? (
                  <SubmitButton variant="secondary" size="sm">
                    Confirm all strong matches ({groups.filter((g) => g.confidence === "strong").length})
                  </SubmitButton>
                ) : null}
              </ActionForm>
              <ActionForm action={bulkReviewAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <input type="hidden" name="intent" value="skip" />
                {groups.length ? (
                  <SubmitButton variant="outline" size="sm" confirm="Skip every row that still needs review? They will not be imported.">
                    Skip all unresolved
                  </SubmitButton>
                ) : null}
              </ActionForm>
            </div>
            <ul className="space-y-4">
              {groups.slice(0, 50).map((g) => (
                <li key={g.key} className="rounded-lg border border-edge p-3">
                  <ActionForm action={resolveAction}>
                    <input type="hidden" name="batchId" value={batch.id} />
                    <input type="hidden" name="key" value={g.key} />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <span className="font-semibold">
                          {g.identity.firstName} {g.identity.lastName}
                        </span>{" "}
                        <span className="text-xs text-ink-3">
                          {[g.identity.dob && `DOB ${g.identity.dob}`, g.identity.email, g.identity.sourceId && `source id ${g.identity.sourceId}`].filter(Boolean).join(" · ")} · {g.rows.length} row(s)
                        </span>
                      </div>
                      <StatusBadge status={g.confidence === "strong" ? "strong match" : g.confidence === "ambiguous" ? "needs_review" : "no match"} />
                    </div>
                    <fieldset className="mt-2 space-y-1">
                      <legend className="sr-only">Choose who this is</legend>
                      {g.candidates.map((c) => {
                        const info = candidateInfo.get(c.personId);
                        return (
                          <label key={c.personId} className="flex min-h-9 items-start gap-2 text-sm">
                            <input type="radio" name="choice" value={c.personId} defaultChecked={g.suggested === c.personId} className="mt-1" />
                            <span>
                              Link to <span className="font-medium">{info?.name ?? c.personId}</span>
                              <span className="text-ink-3">
                                {" "}
                                {[info?.dob && `DOB ${info.dob}`, info?.email, info?.athleteId ? "athlete" : "not an athlete", info?.status].filter(Boolean).join(" · ")} — {c.reason}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {schema.allowCreatePerson ? (
                        <label className="flex min-h-9 items-center gap-2 text-sm">
                          <input type="radio" name="choice" value="__create" /> Create a new person
                        </label>
                      ) : null}
                      <label className="flex min-h-9 items-center gap-2 text-sm">
                        <input type="radio" name="choice" value="__skip" /> Skip these rows
                      </label>
                    </fieldset>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Field label="…or link to someone else" htmlFor={`manual-${g.key}`} className="min-w-56 flex-1">
                        <Select id={`manual-${g.key}`} name="manualPersonId" defaultValue="">
                          <option value="">—</option>
                          {allPeople.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.last}, {p.first}
                              {p.dob ? ` (${p.dob})` : ""}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton size="sm">Save decision</SubmitButton>
                    </div>
                  </ActionForm>
                </li>
              ))}
            </ul>
            {groups.length > 50 ? <p className="mt-3 text-sm text-ink-3">Showing 50 of {groups.length}; resolve these to see the rest.</p> : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ---------------- Step 6: preview + coverage + commit ---------------- */}
      {validated ? (
        <Card className="mb-6" id="preview">
          <CardHeader kicker="Step 6" title="Preview" />
          <CardBody>
            <Table caption="Sample rows">
              <thead>
                <tr>
                  <Th>Row</Th>
                  <Th>Action</Th>
                  <Th>Match</Th>
                  <Th>Data</Th>
                  <Th>Warnings</Th>
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((r) => {
                  const n = r.normalized as Record<string, unknown>;
                  const act = (n?._result as string) ?? (n?._action as string) ?? (r.status === "needs_review" ? "review" : "—");
                  return (
                    <tr key={r.id}>
                      <Td>{r.rowNumber}</Td>
                      <Td>
                        <Badge variant={act === "create" ? "blue" : act === "update" ? "yellow" : act === "skip" ? "neutral" : act === "review" ? "yellow" : "green"}>{ACTION_LABEL[act] ?? act}</Badge>
                      </Td>
                      <Td className="text-xs">{r.matchConfidence?.replaceAll("_", " ") ?? "—"}</Td>
                      <Td className="max-w-md text-xs text-ink-2">{summarize(n)}</Td>
                      <Td className="max-w-xs text-xs text-warn">{r.warnings.join("; ")}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {badRows.length ? (
              <>
                <h3 className="mt-5 text-sm font-semibold">Rejected and duplicate rows</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {badRows.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">Row {r.rowNumber}</span> <StatusBadge status={r.status} /> <span className="text-ink-2">{[...r.errors, ...(r.status === "duplicate" ? r.warnings : [])].join("; ")}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {warnRows.length ? (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-medium">Rows with warnings ({warnRows.length}{warnRows.length === 15 ? "+" : ""})</summary>
                <ul className="mt-1 space-y-1">
                  {warnRows.map((r) => (
                    <li key={r.id}>
                      Row {r.rowNumber}: <span className="text-ink-2">{r.warnings.join("; ")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <h3 className="mt-6 text-sm font-semibold">Coverage and limitations</h3>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{batch.limitations}</p>
            {batch.status === "validated" ? (
              <ActionForm action={coverageAction} className="mt-3 grid gap-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
                <input type="hidden" name="batchId" value={batch.id} />
                <Field label="Coverage from" htmlFor="coverageStart" required hint="Detected from the rows; adjust to what the export really covers.">
                  <Input id="coverageStart" name="coverageStart" type="date" defaultValue={batch.coverageStart ?? ""} required />
                </Field>
                <Field label="Coverage to" htmlFor="coverageEnd" required>
                  <Input id="coverageEnd" name="coverageEnd" type="date" defaultValue={batch.coverageEnd ?? ""} required />
                </Field>
                <Field label="Note (optional)" htmlFor="note" hint="e.g. 'Attendance report, all classes, Jan–Mar'">
                  <Textarea id="note" name="note" className="min-h-10" />
                </Field>
                <SubmitButton variant={stats.coverageConfirmed ? "outline" : "primary"}>{stats.coverageConfirmed ? "Update coverage" : "Confirm coverage"}</SubmitButton>
              </ActionForm>
            ) : (
              <p className="mt-2 text-sm">
                Coverage: {fmtDate(batch.coverageStart)} – {fmtDate(batch.coverageEnd)}
              </p>
            )}

            {batch.status === "validated" ? (
              <div className="mt-6 border-t border-edge pt-4">
                {(stats.needs_review ?? 0) > 0 ? (
                  <Callout tone="warn" title="Commit unavailable">
                    {stats.needs_review} row(s) still need an identity decision (Step 5).
                  </Callout>
                ) : !stats.coverageConfirmed ? (
                  <Callout tone="warn" title="Commit unavailable">
                    Confirm the coverage date range first — historical imports must state what period they cover.
                  </Callout>
                ) : (
                  <ActionForm action={commitAction}>
                    <input type="hidden" name="batchId" value={batch.id} />
                    <p className="mb-2 text-sm text-ink-3">Writes everything in one transaction. You can revert this import afterwards.</p>
                    <SubmitButton pendingText="Committing…" confirm="Commit this import? Records will be created and linked as previewed.">
                      Commit import
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ---------------- Step 8–9: reconciliation + revert ---------------- */}
      {rec ? (
        <Card className="mb-6" id="reconcile">
          <CardHeader
            kicker="Step 8"
            title="Reconciliation"
            action={
              <a href={`/imports/${batch.id}/rejected`} className={buttonClass("outline", "sm")}>
                Download rejected rows (CSV)
              </a>
            }
          />
          <CardBody>
            <p className="mb-3 text-sm">
              {rec.balanced ? <Badge variant="green">balanced</Badge> : <Badge variant="red">row count mismatch</Badge>} File rows {rec.fileRows} = staged rows {rec.importRows}.{" "}
              {Object.entries(rec.byResult)
                .map(([k, n]) => `${n} ${k}`)
                .join(" · ")}
              {batch.committedAt ? ` · committed ${fmt(batch.committedAt)}` : ""}
              {batch.revertedAt ? ` · reverted ${fmt(batch.revertedAt)}` : ""}
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold">Records created</h3>
                <ul className="mt-1 text-sm">
                  {Object.entries(rec.createdByType).map(([t, n]) => (
                    <li key={t}>
                      {n} × {t.replaceAll("_", " ")}
                    </li>
                  ))}
                  {!Object.keys(rec.createdByType).length ? <li className="text-ink-3">None</li> : null}
                </ul>
                <h3 className="mt-4 text-sm font-semibold">Value checks</h3>
                <ul className="mt-1 text-sm">
                  <li>{rec.checks.compared} values compared source → stored</li>
                  <li className={rec.checks.precisionMismatches ? "text-bad" : ""}>{rec.checks.precisionMismatches} precision mismatches</li>
                  <li className={rec.checks.unitMismatches ? "text-bad" : ""}>{rec.checks.unitMismatches} unit mismatches</li>
                  <li>
                    {rec.checks.sourceNulls} empty in source → {rec.checks.storedNulls} null stored; <span className={rec.checks.nullCoercedToZero ? "text-bad" : ""}>{rec.checks.nullCoercedToZero} coerced to 0</span>
                  </li>
                  <li>{rec.duplicates.length} duplicate rows in file</li>
                  <li>
                    Coverage {fmtDate(rec.coverage.start)} – {fmtDate(rec.coverage.end)} {rec.coverage.confirmed ? "(confirmed)" : ""}
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Per person × item</h3>
                <Table caption="Per athlete and test type">
                  <thead>
                    <tr>
                      <Th>Person</Th>
                      <Th>Item</Th>
                      <Th align="right">File</Th>
                      <Th align="right">Committed</Th>
                      <Th align="right">Skipped</Th>
                      <Th align="right">Rejected</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.groups.slice(0, 40).map((g) => (
                      <tr key={`${g.athlete}|${g.item}`}>
                        <Td>{g.athlete}</Td>
                        <Td>{g.item}</Td>
                        <Td align="right">{g.fileRows}</Td>
                        <Td align="right">{g.committed}</Td>
                        <Td align="right">{g.skipped}</Td>
                        <Td align="right">{g.rejected}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
            {rec.samples.length ? (
              <>
                <h3 className="mt-5 text-sm font-semibold">Sampled values: source vs stored</h3>
                <Table caption="Sampled values">
                  <thead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Field</Th>
                      <Th>Source text</Th>
                      <Th>Stored text</Th>
                      <Th>Stored value</Th>
                      <Th>Unit</Th>
                      <Th>OK</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.samples.map((s, i) => (
                      <tr key={i}>
                        <Td>{s.rowNumber}</Td>
                        <Td>{s.field}</Td>
                        <Td className="font-mono text-xs">{s.sourceRaw ?? "null"}</Td>
                        <Td className="font-mono text-xs">{s.storedRaw ?? "null"}</Td>
                        <Td className="font-mono text-xs">{s.storedValue ?? "null"}</Td>
                        <Td>
                          {s.sourceUnit}
                          {s.sourceUnit !== s.storedUnit ? ` → ${s.storedUnit}` : ""}
                        </Td>
                        <Td>{s.ok ? <Badge variant="green">yes</Badge> : <Badge variant="red">no</Badge>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : null}

            {batch.status === "committed" ? (
              <div className="mt-6 border-t border-edge pt-4">
                <h3 className="text-sm font-semibold">Step 9 — Revert</h3>
                <p className="mb-2 text-sm text-ink-3">
                  Deletes only the records this import created (children first) and the source IDs it registered, and restores fields it filled on existing records. Pre-existing people it linked to are untouched. Records later data depends on are kept and listed.
                </p>
                <ActionForm action={revertAction}>
                  <input type="hidden" name="batchId" value={batch.id} />
                  <SubmitButton variant="danger" pendingText="Reverting…" confirm="Revert this import? Records it created will be deleted.">
                    Revert import
                  </SubmitButton>
                </ActionForm>
              </div>
            ) : (
              <Callout tone="info" className="mt-6" title="Reverted">
                {stats.reverted_deleted ?? 0} record(s) removed, {stats.reverted_restored ?? 0} update(s) restored, {stats.reverted_kept ?? 0} kept because later data uses them.
              </Callout>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
