import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, StatusBadge } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { can, canOnAthlete, isStaff } from "@/lib/authz/policy";
import { scienceSettings, scopedAthletes } from "@/lib/science/access";
import { regionLabel } from "@/lib/science/body-regions";
import { reviewQueue, reviewQueueCount } from "@/lib/science/bodymap";
import { habitSummaries } from "@/lib/science/habits";
import { loadAlerts } from "@/lib/science/load";
import { completionGrid, listQuestionnaires, questionnairesForAthlete, wellnessCompletionSummary } from "@/lib/science/wellness";
import { fmt, todayLocal } from "@/lib/time";
import { updateSettingsAction } from "./actions";
import { CheckinForm, HabitCheckinForm } from "./_components/checkin-form";
import { FormulaTag } from "./_components/shared";
import { AcwrChip, HeatLegend, ReadinessHeatTable } from "./_components/ams";
import { HeroStat, ModuleHero } from "../training/_components/tb";

export const metadata = { title: "Sports Science" };

export default async function SciencePage() {
  const v = await requireViewer();
  if (v.role === "athlete") return <AthleteToday />;
  if (!isStaff(v)) {
    return (
      <>
        <PageHeader kicker="Sports science" title="Progress for your athletes" />
        <Callout title="Families see progress on the Performance page">
          Coaches record testing, training load, and coach-reviewed progress reports there. Daily check-ins and body-map reports are completed by the athlete.{" "}
          <Link href="/performance" className="font-medium underline">
            Go to Performance →
          </Link>
        </Callout>
      </>
    );
  }
  const today = todayLocal();
  const health = (await scopedAthletes(db, v, "health.read")).length > 0;
  const [summary, queueCount, queue, alerts, settings, activeQs] = await Promise.all([
    health ? wellnessCompletionSummary(db, v, today) : null,
    reviewQueueCount(db, v),
    reviewQueue(db, v),
    loadAlerts(db, v, today),
    scienceSettings(db, v.orgId),
    health ? listQuestionnaires(db, v, { activeOnly: true }) : [],
  ]);
  // Readiness board: today's grid for the first active questionnaire (health-scoped in completionGrid).
  const boardQ = activeQs[0] ?? null;
  const board = boardQ ? await completionGrid(db, v, boardQ.id, today) : null;
  return (
    <>
      <ModuleHero kicker="Sports science · AMS" title="Readiness dashboard" description={`Today (${today}, facility time). Every derived number is a documented Teamwork calculation with a version key; vendor values are badged as vendor.`}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {summary ? (
            <>
              <HeroStat label="Wellness answered" value={`${summary.answered}/${summary.expected}`} hint={summary.partial ? `${summary.partial} partial` : "complete responses"} />
              <HeroStat label="No response yet" value={summary.noResponse} hint="Not answered ≠ fine" />
              <HeroStat label="Flagged answers" value={summary.flagged} hint="Per questionnaire thresholds" />
            </>
          ) : null}
          <HeroStat label="Body map review" value={queueCount} hint="New + follow-up" />
          {!summary ? <HeroStat label="Load alerts" value={alerts.filter((a) => a.kind !== "insufficient_data").length} hint="ACWR outside range" /> : null}
        </div>
      </ModuleHero>
      {board && boardQ ? (
        <Card className="mb-6">
          <CardHeader
            title="Today's readiness"
            kicker={`${boardQ.name} · v${boardQ.version} · tw_readiness_v1`}
            action={<ButtonLink href={`/science/wellness?q=${boardQ.id}`} variant="outline" size="sm">Open wellness</ButtonLink>}
          />
          <CardBody className="space-y-2">
            {board.rows.length === 0 ? (
              <p className="text-sm text-ink-3">None of your athletes are targeted by this questionnaire.</p>
            ) : (
              <>
                <ReadinessHeatTable rows={board.rows} questions={board.q.questions} caption="Today's readiness by athlete" hrefFor={(id) => `/science/wellness?q=${boardQ.id}&athlete=${id}#trend`} />
                <HeatLegend />
              </>
            )}
          </CardBody>
        </Card>
      ) : null}
      {summary ? null : (
        <Callout className="mb-6" title="No health data in your role">
          Wellness, body-map, and wearable data are limited to coaches/admins assigned to the athlete. Training load, KPIs, and volume remain available.
        </Callout>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {summary ? (
          <Card>
            <CardHeader title="Body map review queue" kicker="Self-reported · not a diagnosis" action={<ButtonLink href="/science/body-map" variant="outline" size="sm">Open queue</ButtonLink>} />
            <CardBody>
              {queue.length ? (
                <ul className="divide-y divide-edge">
                  {queue.slice(0, 6).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span>
                        <span className="font-medium">{r.athleteName}</span> · {regionLabel(r.region, r.side)} · {r.kind} {r.severity}/10
                      </span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {fmt(r.reportedAt, "MMM d")} <StatusBadge status={r.reviewStatus} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">Nothing waiting for review.</p>
              )}
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Load alerts" kicker="acwr_rolling_v1" action={<ButtonLink href="/science/load" variant="outline" size="sm">Load monitoring</ButtonLink>} />
          <CardBody>
            <p className="mb-2 text-xs text-ink-3">
              Alert when ACWR &gt; {settings.acwrAlertHigh} or &lt; {settings.acwrAlertLow}. Ratio withheld when window coverage &lt; {Math.round(settings.acwrMinCoverage * 100)}%. <FormulaTag k="acwr_rolling_v1" />
            </p>
            {alerts.length ? (
              <ul className="divide-y divide-edge">
                {alerts.map((a) => (
                  <li key={a.athleteId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <Link href={`/science/load?athlete=${a.athleteId}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    {a.kind === "insufficient_data" ? (
                      <span className="text-xs text-ink-3">Insufficient data · chronic coverage {Math.round(a.acwr.chronicCoverage * 100)}%</span>
                    ) : (
                      <span className="flex items-center gap-2 text-xs font-semibold">
                        <span aria-hidden>{a.kind === "acwr_high" ? "▲" : "▼"}</span>
                        ACWR <AcwrChip ratio={a.acwr.ratio} high={settings.acwrAlertHigh} low={settings.acwrAlertLow} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No load alerts in your scope.</p>
            )}
          </CardBody>
        </Card>
        {summary ? (
          <Card>
            <CardHeader title="Today's wellness" action={<ButtonLink href="/science/wellness" variant="outline" size="sm">Completion grid</ButtonLink>} />
            <CardBody>
              <p className="text-sm text-ink-2">
                {summary.expected === 0 ? "No questionnaires are scheduled for your athletes today." : `${summary.answered} answered, ${summary.partial} partial, ${summary.noResponse} with no response. Missing check-ins are shown separately and never treated as favorable.`}
              </p>
            </CardBody>
          </Card>
        ) : null}
        {can(v, "science.manage") ? (
          <Card>
            <CardHeader title="Thresholds" kicker="Configurable · Teamwork starting points, not norms" />
            <CardBody>
              <ActionForm action={updateSettingsAction} className="grid gap-3 sm:grid-cols-2">
                <Field label="Soreness review threshold (0–10)" htmlFor="st-sore" hint="Pain always creates a review task.">
                  <Input id="st-sore" name="sorenessReviewThreshold" type="number" min={1} max={10} defaultValue={settings.sorenessReviewThreshold} />
                </Field>
                <Field label="Readiness flag below (0–100)" htmlFor="st-ready">
                  <Input id="st-ready" name="readinessFlagBelow" type="number" min={0} max={100} defaultValue={settings.readinessFlagBelow} />
                </Field>
                <Field label="ACWR min window coverage (%)" htmlFor="st-cov">
                  <Input id="st-cov" name="acwrMinCoveragePct" type="number" min={50} max={100} defaultValue={Math.round(settings.acwrMinCoverage * 100)} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="ACWR high" htmlFor="st-hi">
                    <Input id="st-hi" name="acwrAlertHigh" type="number" step="0.05" defaultValue={settings.acwrAlertHigh} />
                  </Field>
                  <Field label="ACWR low" htmlFor="st-lo">
                    <Input id="st-lo" name="acwrAlertLow" type="number" step="0.05" defaultValue={settings.acwrAlertLow} />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <SubmitButton>Save thresholds</SubmitButton>
                </div>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

async function AthleteToday() {
  const v = await requireViewer();
  const today = todayLocal();
  const [self] = await scopedAthletes(db, v, "health.write");
  if (!self) return <EmptyState title="No athlete profile is linked to this login." />;
  const qs = await questionnairesForAthlete(db, v, self.id, today);
  const due = qs.filter((q) => q.due);
  const habits = await habitSummaries(db, v, self.id, today, today);
  const canLog = await canOnAthlete(db, v, self.id, "training.log");
  return (
    <>
      <PageHeader kicker={today} title={`Hi ${self.firstName}`} description="Your daily check-in, habits, and body map. Your answers go to your assigned coaches." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Today's check-in" />
          <CardBody>
            {due.length === 0 ? (
              <p className="text-sm text-ink-3">No check-in is scheduled for you today.</p>
            ) : (
              due.map((q) => (
                <div key={q.id} className="space-y-3">
                  <p className="text-sm text-ink-3">
                    {q.name} · v{q.version} {q.response ? <span className="font-medium text-ok">· Submitted — you can update it</span> : null}
                  </p>
                  <CheckinForm athleteId={self.id} questionnaireId={q.id} questions={q.questions} existing={q.response?.answers ?? null} forDate={today} />
                </div>
              ))
            )}
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Habits" action={<ButtonLink href="/science/habits" variant="ghost" size="sm">History</ButtonLink>} />
            <CardBody>
              {habits.length === 0 ? (
                <p className="text-sm text-ink-3">No habits assigned.</p>
              ) : (
                <ul className="space-y-4">
                  {habits.map((h) => (
                    <li key={h.habit.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <span className="font-medium">{h.habit.name}</span>
                        <span className="text-xs text-ink-3">{h.habit.targetValue != null ? `Target ${h.habit.targetValue} ${h.habit.targetUnit}` : h.habit.frequency}</span>
                      </div>
                      {canLog ? <HabitCheckinForm habitId={h.habit.id} athleteId={self.id} forDate={today} unit={h.habit.targetUnit} current={h.todayStatus} /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Body map" />
            <CardBody>
              <p className="mb-3 text-sm text-ink-2">Sore or hurting somewhere? Mark it on the body map so your coach knows. This is not a diagnosis.</p>
              <ButtonLink href="/science/body-map" size="lg" className="w-full">
                Report soreness or pain
              </ButtonLink>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
