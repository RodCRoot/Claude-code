/** Value formatting shared by report charts (client) and their data tables (server). */
export type ReportChartUnit = "count" | "usd_minor" | "pct";

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const fullUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function fmtChartValue(v: unknown, unit: ReportChartUnit, compact = false): string {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return "—";
  const num = Number(v);
  if (unit === "usd_minor") return compact ? compactUsd.format(num / 100) : fullUsd.format(num / 100);
  if (unit === "pct") return `${Math.round(num * (compact ? 100 : 1000)) / (compact ? 1 : 10)}%`;
  return compact && Math.abs(num) >= 1000 ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(num) : num.toLocaleString("en-US");
}

