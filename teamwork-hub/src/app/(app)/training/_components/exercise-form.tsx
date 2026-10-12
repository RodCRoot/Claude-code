import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { EXERCISE_CATEGORIES, MOVEMENT_PATTERNS, TRACKING_TYPES, UNITS, type Exercise } from "@/lib/training/exercises";
import { createExerciseAction, updateExerciseAction } from "../actions";

const TRACK_LABEL: Record<string, string> = {
  weight_reps: "Weight × reps",
  reps: "Reps only",
  bodyweight_reps: "Bodyweight reps",
  time: "Time",
  distance: "Distance",
  time_distance: "Time + distance",
};

export function ExerciseForm({ exercise, all }: { exercise?: Exercise; all: Pick<Exercise, "id" | "name">[] }) {
  const p = exercise ? `ex-${exercise.id.slice(0, 8)}` : "ex-new";
  const others = all.filter((e) => e.id !== exercise?.id);
  return (
    <ActionForm action={exercise ? updateExerciseAction : createExerciseAction} resetOnSuccess={!exercise} className="grid gap-3 sm:grid-cols-2">
      {exercise ? <input type="hidden" name="id" value={exercise.id} /> : null}
      <Field label="Name" htmlFor={`${p}-name`} required>
        <Input id={`${p}-name`} name="name" required minLength={2} maxLength={120} defaultValue={exercise?.name} />
      </Field>
      <Field label="Category" htmlFor={`${p}-cat`} required>
        <Select id={`${p}-cat`} name="category" defaultValue={exercise?.category ?? "Lower body"}>
          {[...new Set([...EXERCISE_CATEGORIES, ...(exercise ? [exercise.category] : [])])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label="Movement pattern" htmlFor={`${p}-pat`}>
        <Select id={`${p}-pat`} name="movementPattern" defaultValue={exercise?.movementPattern ?? ""}>
          <option value="">—</option>
          {MOVEMENT_PATTERNS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
      </Field>
      <Field label="Equipment" htmlFor={`${p}-eq`} hint="Comma separated, e.g. barbell, rack">
        <Input id={`${p}-eq`} name="equipment" defaultValue={exercise?.equipment.join(", ")} />
      </Field>
      <Field label="Tracking type" htmlFor={`${p}-tt`}>
        <Select id={`${p}-tt`} name="trackingType" defaultValue={exercise?.trackingType ?? "weight_reps"}>
          {TRACKING_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRACK_LABEL[t]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Default unit" htmlFor={`${p}-unit`}>
        <Select id={`${p}-unit`} name="defaultUnit" defaultValue={exercise?.defaultUnit ?? "lb"}>
          {UNITS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </Select>
      </Field>
      <Field label="Bodyweight factor" htmlFor={`${p}-bw`} hint="Fraction of body mass counted as load (e.g. 0.64 push-up). Blank = not counted.">
        <Input id={`${p}-bw`} name="bodyweightFactor" type="number" step="0.01" min={0} max={1.5} defaultValue={exercise?.bodyweightFactor ?? ""} />
      </Field>
      <Field label="% loads use max of" htmlFor={`${p}-max`} hint="e.g. Front Squat → Back Squat. Blank = this exercise's own max.">
        <Select id={`${p}-max`} name="maxSourceExerciseId" defaultValue={exercise?.maxSourceExerciseId ?? ""}>
          <option value="">This exercise</option>
          {others.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Video link (authorized/owned only)" htmlFor={`${p}-vid`} hint="https:// link to a video you own or are licensed to share. Linked, never copied.">
        <Input id={`${p}-vid`} name="videoUrl" type="url" placeholder="https://" defaultValue={exercise?.videoUrl ?? ""} />
      </Field>
      <Field label="Approved substitutions" htmlFor={`${p}-subs`} hint="Athletes can swap to these on their own. Ctrl/Cmd-click to pick several.">
        <Select id={`${p}-subs`} name="substitutionIds" multiple defaultValue={exercise?.substitutionIds ?? []} className="h-32">
          {others.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Coaching notes" htmlFor={`${p}-notes`} className="sm:col-span-2">
        <Textarea id={`${p}-notes`} name="coachingNotes" maxLength={2000} defaultValue={exercise?.coachingNotes ?? ""} />
      </Field>
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="isUnilateral" defaultChecked={exercise?.isUnilateral} className="size-5" /> Unilateral (log left/right)
        </label>
        {exercise ? (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="hidden" name="active" value="off" />
            <input type="checkbox" name="active" value="on" defaultChecked={exercise.active} className="size-5" /> Active
          </label>
        ) : null}
        <SubmitButton>{exercise ? "Save exercise" : "Add exercise"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
