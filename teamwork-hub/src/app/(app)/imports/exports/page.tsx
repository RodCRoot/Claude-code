import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { athletes, people } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter, can } from "@/lib/authz/policy";
import { listExports } from "@/lib/exports/bundle";
import { fmt } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { createExportAction } from "../actions";
import { ImportTabs } from "../tabs";

export const metadata = { title: "Exports & backup" };

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default async function ExportsPage() {
  const v = await requireStaff();
  const admin = can(v, "imports.manage");
  const scope = await accessibleAthleteIds(db, v, "profile.read");
  const roster = await db
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, active: athletes.active })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), athleteScopeFilter(scope, athletes.id)))
    .orderBy(asc(people.lastName), asc(people.firstName));
  const orgRoster = roster;
  const exports = await listExports(db, v);

  return (
    <>
      <PageHeader
        kicker={admin ? "Import Center" : "Data"}
        title="Exports & backup"
        description="Download Teamwork's data as a zip of CSV + JSON files with the original documents and raw signal files, plus a manifest.json listing every file with its SHA-256 checksum."
      />
      <ImportTabs current="exports" canImport={admin} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader kicker="Organization-wide" title="Full data export" />
          <CardBody>
            {admin ? (
              <ActionForm action={createExportAction}>
                <input type="hidden" name="kind" value="org" />
                <p className="mb-3 text-sm text-ink-3">
                  People, guardianships, households, memberships, invoices &amp; transactions, attendance, workouts/set logs/maxes, questionnaire responses, body reports, metric values (with source, formula and units), completed form PDFs, archived documents and raw signal files.
                </p>
                <SubmitButton pendingText="Building export…">Generate organization export</SubmitButton>
              </ActionForm>
            ) : (
              <Callout tone="info">Only owners and admins can export organization-wide data.</Callout>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader kicker="Per athlete" title="Athlete data export" />
          <CardBody>
            <ActionForm action={createExportAction} className="space-y-3">
              <input type="hidden" name="kind" value="athlete" />
              <Field label="Athlete" htmlFor="athleteId" required hint="Only athletes whose profile you can access. Health and billing files are included only if you can see them.">
                <Select id="athleteId" name="athleteId" defaultValue="" required>
                  <option value="" disabled>
                    Choose an athlete…
                  </option>
                  {orgRoster.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.last}, {a.first}
                      {a.active ? "" : " (inactive)"}
                    </option>
                  ))}
                </Select>
              </Field>
              {orgRoster.length ? <SubmitButton pendingText="Building export…">Generate athlete export</SubmitButton> : <p className="text-sm text-ink-3">No athletes in your scope.</p>}
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={admin ? "Stored exports" : "Your exports"} />
        <CardBody>
          {exports.length === 0 ? (
            <EmptyState title="No exports yet" />
          ) : (
            <Table caption="Stored exports">
              <thead>
                <tr>
                  <Th>Created</Th>
                  <Th>Scope</Th>
                  <Th>Includes</Th>
                  <Th align="right">Size</Th>
                  <Th>SHA-256</Th>
                  <Th>Download</Th>
                </tr>
              </thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap">{fmt(e.createdAt, "MMM d, h:mm a")}</Td>
                    <Td>{e.scope?.kind === "org" ? "Organization" : (e.athleteName ?? "Athlete")}</Td>
                    <Td>
                      {e.includes?.health ? <Badge variant="blue">health</Badge> : null} {e.includes?.billing ? <Badge variant="blue">billing</Badge> : null}
                    </Td>
                    <Td align="right">{kb(e.sizeBytes)}</Td>
                    <Td className="font-mono text-xs">{e.sha256.slice(0, 12)}…</Td>
                    <Td>
                      <a href={`/api/exports/${e.id}`} className="font-medium text-brand underline" download>
                        {e.filename.length > 28 ? "Download .zip" : e.filename}
                      </a>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      {admin ? (
        <Callout tone="info" title="Database backups" className="mt-6">
          Exports are for portability, not disaster recovery. Full backups use <code>pnpm backup</code> (pg_dump) plus a copy of the storage directory — see <code>docs/BACKUP-RESTORE.md</code>.
        </Callout>
      ) : null}
    </>
  );
}
