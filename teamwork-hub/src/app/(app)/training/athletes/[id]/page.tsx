import Link from "next/link";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { athleteCapabilities, isStaff, requireOnAthlete } from "@/lib/authz/policy";
import { addDaysYmd, fmt, fmtDate, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { adherence, METHOD_LABEL } from "@/lib/training/formulas";
import { maxHistory, suggestEstimatedMaxes } from "@/lib/training/maxes";
import { athleteWorkouts, e1rmSeries, leaderboardOptIn, liftsWithData, recentVbt } from "@/lib/training/reports";
import { listExercises } from "@/lib/training/exercises";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Button, buttonClass, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { TrainingNav } from "../../_components/training-nav";
import { E1rmChart } from "../../_components/e1rm-chart";
import { confirmEstimateAction, leaderboardOptInAction, recordMaxAction } from "../../actions";
import { guarded, isYmd, sp } from "../../_lib/helpers";

export const metadata = { title: "Athlete training" };

export default async function AthleteTraining({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  const viewer = await requireViewer();
  await guarded(() => requireOnAthlete(db, viewer, id, "training.read"));
  const caps = await athleteCapabilities(db, viewer, id);
  const canWrite = caps.has("training.write");
  const today = todayLocal();
  const from = isYmd(sp(q.from)) ? sp(q.from) : addDaysYmd(today, -90);
  const to = isYmd(sp(q.to)) ? sp(q.to) : today;

  const name = (await athleteNames(db, viewer.orgId, [id])).get(id) ?? "Athlete";
  const ws = await athleteWorkouts(db, viewer, id, { from, to: addDaysYmd(to, 0) });
  const adh = adherence(ws, today < to ? today : to);
  const sessionLoad = ws.reduce((s, w) => s + (w.sessionRpe != null && w.durationMinutes != null ? w.sessionRpe * w.durationMinutes : 0), 0);
  const maxRows = await maxHistory(db, viewer, id);
  const lifts = await liftsWithData(db, viewer, id);
  const liftIds = [...new Set([...lifts.map((l) => l.id), ...maxRows.filter((m) => m.m.unit === "lb" || m.m.unit === "kg").map((m) => m.m.exerciseId)])];
  const liftNames = new Map([...lifts.map((l) => [l.id, l.name] as const), ...maxRows.map((m) => [m.m.exerciseId, m.exerciseName] as const)]);
  const liftId = liftIds.includes(sp(q.lift)) ? sp(q.lift) : liftIds[0];
  const series = liftId ? await e1rmSeries(db, viewer, id, liftId, { from, to }) : [];
  const liftMaxes = maxRows.filter((m) => m.m.exerciseId === liftId && m.m.recordedOn >= from && m.m.recordedOn <= to);
  const units: string[] = [...new Set<string>([...series.map((s) => s.unit), ...liftMaxes.map((m) => m.m.unit)])].filter((u) => u === "lb" || u === "kg");
  const unit = units.includes(sp(q.unit)) ? sp(q.unit) : units[0] ?? "lb";
  const byDate = new Map<string, { date: string; e1rm?: number | null; max?: number | null; detail?: string }>();
  for (const s of series.filter((s) => s.unit === unit)) byDate.set(s.date, { date: s.date, e1rm: s.e1rm, detail: s.detail });
  for (const m of liftMaxes.filter((m) => m.m.unit === unit)) byDate.set(m.m.recordedOn, { ...(byDate.get(m.m.recordedOn) ?? { date: m.m.recordedOn }), max: Number(m.m.value) });
  const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  const suggestions = canWrite ? await suggestEstimatedMaxes(db, viewer, id, "epley_v1", today) : [];
  const exercises = canWrite ? await listExercises(db, viewer) : [];
  const vbt = await recentVbt(db, viewer, id, 15);
  const optedIn = await leaderboardOptIn(db, viewer.orgId, id);
  const canOptIn = viewer.role === "athlete" || viewer.role === "guardian";
  const qs = (extra: Record<string, string>) => new URLSearchParams({ from, to, ...(liftId ? { lift: liftId } : {}), ...extra }).toString();

  return (
    <div>
      <PageHeader
        kicker="Training history"
        title={name}
        description={`${fmtDate(from)} – ${fmtDate(to)}`}
        actions={
          <>
            <a href={`/api/training/export?kind=workouts&athleteId=${id}&from=${from}&to=${to}`} download className={buttonClass("secondary", "sm")}>
              Export workouts CSV
            </a>
            <a href={`/api/training/export?kind=sets&athleteId=${id}&from=${from}&to=${to}`} download className={buttonClass("secondary", "sm")}>
              Export set logs CSV
            </a>
          </>
        }
      />
      <TrainingNav viewer={viewer} current={isStaff(viewer) ? "athletes" : "overview"} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From" htmlFor="r-from">
          <Input id="r-from" type="date" name="from" defaultValue={from} />
        </Field>
        <Field label="To" htmlFor="r-to">
          <Input id="r-to" type="date" name="to" defaultValue={to} />
        </Field>
        {liftId ? <input type="hidden" name="lift" value={liftId} /> : null}
        <Button type="submit" variant="secondary" className="min-h-11">
          Apply range
        </Button>
      </form>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Adherence" value={adh.pct != null ? `${adh.pct}%` : "—"} hint={`${adh.completed} completed of ${adh.scheduled} scheduled up to today`} />
        <Stat label="Workouts in range" value={ws.length} hint={`${ws.filter((w) => w.status === "skipped").length} skipped`} />
        <Stat label="Session load" value={sessionLoad ? `${sessionLoad} AU` : "—"} hint="Σ session RPE × minutes (completed workouts)" />
      </div>

      <Card className="mb-6">
        <CardHeader title="Strength progress" kicker="e1RM chart" />
        <CardBody>
          {liftIds.length === 0 ? (
            <EmptyState title="No lift data yet">Logged weight × reps sets (1–10 reps) and recorded maxes appear here.</EmptyState>
          ) : (
            <>
              <nav aria-label="Lift" className="mb-3 flex flex-wrap gap-1">
                {liftIds.map((l) => (
                  <Link key={l} href={`?${qs({ lift: l })}`} aria-current={l === liftId ? "page" : undefined} className={`min-h-11 rounded-lg border px-3 py-2.5 text-sm ${l === liftId ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}>
                    {liftNames.get(l)}
                  </Link>
                ))}
                {units.length > 1
                  ? units.map((u) => (
                      <Link key={u} href={`?${qs({ unit: u })}`} className={`min-h-11 rounded-lg border px-3 py-2.5 text-sm ${u === unit ? "border-ok text-ok" : "border-edge"}`}>
                        Show {u}
                      </Link>
                    ))
                  : null}
              </nav>
              <E1rmChart points={points} unit={unit} lift={liftNames.get(liftId!) ?? "Lift"} from={from} to={to} />
              {units.length > 1 ? <p className="mt-1 text-xs text-ink-3">Data exists in both lb and kg; units are never mixed on one chart.</p> : null}
            </>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Max & PR history" kicker="Append-only" />
          <CardBody>
            {maxRows.length === 0 ? (
              <p className="text-sm text-ink-3">No maxes recorded.</p>
            ) : (
              <Table caption="Max history">
                <thead>
                  <tr>
                    <Th>Exercise</Th>
                    <Th align="right">Max</Th>
                    <Th>Type / method</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {maxRows.map(({ m, exerciseName }) => (
                    <tr key={m.id}>
                      <Td>{exerciseName}</Td>
                      <Td align="right">
                        {Number(m.value)} {m.unit}
                      </Td>
                      <Td className="text-xs">
                        <Badge variant={m.kind === "tested" ? "green" : m.kind === "estimated" ? "blue" : "neutral"}>{m.kind}</Badge> {METHOD_LABEL[m.method] ?? m.method}
                      </Td>
                      <Td>{fmtDate(m.recordedOn)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {canWrite ? (
              <ActionForm action={recordMaxAction} resetOnSuccess className="mt-4 grid grid-cols-2 gap-2 border-t border-edge pt-4 sm:grid-cols-3">
                <input type="hidden" name="athleteId" value={id} />
                <Field label="Exercise" htmlFor="mx-ex" className="col-span-2 sm:col-span-3">
                  <Select id="mx-ex" name="exerciseId" required>
                    {exercises.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Value" htmlFor="mx-v">
                  <Input id="mx-v" name="value" type="number" step="0.5" min={0.5} required />
                </Field>
                <Field label="Unit" htmlFor="mx-u">
                  <Select id="mx-u" name="unit" defaultValue="lb">
                    <option value="lb">lb</option>
                    <option value="kg">kg</option>
                    <option value="s">s</option>
                    <option value="m">m</option>
                    <option value="reps">reps</option>
                  </Select>
                </Field>
                <Field label="Type" htmlFor="mx-k">
                  <Select id="mx-k" name="kind" defaultValue="tested">
                    <option value="tested">Tested 1RM</option>
                    <option value="manual">Coach entered</option>
                  </Select>
                </Field>
                <Field label="Date" htmlFor="mx-d">
                  <Input id="mx-d" name="recordedOn" type="date" defaultValue={today} max={today} required />
                </Field>
                <div className="col-span-2 flex items-end">
                  <SubmitButton>Record max</SubmitButton>
                </div>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>

        {canWrite ? (
          <Card>
            <CardHeader title="Suggested estimated maxes" kicker="Coach confirms" />
            <CardBody>
              <p className="mb-3 text-xs text-ink-3">
                From the best completed set (1–10 reps) in the last 42 days that beats the current max in the same unit. Epley v1: 1RM = w × (1 + reps/30). Brzycki v1: 1RM = w × 36 / (37 − reps). Nothing is stored until you confirm.
              </p>
              {suggestions.length === 0 ? (
                <p className="text-sm text-ink-3">No suggestions right now.</p>
              ) : (
                <ul className="divide-y divide-edge">
                  {suggestions.map((s) => (
                    <li key={s.suggested.setLogId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span>
                        <strong>{s.exerciseName}</strong>: {s.suggested.e1rm} {s.suggested.unit}{" "}
                        <span className="text-xs text-ink-3">
                          from {s.suggested.load} {s.suggested.unit} × {s.suggested.reps} on {s.suggested.date}; current {s.current ? `${s.current.value} ${s.current.unit} (${s.current.recordedOn})` : "none"}
                        </span>
                      </span>
                      <ActionForm action={confirmEstimateAction} className="flex gap-1">
                        <input type="hidden" name="athleteId" value={id} />
                        <input type="hidden" name="setLogId" value={s.suggested.setLogId} />
                        <SubmitButton size="sm" name="method" value="epley_v1">
                          Save (Epley)
                        </SubmitButton>
                        <SubmitButton size="sm" variant="secondary" name="method" value="brzycki_v1">
                          Brzycki
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        ) : null}

        {canOptIn ? (
          <Card>
            <CardHeader title="Group leaderboard" />
            <CardBody>
              <p className="mb-3 text-sm text-ink-2">
                {optedIn ? "Opted in: best e1RMs may appear on your training group's leaderboard, visible to your coaches." : "Not participating. Leaderboards are opt-in only."}
              </p>
              <ActionForm action={leaderboardOptInAction}>
                <input type="hidden" name="athleteId" value={id} />
                <input type="hidden" name="optIn" value={optedIn ? "false" : "true"} />
                <SubmitButton variant={optedIn ? "secondary" : "primary"}>{optedIn ? "Opt out" : "Opt in"}</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Velocity (VBT) readings" kicker="Imported files only" />
          <CardBody>
            {vbt.length === 0 ? (
              <p className="text-sm text-ink-3">No imported VBT readings. Staff can import device CSV exports in Reports. No live device connection is used.</p>
            ) : (
              <Table caption="VBT readings">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Exercise</Th>
                    <Th align="right">Load</Th>
                    <Th align="right">Mean / peak m/s</Th>
                    <Th>Source</Th>
                  </tr>
                </thead>
                <tbody>
                  {vbt.map(({ r, exerciseName, fileName }) => (
                    <tr key={r.id}>
                      <Td>{fmt(r.performedAt)}</Td>
                      <Td>
                        {exerciseName ?? "—"} {r.repNumber ? `#${r.repNumber}` : ""}
                      </Td>
                      <Td align="right">{r.load != null ? `${Number(r.load)} ${r.loadUnit}` : "—"}</Td>
                      <Td align="right">
                        {r.meanVelocityMs ?? "—"} / {r.peakVelocityMs ?? "—"}
                      </Td>
                      <Td className="text-xs">Imported file: {fileName ?? "unknown"}{r.device ? ` (${r.device})` : ""}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Workouts" kicker={`${ws.length} in range`} />
        {ws.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">No workouts in this range.</p>
          </CardBody>
        ) : (
          <Table caption="Workouts">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Workout</Th>
                <Th>Status</Th>
                <Th align="right">sRPE × min</Th>
                <Th>Reviewed</Th>
              </tr>
            </thead>
            <tbody>
              {ws.map((w) => (
                <tr key={w.id}>
                  <Td>{fmtDate(w.scheduledDate)}</Td>
                  <Td>
                    <Link href={`/training/workouts/${w.id}`} className="text-brand hover:underline">
                      {w.title}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={w.status} />
                  </Td>
                  <Td align="right">{w.sessionRpe != null ? `${w.sessionRpe} × ${w.durationMinutes}` : "—"}</Td>
                  <Td>{w.coachReviewedAt ? <StatusBadge status="reviewed" /> : w.status === "completed" ? <span className="text-xs text-ink-3">pending</span> : ""}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
