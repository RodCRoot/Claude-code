"use client";

import { startTransition, useActionState } from "react";
import { FormMessage, type ActionState } from "@/components/forms";
import { Badge, buttonClass } from "@/components/ui";
import { batchBookAction } from "../actions";

type Member = { id: string; name: string };
type Result = { athlete: string; outcome: "booked" | "waitlisted" | "failed" | "rolled_back"; waitlistPosition: number | null; error: string | null };

const OUTCOME: Record<Result["outcome"], { label: string; variant: "green" | "yellow" | "red" | "neutral" }> = {
  booked: { label: "Reserved", variant: "green" },
  waitlisted: { label: "Waitlist", variant: "yellow" },
  failed: { label: "Not reserved", variant: "red" },
  rolled_back: { label: "Not reserved", variant: "neutral" },
};

/**
 * Family-member checklist shown at the moment of reserving (several children on one login).
 * Each person is checked on their own; the ones that can be reserved are, the rest say why.
 */
export function ReservePicker({ sessionId, members, waitlist, idem, classLabel }: { sessionId: string; members: Member[]; waitlist: boolean; idem: string; classLabel: string }) {
  const [state, action, pending] = useActionState(batchBookAction, {} as ActionState);
  const results = (state.data?.results as Result[] | undefined) ?? [];
  return (
    <form
      className="space-y-2 text-left"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="idem" value={idem} />
      <input type="hidden" name="weeks" value="1" />
      <input type="hidden" name="mode" value="partial" />
      {waitlist ? <input type="hidden" name="waitlist" value="on" /> : null}
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-2">
          Who is this for?<span className="sr-only"> {classLabel}</span>
        </legend>
        {members.map((m) => (
          <label key={m.id} className="flex min-h-11 items-center gap-3 rounded-md border border-edge bg-surface px-3 text-sm font-medium">
            <input type="checkbox" name="athleteId" value={m.id} className="size-5" />
            {m.name}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={pending} className={buttonClass(waitlist ? "secondary" : "primary", "md", "min-h-11 w-full")}>
        {pending ? (waitlist ? "Joining…" : "Reserving…") : waitlist ? "Join waitlist" : "Reserve"}
      </button>
      <FormMessage state={state} />
      {results.length ? (
        <ul className="divide-y divide-edge rounded-md border border-edge" aria-label="Reservation results">
          {results.map((r, i) => (
            <li key={i} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{r.athlete}</div>
                {r.error ? <div className="mt-0.5 text-xs text-bad">{r.error}</div> : null}
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
