"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatMoney, percentOf } from "@/lib/money";
import { registerForEventAction } from "../../../_events/actions";

type Props = {
  eventId: string;
  formKey: string;
  athletes: { athleteId: string; name: string }[];
  priceMinor: number;
  currency: string;
  siblingDiscountPercent: number | null;
  /** Athletes from this family who already hold a spot (the sibling discount counts them). */
  alreadyRegistered: number;
  spotsLeft: number;
  online: boolean;
};

/** Choose athletes, see the total, register. The server re-prices and re-checks everything. */
export function RegisterForm({ eventId, formKey, athletes, priceMinor, currency, siblingDiscountPercent, alreadyRegistered, spotsLeft, online }: Props) {
  const [picked, setPicked] = useState<string[]>(athletes.length === 1 ? [athletes[0].athleteId] : []);
  const priceFor = (index: number) => (siblingDiscountPercent && alreadyRegistered + index >= 1 ? priceMinor - Math.min(priceMinor, percentOf(priceMinor, siblingDiscountPercent)) : priceMinor);
  const total = picked.reduce((sum, _id, i) => sum + priceFor(i), 0);
  const tooMany = picked.length > spotsLeft;
  return (
    <ActionForm action={registerForEventAction} className="space-y-3">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="key" value={formKey} />
      <fieldset>
        <legend className="text-sm font-semibold text-ink">Who is coming?</legend>
        <ul className="mt-2 space-y-2">
          {athletes.map((a) => {
            const on = picked.includes(a.athleteId);
            const idx = picked.indexOf(a.athleteId);
            return (
              <li key={a.athleteId}>
                <label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 ${on ? "border-brand bg-brand/5" : "border-edge bg-surface"}`}>
                  <input
                    type="checkbox"
                    name="athleteIds"
                    value={a.athleteId}
                    checked={on}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.athleteId] : p.filter((x) => x !== a.athleteId)))}
                    className="size-5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 font-medium">{a.name}</span>
                  {on ? <span className="shrink-0 text-sm font-semibold tabular">{priceFor(idx) === 0 ? "Free" : formatMoney(priceFor(idx), currency)}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="flex items-baseline justify-between border-t border-edge pt-3" aria-live="polite">
        <span className="text-sm font-semibold text-ink-2">Total{picked.length > 1 ? ` for ${picked.length} athletes` : ""}</span>
        <span className="text-xl font-bold tabular" data-testid="event-total">
          {picked.length === 0 ? formatMoney(0, currency) : total === 0 ? "Free" : formatMoney(total, currency)}
        </span>
      </div>
      {tooMany ? (
        <p role="alert" className="text-sm font-medium text-bad">
          Only {spotsLeft} {spotsLeft === 1 ? "spot is" : "spots are"} left.
        </p>
      ) : null}
      <SubmitButton className="h-12 w-full text-base" pendingText="Holding your spot…">
        {total === 0 && picked.length ? "Register" : online ? "Register and continue to payment" : "Register and hold my spot"}
      </SubmitButton>
    </ActionForm>
  );
}
