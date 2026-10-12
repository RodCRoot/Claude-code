import Link from "next/link";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { workouts } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter, isStaff } from "@/lib/authz/policy";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { athleteTrainingSnapshot } from "@/lib/training/dashboard";
import { ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { TrainingNav } from "./_components/training-nav";
import { CoachTrainingFeedCard, PrAlertsCard, TodayTrainingCard } from "./_components/dashboard-cards";

export const metadata = { title: "Training" };

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
        <PageHeader kicker="Training" title={viewer.role === "athlete" ? "My training" : "Training"} actions={viewer.role === "athlete" ? <ButtonLink href="/training/today">Today&apos;s workout</ButtonLink> : undefined} />
        <TrainingNav viewer={viewer} current="overview" />
        {snaps.length === 0 ? (
          <EmptyState title="No training access">{viewer.role === "guardian" ? "Your account doesn't include training access for any athlete. Ask the front desk if this is unexpected." : "No training program is linked to your account yet."}</EmptyState>
        ) : (
          <div className="space-y-4">
            {snaps.map(({ id, name, snap }) => (
              <Card key={id}>
                <CardHeader title={name} action={<ButtonLink href={`/training/athletes/${id}`} variant="secondary" size="sm">History & maxes</ButtonLink>} />
                <CardBody className="grid gap-3 sm:grid-cols-2">
                  <Stat
                    label="Adherence (28 days)"
                    value={snap?.adherence28d.pct != null ? `${snap.adherence28d.pct}%` : "—"}
                    hint={snap ? `${snap.adherence28d.completed} of ${snap.adherence28d.scheduled} scheduled workouts completed` : undefined}
                  />
                  <Stat label="Next workout" value={snap?.next ? snap.next.title : "—"} hint={snap?.next ? <Link href={`/training/today?date=${snap.next.scheduledDate}`} className="underline">{snap.next.scheduledDate}</Link> : "Nothing scheduled"} />
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  const scope = await accessibleAthleteIds(db, viewer, "training.read");
  const [{ n: unreviewed }] = await db
    .select({ n: count() })
    .from(workouts)
    .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), eq(workouts.status, "completed"), isNull(workouts.coachReviewedAt)));
  const [{ n: todayCount }] = await db
    .select({ n: count() })
    .from(workouts)
    .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), eq(workouts.scheduledDate, today)));
  const week = await db
    .select({ status: workouts.status })
    .from(workouts)
    .where(and(eq(workouts.orgId, viewer.orgId), athleteScopeFilter(scope, workouts.athleteId), inArray(workouts.scheduledDate, Array.from({ length: 7 }, (_, i) => addDaysYmd(today, -i)))));
  const wkDone = week.filter((w) => w.status === "completed").length;

  return (
    <div>
      <PageHeader
        kicker="Training"
        title="Strength & conditioning"
        description="Programs, weight-room logging, maxes, and progress for the athletes you coach."
        actions={
          <>
            <ButtonLink href="/training/weight-room">Open weight room</ButtonLink>
            <ButtonLink href="/training/review" variant="secondary">
              Review results
            </ButtonLink>
          </>
        }
      />
      <TrainingNav viewer={viewer} current="overview" />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Workouts today" value={todayCount} hint="In your scope" />
        <Stat label="Awaiting review" value={unreviewed} hint={<Link href="/training/review?review=unreviewed" className="underline">Open review queue</Link>} tone={unreviewed > 0 ? "warn" : undefined} />
        <Stat label="Last 7 days completion" value={week.length ? `${Math.round((wkDone / week.length) * 100)}%` : "—"} hint={`${wkDone} of ${week.length} scheduled workouts`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TodayTrainingCard viewer={viewer} date={today} />
        <PrAlertsCard viewer={viewer} />
        <CoachTrainingFeedCard viewer={viewer} />
      </div>
    </div>
  );
}
