import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { writableAthletes } from "@/lib/training/common";
import { programTree } from "@/lib/training/programs";
import { groupsForViewer, listAssignments } from "@/lib/training/assignments";
import { listExercises } from "@/lib/training/exercises";
import { describePrescription, type ResolvedSetGroup } from "@/lib/training/formulas";
import type { SetPrescription } from "@/db/schema";
import { fmtDate, todayLocal } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { TrainingNav } from "../../_components/training-nav";
import { ItemForm } from "../../_components/item-form";
import { ProgramWeekBuilder } from "../../_components/program-builder";
import {
  addDayAction,
  addPhaseAction,
  applyTemplateAction,
  assignProgramAction,
  cancelAssignmentAction,
  copyDayAction,
  copyWeekAction,
  deleteDayAction,
  deleteItemAction,
  deletePhaseAction,
  duplicateProgramAction,
  syncAssignmentAction,
  updatePhaseAction,
  updateProgramMetaAction,
} from "../../actions";
import { guarded, sp } from "../../_lib/helpers";

export const metadata = { title: "Program builder" };

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function templateText(p: SetPrescription) {
  const l = p.load;
  const g: ResolvedSetGroup = {
    sets: p.sets,
    reps: p.reps,
    repsText: p.repsText,
    isWarmup: p.isWarmup,
    durationS: p.durationS,
    distanceM: p.distanceM,
    tempo: p.tempo,
    restS: p.restS,
    loadType: l?.type ?? "none",
    percent: l?.type === "percent_max" ? l.percent : null,
    rpe: l?.type === "rpe" ? l.rpe : null,
    rir: l?.type === "rir" ? l.rir : null,
    targetLoad: l?.type === "absolute" ? l.value : null,
    targetUnit: l?.type === "absolute" ? l.unit : null,
  };
  return describePrescription(g);
}

export default async function ProgramBuilder({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  const viewer = await requireCap("training.manage");
  const tree = await guarded(() => programTree(db, viewer, id));
  const { program, phases, phaseStart, days } = tree;
  const exercises = await listExercises(db, viewer);
  const assignments = await listAssignments(db, viewer, id);
  const groupList = await groupsForViewer(db, viewer);
  const athleteOptions = await writableAthletes(db, viewer);

  const weeks = [...new Set(days.map((d) => d.week))].sort((a, b) => a - b);
  const totalWeeks = Math.max(phases.reduce((s, p) => s + p.weeks, 0), weeks.at(-1) ?? 0);
  const week = Number(sp(q.week)) || weeks[0] || 1;
  const weekDays = days.filter((d) => d.week === week);
  const phaseOf = (pid: string | null) => phases.find((p) => p.id === pid);

  return (
    <div>
      <PageHeader
        kicker="Program builder"
        title={
          <>
            {program.name} <Badge variant="brand">v{program.currentVersion}</Badge>
          </>
        }
        description={program.description ?? undefined}
        actions={<StatusBadge status={program.status} />}
      />
      <TrainingNav viewer={viewer} current="programs" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <ActionForm action={updateProgramMetaAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="programId" value={program.id} />
              <Field label="Name" htmlFor="pm-name" required>
                <Input id="pm-name" name="name" defaultValue={program.name} required />
              </Field>
              <Field label="Status" htmlFor="pm-status">
                <Select id="pm-status" name="status" defaultValue={program.status}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </Select>
              </Field>
              <Field label="Sport" htmlFor="pm-sport">
                <Input id="pm-sport" name="sport" defaultValue={program.sport ?? ""} />
              </Field>
              <Field label="Description" htmlFor="pm-desc" className="sm:col-span-2">
                <Textarea id="pm-desc" name="description" defaultValue={program.description ?? ""} />
              </Field>
              <div>
                <SubmitButton variant="secondary">Save details</SubmitButton>
              </div>
            </ActionForm>
            <ActionForm action={duplicateProgramAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-edge pt-4">
              <input type="hidden" name="programId" value={program.id} />
              <Field label="Duplicate as" htmlFor="dup-name">
                <Input id="dup-name" name="name" placeholder={`${program.name} (copy)`} />
              </Field>
              <SubmitButton variant="outline">Duplicate program</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Phases" kicker={`${totalWeeks} weeks total`} />
          <CardBody className="space-y-3">
            {phases.map((ph) => (
              <div key={ph.id} className="flex flex-wrap items-end gap-2 border-b border-edge pb-3">
                <ActionForm action={updatePhaseAction} className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
                  <input type="hidden" name="programId" value={program.id} />
                  <input type="hidden" name="phaseId" value={ph.id} />
                  <Field label={`Phase (weeks ${phaseStart.get(ph.id)}–${phaseStart.get(ph.id)! + ph.weeks - 1})`} htmlFor={`ph-${ph.id}`}>
                    <Input id={`ph-${ph.id}`} name="name" defaultValue={ph.name} required />
                  </Field>
                  <Field label="Goal" htmlFor={`phg-${ph.id}`}>
                    <Input id={`phg-${ph.id}`} name="goal" defaultValue={ph.goal ?? ""} />
                  </Field>
                  <Field label="Weeks" htmlFor={`phw-${ph.id}`}>
                    <Input id={`phw-${ph.id}`} name="weeks" type="number" min={1} max={52} defaultValue={ph.weeks} />
                  </Field>
                  <SubmitButton size="sm" variant="secondary">
                    Save
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={deletePhaseAction}>
                  <input type="hidden" name="programId" value={program.id} />
                  <input type="hidden" name="phaseId" value={ph.id} />
                  <SubmitButton size="sm" variant="ghost" confirm={`Delete phase "${ph.name}"? Its days are kept without a phase.`}>
                    Delete
                  </SubmitButton>
                </ActionForm>
              </div>
            ))}
            <ActionForm action={addPhaseAction} resetOnSuccess className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
              <input type="hidden" name="programId" value={program.id} />
              <Field label="New phase" htmlFor="np-ph">
                <Input id="np-ph" name="name" placeholder="e.g. Accumulation" required />
              </Field>
              <Field label="Goal" htmlFor="np-goal">
                <Input id="np-goal" name="goal" />
              </Field>
              <Field label="Weeks" htmlFor="np-weeks">
                <Input id="np-weeks" name="weeks" type="number" min={1} max={52} defaultValue={4} />
              </Field>
              <SubmitButton size="sm">Add phase</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Weeks & days" kicker="Template" />
        <CardBody>
          <nav aria-label="Weeks" className="mb-4 flex flex-wrap gap-1">
            {Array.from({ length: Math.max(totalWeeks, 1) }, (_, i) => i + 1).map((w) => (
              <Link
                key={w}
                href={`/training/programs/${program.id}?week=${w}`}
                aria-current={w === week ? "page" : undefined}
                className={`min-h-11 min-w-11 rounded-lg border px-3 py-2.5 text-center text-sm font-medium ${w === week ? "border-brand bg-brand text-brand-ink" : weeks.includes(w) ? "border-edge" : "border-dashed border-edge text-ink-3"}`}
              >
                W{w}
              </Link>
            ))}
          </nav>
          {weekDays.length === 0 ? <p className="mb-4 text-sm text-ink-3">Week {week} has no days yet. Add one below or copy another week into it.</p> : null}
          {weekDays.length ? (
            <ProgramWeekBuilder
              programId={program.id}
              version={program.currentVersion}
              days={weekDays.map((d) => ({
                id: d.id,
                week: d.week,
                dayIndex: d.dayIndex,
                title: d.title,
                phaseName: phaseOf(d.phaseId)?.name ?? null,
                items: d.items.map((it) => ({
                  id: it.id,
                  blockLabel: it.blockLabel,
                  blockType: it.blockType,
                  exerciseName: it.exercise.name,
                  summary:
                    it.prescription.map(templateText).join(" · ") +
                    (it.progression.kind === "linear_load" ? ` · +${it.progression.perWeek}${it.progression.unit === "percent" ? "%" : ` ${it.progression.unit}`}/wk` : ""),
                })),
              }))}
              itemEditors={Object.fromEntries(
                weekDays.flatMap((d) =>
                  d.items.map((it) => [
                    it.id,
                    <details key={it.id} className="mt-1">
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand">Edit</summary>
                      <ItemForm programId={program.id} dayId={d.id} item={it} exercises={exercises} />
                      <ActionForm action={deleteItemAction} className="mt-2">
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="itemId" value={it.id} />
                        <SubmitButton size="sm" variant="danger" confirm="Remove this exercise from the template?">
                          Remove exercise
                        </SubmitButton>
                      </ActionForm>
                    </details>,
                  ]),
                ),
              )}
              dayTools={Object.fromEntries(
                weekDays.map((d) => [
                  d.id,
                  <div key={d.id} className="flex flex-wrap items-start gap-2">
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand">Copy day</summary>
                      <ActionForm action={copyDayAction} className="mt-1 grid grid-cols-2 gap-2 rounded-lg border border-edge p-2 sm:grid-cols-[5rem_5rem_1fr_auto] sm:items-end">
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="dayId" value={d.id} />
                        <Field label="To week" htmlFor={`cd-w-${d.id}`}>
                          <Input id={`cd-w-${d.id}`} name="week" type="number" min={1} max={104} defaultValue={Math.min(d.week + 1, 104)} required />
                        </Field>
                        <Field label="Day #" htmlFor={`cd-d-${d.id}`}>
                          <Input id={`cd-d-${d.id}`} name="dayIndex" type="number" min={1} max={7} defaultValue={d.dayIndex} required />
                        </Field>
                        <Field label="Title (new day)" htmlFor={`cd-t-${d.id}`}>
                          <Input id={`cd-t-${d.id}`} name="title" placeholder={d.title} />
                        </Field>
                        <SubmitButton size="sm" variant="secondary">
                          Copy
                        </SubmitButton>
                        <p className="col-span-full text-xs text-ink-3">An empty slot gets a new day; an existing day gets these exercises appended.</p>
                      </ActionForm>
                    </details>
                    <ActionForm action={deleteDayAction}>
                      <input type="hidden" name="programId" value={program.id} />
                      <input type="hidden" name="dayId" value={d.id} />
                      <SubmitButton size="sm" variant="ghost" confirm={`Delete W${d.week} Day ${d.dayIndex} from the template? Existing workouts are not affected.`}>
                        Delete day
                      </SubmitButton>
                    </ActionForm>
                  </div>,
                ]),
              )}
              dayFooters={Object.fromEntries(
                weekDays.map((d) => [
                  d.id,
                  <details key={d.id} className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand">+ Add exercise</summary>
                    <ItemForm programId={program.id} dayId={d.id} exercises={exercises} />
                  </details>,
                ]),
              )}
            />
          ) : null}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <ActionForm action={addDayAction} resetOnSuccess className="grid grid-cols-2 gap-2 rounded-lg border border-edge p-3 sm:grid-cols-4 sm:items-end">
              <input type="hidden" name="programId" value={program.id} />
              <Field label="Week" htmlFor="ad-w">
                <Input id="ad-w" name="week" type="number" min={1} max={104} defaultValue={week} required />
              </Field>
              <Field label="Day #" htmlFor="ad-d">
                <Input id="ad-d" name="dayIndex" type="number" min={1} max={7} defaultValue={weekDays.length + 1} required />
              </Field>
              <Field label="Title" htmlFor="ad-t" className="col-span-2">
                <Input id="ad-t" name="title" placeholder="e.g. Lower — Power" required />
              </Field>
              <Field label="Phase" htmlFor="ad-p" className="col-span-2">
                <Select id="ad-p" name="phaseId" defaultValue={phases.find((p) => week >= phaseStart.get(p.id)! && week < phaseStart.get(p.id)! + p.weeks)?.id ?? ""}>
                  <option value="">None</option>
                  {phases.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton size="sm">Add day</SubmitButton>
            </ActionForm>
            <ActionForm action={copyWeekAction} className="grid grid-cols-2 gap-2 rounded-lg border border-edge p-3 sm:grid-cols-3 sm:items-end">
              <input type="hidden" name="programId" value={program.id} />
              <Field label="Copy week" htmlFor="cw-f">
                <Input id="cw-f" name="fromWeek" type="number" min={1} defaultValue={week} required />
              </Field>
              <Field label="Into weeks" htmlFor="cw-t" hint="e.g. 2-4 (empty weeks only)">
                <Input id="cw-t" name="toWeeks" placeholder="2-4" required />
              </Field>
              <SubmitButton size="sm" variant="secondary">
                Copy
              </SubmitButton>
            </ActionForm>
          </div>
        </CardBody>
      </Card>

      <Card className="mt-6" id="assign">
        <CardHeader title="Assign" kicker={`Assigns v${program.currentVersion}`} />
        <CardBody>
          {program.status !== "active" ? (
            <Callout tone="warn" className="mb-3">
              This program is {program.status}. Drafts can be assigned for testing; archived programs cannot.
            </Callout>
          ) : null}
          <ActionForm action={assignProgramAction} className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
            <input type="hidden" name="programId" value={program.id} />
            <Field label="Group or athlete" htmlFor="as-t" required>
              <Select id="as-t" name="target" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                <optgroup label="Groups">
                  {groupList.map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Athletes">
                  {athleteOptions.map(([aid, n]) => (
                    <option key={aid} value={`athlete:${aid}`}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </Field>
            <Field label="Start date" htmlFor="as-d" required>
              <Input id="as-d" name="startDate" type="date" defaultValue={todayLocal()} required />
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-ink-2">Training days</legend>
              <div className="flex flex-wrap gap-1">
                {DOW.map((d, i) => (
                  <label key={d} className="flex min-h-11 items-center gap-1 rounded-lg border border-edge px-2 text-sm">
                    <input type="checkbox" name="daysOfWeek" value={i + 1} defaultChecked={[1, 3, 5].includes(i + 1)} className="size-4" />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>
            <SubmitButton>Assign</SubmitButton>
          </ActionForm>

          <h3 className="mt-6 mb-2 text-sm font-semibold">Assignments</h3>
          {assignments.length === 0 ? (
            <p className="text-sm text-ink-3">Not assigned yet.</p>
          ) : (
            <ul className="divide-y divide-edge rounded-lg border border-edge">
              {assignments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium">{a.target}</span> · from {fmtDate(a.startDate)} on {a.daysOfWeek.map((d) => DOW[d - 1]).join("/")} · v{a.programVersion}{" "}
                    <StatusBadge status={a.status} />
                    {a.programVersion < program.currentVersion && a.status === "active" ? (
                      <span className="ml-2 text-xs text-warn">Template is now v{program.currentVersion}; existing workouts unchanged.</span>
                    ) : null}
                  </div>
                  {a.status === "active" ? (
                    <div className="flex flex-wrap gap-1">
                      <ActionForm action={syncAssignmentAction}>
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <SubmitButton size="sm" variant="ghost">
                          Add new members
                        </SubmitButton>
                      </ActionForm>
                      <ActionForm action={applyTemplateAction}>
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <SubmitButton size="sm" variant="outline" confirm={`Rebuild unstarted workouts (today and later) from v${program.currentVersion}? Started, completed and past workouts are kept.`}>
                          Apply to unstarted workouts
                        </SubmitButton>
                      </ActionForm>
                      <ActionForm action={cancelAssignmentAction}>
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <SubmitButton size="sm" variant="ghost" confirm="Cancel this assignment? Unstarted future workouts are removed; history stays.">
                          Cancel
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
