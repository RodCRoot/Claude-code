/**
 * Accessible chart wrapper: title, units, date range, a plain-text summary, and an
 * expandable data table (the chart itself is aria-hidden; the table is the accessible view).
 */
export function ChartFigure({
  title,
  unit,
  range,
  summary,
  legend,
  columns,
  rows,
  children,
  note,
}: {
  title: string;
  unit: string;
  range?: string;
  summary: React.ReactNode;
  legend?: { label: string; slot: number; kind?: "line" | "rect" }[];
  columns: string[];
  rows: (string | number | null)[][];
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  const sw = ["bg-[#2a78d6] dark:bg-[#3987e5]", "bg-[#eb6834] dark:bg-[#d95926]", "bg-[#1baf7a] dark:bg-[#199e70]"];
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-ink-3">
          Unit: {unit}
          {range ? <> · {range}</> : null}
        </div>
      </figcaption>
      {legend && legend.length > 1 ? (
        <ul className="mb-1 flex flex-wrap gap-3 text-xs text-ink-2" aria-label="Legend">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden className={`${sw[l.slot % 3]} ${l.kind === "rect" ? "size-2.5 rounded-sm" : "h-0.5 w-4 rounded"}`} />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      {children}
      <p className="mt-2 text-sm text-ink-2">{summary}</p>
      {note ? <p className="mt-1 text-xs text-ink-3">{note}</p> : null}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-ink-3 hover:text-ink">Show data table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-edge" tabIndex={0} role="region" aria-label={`${title} data`}>
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{title} data</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col" className="sticky top-0 border-b border-edge bg-surface-2 px-2 py-1.5 text-left font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b border-edge/60 px-2 py-1 tabular">
                      {c === null || c === "" ? <span className="text-ink-3">—</span> : c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
