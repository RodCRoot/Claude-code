import { db } from "@/db";
import { ChartFigure } from "@/components/charts/chart-figure";
import { ReportBarChart } from "@/components/charts/report-chart";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DefinitionsDrawer, ExportLink, FilterBar, MonthsSelect, ScoreboardTabs, scoreboardQs } from "@/components/scoreboard/shell";
import { ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader, Stat } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { BOTTLENECK_RULES, monthlyScoreboard, type MonthlyRowDef } from "@/lib/scoreboard/monthly";
import { saveTargetsAction } from "../actions";
import { loadScoreboard, type ScoreboardSearch } from "../_load";

export const metadata = { title: "Monthly scoreboard" };

function cell(def: MonthlyRowDef, x: number | null) {
  if (x == null) return null;
  if (def.kind === "pct") return `${Math.round(x * 1000) / 10}%`;
  if (def.kind === "money") return formatMoney(x);
  return x.toLocaleString("en-US");
}

/** Compare a value with the row's ideal in words (never colour alone). */
function versus(def: MonthlyRowDef, x: number | null, ideal: number | undefined): string | null {
  if (x == null || ideal == null) return null;
  const target = def.kind === "pct" ? ideal / 100 : def.kind === "money" ? ideal * 100 : ideal;
  const met = def.better === "higher" ? x >= target : x <= target;
  return met ? "at ideal" : def.better === "higher" ? "under ideal" : "over ideal";
}

export default async function MonthlyScoreboardPage({ searchParams }: { searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, locations, programs, months, q, canManage } = await loadScoreboard(searchParams);
  const mo = await monthlyScoreboard(db, v, c, { months });
  const qm = { ...q, months };
  const lastFull = mo.bottleneckMonth;
  const current = mo.months[mo.months.length - 1];
  const b = mo.bottleneck;
  const chartData = mo.months.map((m) => ({ x: m.month, label: m.partial ? `${m.label}*` : m.label, sold: m.values.sold, lost: m.values.lost }));
  const netText = (n: number | null | undefined) => (n == null ? "n/a" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`);
  const table = (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Monthly scoreboard">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">Monthly scoreboard by month with the ideal for each row</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 border-b border-edge bg-th px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Row
            </th>
            <th scope="col" className="border-b border-edge bg-th px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              Ideal
            </th>
            {mo.months.map((m) => (
              <th key={m.month} scope="col" className="border-b border-edge bg-th px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-ink-2">
                {m.label}
                {m.partial ? <span className="block font-medium normal-case">to date</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {mo.rows.map((def) => {
            const strong = def.key === "net_growth";
            return (
              <tr key={def.key} className={strong ? "bg-surface-2 font-semibold" : undefined} data-row={def.key}>
                <th scope="row" className={`sticky left-0 z-10 border-b border-edge/70 px-3 py-2 text-left font-medium ${strong ? "bg-surface-2 font-bold" : "bg-surface"} ${def.sub ? "pl-7 text-ink-2" : ""}`}>
                  {def.label}
                </th>
                <td className="border-b border-edge/70 px-3 py-1.5">
                  {def.noTarget ? (
                    <span className="text-xs text-ink-3">no ideal</span>
                  ) : canManage ? (
                    <span className="flex items-center gap-1">
                      <input
                        name={`target_${def.key}`}
                        aria-label={`Ideal for ${def.label}${def.kind === "pct" ? " (percent)" : def.kind === "money" ? " (dollars)" : ""}`}
                        defaultValue={mo.targets[def.key] ?? ""}
                        inputMode="decimal"
                        className="h-8 w-20 rounded-md border border-edge bg-surface px-2 text-right text-sm tabular"
                      />
                      <span className="text-xs text-ink-3">{def.kind === "pct" ? "%" : def.kind === "money" ? "$" : ""}</span>
                    </span>
                  ) : (
                    <span className="tabular">{mo.targets[def.key] == null ? <span className="text-xs text-ink-3">not set</span> : `${def.kind === "money" ? "$" : ""}${mo.targets[def.key]}${def.kind === "pct" ? "%" : ""}`}</span>
                  )}
                </td>
                {mo.months.map((m) => {
                  const x = m.values[def.key];
                  const vs = m.partial ? null : versus(def, x, mo.targets[def.key]);
                  return (
                    <td key={m.month} className="border-b border-edge/70 px-3 py-2 text-right align-top tabular">
                      {mo.na[def.key] ? (
                        <span className="text-xs text-ink-3">n/a with filter</span>
                      ) : x == null ? (
                        <span className="text-xs text-ink-3">{def.key === "at_risk" ? "not recorded" : "none"}</span>
                      ) : (
                        <>
                          {def.key === "net_growth" ? netText(x) : cell(def, x)}
                          {vs ? <span className={`block text-[11px] font-normal ${vs === "at ideal" ? "text-ink-3" : "font-semibold text-ink"}`}>{vs}</span> : null}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <PageHeader
        kicker="Owner scoreboard"
        title="Monthly funnel"
        description="Leads to consults to sales to clients to retention, month by month, against the ideal you set for each row."
        actions={
          <ButtonLink href={`/api/scoreboard/monthly${scoreboardQs(qm)}`} variant="secondary" download>
            Export CSV
          </ButtonLink>
        }
      />
      <ScoreboardTabs current="monthly" q={q} />
      <FilterBar action="/scoreboard/monthly" locations={locations} programs={programs} q={q}>
        <MonthsSelect value={months} />
      </FilterBar>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={`Net growth, ${lastFull?.label ?? "last month"}`}
          value={netText(lastFull?.values.net_growth)}
          hint={lastFull ? `${lastFull.values.sold} sold minus ${lastFull.values.lost} lost` : undefined}
          tone={lastFull?.values.net_growth == null ? undefined : lastFull.values.net_growth > 0 ? "ok" : lastFull.values.net_growth < 0 ? "bad" : undefined}
        />
        <Stat label={`Net growth, ${current.label} to date`} value={netText(current.values.net_growth)} hint={`${current.values.sold} sold minus ${current.values.lost} lost`} />
        <Stat label="Active clients now" value={current.values.active ?? "n/a"} hint={current.values.on_hold != null ? `${current.values.on_hold} on hold` : undefined} />
        <Stat label="Plan changes this month" value={current.values.plan_changes ?? "n/a"} hint="Not losses, not sales" />
      </div>

      <Card className="mb-5">
        <CardHeader title="Where is the bottleneck?" kicker={lastFull ? `Rule of thumb, read on ${lastFull.label} (last complete month)` : "Rule of thumb"} />
        <CardBody className="space-y-3 pt-0">
          <p className="text-lg font-semibold" data-testid="bottleneck-headline">
            {b.headline}
          </p>
          <p className="text-sm text-ink-2" data-testid="bottleneck-rule">
            {b.rule}
          </p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {b.steps.map((s) => (
              <li key={s.key} className="rounded-md border border-edge px-3 py-2">
                <div className="kicker">{s.label}</div>
                <div className="tabular">
                  {s.actual ?? "n/a"} <span className="text-ink-3">/ ideal {s.target ?? "not set"}</span>
                </div>
                <div className="text-xs text-ink-2">{s.status === "met" ? "At ideal" : s.status === "short" ? "Under ideal" : s.status === "no_target" ? "No ideal set: skipped" : "No value: skipped"}</div>
              </li>
            ))}
          </ul>
          <Callout tone="warn" title="Only a rule of thumb">
            This read-out applies the fixed rules below to one month and reports the first step that is short. It does not know about seasons, one-off events or small numbers. Treat it as a place to start looking.
          </Callout>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-ink-3">All rules, in order</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-2">
              {BOTTLENECK_RULES.map((r) => (
                <li key={r.stage}>{r.rule}</li>
              ))}
            </ol>
          </details>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader title="Month by month" kicker="Ideal = your target for a full month" action={<ExportLink table="monthly" q={qm} />} />
        <CardBody className="pt-0">
          {canManage ? (
            <ActionForm action={saveTargetsAction} className="space-y-3">
              {table}
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton>Save ideals</SubmitButton>
                <span className="text-xs text-ink-3">Leave a box empty for no ideal. Percent rows take a number such as 60. Changes are audited.</span>
              </div>
            </ActionForm>
          ) : (
            table
          )}
        </CardBody>
      </Card>

      {!mo.na.sold ? (
        <Card className="mb-5">
          <CardBody className="pt-4">
            <ChartFigure
              title="New memberships sold and real losses"
              unit="Memberships per month"
              range={`${mo.months[0].label} to ${current.label}`}
              summary={`Net growth over these ${mo.months.length} months: ${netText(mo.months.reduce((s, m) => s + (m.values.net_growth ?? 0), 0))} (sold minus lost; plan changes are on neither side).`}
              note={`* ${current.label} is month to date.`}
              legend={[
                { label: "Sold", slot: 0, kind: "rect" },
                { label: "Lost", slot: 1, kind: "rect" },
              ]}
              columns={["Month", "Sold", "Lost"]}
              rows={chartData.map((d) => [d.label, d.sold, d.lost])}
            >
              <ReportBarChart
                data={chartData}
                series={[
                  { key: "sold", label: "Sold" },
                  { key: "lost", label: "Lost" },
                ]}
                unit="count"
                layout="grouped"
              />
            </ChartFigure>
          </CardBody>
        </Card>
      ) : null}

      <DefinitionsDrawer tab="monthly" />
    </>
  );
}
