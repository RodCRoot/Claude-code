import Link from "next/link";
import type { KpiResult } from "@/lib/kpi";
import { formatValue } from "@/lib/calc";
import { StatusDot, Progress, Tooltip } from "@/components/ui";
import { cn } from "@/lib/cn";

export function KpiCard({ result }: { result: KpiResult }) {
  const { metric, value, goal, attainment, status, trendPct, source, lastUpdated } = result;
  const trendUp = trendPct !== null && trendPct > 0;
  const trendDown = trendPct !== null && trendPct < 0;
  const trendGood =
    trendPct === null ? null : metric.direction === "up" ? trendPct >= 0 : trendPct <= 0;

  return (
    <Link
      href={`/scoreboard/${metric.key}`}
      className="group block rounded-xl border border-edge bg-surface-2 p-4 transition-colors hover:border-brand-600/60"
    >
      <div className="flex items-start justify-between gap-2">
        <Tooltip
          content={
            <>
              <span className="block font-semibold">{metric.name}</span>
              <span className="mt-1 block">{metric.definition ?? "No definition"}</span>
              {metric.formula ? (
                <span className="mt-1 block opacity-80">Formula: {metric.formula}</span>
              ) : null}
            </>
          }
        >
          <span className="text-[13px] font-semibold leading-snug text-ink-2 group-hover:text-ink">
            {metric.name}
          </span>
        </Tooltip>
        <StatusDot status={status} className="mt-0.5 shrink-0" />
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="stat-figure text-[28px] font-bold leading-none">
          {formatValue(value, metric.unit, { compact: true })}
        </span>
        {trendPct !== null && (
          <span
            className={cn(
              "text-xs font-semibold",
              trendGood ? "text-ok" : "text-bad"
            )}
            title="vs previous period"
          >
            {trendUp ? "▲" : trendDown ? "▼" : "—"} {Math.abs(trendPct)}%
          </span>
        )}
      </div>

      <div className="mt-2">
        <Progress pct={attainment} status={status} />
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-3">
          <span>
            Goal {formatValue(goal, metric.unit, { compact: true })}
            {attainment !== null ? ` · ${Math.round(attainment)}%` : ""}
          </span>
          <span>
            Prev {formatValue(result.previous, metric.unit, { compact: true })}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-ink-3/80">
          <span className="truncate" title={source}>{source}</span>
          <span title={lastUpdated ?? undefined}>
            {lastUpdated ? `upd ${lastUpdated.slice(5, 10)}` : ""}
          </span>
        </div>
      </div>
    </Link>
  );
}
