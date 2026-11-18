import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { listReportsForStaff } from "@/lib/science/reports";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { createReportAction } from "../actions";

export const metadata = { title: "Progress reports" };

export default async function ReportsPage() {
  const v = await requireStaff();
  const today = todayLocal();
  const reports = await listReportsForStaff(db, v);
  const athletes = can(v, "science.manage") ? await scopedAthletes(db, v, "training.write") : [];
  return (
    <>
      <PageHeader kicker="Sports science" title="Parent progress reports" description="Draft (auto-assembled snapshot) → coach edits summary and sections → approved → shared. Families only ever see shared reports. Wellness is off by default." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <Card>
          <CardHeader title="Reports" />
          <CardBody>
            {reports.length === 0 ? (
              <EmptyState title="No reports yet." />
            ) : (
              <Table caption="Progress reports">
                <thead>
                  <tr>
                    <Th>Athlete</Th>
                    <Th>Period</Th>
                    <Th>Status</Th>
                    <Th>Wellness</Th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <Link href={`/science/reports/${r.id}`} className="font-medium hover:underline">
                          {r.athleteName}
                        </Link>
                      </Td>
                      <Td>
                        {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                      </Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td className="text-xs">{r.includeWellness ? "included" : "off"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
        {athletes.length ? (
          <Card>
            <CardHeader title="New draft" />
            <CardBody>
              <ActionForm action={createReportAction} className="space-y-3">
                <Field label="Athlete" htmlFor="nr-a" required>
                  <Select id="nr-a" name="athleteId" required>
                    {athletes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Period start" htmlFor="nr-s" required>
                  <Input id="nr-s" type="date" name="periodStart" defaultValue={addDaysYmd(today, -27)} required />
                </Field>
                <Field label="Period end" htmlFor="nr-e" required>
                  <Input id="nr-e" type="date" name="periodEnd" defaultValue={today} max={today} required />
                </Field>
                <SubmitButton pendingText="Assembling…">Assemble draft</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
