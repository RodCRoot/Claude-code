import Link from "next/link";
import { db } from "@/db";
import { can, type Viewer } from "@/lib/authz/policy";
import { journeyPanel, staffOptions } from "@/lib/journey/steps";
import { fmtDate } from "@/lib/time";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { Meter } from "@/components/profile/studio";
import { StepRow } from "./step-row";

const RECOGNISED = { recognised: ["green", "Recognised"], open: ["yellow", "Not recognised yet"], skipped: ["neutral", "Skipped"], not_tracked: ["neutral", "Reached before tracking began"] } as const;

/**
 * Staff profile panel: where the member is in onboarding (and any hold or offboarding checklist),
 * upcoming touchpoints, and visit milestones with whether each was recognised. Coaches get it
 * only for their athletes and without billing steps (enforced in journeyPanel).
 */
export async function JourneyPanel({ v, athleteId }: { v: Viewer; athleteId: string }) {
  if (!can(v, "journey.view")) return null;
  const [panel, staff] = await Promise.all([db.transaction((tx) => journeyPanel(tx, v, athleteId)), staffOptions(db, v)]);
  if (!panel) return null;
  const coach = v.role === "coach";
  const reached = panel.milestones.filter((m) => m.reachedOn);
  const next = panel.milestones.find((m) => !m.reachedOn);
  const active = panel.journeys.filter((j) => j.status === "active");
  const past = panel.journeys.filter((j) => j.status !== "active");
  return (
    <Card id="journey">
      <CardHeader title="Member journey" kicker={`${panel.visits} visit${panel.visits === 1 ? "" : "s"}`} action={<Link href="/follow-ups" className="text-xs font-semibold text-brand hover:underline">All follow-ups<span aria-hidden> ›</span></Link>} />
      {active.length === 0 && past.length === 0 && panel.upcoming.length === 0 && reached.length === 0 ? (
        <CardBody>
          <p className="text-sm text-ink-3">No journey steps yet. They start on their own when a membership or trial begins, a hold is recorded, or a visit milestone is reached.</p>
        </CardBody>
      ) : null}

      {active.map((j) => (
        <section key={j.id} aria-label={j.label} className="border-t border-edge first:border-t-0">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-2/50 px-4 py-2">
            <h3 className="text-sm font-bold">
              {j.label} <span className="font-normal text-ink-3">since {fmtDate(j.startedOn)}</span>
            </h3>
            <span className="flex items-center gap-2 text-xs text-ink-3">
              <span className="w-24">
                <Meter value={j.done} max={j.total} tone={j.done === j.total ? "ok" : "brand"} />
              </span>
              {j.done} of {j.total} done
            </span>
          </div>
          <ul className="divide-y divide-edge">
            {j.steps.map((s) => (
              <StepRow key={s.taskId} s={s} staff={staff} showAthlete={false} coachView={coach} />
            ))}
          </ul>
        </section>
      ))}

      {panel.upcoming.length ? (
        <section aria-label="Upcoming touchpoints" className="border-t border-edge px-4 py-3">
          <h3 className="text-sm font-bold">Upcoming touchpoints</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {panel.upcoming.map((u) => (
              <li key={u.key} className="flex flex-wrap justify-between gap-2">
                <span>{u.name}</span>
                <span className="text-ink-3">
                  {fmtDate(u.dueOn)}
                  {u.moved ? " (moved for a hold)" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reached.length || next ? (
        <section aria-label="Visit milestones" className="border-t border-edge px-4 py-3">
          <h3 className="text-sm font-bold">Visit milestones</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {reached.map((m) => (
              <li key={m.visits} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {m.visits} visits <span className="text-ink-3">reached {fmtDate(m.reachedOn)}</span>
                </span>
                {m.recognised ? <Badge variant={RECOGNISED[m.recognised][0]}>{RECOGNISED[m.recognised][1]}</Badge> : null}
              </li>
            ))}
            {next ? (
              <li className="text-ink-3">
                Next: {next.visits} visits ({next.visits - panel.visits} to go)
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {past.length ? (
        <details className="border-t border-edge px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink-2">Finished checklists ({past.length})</summary>
          {past.map((j) => (
            <div key={j.id} className="mt-2">
              <p className="text-sm font-medium">
                {j.label} <span className="font-normal text-ink-3">from {fmtDate(j.startedOn)}: {j.status === "closed" ? `closed (${j.closedReason ?? "no reason"})` : "completed"}</span>
              </p>
              <ul className="divide-y divide-edge rounded-md border border-edge">
                {j.steps.map((s) => (
                  <StepRow key={s.taskId} s={s} staff={staff} showAthlete={false} coachView={coach} />
                ))}
              </ul>
            </div>
          ))}
        </details>
      ) : null}
    </Card>
  );
}
