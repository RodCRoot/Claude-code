import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { SCOREBOARD_EXPENSE_CATEGORIES, scoreboardExpenses, type ScoreboardExpenseCategory } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { parseMoneyToMinor } from "@/lib/money";
import { addMonths, dayEnd, dayStart, membershipCtes, monthEnd, monthLabel, monthStart, num, rowsOf, ymdOf, type Ctx, type Row } from "./core";
import { payrollByMonth } from "./efficiency";

/**
 * Money view. Everything is cash that settled (collected) or invoices that were issued (billed),
 * by facility-local calendar month. The operating margin is a MANAGEMENT ESTIMATE from hand-entered
 * expenses; it is not accounting and nothing here is posted to a ledger.
 */

export const MONEY_DEFINITIONS = [
  { key: "mv_collected", label: "Collected", version: 1, definition: "Settled charges and manual payments by settlement time in the month. Gross of refunds and processor fees; pending money is not counted. Same rule as the Collected revenue report and the daily page." },
  { key: "mv_refunds", label: "Refunds", version: 1, definition: "Settled refund transactions in the month, shown as a positive amount. Net collected = collected minus refunds." },
  { key: "mv_billed", label: "Billed", version: 1, definition: "Total of invoices issued in the month, excluding drafts and voided invoices. Same rule as the Invoiced report." },
  { key: "mv_outstanding", label: "Outstanding", version: 1, definition: "Of the invoices issued in that month, the balance still unpaid today on those that are still open (invoice total minus settled payments). It is today's balance, not the balance at month end." },
  { key: "mv_credits", label: "Account credits issued", version: 1, definition: "Referral reward credits added to family accounts in the month (the account credit ledger's referral rewards). Account credit is not money received and is never part of collected." },
  { key: "mv_events", label: "Camp and clinic revenue", version: 1, definition: "Collected (same rule) on invoices created for camp and clinic registrations in the events module. It is part of Collected, not in addition to it." },
  {
    key: "mv_by_option",
    label: "Revenue by membership option",
    version: 1,
    definition: "Collected in the month, grouped by what the invoice was for: the membership plan for membership invoices, \"Camps and clinics\" for event registrations, \"Other sales\" for everything else (shop, drop-ins, packages). Every collected dollar falls in exactly one group, so the groups add up to Collected.",
  },
  {
    key: "mv_by_location",
    label: "Revenue by location",
    version: 1,
    definition: "Collected in the month on membership invoices, by the membership's location scope: a plan valid at exactly one location goes to that location, a plan valid at several or all goes to \"Multiple / all locations\". Invoices with no membership go to \"Not tied to a location\". The groups add up to Collected.",
  },
  {
    key: "mv_margin",
    label: "Operating margin (management estimate)",
    version: 1,
    definition:
      "Net collected minus expenses for the month. Expenses = rent, software and other entered by hand here, marketing from the Marketing tab, and payroll from the payroll module (gross pay for clocked hours; if a month has no time-clock data, a hand-entered payroll figure is used when present). When payroll is unknown or incomplete the margin is shown as not available and the figure before payroll is given instead. This is a management estimate from cash collected and typed-in costs: it is not accounting, has no accruals, taxes or depreciation, and should not be used for filings.",
  },
];

export const EXPENSE_LABEL: Record<ScoreboardExpenseCategory, string> = { rent: "Rent", software: "Software", payroll_manual: "Payroll (entered by hand)", other: "Other" };

export type MoneyMonth = {
  month: string;
  label: string;
  partial: boolean;
  collectedMinor: number;
  refundsMinor: number;
  netMinor: number;
  billedMinor: number;
  outstandingMinor: number;
  creditsMinor: number | null;
  eventsMinor: number | null;
};
export type Pivot = { groups: string[]; byMonth: Record<string, Record<string, number>> };
export type MoneyView = { first: string; last: string; months: MoneyMonth[]; byOption: Pivot; byLocation: Pivot; outstandingNowMinor: number };

export async function moneyView(tx: Tx, c: Ctx, opts: { months?: number } = {}): Promise<MoneyView> {
  const count = Math.min(24, Math.max(2, opts.months ?? 6));
  const last = monthStart(c.today);
  const first = addMonths(last, -(count - 1));
  const t0 = dayStart(c, first);
  const t1 = dayEnd(c, monthEnd(last));
  const tz = sql`${c.tz}`;
  const invF = c.filtered ? sql`and i.membership_id in (select id from ms)` : sql``;
  const txnF = c.filtered ? sql`and t.invoice_id in (select i.id from invoices i where i.membership_id in (select id from ms))` : sql``;
  const settledAt = sql`coalesce(t.settled_at, t.occurred_at)`;
  const mOf = (col: ReturnType<typeof sql>) => sql`date_trunc('month', ${col} at time zone ${tz})::date`;

  const cash = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select ${mOf(settledAt)} as m,
          coalesce(sum(t.amount_minor) filter (where t.kind in ('charge','manual_payment')), 0)::bigint as collected,
          coalesce(sum(-t.amount_minor) filter (where t.kind = 'refund'), 0)::bigint as refunds,
          coalesce(sum(t.amount_minor) filter (where t.kind in ('charge','manual_payment') and exists (select 1 from event_registrations er where er.invoice_id = t.invoice_id)), 0)::bigint as events
        from transactions t
        where t.org_id = ${c.orgId} and t.status = 'settled' and t.kind in ('charge','manual_payment','refund') and ${settledAt} >= ${t0} and ${settledAt} < ${t1} ${txnF}
        group by 1`,
  );
  const billed = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select ${mOf(sql`coalesce(i.issued_at, i.created_at)`)} as m, sum(i.total_minor)::bigint as billed,
          coalesce(sum(case when i.status = 'open' then greatest(0, i.total_minor - coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment')), 0)) else 0 end), 0)::bigint as outstanding
        from invoices i
        where i.org_id = ${c.orgId} and i.status not in ('draft','void') and coalesce(i.issued_at, i.created_at) >= ${t0} and coalesce(i.issued_at, i.created_at) < ${t1} ${invF}
        group by 1`,
  );
  const [outNow] = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select coalesce(sum(greatest(0, i.total_minor - coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment')), 0))), 0)::bigint as amount
        from invoices i where i.org_id = ${c.orgId} and i.status = 'open' ${invF}`,
  );
  const credits = c.filtered
    ? []
    : await rowsOf<Row>(
        tx,
        sql`select ${mOf(sql`created_at`)} as m, sum(delta_minor)::bigint as amount from account_credit_ledger
            where org_id = ${c.orgId} and kind = 'referral_reward' and delta_minor > 0 and created_at >= ${t0} and created_at < ${t1} group by 1`,
      );
  const pivotRows = await rowsOf<Row>(
    tx,
    sql`with ${membershipCtes(c)}
        select ${mOf(settledAt)} as m,
          case when am.id is not null then am.product
               when exists (select 1 from event_registrations er where er.invoice_id = t.invoice_id) then 'Camps and clinics'
               else 'Other sales' end as opt,
          case when am.id is null then 'Not tied to a location'
               when jsonb_array_length(am.loc_scope) = 1 then coalesce((select l.name from locations l where l.id::text = am.loc_scope->>0), 'Unknown location')
               else 'Multiple / all locations' end as loc,
          sum(t.amount_minor)::bigint as amount
        from transactions t left join invoices i on i.id = t.invoice_id left join allmx am on am.id = i.membership_id
        where t.org_id = ${c.orgId} and t.status = 'settled' and t.kind in ('charge','manual_payment') and ${settledAt} >= ${t0} and ${settledAt} < ${t1} ${txnF}
        group by 1, 2, 3`,
  );

  const by = <T extends Row>(rows: T[]) => new Map(rows.map((r) => [ymdOf(r.m)!, r]));
  const cashM = by(cash);
  const billedM = by(billed);
  const creditM = by(credits);
  const months: MoneyMonth[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) {
    const collected = num(cashM.get(m)?.collected);
    const refunds = num(cashM.get(m)?.refunds);
    months.push({
      month: m,
      label: monthLabel(m),
      partial: m === last,
      collectedMinor: collected,
      refundsMinor: refunds,
      netMinor: collected - refunds,
      billedMinor: num(billedM.get(m)?.billed),
      outstandingMinor: num(billedM.get(m)?.outstanding),
      creditsMinor: c.filtered ? null : num(creditM.get(m)?.amount),
      eventsMinor: c.filtered ? null : num(cashM.get(m)?.events),
    });
  }
  const pivot = (col: "opt" | "loc"): Pivot => {
    const byMonth: Record<string, Record<string, number>> = {};
    const totals = new Map<string, number>();
    for (const r of pivotRows) {
      const m = ymdOf(r.m)!;
      const g = String(r[col]);
      (byMonth[m] ??= {})[g] = (byMonth[m][g] ?? 0) + num(r.amount);
      totals.set(g, (totals.get(g) ?? 0) + num(r.amount));
    }
    return { groups: [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g), byMonth };
  };
  return { first, last, months, byOption: pivot("opt"), byLocation: pivot("loc"), outstandingNowMinor: num(outNow.amount) };
}

// ---------------------------------------------------------------------------
// Manual expenses and the management-estimate margin
// ---------------------------------------------------------------------------

export type ExpenseInput = { month: string; category: string; label?: string | null; amount: string };

export async function saveExpense(tx: Tx, v: Viewer, input: ExpenseInput) {
  assertCan(v, "scoreboard.manage");
  const errors: Record<string, string> = {};
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month ?? "")) errors.month = "Choose a month";
  if (!(SCOREBOARD_EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) errors.category = "Choose a category";
  const amountMinor = parseMoneyToMinor(String(input.amount ?? ""));
  if (amountMinor == null || amountMinor < 0 || amountMinor > 100_000_000_00) errors.amount = "Enter an amount of 0 or more";
  const label = (input.label ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (Object.keys(errors).length) throw new UserError("Check the highlighted fields.", errors);
  const month = `${input.month}-01`;
  const category = input.category as ScoreboardExpenseCategory;
  const [before] = await tx
    .select()
    .from(scoreboardExpenses)
    .where(and(eq(scoreboardExpenses.orgId, v.orgId), eq(scoreboardExpenses.month, month), eq(scoreboardExpenses.category, category), sql`lower(${scoreboardExpenses.label}) = lower(${label})`))
    .for("update");
  const actor = { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role };
  const summary = `Expense ${input.month} ${EXPENSE_LABEL[category]}${label ? ` (${label})` : ""}`;
  if (before) {
    await tx.update(scoreboardExpenses).set({ amountMinor: amountMinor!, label, updatedAt: new Date() }).where(eq(scoreboardExpenses.id, before.id));
    await audit(tx, actor, "scoreboard.expense_update", "scoreboard_expense", before.id, { summary, before: { amountMinor: before.amountMinor }, after: { amountMinor } });
    return before.id;
  }
  const [row] = await tx.insert(scoreboardExpenses).values({ orgId: v.orgId, month, category, label, amountMinor: amountMinor!, createdBy: v.userId }).returning();
  await audit(tx, actor, "scoreboard.expense_create", "scoreboard_expense", row.id, { summary, after: { amountMinor } });
  return row.id;
}

export async function deleteExpense(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "scoreboard.manage");
  const [row] = await tx.delete(scoreboardExpenses).where(and(eq(scoreboardExpenses.id, id), eq(scoreboardExpenses.orgId, v.orgId))).returning();
  if (!row) throw new UserError("That entry was not found.");
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "scoreboard.expense_delete", "scoreboard_expense", id, { summary: `Removed expense ${row.month.slice(0, 7)} ${EXPENSE_LABEL[row.category]}`, before: { amountMinor: row.amountMinor } });
}

export type MarginMonth = {
  month: string;
  label: string;
  partial: boolean;
  netCollectedMinor: number;
  rentMinor: number | null;
  softwareMinor: number | null;
  otherMinor: number | null;
  marketingMinor: number | null;
  /** Null = unknown. */
  payrollMinor: number | null;
  payrollSource: "payroll module" | "payroll module (incomplete: some hours have no pay rate)" | "entered by hand" | "not available";
  beforePayrollMinor: number;
  /** Null when payroll is unknown or incomplete. */
  marginMinor: number | null;
  marginPercent: number | null;
};

export type MarginView = { access: "ok" | "restricted" | "filtered"; months: MarginMonth[]; entries: (typeof scoreboardExpenses.$inferSelect)[] };

/**
 * Simple operating margin per month. Org-wide only: expenses are not split by location or program.
 * Needs payroll access because it reveals payroll cost.
 */
export async function marginView(tx: Tx, v: Viewer, c: Ctx, opts: { months?: number } = {}): Promise<MarginView> {
  const pay = await payrollByMonth(tx, v, c, opts);
  if (pay.access !== "ok") return { access: pay.access, months: [], entries: [] };
  const money = await moneyView(tx, c, opts);
  const entries = await tx
    .select()
    .from(scoreboardExpenses)
    .where(and(eq(scoreboardExpenses.orgId, c.orgId), sql`${scoreboardExpenses.month} >= ${money.first}`, sql`${scoreboardExpenses.month} <= ${money.last}`))
    .orderBy(sql`${scoreboardExpenses.month} desc`, scoreboardExpenses.category, scoreboardExpenses.label);
  const spend = await rowsOf<Row>(tx, sql`select month as m, sum(amount_minor)::bigint as amount from scoreboard_marketing_spend where org_id = ${c.orgId} and month >= ${money.first} and month <= ${money.last} group by 1`);
  const spendM = new Map(spend.map((r) => [ymdOf(r.m)!, num(r.amount)]));
  const sumOf = (m: string, cat: ScoreboardExpenseCategory) => {
    const xs = entries.filter((e) => e.month === m && e.category === cat);
    return xs.length ? xs.reduce((s, e) => s + e.amountMinor, 0) : null;
  };
  const months = money.months.map((mm): MarginMonth => {
    const p = pay.months.find((x) => x.month === mm.month);
    const manual = sumOf(mm.month, "payroll_manual");
    let payrollMinor: number | null = null;
    let payrollSource: MarginMonth["payrollSource"] = "not available";
    if (p && p.status !== "none") {
      payrollMinor = p.grossMinor;
      payrollSource = p.status === "ok" ? "payroll module" : "payroll module (incomplete: some hours have no pay rate)";
    } else if (manual != null) {
      payrollMinor = manual;
      payrollSource = "entered by hand";
    }
    const rent = sumOf(mm.month, "rent");
    const software = sumOf(mm.month, "software");
    const other = sumOf(mm.month, "other");
    const marketing = spendM.has(mm.month) ? spendM.get(mm.month)! : null;
    const before = mm.netMinor - (rent ?? 0) - (software ?? 0) - (other ?? 0) - (marketing ?? 0);
    const known = payrollMinor != null && payrollSource !== "payroll module (incomplete: some hours have no pay rate)";
    const margin = known ? before - payrollMinor! : null;
    return {
      month: mm.month,
      label: mm.label,
      partial: mm.partial,
      netCollectedMinor: mm.netMinor,
      rentMinor: rent,
      softwareMinor: software,
      otherMinor: other,
      marketingMinor: marketing,
      payrollMinor,
      payrollSource,
      beforePayrollMinor: before,
      marginMinor: margin,
      marginPercent: margin != null && mm.netMinor > 0 ? margin / mm.netMinor : null,
    };
  });
  return { access: "ok", months, entries };
}
