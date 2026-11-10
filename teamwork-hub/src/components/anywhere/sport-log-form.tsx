import { logSportAction } from "@/app/(app)/anywhere/actions";
import { ActionForm, SubmitButton } from "@/components/forms";

/**
 * "How was practice?": minutes (pre-filled from the event when it has a length) and effort 0 to 10.
 * Submits to logSport, which re-checks the viewer's access and writes one load row with source
 * "sport". Radios are real inputs, so it works from the keyboard and without color.
 */
export function SportLogForm({
  athleteId,
  eventId,
  date,
  defaultMinutes,
  defaultRpe,
  idPrefix,
  submitLabel = "Save",
  adHoc,
}: {
  athleteId: string;
  eventId?: string;
  date: string;
  defaultMinutes?: number | null;
  defaultRpe?: number | null;
  idPrefix: string;
  submitLabel?: string;
  /** Without an event: a one-time key and a practice/game choice. */
  adHoc?: { clientKey: string; maxDate: string; minDate: string };
}) {
  return (
    <ActionForm action={logSportAction} resetOnSuccess={!!adHoc} className="space-y-3">
      <input type="hidden" name="athleteId" value={athleteId} />
      {eventId ? <input type="hidden" name="eventId" value={eventId} /> : null}
      {adHoc ? (
        <>
          <input type="hidden" name="clientKey" value={adHoc.clientKey} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${idPrefix}-kind`} className="block text-sm font-medium text-ink-2">
                What was it?
              </label>
              <select id={`${idPrefix}-kind`} name="kind" defaultValue="practice" className="mt-1 h-12 w-full rounded-md border border-edge bg-surface px-3 text-base text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand">
                <option value="practice">Practice</option>
                <option value="game">Game</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-date`} className="block text-sm font-medium text-ink-2">
                Day
              </label>
              <input id={`${idPrefix}-date`} type="date" name="occurrenceDate" defaultValue={date} min={adHoc.minDate} max={adHoc.maxDate} required className="mt-1 h-12 w-full rounded-md border border-edge bg-surface px-3 text-base text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand" />
            </div>
          </div>
        </>
      ) : (
        <input type="hidden" name="occurrenceDate" value={date} />
      )}
      <fieldset>
        <legend className="text-sm font-medium text-ink-2">How hard did it feel? (0 is rest, 10 is all out)</legend>
        <div className="mt-1.5 grid grid-cols-6 gap-1.5 sm:grid-cols-11">
          {Array.from({ length: 11 }, (_, n) => (
            <label
              key={n}
              className="flex min-h-12 cursor-pointer items-center justify-center rounded-md border border-edge bg-surface text-base font-bold tabular text-ink hover:bg-surface-2 has-checked:border-brand has-checked:bg-brand has-checked:text-brand-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-brand"
            >
              <input type="radio" name="rpe" value={n} defaultChecked={defaultRpe === n} required className="sr-only" />
              {n}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${idPrefix}-min`} className="block text-sm font-medium text-ink-2">
            Minutes
          </label>
          <input
            id={`${idPrefix}-min`}
            name="durationMinutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            required
            defaultValue={defaultMinutes ?? undefined}
            className="mt-1 h-12 w-28 rounded-md border border-edge bg-surface px-3 text-base text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand"
          />
        </div>
        <SubmitButton size="lg" className="min-w-28 flex-1 sm:flex-none">
          {submitLabel}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
