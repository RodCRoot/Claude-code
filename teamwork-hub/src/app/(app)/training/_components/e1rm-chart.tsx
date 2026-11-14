"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { date: string; e1rm?: number | null; max?: number | null; detail?: string };

/**
 * Best e1RM per session (Epley v1) with recorded maxes overlaid, single unit only.
 * Labeled with units and date range; a data table follows for screen readers.
 */
export function E1rmChart({ points, unit, lift, from, to }: { points: Point[]; unit: string; lift: string; from: string; to: string }) {
  const title = `${lift}: estimated 1RM and recorded maxes (${unit}), ${from} to ${to}`;
  if (!points.length) return <p className="text-sm text-ink-3">No {unit} data for {lift} in this date range.</p>;
  return (
    <figure aria-label={title}>
      <figcaption className="mb-2 text-sm font-medium text-ink-2">{title}</figcaption>
      <div className="h-64 w-full" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={points} margin={{ top: 8, right: 12, bottom: 24, left: 8 }}>
            <CartesianGrid stroke="var(--edge)" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--ink-3)" }} label={{ value: "Date", position: "insideBottom", offset: -16, fill: "var(--ink-3)", fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--ink-3)" }} domain={[(min: number) => Math.floor((min - 10) / 5) * 5, (max: number) => Math.ceil((max + 10) / 5) * 5]} width={56} label={{ value: unit, angle: -90, position: "insideLeft", fill: "var(--ink-3)", fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--edge)", borderRadius: 8, color: "var(--ink)" }}
              formatter={(v, name) => [`${v} ${unit}`, name]}
            />
            <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="e1rm" name="Best e1RM (Epley v1)" stroke="var(--brand)" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            <Line type="stepAfter" dataKey="max" name="Recorded max" stroke="var(--ok)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 4 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-xs">
        <summary className="min-h-11 cursor-pointer py-2 text-ink-3">Show data table</summary>
        <table className="w-full text-left">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Best e1RM ({unit})</th>
              <th scope="col">Set</th>
              <th scope="col">Recorded max ({unit})</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <td>{p.date}</td>
                <td className="tabular">{p.e1rm ?? "—"}</td>
                <td>{p.detail ?? ""}</td>
                <td className="tabular">{p.max ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
