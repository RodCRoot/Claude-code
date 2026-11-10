"use client";

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useVizTheme } from "./theme";

export type StackedLoadSeries = { key: string; label: string };
export type StackedLoadDatum = { x: string; total: number | null } & Record<string, number | string | null>;

/**
 * Weekly load stacked by origin (gym / sport / on your own). Decorative for assistive tech: the
 * ChartFigure around it carries the summary and the data table. Series are told apart by the
 * written legend, the tooltip names and the fixed stacking order (legend order = bottom to top),
 * not by color alone; the week total is printed above each stack.
 */
export function StackedLoadChart({ data, series, height = 240 }: { data: StackedLoadDatum[]; series: StackedLoadSeries[]; height?: number }) {
  const t = useVizTheme();
  const colors = [t.s1, t.s2, t.s3, t.muted];
  return (
    <div>
      <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend, bottom of each bar to top">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: colors[i % colors.length] }} />
            {i + 1}. {s.label}
          </li>
        ))}
      </ul>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={data} margin={{ top: 18, right: 8, bottom: 4, left: 4 }} barCategoryGap="22%">
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis dataKey="x" tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} tickFormatter={(d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d)} />
            <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v))} />
            <Tooltip
              cursor={{ fill: t.grid, fillOpacity: 0.4 }}
              contentStyle={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, fontSize: 12, color: t.ink }}
              labelFormatter={(l) => `Week of ${String(l)}`}
              formatter={(v, name) => [`${typeof v === "number" ? Math.round(v) : "0"} AU`, String(name)]}
            />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} stackId="load" fill={colors[i % colors.length]} stroke={t.surface} strokeWidth={1} maxBarSize={44} isAnimationActive={false}>
                {i === series.length - 1 ? <LabelList dataKey="total" position="top" fill={t.ink} fontSize={11} formatter={(v) => (typeof v === "number" ? String(Math.round(v)) : "")} /> : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
