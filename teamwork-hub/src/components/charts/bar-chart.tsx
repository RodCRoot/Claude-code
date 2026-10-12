"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtValue, seriesColor, useVizTheme } from "./theme";

/** Single-series column chart (e.g. daily load in AU). Null = no bar (unknown), never 0. */
export function ColumnChart({ data, unit, label, height = 200, digits = 0 }: { data: { x: string; y: number | null }[]; unit: string; label: string; height?: number; digits?: number }) {
  const t = useVizTheme();
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }} barCategoryGap={2}>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="x" tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={20} tickFormatter={(d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : d)} />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v))} />
          <Tooltip cursor={{ fill: t.grid, fillOpacity: 0.4 }} contentStyle={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, fontSize: 12, color: t.ink }} formatter={(v) => [fmtValue(typeof v === "number" ? v : null, digits, unit), label]} />
          <Bar dataKey="y" name={label} fill={seriesColor(t, 0)} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
