import { requireApiUser } from "@/lib/auth";
import { getScoreboard } from "@/lib/kpi";
import { resolvePeriod, type PeriodKind } from "@/lib/periods";
import { GROUP_LABELS } from "@/lib/metric-catalog";

/** CSV export of the executive scoreboard for the requested period. */
export async function GET(req: Request) {
  const auth = await requireApiUser("view_dashboard");
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const kind = (url.searchParams.get("period") ?? "weekly") as PeriodKind;
  const custom =
    kind === "custom"
      ? {
          start: url.searchParams.get("start") ?? "",
          end: url.searchParams.get("end") ?? "",
        }
      : undefined;
  const period = resolvePeriod(kind, new Date(), custom);
  const includeSensitive = auth.user.permissions.includes("view_financials");
  const groups = getScoreboard(period, includeSensitive);

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ["Group", "Metric", "Actual", "Goal", "Diff", "% of goal", "Previous", "Status", "Source"].join(","),
  ];
  for (const [groupKey, results] of Object.entries(groups)) {
    for (const r of results) {
      lines.push(
        [
          GROUP_LABELS[groupKey] ?? groupKey,
          r.metric.name,
          r.value ?? "",
          r.goal ?? "",
          r.diff ?? "",
          r.attainment ?? "",
          r.previous ?? "",
          r.status,
          r.source,
        ]
          .map(esc)
          .join(",")
      );
    }
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="scoreboard-${period.start}-${period.end}.csv"`,
    },
  });
}
