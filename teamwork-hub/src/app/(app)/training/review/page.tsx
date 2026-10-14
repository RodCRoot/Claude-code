import Link from "next/link";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { groupsForViewer } from "@/lib/training/assignments";
import { reviewFeed } from "@/lib/training/review";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Button, Card, CardBody, EmptyState, Field, Input, PageHeader, Select, StatusBadge } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { PrAlertsCard } from "../_components/dashboard-cards";
import { reviewWorkoutAction } from "../actions";
import { isYmd, sp } from "../_lib/helpers";

export const metadata = { title: "Review results" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireStaff();
  const q = await searchParams;
  const today = todayLocal();
  const groupList = await groupsForViewer(db, viewer);
  const f = {
    groupId: groupList.some((g) => g.id === sp(q.group)) ? sp(q.group) : undefined,
    review: (["unreviewed", "reviewed", "all"].includes(sp(q.review)) ? sp(q.review) : "unreviewed") as "unreviewed" | "reviewed" | "all",
    from: isYmd(sp(q.from)) ? sp(q.from) : addDaysYmd(today, -14),
    to: isYmd(sp(q.to)) ? sp(q.to) : today,
  };
  const feed = await reviewFeed(db, viewer, { ...f, limit: 60 });
  const canReview = can(viewer, "training.manage");

  return (
    <div>
      <PageHeader kicker="Training" title="Review logged results" description="Completed and in-progress workouts from athletes in your scope." />
      <TrainingNav viewer={viewer} current="review" />
      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-5 sm:items-end">
        <Field label="Group" htmlFor="rv-g">
          <Select id="rv-g" name="group" defaultValue={f.groupId ?? ""}>
            <option value="">All my athletes</option>
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="rv-s">
          <Select id="rv-s" name="review" defaultValue={f.review}>
            <option value="unreviewed">Needs review</option>
            <option value="reviewed">Reviewed</option>
            <option value="all">All</option>
          </Select>
        </Field>
        <Field label="From" htmlFor="rv-f">
          <Input id="rv-f" type="date" name="from" defaultValue={f.from} />
        </Field>
        <Field label="To" htmlFor="rv-t">
          <Input id="rv-t" type="date" name="to" defaultValue={f.to} />
        </Field>
        <Button type="submit" variant="secondary" className="min-h-11">
          Filter
        </Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
          {feed.length === 0 ? <EmptyState title="Nothing to review">No logged workouts match these filters.</EmptyState> : null}
          {feed.map((w) => {
            const top = w.items
              .map((it) => {
                const work = it.logs.filter((l) => l.completed && l.load != null);
                const best = work.reduce<(typeof work)[number] | null>((a, l) => (!a || (l.load ?? 0) > (a.load ?? 0) ? l : a), null);
                return best ? `${it.performed.name} ${best.load} ${best.loadUnit} × ${best.reps ?? "—"}` : null;
              })
              .filter(Boolean)
              .slice(0, 3);
            return (
              <Card key={w.id}>
                <CardBody className="pt-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <Link href={`/training/workouts/${w.id}`} className="font-semibold text-brand hover:underline">
                        {w.athleteName} — {w.title}
                      </Link>
                      <div className="text-xs text-ink-3">
                        {fmtDate(w.scheduledDate)} · {w.progress.done}/{w.progress.total} sets
                        {w.sessionRpe != null ? ` · sRPE ${w.sessionRpe} × ${w.durationMinutes} min` : ""}
                      </div>
                      {top.length ? <div className="mt-1 text-sm text-ink-2">Top sets: {top.join(" · ")}</div> : null}
                      {w.athleteComment ? <div className="mt-1 text-sm">“{w.athleteComment}”</div> : null}
                      {w.coachFeedback ? <div className="mt-1 text-xs text-ok">Feedback: {w.coachFeedback}</div> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={w.status} />
                      {w.coachReviewedAt ? <StatusBadge status="reviewed" /> : null}
                    </div>
                  </div>
                  {canReview && !w.coachReviewedAt ? (
                    <ActionForm action={reviewWorkoutAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="workoutId" value={w.id} />
                      <Field label="Quick feedback (optional)" htmlFor={`fb-${w.id}`} className="min-w-0 flex-1">
                        <Input id={`fb-${w.id}`} name="feedback" maxLength={2000} />
                      </Field>
                      <SubmitButton size="sm" name="reviewed" value="true" className="min-h-11">
                        Mark reviewed
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
        <PrAlertsCard viewer={viewer} />
      </div>
    </div>
  );
}
