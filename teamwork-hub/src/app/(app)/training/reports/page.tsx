import Link from "next/link";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { groupsForViewer } from "@/lib/training/assignments";
import { listExercises } from "@/lib/training/exercises";
import { groupReport, leaderboard } from "@/lib/training/reports";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Button, buttonClass, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { importVbtAction } from "../actions";
import { guarded, isYmd, sp } from "../_lib/helpers";

export const metadata = { title: "Training reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireStaff();
  const q = await searchParams;
  const today = todayLocal();
  const from = isYmd(sp(q.from)) ? sp(q.from) : addDaysYmd(today, -28);
  const to = isYmd(sp(q.to)) ? sp(q.to) : today;
  const groupList = await groupsForViewer(db, viewer);
  const groupId = groupList.find((g) => g.id === sp(q.group))?.id ?? groupList[0]?.id;
  const report = groupId ? await guarded(() => groupReport(db, viewer, groupId, { from, to }, today)) : null;
  const exercises = await listExercises(db, viewer);
  const lbLift = exercises.find((e) => e.id === sp(q.lift))?.id ?? report?.topLifts[0]?.id ?? exercises.find((e) => e.name === "Back Squat")?.id;
  const board = groupId && lbLift ? await guarded(() => leaderboard(db, viewer, groupId, lbLift, { from, to })) : null;
  const exportQs = (kind: string) => `/api/training/export?kind=${kind}${groupId ? `&groupId=${groupId}` : ""}&from=${from}&to=${to}`;

  return (
    <div>
      <PageHeader kicker="Training" title="Reports" description="Group adherence and top lifts, opt-in leaderboard, CSV exports, and VBT file import." />
      <TrainingNav viewer={viewer} current="reports" />
      {!groupList.length ? (
        <EmptyState title="No groups in your scope" />
      ) : (
        <>
          <form method="get" className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
            <Field label="Group" htmlFor="rp-g">
              <Select id="rp-g" name="group" defaultValue={groupId}>
                {groupList.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From" htmlFor="rp-f">
              <Input id="rp-f" type="date" name="from" defaultValue={from} />
            </Field>
            <Field label="To" htmlFor="rp-t">
              <Input id="rp-t" type="date" name="to" defaultValue={to} />
            </Field>
            <Button type="submit" variant="secondary" className="min-h-11">
              Run report
            </Button>
          </form>

          {report ? (
            <Card className="mb-6">
              <CardHeader
                title={`${report.group.name}: adherence & top lifts`}
                kicker={`${fmtDate(from)} – ${fmtDate(to)}`}
                action={
                  <div className="flex flex-wrap gap-2">
                    <a href={exportQs("workouts")} download className={buttonClass("secondary", "sm")}>
                      Workouts CSV
                    </a>
                    <a href={exportQs("sets")} download className={buttonClass("secondary", "sm")}>
                      Set logs CSV
                    </a>
                  </div>
                }
              />
              {report.rows.length === 0 ? (
                <CardBody>
                  <p className="text-sm text-ink-3">No athletes in your scope in this group.</p>
                </CardBody>
              ) : (
                <Table caption="Group adherence and best e1RM per lift">
                  <thead>
                    <tr>
                      <Th>Athlete</Th>
                      <Th align="right">Adherence</Th>
                      <Th align="right">sRPE load (AU)</Th>
                      {report.topLifts.map((l) => (
                        <Th key={l.id} align="right">
                          {l.name} best e1RM
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.athleteId}>
                        <Td>
                          <Link href={`/training/athletes/${r.athleteId}?from=${from}&to=${to}`} className="text-brand hover:underline">
                            {r.name}
                          </Link>
                        </Td>
                        <Td align="right">{r.pct != null ? `${r.pct}% (${r.completed}/${r.scheduled})` : "—"}</Td>
                        <Td align="right">{r.sessionLoad || "—"}</Td>
                        {report.topLifts.map((l) => (
                          <Td key={l.id} align="right">
                            {r.best[l.id] ? `${r.best[l.id]!.value} ${r.best[l.id]!.unit}` : "—"}
                          </Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <CardBody>
                <p className="mt-2 text-xs text-ink-3">Adherence = completed ÷ scheduled, counting workouts dated up to today. e1RM uses Epley v1 on completed working sets of 1–10 reps; units are shown as logged and never converted.</p>
              </CardBody>
            </Card>
          ) : null}

          <Card className="mb-6">
            <CardHeader title="Leaderboard (opt-in only)" kicker={board ? `${board.optedInCount} of ${board.eligibleCount} athletes opted in` : undefined} />
            <CardBody>
              <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="group" value={groupId} />
                <input type="hidden" name="from" value={from} />
                <input type="hidden" name="to" value={to} />
                <Field label="Lift" htmlFor="lb-l">
                  <Select id="lb-l" name="lift" defaultValue={lbLift}>
                    {exercises
                      .filter((e) => e.trackingType === "weight_reps")
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Button type="submit" variant="secondary" className="min-h-11">
                  Show
                </Button>
              </form>
              {!board || board.rows.length === 0 ? (
                <p className="text-sm text-ink-3">No opted-in results for this lift and range. Athletes (or guardians) opt in from their training history page.</p>
              ) : (
                <ol className="divide-y divide-edge">
                  {board.rows.map((r, i) => (
                    <li key={r.athleteId} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        <span className="mr-2 inline-block w-6 text-right font-bold tabular">{i + 1}.</span>
                        {r.name}
                      </span>
                      <span className="tabular">
                        <strong>
                          {r.e1rm} {r.unit}
                        </strong>{" "}
                        <span className="text-xs text-ink-3">
                          ({r.detail}, {r.date})
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {can(viewer, "training.manage") ? (
        <Card>
          <CardHeader title="Import VBT readings (CSV file)" kicker="File import — no device connection" />
          <CardBody>
            <p className="mb-3 text-sm text-ink-2">
              Columns: <code>athlete</code> (external id or email), <code>exercise</code> (library name), <code>timestamp</code>, <code>load</code>, <code>unit</code> (lb/kg), <code>rep</code>, <code>mean_velocity</code>, <code>peak_velocity</code> (m/s),{" "}
              <code>power</code> (W), <code>device</code>. Each reading records the file it came from. Re-importing the same rows is skipped.
            </p>
            <ActionForm action={importVbtAction} className="flex flex-wrap items-end gap-3">
              <Field label="CSV file" htmlFor="vbt-f">
                <Input id="vbt-f" name="file" type="file" accept=".csv,text/csv" required />
              </Field>
              <SubmitButton pendingText="Importing…">Import</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
