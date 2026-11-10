import { createGoalAction, goalStatusAction } from "@/app/(app)/goals/actions";
import { ProgressBar } from "@/app/(app)/training/_components/tb";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import type { GoalOptions, GoalView } from "@/lib/engagement/goals";
import { fmt, fmtDate } from "@/lib/time";

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

function dueText(g: GoalView): string | null {
  if (!g.targetDate) return null;
  if (g.daysLeft === null) return `Target date ${fmtDate(g.targetDate)}`;
  if (g.daysLeft < 0) return `Target date was ${fmtDate(g.targetDate)}. Keep going, or set a new date.`;
  if (g.daysLeft === 0) return "Target date is today";
  return `By ${fmtDate(g.targetDate)} (${g.daysLeft} day${g.daysLeft === 1 ? "" : "s"} left)`;
}

/** The measured line, always as text (the bar is decorative). */
function progressText(g: GoalView): string | null {
  if (!g.link || !g.progress) return null;
  const { current, baseline, pct } = g.progress;
  const unit = g.link.targetUnit;
  if (current === null) return `No result recorded yet. Target ${num(g.link.targetValue)} ${unit}.`;
  const base = `Now ${num(current)} ${unit}, target ${num(g.link.targetValue)} ${unit}`;
  if (pct === null) return `${base}.`;
  return `${base}. ${pct}% of the way${baseline !== null ? ` from ${num(baseline)} ${unit}` : ""}.`;
}

export function GoalRow({ g, canWrite, compact = false }: { g: GoalView; canWrite: boolean; compact?: boolean }) {
  const text = progressText(g);
  const due = dueText(g);
  const done = g.status === "achieved";
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">
            {done ? (
              <span className="mr-1.5 inline-flex size-5 items-center justify-center rounded-full bg-ok/15 align-[-3px] text-xs font-extrabold text-ok" aria-hidden>
                ✓
              </span>
            ) : null}
            {g.title}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            {g.link ? `${g.link.label} · target ${num(g.link.targetValue)} ${g.link.targetUnit}` : "Checked off by hand"}
            {done && g.achievedAt ? ` · reached ${fmt(g.achievedAt, "MMM d, yyyy")}` : ""}
            {g.status === "archived" ? " · archived" : ""}
          </p>
        </div>
        {g.link && g.progress && g.progress.pct !== null && !done ? <span className="text-lg leading-none font-extrabold tabular text-ink">{g.progress.pct}%</span> : null}
      </div>
      {g.link && g.progress && !done ? <ProgressBar done={g.progress.pct ?? 0} total={100} size="md" className="mt-2" /> : null}
      {text && !done ? <p className="mt-1.5 text-xs text-ink-2">{text}</p> : null}
      {due && !done ? <p className="mt-0.5 text-xs text-ink-3">{due}</p> : null}
      {g.progress?.note && !done && !compact ? <p className="mt-0.5 text-xs text-ink-3">{g.progress.note}</p> : null}
      {canWrite && !compact && g.status !== "achieved" ? (
        <ActionForm action={goalStatusAction} className="mt-2">
          <input type="hidden" name="goalId" value={g.id} />
          <div className="flex flex-wrap gap-2">
            {g.status === "active" && !g.link ? (
              <SubmitButton name="do" value="achieve" size="sm" pendingText="Saving…">
                Mark done<span className="sr-only">: {g.title}</span>
              </SubmitButton>
            ) : null}
            {g.status === "active" ? (
              <SubmitButton name="do" value="archive" size="sm" variant="secondary" pendingText="Saving…">
                Archive<span className="sr-only">: {g.title}</span>
              </SubmitButton>
            ) : (
              <SubmitButton name="do" value="reopen" size="sm" variant="secondary" pendingText="Saving…">
                Reopen<span className="sr-only">: {g.title}</span>
              </SubmitButton>
            )}
          </div>
        </ActionForm>
      ) : null}
    </li>
  );
}

export function GoalList({ goals, canWrite, compact, empty }: { goals: GoalView[]; canWrite: boolean; compact?: boolean; empty: string }) {
  if (!goals.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-edge">
      {goals.map((g) => (
        <GoalRow key={g.id} g={g} canWrite={canWrite} compact={compact} />
      ))}
    </ul>
  );
}

/** New-goal form. Works without client script beyond the shared ActionForm; the server validates everything. */
export function GoalForm({ athleteId, options, idPrefix = "goal" }: { athleteId: string; options: GoalOptions; idPrefix?: string }) {
  const id = (s: string) => `${idPrefix}-${s}`;
  const canLink = options.metrics.length + options.exercises.length > 0;
  return (
    <ActionForm action={createGoalAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="athleteId" value={athleteId} />
      <Field label="Goal" htmlFor={id("title")} required className="sm:col-span-2" hint="Short and specific, like “Make varsity” or “Squat 225”.">
        <Input id={id("title")} name="title" required maxLength={120} />
      </Field>
      {canLink ? (
        <>
          <Field label="Track it with" htmlFor={id("link")} className="sm:col-span-2" hint="Linked goals fill in from new results and check themselves off.">
            <Select id={id("link")} name="link" defaultValue="">
              <option value="">Nothing, I will check it off myself</option>
              {options.metrics.length ? (
                <optgroup label="Test results">
                  {options.metrics.map((m) => (
                    <option key={m.id} value={`metric:${m.id}`}>
                      {m.name} ({m.unit})
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {options.exercises.length ? (
                <optgroup label="Lift maxes">
                  {options.exercises.map((e) => (
                    <option key={e.id} value={`exercise:${e.id}`}>
                      {e.name} max ({e.unit})
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </Field>
          <Field label="Target number" htmlFor={id("target")} hint="Only for linked goals.">
            <Input id={id("target")} name="targetValue" inputMode="decimal" />
          </Field>
          <Field label="Unit (optional)" htmlFor={id("unit")} hint="Leave blank to use the unit shown above.">
            <Input id={id("unit")} name="targetUnit" maxLength={20} />
          </Field>
          <Field label="The number should" htmlFor={id("direction")}>
            <Select id={id("direction")} name="direction" defaultValue="">
              <option value="">Follow the usual direction</option>
              <option value="increase">Go up</option>
              <option value="decrease">Go down</option>
            </Select>
          </Field>
        </>
      ) : (
        <input type="hidden" name="link" value="" />
      )}
      <Field label="Target date (optional)" htmlFor={id("date")}>
        <Input id={id("date")} name="targetDate" type="date" />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton>Add goal</SubmitButton>
      </div>
    </ActionForm>
  );
}
