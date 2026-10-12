import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import type { MetricSeries } from "@/lib/science/kpis";
import { SourceBadge, fmtN } from "./shared";

export function MetricCard({ s, from, to }: { s: MetricSeries; from: string; to: string }) {
  const d = s.metric.precision;
  const u = s.metric.unit;
  const refLines = [...(s.baseline ? [{ y: s.baseline.value, label: `Baseline ${s.baseline.value.toFixed(d)}` }] : []), ...(s.target ? [{ y: s.target.value, label: `Target ${s.target.value.toFixed(d)}` }] : [])];
  const band = s.swc !== null && s.baseline ? { y1: s.baseline.value - s.swc, y2: s.baseline.value + s.swc, label: "SWC band" } : null;
  const converted = [...new Set(s.points.flatMap((p) => p.convertedFromUnits))];
  const cls = { improved: ["green", "Improved beyond SWC"], declined: ["red", "Declined beyond SWC"], within_swc: ["neutral", "Within SWC"], unknown: ["neutral", "Change not classifiable"] } as const;
  return (
    <Card>
      <CardHeader title={s.metric.name} kicker={`${s.metric.category.replace("_", " ")} · ${u}${s.metric.higherIsBetter === null ? "" : s.metric.higherIsBetter ? " · higher is better" : " · lower is better"}`} action={<SourceBadge source={s.metric.definedBy} />} />
      <CardBody className="space-y-3">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-ink-3">Latest</dt>
            <dd className="text-lg font-bold tabular">{s.latest ? `${fmtN(s.latest.value, d)} ${u}` : "—"}</dd>
            <dd className="text-xs text-ink-3">{s.latest?.date ?? "no value"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Baseline</dt>
            <dd className="text-lg font-bold tabular">{s.baseline ? `${s.baseline.value.toFixed(d)}` : "—"}</dd>
            <dd className="text-xs text-ink-3">{s.baseline ? (s.baseline.source === "target" ? `set ${s.baseline.date ?? ""}` : `first session ${s.baseline.date}`) : ""}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Target</dt>
            <dd className="text-lg font-bold tabular">{s.target ? s.target.value.toFixed(d) : "—"}</dd>
            <dd className="text-xs text-ink-3">{s.target ? `${s.target.scope}${s.target.goalDate ? ` · by ${s.target.goalDate}` : ""}` : ""}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={cls[s.classification][0]}>{cls[s.classification][1]}</Badge>
          <span className="text-ink-3">
            Change {s.change === null ? "—" : `${s.change > 0 ? "+" : ""}${s.change.toFixed(d)} ${u}`} ({s.changePct === null ? "—" : `${s.changePct > 0 ? "+" : ""}${s.changePct.toFixed(1)}%`}) · SWC ±{fmtN(s.swc, d)} {s.swc === null ? "(needs ≥ 3 sessions)" : u}
          </span>
        </div>
        <ChartFigure
          title={`${s.metric.name} by session`}
          unit={u}
          range={`${from} – ${to}`}
          summary={`${s.points.length} session(s); ${s.points.filter((x) => x.value === null).length} without a usable value. Rule per session: ${[...new Set(s.points.map((x) => x.rule))].join(", ") || "—"}.`}
          note={converted.length ? `Some trials were entered in ${converted.join(", ")} and converted to ${u} explicitly (1 in = 2.54 cm; 1 lb = 0.45359237 kg).` : undefined}
          columns={["Date", "Test", "Selected", "Trials used", "Vendor aggregate (not averaged in)", "Trial values (entered unit)"]}
          rows={s.points.map((x) => [
            x.date,
            x.testTypeName,
            x.value === null ? null : `${x.value.toFixed(d)} ${u}`,
            x.n,
            x.vendorAggregate === null ? null : `${x.vendorAggregate.toFixed(d)} ${u}`,
            x.trials
              .filter((t) => !t.isAggregate)
              .map((t) => `#${t.trialNumber ?? "?"}: ${t.value === null ? "null" : `${t.value} ${t.enteredUnit}`}${t.excluded ? " (excluded)" : ""}`)
              .join("; "),
          ])}
        >
          <TrendChart data={s.points.map((x) => ({ x: x.date, value: x.value }))} series={[{ key: "value", label: s.metric.name }]} unit={u} digits={d} refLines={refLines} band={band} />
        </ChartFigure>
      </CardBody>
    </Card>
  );
}

