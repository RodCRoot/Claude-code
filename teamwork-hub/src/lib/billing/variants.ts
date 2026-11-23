import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { inventoryMovements, invoiceLines, products, productVariants } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { actorOf, assertMinor } from "./util";

export const DEFAULT_OPTION_NAME = "Size";
export type Variant = typeof productVariants.$inferSelect;

export const optionNameOf = (p: { optionName: string | null }) => p.optionName?.trim() || DEFAULT_OPTION_NAME;

/** What a bill line and receipt say for a variant sale, e.g. "Teamwork T-Shirt, Size M". */
export function variantLineDescription(productName: string, optionName: string, label: string) {
  return `${productName}, ${optionName} ${label}`;
}

/** Every variant in the org, grouped by product, in display order (inactive ones included). */
export async function variantsByProduct(tx: Tx, orgId: string): Promise<Map<string, Variant[]>> {
  const rows = await tx.select().from(productVariants).where(eq(productVariants.orgId, orgId)).orderBy(asc(productVariants.position), asc(productVariants.createdAt));
  const out = new Map<string, Variant[]>();
  for (const r of rows) out.set(r.productId, [...(out.get(r.productId) ?? []), r]);
  return out;
}

async function lockRetailProduct(tx: Tx, v: Viewer, productId: string) {
  const [p] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.orgId, v.orgId))).for("update");
  if (!p) throw new UserError("Product not found.");
  if (p.kind !== "retail") throw new UserError("Only retail products have variants.");
  return p;
}

function cleanLabel(raw: string) {
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label) throw new UserError("Enter a label, for example M or Youth Large.", { label: "Required" });
  if (label.length > 40) throw new UserError("Keep the label to 40 characters or fewer.", { label: "Too long" });
  return label;
}

function cleanPrice(priceMinor: number | null | undefined) {
  if (priceMinor == null) return null;
  assertMinor(priceMinor, "price");
  if (priceMinor < 0) throw new UserError("Price cannot be negative.", { price: "Invalid" });
  return priceMinor;
}

async function assertLabelFree(tx: Tx, productId: string, label: string, exceptId?: string) {
  const rows = await tx.select({ id: productVariants.id }).from(productVariants).where(and(eq(productVariants.productId, productId), sql`lower(${productVariants.label}) = ${label.toLowerCase()}`));
  if (rows.some((r) => r.id !== exceptId)) throw new UserError(`This product already has a variant called "${label}".`, { label: "Already used" });
}

/**
 * Add one or more variants (labels in the order given, appended after the existing ones).
 * The first variant a product gets does not move any stock: what was counted before stays "unassigned".
 */
export async function addVariants(tx: Tx, v: Viewer, input: { productId: string; labels: string[]; sku?: string | null; priceMinor?: number | null }) {
  assertCan(v, "billing.manage");
  const p = await lockRetailProduct(tx, v, input.productId);
  const labels = input.labels.map(cleanLabel);
  if (!labels.length) throw new UserError("Enter at least one label.", { label: "Required" });
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new UserError("Each label can be listed once.", { label: "Repeated" });
  if (labels.length > 1 && input.sku) throw new UserError("Add variants one at a time to give each its own SKU.", { sku: "One variant at a time" });
  const price = cleanPrice(input.priceMinor);
  const existing = await tx.select().from(productVariants).where(eq(productVariants.productId, p.id));
  if (existing.length + labels.length > 60) throw new UserError("A product can have up to 60 variants.");
  let pos = existing.reduce((m, x) => Math.max(m, x.position), -1);
  const out: Variant[] = [];
  for (const label of labels) {
    await assertLabelFree(tx, p.id, label);
    const [row] = await tx.insert(productVariants).values({ orgId: v.orgId, productId: p.id, label, sku: input.sku?.trim() || null, priceMinor: price, position: ++pos }).returning();
    out.push(row);
  }
  await audit(tx, actorOf(v), "billing.variant.add", "product", p.id, { summary: `${p.name}: added ${labels.join(", ")}`, after: { labels, sku: input.sku ?? null, priceMinor: price } });
  return out;
}

async function loadVariant(tx: Tx, v: Viewer, variantId: string) {
  const [row] = await tx.select().from(productVariants).where(and(eq(productVariants.id, variantId), eq(productVariants.orgId, v.orgId)));
  if (!row) throw new UserError("Variant not found.");
  const p = await lockRetailProduct(tx, v, row.productId);
  return { variant: row, product: p };
}

/** Rename, change SKU / price override (null = the product's price), activate or deactivate. */
export async function updateVariant(tx: Tx, v: Viewer, input: { variantId: string; label?: string; sku?: string | null; priceMinor?: number | null; active?: boolean }) {
  assertCan(v, "billing.manage");
  const { variant, product } = await loadVariant(tx, v, input.variantId);
  const next = {
    label: input.label !== undefined ? cleanLabel(input.label) : variant.label,
    sku: input.sku !== undefined ? input.sku?.trim() || null : variant.sku,
    priceMinor: input.priceMinor !== undefined ? cleanPrice(input.priceMinor) : variant.priceMinor,
    active: input.active ?? variant.active,
  };
  if (next.label.toLowerCase() !== variant.label.toLowerCase()) await assertLabelFree(tx, product.id, next.label, variant.id);
  const [row] = await tx.update(productVariants).set({ ...next, updatedAt: new Date() }).where(eq(productVariants.id, variant.id)).returning();
  const before = { label: variant.label, sku: variant.sku, priceMinor: variant.priceMinor, active: variant.active };
  await audit(tx, actorOf(v), next.active !== variant.active ? (next.active ? "billing.variant.activate" : "billing.variant.deactivate") : "billing.variant.update", "product", product.id, {
    summary: `${product.name}: ${variant.label}${next.label !== variant.label ? ` renamed ${next.label}` : ""}${next.active !== variant.active ? (next.active ? " reactivated" : " deactivated") : " updated"}`,
    before,
    after: next,
  });
  return row;
}

/** Move a variant one place earlier or later in the list. */
export async function moveVariant(tx: Tx, v: Viewer, input: { variantId: string; direction: "up" | "down" }) {
  assertCan(v, "billing.manage");
  const { variant, product } = await loadVariant(tx, v, input.variantId);
  const all = await tx.select().from(productVariants).where(eq(productVariants.productId, product.id)).orderBy(asc(productVariants.position), asc(productVariants.createdAt));
  const i = all.findIndex((x) => x.id === variant.id);
  const j = input.direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j], all[i]];
  for (const [pos, row] of all.entries()) {
    if (row.position !== pos) await tx.update(productVariants).set({ position: pos, updatedAt: new Date() }).where(eq(productVariants.id, row.id));
  }
  await audit(tx, actorOf(v), "billing.variant.reorder", "product", product.id, { summary: `${product.name}: order is now ${all.map((x) => x.label).join(", ")}` });
}

/** Whether a variant has ever been sold or counted. Such a variant can only be deactivated. */
export async function variantHasHistory(tx: Tx, variantId: string) {
  const [m] = await tx.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.variantId, variantId)).limit(1);
  if (m) return true;
  const [l] = await tx.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.variantId, variantId)).limit(1);
  return !!l;
}

/** Remove a variant added by mistake. Refused once it has sales or stock history. */
export async function deleteVariant(tx: Tx, v: Viewer, variantId: string) {
  assertCan(v, "billing.manage");
  const { variant, product } = await loadVariant(tx, v, variantId);
  if (await variantHasHistory(tx, variant.id)) throw new UserError(`${variant.label} has sales or stock history, so it cannot be deleted. Deactivate it instead.`);
  await tx.delete(productVariants).where(eq(productVariants.id, variant.id));
  await audit(tx, actorOf(v), "billing.variant.delete", "product", product.id, { summary: `${product.name}: removed unused variant ${variant.label}`, before: variant });
}

export async function setOptionName(tx: Tx, v: Viewer, input: { productId: string; optionName: string }) {
  assertCan(v, "billing.manage");
  const p = await lockRetailProduct(tx, v, input.productId);
  const name = input.optionName.trim().replace(/\s+/g, " ").slice(0, 30) || null;
  await tx.update(products).set({ optionName: name }).where(eq(products.id, p.id));
  await audit(tx, actorOf(v), "billing.variant.option_name", "product", p.id, { summary: `${p.name}: option is called ${name ?? DEFAULT_OPTION_NAME}`, before: { optionName: p.optionName }, after: { optionName: name } });
}

/** Variant ids that have sales or stock history (for the product page: delete vs deactivate). */
export async function variantIdsWithHistory(tx: Tx, variantIds: string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const a = await tx.selectDistinct({ id: inventoryMovements.variantId }).from(inventoryMovements).where(inArray(inventoryMovements.variantId, variantIds));
  const b = await tx.selectDistinct({ id: invoiceLines.variantId }).from(invoiceLines).where(inArray(invoiceLines.variantId, variantIds));
  return new Set([...a, ...b].map((r) => r.id).filter((x): x is string => !!x));
}
