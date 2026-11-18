import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { coachScorecard, coachScorecards, weekStartOf, type Scorecard } from "@/lib/journey/scorecard";
import { journeyContext } from "@/lib/journey/sync";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Textarea } from "@/components/ui";
import { FollowUpTabs } from "@/components/journey/tabs";
import { saveReflectionAction } from "../actions";

export const metadata = { title: "Coach scorecard" };

function Metric({ label, value, target, unit = "", met }: { label: string; value: string; target: number; unit?: string; met: boolean | null }) {
  return (
    <div className="rounded-md border border-edge bg-surface-2/50 px-3 py-2">
      <dt className="text-xs font-semibold text-ink-3">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-2">
        <span className="text-xl font-bold tabular">{value}</span>
        <span className="text-xs text-ink-3">
          target {target}
          {unit}
        </span>
        {met === null ? <Badge>No data</Badge> : met ? <Badge variant="green">On target</Badge> : <Badge variant="yellow">Below target</Badge>}
      </dd>
    </div>
  );
}

function Numbers({ c }: { c: Scorecard }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      <Metric label={`Session utilisation (${c.booked} booked of ${c.capacity} places in ${c.sessions} session${c.sessions === 1 ? "" : "s"})`} value={c.utilisationPercent === null ? "—" : `${c.utilisationPercent}%`} target={c.targets.utilisationPercent} unit="%" met={c.utilisationPercent === null ? null : c.utilisationPercent >= c.targets.utilisationPercent} />
      <Metric label="Client reach-outs logged" value={String(c.reachOuts)} target={c.targets.reachOuts} met={c.reachOuts >= c.targets.reachOuts} />
      <Metric label="Client meetings / assessments held" value={String(c.meetings)} target={c.targets.meetings} met={c.meetings >= c.targets.meetings} />
      <Metric label={`Touchpoints on time (${c.touchpointsOnTime} of ${c.touchpointsDue} due)`} value={c.touchpointsOnTimePercent === null ? "—" : `${c.touchpointsOnTimePercent}%`} target={c.targets.touchpointsOnTimePercent} unit="%" met={c.touchpointsOnTimePercent === null ? null : c.touchpointsOnTimePercent >= c.targets.touchpointsOnTimePercent} />
    </dl>
  );
}

function Reflection({ c }: { c: Scorecard }) {
  if (!c.reflection) return <p className="mt-3 text-sm text-ink-3">No reflection written for this week.</p>;
  const rows: [string, string | null][] = [["What went well", c.reflection.wentWell], ["What is stuck", c.reflection.stuck], ["What help is needed", c.reflection.helpNeeded]];
  return (
    <dl className="mt-3 space-y-2 text-sm">
      {rows.map(([k, val]) => (
        <div key={k}>
          <dt className="text-xs font-semibold text-ink-3">{k}</dt>
          <dd className="whitespace-pre-wrap">{val || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function ScorecardPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const v = await requireCap("journey.view");
  const sp = await searchParams;
  const { tz } = await journeyContext(db, v.orgId);
  const today = todayLocal(tz);
  const thisWeek = weekStartOf(today);
  const asked = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? weekStartOf(sp.week) : thisWeek;
  const week = asked > thisWeek ? thisWeek : asked;
  const all = can(v, "journey.report");
  const cards = all ? await coachScorecards(db, v, { weekStart: week }) : [];
  const own = v.role === "coach" || !all ? await coachScorecard(db, v, { weekStart: week }) : null;

  return (
    <>
      <PageHeader
        kicker="Coaching"
        title="Coach weekly scorecard"
        description={`Week of ${fmtDate(week)} to ${fmtDate(addDaysYmd(week, 6))}. The numbers are worked out from sessions, bookings, logged reach-outs and journey touchpoints; targets are set in Settings > Member journey.`}
        actions={
          <span className="flex gap-3 text-sm font-semibold">
            <Link href={`/follow-ups/scorecard?week=${addDaysYmd(week, -7)}`} className="text-brand underline">
              Previous week
            </Link>
            {week < thisWeek ? (
              <Link href={`/follow-ups/scorecard?week=${addDaysYmd(week, 7)}`} className="text-brand underline">
                Next week
              </Link>
            ) : null}
          </span>
        }
      />
      <FollowUpTabs current="scorecard" showReport={all} />

      {own ? (
        <Card className="mb-4">
          <CardHeader title={`${own.coachName}: my week`} />
          <CardBody>
            <Numbers c={own} />
            <ActionForm action={saveReflectionAction} className="mt-4 space-y-3">
              <input type="hidden" name="weekStart" value={week} />
              <h3 className="text-sm font-bold">Weekly reflection</h3>
              <p className="text-xs text-ink-3">Short and honest. The owner reads it; nobody else does.</p>
              {(
                [
                  ["wentWell", "What went well", own.reflection?.wentWell],
                  ["stuck", "What is stuck", own.reflection?.stuck],
                  ["helpNeeded", "What help is needed", own.reflection?.helpNeeded],
                ] as const
              ).map(([name, label, val]) => (
                <div key={name}>
                  <label htmlFor={`r-${name}`} className="mb-1 block text-sm font-medium text-ink-2">
                    {label}
                  </label>
                  <Textarea id={`r-${name}`} name={name} defaultValue={val ?? ""} maxLength={1500} />
                </div>
              ))}
              <SubmitButton>Save reflection</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      {all ? (
        cards.length ? (
          <div className="space-y-4">
            {cards.map((c) => (
              <Card key={c.coachUserId}>
                <CardHeader title={c.coachName} />
                <CardBody>
                  <Numbers c={c} />
                  <Reflection c={c} />
                </CardBody>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState title="No coaches yet">Scorecards appear for every active coach login.</EmptyState>
          </Card>
        )
      ) : null}
    </>
  );
}
