import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, updatedAt } from "./_common";
import { users } from "./core";

// ---------------------------------------------------------------------------
// Owner scoreboard: the only things the owner types in by hand.
// Everything else on the scoreboard is computed from other modules' tables.
// ---------------------------------------------------------------------------

/**
 * Marketing spend for one calendar month and one channel, entered by hand (no ad-platform
 * integration). `month` is the first day of the month. `channel` matches a CRM lead source
 * (leads.source) when the owner wants cost per lead for that source; any other text is allowed.
 */
export const scoreboardMarketingSpend = pgTable(
  "scoreboard_marketing_spend",
  {
    id: id(),
    orgId: orgId(),
    month: date("month").notNull(),
    channel: text("channel").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("USD"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("scoreboard_spend_uq").on(t.orgId, t.month, sql`lower(${t.channel})`),
    check("scoreboard_spend_amount_ck", sql`${t.amountMinor} >= 0`),
    check("scoreboard_spend_month_ck", sql`extract(day from ${t.month}) = 1`),
  ],
);

export const SCOREBOARD_EXPENSE_CATEGORIES = ["rent", "software", "payroll_manual", "other"] as const;
export type ScoreboardExpenseCategory = (typeof SCOREBOARD_EXPENSE_CATEGORIES)[number];

/**
 * Optional hand-entered monthly expense for the management-estimate operating margin.
 * Payroll comes from the payroll module and marketing from scoreboard_marketing_spend;
 * `payroll_manual` is only used for a month with no time-clock data.
 */
export const scoreboardExpenses = pgTable(
  "scoreboard_expenses",
  {
    id: id(),
    orgId: orgId(),
    month: date("month").notNull(),
    category: text("category").$type<ScoreboardExpenseCategory>().notNull(),
    label: text("label").notNull().default(""),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("USD"),
    createdBy: uuid("created_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("scoreboard_expenses_uq").on(t.orgId, t.month, t.category, sql`lower(${t.label})`),
    index("scoreboard_expenses_org_idx").on(t.orgId, t.month),
    check("scoreboard_expenses_amount_ck", sql`${t.amountMinor} >= 0`),
    check("scoreboard_expenses_month_ck", sql`extract(day from ${t.month}) = 1`),
    check("scoreboard_expenses_category_ck", sql`${t.category} in ('rent','software','payroll_manual','other')`),
  ],
);
