import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getScoreboard } from "@/lib/kpi";
import { resolvePeriod, type PeriodKind } from "@/lib/periods";
import { GROUP_LABELS } from "@/lib/metric-catalog";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader, Input, Button } from "@/components/ui";
import { cn } from "@/lib/cn";

export const metadata = { title: "Executive Scoreboard" };

const PERIODS: { key: PeriodKind; label: string }[] = [
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
  { key: "quarterly", label: "Quarter" },
  { key: "ytd", label: "YTD" },
  { key: "custom", label: "Custom" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ScoreboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>;
}) {
  const user = await requireUser("view_dashboard");
  const sp = await searchParams;
  const kind: PeriodKind = (PERIODS.find((p) => p.key === sp.period)?.key ?? "weekly") as PeriodKind;
  const custom =
    kind === "custom" && sp.start && sp.end && DATE_RE.test(sp.start) && DATE_RE.test(sp.end)
      ? { start: sp.start, end: sp.end }
      : undefined;
  const period = resolvePeriod(kind === "custom" && !custom ? "monthly" : kind, new Date(), custom);
  const includeSensitive = user.permissions.includes("view_financials");
  const groups = getScoreboard(period, includeSensitive);

  const exportHref = `/api/export/scoreboard?period=${period.kind}${
    custom ? `&start=${custom.start}&end=${custom.end}` : ""
  }`;

  return (
    <>
      <PageHeader
        kicker="Executive Scoreboard"
        title={period.label}
        subtitle="Every number links to the records behind it. Hover a metric name for its definition."
        actions={
          <div className="no-print flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-edge">
              {PERIODS.map((p) => (
                <Link
                  key={p.key}
                  href={`/scoreboard?period=${p.key}`}
                  className={cn(
                    "px-3 py-1.5 text-xs font-semibold",
                    kind === p.key
                      ? "bg-brand-600 text-white"
                      : "bg-surface-2 text-ink-2 hover:bg-surface-3"
                  )}
                >
                  {p.label}
                </Link>
              ))}
            </div>
            <a
              href={exportHref}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface-3"
            >
              Export CSV
            </a>
          </div>
        }
      />

      {kind === "custom" && (
        <form method="get" action="/scoreboard" className="no-print mb-6 flex flex-wrap items-end gap-2">
          <input type="hidden" name="period" value="custom" />
          <div>
            <label className="kicker mb-1 block">From</label>
            <Input type="date" name="start" defaultValue={custom?.start ?? period.start} className="w-40" />
          </div>
          <div>
            <label className="kicker mb-1 block">To</label>
            <Input type="date" name="end" defaultValue={custom?.end ?? period.end} className="w-40" />
          </div>
          <Button size="md" type="submit">Apply</Button>
        </form>
      )}

      {Object.entries(GROUP_LABELS).map(([groupKey, label]) => {
        const results = groups[groupKey];
        if (!results || results.length === 0) return null;
        const reds = results.filter((r) => r.status === "red").length;
        return (
          <section key={groupKey} className="mb-8">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-lg font-bold tracking-tight">{label}</h2>
              {reds > 0 ? (
                <span className="rounded-full bg-bad/10 px-2 py-0.5 text-[11px] font-bold text-bad">
                  {reds} behind
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {results.map((r) => (
                <KpiCard key={r.metric.key} result={r} />
              ))}
            </div>
          </section>
        );
      })}

      {!includeSensitive && (
        <p className="mt-2 text-xs text-ink-3">
          Financial metrics are hidden for your role. An administrator can grant
          “View financials” in Admin → Users &amp; Roles.
        </p>
      )}
      <p className="mt-6 text-xs text-ink-3">
        Add or edit metrics, goals, and thresholds in{" "}
        <Link href="/admin/metrics" className="underline">Admin → Metric Dictionary</Link>.
      </p>
    </>
  );
}
