import Link from "next/link";
import { and, count, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { workouts } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter, isStaff } from "@/lib/authz/policy";
import { addDaysYmd, startOfWeekYmd, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { athleteTrainingSnapshot } from "@/lib/training/dashboard";
import { groupsForViewer } from "@/lib/training/assignments";
import { weightRoomRoster } from "@/lib/training/weightroom";
import { ButtonLink, Card, CardBody, CardHeader, EmptyState, StatusBadge } from "@/components/ui";
import { TrainingNav } from "./_components/training-nav";
import { CoachTrainingFeedCard, PrAlertsCard, TodayTrainingCard } from "./_components/dashboard-cards";
import { HeroLink, HeroStat, ModuleHero, ProgressBar, ProgressText, WeekStrip, type WeekDay } from "./_components/tb";

export const metadata = { title: "Training" };

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function TrainingHome() {
  const viewer = await requireViewer();
  const today = todayLocal();

  if (!isStaff(viewer)) {
    const ids = await accessibleAthleteIds(db, viewer, "training.read");
    const list = ids === "all" ? [] : ids;
    const names = await athleteNames(db, viewer.orgId, list);
    const snaps = await Promise.all(list.map(async (id) => ({ id, name: names.get(id) ?? "Athlete", snap: await athleteTrainingSnapshot(db, viewer, id, today) })));
    return (
      <div className="mx-auto max-w-3xl">
        <ModuleHero
          kicker="Training"
          title={viewer.role === "athlete" ? "My training" : "Training"}
          actions={viewer.role === "athlete" ? <HeroLink href="/training/today" primary>Today&apos;s workout →</HeroLink> : undefined}
        />
        <TrainingNav viewer={viewer} current="overview" />
        {snaps.length === 0 ? (
          <EmptyState title="No training access">{viewer.role === "guardian" ? "Your account doesn't include training access for any athlete. Ask the front desk if this is unexpected." : "No training program is linked to your account yet."}</EmptyState>
        ) : (
          <div className="space-y-4">
            {snaps.map(({ id, name, snap }) => {
              const adh = snap?.adherence28d;
              return (
                <Card key={id}>
                  <CardHeader title={name} kicker="Athlete" action={<ButtonLink href={`/training/athletes/${id}`} variant="secondary" size="sm">History & maxes</ButtonLink>} />
                  <CardBody className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="kicker">Adherence (28 days)</div>
                      <div className="mt-1 text-4xl leading-none font-extrabold tabular">{adh?.pct != null ? `${adh.pct}%` : "—"}</div>
                      {adh ? (
                        <>
                          <ProgressBar done={adh.completed} total={adh.scheduled} className="mt-2" />
                          <p className="mt-1 text-xs text-ink-3">
                            {adh.completed} of {adh.scheduled} scheduled workouts completed
                          </p>
                        </>
                      ) : null}
                    </div>
                    <div className="rounded-lg border border-edge bg-surface-2 p-3">
                      <div className="kicker">Next workout</div>
                      {snap?.next ? (
                        <>
                          <div className="mt-1 text-lg font-bold leading-tight">{snap.next.title}</div>
                          <Link href={`/training/today?date=${snap.next.scheduledDate}`} className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline-offset-2 hover:underline">
                            {snap.next.scheduledDate} →
                          </Link>
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-ink-3">Nothing scheduled</p>
                      )}
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const scope = await accessibleAthleteIds(db, viewer, "training.read");
  const weekStart = startOfWeekYmd(today);
  const weekEnd = addDaysYmd(weekStart, 6);
  const [[{ n: unreviewed }], [{ n: todayCount }], week, weekRows, groupList] = await Promise.all([
    db
      .select({ n: count() })
      .from(workouts)
      .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), eq(workouts.status, "completed"), isNull(workouts.coachReviewedAt))),
    db
      .select({ n: count() })
      .from(workouts)
      .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), eq(workouts.scheduledDate, today))),
    db
      .select({ status: workouts.status })
      .from(workouts)
      .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), inArray(workouts.scheduledDate, Array.from({ length: 7 }, (_, i) => addDaysYmd(today, -i))))),
    // Calendar strip for the current Mon–Sun week (same scope filter as the counts above).
    db
      .select({ date: workouts.scheduledDate, status: workouts.status, title: workouts.title })
      .from(workouts)
      .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), gte(workouts.scheduledDate, weekStart), lte(workouts.scheduledDate, weekEnd))),
    groupsForViewer(db, viewer),
  ]);
  const wkDone = week.filter((w) => w.status === "completed").length;

  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysYmd(weekStart, i);
    const rows = weekRows.filter((r) => r.date === date);
    const byTitle = new Map<string, { title: string; athletes: number; completed: number }>();
    for (const r of rows) {
      const s = byTitle.get(r.title) ?? { title: r.title, athletes: 0, completed: 0 };
      s.athletes++;
      if (r.status === "completed") s.completed++;
      byTitle.set(r.title, s);
    }
    return {
      date,
      dow: DOW[i],
      dayNum: String(Number(date.slice(8))),
      isToday: date === today,
      total: rows.length,
      completed: rows.filter((r) => r.status === "completed").length,
      sessions: [...byTitle.values()].sort((a, b) => b.athletes - a.athletes),
    };
  });

  // Today's board per group (same roster the weight-room tablet uses; scope-checked there).
  const rosters = (
    await Promise.all(
      groupList.slice(0, 8).map((g) =>
        weightRoomRoster(db, viewer, g.id, today).catch(() => null),
      ),
    )
  ).filter((r): r is NonNullable<typeof r> => !!r && r.athletes.some((a) => a.workout));

  return (
    <div>
      <ModuleHero
        kicker="Training"
        title="Strength & conditioning"
        description="Programs, weight-room logging, maxes, and progress for the athletes you coach."
        actions={
          <>
            <HeroLink href="/training/weight-room" primary>
              Open weight room
            </HeroLink>
            <HeroLink href="/training/review">Review results</HeroLink>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <HeroStat label="Workouts today" value={todayCount} hint="In your scope" />
          <HeroStat label="Awaiting review" value={unreviewed} hint={<Link href="/training/review?review=unreviewed">Open review queue</Link>} />
          <HeroStat label="Last 7 days completion" value={week.length ? `${Math.round((wkDone / week.length) * 100)}%` : "—"} hint={`${wkDone} of ${week.length} scheduled workouts`} />
        </div>
      </ModuleHero>
      <TrainingNav viewer={viewer} current="overview" />

      <section aria-labelledby="week-h" className="mb-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="week-h" className="text-lg font-bold">
            This week
          </h2>
          <span className="text-xs text-ink-3">
            {weekStart} – {weekEnd} · sessions and athletes scheduled per day
          </span>
        </div>
        <WeekStrip days={days} hrefFor={(d) => `/training/today?date=${d}`} />
      </section>

      <section aria-labelledby="today-h" className="mb-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="today-h" className="text-lg font-bold">
            Today by group
          </h2>
          <Link href="/training/today" className="text-sm font-semibold text-brand hover:underline">
            All of today&apos;s workouts →
          </Link>
        </div>
        {rosters.length === 0 ? (
          <TodayTrainingCard viewer={viewer} date={today} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rosters.map((r) => {
              const withW = r.athletes.filter((a) => a.workout);
              const done = withW.reduce((s, a) => s + (a.workout?.progress.done ?? 0), 0);
              const total = withW.reduce((s, a) => s + (a.workout?.progress.total ?? 0), 0);
              const finished = withW.filter((a) => a.workout?.status === "completed").length;
              return (
                <Card key={r.group.id} className="flex flex-col">
                  <div className="border-b border-edge px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="kicker">Group</div>
                        <h3 className="truncate text-base font-bold">{r.group.name}</h3>
                      </div>
                      <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold tabular text-ink-2">
                        {finished}/{withW.length} finished
                      </span>
                    </div>
                    <ProgressBar done={done} total={total} size="lg" className="mt-2" />
                    <ProgressText done={done} total={total} className="mt-1 block" />
                  </div>
                  <ul className="flex-1 divide-y divide-edge/70 px-4 py-1">
                    {withW.slice(0, 6).map((a) => (
                      <li key={a.athleteId} className="py-2">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <Link href={`/training/workouts/${a.workout!.id}`} className="min-w-0 truncate font-semibold hover:underline">
                            {a.name}
                          </Link>
                          <span className="flex shrink-0 items-center gap-2">
                            <ProgressText done={a.workout!.progress.done} total={a.workout!.progress.total} unit="" />
                            {a.workout!.status !== "scheduled" ? <StatusBadge status={a.workout!.status} /> : null}
                          </span>
                        </div>
                        <div className="truncate text-xs text-ink-3">{a.workout!.title}</div>
                        <ProgressBar done={a.workout!.progress.done} total={a.workout!.progress.total} complete={a.workout!.status === "completed"} size="sm" className="mt-1" />
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-edge px-4 py-2 text-sm">
                    <Link href={`/training/weight-room?group=${r.group.id}`} className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline">
                      {withW.length > 6 ? `+${withW.length - 6} more · ` : ""}Log in weight room →
                    </Link>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <PrAlertsCard viewer={viewer} />
        <CoachTrainingFeedCard viewer={viewer} />
      </div>
    </div>
  );
}
