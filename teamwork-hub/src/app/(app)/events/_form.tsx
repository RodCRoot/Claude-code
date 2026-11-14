import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { events } from "@/db/schema";
import { EVENT_KINDS } from "@/lib/events/events";
import { DEFAULT_HOLD_HOURS } from "@/lib/events/pricing";
import { createEventAction, updateEventAction } from "../_events/actions";
import { SessionRows } from "./_session-rows";

type Opt = { id: string; name: string };
const dollars = (minor: number | null | undefined) => (minor == null ? "" : (minor / 100).toFixed(2));
const grid = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

/** Create (with sessions) or edit (details only; sessions are managed below the form). */
export function EventForm({ event, forms, coaches, resources }: { event?: typeof events.$inferSelect; forms: Opt[]; coaches?: Opt[]; resources?: Opt[] }) {
  const e = event;
  return (
    <ActionForm action={e ? updateEventAction : createEventAction} className="space-y-5">
      {e ? <input type="hidden" name="eventId" value={e.id} /> : null}
      <div className={grid}>
        <Field label="Name" htmlFor="ev-name" required className="sm:col-span-2">
          <Input id="ev-name" name="name" required maxLength={120} defaultValue={e?.name} className="h-11" />
        </Field>
        <Field label="Kind" htmlFor="ev-kind" required>
          <Select id="ev-kind" name="kind" defaultValue={e?.kind ?? "camp"} className="h-11">
            {EVENT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor="ev-desc" hint="Shown to families. What to bring, who it is for, what they will work on." className="sm:col-span-2 lg:col-span-3">
          <Textarea id="ev-desc" name="description" rows={3} maxLength={2000} defaultValue={e?.description ?? ""} />
        </Field>
      </div>

      {!e ? (
        <>
          <SessionRows />
          <div className={grid}>
            <Field label="Coach" htmlFor="ev-coach" hint="Optional. Can be changed per session on the calendar.">
              <Select id="ev-coach" name="coachUserId" defaultValue="" className="h-11">
                <option value="">Not assigned yet</option>
                {(coaches ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Room or area" htmlFor="ev-res" hint="Optional.">
              <Select id="ev-res" name="resourceId" defaultValue="" className="h-11">
                <option value="">Not assigned yet</option>
                {(resources ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </>
      ) : null}

      <div className={grid}>
        <Field label="Capacity" htmlFor="ev-cap" required hint="Total spots for the whole event.">
          <Input id="ev-cap" name="capacity" type="number" inputMode="numeric" min={1} max={1000} required defaultValue={e?.capacity} className="h-11" />
        </Field>
        <Field label="Price per athlete ($)" htmlFor="ev-price" required hint="Enter 0 for a free event.">
          <Input id="ev-price" name="price" inputMode="decimal" required defaultValue={dollars(e?.priceMinor)} placeholder="0.00" className="h-11" />
        </Field>
        <Field label="Unpaid hold (hours)" htmlFor="ev-hold" hint={`How long an unpaid registration keeps its spot. Default ${DEFAULT_HOLD_HOURS}.`}>
          <Input id="ev-hold" name="holdHours" type="number" inputMode="numeric" min={1} max={720} defaultValue={e?.holdHours ?? DEFAULT_HOLD_HOURS} className="h-11" />
        </Field>
        <Field label="Early bird price ($)" htmlFor="ev-eb" hint="Optional. Must be lower than the price.">
          <Input id="ev-eb" name="earlyBirdPrice" inputMode="decimal" defaultValue={dollars(e?.earlyBirdPriceMinor)} className="h-11" />
        </Field>
        <Field label="Early bird last day" htmlFor="ev-ebu" hint="The early bird price applies through the end of this day.">
          <Input id="ev-ebu" name="earlyBirdUntil" type="date" defaultValue={e?.earlyBirdUntil ?? ""} className="h-11" />
        </Field>
        <Field label="Sibling discount (%)" htmlFor="ev-sib" hint="Optional. Off each additional athlete on the same billing account.">
          <Input id="ev-sib" name="siblingDiscountPercent" type="number" inputMode="numeric" min={1} max={100} defaultValue={e?.siblingDiscountPercent ?? ""} className="h-11" />
        </Field>
        <Field label="Registration opens" htmlFor="ev-open" hint="Optional. Empty means as soon as it is published.">
          <Input id="ev-open" name="registrationOpensOn" type="date" defaultValue={e?.registrationOpensOn ?? ""} className="h-11" />
        </Field>
        <Field label="Registration closes" htmlFor="ev-close" hint="Optional. It always closes when the first session starts.">
          <Input id="ev-close" name="registrationClosesOn" type="date" defaultValue={e?.registrationClosesOn ?? ""} className="h-11" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum age" htmlFor="ev-min">
            <Input id="ev-min" name="minAge" type="number" inputMode="numeric" min={0} max={120} defaultValue={e?.minAge ?? ""} className="h-11" />
          </Field>
          <Field label="Maximum age" htmlFor="ev-max">
            <Input id="ev-max" name="maxAge" type="number" inputMode="numeric" min={0} max={120} defaultValue={e?.maxAge ?? ""} className="h-11" />
          </Field>
        </div>
      </div>

      {forms.length ? (
        <fieldset>
          <legend className="text-sm font-medium text-ink-2">Required forms</legend>
          <p className="text-xs text-ink-3">An athlete can register only when each ticked form is completed and not expired.</p>
          <div className="mt-1 grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
            {forms.map((f) => (
              <label key={f.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="requiredFormTemplateIds" value={f.id} defaultChecked={e?.requiredFormTemplateIds.includes(f.id)} className="size-5 shrink-0" />
                <span className="font-medium text-ink-2">{f.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <SubmitButton>{e ? "Save changes" : "Create draft"}</SubmitButton>
    </ActionForm>
  );
}
