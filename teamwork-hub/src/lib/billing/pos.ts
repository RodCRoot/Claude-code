import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { inventoryMovements, payerAccounts, payerBeneficiaries, products, productVariants, productVersions } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { versionOn } from "./catalog";
import { createInvoiceRecord, recordManualPayment, type LineInput, type ManualMethod } from "./invoices";
import { actorOf, int } from "./util";
import { optionNameOf, variantLineDescription, type Variant } from "./variants";

export const WALK_IN_NAME = "Walk-in customer (POS)";

/** Shared payer account for anonymous counter sales (invoices always need a payer). */
export async function walkInPayer(tx: Tx, orgId: string) {
  const [p] = await tx
    .select()
    .from(payerAccounts)
    .where(and(eq(payerAccounts.orgId, orgId), eq(payerAccounts.name, WALK_IN_NAME), isNull(payerAccounts.householdId)));
  if (p) return p;
  const [np] = await tx.insert(payerAccounts).values({ orgId, name: WALK_IN_NAME, providerRefs: { kind: "walk_in" } }).returning();
  return np;
}

/** On-hand count per product (all variants plus unassigned stock). */
export async function onHandCounts(tx: Tx, orgId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ productId: inventoryMovements.productId, n: sql<string>`coalesce(sum(${inventoryMovements.delta}),0)::bigint` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.orgId, orgId))
    .groupBy(inventoryMovements.productId);
  return Object.fromEntries(rows.map((r) => [r.productId, int(r.n)]));
}

/** Key for stock that belongs to no variant: a product without variants, or stock counted before it had any. */
export const UNASSIGNED = "";

/** On-hand count per product per variant; `counts[productId][UNASSIGNED]` is the stock with no variant. */
export async function stockByVariant(tx: Tx, orgId: string, productIds?: string[]): Promise<Record<string, Record<string, number>>> {
  if (productIds && !productIds.length) return {};
  const rows = await tx
    .select({ productId: inventoryMovements.productId, variantId: inventoryMovements.variantId, n: sql<string>`coalesce(sum(${inventoryMovements.delta}),0)::bigint` })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.orgId, orgId), productIds ? inArray(inventoryMovements.productId, productIds) : undefined))
    .groupBy(inventoryMovements.productId, inventoryMovements.variantId);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.productId] ??= {})[r.variantId ?? UNASSIGNED] = int(r.n);
  return out;
}

/** At or below this many on hand a count is shown as low (the front desk's existing rule). */
export const LOW_STOCK_AT = 2;

async function lockTrackedProduct(tx: Tx, v: Viewer, productId: string) {
  const [p] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.orgId, v.orgId))).for("update");
  if (!p || !p.trackInventory) throw new UserError("That product does not track inventory.");
  const variants = await tx.select().from(productVariants).where(eq(productVariants.productId, p.id)).orderBy(productVariants.id).for("update");
  return { p, variants };
}

/**
 * Receive, adjust (note required) or return stock. For a product with variants the movement names
 * the variant; without one it applies to the product's unassigned stock, which can only be adjusted
 * (corrected or written off), never received into.
 */
export async function adjustStock(tx: Tx, v: Viewer, input: { productId: string; variantId?: string | null; delta: number; reason: "receive" | "adjust" | "return"; note?: string | null }) {
  assertCan(v, "billing.manage");
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new UserError("Quantity must be a non-zero whole number.");
  if (input.reason === "receive" && input.delta < 0) throw new UserError("Received quantity must be positive.");
  if (input.reason === "adjust" && !input.note?.trim()) throw new UserError("Stock adjustments need a note.");
  const { p, variants } = await lockTrackedProduct(tx, v, input.productId);
  const variant = input.variantId ? variants.find((x) => x.id === input.variantId) : null;
  if (input.variantId && !variant) throw new UserError("That variant does not belong to this product.");
  if (!variant && variants.length && input.reason !== "adjust") throw new UserError(`Choose which ${optionNameOf(p).toLowerCase()} of ${p.name} this stock is.`);
  const counts = (await stockByVariant(tx, v.orgId, [p.id]))[p.id] ?? {};
  const have = counts[variant?.id ?? UNASSIGNED] ?? 0;
  if (have + input.delta < 0) throw new UserError("Adjustment would make on-hand stock negative.");
  const [mv] = await tx.insert(inventoryMovements).values({ orgId: v.orgId, productId: p.id, variantId: variant?.id ?? null, delta: input.delta, reason: input.reason, actorUserId: v.userId, note: input.note ?? null }).returning();
  await audit(tx, actorOf(v), "billing.inventory." + input.reason, "product", p.id, {
    summary: `${input.delta > 0 ? "+" : ""}${input.delta} ${p.name}${variant ? `, ${optionNameOf(p)} ${variant.label}` : variants.length ? " (unassigned)" : ""}${input.note ? ` (${input.note})` : ""}`,
  });
  return mv;
}

/**
 * Move counted stock between a product's buckets, typically from "unassigned" (counted before the
 * product had variants) to the variant it really is. Two adjust movements with the same note; the
 * product total does not change. Nothing is ever assigned automatically.
 */
export async function moveStock(tx: Tx, v: Viewer, input: { productId: string; fromVariantId?: string | null; toVariantId: string; quantity: number; note: string }) {
  assertCan(v, "billing.manage");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new UserError("Quantity must be a positive whole number.");
  const note = input.note?.trim();
  if (!note) throw new UserError("Stock adjustments need a note.");
  const { p, variants } = await lockTrackedProduct(tx, v, input.productId);
  const from = input.fromVariantId ? variants.find((x) => x.id === input.fromVariantId) : null;
  const to = variants.find((x) => x.id === input.toVariantId);
  if (!to || (input.fromVariantId && !from)) throw new UserError("That variant does not belong to this product.");
  if ((from?.id ?? null) === to.id) throw new UserError("Choose two different places to move stock between.");
  const counts = (await stockByVariant(tx, v.orgId, [p.id]))[p.id] ?? {};
  const have = counts[from?.id ?? UNASSIGNED] ?? 0;
  if (have < input.quantity) throw new UserError(`Only ${have} ${from ? `${optionNameOf(p)} ${from.label}` : "unassigned"} on hand.`);
  await tx.insert(inventoryMovements).values([
    { orgId: v.orgId, productId: p.id, variantId: from?.id ?? null, delta: -input.quantity, reason: "adjust", actorUserId: v.userId, note },
    { orgId: v.orgId, productId: p.id, variantId: to.id, delta: input.quantity, reason: "adjust", actorUserId: v.userId, note },
  ]);
  await audit(tx, actorOf(v), "billing.inventory.move", "product", p.id, { summary: `${p.name}: moved ${input.quantity} from ${from ? from.label : "unassigned"} to ${to.label} (${note})` });
}

export type SaleItem = { productId: string; variantId?: string | null; quantity: number };

export type PricedItem = {
  product: typeof products.$inferSelect;
  version: typeof productVersions.$inferSelect;
  variant: Variant | null;
  quantity: number;
  unitAmountMinor: number;
  description: string;
};

/**
 * Lock, validate and price the items of a sale. Each product row and each of its variant rows is
 * locked FOR UPDATE (in id order) before stock is read, so two sales of the last item of a variant
 * cannot both succeed: the second waits, then sees the first sale's stock movement.
 *
 * A product with active variants must be sold as one of them; stock is checked for that variant
 * only. Tracked stock at zero cannot be sold (the rule the point of sale has always had).
 */
export async function priceSaleItems(tx: Tx, orgId: string, items: SaleItem[], today: string): Promise<PricedItem[]> {
  const ids = [...new Set(items.map((i) => i.productId))];
  const ps = await tx.select().from(products).where(and(inArray(products.id, ids), eq(products.orgId, orgId))).orderBy(products.id).for("update");
  if (ps.length !== ids.length) throw new UserError("One of the products was not found.");
  const vs = await tx.select().from(productVariants).where(inArray(productVariants.productId, ids)).orderBy(productVariants.id).for("update");
  const counts = await stockByVariant(tx, orgId, ids);
  const need = new Map<string, number>();
  const out: PricedItem[] = [];
  for (const it of items) {
    const p = ps.find((x) => x.id === it.productId)!;
    if (!p.active) throw new UserError(`${p.name} is archived.`);
    if (p.kind === "recurring_membership") throw new UserError("Sell memberships from the Memberships page.");
    const mine = vs.filter((x) => x.productId === p.id);
    const active = mine.filter((x) => x.active);
    const opt = optionNameOf(p);
    let variant: Variant | null = null;
    if (it.variantId) {
      variant = mine.find((x) => x.id === it.variantId) ?? null;
      if (!variant) throw new UserError(`That ${opt.toLowerCase()} does not belong to ${p.name}.`);
      if (!variant.active) throw new UserError(`${p.name}, ${opt} ${variant.label} is no longer sold.`);
    } else if (active.length) {
      throw new UserError(`Choose a ${opt.toLowerCase()} for ${p.name}.`);
    }
    if (p.trackInventory) {
      const key = `${p.id}:${variant?.id ?? UNASSIGNED}`;
      const want = (need.get(key) ?? 0) + it.quantity;
      need.set(key, want);
      const have = counts[p.id]?.[variant?.id ?? UNASSIGNED] ?? 0;
      if (have < want) throw new UserError(have <= 0 ? `${p.name}${variant ? `, ${opt} ${variant.label}` : ""} is out of stock.` : `Only ${have} × ${p.name}${variant ? `, ${opt} ${variant.label}` : ""} on hand.`);
    }
    const ver = await versionOn(tx, p.id, today);
    if (!ver) throw new UserError(`${p.name} has no price in effect today.`);
    out.push({
      product: p,
      version: ver,
      variant,
      quantity: it.quantity,
      unitAmountMinor: variant?.priceMinor ?? ver.priceMinor,
      description: variant ? variantLineDescription(p.name, opt, variant.label) : p.name,
    });
  }
  return out;
}

export type SaleInput = {
  payerAccountId?: string | null;
  athleteId?: string | null;
  items: SaleItem[];
  payment: { kind: "manual"; method: ManualMethod; reference: string } | { kind: "invoice" };
  today: string;
  isDemo?: boolean;
};

/**
 * Counter sale. Stock is checked under row locks on each product and variant (priceSaleItems), so
 * two registers can't sell the last item twice. Sales tax is worked out by createInvoiceRecord from
 * the products' taxable switch. Payment is either recorded offline now (staff_attested) for the
 * full total including tax, or left as an open invoice to pay through provider checkout.
 */
export async function quickSale(tx: Tx, v: Viewer, input: SaleInput) {
  assertCan(v, "billing.manage");
  const items = input.items.filter((i) => i.quantity > 0);
  if (!items.length) throw new UserError("Add at least one item.");
  if (items.some((i) => !Number.isInteger(i.quantity))) throw new UserError("Quantities must be whole numbers.");
  const payer = input.payerAccountId
    ? (await tx.select().from(payerAccounts).where(and(eq(payerAccounts.id, input.payerAccountId), eq(payerAccounts.orgId, v.orgId))))[0]
    : await walkInPayer(tx, v.orgId);
  if (!payer) throw new UserError("Payer account not found.");
  if (input.athleteId) {
    const [b] = await tx.select().from(payerBeneficiaries).where(and(eq(payerBeneficiaries.payerAccountId, payer.id), eq(payerBeneficiaries.athleteId, input.athleteId)));
    if (!b) throw new UserError("That athlete is not linked to this payer account.");
  }
  const priced = await priceSaleItems(tx, v.orgId, items, input.today);
  const lines: LineInput[] = priced.map((it) => {
    const { product: p, version: ver } = it;
    const grantsCredits = (p.kind === "package" || p.kind === "drop_in" || p.kind === "trial" || p.kind === "assessment") && ver.creditsPerPeriod;
    if (grantsCredits && !input.athleteId) throw new UserError(`${p.name} grants session credits — choose the athlete.`);
    return {
      description: it.description,
      quantity: it.quantity,
      unitAmountMinor: it.unitAmountMinor,
      productVersionId: ver.id,
      variantId: it.variant?.id ?? null,
      athleteId: input.athleteId ?? null,
      entitlement: grantsCredits ? { credits: ver.creditsPerPeriod!, creditExpiryDays: ver.creditExpiryDays ?? undefined, serviceTypeIds: ver.serviceTypeIds } : null,
    };
  });
  const { invoice, lines: created } = await createInvoiceRecord(tx, actorOf(v), {
    orgId: v.orgId,
    payerAccountId: payer.id,
    lines,
    source: "pos",
    status: "open",
    dueDate: input.today,
    isDemo: input.isDemo ?? false,
  });
  await recordSaleMovements(tx, v.orgId, v.userId, priced, created ?? []);
  let paid = false;
  if (input.payment.kind === "manual" && invoice.totalMinor > 0) {
    const r = await recordManualPayment(tx, v, { invoiceId: invoice.id, amountMinor: invoice.totalMinor, method: input.payment.method, reference: input.payment.reference, isDemo: input.isDemo });
    paid = r.invoicePaid;
  }
  await audit(tx, actorOf(v), "billing.pos.sale", "invoice", invoice.id, { summary: `POS sale ${invoice.number} (${input.payment.kind})` });
  return { invoice, paid };
}

/** One "sale" stock movement per tracked line, carrying the variant. Lines come back in the order they were priced. */
export async function recordSaleMovements(tx: Tx, orgId: string, actorUserId: string | null, priced: PricedItem[], created: { id: string; quantity: number }[]) {
  for (const [i, l] of created.entries()) {
    const it = priced[i];
    if (!it?.product.trackInventory) continue;
    await tx.insert(inventoryMovements).values({ orgId, productId: it.product.id, variantId: it.variant?.id ?? null, delta: -l.quantity, reason: "sale", invoiceLineId: l.id, actorUserId });
  }
}
