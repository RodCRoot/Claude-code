import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, invoiceLines, invoices, payerAccounts, payerBeneficiaries, people, products, shopListings, shopOrders, type ProductKind } from "@/db/schema";
import { assertCan, AuthzError, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { listCatalog, versionOn } from "@/lib/billing/catalog";
import { UserError } from "@/lib/billing/errors";
import { createInvoiceRecord, invoiceMoney } from "@/lib/billing/invoices";
import { LOW_STOCK_AT, priceSaleItems, recordSaleMovements, stockByVariant, UNASSIGNED } from "@/lib/billing/pos";
import { salesTaxSettings } from "@/lib/billing/sales-tax";
import { optionNameOf, variantsByProduct } from "@/lib/billing/variants";
import { actorOf } from "@/lib/billing/util";
import { ONLINE_PROVIDERS, getProvider } from "@/lib/payments";

/**
 * Family Shop.
 *
 * Only products staff mark "sellable online" appear, and only kinds that need no seat count:
 * session packs, drop-ins, assessments, one-time add-ons and retail goods (picked up at the front
 * desk; stock is taken off the count when the order is placed and put back if the bill is voided). Camps and clinics are sold as events
 * (src/lib/events), where a registration holds a seat on the event itself; catalog "camp" products
 * are not linked to scheduled sessions and stay off the shop. Memberships use the membership flow.
 */
export const SHOP_KINDS: ProductKind[] = ["package", "drop_in", "assessment", "one_time", "retail"];

export const SHOP_KIND_LABEL: Partial<Record<ProductKind, string>> = {
  package: "Session pack",
  drop_in: "Single session",
  assessment: "Assessment",
  one_time: "Add-on",
  retail: "Gear",
};

export function shopBlockReason(kind: ProductKind): string | null {
  if (SHOP_KINDS.includes(kind)) return null;
  if (kind === "camp") return "A catalog camp product is not linked to scheduled sessions, so a seat cannot be held online. Sell camps and clinics as events under Camps & clinics instead.";
  if (kind === "recurring_membership") return "Memberships start from the Memberships page so terms and billing dates are set correctly.";
  if (kind === "trial") return "Trials are issued by staff as trial passes.";
  return "This kind of product cannot be sold online.";
}

/** Staff choose which products families can buy online (Billing → Products). Default is off. */
export async function setShopListing(tx: Tx, v: Viewer, input: { productId: string; sellableOnline: boolean; includes?: string | null }) {
  assertCan(v, "billing.manage");
  const [p] = await tx.select().from(products).where(and(eq(products.id, input.productId), eq(products.orgId, v.orgId)));
  if (!p) throw new UserError("Product not found.");
  if (input.sellableOnline) {
    const block = shopBlockReason(p.kind);
    if (block) throw new UserError(block);
  }
  const includes = (input.includes ?? "").trim().slice(0, 600) || null;
  const [before] = await tx.select().from(shopListings).where(eq(shopListings.productId, p.id));
  await tx
    .insert(shopListings)
    .values({ orgId: v.orgId, productId: p.id, sellableOnline: input.sellableOnline, includes, updatedBy: v.userId })
    .onConflictDoUpdate({ target: shopListings.productId, set: { sellableOnline: input.sellableOnline, includes, updatedBy: v.userId, updatedAt: new Date() } });
  await audit(tx, actorOf(v), "growth.shop.listing", "product", p.id, {
    summary: `${p.name}: ${input.sellableOnline ? "sellable online" : "not sellable online"}`,
    before: before ? { sellableOnline: before.sellableOnline, includes: before.includes } : null,
    after: { sellableOnline: input.sellableOnline, includes },
  });
}

export async function shopListingsByProduct(tx: Tx, orgId: string) {
  const rows = await tx.select().from(shopListings).where(eq(shopListings.orgId, orgId));
  return new Map(rows.map((r) => [r.productId, r]));
}

export type ShopItem = {
  productId: string;
  name: string;
  kind: ProductKind;
  kindLabel: string;
  description: string | null;
  includes: string | null;
  /** Facts from the catalog version (credits, expiry), never invented. */
  facts: string[];
  priceMinor: number;
  currency: string;
  /** Sales tax is added to this item at checkout (retail goods staff marked taxable). */
  taxable: boolean;
  /** Stock on hand when the item is counted and has no variants; null = not counted. */
  onHand: number | null;
  /** Name of the choice the buyer must make ("Size"); null when the item has no variants. */
  optionName: string | null;
  /** Active variants in display order. Empty = nothing to choose. */
  variants: { id: string; label: string; priceMinor: number; onHand: number | null; low: boolean }[];
};

/** Sellable items with the price in effect today. Items without a price above $0 are never listed. */
export async function shopItems(tx: Tx, orgId: string, today: string): Promise<ShopItem[]> {
  const listings = await shopListingsByProduct(tx, orgId);
  const catalog = await listCatalog(tx, orgId, today);
  const out: ShopItem[] = [];
  const variants = await variantsByProduct(tx, orgId);
  const stock = await stockByVariant(tx, orgId);
  for (const c of catalog) {
    const l = listings.get(c.product.id);
    if (!l?.sellableOnline || !c.product.active || !SHOP_KINDS.includes(c.product.kind) || !c.current || c.current.priceMinor <= 0) continue;
    const facts: string[] = [];
    const active = (variants.get(c.product.id) ?? []).filter((x) => x.active);
    if (c.current.creditsPerPeriod) facts.push(`${c.current.creditsPerPeriod} session credit${c.current.creditsPerPeriod === 1 ? "" : "s"}`);
    if (c.current.creditsPerPeriod && c.current.creditExpiryDays) facts.push(`Use within ${c.current.creditExpiryDays} days of payment`);
    out.push({
      productId: c.product.id,
      name: familyName(c.product.name),
      kind: c.product.kind,
      kindLabel: SHOP_KIND_LABEL[c.product.kind] ?? "Item",
      description: c.product.description,
      includes: l.includes,
      facts,
      priceMinor: c.current.priceMinor,
      currency: c.current.currency,
      taxable: c.product.kind === "retail" && c.product.taxable,
      onHand: c.product.trackInventory && !active.length ? (stock[c.product.id]?.[UNASSIGNED] ?? 0) : null,
      optionName: active.length ? optionNameOf(c.product) : null,
      variants: active.map((x) => {
        const n = c.product.trackInventory ? (stock[c.product.id]?.[x.id] ?? 0) : null;
        return { id: x.id, label: x.label, priceMinor: x.priceMinor ?? c.current!.priceMinor, onHand: n, low: n != null && n > 0 && n <= LOW_STOCK_AT };
      }),
    });
  }
  return out.sort((a, b) => SHOP_KINDS.indexOf(a.kind) - SHOP_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** Family-facing text never carries em dashes, even when a product name does. */
export const familyName = (name: string) => name.replace(/\s*[—―]\s*/g, ": ");

export type ShopAthlete = { athleteId: string; name: string; payerAccountId: string };

/**
 * Athletes this viewer may buy for: beneficiaries of a billing account where the viewer is
 * authorized to PAY. View-only payers (Jordan) and guardians with no payer role (Casey) get none.
 */
export async function shopAthletes(tx: Tx, v: Viewer): Promise<ShopAthlete[]> {
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  const payable = await payerAccountIdsFor(tx, v, "pay");
  if (!payable.length) return [];
  const rows = await tx
    .select({ athleteId: athletes.id, first: people.firstName, last: people.lastName, payerAccountId: payerBeneficiaries.payerAccountId })
    .from(payerBeneficiaries)
    .innerJoin(payerAccounts, eq(payerAccounts.id, payerBeneficiaries.payerAccountId))
    .innerJoin(athletes, eq(athletes.id, payerBeneficiaries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(inArray(payerBeneficiaries.payerAccountId, payable), eq(payerAccounts.orgId, v.orgId), eq(athletes.orgId, v.orgId), eq(athletes.active, true)))
    .orderBy(people.firstName);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.athleteId) ? false : (seen.add(r.athleteId), true))).map((r) => ({ athleteId: r.athleteId, name: `${r.first} ${r.last}`, payerAccountId: r.payerAccountId }));
}

/** Whether any hosted checkout provider has credentials. Read-only; nothing is contacted. */
export function onlinePaymentAvailable(): boolean {
  return ONLINE_PROVIDERS.some((p) => getProvider(p).isConfigured());
}

export type ShopCheckoutResult = { invoiceId: string; invoiceNumber: string; created: boolean; onlinePayment: boolean };

/**
 * Shop checkout = an OPEN invoice through the existing invoice flow. It grants nothing: the
 * invoice line carries the entitlement and credits appear only when the invoice is settled by a
 * verified provider webhook or a staff-recorded payment (settleInvoiceIfCovered). No provider is
 * called here; the family continues to the existing hosted checkout from the invoice page.
 * The price comes from the catalog version in effect today, never from the client.
 */
export async function shopCheckout(tx: Tx, v: Viewer, input: { productId: string; athleteId: string; idempotencyKey: string; today: string; variantId?: string | null }): Promise<ShopCheckoutResult> {
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError("The shop is for families. Staff sell from the point of sale.");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.idempotencyKey)) throw new UserError("Please reload the page and try again.");
  const allowed = (await shopAthletes(tx, v)).find((a) => a.athleteId === input.athleteId);
  if (!allowed) throw new AuthzError("You can view this account but are not authorized to make purchases for this athlete.");

  const key = `shop:${v.userId}:${input.idempotencyKey}`;
  // Serialize a double click on the same form; the unique (org, idempotency_key) index is the backstop.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  const [prior] = await tx.select().from(shopOrders).where(and(eq(shopOrders.orgId, v.orgId), eq(shopOrders.idempotencyKey, key)));
  if (prior) {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, prior.invoiceId));
    return { invoiceId: inv.id, invoiceNumber: inv.number, created: false, onlinePayment: onlinePaymentAvailable() };
  }

  const [p] = await tx.select().from(products).where(and(eq(products.id, input.productId), eq(products.orgId, v.orgId))).for("share");
  const [listing] = p ? await tx.select().from(shopListings).where(eq(shopListings.productId, p.id)) : [];
  if (!p || !p.active || !listing?.sellableOnline || !SHOP_KINDS.includes(p.kind)) throw new UserError("That item is not available in the shop right now.");
  const ver = await versionOn(tx, p.id, input.today);
  if (!ver || ver.priceMinor <= 0) throw new UserError("That item is not available in the shop right now.");
  // Retail goods: the same locked stock and variant check the front desk uses (a size must be chosen
  // when the item has sizes; a counted item at zero cannot be ordered).
  const priced = p.kind === "retail" ? await priceSaleItems(tx, v.orgId, [{ productId: p.id, variantId: input.variantId || null, quantity: 1 }], input.today) : null;
  if (!priced && input.variantId) throw new UserError("That item is not available in the shop right now.");
  const unit = priced ? priced[0].unitAmountMinor : ver.priceMinor;
  if (unit <= 0) throw new UserError("That item is not available in the shop right now.");

  const credits = ver.creditsPerPeriod && ver.creditsPerPeriod > 0 ? ver.creditsPerPeriod : null;
  const { invoice, lines: createdLines } = await createInvoiceRecord(tx, actorOf(v), {
    orgId: v.orgId,
    payerAccountId: allowed.payerAccountId,
    status: "open",
    source: "teamwork",
    memo: "Family Shop order",
    isDemo: p.isDemo,
    idempotencyKey: key,
    currency: ver.currency,
    lines: [
      {
        description: priced ? priced[0].description : p.name,
        quantity: 1,
        unitAmountMinor: unit,
        productVersionId: ver.id,
        variantId: priced?.[0].variant?.id ?? null,
        athleteId: allowed.athleteId,
        entitlement: credits ? { credits, creditExpiryDays: ver.creditExpiryDays ?? undefined, serviceTypeIds: ver.serviceTypeIds } : null,
      },
    ],
  });
  if (priced) await recordSaleMovements(tx, v.orgId, v.userId, priced, createdLines ?? []);
  await tx.insert(shopOrders).values({
    orgId: v.orgId,
    invoiceId: invoice.id,
    payerAccountId: allowed.payerAccountId,
    athleteId: allowed.athleteId,
    productId: p.id,
    productVersionId: ver.id,
    placedByUserId: v.userId,
    idempotencyKey: key,
    isDemo: invoice.isDemo,
  });
  await audit(tx, actorOf(v), "growth.shop.order", "invoice", invoice.id, {
    summary: `Shop order ${invoice.number}: ${priced ? priced[0].description : p.name} (${invoice.totalMinor} ${ver.currency}${invoice.taxMinor ? ` including ${invoice.taxMinor} sales tax` : ""}), awaiting payment`,
    after: { productId: p.id, productVersionId: ver.id, athleteId: allowed.athleteId, payerAccountId: allowed.payerAccountId },
  });
  return { invoiceId: invoice.id, invoiceNumber: invoice.number, created: true, onlinePayment: onlinePaymentAvailable() };
}

/** Order confirmation for the family who placed it (payer scope enforced). */
export async function shopOrderView(tx: Tx, v: Viewer, invoiceId: string) {
  const [o] = await tx
    .select({ order: shopOrders, invoice: invoices, productName: products.name, productKind: products.kind, first: people.firstName })
    .from(shopOrders)
    .innerJoin(invoices, eq(invoices.id, shopOrders.invoiceId))
    .innerJoin(products, eq(products.id, shopOrders.productId))
    .innerJoin(athletes, eq(athletes.id, shopOrders.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(shopOrders.invoiceId, invoiceId), eq(shopOrders.orgId, v.orgId)));
  if (!o) return null;
  const viewable = await payerAccountIdsFor(tx, v, "view");
  if (!viewable.includes(o.order.payerAccountId)) return null;
  const canPay = (await payerAccountIdsFor(tx, v, "pay")).includes(o.order.payerAccountId);
  const money = await invoiceMoney(tx, o.invoice.id);
  const [line] = await tx.select({ description: invoiceLines.description }).from(invoiceLines).where(eq(invoiceLines.invoiceId, o.invoice.id)).limit(1);
  const tax = await salesTaxSettings(tx, v.orgId);
  return { invoice: o.invoice, productName: familyName(line?.description ?? o.productName), retail: o.productKind === "retail", taxLabel: tax.label, athleteFirst: o.first, money, canPay, onlinePayment: onlinePaymentAvailable() };
}
