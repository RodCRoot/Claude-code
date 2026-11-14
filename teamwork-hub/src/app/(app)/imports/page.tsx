import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { listBatches } from "@/lib/imports/batches";
import { uploadableSchemas } from "@/lib/imports/schemas";
import { fmt, fmtDate } from "@/lib/time";
import { Badge, buttonClass, Callout, Card, CardBody, CardHeader, EmptyState, Field, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ImportTabs } from "./tabs";

export const metadata = { title: "Import Center" };

const SOURCE_LABEL: Record<string, string> = {
  zenplanner: "Zen Planner",
  teambuildr: "TeamBuildr",
  hawkin_file: "Hawkin (file)",
  hawkin_api: "Hawkin (API)",
  generic_csv: "Generic",
  generic_json: "Generic",
  wearable_csv: "Wearable",
  gohighlevel: "GoHighLevel",
};

export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireCap("imports.manage");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : null;
  const batches = await listBatches(db, v);
  const schemas = uploadableSchemas();
  const groups = [...new Set(schemas.map((s) => s.label.split(" — ")[0]))];

  return (
    <>
      <PageHeader
        kicker="Settings"
        title="Import Center"
        description="Bring historical data in from Zen Planner, TeamBuildr, Hawkin Dynamics and other files. Every import is staged, validated, matched to people with staff confirmation, previewed, committed explicitly, reconciled, and can be reverted."
      />
      <ImportTabs current="imports" />
      {error ? (
        <Callout tone="bad" title="Upload not accepted" className="mb-4">
          {error}
        </Callout>
      ) : null}

      <Card className="mb-6">
        <CardHeader kicker="Step 1" title="Upload a file" />
        <CardBody>
          <form method="post" action="/imports/upload" encType="multipart/form-data" className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <Field label="File (CSV, JSON, or .zip for signed documents)" htmlFor="file" required hint="Excel files: save as CSV first. Max 25 MB.">
              <input id="file" name="file" type="file" required accept=".csv,.json,.zip,.txt,text/csv,application/json,application/zip" className="block w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm" />
            </Field>
            <Field label="What does it contain?" htmlFor="schemaId" required hint="You can change this on the next step.">
              <Select id="schemaId" name="schemaId" required defaultValue="">
                <option value="" disabled>
                  Choose a source and data type…
                </option>
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {schemas
                      .filter((s) => s.label.startsWith(g))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label.split(" — ")[1] ?? s.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <button type="submit" className={buttonClass("primary", "md")}>
              Upload &amp; continue
            </button>
          </form>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium text-ink-2">What each import does</summary>
            <ul className="mt-2 space-y-2">
              {schemas.map((s) => (
                <li key={s.id}>
                  <span className="font-medium">{s.label}</span> <Badge variant={s.evidence === "existing Teamwork integration" ? "green" : s.evidence === "vendor docs" ? "blue" : "yellow"}>{s.evidence}</Badge>
                  <p className="text-ink-3">{s.description}</p>
                </li>
              ))}
            </ul>
          </details>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Import history" kicker={`${batches.length} batch${batches.length === 1 ? "" : "es"}`} />
        <CardBody>
          {batches.length === 0 ? (
            <EmptyState title="No imports yet">Upload a Zen Planner member list first — later imports (family links, memberships, attendance) match against it.</EmptyState>
          ) : (
            <Table caption="Import batches">
              <thead>
                <tr>
                  <Th>Uploaded</Th>
                  <Th>Source / data</Th>
                  <Th>File</Th>
                  <Th>Status</Th>
                  <Th align="right">Rows</Th>
                  <Th>Result</Th>
                  <Th>Coverage</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const s = b.stats as Record<string, number>;
                  return (
                    <tr key={b.id}>
                      <Td className="whitespace-nowrap">{fmt(b.createdAt, "MMM d, h:mm a")}</Td>
                      <Td>
                        <div className="font-medium">{SOURCE_LABEL[b.source] ?? b.source}</div>
                        <div className="text-xs text-ink-3">{b.entityType}</div>
                      </Td>
                      <Td className="max-w-48 truncate">
                        <Link href={`/imports/${b.id}`} className="font-medium text-brand underline-offset-2 hover:underline">
                          {b.originalFilename ?? "(file)"}
                        </Link>
                      </Td>
                      <Td>
                        <StatusBadge status={b.status} />
                        {(s.needs_review ?? 0) > 0 && b.status === "validated" ? (
                          <Badge variant="yellow" className="ml-1">
                            {s.needs_review} to review
                          </Badge>
                        ) : null}
                      </Td>
                      <Td align="right">{s.fileRows ?? "—"}</Td>
                      <Td className="text-xs text-ink-2">
                        {b.status === "committed" || b.status === "reverted"
                          ? `${s.committed_create ?? 0} created · ${s.committed_link ?? 0} linked · ${s.committed_update ?? 0} updated · ${s.committed_skip ?? 0} skipped · ${s.committed_reject ?? 0} rejected`
                          : b.status === "validated"
                            ? `${s.action_create ?? 0} new · ${s.action_link ?? 0} link · ${s.action_update ?? 0} update · ${s.status_invalid ?? 0} invalid`
                            : "—"}
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{b.coverageStart ? `${fmtDate(b.coverageStart)} – ${fmtDate(b.coverageEnd)}` : "—"}</Td>
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
