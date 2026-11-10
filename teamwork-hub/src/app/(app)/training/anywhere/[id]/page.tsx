import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, StatusBadge } from "@/components/ui";
import { SAFETY_COPY } from "@/lib/anywhere/common";
import { sessionForStaff } from "@/lib/anywhere/sessions";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listExercises } from "@/lib/training/exercises";
import { TrainingNav } from "../../_components/training-nav";
import { guarded } from "../../_lib/helpers";
import { addStepAction, stepAction, updateSessionAction } from "../actions";
import { SessionFields } from "../_fields";

export const metadata = { title: "On Your Own session" };

export default async function AnywhereBuilder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireStaff();
  const s = await guarded(() => sessionForStaff(db, viewer, id));
  const canEdit = can(viewer, "training.manage");
  const exercises = canEdit ? await listExercises(db, viewer) : [];
  const byCategory = new Map<string, typeof exercises>();
  for (const e of exercises) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);

  return (
    <div>
      <PageHeader
        kicker="On Your Own · session builder"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.title} <StatusBadge status={s.status} /> {s.isSample ? <Badge variant="yellow">Sample</Badge> : null}
          </span>
        }
        description={s.isSample ? "This is a sample to get you started. Change anything, or archive it." : undefined}
        actions={<ButtonLink href="/training/anywhere" variant="secondary">Back to the library</ButtonLink>}
      />
      <TrainingNav viewer={viewer} current="anywhere" />
      <Callout tone="warn" className="mb-5">
        Athletes see this line on every session: <strong>{SAFETY_COPY}</strong>
      </Callout>
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card>
            <CardHeader title="Steps" kicker={`${s.steps.length} step${s.steps.length === 1 ? "" : "s"} · built from your exercise library`} />
            <CardBody>
              {s.steps.length === 0 ? (
                <p className="text-sm text-ink-3">No steps yet. Add the first one below.</p>
              ) : (
                <ol className="divide-y divide-edge">
                  {s.steps.map((st, i) => (
                    <li key={st.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="font-semibold leading-snug">
                          <span className="text-ink-3 tabular">{i + 1}.</span> {st.exercise.name}
                        </p>
                        <p className="text-sm font-semibold text-brand">{st.prescription}</p>
                        {st.cue ? <p className="text-sm text-ink-2">{st.cue}</p> : null}
                        {st.exercise.coachingNotes ? <p className="text-xs text-ink-3">From the library: {st.exercise.coachingNotes}</p> : null}
                        {st.exercise.videoUrl ? <p className="text-xs text-ink-3">Demo video linked in the library.</p> : null}
                      </div>
                      {canEdit ? (
                        <ActionForm action={stepAction}>
                          <input type="hidden" name="stepId" value={st.id} />
                          <div className="flex gap-1">
                            {i > 0 ? (
                              <SubmitButton name="do" value="up" variant="secondary" size="sm" className="h-10!" pendingText="...">
                                Up<span className="sr-only">: move step {i + 1}, {st.exercise.name}</span>
                              </SubmitButton>
                            ) : null}
                            {i < s.steps.length - 1 ? (
                              <SubmitButton name="do" value="down" variant="secondary" size="sm" className="h-10!" pendingText="...">
                                Down<span className="sr-only">: move step {i + 1}, {st.exercise.name}</span>
                              </SubmitButton>
                            ) : null}
                            <SubmitButton name="do" value="remove" variant="ghost" size="sm" className="h-10!" pendingText="...">
                              Remove<span className="sr-only"> step {i + 1}, {st.exercise.name}</span>
                            </SubmitButton>
                          </div>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
          {canEdit ? (
            <Card>
              <CardHeader title="Add a step" kicker="Exercises, cues and demo links come from the exercise library" />
              <CardBody>
                <ActionForm action={addStepAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <Field label="Exercise" htmlFor="st-ex" required>
                    <Select id="st-ex" name="exerciseId" required defaultValue="">
                      <option value="" disabled>
                        Choose an exercise
                      </option>
                      {[...byCategory.entries()].map(([cat, list]) => (
                        <optgroup key={cat} label={cat}>
                          {list.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                              {e.equipment.length ? ` (${e.equipment.join(", ")})` : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  <Field label="What to do" htmlFor="st-rx" required hint="For example: 2 x 30 seconds each side">
                    <Input id="st-rx" name="prescription" maxLength={120} required />
                  </Field>
                  <Field label="Extra cue for this session (optional)" htmlFor="st-cue" className="sm:col-span-2">
                    <Input id="st-cue" name="cue" maxLength={240} />
                  </Field>
                  <div className="sm:col-span-2">
                    <SubmitButton>Add step</SubmitButton>
                  </div>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
        </div>
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Session details" />
            <CardBody>
              {canEdit ? (
                <ActionForm action={updateSessionAction} className="space-y-4">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <SessionFields s={s} />
                  <Field label="Status" htmlFor="os-status" hint="Only published sessions show in the athlete library.">
                    <Select id="os-status" name="status" defaultValue={s.status}>
                      <option value="draft">Draft</option>
                      <option value="published">Published</option>
                      <option value="archived">Archived</option>
                    </Select>
                  </Field>
                  <SubmitButton>Save</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-ink-3">Coaches, admins and owners can edit sessions.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
