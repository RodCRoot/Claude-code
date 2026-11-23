import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { invoiceLines, invoices, organizations, refunds, transactions } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "./errors";
import { DEFAULT_SALES_TAX_BPS, DEFAULT_SALES_TAX_LABEL, divRoundHalfUp, formatRate } from "./tax";
import { actorOf, int } from "./util";

export type SalesTaxSettings = {
  /** Basis points: 700 = 7.00%. 0 = no sales tax is charged. */
  rateBps: number;
  /** Shown next to the tax on bills and receipts. */
  label: string;
  /** False until an owner or admin has saved the rate (it is then no longer the shipped default). */
  confirmed: boolean;
};

export const DEFAULT_SALES_TAX: SalesTaxSettings = { rateBps: DEFAULT_SALES_TAX_BPS, label: DEFAULT_SALES_TAX_LABEL, confirmed: false };

export function salesTaxOf(settings: Record<string, unknown> | null | undefined): SalesTaxSettings {
  const raw = ((settings ?? {}) as Record<string, unknown>).salesTax as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return DEFAULT_SALES_TAX;
  const bps = typeof raw.rateBps === "number" && Number.isInteger(raw.rateBps) && raw.rateBps >= 0 && raw.rateBps <= 2500 ? raw.rateBps : DEFAULT_SALES_TAX_BPS;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : DEFAULT_SALES_TAX_LABEL;
  return { rateBps: bps, label, confirmed: raw.confirmed === true };
}

export async function salesTaxSettings(tx: Tx, orgId: string): Promise<SalesTaxSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return salesTaxOf(o?.settings);
}

/**
 * Owner / admin only. Changing the rate affects bills created from now on; issued bills keep the
 * rate and tax stored on them.
 */
export async function saveSalesTax(tx: Tx, v: Viewer, next: { rateBps: number; label?: string | null }) {
  assertCan(v, "settings.manage");
  if (!Number.isInteger(next.rateBps) || next.rateBps < 0 || next.rateBps > 2500) {
    throw new UserError("Enter the sales tax rate as a percent from 0 to 25, for example 7 or 7.00. Leave it empty to charge no sales tax.", { salesTaxRate: "0 to 25" });
  }
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = salesTaxOf(o?.settings);
  const after: SalesTaxSettings = { rateBps: next.rateBps, label: (next.label ?? "").trim().slice(0, 80) || DEFAULT_SALES_TAX_LABEL, confirmed: true };
  await tx.update(organizations).set({ settings: { ...(o?.settings ?? {}), salesTax: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "billing.sales_tax.rate", "org", v.orgId, {
    summary: `Sales tax rate ${formatRate(before.rateBps)} → ${formatRate(after.rateBps)} (${after.label}). Applies to bills created from now on.`,
    before,
    after,
  });
  return after;
}

/**
 * How much of a refund is sales tax.
 *
 * - For one bill line: the refund is treated as part of that line's price plus its tax, so the tax
 *   share is refund x line tax / (line price after discount + line tax).
 * - For the whole bill: refund x bill tax / bill total.
 * Halves round up; the result never exceeds the tax not yet refunded, and a refund that returns
 * everything returns exactly the remaining tax. Call with the charge row locked.
 */
export async function refundTaxMinor(tx: Tx, input: { invoiceId: string | null; amountMinor: number; invoiceLineId?: string | null }): Promise<number> {
  if (!input.invoiceId) {
    if (input.invoiceLineId) throw new UserError("That bill line does not belong to this payment.");
    return 0;
  }
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId));
  if (!inv) return 0;
  const live = ["requested", "pending", "succeeded"] as const;
  const prior = await tx
    .select({ lineId: refunds.invoiceLineId, amount: sql<string>`coalesce(sum(${refunds.amountMinor}),0)::bigint`, tax: sql<string>`coalesce(sum(${refunds.taxMinor}),0)::bigint` })
    .from(refunds)
    .innerJoin(transactions, eq(transactions.id, refunds.transactionId))
    .where(and(eq(transactions.invoiceId, inv.id), inArray(refunds.status, [...live])))
    .groupBy(refunds.invoiceLineId);
  const priorTax = prior.reduce((s, r) => s + int(r.tax), 0);
  const priorAmount = prior.reduce((s, r) => s + int(r.amount), 0);
  const billTaxLeft = Math.max(0, inv.taxMinor - priorTax);

  if (input.invoiceLineId) {
    const [line] = await tx.select().from(invoiceLines).where(and(eq(invoiceLines.id, input.invoiceLineId), eq(invoiceLines.invoiceId, inv.id)));
    if (!line) throw new UserError("That bill line does not belong to this payment.");
    const gross = line.amountMinor - line.discountMinor + line.taxMinor;
    const onLine = prior.find((r) => r.lineId === line.id);
    const lineLeft = gross - int(onLine?.amount);
    if (input.amountMinor > lineLeft) throw new UserError(`At most ${lineLeft} cents can still be refunded for "${line.description}" (its price after discount plus its tax).`);
    if (line.taxMinor <= 0 || gross <= 0) return 0;
    const lineTaxLeft = Math.max(0, line.taxMinor - int(onLine?.tax));
    const share = input.amountMinor === lineLeft ? lineTaxLeft : divRoundHalfUp(input.amountMinor * line.taxMinor, gross);
    return Math.min(share, lineTaxLeft, billTaxLeft, input.amountMinor);
  }

  if (inv.taxMinor <= 0 || inv.totalMinor <= 0) return 0;
  const share = priorAmount + input.amountMinor >= inv.totalMinor ? billTaxLeft : divRoundHalfUp(input.amountMinor * inv.taxMinor, inv.totalMinor);
  return Math.min(share, billTaxLeft, input.amountMinor);
}
