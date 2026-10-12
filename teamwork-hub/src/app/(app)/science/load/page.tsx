import { ColumnChart } from "@/components/charts/bar-chart";
import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th } from "@/components/ui";
import { HeroStat, ModuleHero } from "../../training/_components/tb";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { FORMULAS, mean } from "@/lib/science/formulas";
import { athleteLoad } from "@/lib/science/load";
import { todayLocal } from "@/lib/time";
import { deleteActivityAction, logActivityAction } from "../actions";
import { AthletePicker, FormulaTag, fmtN, pickAthlete, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Load monitoring" };

const STATUS_STYLE: Record<string, string> = {
  logged: "bg-[#2a78d6] dark:bg-[#3987e5]",
  rest: "bg-surface-2 border border-ink-3",
  incomplete: "bg-warn/60",
  no_data: "border border-dashed border-ink-3/70",
};

export default async function LoadPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "training.read");
  const athlete = pickAthlete(athletes, sp1(p.athlete));
  if (!athlete) return <EmptyState title="No athletes in your scope." />;
  const L = await athleteLoad(db, v, athlete.id, today, 56);
  const canLog = await canOnAthlete(db, v, athlete.id, "training.log");
  const canDelete = await canOnAthlete(db, v, athlete.id, "training.write");
  const coverage56 = L.series.filter((d) => d.load !== null).length / L.series.length;
  const a = L.acwr;
  return (
    <>
      <ModuleHero kicker="Sports science · AMS · Load" title={athlete.name} description={`Session load ${FORMULAS.srpe_load_v1.definition} Reported in arbitrary units (AU).`}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <HeroStat label="ACWR (acwr_rolling_v1)" value={a.ratio === null ? "—" : fmtN(a.ratio)} hint={a.ratio === null ? a.reason : `acute ${fmtN(a.acuteMean, 0)} ÷ chronic ${fmtN(a.chronicMean, 0)} AU/day`} />
          <HeroStat label={`7-day load (to ${L.metricsAsOf.slice(5)})`} value={L.weeklyLoad === null ? "—" : `${Math.round(L.weeklyLoad)} AU`} hint={L.weeklyLoad === null ? "Needs all 7 days known" : "srpe_load_v1 sum"} />
          <HeroStat label="Monotony / strain" value={L.monotony === null ? "—" : fmtN(L.monotony)} hint={L.strain === null ? "Needs 7 known days with variation" : `strain ${Math.round(L.strain)} AU`} />
          <HeroStat label="Data coverage (56 d)" value={`${Math.round(coverage56 * 100)}%`} hint="Days with known load (logged or rest)" />
        </div>
      </ModuleHero>
      <div className="mb-4 rounded-lg border border-edge bg-surface p-3 empty:hidden">
        <AthletePicker athletes={athletes} current={athlete.id} />
      </div>
      <Card className="mb-6">
        <CardHeader title="Comparison windows" kicker={`Metrics as of ${L.metricsAsOf}${L.metricsAsOf !== L.to ? " (today not logged yet)" : ""} · formula versions shown`} />
        <CardBody className="text-sm text-ink-2">
          <ul className="space-y-1">
            <li>
              Acute: {a.acuteWindow.start} → {a.acuteWindow.end} ({a.acuteWindow.days} days) · coverage {Math.round(a.acuteCoverage * 100)}%
            </li>
            <li>
              Chronic: {a.chronicWindow.start} → {a.chronicWindow.end} ({a.chronicWindow.days} days, coupled) · coverage {Math.round(a.chronicCoverage * 100)}% · minimum {Math.round(L.minCoverage * 100)}%
            </li>
            <li className="flex flex-wrap gap-1">
              <FormulaTag k="srpe_load_v1" /> <FormulaTag k="acwr_rolling_v1" /> <FormulaTag k="monotony_v1" /> <FormulaTag k="strain_v1" />
            </li>
          </ul>
          <p className="mt-2 text-xs text-ink-3">Days without entries count as 0 only when recorded as a rest day. Otherwise they reduce coverage, and the ratio is withheld below the threshold. A session with missing duration or RPE makes that day “incomplete” (unknown, never 0).</p>
        </CardBody>
      </Card>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Daily load" kicker={`${L.from} → ${L.to}`} />
          <CardBody>
            <ChartFigure
              title="Daily session load (srpe_load_v1)"
              unit="AU (arbitrary units)"
              range={`${L.from} – ${L.to}`}
              summary={`${L.series.filter((d) => d.status === "logged").length} days logged, ${L.series.filter((d) => d.status === "rest").length} rest days, ${L.series.filter((d) => d.status === "incomplete").length} incomplete, ${L.series.filter((d) => d.status === "no_data").length} with no data. Mean known daily load ${fmtN(mean(L.series.map((d) => d.load)), 0)} AU.`}
              columns={["Date", "Status", "Load (AU)", "Sessions"]}
              rows={L.series.map((d) => [d.date, d.status.replace("_", " "), d.load === null ? null : Math.round(d.load), d.sessions])}
            >
              <ColumnChart data={L.series.map((d) => ({ x: d.date, y: d.load }))} unit="AU" label="Daily load" />
            </ChartFigure>
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-ink-3">Data coverage by day</div>
              <ul className="grid grid-cols-[repeat(28,minmax(0,1fr))] gap-0.5" aria-label="Coverage per day">
                {L.series.slice(-28).map((d) => (
                  <li key={d.date} title={`${d.date}: ${d.status.replace("_", " ")}`} className={`h-4 rounded-sm ${STATUS_STYLE[d.status]}`}>
                    <span className="sr-only">
                      {d.date} {d.status}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-3">
                {Object.entries({ logged: "logged", rest: "rest (0 AU)", incomplete: "incomplete", no_data: "no data" }).map(([k, l]) => (
                  <span key={k} className="flex items-center gap-1">
                    <span aria-hidden className={`inline-block size-3 rounded-sm ${STATUS_STYLE[k]}`} />
                    {l}
                  </span>
                ))}
              </p>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Weekly totals" kicker="ISO weeks (Mon–Sun)" />
          <CardBody>
            <Table caption="Weekly load totals">
              <thead>
                <tr>
                  <Th>Week of</Th>
                  <Th align="right">Total (AU)</Th>
                  <Th align="right">Known days</Th>
                </tr>
              </thead>
              <tbody>
                {L.weeks.map((w) => (
                  <tr key={w.weekStart}>
                    <Td>{w.weekStart}</Td>
                    <Td align="right">{w.total === null ? "—" : Math.round(w.total)}</Td>
                    <Td align="right">
                      {w.knownDays}/{w.days}
                      {w.knownDays < w.days ? <span className="ml-1 text-xs text-warn">partial</span> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2 text-xs text-ink-3">A partial week’s total only includes known days; it is not a full-week figure.</p>
          </CardBody>
        </Card>
        {L.readiness ? (
          <Card>
            <CardHeader title="Wellness context" kicker="Separate chart · shared dates, separate scale" />
            <CardBody>
              <ChartFigure
                title="Teamwork readiness (tw_readiness_v1)"
                unit="0–100 Teamwork scale"
                range={`${L.from} – ${L.to}`}
                summary={`${L.readiness.size} check-ins in the window. Shown beside load (not on a second axis) so the two scales are never conflated.`}
                columns={["Date", "Readiness", "Load (AU)"]}
                rows={L.series.map((d) => [d.date, L.readiness!.get(d.date) == null ? null : Math.round(L.readiness!.get(d.date)!), d.load === null ? null : Math.round(d.load)])}
              >
                <TrendChart data={L.series.map((d) => ({ x: d.date, r: L.readiness!.get(d.date) == null ? null : Math.round(L.readiness!.get(d.date)!) }))} series={[{ key: "r", label: "Readiness" }]} unit="/100" digits={0} yDomain={[0, 100]} height={180} />
              </ChartFigure>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Sessions" kicker="Manual activity + completed workouts" />
          <CardBody>
            {canLog ? (
              <ActionForm action={logActivityAction} resetOnSuccess className="mb-4 grid gap-2 sm:grid-cols-6">
                <input type="hidden" name="athleteId" value={athlete.id} />
                <Field label="Date" htmlFor="la-d" className="sm:col-span-2">
                  <Input id="la-d" type="date" name="activityDate" defaultValue={today} max={today} required />
                </Field>
                <Field label="Type" htmlFor="la-k" className="sm:col-span-2">
                  <Select id="la-k" name="kind" defaultValue="practice">
                    <option value="practice">Practice</option>
                    <option value="game">Game</option>
                    <option value="conditioning">Conditioning</option>
                    <option value="other">Other</option>
                    <option value="rest">Rest day (no activity = 0 AU)</option>
                  </Select>
                </Field>
                <Field label="Minutes" htmlFor="la-m">
                  <Input id="la-m" name="durationMinutes" type="number" min={0} max={600} inputMode="numeric" />
                </Field>
                <Field label="sRPE 0–10" htmlFor="la-r">
                  <Input id="la-r" name="sessionRpe" type="number" min={0} max={10} inputMode="numeric" />
                </Field>
                <div className="sm:col-span-6">
                  <SubmitButton>Log session</SubmitButton>
                </div>
              </ActionForm>
            ) : null}
            <Table caption="Load entries">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Session</Th>
                  <Th align="right">Min</Th>
                  <Th align="right">sRPE</Th>
                  <Th align="right">Load (AU)</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {[...L.entries].reverse().slice(0, 40).map((e) => (
                  <tr key={`${e.source}-${e.id}`}>
                    <Td>{e.date}</Td>
                    <Td>{e.kind === "rest" ? "Rest day" : e.label}</Td>
                    <Td align="right">{e.durationMin ?? "—"}</Td>
                    <Td align="right">{e.rpe ?? "—"}</Td>
                    <Td align="right">{e.kind === "rest" ? "0" : e.load === null ? <span className="text-warn">unknown</span> : e.load}</Td>
                    <Td>
                      {canDelete && e.source === "activity" ? (
                        <ActionForm action={deleteActivityAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <SubmitButton variant="ghost" size="sm" confirm="Delete this session?">
                            Delete
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
