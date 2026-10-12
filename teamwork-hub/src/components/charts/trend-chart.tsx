"use client";

import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtValue, seriesColor, useVizTheme } from "./theme";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export type TrendSeries = { key: string; label: string };
export type TrendDatum = { x: string } & Record<string, number | string | null>;

/**
 * Single-axis line chart. Null values render as gaps (missing data is never drawn as 0).
 * Optional reference lines (baseline/target) and a band (e.g. SWC). Always paired with a
 * text summary + table by <ChartFigure>.
 */
export function TrendChart({
  data,
  series,
  unit,
  digits = 2,
  height = 220,
  refLines = [],
  band,
  yDomain,
}: {
  data: TrendDatum[];
  series: TrendSeries[];
  unit: string;
  digits?: number;
  height?: number;
  refLines?: { y: number; label: string }[];
  band?: { y1: number; y2: number; label: string } | null;
  yDomain?: [number | "auto", number | "auto"];
}) {
  const t = useVizTheme();
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="x" tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={24} tickFormatter={(d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d)} />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={48} domain={yDomain ?? ["auto", "auto"]} tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? compact.format(v) : String(Number(v.toFixed(digits))))} />
          {band ? <ReferenceArea y1={band.y1} y2={band.y2} fill={t.band} fillOpacity={0.1} stroke="none" ifOverflow="extendDomain" /> : null}
          {refLines.map((r, i) => (
            <ReferenceLine key={r.label} y={r.y} stroke={i === 0 ? t.axis : t.muted} strokeWidth={1} ifOverflow="extendDomain" label={{ value: r.label, position: "insideTopRight", fill: t.axis, fontSize: 10 }} />
          ))}
          <Tooltip
            cursor={{ stroke: t.axis, strokeWidth: 1 }}
            contentStyle={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, fontSize: 12, color: t.ink }}
            formatter={(v, name) => [fmtValue(typeof v === "number" ? v : null, digits, unit), String(name)]}
          />
          {series.map((s, i) => (
            <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={seriesColor(t, i)} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: t.surface, fill: seriesColor(t, i) }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
