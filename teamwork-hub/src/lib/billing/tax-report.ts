import { sql } from "drizzle-orm";
import type { ReportDef } from "@/lib/reports";
import { localDayBounds } from "@/lib/time";
import { formatRate } from "./tax";

type Row = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

export const SALES_TAX_COLUMN_NOTES = [
  "Basis: ACCRUAL. A bill counts in the month it was issued, whether or not it has been paid yet. This matches the Invoiced (billed) report; the Collected revenue report is the cash view.",
  "Taxable sales: for bills issued in the month that have at least one taxable item, the taxable items' prices after any price discount on the bill. Untaxed items on the same bill are not included. Voided and draft bills are excluded. Bills imported from Zen Planner are never included.",
  "Tax collected: the sales tax charged on those bills, as stored on each bill when it was issued (one rounding per bill: taxable amount x rate, half up to the cent).",
  "…of which on bills not paid: the part of Tax collected that sits on bills still open or written off as uncollectible. Shown so the accrual and cash views can be reconciled.",
  "Taxable sales refunded and Tax refunded: refunds that went through in the month (by the date the refund was recorded) on bills that carried tax, split into the price part and the tax part recorded with each refund.",
  "Net tax: Tax collected minus Tax refunded.",
  "Rate(s): every rate stored on the month's bills. More than one appears only when the organization's rate was changed during the month.",
  "This report adds up what the Hub charged. It is not a tax return and does not decide what is taxable.",
];

export const RETAIL_REPORTS: ReportDef[] = [
  {
    key: "sales-tax",
    title: "Sales tax collected",
    category: "Money",
    definition:
      "Sales tax by month, on an ACCRUAL basis: a bill counts in the month it was issued, paid or not (voided, draft and imported bills are excluded). Taxable sales = taxable items after price discounts. Tax collected = tax charged on those bills, exactly as stored on each bill at issue. Tax refunded = the tax part of refunds recorded in the month. Net tax = collected minus refunded. The column notes under the table define every column. Confirm filing figures with your accountant.",
    cap: "reports.financial",
    columns: [
      { key: "month", label: "Month" },
      { key: "rates", label: "Rate(s) in effect" },
      { key: "bills", label: "Bills with tax", kind: "int" },
      { key: "taxable_minor", label: "Taxable sales", kind: "money" },
      { key: "tax_minor", label: "Tax collected", kind: "money" },
      { key: "tax_unpaid_minor", label: "…of which on bills not paid", kind: "money" },
      { key: "taxable_refunded_minor", label: "Taxable sales refunded", kind: "money" },
      { key: "tax_refunded_minor", label: "Tax refunded", kind: "money" },
      { key: "net_tax_minor", label: "Net tax", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const start = localDayBounds(r.from, r.tz).start.toISOString();
      const end = localDayBounds(r.to, r.tz).end.toISOString();
      const billed = (
        await tx.execute(sql`
          select to_char(date_trunc('month', coalesce(issued_at, created_at) at time zone ${r.tz}), 'YYYY-MM') as month,
                 array_agg(distinct tax_rate_bps order by tax_rate_bps) as rates,
                 count(*)::int as bills,
                 coalesce(sum(taxable_minor),0)::bigint as taxable_minor,
                 coalesce(sum(tax_minor),0)::bigint as tax_minor,
                 coalesce(sum(tax_minor) filter (where status <> 'paid'),0)::bigint as tax_unpaid_minor
          from invoices
          where org_id = ${orgId} and tax_rate_bps is not null and source <> 'imported' and status in ('open','paid','uncollectible')
            and coalesce(issued_at, created_at) >= ${start} and coalesce(issued_at, created_at) < ${end}
          group by 1`)
      ).rows as Row[];
      const refunded = (
        await tx.execute(sql`
          select to_char(date_trunc('month', r.created_at at time zone ${r.tz}), 'YYYY-MM') as month,
                 coalesce(sum(r.amount_minor - r.tax_minor),0)::bigint as taxable_refunded_minor,
                 coalesce(sum(r.tax_minor),0)::bigint as tax_refunded_minor
          from refunds r
          where r.org_id = ${orgId} and r.status = 'succeeded' and r.tax_minor > 0
            and r.created_at >= ${start} and r.created_at < ${end}
          group by 1`)
      ).rows as Row[];
      const months = [...new Set([...billed, ...refunded].map((x) => String(x.month)))].sort();
      const rows = months.map((m) => {
        const b = billed.find((x) => x.month === m);
        const f = refunded.find((x) => x.month === m);
        const rates = ((b?.rates as number[] | null) ?? []).map((x) => formatRate(Number(x)));
        return {
          month: m,
          rates: rates.length ? rates.join(", ") : "no taxed bills",
          bills: n(b?.bills),
          taxable_minor: n(b?.taxable_minor),
          tax_minor: n(b?.tax_minor),
          tax_unpaid_minor: n(b?.tax_unpaid_minor),
          taxable_refunded_minor: n(f?.taxable_refunded_minor),
          tax_refunded_minor: n(f?.tax_refunded_minor),
          net_tax_minor: n(b?.tax_minor) - n(f?.tax_refunded_minor),
        };
      });
      const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, x) => s + n(x[k]), 0);
      return {
        rows,
        summary: [
          { label: "Taxable sales", value: sum("taxable_minor"), kind: "money" },
          { label: "Tax collected (accrual)", value: sum("tax_minor"), kind: "money" },
          { label: "Tax refunded", value: sum("tax_refunded_minor"), kind: "money" },
          { label: "Net tax", value: sum("net_tax_minor"), kind: "money" },
        ],
        notes: SALES_TAX_COLUMN_NOTES,
      };
    },
  },
  {
    key: "retail-sales",
    title: "Retail sales by item",
    category: "Money",
    definition:
      "Retail items on bills issued in the date range (front desk and Family Shop), by item and variant. Accrual basis, like Invoiced (billed): open and paid bills count, voided and draft bills do not. Sales = price after the bill's price discount, before tax. Sales tax = the tax share stored on each line. Refunds are not deducted here; see Refunds & disputes and Sales tax collected.",
    cap: "reports.financial",
    columns: [
      { key: "item", label: "Item" },
      { key: "variant", label: "Variant" },
      { key: "units", label: "Units", kind: "int" },
      { key: "sales_minor", label: "Sales (before tax)", kind: "money" },
      { key: "tax_minor", label: "Sales tax", kind: "money" },
    ],
    run: async (tx, orgId, r) => {
      const start = localDayBounds(r.from, r.tz).start.toISOString();
      const end = localDayBounds(r.to, r.tz).end.toISOString();
      const rows = (
        await tx.execute(sql`
          select p.name as item, coalesce(pv.label, '') as variant,
                 sum(l.quantity)::int as units,
                 coalesce(sum(l.amount_minor - l.discount_minor),0)::bigint as sales_minor,
                 coalesce(sum(l.tax_minor),0)::bigint as tax_minor
          from invoice_lines l
            join invoices i on i.id = l.invoice_id
            join product_versions v on v.id = l.product_version_id
            join products p on p.id = v.product_id
            left join product_variants pv on pv.id = l.variant_id
          where i.org_id = ${orgId} and p.kind = 'retail' and i.status in ('open','paid','uncollectible')
            and coalesce(i.issued_at, i.created_at) >= ${start} and coalesce(i.issued_at, i.created_at) < ${end}
          group by p.name, pv.label, pv.position
          order by p.name, pv.position nulls first, pv.label`)
      ).rows as Row[];
      return {
        rows,
        summary: [
          { label: "Units", value: rows.reduce((s, x) => s + n(x.units), 0) },
          { label: "Sales (before tax)", value: rows.reduce((s, x) => s + n(x.sales_minor), 0), kind: "money" },
          { label: "Sales tax", value: rows.reduce((s, x) => s + n(x.tax_minor), 0), kind: "money" },
        ],
      };
    },
  },
];
