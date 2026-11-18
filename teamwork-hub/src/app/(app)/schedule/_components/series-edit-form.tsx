"use client";

import { startTransition, useActionState, useState } from "react";
import { FormMessage, type ActionState } from "@/components/forms";
import { buttonClass, Field, Input, Select } from "@/components/ui";
import { seriesEditAction } from "../actions";

type Option = { id: string; name: string };
type Conflict = { id: string; when: string; title: string; occupying: number; waitlisted: number; newCapacity: number; newWaitlistCapacity: number };

/**
 * Edit time / coach / room / capacity for this session, this and following, or the whole series.
 * Blank fields are left as they are. When a smaller capacity would not fit existing bookings the
 * server changes nothing and returns the conflicting sessions; staff then pick how to resolve them.
 */
export function SeriesEditForm({
  sessionId,
  version,
  inSeries,
  defaults,
  coaches,
  rooms,
}: {
  sessionId: string;
  version: number;
  inSeries: boolean;
  defaults: { time: string; duration: number; capacity: number; waitlistCapacity: number; coachUserId: string | null; resourceId: string | null };
  coaches: Option[];
  rooms: Option[];
}) {
  const [state, action, pending] = useActionState(seriesEditAction, {} as ActionState);
  const [mode, setMode] = useState("refuse");
  const conflicts = (state.data?.conflicts as Conflict[] | undefined) ?? [];
  return (
    <form
      className="space-y-3"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium text-ink-2">Apply to</legend>
        {(
          [
            ["this", "This session only"],
            ...(inSeries
              ? [
                  ["following", "This and all following sessions"],
                  ["all", "Entire series (all upcoming sessions)"],
                ]
              : []),
          ] as [string, string][]
        ).map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="scope" value={value} defaultChecked={value === "this"} className="size-5" /> {label}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-ink-3">Leave a field blank to keep it. Bookings always stay; families are notified when the time, coach or room changes.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start time" htmlFor="se-time" hint={`Now ${defaults.time}`}>
          <Input id="se-time" name="startTimeLocal" type="time" className="h-11" />
        </Field>
        <Field label="Duration (min)" htmlFor="se-dur" hint={`Now ${defaults.duration}`}>
          <Input id="se-dur" name="durationMinutes" type="number" min={5} max={1440} inputMode="numeric" className="h-11" />
        </Field>
        <Field label="Capacity" htmlFor="se-cap" hint={`Now ${defaults.capacity}`}>
          <Input id="se-cap" name="capacity" type="number" min={0} max={500} inputMode="numeric" className="h-11" />
        </Field>
        <Field label="Waitlist size" htmlFor="se-wl" hint={`Now ${defaults.waitlistCapacity}`}>
          <Input id="se-wl" name="waitlistCapacity" type="number" min={0} max={200} inputMode="numeric" className="h-11" />
        </Field>
      </div>
      <Field label="Coach" htmlFor="se-coach">
        <Select id="se-coach" name="coachUserId" defaultValue="keep" className="h-11">
          <option value="keep">Keep current coach</option>
          <option value="none">No coach</option>
          {coaches.map((c) => (
            <option key={c.id} value={c.id} disabled={c.id === defaults.coachUserId}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Room / area" htmlFor="se-room">
        <Select id="se-room" name="resourceId" defaultValue="keep" className="h-11">
          <option value="keep">Keep current room</option>
          <option value="none">No room</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id} disabled={r.id === defaults.resourceId}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>

      {conflicts.length ? (
        <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3" role="group" aria-labelledby="se-conflicts">
          <p id="se-conflicts" className="text-sm font-semibold">
            Sessions with more athletes than the new size
          </p>
          <ul className="space-y-1 text-sm">
            {conflicts.map((c) => (
              <li key={c.id}>
                <a href={`/schedule/sessions/${c.id}`} className="font-medium underline">
                  {c.when}
                </a>{" "}
                — {c.occupying} booked (new capacity {c.newCapacity}){c.waitlisted ? `, ${c.waitlisted} waitlisted (new waitlist ${c.newWaitlistCapacity})` : ""}
              </li>
            ))}
          </ul>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium text-ink-2">How should these be handled?</legend>
            {(
              [
                ["refuse", "Don't change anything"],
                ["skip_conflicting", "Apply the change, but keep the current size on these sessions"],
                ["keep_bookings_over_capacity", "Apply the new size everywhere and keep everyone booked (these stay over capacity)"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-start gap-2 text-sm">
                <input type="radio" name="onCapacityConflict" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-0.5 size-5 shrink-0" />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-ink-3">No athlete is ever removed automatically. To reduce a roster, cancel individual bookings first.</p>
        </div>
      ) : (
        <input type="hidden" name="onCapacityConflict" value="refuse" />
      )}

      <button type="submit" disabled={pending} className={buttonClass("primary", "md", "min-h-11")}>
        {pending ? "Saving…" : "Save changes"}
      </button>
      <FormMessage state={state} />
    </form>
  );
}
