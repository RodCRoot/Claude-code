"use client";

import { startTransition, useActionState } from "react";
import { FormMessage, type ActionState } from "@/components/forms";
import { Badge, buttonClass, Field, Select } from "@/components/ui";
import { batchBookAction } from "../actions";

type Athlete = { id: string; name: string; credits: number };
type Result = { athlete: string; session: string; when: string; outcome: "booked" | "waitlisted" | "failed" | "rolled_back"; waitlistPosition: number | null; error: string | null };

const OUTCOME: Record<Result["outcome"], { label: string; variant: "green" | "yellow" | "red" | "neutral" }> = {
  booked: { label: "Booked", variant: "green" },
  waitlisted: { label: "Waitlist", variant: "yellow" },
  failed: { label: "Not booked", variant: "red" },
  rolled_back: { label: "Not booked (all-or-nothing)", variant: "neutral" },
};

/** Book several children into one session, and/or the next N weeks of a series, in one action. */
export function BatchBookForm({
  sessionId,
  athletes,
  preselected,
  inSeries,
  maxWeeks,
  idem,
}: {
  sessionId: string;
  athletes: Athlete[];
  preselected: string | null;
  inSeries: boolean;
  maxWeeks: number;
  idem: string;
}) {
  const [state, action, pending] = useActionState(batchBookAction, {} as ActionState);
  const results = (state.data?.results as Result[] | undefined) ?? [];
  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      {/* One key per page load: a double tap or a retry returns the same bookings instead of new ones. */}
      <input type="hidden" name="idem" value={idem} />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium text-ink-2">Who is coming?</legend>
        {athletes.map((a) => (
          <label key={a.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-edge px-3 text-sm">
            <input type="checkbox" name="athleteId" value={a.id} defaultChecked={a.id === preselected || athletes.length === 1} className="size-5" />
            <span className="font-medium">{a.name}</span>
            <span className="ml-auto text-xs text-ink-3">
              {a.credits} credit{a.credits === 1 ? "" : "s"}
            </span>
          </label>
        ))}
      </fieldset>
      {inSeries ? (
        <Field label="How many weeks?" htmlFor="bb-weeks" hint="Books this session and the same class on the following weeks.">
          <Select id="bb-weeks" name="weeks" defaultValue="1" className="h-11">
            {Array.from({ length: maxWeeks }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "Just this session" : `The next ${n} weeks`}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <input type="hidden" name="weeks" value="1" />
      )}
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium text-ink-2">If some can&apos;t be booked</legend>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="radio" name="mode" value="all_or_nothing" defaultChecked className="mt-0.5 size-5 shrink-0" />
          Book nothing (all or nothing)
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="radio" name="mode" value="partial" className="mt-0.5 size-5 shrink-0" />
          Book the ones that can be booked
        </label>
      </fieldset>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="waitlist" className="size-5" /> Join the waitlist when a session is full
      </label>
      <button type="submit" disabled={pending} className={buttonClass("primary", "lg", "min-h-12 w-full sm:w-auto")}>
        {pending ? "Booking…" : "Book"}
      </button>
      <FormMessage state={state} />
      {results.length ? (
        <ul className="divide-y divide-edge rounded-lg border border-edge" aria-label="Booking results">
          {results.map((r, i) => (
            <li key={i} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{r.athlete}</div>
                <div className="text-xs text-ink-3">
                  {r.session} · {r.when}
                </div>
                {r.error ? <div className="mt-1 text-xs text-bad">{r.error}</div> : null}
              </div>
              <Badge variant={OUTCOME[r.outcome].variant}>
                {OUTCOME[r.outcome].label}
                {r.outcome === "waitlisted" && r.waitlistPosition ? ` #${r.waitlistPosition}` : ""}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
