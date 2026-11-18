import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, can, isStaff } from "@/lib/authz/policy";
import { ARCHIVE_LABEL, listArchive } from "@/lib/forms/archive";
import { athleteOptions, peopleOptions } from "@/lib/forms/queries";
import { fmt, fmtDate } from "@/lib/time";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { ArchiveUpload } from "../_components/archive-upload";

export const metadata = { title: "Document archive" };

export default async function ArchivePage() {
  const v = await requireViewer();
  const manage = can(v, "forms.manage");

  let rows: Awaited<ReturnType<typeof listArchive>> = [];
  if (manage) rows = await listArchive(db, v.orgId);
  else if (!isStaff(v)) {
    const ids = await accessibleAthleteIds(db, v, "profile.read");
    const kids = await athleteOptions(db, v.orgId, ids === "all" ? [] : ids);
    const personIds = kids.map((k) => k.personId);
    if (v.personId) personIds.push(v.personId);
    rows = (await listArchive(db, v.orgId, { personIds })).filter((r) => r.obj.accessLevel === "subject_and_guardians");
  }
  const people = manage ? await peopleOptions(db, v.orgId) : [];

  return (
    <>
      <PageHeader
        kicker="Documents"
        title="Document archive"
        description="Historical signed documents from before Teamwork Hub, stored exactly as received with their original evidence. Signatures are never recreated."
        actions={
          <ButtonLink href="/documents" variant="outline">
            Back to documents
          </ButtonLink>
        }
      />
      {manage ? (
        <Tabs
          current="archive"
          tabs={[
            { key: "requests", label: "Requests", href: "/documents?tab=requests" },
            { key: "missing", label: "Missing forms", href: "/documents?tab=missing" },
            { key: "templates", label: "Templates", href: "/documents?tab=templates" },
            { key: "archive", label: "Archive", href: "/documents/archive" },
          ]}
        />
      ) : null}
      {isStaff(v) && !manage ? (
        <Callout tone="warn" title="Front-desk staff only">
          The archive is managed by owners, admins, and operations staff (forms permission). Coaches don’t have access to archived documents.
        </Callout>
      ) : null}

      <div className="space-y-5">
        {manage ? (
          <Card>
            <CardHeader title="Upload a historical document" kicker="Import" />
            <CardBody>
              <Callout className="mb-4" title={ARCHIVE_LABEL}>
                Upload the original PDF (e.g. a scanned paper waiver or an export from Zen Planner). Teamwork Hub stores it with a SHA-256 checksum and your notes about where it came from. It does not create signatures and does not count as a completed Teamwork Hub form.
              </Callout>
              <ArchiveUpload people={people} />
            </CardBody>
          </Card>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState title="No archived documents">{manage ? "Uploaded documents will appear here." : "There are no historical documents on file for your family."}</EmptyState>
        ) : (
          <Card>
            <CardHeader title="Archived documents" kicker={`${rows.length} on file`} />
            <Table caption="Archived documents">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Document</Th>
                  <Th>Original evidence</Th>
                  {manage ? <Th>Visibility</Th> : null}
                  <Th align="right">File</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ev = (r.doc.originalEvidence ?? {}) as { notes?: string | null; originalFilename?: string };
                  return (
                    <tr key={r.doc.id}>
                      <Td className="font-medium">
                        {r.first} {r.last}
                      </Td>
                      <Td>
                        <div>{r.doc.title}</div>
                        <Badge variant="neutral" className="mt-1">
                          {ARCHIVE_LABEL}
                        </Badge>
                      </Td>
                      <Td className="max-w-xs text-xs">
                        <div>
                          {r.doc.originalSystem} · signed {fmtDate(r.doc.originalSignedAt)}
                        </div>
                        {ev.notes ? <div className="text-ink-3">{ev.notes}</div> : null}
                        <div className="text-ink-3">Imported {fmt(r.doc.createdAt)}</div>
                      </Td>
                      {manage ? <Td className="text-xs">{r.obj.accessLevel === "staff" ? "Staff only" : "Staff + family"}</Td> : null}
                      <Td align="right">
                        <a className="text-sm font-medium text-brand hover:underline" href={`/api/files/${r.obj.id}`}>
                          Download<span className="sr-only"> {r.doc.title}</span>
                        </a>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}
