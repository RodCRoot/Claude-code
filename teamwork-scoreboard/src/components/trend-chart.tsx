"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

export interface TrendPoint {
  label: string;
  value: number | null;
  goal?: number | null;
}

export function TrendChart({
  data,
  goal,
  unit,
}: {
  data: TrendPoint[];
  goal?: number | null;
  unit?: string;
}) {
  const fmt = (v: number) =>
    unit === "currency"
      ? `$${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}`
      : unit === "percent"
      ? `${Math.round(v)}%`
      : String(Math.round(v * 10) / 10);

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--edge)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--ink-3)" }}
            axisLine={{ stroke: "var(--edge)" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--ink-3)" }}
            tickFormatter={fmt}
            axisLine={false}
            tickLine={false}
            width={54}
          />
          <Tooltip
            formatter={(v) => [fmt(Number(v)), "Actual"]}
            contentStyle={{
              background: "var(--surface-2)",
              border: "1px solid var(--edge)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--ink)",
            }}
          />
          {goal !== null && goal !== undefined ? (
            <ReferenceLine
              y={goal}
              stroke="var(--color-warn, #d97706)"
              strokeDasharray="6 4"
              label={{ value: "Goal", fontSize: 10, fill: "var(--ink-3)", position: "right" }}
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="value"
            stroke="#d21f36"
            strokeWidth={2.5}
            dot={{ r: 3, fill: "#d21f36" }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
