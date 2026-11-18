import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import type { ProgramItem } from "@/lib/training/programs";
import type { SetPrescription } from "@/db/schema";
import { addItemAction, updateItemAction } from "../actions";
import { SET_GROUP_ROWS } from "../_lib/forms";

function loadValue(p?: SetPrescription) {
  const l = p?.load;
  if (!l) return "";
  if (l.type === "absolute") return String(l.value);
  if (l.type === "percent_max") return String(l.percent);
  if (l.type === "rpe") return String(l.rpe);
  if (l.type === "rir") return String(l.rir);
  return "";
}

/** Template item editor: exercise, block label (A1/A2 superset, C1–C3 circuit), up to 4 set groups, progression. */
export function ItemForm({ programId, dayId, item, exercises }: { programId: string; dayId: string; item?: ProgramItem; exercises: { id: string; name: string }[] }) {
  const p = item ? `it-${item.id.slice(0, 8)}` : `new-${dayId.slice(0, 8)}`;
  const prog = item?.progression;
  return (
    <ActionForm action={item ? updateItemAction : addItemAction} resetOnSuccess={!item} className="@container space-y-3">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="dayId" value={dayId} />
      {item ? <input type="hidden" name="itemId" value={item.id} /> : null}
      <div className="grid gap-3 @xl:grid-cols-[2fr_1fr_1fr]">
        <Field label="Exercise" htmlFor={`${p}-ex`} required>
          <Select id={`${p}-ex`} name="exerciseId" defaultValue={item?.exerciseId} required>
            {exercises.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Block label" htmlFor={`${p}-bl`} hint="A, A1/A2 superset, C1–C3 circuit" required>
          <Input id={`${p}-bl`} name="blockLabel" defaultValue={item?.blockLabel ?? "A"} required pattern="[A-Za-z][0-9]{0,2}" maxLength={3} />
        </Field>
        <Field label="Block type" htmlFor={`${p}-bt`}>
          <Select id={`${p}-bt`} name="blockType" defaultValue={item?.blockType ?? "straight"}>
            <option value="straight">Straight sets</option>
            <option value="superset">Superset</option>
            <option value="circuit">Circuit</option>
          </Select>
        </Field>
      </div>
      <fieldset className="rounded-lg border border-edge p-2">
        <legend className="px-1 text-sm font-medium text-ink-2">Set groups (leave “Sets” blank to skip a row)</legend>
        <div className="space-y-2">
          {Array.from({ length: SET_GROUP_ROWS }, (_, i) => {
            const g = item?.prescription[i];
            const r = `${p}-g${i}`;
            return (
              <div key={i} className="grid grid-cols-2 gap-2 border-b border-edge/60 pb-2 last:border-0 @xl:grid-cols-6 @4xl:grid-cols-12">
                <Field label="Sets" htmlFor={`${r}-sets`}>
                  <Input id={`${r}-sets`} name={`g${i}_sets`} type="number" min={1} max={20} defaultValue={g?.sets ?? (i === 0 && !item ? 3 : "")} />
                </Field>
                <Field label="Reps" htmlFor={`${r}-reps`}>
                  <Input id={`${r}-reps`} name={`g${i}_reps`} type="number" min={1} max={200} defaultValue={g?.reps ?? (i === 0 && !item ? 5 : "")} />
                </Field>
                <Field label="Rep text" htmlFor={`${r}-rt`}>
                  <Input id={`${r}-rt`} name={`g${i}_repsText`} maxLength={40} placeholder="e.g. 8 each" defaultValue={g?.repsText ?? ""} />
                </Field>
                <Field label="Load type" htmlFor={`${r}-lt`}>
                  <Select id={`${r}-lt`} name={`g${i}_loadType`} defaultValue={g?.load?.type ?? "none"}>
                    <option value="none">None</option>
                    <option value="percent_max">% of max</option>
                    <option value="absolute">Absolute</option>
                    <option value="rpe">RPE</option>
                    <option value="rir">RIR</option>
                    <option value="bodyweight">Bodyweight</option>
                  </Select>
                </Field>
                <Field label="Load value" htmlFor={`${r}-lv`}>
                  <Input id={`${r}-lv`} name={`g${i}_loadValue`} type="number" step="0.5" min={0} defaultValue={loadValue(g)} />
                </Field>
                <Field label="Abs. unit" htmlFor={`${r}-lu`}>
                  <Select id={`${r}-lu`} name={`g${i}_loadUnit`} defaultValue={g?.load?.type === "absolute" ? g.load.unit : "lb"}>
                    <option value="lb">lb</option>
                    <option value="kg">kg</option>
                  </Select>
                </Field>
                <Field label="Time (s)" htmlFor={`${r}-d`}>
                  <Input id={`${r}-d`} name={`g${i}_durationS`} type="number" step="0.1" min={0} defaultValue={g?.durationS ?? ""} />
                </Field>
                <Field label="Dist. (m)" htmlFor={`${r}-dm`}>
                  <Input id={`${r}-dm`} name={`g${i}_distanceM`} type="number" step="0.1" min={0} defaultValue={g?.distanceM ?? ""} />
                </Field>
                <Field label="Tempo" htmlFor={`${r}-t`}>
                  <Input id={`${r}-t`} name={`g${i}_tempo`} maxLength={20} placeholder="30X1" defaultValue={g?.tempo ?? ""} />
                </Field>
                <Field label="Rest (s)" htmlFor={`${r}-r`}>
                  <Input id={`${r}-r`} name={`g${i}_restS`} type="number" min={0} max={3600} defaultValue={g?.restS ?? ""} />
                </Field>
                <label className="col-span-2 flex min-h-11 items-end gap-2 pb-2 text-sm @xl:col-span-2">
                  <input type="checkbox" name={`g${i}_warmup`} defaultChecked={!!g?.isWarmup} className="size-5" /> Warm-up
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>
      <div className="grid gap-3 @xl:grid-cols-[1fr_1fr_1fr_2fr]">
        <Field label="Progression" htmlFor={`${p}-pk`} hint="Applied per week within the phase at assignment">
          <Select id={`${p}-pk`} name="progKind" defaultValue={prog?.kind ?? "none"}>
            <option value="none">None</option>
            <option value="linear_load">Linear load per week</option>
          </Select>
        </Field>
        <Field label="Per week" htmlFor={`${p}-pw`}>
          <Input id={`${p}-pw`} name="progPerWeek" type="number" step="0.5" defaultValue={prog?.kind === "linear_load" ? prog.perWeek : ""} />
        </Field>
        <Field label="Unit" htmlFor={`${p}-pu`}>
          <Select id={`${p}-pu`} name="progUnit" defaultValue={prog?.kind === "linear_load" ? prog.unit : "lb"}>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
            <option value="percent">% points</option>
          </Select>
        </Field>
        <Field label="Notes" htmlFor={`${p}-n`}>
          <Input id={`${p}-n`} name="notes" maxLength={1000} defaultValue={item?.notes ?? ""} />
        </Field>
      </div>
      <SubmitButton size="sm">{item ? "Save item" : "Add to day"}</SubmitButton>
    </ActionForm>
  );
}
