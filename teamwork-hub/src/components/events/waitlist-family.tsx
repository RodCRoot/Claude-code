"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { acceptWaitlistOfferAction, joinWaitlistAction, leaveWaitlistAction } from "@/app/(app)/_events/actions";

/** Choose athletes and join the line. The server re-checks permission and eligibility. */
export function JoinWaitlistForm({ eventId, athletes, offerLabel }: { eventId: string; athletes: { athleteId: string; name: string }[]; offerLabel: string }) {
  const [picked, setPicked] = useState<string[]>(athletes.length === 1 ? [athletes[0].athleteId] : []);
  return (
    <ActionForm action={joinWaitlistAction} className="space-y-3">
      <input type="hidden" name="eventId" value={eventId} />
      <fieldset>
        <legend className="text-sm font-semibold text-ink">Who should we add to the waitlist?</legend>
        <ul className="mt-2 space-y-2">
          {athletes.map((a) => {
            const on = picked.includes(a.athleteId);
            return (
              <li key={a.athleteId}>
                <label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 ${on ? "border-brand bg-brand/5" : "border-edge bg-surface"}`}>
                  <input type="checkbox" name="athleteIds" value={a.athleteId} checked={on} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.athleteId] : p.filter((x) => x !== a.athleteId)))} className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1 font-medium">{a.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className="text-xs text-ink-3">
        Joining is free and nothing is charged. If a spot opens, it is offered to the first athlete in line and shown here for {offerLabel}. You then choose whether to take it. We do not send a message about it yet, so please check back.
      </p>
      <SubmitButton className="h-12 w-full text-base" pendingText="Adding to the waitlist…">
        Join the waitlist
      </SubmitButton>
    </ActionForm>
  );
}

export function AcceptOfferForm({ entryId, formKey, first, online }: { entryId: string; formKey: string; first: string; online: boolean }) {
  return (
    <ActionForm action={acceptWaitlistOfferAction}>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="key" value={formKey} />
      <SubmitButton pendingText="Holding the spot…">{online ? `Take the spot for ${first} and continue to payment` : `Take the spot for ${first}`}</SubmitButton>
    </ActionForm>
  );
}

export function LeaveWaitlistForm({ entryId, label, confirm }: { entryId: string; label: string; confirm: string }) {
  return (
    <ActionForm action={leaveWaitlistAction}>
      <input type="hidden" name="entryId" value={entryId} />
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" confirm={confirm}>
        {label}
      </SubmitButton>
    </ActionForm>
  );
}
