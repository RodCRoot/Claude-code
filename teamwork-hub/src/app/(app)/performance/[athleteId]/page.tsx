import { notFound } from "next/navigation";
import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { Avatar, Callout, Card, CardBody, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";
import { HeroStat, ModuleHero, PrBadge, ProgressBar, TrendArrow } from "../../training/_components/tb";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { BODY_MAP_DISCLAIMER, regionLabel } from "@/lib/science/body-regions";
import { VENDOR_LABEL } from "@/lib/science/kpis";
import { performanceSummary } from "@/lib/science/performance";
import type { ReportContent } from "@/lib/science/reports";
import { fmt, fmtDate } from "@/lib/time";
import { ReportBody } from "../_components/report-view";

export const metadata = { title: "Athlete progress" };

const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

export default async function AthletePerformancePage({ params }: { params: Promise<{ athleteId: string }> }) {
  const v = await requireViewer();
  const { athleteId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(athleteId) || !(await canOnAthlete(db, v, athleteId, "training.read"))) notFound();
  const [athlete] = await scopedAthletes(db, v, "training.read", { includeInactive: true, ids: [athleteId] });
  if (!athlete) notFound();
  const s = await performanceSummary(db, v, athleteId);
  const canSeeHealth = s.health !== null;
  return (
    <>
      <ModuleHero
        kicker="Performance · Athlete profile"
        title={
          <span className="flex items-center gap-3">
            <Avatar name={athlete.name} className="size-11! bg-white/15! text-base! text-white!" />
            {athlete.name}
          </span>
        }
        description="Coach-recorded results and shared progress reports."
      >
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <HeroStat label="Attendance (90 days)" value={s.attendance.ratePct === null ? "—" : `${n(s.attendance.ratePct, 0)}%`} hint={`${s.attendance.attended} attended · ${s.attendance.noShow} no-show`} />
          <HeroStat label="Tests tracked" value={s.kpis.length} hint="Metrics with results (12 months)" />
          <HeroStat label="Strength maxes" value={s.strength.length} hint={`${s.strength.filter((x) => x.prInPeriod).length} new PR(s) in 90 days`} />
          <HeroStat label="Shared reports" value={s.reports.length} />
        </div>
      </ModuleHero>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader title="Testing results" kicker="Latest vs baseline vs target" />
          <CardBody>
            {s.kpis.length === 0 ? (
              <p className="text-sm text-ink-3">No testing results yet.</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-2">
                {s.kpis.map((k) => {
                  const d = k.metric.precision;
                  return (
                    <div key={k.metric.id} className="min-w-0 rounded-lg border border-edge p-3">
                      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-3xl leading-none font-extrabold tabular">{n(k.latest?.value, d)}</span>
                        <span className="text-xs font-semibold text-ink-2">{k.metric.unit} latest</span>
                        <TrendArrow
                          delta={k.changePct}
                          unit="% vs baseline"
                          digits={1}
                          good={k.changePct === null || k.metric.higherIsBetter === null ? null : k.metric.higherIsBetter ? k.changePct > 0 : k.changePct < 0}
                        />
                      </div>
                    <ChartFigure
                      title={`${k.metric.name} (${VENDOR_LABEL[k.metric.definedBy] ?? k.metric.definedBy})`}
                      unit={k.metric.unit}
                      range="last 12 months"
                      summary={`Latest ${n(k.latest?.value, d)} ${k.metric.unit}${k.latest ? ` on ${k.latest.date}` : ""}; baseline ${n(k.baseline?.value, d)}; target ${n(k.target?.value, d)}${k.changePct !== null ? `; ${k.changePct > 0 ? "+" : ""}${k.changePct.toFixed(1)}% vs baseline` : ""}. ${k.metric.higherIsBetter === false ? "Lower is better." : k.metric.higherIsBetter ? "Higher is better." : ""}`}
                      columns={["Date", `Value (${k.metric.unit})`]}
                      rows={k.points.map((p) => [p.date, p.value === null ? null : p.value.toFixed(d)])}
                    >
                      <TrendChart data={k.points.map((p) => ({ x: p.date, value: p.value }))} series={[{ key: "value", label: k.metric.name }]} unit={k.metric.unit} digits={d} height={170} refLines={k.target ? [{ y: k.target.value, label: "Target" }] : []} />
                    </ChartFigure>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Strength" kicker="Best recorded max per lift" />
          <CardBody>
            {s.strength.length === 0 ? (
              <p className="text-sm text-ink-3">No maxes recorded.</p>
            ) : (
              <Table caption="Strength maxes">
                <thead>
                  <tr>
                    <Th>Exercise</Th>
                    <Th align="right">Best</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.strength.map((x) => (
                    <tr key={x.exercise}>
                      <Td>
                        <span className="font-semibold">{x.exercise}</span> {x.prInPeriod ? <PrBadge className="ml-1" /> : null}
                      </Td>
                      <Td align="right">
                        <strong className="text-lg">{x.best.value}</strong> <span className="text-xs">{x.best.unit}</span>
                        <div className="text-[11px] text-ink-3">{x.best.method}</div>
                      </Td>
                      <Td>{x.best.date}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Habits" kicker="Last 28 days" />
          <CardBody>
            {s.habits.length === 0 ? (
              <p className="text-sm text-ink-3">No habits assigned.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {s.habits.map((h) => (
                  <li key={h.habit.id}>
                    <span className="font-medium">{h.habit.name}</span>: {h.adherence.adherencePct === null ? "—" : `${n(h.adherence.adherencePct, 0)}%`} adherence · streak {h.streak}
                    {h.adherence.adherencePct !== null ? <ProgressBar done={h.adherence.adherencePct} total={100} size="sm" className="my-1" /> : null}
                    <div className="text-xs text-ink-3">
                      {h.adherence.done} done · {h.adherence.partial} partial · {h.adherence.missed} missed · {h.adherence.noCheckin} no check-in
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {canSeeHealth && s.health ? (
          <Card className="lg:col-span-2">
            <CardHeader title="Wellness & body map" kicker="Visible only with health access" />
            <CardBody className="space-y-3 text-sm">
              <p>
                {s.health.checkins} check-ins in the last {s.health.days} days. Mean Teamwork readiness (tw_readiness_v1): {n(s.health.readinessMean, 0)}/100.
              </p>
              <p className="text-xs text-ink-3">{BODY_MAP_DISCLAIMER}</p>
              {s.health.recentBody.length ? (
                <ul className="space-y-1">
                  {s.health.recentBody.slice(0, 8).map((b) => (
                    <li key={b.id}>
                      {fmt(b.reportedAt, "MMM d")} · {regionLabel(b.region, b.side)} · {b.kind} {b.severity}/10 · <span className="text-ink-3">{b.reviewStatus.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-3">No body-map reports in the last 28 days.</p>
              )}
            </CardBody>
          </Card>
        ) : null}
        <Card className="lg:col-span-2">
          <CardHeader title="Progress reports" kicker="Coach-reviewed and shared" />
          <CardBody>
            {s.reports.length === 0 ? (
              <EmptyState title="No shared reports yet." />
            ) : (
              <div className="space-y-3">
                {s.reports.map((r, i) => {
                  const c = r.content as ReportContent;
                  // Wellness only if the report includes it AND this viewer has health access.
                  const showWellness = c.sections.wellness && r.includeWellness && canSeeHealth;
                  return (
                    <details key={r.id} open={i === 0} className="rounded-lg border border-edge p-3">
                      <summary className="cursor-pointer font-medium">
                        {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                      </summary>
                      <div className="mt-3">
                        <ReportBody snapshot={{ ...c.snapshot, wellness: showWellness ? c.snapshot.wellness : null }} sections={{ ...c.sections, wellness: showWellness }} summary={r.coachSummary} />
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
      {!canSeeHealth ? (
        <Callout className="mt-6">Wellness and body-map details aren’t shown because your account doesn’t have health access for this athlete.</Callout>
      ) : null}
    </>
  );
}
