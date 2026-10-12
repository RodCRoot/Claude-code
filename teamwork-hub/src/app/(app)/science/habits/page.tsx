import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { can, canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { FORMULAS } from "@/lib/science/formulas";
import { habitSummaries, listHabits, type HabitSummary } from "@/lib/science/habits";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { assignHabitAction, createHabitAction } from "../actions";
import { HabitCheckinForm } from "../_components/checkin-form";
import { AthletePicker, FormulaTag, fmtN, pickAthlete, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Habits" };

export default async function HabitsPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "training.read");
  const athlete = pickAthlete(athletes, sp1(p.athlete));
  const days = Number(sp1(p.days)) === 7 ? 7 : Number(sp1(p.days)) === 56 ? 56 : 28;
  const from = addDaysYmd(today, -(days - 1));
  const summaries = athlete ? await habitSummaries(db, v, athlete.id, from, today) : [];
  const canLog = athlete ? await canOnAthlete(db, v, athlete.id, "training.log") : false;
  const manage = can(v, "science.manage");
  const all = manage ? await listHabits(db, v) : [];
  const gs = manage ? await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name)) : [];

  return (
    <>
      <PageHeader kicker="Sports science" title="Habit tracker" description={`Adherence ${FORMULAS.habit_adherence_v1.definition}`} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <AthletePicker athletes={athletes} current={athlete?.id ?? null} extra={{ days: String(days) }} />
        <form method="get" className="flex items-end gap-2">
          {athlete ? <input type="hidden" name="athlete" value={athlete.id} /> : null}
          <div>
            <label htmlFor="hd" className="block text-xs font-medium text-ink-3">
              Window
            </label>
            <Select id="hd" name="days" defaultValue={String(days)}>
              <option value="7">Last 7 days</option>
              <option value="28">Last 28 days</option>
              <option value="56">Last 56 days</option>
            </Select>
          </div>
          <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
            Apply
          </button>
        </form>
      </div>
      {!athlete ? <EmptyState title="No athletes in your scope." /> : summaries.length === 0 ? <EmptyState title={`No habits assigned to ${athlete.name}.`} /> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        {athlete
          ? summaries.map((h) => (
              <Card key={h.habit.id}>
                <CardHeader title={h.habit.name} kicker={`${h.habit.frequency}${h.habit.targetValue != null ? ` · target ${h.habit.targetValue} ${h.habit.targetUnit}` : ""}`} />
                <CardBody className="space-y-4">
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <div className="rounded-lg bg-surface-2 p-2">
                      <div className="text-xl font-bold tabular">{h.adherence.adherencePct === null ? "—" : `${fmtN(h.adherence.adherencePct, 0)}%`}</div>
                      <div className="text-xs text-ink-3">adherence</div>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-2">
                      <div className="text-xl font-bold tabular">{h.streak}</div>
                      <div className="text-xs text-ink-3">current streak</div>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-2">
                      <div className="text-xl font-bold tabular">{h.adherence.expected}</div>
                      <div className="text-xs text-ink-3">expected</div>
                    </div>
                  </div>
                  <p className="text-xs text-ink-2">
                    Done {h.adherence.done} · Partial {h.adherence.partial} · <strong>Missed (reported) {h.adherence.missed}</strong> · <strong>No check-in {h.adherence.noCheckin}</strong> · {h.window.from} → {h.window.to} <FormulaTag k="habit_adherence_v1" />
                  </p>
                  <HabitCalendar h={h} />
                  {canLog && h.window.to === today ? (
                    <div>
                      <div className="mb-1 text-xs font-medium text-ink-3">Today ({today})</div>
                      <HabitCheckinForm habitId={h.habit.id} athleteId={athlete.id} forDate={today} unit={h.habit.targetUnit} current={h.todayStatus} />
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ))
          : null}
      </div>

      {manage ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Create habit" />
            <CardBody>
              <ActionForm action={createHabitAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="hn" required>
                  <Input id="hn" name="name" required maxLength={80} />
                </Field>
                <Field label="Frequency" htmlFor="hf">
                  <Select id="hf" name="frequency" defaultValue="daily">
                    <option value="daily">Daily</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Weekly</option>
                  </Select>
                </Field>
                <Field label="Target value (optional)" htmlFor="htv">
                  <Input id="htv" name="targetValue" type="number" step="any" min={0} />
                </Field>
                <Field label="Target unit" htmlFor="htu" hint="e.g. h, L, min">
                  <Input id="htu" name="targetUnit" maxLength={20} />
                </Field>
                <Field label="Description" htmlFor="hdsc" className="sm:col-span-2">
                  <Input id="hdsc" name="description" maxLength={300} />
                </Field>
                <div className="sm:col-span-2">
                  <SubmitButton>Create habit</SubmitButton>
                </div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Assign habit" />
            <CardBody>
              {all.length === 0 ? (
                <p className="text-sm text-ink-3">Create a habit first.</p>
              ) : (
                <ActionForm action={assignHabitAction} className="grid gap-3 sm:grid-cols-2">
                  <Field label="Habit" htmlFor="ah" required>
                    <Select id="ah" name="habitId" required>
                      {all.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Assign to" htmlFor="at" required hint="Groups must be fully in your coaching scope.">
                    <Select id="at" name="target" required>
                      <optgroup label="Groups">
                        {gs.map((g) => (
                          <option key={g.id} value={`group:${g.id}`}>
                            {g.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Athletes">
                        {athletes.map((a) => (
                          <option key={a.id} value={`athlete:${a.id}`}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  </Field>
                  <Field label="Start" htmlFor="as" required>
                    <Input id="as" name="startDate" type="date" defaultValue={today} required />
                  </Field>
                  <Field label="End (optional)" htmlFor="ae">
                    <Input id="ae" name="endDate" type="date" />
                  </Field>
                  <div className="sm:col-span-2">
                    <SubmitButton>Assign</SubmitButton>
                  </div>
                </ActionForm>
              )}
              {all.length ? (
                <Table className="mt-4" caption="Habits and assignments">
                  <thead>
                    <tr>
                      <Th>Habit</Th>
                      <Th>Frequency</Th>
                      <Th align="right">Assignments</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {all.map((h) => (
                      <tr key={h.id}>
                        <Td>{h.name}</Td>
                        <Td>{h.frequency}</Td>
                        <Td align="right">{h.assignments.length}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : null}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function HabitCalendar({ h }: { h: HabitSummary }) {
  const style: Record<string, string> = {
    done: "bg-ok text-white",
    partial: "bg-warn/70 text-white",
    missed: "bg-bad/80 text-white",
    none: "border border-dashed border-ink-3/60 text-ink-3",
  };
  const sym: Record<string, string> = { done: "✓", partial: "½", missed: "✕", none: "·" };
  return (
    <div>
      <ul className="flex flex-wrap gap-1" aria-label={`${h.habit.name} history`}>
        {h.calendar.map((c) => {
          const k = c.status ?? "none";
          return (
            <li key={c.date} title={`${c.date}: ${c.status ?? "no check-in"}${c.value != null ? ` (${c.value} ${h.habit.targetUnit ?? ""})` : ""}`} className={`flex size-7 items-center justify-center rounded text-xs font-bold ${style[k]}`}>
              <span aria-hidden>{sym[k]}</span>
              <span className="sr-only">
                {c.date} {c.status ?? "no check-in"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] text-ink-3">✓ done · ½ partial · ✕ missed (reported) · · no check-in{h.habit.frequency === "weekly" ? " · one cell per ISO week" : ""}</p>
    </div>
  );
}
