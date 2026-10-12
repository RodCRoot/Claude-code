import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { cancellationPolicies, classSeries, resources, serviceTypes } from "@/db/schema";
import { addAvailabilityAction, addTimeOffAction, createSessionAction, savePolicyAction, saveResourceAction, saveSeriesAction, saveServiceTypeAction } from "../actions";

type Opt = { id: string; name: string };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const KINDS = [
  ["class", "Class (group)"],
  ["private", "Private session"],
  ["semi_private", "Semi-private"],
  ["assessment", "Assessment"],
  ["camp", "Camp"],
  ["event", "Event"],
] as const;
const PENALTIES = [
  ["none", "No penalty (credit returned)"],
  ["forfeit_credit", "Credit is used"],
  ["fee", "Charge a fee (recorded for billing)"],
] as const;

function Check({ name, label, defaultChecked, hint, value }: { name: string; label: string; defaultChecked?: boolean; hint?: string; value?: string }) {
  return (
    <label className="flex min-h-11 items-start gap-2 py-1 text-sm">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="mt-0.5 size-5 shrink-0" />
      <span>
        <span className="font-medium text-ink-2">{label}</span>
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
    </label>
  );
}

const grid = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

export function ResourceForm({ r }: { r?: typeof resources.$inferSelect }) {
  const k = r?.id ?? "new";
  return (
    <ActionForm action={saveResourceAction} className="space-y-3" resetOnSuccess={!r}>
      {r ? <input type="hidden" name="id" value={r.id} /> : null}
      <div className={grid}>
        <Field label="Name" htmlFor={`rn-${k}`} required>
          <Input id={`rn-${k}`} name="name" defaultValue={r?.name} required className="h-11" />
        </Field>
        <Field label="Kind" htmlFor={`rk-${k}`}>
          <Select id={`rk-${k}`} name="kind" defaultValue={r?.kind ?? "area"} className="h-11">
            <option value="area">Area</option>
            <option value="room">Room</option>
            <option value="equipment">Equipment</option>
          </Select>
        </Field>
        <Field label="Capacity (optional)" htmlFor={`rc-${k}`}>
          <Input id={`rc-${k}`} name="capacity" type="number" min={0} defaultValue={r?.capacity ?? ""} className="h-11" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-6">
        <Check name="exclusive" label="Exclusive (can't be double-booked)" defaultChecked={r?.exclusive} />
        <Check name="active" label="Active" defaultChecked={r?.active ?? true} />
      </div>
      <SubmitButton className="min-h-11">{r ? "Save resource" : "Add resource"}</SubmitButton>
    </ActionForm>
  );
}

export function PolicyForm({ p }: { p?: typeof cancellationPolicies.$inferSelect }) {
  const k = p?.id ?? "new";
  return (
    <ActionForm action={savePolicyAction} className="space-y-3" resetOnSuccess={!p}>
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <div className={grid}>
        <Field label="Name" htmlFor={`pn-${k}`} required>
          <Input id={`pn-${k}`} name="name" defaultValue={p?.name} required className="h-11" />
        </Field>
        <Field label="Late-cancel window (hours before start)" htmlFor={`pw-${k}`} required>
          <Input id={`pw-${k}`} name="lateCancelWindowHours" type="number" min={0} step="0.25" defaultValue={p ? p.lateCancelWindowMinutes / 60 : ""} required className="h-11" />
        </Field>
        <Field label="Fee amount (USD, for “fee” penalties)" htmlFor={`pf-${k}`}>
          <Input id={`pf-${k}`} name="feeDollars" type="number" min={0} step="0.01" defaultValue={p && p.feeMinor ? (p.feeMinor / 100).toFixed(2) : ""} className="h-11" />
        </Field>
        <Field label="Late cancellation" htmlFor={`pl-${k}`}>
          <Select id={`pl-${k}`} name="lateCancelPenalty" defaultValue={p?.lateCancelPenalty ?? "none"} className="h-11">
            {PENALTIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="No-show" htmlFor={`pns-${k}`}>
          <Select id={`pns-${k}`} name="noShowPenalty" defaultValue={p?.noShowPenalty ?? "none"} className="h-11">
            {PENALTIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Description shown to staff" htmlFor={`pd-${k}`}>
        <Textarea id={`pd-${k}`} name="description" defaultValue={p?.description ?? ""} />
      </Field>
      <SubmitButton className="min-h-11">{p ? "Save policy" : "Add policy"}</SubmitButton>
    </ActionForm>
  );
}

export function ServiceTypeForm({ st, policies, forms }: { st?: typeof serviceTypes.$inferSelect; policies: Opt[]; forms: Opt[] }) {
  const k = st?.id ?? "new";
  const el = st?.eligibility ?? {};
  return (
    <ActionForm action={saveServiceTypeAction} className="space-y-3" resetOnSuccess={!st}>
      {st ? <input type="hidden" name="id" value={st.id} /> : null}
      <div className={grid}>
        <Field label="Name" htmlFor={`sn-${k}`} required>
          <Input id={`sn-${k}`} name="name" defaultValue={st?.name} required className="h-11" />
        </Field>
        <Field label="Kind" htmlFor={`sk-${k}`}>
          <Select id={`sk-${k}`} name="kind" defaultValue={st?.kind ?? "class"} className="h-11">
            {KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Color" htmlFor={`scol-${k}`}>
          <Input id={`scol-${k}`} name="color" type="color" defaultValue={st?.color ?? "#2563eb"} className="h-11 p-1" />
        </Field>
        <Field label="Duration (minutes)" htmlFor={`sd-${k}`}>
          <Input id={`sd-${k}`} name="defaultDurationMinutes" type="number" min={5} defaultValue={st?.defaultDurationMinutes ?? 60} className="h-11" />
        </Field>
        <Field label="Capacity" htmlFor={`sc-${k}`}>
          <Input id={`sc-${k}`} name="defaultCapacity" type="number" min={1} defaultValue={st?.defaultCapacity ?? 12} className="h-11" />
        </Field>
        <Field label="Credits per booking" htmlFor={`scr-${k}`} hint="0 = free">
          <Input id={`scr-${k}`} name="creditCost" type="number" min={0} defaultValue={st?.creditCost ?? 1} className="h-11" />
        </Field>
        <Field label="Buffer before (min)" htmlFor={`sbb-${k}`}>
          <Input id={`sbb-${k}`} name="bufferBeforeMinutes" type="number" min={0} defaultValue={st?.bufferBeforeMinutes ?? 0} className="h-11" />
        </Field>
        <Field label="Buffer after (min)" htmlFor={`sba-${k}`}>
          <Input id={`sba-${k}`} name="bufferAfterMinutes" type="number" min={0} defaultValue={st?.bufferAfterMinutes ?? 0} className="h-11" />
        </Field>
        <Field label="Cancellation policy" htmlFor={`sp-${k}`}>
          <Select id={`sp-${k}`} name="cancellationPolicyId" defaultValue={st?.cancellationPolicyId ?? ""} className="h-11">
            <option value="">None (always return credit)</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Minimum age (optional)" htmlFor={`smin-${k}`}>
          <Input id={`smin-${k}`} name="minAge" type="number" min={0} defaultValue={el.minAge ?? ""} className="h-11" />
        </Field>
        <Field label="Maximum age (optional)" htmlFor={`smax-${k}`}>
          <Input id={`smax-${k}`} name="maxAge" type="number" min={0} defaultValue={el.maxAge ?? ""} className="h-11" />
        </Field>
      </div>
      <Field label="Description" htmlFor={`sdesc-${k}`}>
        <Textarea id={`sdesc-${k}`} name="description" defaultValue={st?.description ?? ""} />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium text-ink-2">Required forms before booking</legend>
        {forms.length ? (
          <div className="flex flex-wrap gap-x-6">
            {forms.map((f) => (
              <Check key={f.id} name="requiredFormTemplateIds" value={f.id} label={f.name} defaultChecked={el.requiredFormTemplateIds?.includes(f.id)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-3">No form templates exist yet (Documents module).</p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-x-6">
        <Check name="requiresEntitlement" label="Requires membership or credits" defaultChecked={el.requiresEntitlement !== false} />
        <Check name="publicBookable" label="Families can self-book (private/assessment)" defaultChecked={st?.publicBookable} />
        <Check name="exclusiveCoach" label="Coach is exclusively booked" hint="Private/assessment: no overlapping sessions for the coach" defaultChecked={st?.exclusiveCoach} />
        <Check name="active" label="Active" defaultChecked={st?.active ?? true} />
      </div>
      <SubmitButton className="min-h-11">{st ? "Save service" : "Add service"}</SubmitButton>
    </ActionForm>
  );
}

export function SeriesForm({ s, services, coaches, rooms, today }: { s?: typeof classSeries.$inferSelect; services: Opt[]; coaches: Opt[]; rooms: Opt[]; today: string }) {
  const k = s?.id ?? "new";
  return (
    <ActionForm action={saveSeriesAction} className="space-y-3" resetOnSuccess={!s}>
      {s ? <input type="hidden" name="id" value={s.id} /> : null}
      <div className={grid}>
        <Field label="Title" htmlFor={`tt-${k}`} required>
          <Input id={`tt-${k}`} name="title" defaultValue={s?.title} required className="h-11" />
        </Field>
        <Field label="Service" htmlFor={`ts-${k}`} required>
          <Select id={`ts-${k}`} name="serviceTypeId" defaultValue={s?.serviceTypeId ?? ""} required className="h-11">
            <option value="" disabled>
              Choose…
            </option>
            {services.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start time (facility local)" htmlFor={`tst-${k}`} required>
          <Input id={`tst-${k}`} name="startTimeLocal" type="time" defaultValue={s?.startTimeLocal.slice(0, 5) ?? "06:00"} required className="h-11" />
        </Field>
        <Field label="Duration (minutes)" htmlFor={`td-${k}`}>
          <Input id={`td-${k}`} name="durationMinutes" type="number" min={5} defaultValue={s?.durationMinutes ?? 60} className="h-11" />
        </Field>
        <Field label="Coach" htmlFor={`tc-${k}`}>
          <Select id={`tc-${k}`} name="coachUserId" defaultValue={s?.coachUserId ?? ""} className="h-11">
            <option value="">No coach</option>
            {coaches.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Room / area" htmlFor={`tr-${k}`}>
          <Select id={`tr-${k}`} name="resourceId" defaultValue={s?.resourceId ?? ""} className="h-11">
            <option value="">None</option>
            {rooms.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Capacity" htmlFor={`tcap-${k}`}>
          <Input id={`tcap-${k}`} name="capacity" type="number" min={1} defaultValue={s?.capacity ?? 12} className="h-11" />
        </Field>
        <Field label="Waitlist size" htmlFor={`twl-${k}`}>
          <Input id={`twl-${k}`} name="waitlistCapacity" type="number" min={0} defaultValue={s?.waitlistCapacity ?? 5} className="h-11" />
        </Field>
        <Field label="Starts on" htmlFor={`tso-${k}`} required>
          <Input id={`tso-${k}`} name="startsOn" type="date" defaultValue={s?.startsOn ?? today} required className="h-11" />
        </Field>
        <Field label="Ends on (optional)" htmlFor={`teo-${k}`}>
          <Input id={`teo-${k}`} name="endsOn" type="date" defaultValue={s?.endsOn ?? ""} className="h-11" />
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-ink-2">Weekdays</legend>
        <div className="flex flex-wrap gap-x-4">
          {WEEKDAYS.map((w, i) => (
            <label key={w} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="weekdays" value={i + 1} defaultChecked={s?.weekdays.includes(i + 1)} className="size-5" /> {w}
            </label>
          ))}
        </div>
      </fieldset>
      <Check name="active" label="Active" defaultChecked={s?.active ?? true} />
      <SubmitButton className="min-h-11">{s ? "Save series" : "Add series"}</SubmitButton>
      {s ? <p className="text-xs text-ink-3">Edits apply to sessions generated from now on; existing sessions keep their bookings and times.</p> : null}
    </ActionForm>
  );
}

export function AvailabilityForm({ coaches, fixedCoachId }: { coaches: Opt[]; fixedCoachId?: string }) {
  return (
    <ActionForm action={addAvailabilityAction} className="space-y-3">
      <div className={grid}>
        {fixedCoachId ? (
          <input type="hidden" name="coachUserId" value={fixedCoachId} />
        ) : (
          <Field label="Coach" htmlFor="av-coach" required>
            <Select id="av-coach" name="coachUserId" defaultValue="" required className="h-11">
              <option value="" disabled>
                Choose…
              </option>
              {coaches.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Weekday" htmlFor="av-wd">
          <Select id="av-wd" name="weekday" defaultValue="1" className="h-11">
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i + 1}>
                {w}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" htmlFor="av-start" required>
          <Input id="av-start" name="startLocal" type="time" defaultValue="09:00" required className="h-11" />
        </Field>
        <Field label="Until" htmlFor="av-end" required>
          <Input id="av-end" name="endLocal" type="time" defaultValue="12:00" required className="h-11" />
        </Field>
        <Field label="Effective from (optional)" htmlFor="av-ef">
          <Input id="av-ef" name="effectiveFrom" type="date" className="h-11" />
        </Field>
        <Field label="Effective until (optional)" htmlFor="av-et">
          <Input id="av-et" name="effectiveTo" type="date" className="h-11" />
        </Field>
      </div>
      <SubmitButton className="min-h-11">Add availability</SubmitButton>
    </ActionForm>
  );
}

export function TimeOffForm({ coaches, fixedCoachId, today }: { coaches: Opt[]; fixedCoachId?: string; today: string }) {
  return (
    <ActionForm action={addTimeOffAction} className="space-y-3" resetOnSuccess>
      <div className={grid}>
        {fixedCoachId ? (
          <input type="hidden" name="coachUserId" value={fixedCoachId} />
        ) : (
          <Field label="Coach" htmlFor="to-coach" required>
            <Select id="to-coach" name="coachUserId" defaultValue="" required className="h-11">
              <option value="" disabled>
                Choose…
              </option>
              {coaches.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Start date" htmlFor="to-sd" required>
          <Input id="to-sd" name="startDate" type="date" defaultValue={today} required className="h-11" />
        </Field>
        <Field label="Start time" htmlFor="to-st" required>
          <Input id="to-st" name="startTime" type="time" defaultValue="00:00" required className="h-11" />
        </Field>
        <Field label="End date" htmlFor="to-ed" required>
          <Input id="to-ed" name="endDate" type="date" defaultValue={today} required className="h-11" />
        </Field>
        <Field label="End time" htmlFor="to-et" required>
          <Input id="to-et" name="endTime" type="time" defaultValue="23:59" required className="h-11" />
        </Field>
        <Field label="Reason (optional)" htmlFor="to-r">
          <Input id="to-r" name="reason" className="h-11" />
        </Field>
      </div>
      <SubmitButton className="min-h-11">Add time off</SubmitButton>
    </ActionForm>
  );
}

export function OneOffSessionForm({ services, coaches, rooms, today }: { services: Opt[]; coaches: Opt[]; rooms: Opt[]; today: string }) {
  return (
    <ActionForm action={createSessionAction} className="space-y-3">
      <div className={grid}>
        <Field label="Service" htmlFor="os-st" required>
          <Select id="os-st" name="serviceTypeId" defaultValue="" required className="h-11">
            <option value="" disabled>
              Choose…
            </option>
            {services.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title (optional)" htmlFor="os-title" hint="Defaults to the service name">
          <Input id="os-title" name="title" className="h-11" />
        </Field>
        <Field label="Date" htmlFor="os-date" required>
          <Input id="os-date" name="date" type="date" defaultValue={today} required className="h-11" />
        </Field>
        <Field label="Start time" htmlFor="os-time" required>
          <Input id="os-time" name="time" type="time" defaultValue="16:00" required className="h-11" />
        </Field>
        <Field label="Duration (minutes)" htmlFor="os-dur">
          <Input id="os-dur" name="durationMinutes" type="number" min={5} defaultValue={60} className="h-11" />
        </Field>
        <Field label="Coach" htmlFor="os-coach">
          <Select id="os-coach" name="coachUserId" defaultValue="" className="h-11">
            <option value="">No coach</option>
            {coaches.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Room / area" htmlFor="os-room">
          <Select id="os-room" name="resourceId" defaultValue="" className="h-11">
            <option value="">None</option>
            {rooms.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Capacity" htmlFor="os-cap">
          <Input id="os-cap" name="capacity" type="number" min={0} defaultValue={10} className="h-11" />
        </Field>
        <Field label="Waitlist size" htmlFor="os-wl">
          <Input id="os-wl" name="waitlistCapacity" type="number" min={0} defaultValue={0} className="h-11" />
        </Field>
        <Field label="Who can book online" htmlFor="os-vis">
          <Select id="os-vis" name="visibility" defaultValue="members" className="h-11">
            <option value="members">Members (families & athletes)</option>
            <option value="public">Public</option>
            <option value="private">Private (staff books)</option>
          </Select>
        </Field>
      </div>
      <SubmitButton className="min-h-11">Create session</SubmitButton>
    </ActionForm>
  );
}
