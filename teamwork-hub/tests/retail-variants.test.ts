import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inventoryMovements, invoiceLines, invoices, productVariants } from "@/db/schema";
import { createProduct, setProductTaxable } from "@/lib/billing/catalog";
import { adjustStock, moveStock, onHandCounts, quickSale, stockByVariant, UNASSIGNED } from "@/lib/billing/pos";
import { addVariants, deleteVariant, moveVariant, setOptionName, updateVariant, variantsByProduct } from "@/lib/billing/variants";
import { setShopListing, shopCheckout, shopItems, shopOrderView } from "@/lib/growth/shop";
import { reportByKey } from "@/lib/reports";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
const SHIRT = "Sample — Team T-Shirt";

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing"] });
  B = ctx.extra.billing;
});
afterAll(closeTestDb);

const invoice = { kind: "invoice" } as const;
const stockOf = async (productId: string) => (await stockByVariant(testDb(), ctx.orgId, [productId]))[productId] ?? {};
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("size variants at the front desk", () => {
  it("the seeded shirt has ordered sizes with stock counted per size and a product total", async () => {
    const db = testDb();
    const vs = (await variantsByProduct(db, ctx.orgId)).get(B.shirtProductId)!;
    expect(vs.map((x) => x.label)).toEqual(["YS", "YM", "YL", "S", "M", "L", "XL"]);
    const st = await stockOf(B.shirtProductId);
    // Seed received 4/4/4/5/6/1/0 and sold one M.
    expect(st[B.shirtSizeM]).toBe(5);
    expect(st[B.shirtSizeL]).toBe(1);
    expect(st[B.shirtSizeXL] ?? 0).toBe(0);
    expect(st[UNASSIGNED] ?? 0).toBe(0);
    expect((await onHandCounts(db, ctx.orgId))[B.shirtProductId]).toBe(23);
  });

  it("a sale must name a size; the size goes on the bill line; stock moves for that size only", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, quantity: 1 }], payment: invoice, today: T }))).rejects.toThrow(/Choose a size/);
    // A size from another product is refused.
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.bottleProductId, variantId: B.shirtSizeM, quantity: 1 }], payment: invoice, today: T }))).rejects.toThrow(/does not belong/);
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeM, quantity: 2 }], payment: { kind: "manual", method: "cash", reference: "TEST-V1" }, today: T }));
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, s.invoice.id));
    expect(line).toMatchObject({ description: `${SHIRT}, Size M`, variantId: B.shirtSizeM, quantity: 2, unitAmountMinor: 2500 });
    const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.invoiceLineId, line.id));
    expect(mv).toMatchObject({ variantId: B.shirtSizeM, delta: -2, reason: "sale" });
    const st = await stockOf(B.shirtProductId);
    expect(st[B.shirtSizeM]).toBe(3);
    expect(st[B.shirtSizeS]).toBe(5);
  });

  it("a size at zero is out of stock; asking for more than is on hand is refused", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeXL, quantity: 1 }], payment: invoice, today: T }))).rejects.toThrow(/Size XL is out of stock/);
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeM, quantity: 4 }], payment: invoice, today: T }))).rejects.toThrow(/Only 3 × .*Size M on hand/);
    // Two cart rows for the same size are added together before the check.
    await expect(
      db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeM, quantity: 2 }, { productId: B.shirtProductId, variantId: B.shirtSizeM, quantity: 2 }], payment: invoice, today: T })),
    ).rejects.toThrow(/Only 3/);
  });

  it("two registers selling the last one of a size at the same moment: exactly one sale goes through", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    expect((await stockOf(B.shirtProductId))[B.shirtSizeL]).toBe(1);
    const sell = (v: typeof erin) => db.transaction((tx) => quickSale(tx, v, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeL, quantity: 1 }], payment: invoice, today: T }));
    const results = await Promise.allSettled([sell(erin), sell(rod), sell(erin), sell(rod)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/out of stock/);
    expect((await stockOf(B.shirtProductId))[B.shirtSizeL]).toBe(0);
    const sold = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.variantId, B.shirtSizeL), eq(inventoryMovements.reason, "sale")));
    expect(sold).toHaveLength(1);
  });

  it("a size can have its own price and SKU; blank means the product price", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await db.transaction((tx) => updateVariant(tx, erin, { variantId: B.shirtSizeS, priceMinor: 2700, sku: "SAMPLE-TEE-S" }));
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeS, quantity: 1 }, { productId: B.shirtProductId, variantId: B.shirtSizeYS, quantity: 1 }], payment: invoice, today: T }));
    const ls = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, s.invoice.id));
    expect(ls.find((l) => l.variantId === B.shirtSizeS)!.unitAmountMinor).toBe(2700);
    expect(ls.find((l) => l.variantId === B.shirtSizeYS)!.unitAmountMinor).toBe(2500);
    expect(s.invoice.totalMinor).toBe(5200);
    await db.transaction((tx) => updateVariant(tx, erin, { variantId: B.shirtSizeS, priceMinor: null }));
    const [row] = await db.select().from(productVariants).where(eq(productVariants.id, B.shirtSizeS));
    expect(row).toMatchObject({ priceMinor: null, sku: "SAMPLE-TEE-S" });
    await expect(db.transaction((tx) => updateVariant(tx, erin, { variantId: B.shirtSizeS, priceMinor: -1 }))).rejects.toThrow(/negative/);
  });

  it("a deactivated size cannot be sold, cannot be deleted once it has history, and its past sales stay intact", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const past = await db.select().from(invoiceLines).where(eq(invoiceLines.variantId, B.shirtSizeM));
    expect(past.length).toBeGreaterThan(0);
    await db.transaction((tx) => updateVariant(tx, erin, { variantId: B.shirtSizeM, active: false }));
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, variantId: B.shirtSizeM, quantity: 1 }], payment: invoice, today: T }))).rejects.toThrow(/no longer sold/);
    await expect(db.transaction((tx) => deleteVariant(tx, erin, B.shirtSizeM))).rejects.toThrow(/Deactivate it instead/);
    const still = await db.select().from(invoiceLines).where(eq(invoiceLines.variantId, B.shirtSizeM));
    expect(still.map((l) => [l.id, l.description, l.amountMinor])).toEqual(past.map((l) => [l.id, l.description, l.amountMinor]));
    expect((await stockOf(B.shirtProductId))[B.shirtSizeM]).toBe(3);
    await db.transaction((tx) => updateVariant(tx, erin, { variantId: B.shirtSizeM, active: true }));
  });

  it("staff can add, rename, reorder and remove an unused size; families and coaches cannot", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const [xxl] = await db.transaction((tx) => addVariants(tx, erin, { productId: B.shirtProductId, labels: ["XXL"] }));
    await expect(db.transaction((tx) => addVariants(tx, erin, { productId: B.shirtProductId, labels: ["xxl"] }))).rejects.toThrow(/already has/);
    await expect(db.transaction((tx) => updateVariant(tx, erin, { variantId: xxl.id, label: "xl" }))).rejects.toThrow(/already has/);
    await db.transaction((tx) => updateVariant(tx, erin, { variantId: xxl.id, label: "2XL" }));
    await db.transaction((tx) => moveVariant(tx, erin, { variantId: xxl.id, direction: "up" }));
    const order = (await variantsByProduct(db, ctx.orgId)).get(B.shirtProductId)!.map((x) => x.label);
    expect(order.slice(-2)).toEqual(["2XL", "XL"]);
    await db.transaction((tx) => deleteVariant(tx, erin, xxl.id));
    expect((await variantsByProduct(db, ctx.orgId)).get(B.shirtProductId)!.map((x) => x.label)).not.toContain("2XL");
    for (const who of ["alex", "marcus"]) {
      const v = await viewerFor(ctx, who);
      await expect(db.transaction((tx) => addVariants(tx, v, { productId: B.shirtProductId, labels: ["3XL"] }))).rejects.toThrow();
    }
    // Only retail products have variants.
    await expect(db.transaction((tx) => addVariants(tx, erin, { productId: B.unlimitedProductId, labels: ["S"] }))).rejects.toThrow(/Only retail/);
  });

  it("a product without variants works as before", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const before = (await onHandCounts(db, ctx.orgId))[B.bottleProductId];
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.bottleProductId, quantity: 1 }], payment: { kind: "manual", method: "cash", reference: "TEST-V2" }, today: T }));
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, s.invoice.id));
    expect(line).toMatchObject({ description: "Sample — Shaker Bottle", variantId: null, taxable: false });
    expect(s.invoice).toMatchObject({ totalMinor: 1200, taxMinor: 0 });
    expect((await onHandCounts(db, ctx.orgId))[B.bottleProductId]).toBe(before - 1);
    await db.transaction((tx) => adjustStock(tx, erin, { productId: B.bottleProductId, delta: 2, reason: "receive" }));
    await expect(db.transaction((tx) => adjustStock(tx, erin, { productId: B.bottleProductId, delta: -1, reason: "adjust" }))).rejects.toThrow(/need a note/);
    expect((await stockOf(B.bottleProductId))[UNASSIGNED]).toBe(before + 1);
  });

  it("stock counted before a product had sizes stays unassigned until staff move it", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const { product } = await db.transaction((tx) => createProduct(tx, erin, { name: "Test Practice Jersey", kind: "retail", trackInventory: true, version: { priceMinor: 1800, effectiveFrom: T } }));
    await db.transaction((tx) => adjustStock(tx, erin, { productId: product.id, delta: 10, reason: "receive" }));
    await db.transaction((tx) => setOptionName(tx, erin, { productId: product.id, optionName: "Cut" }));
    const [youth, adult] = await db.transaction((tx) => addVariants(tx, erin, { productId: product.id, labels: ["Youth", "Adult"] }));
    let st = await stockOf(product.id);
    expect(st).toEqual({ [UNASSIGNED]: 10 });
    // Nothing was guessed: neither cut has stock, so neither can be sold yet.
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: product.id, variantId: youth.id, quantity: 1 }], payment: invoice, today: T }))).rejects.toThrow(/Cut Youth is out of stock/);
    // New stock must name a cut; unassigned stock can only be adjusted.
    await expect(db.transaction((tx) => adjustStock(tx, erin, { productId: product.id, delta: 5, reason: "receive" }))).rejects.toThrow(/Choose which cut/);
    await expect(db.transaction((tx) => moveStock(tx, erin, { productId: product.id, toVariantId: youth.id, quantity: 4, note: " " }))).rejects.toThrow(/note/);
    await expect(db.transaction((tx) => moveStock(tx, erin, { productId: product.id, toVariantId: youth.id, quantity: 11, note: "Shelf count" }))).rejects.toThrow(/Only 10 unassigned/);
    await db.transaction((tx) => moveStock(tx, erin, { productId: product.id, toVariantId: youth.id, quantity: 4, note: "Shelf count" }));
    await db.transaction((tx) => adjustStock(tx, erin, { productId: product.id, variantId: adult.id, delta: 3, reason: "receive" }));
    await db.transaction((tx) => adjustStock(tx, erin, { productId: product.id, delta: -1, reason: "adjust", note: "Damaged, written off" }));
    st = await stockOf(product.id);
    expect(st).toEqual({ [UNASSIGNED]: 5, [youth.id]: 4, [adult.id]: 3 });
    expect((await onHandCounts(db, ctx.orgId))[product.id]).toBe(12);
    await expect(db.transaction((tx) => adjustStock(tx, erin, { productId: product.id, variantId: adult.id, delta: -4, reason: "adjust", note: "Too many" }))).rejects.toThrow(/negative/);
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: product.id, variantId: youth.id, quantity: 1 }], payment: invoice, today: T }));
    expect((await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, s.invoice.id)))[0].description).toBe("Test Practice Jersey, Cut Youth");
    const moves = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.productId, product.id), eq(inventoryMovements.note, "Shelf count")));
    expect(moves.map((m) => [m.variantId, m.delta, m.reason]).sort()).toEqual([[null, -4, "adjust"], [youth.id, 4, "adjust"]].sort());
  });
});

describe("size variants in the Family Shop", () => {
  it("lists a retail item with per-size stock, requires a size, adds tax, takes stock, and reports by size", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const alex = await viewerFor(ctx, "alex");
    await db.transaction((tx) => setShopListing(tx, rod, { productId: B.shirtProductId, sellableOnline: true }));
    await db.transaction((tx) => setProductTaxable(tx, rod, B.shirtProductId, true));
    const item = (await shopItems(db, ctx.orgId, T)).find((i) => i.productId === B.shirtProductId)!;
    expect(item).toMatchObject({ kind: "retail", taxable: true, optionName: "Size", onHand: null });
    expect(item.name).toBe("Sample: Team T-Shirt");
    expect(item.variants.find((x) => x.label === "XL")).toMatchObject({ onHand: 0 });
    expect(item.variants.find((x) => x.label === "L")).toMatchObject({ onHand: 0 });
    const ys = item.variants.find((x) => x.label === "YS")!;
    expect(ys).toMatchObject({ onHand: 3, low: false, priceMinor: 2500 });

    const buy = (variantId?: string) => db.transaction((tx) => shopCheckout(tx, alex, { productId: B.shirtProductId, athleteId: ctx.athletes.maya, idempotencyKey: key(), today: T, variantId }));
    await expect(buy()).rejects.toThrow(/Choose a size/);
    await expect(buy(B.shirtSizeXL)).rejects.toThrow(/out of stock/);
    const k = key();
    const r = await db.transaction((tx) => shopCheckout(tx, alex, { productId: B.shirtProductId, athleteId: ctx.athletes.maya, idempotencyKey: k, today: T, variantId: B.shirtSizeYS }));
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, r.invoiceId));
    expect(inv).toMatchObject({ status: "open", subtotalMinor: 2500, taxMinor: 175, taxRateBps: 700, totalMinor: 2675 });
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(line).toMatchObject({ description: `${SHIRT}, Size YS`, variantId: B.shirtSizeYS, taxable: true });
    expect((await stockOf(B.shirtProductId))[B.shirtSizeYS]).toBe(2);
    // A double click on the same form does not order or take stock twice.
    const again = await db.transaction((tx) => shopCheckout(tx, alex, { productId: B.shirtProductId, athleteId: ctx.athletes.maya, idempotencyKey: k, today: T, variantId: B.shirtSizeYS }));
    expect(again).toMatchObject({ invoiceId: r.invoiceId, created: false });
    expect((await stockOf(B.shirtProductId))[B.shirtSizeYS]).toBe(2);
    const view = (await shopOrderView(db, alex, r.invoiceId))!;
    expect(view).toMatchObject({ productName: "Sample: Team T-Shirt, Size YS", retail: true });
    expect(view.money.balanceMinor).toBe(2675);

    const rep = await reportByKey("growth-shop-sales")!.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    expect(rep.rows.find((x) => x.item === SHIRT && x.variant === "YS")).toMatchObject({ orders: 1, open: 1, ordered_minor: "2675" });
    const retail = await reportByKey("retail-sales")!.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    expect(retail.rows.find((x) => x.item === SHIRT && x.variant === "YS")).toMatchObject({ units: 2, sales_minor: "5000", tax_minor: "175" });
    expect(retail.rows.find((x) => x.item === "Sample — Shaker Bottle")).toMatchObject({ variant: "" });
    await db.transaction((tx) => setProductTaxable(tx, rod, B.shirtProductId, false));
  });
});
