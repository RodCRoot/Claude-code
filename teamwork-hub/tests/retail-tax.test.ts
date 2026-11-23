import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditEvents, inventoryMovements, invoiceLines, invoices, organizations, products, refunds, transactions } from "@/db/schema";
import { createProduct, setProductTaxable } from "@/lib/billing/catalog";
import { createInvoiceRecord, createManualInvoice, invoiceMoney, issueInvoice, voidInvoice } from "@/lib/billing/invoices";
import { adjustStock, onHandCounts, quickSale } from "@/lib/billing/pos";
import { requestRefund } from "@/lib/billing/refunds";
import { salesTaxSettings, saveSalesTax } from "@/lib/billing/sales-tax";
import { allocate, computeTax, formatRate, parseRateToBps, taxOn } from "@/lib/billing/tax";
import { versionOn } from "@/lib/billing/catalog";
import { reportByKey, toCsv } from "@/lib/reports";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

// Real "today": bills are stamped with the clock and the report is by issue date.
const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
/** Fictional products: a taxable drink ($2.99), a taxable hoodie ($25.00), an untaxed bottle (seed, $12.00). */
let drinkId: string;
let hoodieId: string;
const SYSTEM = { orgId: "", actorUserId: null as string | null, actorRole: "system" };

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing"] });
  B = ctx.extra.billing;
  SYSTEM.orgId = ctx.orgId;
  const db = testDb();
  const rod = await viewerFor(ctx, "rod");
  await db.transaction(async (tx) => {
    const d = await createProduct(tx, rod, { name: "Test Fizz Protein Drink", kind: "retail", trackInventory: true, version: { priceMinor: 299, effectiveFrom: T } });
    const h = await createProduct(tx, rod, { name: "Test Hoodie", kind: "retail", trackInventory: true, version: { priceMinor: 2500, effectiveFrom: T } });
    drinkId = d.product.id;
    hoodieId = h.product.id;
    await adjustStock(tx, rod, { productId: drinkId, delta: 200, reason: "receive" });
    await adjustStock(tx, rod, { productId: hoodieId, delta: 200, reason: "receive" });
    await setProductTaxable(tx, rod, drinkId, true);
    await setProductTaxable(tx, rod, hoodieId, true);
  });
});
afterAll(closeTestDb);

const cash = (n: number) => ({ kind: "manual", method: "cash", reference: `TEST-REG-${n}` }) as const;
const linesOf = (invoiceId: string) => testDb().select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
const fresh = async (invoiceId: string) => (await testDb().select().from(invoices).where(eq(invoices.id, invoiceId)))[0];

describe("sales tax arithmetic", () => {
  it("rounds half up to the cent, once per bill", () => {
    expect(taxOn(299, 700)).toBe(21); // $2.99 x 7% = 20.93 cents
    expect(taxOn(50, 700)).toBe(4); // 3.5 cents rounds up
    expect(taxOn(7, 700)).toBe(0); // 0.49 cents
    expect(taxOn(8, 700)).toBe(1); // 0.56 cents
    expect(taxOn(1999, 700)).toBe(140); // 139.93
    expect(taxOn(100, 0)).toBe(0);
    // Three $2.99 drinks on one bill: 897 x 7% = 62.79 -> 63.
    expect(computeTax([{ amountMinor: 299, taxable: true }, { amountMinor: 299, taxable: true }, { amountMinor: 299, taxable: true }], 0, 700).taxMinor).toBe(63);
    // Where per-line and per-bill rounding differ: two 7-cent lines. Per line 0 + 0; per bill 14 x 7% = 0.98 -> 1.
    const two = computeTax([{ amountMinor: 7, taxable: true }, { amountMinor: 7, taxable: true }], 0, 700);
    expect(two.taxMinor).toBe(1);
    expect(two.lines.reduce((s, l) => s + l.taxMinor, 0)).toBe(1);
  });

  it("spreads a price discount across all lines and taxes only the taxable ones", () => {
    const r = computeTax([{ amountMinor: 2500, taxable: true }, { amountMinor: 1200, taxable: false }], 370, 700);
    expect(r.lines.map((l) => l.discountMinor)).toEqual([250, 120]);
    expect(r.taxableMinor).toBe(2250);
    expect(r.taxMinor).toBe(158); // 157.5 rounds up
    expect(r.lines.map((l) => l.taxMinor)).toEqual([158, 0]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [0, 10])).toEqual([0, 5]);
  });

  it("parses and prints rates", () => {
    expect(parseRateToBps("7")).toBe(700);
    expect(parseRateToBps("7.00%")).toBe(700);
    expect(parseRateToBps("7.25")).toBe(725);
    expect(parseRateToBps("")).toBe(0);
    expect(parseRateToBps("seven")).toBeNull();
    expect(parseRateToBps("7.255")).toBeNull();
    expect(formatRate(700)).toBe("7.00%");
  });
});

describe("the rate setting", () => {
  it("defaults to 7.00% Indiana state sales tax, unconfirmed", async () => {
    expect(await salesTaxSettings(testDb(), ctx.orgId)).toEqual({ rateBps: 700, label: "Indiana state sales tax", confirmed: false });
  });

  it("only owner or admin can change it, and the change is audited", async () => {
    const db = testDb();
    for (const who of ["erin", "marcus", "alex"]) {
      const v = await viewerFor(ctx, who);
      await expect(db.transaction((tx) => saveSalesTax(tx, v, { rateBps: 0 }))).rejects.toThrow();
    }
    expect((await salesTaxSettings(db, ctx.orgId)).rateBps).toBe(700);
    const rod = await viewerFor(ctx, "rod");
    await expect(db.transaction((tx) => saveSalesTax(tx, rod, { rateBps: 2600 }))).rejects.toThrow(/0 to 25/);
    await db.transaction((tx) => saveSalesTax(tx, rod, { rateBps: 700, label: "" }));
    expect(await salesTaxSettings(db, ctx.orgId)).toEqual({ rateBps: 700, label: "Indiana state sales tax", confirmed: true });
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "billing.sales_tax.rate"))).orderBy(desc(auditEvents.createdAt)).limit(1);
    expect(a.actorUserId).toBe(rod.userId);
    expect(a.after).toMatchObject({ rateBps: 700, confirmed: true });
  });
});

describe("the taxable switch", () => {
  it("createProduct takes the taxable choice for retail and ignores it for services", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const made = await db.transaction(async (tx) => ({
      gear: await createProduct(tx, rod, { name: "Test Shaker Bottle", kind: "retail", taxable: true, version: { priceMinor: 900, effectiveFrom: "2026-01-01" } }),
      food: await createProduct(tx, rod, { name: "Test Ready Shake", kind: "retail", taxable: false, version: { priceMinor: 400, effectiveFrom: "2026-01-01" } }),
      plain: await createProduct(tx, rod, { name: "Test Unmarked Item", kind: "retail", version: { priceMinor: 400, effectiveFrom: "2026-01-01" } }),
    }));
    expect([made.gear.product.taxable, made.food.product.taxable, made.plain.product.taxable]).toEqual([true, false, false]);
    const service = await db.transaction((tx) => createProduct(tx, rod, { name: "Test Taxless Clinic", kind: "one_time", taxable: true, version: { priceMinor: 4000, effectiveFrom: "2026-01-01" } }));
    expect(service.product.taxable).toBe(false);
    await db.transaction((tx) => setProductTaxable(tx, rod, made.gear.product.id, false));
  });
  it("is off for every seeded and new product, and only retail products can be switched on", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const all = await db.select().from(products).where(eq(products.orgId, ctx.orgId));
    expect(all.filter((p) => p.taxable).map((p) => p.id).sort()).toEqual([drinkId, hoodieId].sort());
    await expect(db.transaction((tx) => setProductTaxable(tx, rod, B.unlimitedProductId, true))).rejects.toThrow(/only be turned on for retail/i);
    const pack = all.find((p) => p.kind === "package")!;
    await expect(db.transaction((tx) => setProductTaxable(tx, rod, pack.id, true))).rejects.toThrow(/retail/i);
    // The database refuses it too, whatever the code does.
    await expect(db.update(products).set({ taxable: true }).where(eq(products.id, B.unlimitedProductId))).rejects.toThrow();
    const alex = await viewerFor(ctx, "alex");
    await expect(db.transaction((tx) => setProductTaxable(tx, alex, drinkId, false))).rejects.toThrow();
  });
});

describe("tax on bills", () => {
  it("front-desk sale of one taxable $2.99 item: 21 cents tax, paid in full including tax", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: drinkId, quantity: 1 }], payment: cash(1), today: T }));
    expect(s.invoice).toMatchObject({ subtotalMinor: 299, discountMinor: 0, taxMinor: 21, taxRateBps: 700, taxableMinor: 299, totalMinor: 320 });
    expect(s.paid).toBe(true);
    const money = await invoiceMoney(db, s.invoice.id);
    expect(money).toMatchObject({ settledMinor: 320, balanceMinor: 0 });
    const [l] = await linesOf(s.invoice.id);
    expect(l).toMatchObject({ taxable: true, taxMinor: 21, discountMinor: 0 });
  });

  it("mixed taxable and untaxed lines: tax on the taxable line only", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }, { productId: B.bottleProductId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    expect(s.invoice).toMatchObject({ subtotalMinor: 3700, taxMinor: 175, taxableMinor: 2500, totalMinor: 3875, status: "open" });
    const ls = await linesOf(s.invoice.id);
    expect(ls.find((l) => l.taxable)).toMatchObject({ amountMinor: 2500, taxMinor: 175 });
    expect(ls.find((l) => !l.taxable)).toMatchObject({ amountMinor: 1200, taxMinor: 0 });
    // The amount a payment provider would be asked for is the balance, tax included.
    expect((await invoiceMoney(db, s.invoice.id)).balanceMinor).toBe(3875);
  });

  it("a bill with no taxable line has no tax and no rate stored", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.bottleProductId, quantity: 2 }], payment: cash(2), today: T }));
    expect(s.invoice).toMatchObject({ subtotalMinor: 2400, taxMinor: 0, taxRateBps: null, taxableMinor: 0, totalMinor: 2400 });
  });

  it("a discount lowers the taxable amount of the line it falls on", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const hv = (await versionOn(db, hoodieId, T))!;
    const bv = (await versionOn(db, B.bottleProductId, T))!;
    const r = await db.transaction((tx) =>
      createManualInvoice(tx, erin, {
        payerAccountId: ctx.payers.parker,
        discountMinor: 370,
        lines: [
          { description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id },
          { description: "Sample bottle", unitAmountMinor: 1200, productVersionId: bv.id },
        ],
      }),
    );
    expect(r.invoice).toMatchObject({ subtotalMinor: 3700, discountMinor: 370, taxableMinor: 2250, taxMinor: 158, totalMinor: 3700 - 370 + 158 });
    // A single fully discounted taxable line owes no tax and settles at $0.
    const free = await db.transaction((tx) => createManualInvoice(tx, erin, { payerAccountId: ctx.payers.parker, discountMinor: 2500, lines: [{ description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id }] }));
    expect(free.invoice).toMatchObject({ taxMinor: 0, totalMinor: 0, taxRateBps: 700 });
    expect((await fresh(free.invoice.id)).status).toBe("paid");
  });

  it("a free-text line or a caller cannot make a service taxable", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const r = await db.transaction((tx) => createManualInvoice(tx, erin, { payerAccountId: ctx.payers.parker, lines: [{ description: "Private lesson", unitAmountMinor: 8000 }] }));
    expect(r.invoice).toMatchObject({ taxMinor: 0, taxRateBps: null, totalMinor: 8000 });
  });

  it("credits reduce the amount due but not the tax; a membership bill with a family rate credit has zero tax", async () => {
    const db = testDb();
    const hv = (await versionOn(db, hoodieId, T))!;
    // $25.00 taxable hoodie with a $5.00 account-style credit: tax stays 7% of $25.00.
    const withCredit = await db.transaction((tx) =>
      createInvoiceRecord(tx, SYSTEM, { orgId: ctx.orgId, payerAccountId: ctx.payers.parker, discountMinor: 500, creditMinor: 500, lines: [{ description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id }] }),
    );
    expect(withCredit.invoice).toMatchObject({ taxableMinor: 2500, taxMinor: 175, totalMinor: 2500 - 500 + 175 });
    // The same $5.00 as a price discount does lower it.
    const withDiscount = await db.transaction((tx) =>
      createInvoiceRecord(tx, SYSTEM, { orgId: ctx.orgId, payerAccountId: ctx.payers.parker, discountMinor: 500, lines: [{ description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id }] }),
    );
    expect(withDiscount.invoice).toMatchObject({ taxableMinor: 2000, taxMinor: 140, totalMinor: 2140 });
    await expect(
      db.transaction((tx) => createInvoiceRecord(tx, SYSTEM, { orgId: ctx.orgId, payerAccountId: ctx.payers.parker, discountMinor: 100, creditMinor: 200, lines: [{ description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id }] })),
    ).rejects.toThrow(/credit/i);

    // Membership line (a service) with a family rate discount and a family rate credit: never taxed.
    const mem = await db.transaction((tx) =>
      createInvoiceRecord(tx, SYSTEM, {
        orgId: ctx.orgId,
        payerAccountId: ctx.payers.parker,
        discountMinor: 3000,
        creditMinor: 1200,
        familyRatePercent: 10,
        source: "membership_renewal",
        lines: [{ description: "Sample membership period", unitAmountMinor: 18000, productVersionId: B.unlimitedVersionId }],
      }),
    );
    expect(mem.invoice).toMatchObject({ taxMinor: 0, taxRateBps: null, taxableMinor: 0, totalMinor: 15000 });
    // Every membership bill the seed produced through the real renewal path is untaxed too.
    const seeded = await db.select().from(invoices).where(and(eq(invoices.orgId, ctx.orgId), sql`${invoices.membershipId} is not null`));
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((i) => i.taxMinor === 0 && i.taxRateBps === null)).toBe(true);
  });

  it("imported history is never taxed", async () => {
    const db = testDb();
    const hv = (await versionOn(db, hoodieId, T))!;
    const r = await db.transaction((tx) => createInvoiceRecord(tx, SYSTEM, { orgId: ctx.orgId, payerAccountId: ctx.payers.parker, source: "imported", lines: [{ description: "Old hoodie sale", unitAmountMinor: 2500, productVersionId: hv.id }] }));
    expect(r.invoice).toMatchObject({ taxMinor: 0, taxRateBps: null, totalMinor: 2500 });
    expect((await linesOf(r.invoice.id))[0].taxable).toBe(false);
  });

  it("a later rate change, or switching the product off, never alters an issued bill; rate 0 charges nothing", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    const before = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    expect(before.invoice).toMatchObject({ taxMinor: 175, taxRateBps: 700, totalMinor: 2675 });
    // A draft is not issued yet: its tax is set when it is issued.
    const hv = (await versionOn(db, hoodieId, T))!;
    const draft = await db.transaction((tx) => createManualInvoice(tx, erin, { payerAccountId: ctx.payers.parker, status: "draft", lines: [{ description: "Test Hoodie", unitAmountMinor: 2500, productVersionId: hv.id }] }));
    expect(draft.invoice).toMatchObject({ status: "draft", taxMinor: 175, totalMinor: 2675 });

    await db.transaction((tx) => saveSalesTax(tx, rod, { rateBps: 800 }));
    expect(await fresh(before.invoice.id)).toMatchObject({ taxMinor: 175, taxRateBps: 700, totalMinor: 2675 });
    const after = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    expect(after.invoice).toMatchObject({ taxMinor: 200, taxRateBps: 800, totalMinor: 2700 });
    await db.transaction((tx) => issueInvoice(tx, erin, draft.invoice.id));
    expect(await fresh(draft.invoice.id)).toMatchObject({ status: "open", taxMinor: 200, taxRateBps: 800, totalMinor: 2700 });
    expect((await linesOf(draft.invoice.id))[0].taxMinor).toBe(200);

    await db.transaction((tx) => saveSalesTax(tx, rod, { rateBps: 0 }));
    const zero = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    expect(zero.invoice).toMatchObject({ taxMinor: 0, taxRateBps: 0, totalMinor: 2500 });
    expect(await fresh(after.invoice.id)).toMatchObject({ taxMinor: 200, taxRateBps: 800 });

    await db.transaction((tx) => saveSalesTax(tx, rod, { rateBps: 700 }));
    await db.transaction((tx) => setProductTaxable(tx, rod, hoodieId, false));
    const off = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    expect(off.invoice).toMatchObject({ taxMinor: 0, taxRateBps: null });
    expect(await fresh(before.invoice.id)).toMatchObject({ taxMinor: 175, taxRateBps: 700, totalMinor: 2675 });
    await db.transaction((tx) => setProductTaxable(tx, rod, hoodieId, true));
  });

  it("voiding an unpaid counter sale puts the stock back", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const before = (await onHandCounts(db, ctx.orgId))[hoodieId];
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 3 }], payment: { kind: "invoice" }, today: T }));
    expect((await onHandCounts(db, ctx.orgId))[hoodieId]).toBe(before - 3);
    await db.transaction((tx) => voidInvoice(tx, erin, s.invoice.id, "Customer changed their mind"));
    expect((await onHandCounts(db, ctx.orgId))[hoodieId]).toBe(before);
    const mv = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.productId, hoodieId), eq(inventoryMovements.reason, "return")));
    expect(mv.at(-1)).toMatchObject({ delta: 3 });
  });
});

describe("refunds", () => {
  it("refunding a taxable line refunds its tax; partial refunds are proportional and never exceed the tax charged", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }, { productId: B.bottleProductId, quantity: 1 }], payment: cash(30), today: T }));
    expect(s.invoice).toMatchObject({ taxMinor: 175, totalMinor: 3875 });
    const [charge] = await db.select().from(transactions).where(and(eq(transactions.invoiceId, s.invoice.id), eq(transactions.kind, "manual_payment")));
    const ls = await linesOf(s.invoice.id);
    const hoodie = ls.find((l) => l.taxable)!;
    const bottle = ls.find((l) => !l.taxable)!;
    const row = async (id: string) => (await db.select().from(refunds).where(eq(refunds.id, id)))[0];

    // $10.00 of the hoodie line (price 2500 + tax 175): 1000 x 175 / 2675 = 65.4 -> 65 cents of tax.
    const r1 = await requestRefund(db, rod, { transactionId: charge.id, amountMinor: 1000, reason: "Partial return", reference: "TEST-R1", invoiceLineId: hoodie.id });
    expect(await row(r1.refundId)).toMatchObject({ amountMinor: 1000, taxMinor: 65, invoiceLineId: hoodie.id, status: "succeeded" });
    // More than is left on that line is refused.
    await expect(requestRefund(db, rod, { transactionId: charge.id, amountMinor: 1676, reason: "Too much", reference: "TEST-R2", invoiceLineId: hoodie.id })).rejects.toThrow(/At most 1675/);
    // The rest of the line returns exactly the rest of its tax.
    const r2 = await requestRefund(db, rod, { transactionId: charge.id, amountMinor: 1675, reason: "Rest of the hoodie", reference: "TEST-R3", invoiceLineId: hoodie.id });
    expect((await row(r2.refundId)).taxMinor).toBe(110);
    // The untaxed bottle carries no tax.
    const r3 = await requestRefund(db, rod, { transactionId: charge.id, amountMinor: 1200, reason: "Bottle", reference: "TEST-R4", invoiceLineId: bottle.id });
    expect((await row(r3.refundId)).taxMinor).toBe(0);
    const all = await db.select().from(refunds).where(eq(refunds.transactionId, charge.id));
    expect(all.reduce((s2, r) => s2 + r.taxMinor, 0)).toBe(175);
    expect((await invoiceMoney(db, s.invoice.id)).refundedMinor).toBe(3875);
    // Operations staff cannot refund at all (existing rule).
    await expect(requestRefund(db, erin, { transactionId: charge.id, amountMinor: 1, reason: "x", reference: "y" })).rejects.toThrow();
  });

  it("a whole-bill refund splits tax in proportion to the bill", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: hoodieId, quantity: 1 }, { productId: B.bottleProductId, quantity: 1 }], payment: cash(31), today: T }));
    const [charge] = await db.select().from(transactions).where(and(eq(transactions.invoiceId, s.invoice.id), eq(transactions.kind, "manual_payment")));
    // 1000 x 175 / 3875 = 45.16 -> 45
    const a = await requestRefund(db, rod, { transactionId: charge.id, amountMinor: 1000, reason: "Goodwill", reference: "TEST-R5" });
    const b = await requestRefund(db, rod, { transactionId: charge.id, amountMinor: 2875, reason: "Everything else", reference: "TEST-R6" });
    const rows = await db.select().from(refunds).where(eq(refunds.transactionId, charge.id));
    expect(rows.find((r) => r.id === a.refundId)!.taxMinor).toBe(45);
    expect(rows.find((r) => r.id === b.refundId)!.taxMinor).toBe(130);
  });
});

describe("Sales tax collected report", () => {
  it("is limited to financial report roles and its totals match the bills and refunds", async () => {
    const db = testDb();
    const def = reportByKey("sales-tax")!;
    expect(def.cap).toBe("reports.financial");
    expect(def.definition).toMatch(/ACCRUAL/);
    const res = await def.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    const bills = await db.select().from(invoices).where(and(eq(invoices.orgId, ctx.orgId), sql`${invoices.taxRateBps} is not null`, sql`${invoices.status} in ('open','paid','uncollectible')`));
    const rf = await db.select().from(refunds).where(and(eq(refunds.orgId, ctx.orgId), eq(refunds.status, "succeeded"), sql`${refunds.taxMinor} > 0`));
    const sum = (k: string) => res.rows.reduce((s, r) => s + Number(r[k]), 0);
    expect(bills.length).toBeGreaterThan(5);
    expect(sum("bills")).toBe(bills.length);
    expect(sum("taxable_minor")).toBe(bills.reduce((s, i) => s + i.taxableMinor, 0));
    expect(sum("tax_minor")).toBe(bills.reduce((s, i) => s + i.taxMinor, 0));
    expect(sum("tax_unpaid_minor")).toBe(bills.filter((i) => i.status !== "paid").reduce((s, i) => s + i.taxMinor, 0));
    expect(sum("tax_refunded_minor")).toBe(rf.reduce((s, r) => s + r.taxMinor, 0));
    expect(sum("tax_refunded_minor")).toBe(175 + 175);
    expect(sum("net_tax_minor")).toBe(sum("tax_minor") - sum("tax_refunded_minor"));
    // Every rate that was in force shows up, and each column is defined in writing.
    const rates = res.rows.map((r) => String(r.rates)).join(" ");
    expect(rates).toContain("7.00%");
    expect(rates).toContain("8.00%");
    expect(res.notes!.length).toBeGreaterThanOrEqual(def.columns.length - 3);
    const csv = toCsv(def.columns, res.rows);
    expect(csv.split("\n")[0]).toBe("Month,Rate(s) in effect,Bills with tax,Taxable sales (USD),Tax collected (USD),…of which on bills not paid (USD),Taxable sales refunded (USD),Tax refunded (USD),Net tax (USD)");
    // A voided taxed bill drops out.
    const erin = await viewerFor(ctx, "erin");
    const v = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: drinkId, quantity: 1 }], payment: { kind: "invoice" }, today: T }));
    const mid = await def.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    expect(mid.rows.reduce((s, r) => s + Number(r.tax_minor), 0)).toBe(sum("tax_minor") + 21);
    await db.transaction((tx) => voidInvoice(tx, erin, v.invoice.id, "Test void"));
    const end = await def.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    expect(end.rows.reduce((s, r) => s + Number(r.tax_minor), 0)).toBe(sum("tax_minor"));
    // The organization row itself was not touched beyond the settings key.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect((org.settings as Record<string, unknown>).salesTax).toMatchObject({ rateBps: 700 });
  });
});
