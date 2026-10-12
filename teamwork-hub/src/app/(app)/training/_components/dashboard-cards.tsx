import Link from "next/link";
import { db } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { fmt, todayLocal } from "@/lib/time";
import { recentLogsForCoach, todaysWorkoutSummary } from "@/lib/training/dashboard";
import { prAlerts } from "@/lib/training/review";
import { Card, CardBody, CardHeader, EmptyState, StatusBadge } from "@/components/ui";

/**
 * Server components exported for the Today and People dashboards.
 * Each enforces scope internally via the training library (policy.ts).
 */
export async function TodayTrainingCard({ viewer, date = todayLocal() }: { viewer: Viewer; date?: string }) {
  const items = await todaysWorkoutSummary(db, viewer, date);
  return (
    <Card>
      <CardHeader
        kicker="Training"
        title="Today's workouts"
        action={
          <Link href={viewer.role === "athlete" ? "/training/today" : "/training/weight-room"} className="text-sm font-medium text-brand hover:underline">
            {viewer.role === "athlete" ? "Start logging" : "Weight room"}
          </Link>
        }
      />
      <CardBody>
        {items.length === 0 ? (
          <p className="text-sm text-ink-3">No workouts scheduled today.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {items.map((w) => (
              <li key={w.workoutId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <Link href={w.href} className="min-w-0 truncate hover:underline">
                  {viewer.role === "athlete" ? w.title : `${w.athleteName} — ${w.title}`}
                </Link>
                <span className="flex shrink-0 items-center gap-2 tabular text-ink-3">
                  {w.setsDone}/{w.setsTotal}
                  <StatusBadge status={w.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export async function CoachTrainingFeedCard({ viewer, limit = 8 }: { viewer: Viewer; limit?: number }) {
  const logs = await recentLogsForCoach(db, viewer, limit);
  return (
    <Card>
      <CardHeader kicker="Training" title="Recent logged sets" action={<Link href="/training/review" className="text-sm font-medium text-brand hover:underline">Review</Link>} />
      <CardBody>
        {logs.length === 0 ? (
          <p className="text-sm text-ink-3">No sets logged yet.</p>
        ) : (
          <ul className="divide-y divide-edge text-sm">
            {logs.map((l, i) => (
              <li key={i} className="py-2">
                <Link href={`/training/workouts/${l.workoutId}`} className="font-medium hover:underline">
                  {l.athleteName}
                </Link>{" "}
                <span className="text-ink-2">
                  {l.exercise} · {l.summary}
                </span>
                <div className="text-xs text-ink-3">{fmt(l.loggedAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export async function PrAlertsCard({ viewer, since, limit = 10 }: { viewer: Viewer; since?: string; limit?: number }) {
  const alerts = (await prAlerts(db, viewer, { since })).slice(0, limit);
  return (
    <Card>
      <CardHeader kicker="Training" title="PR alerts (last 14 days)" />
      <CardBody>
        {alerts.length === 0 ? (
          <EmptyState title="No new PRs">New best e1RMs (Epley v1) and tested maxes appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-edge text-sm">
            {alerts.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>
                  <Link href={`/training/athletes/${a.athleteId}`} className="font-medium hover:underline">
                    {a.athleteName}
                  </Link>{" "}
                  · {a.exerciseName}
                </span>
                <span className="tabular">
                  <strong>
                    {a.value} {a.unit}
                  </strong>{" "}
                  <span className="text-xs text-ink-3">
                    {a.kind === "tested" ? "tested max" : "e1RM"} (prev {a.previous} {a.unit}) · {a.date}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
