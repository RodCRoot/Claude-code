import { ActionForm, SubmitButton } from "@/components/forms";
import { BodyFigure, HeatLegend } from "@/components/body-map/body-figure";
import { BodyMapForm } from "@/components/body-map/body-map-form";
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { BODY_MAP_DISCLAIMER, heatOverlay, regionLabel } from "@/lib/science/body-regions";
import { bodyHistory, reviewQueue } from "@/lib/science/bodymap";
import { fmt } from "@/lib/time";
import { reviewBodyReportAction, submitBodyReportAction } from "../actions";
import { AthletePicker, HealthOnly, pickAthlete, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Body map" };

export default async function BodyMapPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const athletes = await scopedAthletes(db, v, "health.read");
  if (!athletes.length) {
    return (
      <>
        <PageHeader kicker="Sports science" title="Body map" />
        <HealthOnly />
      </>
    );
  }
  const athlete = pickAthlete(athletes, sp1(p.athlete))!;
  const now = new Date();
  const [history, canWrite, queue] = await Promise.all([bodyHistory(db, v, athlete.id, 90, now), canOnAthlete(db, v, athlete.id, "health.write"), reviewQueue(db, v)]);
  const heat = Object.fromEntries(heatOverlay(history, now, 14));
  return (
    <>
      <PageHeader kicker="Sports science" title="Body map" description="Self-reported soreness and pain. Heat shows the highest severity reported per region in the last 14 days." />
      <Callout tone="warn" className="mb-4" title="Self-reported symptoms only">
        {BODY_MAP_DISCLAIMER}
      </Callout>
      <div className="mb-4">
        <AthletePicker athletes={athletes} current={athlete.id} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {canWrite ? (
          <Card>
            <CardHeader title={`New report · ${athlete.name}`} />
            <CardBody>
              <BodyMapForm action={submitBodyReportAction} athleteId={athlete.id} heat={heat} showDisclaimer={false} />
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Recent heat (last 14 days)" kicker={athlete.name} />
          <CardBody>
            <div className="grid grid-cols-2 gap-2">
              <BodyFigure view="front" heat={heat} className="w-full" />
              <BodyFigure view="back" heat={heat} className="w-full" />
            </div>
            <HeatLegend />
            <h3 className="mt-5 mb-2 text-sm font-semibold">History (90 days)</h3>
            {history.length ? (
              <ol className="relative space-y-3 border-l border-edge pl-4">
                {history.map((r) => (
                  <li key={r.id} className="text-sm">
                    <span aria-hidden className={`absolute -left-[5px] mt-1.5 size-2.5 rounded-full ${r.kind === "pain" ? "bg-bad" : "bg-ink-3"}`} />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{regionLabel(r.region, r.side)}</span>
                      <Badge variant={r.kind === "pain" ? "red" : "neutral"}>{r.kind}</Badge>
                      <span className="tabular">{r.severity}/10</span>
                      <StatusBadge status={r.reviewStatus} />
                    </div>
                    <div className="text-xs text-ink-3">
                      {fmt(r.reportedAt)} · {r.view} view{r.note ? ` · “${r.note}”` : ""}
                      {r.reviewNote ? ` · Review: ${r.reviewNote}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-3">No reports in the last 90 days. (No report does not mean cleared to train.)</p>
            )}
          </CardBody>
        </Card>
      </div>
      {queue.length || (await canOnAthlete(db, v, athlete.id, "health.review")) ? (
        <Card className="mt-6">
          <CardHeader title="Review queue" kicker={`${queue.length} open · pain or soreness ≥ threshold`} />
          <CardBody>
            {queue.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing to review.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {queue.map((r) => (
                  <li key={r.id} className="grid gap-3 py-4 md:grid-cols-[1fr_minmax(0,360px)]">
                    <div className="text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{r.athleteName}</span>
                        <span>{regionLabel(r.region, r.side)}</span>
                        <Badge variant={r.kind === "pain" ? "red" : "neutral"}>{r.kind}</Badge>
                        <span className="tabular">{r.severity}/10</span>
                        <StatusBadge status={r.reviewStatus} />
                      </div>
                      <div className="text-xs text-ink-3">
                        Reported {fmt(r.reportedAt)}
                        {r.note ? ` · “${r.note}”` : ""}
                        {r.reviewNote ? ` · Last note: ${r.reviewNote}` : ""}
                      </div>
                    </div>
                    <ActionForm action={reviewBodyReportAction} className="space-y-2">
                      <input type="hidden" name="reportId" value={r.id} />
                      <label htmlFor={`rv-${r.id}`} className="sr-only">
                        Review outcome
                      </label>
                      <Select id={`rv-${r.id}`} name="status" defaultValue="reviewed">
                        <option value="reviewed">Reviewed — no further action</option>
                        <option value="follow_up">Follow-up needed (note required)</option>
                        <option value="referred_out">Referred out (note required)</option>
                      </Select>
                      <label htmlFor={`rn-${r.id}`} className="sr-only">
                        Review note
                      </label>
                      <Textarea id={`rn-${r.id}`} name="note" placeholder="Note (who you spoke with, referral, plan)" maxLength={1000} />
                      <SubmitButton size="sm">Save review</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
