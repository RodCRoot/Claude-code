import { ChartFigure } from "@/components/charts/chart-figure";
import { ForceTraceChart } from "@/components/charts/force-trace-chart";
import { TrendChart } from "@/components/charts/trend-chart";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { forcePlateDashboard, readForceTrace, type ForceTrace } from "@/lib/science/forceplate";
import { fmt } from "@/lib/time";
import { toggleTrialAction } from "../actions";
import { AthletePicker, FormulaTag, SourceBadge, fmtN, pickAthlete, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Force plate" };

export default async function ForcePlatePage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const athletes = await scopedAthletes(db, v, "training.read");
  const athlete = pickAthlete(athletes, sp1(p.athlete));
  if (!athlete) return <EmptyState title="No athletes in your scope." />;
  const { series, signals } = await forcePlateDashboard(db, v, athlete.id);
  const canEdit = await canOnAthlete(db, v, athlete.id, "training.write");
  const signal = signals.find((s) => s.id === sp1(p.signal)) ?? signals[0] ?? null;
  let trace: ForceTrace | null = null;
  let traceError: string | null = null;
  if (signal) {
    try {
      trace = await readForceTrace(db, v, signal.id);
    } catch (e) {
      traceError = e instanceof Error ? e.message : "Could not read the stored signal.";
    }
  }
  return (
    <>
      <PageHeader kicker="Sports science" title="Force plate dashboard" description="Vendor metrics are shown exactly as the vendor reported them and badged “Hawkin (vendor)”. Session values use only included individual trials; vendor aggregate rows are displayed separately and never averaged in." />
      <Callout className="mb-4">
        Change band <FormulaTag k="swc_02sd_v1" /> = 0.2 × between-session SD of this athlete’s session values (≥ 3 sessions) — a Teamwork convention, not a vendor statistic. Bilateral comparison from raw traces uses <FormulaTag k="asymmetry_v1" /> (Teamwork-derived).
      </Callout>
      <div className="mb-4">
        <AthletePicker athletes={athletes} current={athlete.id} />
      </div>
      {series.length === 0 ? <EmptyState title={`No force-plate sessions for ${athlete.name}.`}>Hawkin data arrives through the Hawkin import/API module (not configured here) or a file import.</EmptyState> : null}
      <div className="grid gap-6 xl:grid-cols-2">
        {series.map((s) => {
          const d = s.metric.precision;
          const u = s.metric.unit;
          return (
            <Card key={s.metric.id}>
              <CardHeader title={s.metric.name} kicker={`${u} · selection: ${[...new Set(s.points.map((x) => x.rule))].join(", ")}`} action={<SourceBadge source={s.metric.definedBy} />} />
              <CardBody className="space-y-3">
                <p className="text-sm">
                  Latest <strong className="tabular">{s.latest ? `${fmtN(s.latest.value, d)} ${u}` : "—"}</strong>
                  {s.baseline ? ` · baseline ${s.baseline.value.toFixed(d)} (${s.baseline.source === "target" ? "set by coach" : "first session"})` : ""}
                  {s.change !== null ? ` · change ${s.change > 0 ? "+" : ""}${s.change.toFixed(d)} ${u}` : ""} · SWC ±{fmtN(s.swc, d)}
                </p>
                <ChartFigure
                  title={`${s.metric.name} by session`}
                  unit={u}
                  summary={`${s.points.length} sessions. Source: ${s.points[0]?.device ?? s.points[0]?.source ?? "—"}. ${s.swc === null ? "SWC band needs ≥ 3 sessions." : `Shaded band = baseline ± SWC (${s.swc.toFixed(d)} ${u}).`}`}
                  columns={["Date", "Selected", "Trials used", "Vendor mean (separate)"]}
                  rows={s.points.map((x) => [x.date, x.value === null ? null : x.value.toFixed(d), x.n, x.vendorAggregate === null ? null : x.vendorAggregate.toFixed(d)])}
                >
                  <TrendChart
                    data={s.points.map((x) => ({ x: x.date, value: x.value }))}
                    series={[{ key: "value", label: s.metric.name }]}
                    unit={u}
                    digits={d}
                    refLines={s.baseline ? [{ y: s.baseline.value, label: "Baseline" }] : []}
                    band={s.swc !== null && s.baseline ? { y1: s.baseline.value - s.swc, y2: s.baseline.value + s.swc, label: "SWC" } : null}
                  />
                </ChartFigure>
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-ink-3 hover:text-ink">Trials per session ({s.points.length})</summary>
                  <div className="mt-2 space-y-3">
                    {[...s.points].reverse().map((pt) => (
                      <div key={pt.sessionId} className="rounded-lg border border-edge p-2 text-sm">
                        <div className="mb-1 text-xs text-ink-3">
                          {fmt(pt.testedAt)} · {pt.testTypeName} · rule {pt.rule} → {pt.value === null ? (pt.reason ?? "—") : `${pt.value.toFixed(d)} ${u}`}
                        </div>
                        <ul className="space-y-1">
                          {pt.trials.map((t) => (
                            <li key={t.trialId} className="flex flex-wrap items-center gap-2">
                              {t.isAggregate ? <Badge variant="yellow">Vendor {t.aggregateKind?.replace("vendor_", "") ?? "aggregate"} row</Badge> : <span className="tabular">Trial {t.trialNumber}</span>}
                              <span className="tabular">{t.value === null ? <span className="text-ink-3">null (not reported)</span> : `${t.rawValue ?? t.value} ${t.enteredUnit}`}</span>
                              {t.excluded ? <Badge variant="red" title={t.exclusionReason ?? ""}>Excluded: {t.exclusionReason}</Badge> : null}
                              {canEdit && !t.isAggregate ? (
                                <ActionForm action={toggleTrialAction} className="flex items-center gap-1">
                                  <input type="hidden" name="trialId" value={t.trialId} />
                                  <input type="hidden" name="excluded" value={t.excluded ? "false" : "true"} />
                                  {!t.excluded ? <Input name="reason" placeholder="Reason" aria-label="Exclusion reason" className="h-8 w-36 text-xs" /> : null}
                                  <SubmitButton variant="ghost" size="sm">
                                    {t.excluded ? "Include" : "Exclude"}
                                  </SubmitButton>
                                </ActionForm>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
              </CardBody>
            </Card>
          );
        })}
      </div>
      <Card className="mt-6">
        <CardHeader title="Raw force–time trace" kicker="Stored CSV (time_s, force_left_N, force_right_N) read server-side" />
        <CardBody>
          {signals.length === 0 ? (
            <p className="text-sm text-ink-3">No raw signals stored for this athlete.</p>
          ) : (
            <>
              <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="athlete" value={athlete.id} />
                <div>
                  <label htmlFor="sig" className="block text-xs font-medium text-ink-3">
                    Trial
                  </label>
                  <Select id="sig" name="signal" defaultValue={signal?.id}>
                    {signals.map((s) => (
                      <option key={s.id} value={s.id}>
                        {fmt(s.testedAt, "MMM d, yyyy")} · {s.testType} · trial {s.trialNumber ?? "?"}
                      </option>
                    ))}
                  </Select>
                </div>
                <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
                  Show
                </button>
              </form>
              {traceError ? <Callout tone="bad">{traceError}</Callout> : null}
              {trace && signal ? (
                <ChartFigure
                  title="Vertical force by plate"
                  unit="N (newtons) vs s"
                  range={`${fmtN(trace.durationS, 2)} s · ${trace.samples} samples @ ${signal.sampleRateHz ?? "?"} Hz (plotted ${trace.downsampledTo})`}
                  legend={[
                    { label: "Left plate", slot: 0 },
                    { label: "Right plate", slot: 1 },
                  ]}
                  summary={`Peak left ${fmtN(trace.peakLeftN, 0)} N, peak right ${fmtN(trace.peakRightN, 0)} N. Peak-force asymmetry (Teamwork-derived, asymmetry_v1): ${fmtN(trace.peakAsymmetryPct, 1)}% (positive = left greater). File: ${signal.filename}.`}
                  columns={["t (s)", "Left (N)", "Right (N)"]}
                  rows={trace.points.filter((_, i) => i % 5 === 0).map((x) => [x.t.toFixed(3), x.left === null ? null : x.left.toFixed(1), x.right === null ? null : x.right.toFixed(1)])}
                >
                  <ForceTraceChart points={trace.points} />
                </ChartFigure>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </>
  );
}
