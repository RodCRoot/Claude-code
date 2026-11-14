import { notFound } from "next/navigation";
import { db } from "@/db";
import { getRun } from "@/lib/payroll/service";
import { fmt, fmtDate } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Callout, PageHeader, StatusBadge } from "@/components/ui";
import { runAction } from "../../actions";
import { PayrollResultView } from "../../_result";
import { requirePayroll } from "../../_shared";

export const metadata = { title: "Payroll run" };
export const dynamic = "force-dynamic";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { v, tz } = await requirePayroll();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const run = await getRun(db, v, id);
  if (!run) notFound();
  const res = run.snap.result;
  const draft = run.status === "draft";
  return (
    <>
      <PageHeader
        kicker="Payroll run"
        title={`${fmtDate(run.fromDate)} – ${fmtDate(run.toDate)}`}
        description={`Snapshot calculated ${fmt(res.generatedAt, "MMM d, yyyy h:mm a", tz)}.${run.approvedAt ? ` Approved ${fmt(run.approvedAt, "MMM d h:mm a", tz)}.` : ""}${run.exportedAt ? ` Last exported ${fmt(run.exportedAt, "MMM d h:mm a", tz)}.` : ""}`}
        actions={
          <>
            <StatusBadge status={run.status} />
            <ButtonLink href={`/payroll?from=${run.fromDate}&to=${run.toDate}`} variant="ghost">
              Open live view to fix flags
            </ButtonLink>
            {!draft ? (
              <ButtonLink href={`/payroll/runs/${run.id}/export`} variant="secondary" download>
                Export CSV
              </ButtonLink>
            ) : null}
          </>
        }
      />
      {draft ? (
        <div className="mb-5 flex flex-wrap gap-2">
          <ActionForm action={runAction}>
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="op" value="recalculate" />
            <SubmitButton variant="secondary" pendingText="Recalculating…">
              Recalculate from current entries
            </SubmitButton>
          </ActionForm>
          <ActionForm action={runAction}>
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="op" value="approve" />
            <SubmitButton pendingText="Approving…" confirm="Approve this payroll? The numbers are frozen after approval.">
              Approve
            </SubmitButton>
          </ActionForm>
          <ActionForm action={runAction}>
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="op" value="discard" />
            <SubmitButton variant="ghost" confirm="Discard this draft run?">
              Discard draft
            </SubmitButton>
          </ActionForm>
        </div>
      ) : (
        <Callout tone="ok" className="mb-5">
          This run is {run.status}. Its numbers are frozen; later corrections to time entries don&apos;t change it — start a new run for an adjustment.
        </Callout>
      )}
      <PayrollResultView result={res} tz={tz} editable={false} />
    </>
  );
}
