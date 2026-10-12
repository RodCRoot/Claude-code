"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { seriesColor, useVizTheme } from "./theme";

/** Raw force-time trace: left and right plate channels (N) vs time (s). One axis, two series. */
export function ForceTraceChart({ points, height = 260 }: { points: { t: number; left: number | null; right: number | null }[]; height?: number }) {
  const t = useVizTheme();
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={t.grid} vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} tickFormatter={(v: number) => `${v.toFixed(1)} s`} />
          <YAxis tick={{ fill: t.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => `${Math.round(v)}`} />
          <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, fontSize: 12, color: t.ink }} labelFormatter={(v) => `t = ${Number(v).toFixed(3)} s`} formatter={(v, n) => [`${typeof v === "number" ? v.toFixed(1) : "—"} N`, String(n)]} />
          <Line type="linear" dataKey="left" name="Left plate" stroke={seriesColor(t, 0)} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          <Line type="linear" dataKey="right" name="Right plate" stroke={seriesColor(t, 1)} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
