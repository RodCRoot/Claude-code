import type { Tx } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import type { ReportColumn } from "@/lib/reports";
import type { Ctx } from "./core";
import { dailyMetric, dailyScoreboard, metricRows } from "./daily";
import { payrollByMonth, slotUtilisation } from "./efficiency";
import { marketingEconomics } from "./marketing";
import { EXPENSE_LABEL, marginView, moneyView, type Pivot } from "./money";
import { monthlyScoreboard } from "./monthly";

/**
 * Every scoreboard table as plain columns + rows, for the CSV export route. The pages render the
 * same data their own way; exports never compute anything the page does not show.
 */
export type ExportTable = { name: string; columns: ReportColumn[]; rows: Record<string, unknown>[] };

const WEEKDAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const EXPORT_TABLES = ["daily", "monthly", "slots", "payroll", "marketing-channels", "marketing-months", "marketing-spend", "money", "money-options", "money-locations", "margin", "expenses"] as const;

function pivotTable(name: string, first: string, p: Pivot, months: { month: string; label: string }[]): ExportTable {
  return {
    name,
    columns: [{ key: "group", label: first }, ...months.map((m) => ({ key: m.month, label: m.label, kind: "money" as const })), { key: "total", label: "Total", kind: "money" as const }],
    rows: p.groups.map((g) => {
      const row: Record<string, unknown> = { group: g };
      let total = 0;
      for (const m of months) {
        row[m.month] = p.byMonth[m.month]?.[g] ?? 0;
        total += p.byMonth[m.month]?.[g] ?? 0;
      }
      row.total = total;
      return row;
    }),
  };
}

export async function exportTable(tx: Tx, v: Viewer, c: Ctx, table: string, opts: { months?: number; weeks?: number } = {}): Promise<ExportTable | null> {
  if (table.startsWith("list-")) {
    const key = table.slice(5);
    if (!dailyMetric(key)) return null;
    const r = await metricRows(tx, v, c, key, 5000);
    if (!r) return null;
    return {
      name: `list-${key}`,
      columns: [
        { key: "name", label: "Name" },
        { key: "detail", label: "Detail" },
        { key: "grp", label: "Group" },
        { key: "day", label: "Date", kind: "date" },
        { key: "amount_minor", label: "Amount", kind: "money" },
      ],
      rows: r.rows,
    };
  }
  switch (table) {
    case "daily": {
      const d = await dailyScoreboard(tx, v, c);
      return {
        name: "daily",
        columns: [
          { key: "group", label: "Section" },
          { key: "label", label: "Number" },
          { key: "count", label: "Count", kind: "int" },
          { key: "people", label: "People", kind: "int" },
          { key: "amount_minor", label: "Amount", kind: "money" },
          { key: "change", label: "Change" },
          { key: "change_label", label: "Change is" },
          { key: "note", label: "Note" },
        ],
        rows: d.order.flatMap((k) => {
          const m = d.metrics[k];
          const head = { group: m.group, label: m.label, count: m.rowCount, people: m.people, amount_minor: m.amountMinor, change: m.change == null ? null : m.kind === "money" ? (m.change / 100).toFixed(2) : m.change, change_label: m.changeLabel, note: m.na };
          return [head, ...m.breakdown.map((b) => ({ group: m.group, label: `${m.label}: ${b.label}`, count: b.count, people: null, amount_minor: b.amountMinor, change: null, change_label: "", note: null }))];
        }),
      };
    }
    case "monthly": {
      const mo = await monthlyScoreboard(tx, v, c, { months: opts.months });
      const fmt = (kind: string, x: number | null) => (x == null ? null : kind === "pct" ? `${Math.round(x * 1000) / 10}%` : kind === "money" ? (x / 100).toFixed(2) : x);
      return {
        name: "monthly",
        columns: [{ key: "row", label: "Row" }, { key: "ideal", label: "Ideal" }, ...mo.months.map((m) => ({ key: m.month, label: m.partial ? `${m.label} (to date)` : m.label }))],
        rows: mo.rows.map((r) => {
          const row: Record<string, unknown> = { row: r.label + (r.kind === "money" ? " (USD)" : ""), ideal: mo.targets[r.key] ?? null };
          for (const m of mo.months) row[m.month] = mo.na[r.key] ? "not available with this filter" : fmt(r.kind, m.values[r.key]);
          return row;
        }),
      };
    }
    case "slots": {
      const s = await slotUtilisation(tx, c, { weeks: opts.weeks });
      return {
        name: "slots",
        columns: [
          { key: "weekday", label: "Weekday" },
          { key: "startTime", label: "Start" },
          { key: "title", label: "Class" },
          { key: "location", label: "Location" },
          { key: "sessions", label: "Sessions run", kind: "int" },
          { key: "avgAttendance", label: "Average attendance" },
          { key: "capacity", label: "Capacity (sum)", kind: "int" },
          { key: "booked", label: "Booked", kind: "int" },
          { key: "attended", label: "Attended", kind: "int" },
          { key: "utilisation", label: "Utilisation (attended / capacity)", kind: "pct" },
          { key: "flag", label: "Flag" },
        ],
        rows: s.rows.map((r) => ({ ...r, weekday: WEEKDAY[r.weekday], flag: r.flagText })),
      };
    }
    case "payroll": {
      const p = await payrollByMonth(tx, v, c, { months: opts.months });
      if (p.access !== "ok") return null;
      return {
        name: "payroll",
        columns: [
          { key: "label", label: "Month" },
          { key: "status", label: "Payroll data" },
          { key: "coachingHours", label: "Coaching hours" },
          { key: "totalHours", label: "All staff hours" },
          { key: "grossMinor", label: "Payroll cost (gross)", kind: "money" },
          { key: "collectedMinor", label: "Collected", kind: "money" },
          { key: "percent", label: "Payroll % of collected", kind: "pct" },
        ],
        rows: p.months.map((m) => ({ ...m, status: m.status === "none" ? "not available" : m.status })),
      };
    }
    case "marketing-channels":
    case "marketing-months":
    case "marketing-spend": {
      const mk = await marketingEconomics(tx, v, c, { months: opts.months });
      const common: ReportColumn[] = [
        { key: "spendMinor", label: "Spend", kind: "money" },
        { key: "leads", label: "Leads", kind: "int" },
        { key: "costPerLeadMinor", label: "Cost per lead", kind: "money" },
        { key: "newMembers", label: "New members", kind: "int" },
        { key: "costPerMemberMinor", label: "Cost per new member", kind: "money" },
      ];
      if (table === "marketing-channels") return { name: table, columns: [{ key: "channel", label: "Channel / lead source" }, ...common], rows: [...mk.channels, { channel: "All channels", ...mk.totals }] };
      if (table === "marketing-months") return { name: table, columns: [{ key: "label", label: "Month" }, ...common], rows: mk.months };
      return { name: table, columns: [{ key: "month", label: "Month", kind: "date" }, { key: "channel", label: "Channel" }, { key: "amountMinor", label: "Amount", kind: "money" }, { key: "note", label: "Note" }], rows: mk.entries };
    }
    case "money":
    case "money-options":
    case "money-locations": {
      const mv = await moneyView(tx, c, { months: opts.months });
      if (table === "money-options") return pivotTable(table, "Membership option", mv.byOption, mv.months);
      if (table === "money-locations") return pivotTable(table, "Location", mv.byLocation, mv.months);
      return {
        name: table,
        columns: [
          { key: "label", label: "Month" },
          { key: "collectedMinor", label: "Collected", kind: "money" },
          { key: "refundsMinor", label: "Refunds", kind: "money" },
          { key: "netMinor", label: "Net collected", kind: "money" },
          { key: "billedMinor", label: "Billed", kind: "money" },
          { key: "outstandingMinor", label: "Outstanding today", kind: "money" },
          { key: "creditsMinor", label: "Account credits issued", kind: "money" },
          { key: "eventsMinor", label: "Camp and clinic revenue", kind: "money" },
        ],
        rows: mv.months,
      };
    }
    case "margin":
    case "expenses": {
      const mg = await marginView(tx, v, c, { months: opts.months });
      if (mg.access !== "ok") return null;
      if (table === "expenses") return { name: table, columns: [{ key: "month", label: "Month", kind: "date" }, { key: "category", label: "Category" }, { key: "label", label: "Label" }, { key: "amountMinor", label: "Amount", kind: "money" }], rows: mg.entries.map((e) => ({ ...e, category: EXPENSE_LABEL[e.category] })) };
      return {
        name: table,
        columns: [
          { key: "label", label: "Month" },
          { key: "netCollectedMinor", label: "Net collected", kind: "money" },
          { key: "rentMinor", label: "Rent", kind: "money" },
          { key: "softwareMinor", label: "Software", kind: "money" },
          { key: "marketingMinor", label: "Marketing", kind: "money" },
          { key: "otherMinor", label: "Other", kind: "money" },
          { key: "payrollMinor", label: "Payroll", kind: "money" },
          { key: "payrollSource", label: "Payroll source" },
          { key: "beforePayrollMinor", label: "Before payroll", kind: "money" },
          { key: "marginMinor", label: "Operating margin (management estimate)", kind: "money" },
          { key: "marginPercent", label: "Margin %", kind: "pct" },
        ],
        rows: mg.months,
      };
    }
  }
  return null;
}
