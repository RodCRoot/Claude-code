"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { seriesColor, useVizTheme } from "./theme";
import { fmtChartValue, type ReportChartUnit } from "./format";

type Datum = { x: string; label: string } & Record<string, number | string | null>;

/**
 * Column / bar chart for reports. Visual only (aria-hidden): <ChartFigure> carries the title,
 * unit, range, text summary and the data table. Colors follow the shared validated palette;
 * stacked segments are separated by a 2px surface gap, bars are capped at 24px.
 */
export function ReportBarChart({
  data,
  series,
  unit,
  layout,
  height,
}: {
  data: Datum[];
  series: { key: string; label: string }[];
  unit: ReportChartUnit;
  layout: "stacked" | "grouped" | "bars";
  height?: number;
}) {
  const t = useVizTheme();
  const horizontal = layout === "bars";
  const h = height ?? (horizontal ? Math.max(120, data.length * 36 + 40) : 240);
  const tooltip = (
    <Tooltip
      cursor={{ fill: t.grid, fillOpacity: 0.4 }}
      contentStyle={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, fontSize: 12, color: t.ink }}
      itemStyle={{ color: t.ink }}
      labelFormatter={(_l, p) => String((p?.[0]?.payload as Datum | undefined)?.label ?? _l)}
      formatter={(v, name) => [fmtChartValue(v, unit), String(name)]}
    />
  );
  const valueAxis = {
    tick: { fill: t.axis, fontSize: 11 },
    tickLine: false,
    axisLine: false,
    tickFormatter: (v: number) => fmtChartValue(v, unit, true),
    allowDecimals: unit !== "count",
    domain: unit === "pct" ? ([0, (max: number) => Math.max(1, max)] as [number, (m: number) => number]) : ([0, "auto"] as [number, "auto"]),
  };
  const categoryAxis = {
    dataKey: "label",
    tick: { fill: t.axis, fontSize: 11 },
    tickLine: false,
    axisLine: { stroke: t.grid },
  };
  return (
    <div style={{ height: h }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        {horizontal ? (
          <BarChart accessibilityLayer={false} data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barCategoryGap={8}>
            <CartesianGrid stroke={t.grid} horizontal={false} />
            <XAxis type="number" {...valueAxis} />
            <YAxis type="category" {...categoryAxis} width={120} interval={0} />
            {tooltip}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesColor(t, i)} maxBarSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        ) : (
          <BarChart accessibilityLayer={false} data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }} barCategoryGap="20%" barGap={2}>
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis {...categoryAxis} minTickGap={12} />
            <YAxis {...valueAxis} width={unit === "usd_minor" ? 56 : 44} />
            {tooltip}
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={seriesColor(t, i)}
                stackId={layout === "stacked" ? "a" : undefined}
                stroke={layout === "stacked" ? t.surface : undefined}
                strokeWidth={layout === "stacked" ? 2 : 0}
                maxBarSize={24}
                radius={layout === "stacked" && i < series.length - 1 ? 0 : [4, 4, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
