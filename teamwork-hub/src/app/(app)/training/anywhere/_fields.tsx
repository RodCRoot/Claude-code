import { Field, Input, Select, Textarea } from "@/components/ui";
import { ANYWHERE_CATEGORIES, ANYWHERE_EQUIPMENT } from "@/db/schema";
import { CATEGORY_LABEL, EQUIPMENT_LABEL } from "@/lib/anywhere/common";
import type { AnywhereSession } from "@/lib/anywhere/sessions";

/** Session details, shared by "new" and the builder. Plain form controls: fully keyboard operable. */
export function SessionFields({ s }: { s?: AnywhereSession }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor="os-title" required className="sm:col-span-2">
        <Input id="os-title" name="title" defaultValue={s?.title} maxLength={80} required />
      </Field>
      <Field label="What it is for" htmlFor="os-desc" hint="One or two plain sentences the athlete reads before starting." className="sm:col-span-2">
        <Textarea id="os-desc" name="description" defaultValue={s?.description ?? ""} maxLength={400} />
      </Field>
      <Field label="Type" htmlFor="os-cat" required>
        <Select id="os-cat" name="category" defaultValue={s?.category ?? "mobility"}>
          {ANYWHERE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Minutes" htmlFor="os-min" required hint="Keep it short: most are 10 to 20.">
        <Input id="os-min" name="durationMinutes" type="number" min={1} max={120} defaultValue={s?.durationMinutes ?? 10} required />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-ink-2">Equipment needed</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {ANYWHERE_EQUIPMENT.filter((e) => e !== "none").map((e) => (
            <label key={e} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="equipment" value={e} defaultChecked={s?.equipment.includes(e)} /> {EQUIPMENT_LABEL[e]}
            </label>
          ))}
        </div>
        <p className="text-xs text-ink-3">Leave all unticked for no equipment.</p>
      </fieldset>
      <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="suitableUnder13" defaultChecked={s?.suitableUnder13 ?? false} className="mt-1" />
        <span>
          Suitable for athletes under 13
          <span className="block text-xs text-ink-3">Athletes under 13, and athletes with no birthday on file, only ever see sessions with this ticked.</span>
        </span>
      </label>
    </div>
  );
}
