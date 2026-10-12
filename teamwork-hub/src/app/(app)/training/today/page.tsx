import Link from "next/link";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { db } from "@/db";
import { workouts } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter, isStaff } from "@/lib/authz/policy";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { workoutsForDate } from "@/lib/training/dashboard";
import { offlineOwnerKey } from "@/lib/training/offline";
import { TrainingOfflineSetup } from "../_components/offline-setup";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Callout, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { CompleteWorkoutForm, SyncBanner, WorkoutLogger } from "../_components/workout-logger";
import { workoutStatusAction } from "../actions";
import { isYmd, sp } from "../_lib/helpers";

export const metadata = { title: "Today's training" };

export default async function TrainingToday({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const q = await searchParams;
  const today = todayLocal();
  const date = isYmd(sp(q.date)) ? sp(q.date) : today;
  const list = await workoutsForDate(db, viewer, date);
  const logScope = await accessibleAthleteIds(db, viewer, "training.log");
  const canLog = (athleteId: string) => logScope === "all" || logScope.includes(athleteId);

  const readScope = await accessibleAthleteIds(db, viewer, "training.read");
  const upcoming =
    viewer.role === "athlete" || viewer.role === "guardian"
      ? await db
          .select({ id: workouts.id, date: workouts.scheduledDate, title: workouts.title, status: workouts.status })
          .from(workouts)
          .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(readScope, workouts.athleteId), gt(workouts.scheduledDate, date), lte(workouts.scheduledDate, addDaysYmd(date, 7))))
          .orderBy(asc(workouts.scheduledDate))
          .limit(10)
      : [];
  const staffView = isStaff(viewer);
  const offlineOwner = offlineOwnerKey(viewer);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        kicker="Training"
        title={date === today ? "Today's workout" : `Workout · ${fmtDate(date)}`}
        description={viewer.role === "guardian" ? "Read-only view of your athletes' training." : staffView ? "Workouts scheduled for your athletes. Use the weight room view to log for a group." : "Log each set as you go. Entries save on this device first and sync automatically."}
        actions={staffView ? <ButtonLink href="/training/weight-room" variant="secondary">Weight room</ButtonLink> : undefined}
      />
      <TrainingNav viewer={viewer} current={viewer.role === "athlete" ? "today" : "overview"} />
      <nav aria-label="Date" className="mb-4 flex items-center justify-between gap-2">
        <Link href={`/training/today?date=${addDaysYmd(date, -1)}`} className="min-h-11 rounded-lg border border-edge px-3 py-2.5 text-sm font-medium">
          ← Previous day
        </Link>
        {date !== today ? (
          <Link href="/training/today" className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Back to today
          </Link>
        ) : null}
        <Link href={`/training/today?date=${addDaysYmd(date, 1)}`} className="min-h-11 rounded-lg border border-edge px-3 py-2.5 text-sm font-medium">
          Next day →
        </Link>
      </nav>

      {logScope === "all" || logScope.length ? <SyncBanner className="mb-4" /> : null}
      {offlineOwner ? (
        <div className="-mt-2 mb-4">
          <TrainingOfflineSetup owner={offlineOwner} />
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState title="No workout scheduled">{viewer.role === "athlete" ? "Rest day — or check the upcoming list below." : "Nothing scheduled for this date in your scope."}</EmptyState>
      ) : staffView ? (
        <ul className="divide-y divide-edge rounded-xl border border-edge bg-surface">
          {list.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <Link href={`/training/workouts/${w.id}`} className="font-medium text-brand hover:underline">
                  {w.athleteName}
                </Link>
                <div className="text-xs text-ink-3">{w.title}</div>
              </div>
              <div className="flex items-center gap-3 text-sm tabular">
                {w.progress.done}/{w.progress.total} sets
                <StatusBadge status={w.status} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-8">
          {list.map((w) => {
            const loggable = canLog(w.athleteId) && viewer.role === "athlete";
            return (
              <article key={w.id} aria-labelledby={`w-${w.id}`} className="space-y-3">
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 id={`w-${w.id}`} className="text-lg font-bold">
                      {w.title}
                    </h2>
                    <p className="text-xs text-ink-3">
                      {viewer.role === "guardian" ? `${w.athleteName} · ` : ""}
                      {w.progress.done}/{w.progress.total} sets logged
                    </p>
                  </div>
                  <StatusBadge status={w.status} />
                </header>
                {w.coachFeedback ? (
                  <Callout tone="info" title="Coach feedback">
                    {w.coachFeedback}
                  </Callout>
                ) : null}
                {w.status === "skipped" ? <Callout tone="warn">This workout is marked skipped.</Callout> : null}
                <WorkoutLogger workout={w} canLog={loggable} />
                {loggable && w.status !== "skipped" ? <CompleteWorkoutForm workout={w} /> : null}
                {loggable && w.status !== "completed" ? (
                  <ActionForm action={workoutStatusAction}>
                    <input type="hidden" name="workoutId" value={w.id} />
                    <input type="hidden" name="status" value={w.status === "skipped" ? "scheduled" : "skipped"} />
                    <SubmitButton variant="ghost" confirm={w.status === "skipped" ? undefined : "Mark this workout as skipped? Your coach will see it as missed."}>
                      {w.status === "skipped" ? "Reopen workout" : "Skip this workout"}
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {upcoming.length ? (
        <section className="mt-10" aria-labelledby="upcoming-h">
          <h2 id="upcoming-h" className="mb-2 font-semibold">
            Coming up (next 7 days)
          </h2>
          <ul className="divide-y divide-edge rounded-xl border border-edge bg-surface">
            {upcoming.map((u) => (
              <li key={u.id}>
                <Link href={`/training/today?date=${u.date}`} className="flex min-h-11 items-center justify-between px-4 py-2 text-sm hover:bg-surface-2">
                  <span>{u.title}</span>
                  <span className="text-ink-3">{fmtDate(u.date)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
