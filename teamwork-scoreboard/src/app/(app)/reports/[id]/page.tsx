import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { review515, comment515 } from "@/app/actions/team";
import { PrintButton } from "@/components/print-button";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Field,
  Textarea,
  Button,
} from "@/components/ui";

const SECTION_LABELS: [string, string][] = [
  ["wins", "Biggest wins"],
  ["kpi_wins", "KPI wins"],
  ["commitments_completed", "Commitments completed"],
  ["commitments_missed", "Commitments missed"],
  ["challenges", "Current challenges"],
  ["client_concerns", "Athlete / client concerns"],
  ["facility_concerns", "Facility / equipment concerns"],
  ["help_needed", "Help needed"],
  ["next_priorities", "Priorities for next week"],
];

export default async function Report515Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const { id } = await params;
  const reportId = parseInt(id, 10);
  if (!Number.isFinite(reportId)) notFound();

  const report = db.get<Record<string, string | number | null>>(sql`
    SELECT r.*, u.name AS user_name FROM reports_515 r
    JOIN users u ON u.id = r.user_id WHERE r.id = ${reportId}
  `);
  if (!report) notFound();

  const canReview = me.permissions.includes("review_reports");
  const isMine = report.user_id === me.id;
  if (!canReview && !isMine) notFound();

  const comments = db.all<{ id: number; body: string; created_at: string; author: string }>(sql`
    SELECT c.id, c.body, c.created_at, u.name AS author
    FROM report_comments c JOIN users u ON u.id = c.user_id
    WHERE c.report_id = ${reportId} ORDER BY c.created_at ASC
  `);

  return (
    <>
      <PageHeader
        kicker={`5-15 · Week of ${report.week_start}`}
        title={`${report.user_name}`}
        subtitle={`Week rating: ${report.rating ?? "—"}/10 · Submitted ${String(
          report.submitted_at ?? "draft"
        ).slice(0, 10)}`}
        actions={
          <div className="no-print flex items-center gap-2">
            {report.manager_status === "reviewed" ? (
              <Badge variant="green">Reviewed</Badge>
            ) : (
              <Badge variant="yellow">Awaiting review</Badge>
            )}
            <PrintButton label="Print / export" />
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {SECTION_LABELS.map(([key, label]) => (
            <Card key={key} className="print-block">
              <CardHeader kicker={label} title="" className="pb-0" />
              <CardBody>
                <p className="whitespace-pre-wrap text-sm text-ink-2">
                  {(report[key] as string) || <span className="text-ink-3">—</span>}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card className="print-block">
            <CardHeader kicker="Manager response" title="" className="pb-0" />
            <CardBody>
              {report.manager_response ? (
                <p className="mb-3 whitespace-pre-wrap text-sm text-ink-2">
                  {report.manager_response as string}
                </p>
              ) : (
                <p className="mb-3 text-sm text-ink-3">No response yet.</p>
              )}
              {report.follow_up_actions ? (
                <>
                  <div className="kicker mb-1">Follow-up actions</div>
                  <p className="whitespace-pre-wrap text-sm text-ink-2">
                    {report.follow_up_actions as string}
                  </p>
                </>
              ) : null}
              {canReview && (
                <form action={review515} className="no-print mt-3 space-y-2">
                  <input type="hidden" name="reportId" value={reportId} />
                  <Field label="Response">
                    <Textarea
                      name="managerResponse"
                      rows={3}
                      defaultValue={(report.manager_response as string) ?? ""}
                    />
                  </Field>
                  <Field label="Follow-up action items">
                    <Textarea
                      name="followUpActions"
                      rows={2}
                      defaultValue={(report.follow_up_actions as string) ?? ""}
                    />
                  </Field>
                  <Button size="sm" type="submit">Save & mark reviewed</Button>
                </form>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader kicker="Discussion" title="" className="pb-0" />
            <CardBody>
              <ul className="space-y-3">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-lg bg-surface-3/60 px-3 py-2">
                    <p className="text-xs font-semibold">
                      {c.author}{" "}
                      <span className="font-normal text-ink-3">
                        · {c.created_at.slice(0, 16).replace("T", " ")}
                      </span>
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-2">{c.body}</p>
                  </li>
                ))}
                {comments.length === 0 && (
                  <li className="text-sm text-ink-3">No comments yet.</li>
                )}
              </ul>
              <form action={comment515} className="no-print mt-3 flex gap-2">
                <input type="hidden" name="reportId" value={reportId} />
                <Textarea name="body" rows={1} placeholder="Add a comment…" className="min-h-9" />
                <Button size="sm" variant="secondary" type="submit">Post</Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
