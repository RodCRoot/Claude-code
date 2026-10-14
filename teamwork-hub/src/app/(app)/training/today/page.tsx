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
import { Callout, EmptyState, StatusBadge } from "@/components/ui";
import { HeroLink, ModuleHero, ProgressBar, pctOf } from "../_components/tb";
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
      <ModuleHero
        kicker={date === today ? `Training · ${fmtDate(date)}` : "Training"}
        title={date === today ? "Today's workout" : `Workout · ${fmtDate(date)}`}
        description={viewer.role === "guardian" ? "Read-only view of your athletes' training." : staffView ? "Workouts scheduled for your athletes. Use the weight room view to log for a group." : "Log each set as you go. Entries save on this device first and sync automatically."}
        actions={staffView ? <HeroLink href="/training/weight-room">Weight room</HeroLink> : undefined}
      />
      <TrainingNav viewer={viewer} current={viewer.role === "athlete" ? "today" : "overview"} />
      <nav aria-label="Date" className="mb-4 flex items-center justify-between gap-2">
        <Link href={`/training/today?date=${addDaysYmd(date, -1)}`} className="min-h-11 rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm font-semibold hover:bg-surface-2">
          ← Previous day
        </Link>
        {date !== today ? (
          <Link href="/training/today" className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Back to today
          </Link>
        ) : null}
        <Link href={`/training/today?date=${addDaysYmd(date, 1)}`} className="min-h-11 rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm font-semibold hover:bg-surface-2">
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
        <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface">
          {list.map((w) => (
            <li key={w.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/training/workouts/${w.id}`} className="font-bold text-brand hover:underline">
                    {w.athleteName}
                  </Link>
                  <div className="text-xs text-ink-3">{w.title}</div>
                </div>
                <div className="flex items-center gap-3 text-sm font-semibold tabular">
                  {w.progress.done}/{w.progress.total} sets
                  <StatusBadge status={w.status} />
                </div>
              </div>
              <ProgressBar done={w.progress.done} total={w.progress.total} complete={w.status === "completed"} size="sm" className="mt-2" />
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-8">
          {list.map((w) => {
            const loggable = canLog(w.athleteId) && viewer.role === "athlete";
            return (
              <article key={w.id} aria-labelledby={`w-${w.id}`} className="space-y-3">
                <header className="rounded-xl border border-edge bg-surface p-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="kicker">{viewer.role === "guardian" ? w.athleteName : "Session"}</div>
                      <h2 id={`w-${w.id}`} className="text-xl leading-tight font-extrabold">
                        {w.title}
                      </h2>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {w.items.length} exercise{w.items.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl leading-none font-extrabold tabular">{pctOf(w.progress.done, w.progress.total) ?? 0}%</div>
                      <StatusBadge status={w.status} className="mt-1" />
                    </div>
                  </div>
                  <ProgressBar done={w.progress.done} total={w.progress.total} complete={w.status === "completed"} size="lg" className="mt-3" />
                  <p className="mt-1 text-xs font-semibold tabular text-ink-2">
                    {w.progress.done}/{w.progress.total} sets logged
                  </p>
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
          <h2 id="upcoming-h" className="mb-2 text-lg font-bold">
            Coming up (next 7 days)
          </h2>
          <ul className="divide-y divide-edge rounded-xl border border-edge bg-surface">
            {upcoming.map((u) => (
              <li key={u.id}>
                <Link href={`/training/today?date=${u.date}`} className="flex min-h-11 items-center justify-between px-4 py-2 text-sm hover:bg-surface-2">
                  <span className="font-semibold">{u.title}</span>
                  <span className="text-ink-3">{fmtDate(u.date)} →</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
