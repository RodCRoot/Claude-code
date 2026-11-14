import Link from "next/link";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { athleteCapabilities, isStaff } from "@/lib/authz/policy";
import { fmt, fmtDate } from "@/lib/time";
import { workoutDetail } from "@/lib/training/logging";
import { workoutProgress } from "@/lib/training/logging";
import { listExercises } from "@/lib/training/exercises";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, PageHeader, Select, StatusBadge, Textarea, Input } from "@/components/ui";
import { TrainingNav } from "../../_components/training-nav";
import { CompleteWorkoutForm, SyncBanner, WorkoutLogger } from "../../_components/workout-logger";
import { reviewWorkoutAction, substituteAction, workoutStatusAction } from "../../actions";
import { guarded } from "../../_lib/helpers";

export const metadata = { title: "Workout" };

export default async function WorkoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const w = await guarded(() => workoutDetail(db, viewer, id));
  const caps = await athleteCapabilities(db, viewer, w.athleteId);
  const canLog = caps.has("training.log");
  const canReview = caps.has("training.write");
  const allExercises = canReview ? await listExercises(db, viewer) : [];
  const prog = workoutProgress(w);
  const load = w.sessionRpe != null && w.durationMinutes != null ? w.sessionRpe * w.durationMinutes : null;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        kicker={`Workout · ${fmtDate(w.scheduledDate)}`}
        title={w.title}
        description={
          <>
            {caps.has("training.read") && isStaff(viewer) ? (
              <Link href={`/training/athletes/${w.athleteId}`} className="font-medium text-brand hover:underline">
                {w.athleteName}
              </Link>
            ) : (
              w.athleteName
            )}{" "}
            · {prog.done}/{prog.total} sets logged
            {w.sessionRpe != null ? ` · sRPE ${w.sessionRpe} × ${w.durationMinutes} min = ${load} AU` : ""}
          </>
        }
        actions={<StatusBadge status={w.status} />}
      />
      <TrainingNav viewer={viewer} current={isStaff(viewer) ? "review" : viewer.role === "athlete" ? "today" : "overview"} />

      {w.athleteComment ? (
        <Callout tone="info" title="Athlete note" className="mb-4">
          {w.athleteComment}
        </Callout>
      ) : null}
      {w.coachFeedback && !canReview ? (
        <Callout tone="ok" title="Coach feedback" className="mb-4">
          {w.coachFeedback}
        </Callout>
      ) : null}

      {canReview ? (
        <Card className="mb-6">
          <CardHeader title="Coach review" kicker={w.coachReviewedAt ? `Reviewed ${fmt(w.coachReviewedAt)}` : "Not reviewed yet"} />
          <CardBody>
            <ActionForm action={reviewWorkoutAction} className="space-y-3">
              <input type="hidden" name="workoutId" value={w.id} />
              <Field label="Feedback to athlete" htmlFor="feedback" hint="Visible to the athlete and guardians with training access.">
                <Textarea id="feedback" name="feedback" defaultValue={w.coachFeedback ?? ""} maxLength={2000} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton name="reviewed" value="true">
                  {w.coachReviewedAt ? "Save feedback" : "Save & mark reviewed"}
                </SubmitButton>
                {w.coachReviewedAt ? (
                  <SubmitButton variant="ghost" name="reviewed" value="false">
                    Mark not reviewed
                  </SubmitButton>
                ) : null}
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      {canLog ? <SyncBanner className="mb-4" /> : null}
      <WorkoutLogger workout={w} canLog={canLog && w.status !== "skipped"} />

      {canLog ? (
        <section className="mt-6 space-y-3" aria-labelledby="mods-h">
          <h2 id="mods-h" className="font-semibold">
            Substitutions & modifications (this workout only)
          </h2>
          {w.items.map((it) => {
            const options = canReview ? allExercises.filter((e) => e.id !== it.exercise.id) : it.substitutionOptions;
            return (
              <Card key={it.id} id={`mod-${it.id}`}>
                <CardBody className="pt-4">
                  <ActionForm action={substituteAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <input type="hidden" name="workoutId" value={w.id} />
                    <input type="hidden" name="itemId" value={it.id} />
                    <Field label={`${it.blockLabel} ${it.exercise.name}: substitute`} htmlFor={`sub-${it.id}`} hint={options.length ? undefined : "No coach-approved substitutions for this exercise."}>
                      <Select id={`sub-${it.id}`} name="substituteExerciseId" defaultValue={it.substituted ? it.performed.id : ""}>
                        <option value="">No substitution ({it.exercise.name})</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Modification note" htmlFor={`modn-${it.id}`}>
                      <Input id={`modn-${it.id}`} name="modification" defaultValue={it.athleteModification ?? ""} maxLength={300} placeholder="e.g. reduced range, pain-free" />
                    </Field>
                    <SubmitButton variant="secondary" className="min-h-11">
                      Save
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            );
          })}
        </section>
      ) : null}

      {canLog && w.status !== "skipped" ? (
        <div className="mt-6">
          <CompleteWorkoutForm workout={w} />
        </div>
      ) : null}
      {canLog && w.status !== "completed" ? (
        <ActionForm action={workoutStatusAction} className="mt-4">
          <input type="hidden" name="workoutId" value={w.id} />
          <input type="hidden" name="status" value={w.status === "skipped" ? "scheduled" : "skipped"} />
          <SubmitButton variant="ghost" confirm={w.status === "skipped" ? undefined : "Mark this workout as skipped?"}>
            {w.status === "skipped" ? "Reopen workout" : "Mark skipped"}
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}
