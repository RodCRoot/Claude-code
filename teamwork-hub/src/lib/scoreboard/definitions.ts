import { DAILY_METRICS } from "./daily";
import { PAYROLL_DEFINITION, SLOT_DEFINITION } from "./efficiency";
import { MARKETING_DEFINITIONS } from "./marketing";
import { MONEY_DEFINITIONS } from "./money";
import { BOTTLENECK_RULES, MONTHLY_ROWS } from "./monthly";

/**
 * The scoreboard's definitions, one entry per number, each with a version. A definition's version
 * goes up whenever its rule changes, so a number from last quarter can be read against the rule
 * that produced it. The page's Definitions drawer renders exactly this list.
 */
export type ScoreboardDefinition = { key: string; label: string; version: number; definition: string; filterNote?: string };
export type DefinitionTab = "daily" | "monthly" | "efficiency" | "marketing" | "money";

const FILTER_BASICS =
  "Program = the membership's plan. Location = the membership's location scope (its own override, else the plan's); a plan valid at every location matches every location. Session numbers use the session's own location. A number that cannot be attributed is withheld while a filter is on, never shown unfiltered.";

export function definitionsFor(tab: DefinitionTab): ScoreboardDefinition[] {
  switch (tab) {
    case "daily":
      return [
        { key: "filter", label: "How the location / program filter works", version: 1, definition: FILTER_BASICS },
        {
          key: "yesterday_change",
          label: "Yesterday's change",
          version: 1,
          definition:
            "For point-in-time numbers (members, holds, past due and so on) the change is the number recomputed as of the end of yesterday minus the number as of the end of the day before, from dated rows; nothing is stored, so a correction keyed today to an older date shows in both. For numbers that count events, the label says what is compared (for example yesterday against the same weekday last week). Where history is not stored, the tile says so instead of showing 0.",
        },
        ...DAILY_METRICS.map((m) => ({ key: m.key, label: m.label, version: m.version, definition: m.definition, filterNote: m.filterNote })),
      ];
    case "monthly":
      return [
        { key: "filter", label: "How the location / program filter works", version: 1, definition: FILTER_BASICS },
        { key: "months", label: "Months and point-in-time rows", version: 1, definition: "Calendar months in facility time. Rows that are a count on a day (active clients, on hold) are taken on the month's last day, or today for the month in progress, which is marked \"to date\"." },
        ...MONTHLY_ROWS.map((r) => ({ key: r.key, label: r.label, version: r.version, definition: r.definition })),
        {
          key: "bottleneck",
          label: "Where is the bottleneck?",
          version: 1,
          definition: `A rule of thumb, not an analysis. It reads the last complete month against your ideals and reports the first step in the chain leads, consults, sales, clients that is under its ideal. Rules, in order: ${BOTTLENECK_RULES.map((r, i) => `(${i + 1}) ${r.rule}`).join(" ")} A step with no ideal, or with no value under the current filter, is skipped.`,
        },
      ];
    case "efficiency":
      return [SLOT_DEFINITION, PAYROLL_DEFINITION];
    case "marketing":
      return MARKETING_DEFINITIONS;
    case "money":
      return [{ key: "filter", label: "How the location / program filter works", version: 1, definition: FILTER_BASICS + " On this tab a filter keeps only invoices tied to a membership in the filtered set." }, ...MONEY_DEFINITIONS];
  }
}
