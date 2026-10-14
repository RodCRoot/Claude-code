import { ActionForm, SubmitButton } from "@/components/forms";
import { Input, Textarea } from "@/components/ui";
import type { QuestionDef } from "@/db/schema";
import { habitCheckinAction, submitCheckinAction } from "../actions";

/** Mobile-first single-screen check-in. Scale items are large radio "pills" (≥44px targets). */
export function CheckinForm({
  athleteId,
  questionnaireId,
  questions,
  existing,
  forDate,
  showDate,
}: {
  athleteId: string;
  questionnaireId: string;
  questions: QuestionDef[];
  existing?: Record<string, unknown> | null;
  forDate: string;
  showDate?: boolean;
}) {
  return (
    <ActionForm action={submitCheckinAction} className="space-y-5">
      <input type="hidden" name="athleteId" value={athleteId} />
      <input type="hidden" name="questionnaireId" value={questionnaireId} />
      {showDate ? (
        <div>
          <label htmlFor="ci-date" className="block text-sm font-medium text-ink-2">
            Date (staff back-entry, up to 7 days)
          </label>
          <Input id="ci-date" type="date" name="forDate" defaultValue={forDate} className="max-w-48" />
        </div>
      ) : (
        <input type="hidden" name="forDate" value={forDate} />
      )}
      {questions.map((q) => {
        const prev = existing?.[q.key];
        const id = `q-${q.key}`;
        const req = q.required ? <span className="text-bad" aria-hidden> *</span> : <span className="text-xs font-normal text-ink-3"> (optional)</span>;
        if (q.kind === "scale") {
          const opts: number[] = [];
          for (let n = q.min ?? 1; n <= (q.max ?? 5); n++) opts.push(n);
          const anchors = q.anchors ?? {};
          return (
            <fieldset key={q.key}>
              <legend className="text-sm font-semibold">
                {q.label}
                {req}
              </legend>
              <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${opts.length > 6 ? Math.ceil(opts.length / 2) : opts.length}, minmax(0, 1fr))` }}>
                {opts.map((n) => (
                  <label key={n} className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-edge text-base font-semibold tabular has-[:checked]:border-brand has-[:checked]:bg-brand has-[:checked]:text-brand-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand">
                    <input type="radio" name={`q_${q.key}`} value={n} defaultChecked={prev === n} required={q.required} className="sr-only" aria-label={`${n}${anchors[String(n)] ? ` — ${anchors[String(n)]}` : ""}`} />
                    {n}
                  </label>
                ))}
              </div>
              {Object.keys(anchors).length ? (
                <div className="mt-1 flex justify-between text-xs text-ink-3">
                  <span>{anchors[String(q.min)] ?? ""}</span>
                  <span>{anchors[String(q.max)] ?? ""}</span>
                </div>
              ) : null}
            </fieldset>
          );
        }
        if (q.kind === "boolean") {
          return (
            <fieldset key={q.key}>
              <legend className="text-sm font-semibold">
                {q.label}
                {req}
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  ["yes", "Yes"],
                  ["no", "No"],
                ].map(([v, l]) => (
                  <label key={v} className="flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-edge font-semibold has-[:checked]:border-brand has-[:checked]:bg-brand has-[:checked]:text-brand-ink">
                    <input type="radio" name={`q_${q.key}`} value={v} required={q.required} defaultChecked={prev === (v === "yes")} className="sr-only" />
                    {l}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }
        if (q.kind === "number") {
          return (
            <div key={q.key}>
              <label htmlFor={id} className="block text-sm font-semibold">
                {q.label}
                {q.unit ? <span className="font-normal text-ink-3"> ({q.unit})</span> : null}
                {req}
              </label>
              <Input id={id} name={`q_${q.key}`} type="number" inputMode="decimal" step="any" min={0} defaultValue={typeof prev === "number" ? prev : ""} required={q.required} className="mt-1 h-12 max-w-40 text-lg" />
            </div>
          );
        }
        return (
          <div key={q.key}>
            <label htmlFor={id} className="block text-sm font-semibold">
              {q.label}
              {req}
            </label>
            <Textarea id={id} name={`q_${q.key}`} defaultValue={typeof prev === "string" ? prev : ""} required={q.required} maxLength={500} className="mt-1" />
          </div>
        );
      })}
      <SubmitButton size="lg" className="w-full">
        {existing ? "Update check-in" : "Submit check-in"}
      </SubmitButton>
    </ActionForm>
  );
}

/** One habit: done / partial / missed buttons + optional value. */
export function HabitCheckinForm({ habitId, athleteId, forDate, unit, current }: { habitId: string; athleteId: string; forDate: string; unit: string | null; current: string | null }) {
  return (
    <ActionForm action={habitCheckinAction} className="space-y-2">
      <input type="hidden" name="habitId" value={habitId} />
      <input type="hidden" name="athleteId" value={athleteId} />
      <input type="hidden" name="forDate" value={forDate} />
      {unit ? (
        <div className="flex items-center gap-2">
          <label htmlFor={`hv-${habitId}`} className="text-xs text-ink-3">
            Value ({unit})
          </label>
          <Input id={`hv-${habitId}`} name="value" type="number" step="any" min={0} className="h-9 w-24" />
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        {(["done", "partial", "missed"] as const).map((st) => (
          <SubmitButton key={st} name="status" value={st} variant={current === st ? "primary" : "outline"} size="lg" pendingText="…">
            {st === "done" ? "Done" : st === "partial" ? "Partial" : "Missed"}
          </SubmitButton>
        ))}
      </div>
    </ActionForm>
  );
}
