import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, PageHeader, StatusBadge, Textarea } from "@/components/ui";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { viewReport } from "@/lib/science/reports";
import { fmt } from "@/lib/time";
import { ReportBody } from "../../../performance/_components/report-view";
import { editReportAction, reportStatusAction } from "../../actions";
import { BackLink } from "../../_components/shared";

export const metadata = { title: "Progress report" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireStaff();
  const { id } = await params;
  const rv = await viewReport(db, v, id);
  if (!rv) notFound();
  const { report: r, sections, snapshot } = rv;
  const name = (await scopedAthletes(db, v, "training.read", { includeInactive: true, ids: [r.athleteId] }))[0]?.name ?? "Athlete";
  const healthOk = await canOnAthlete(db, v, r.athleteId, "health.read");
  const editable = rv.canManage && r.status !== "shared";
  return (
    <>
      <BackLink href="/science/reports">Reports</BackLink>
      <PageHeader kicker="Progress report" title={name} description={<>Status: <StatusBadge status={r.status} />{r.approvedAt ? ` · approved ${fmt(r.approvedAt)}` : ""}</>} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <Card>
          <CardHeader title="What the family will see" kicker={r.status === "shared" ? "Shared — frozen" : "Preview"} />
          <CardBody>
            <ReportBody snapshot={snapshot} sections={sections} summary={r.coachSummary} />
          </CardBody>
        </Card>
        <div className="space-y-6">
          {editable ? (
            <Card>
              <CardHeader title="Edit" kicker="Saving returns the report to draft" />
              <CardBody>
                <ActionForm action={editReportAction} className="space-y-3">
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Coach summary" htmlFor="rs" hint="Required before approval.">
                    <Textarea id="rs" name="coachSummary" defaultValue={r.coachSummary ?? ""} maxLength={4000} className="min-h-36" />
                  </Field>
                  <fieldset className="space-y-1 text-sm">
                    <legend className="font-medium text-ink-2">Sections</legend>
                    {(["kpis", "strength", "habits", "attendance"] as const).map((k) => (
                      <label key={k} className="flex items-center gap-2">
                        <input type="checkbox" name={`sec_${k}`} defaultChecked={sections[k]} /> {k === "kpis" ? "Testing results" : k[0].toUpperCase() + k.slice(1)}
                      </label>
                    ))}
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="sec_wellness" defaultChecked={sections.wellness} disabled={!healthOk} /> Wellness summary (off by default; only family members with health access will see it)
                    </label>
                  </fieldset>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="refresh" /> Re-assemble snapshot from current data
                  </label>
                  <SubmitButton>Save draft</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          {rv.canManage ? (
            <Card>
              <CardHeader title="Workflow" />
              <CardBody className="space-y-3">
                {r.status === "draft" ? (
                  <ActionForm action={reportStatusAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="to" value="approved" />
                    <SubmitButton>Approve</SubmitButton>
                  </ActionForm>
                ) : null}
                {r.status === "approved" ? (
                  <>
                    <ActionForm action={reportStatusAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="to" value="shared" />
                      <SubmitButton confirm="Share this report with the athlete's family? Shared reports are frozen.">Share with family</SubmitButton>
                    </ActionForm>
                    <ActionForm action={reportStatusAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="to" value="draft" />
                      <SubmitButton variant="outline">Return to draft</SubmitButton>
                    </ActionForm>
                  </>
                ) : null}
                {r.status === "shared" ? <Callout tone="ok">Shared. Guardians with training access and the athlete can see it on the Performance page.</Callout> : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
