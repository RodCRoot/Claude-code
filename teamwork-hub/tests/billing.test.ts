import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { invoices, membershipEvents, memberships, paymentAttempts, productVersions, refunds, transactions } from "@/db/schema";
import { assertCanPayPayer, assertCanViewPayer, payablePayerIds, viewablePayerIds } from "@/lib/billing/access";
import { createProductVersion, listCatalog, versionOn } from "@/lib/billing/catalog";
import { startCheckout } from "@/lib/billing/checkout";
import { createManualInvoice, invoiceMoney, recordManualPayment, voidInvoice } from "@/lib/billing/invoices";
import { addHold, cancelMembership, changePlan, createMembership, earliestCancelDate } from "@/lib/billing/memberships";
import { onHandCounts, quickSale } from "@/lib/billing/pos";
import { paymentExceptions } from "@/lib/billing/reconciliation";
import { requestRefund } from "@/lib/billing/refunds";
import { generateRenewals } from "@/lib/billing/renewals";
import { listInvoices, listMemberships } from "@/lib/billing/queries";
import { addMonthsYmd, int } from "@/lib/billing/util";
import { decimalToMinor, minorToDecimal } from "@/lib/payments/provider";
import { parseMoneyToMinor } from "@/lib/money";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-03-02";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;

beforeAll(async () => {
  ctx = await seedOrg(T);
  B = ctx.extra.billing;
});
beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID;
});
afterAll(closeTestDb);

describe("authorization: who sees and pays what", () => {
  it("Jordan can view the Parker account but cannot pay; Alex can do both", async () => {
    const db = testDb();
    const jordan = await viewerFor(ctx, "jordan");
    const alex = await viewerFor(ctx, "alex");
    expect(await viewablePayerIds(db, jordan)).toEqual([ctx.payers.parker]);
    expect(await payablePayerIds(db, jordan)).toEqual([]);
    expect(await payablePayerIds(db, alex)).toEqual([ctx.payers.parker]);
    await expect(assertCanPayPayer(db, jordan, ctx.payers.parker)).rejects.toThrow(/not authorized to pay/);
    const jInv = await listInvoices(db, jordan);
    expect(jInv.length).toBeGreaterThan(0);
    expect(jInv.every((r) => r.invoice.payerAccountId === ctx.payers.parker)).toBe(true);
    const open = jInv.find((r) => r.invoice.status === "open")!;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    await expect(startCheckout(db, jordan, { invoiceId: open.invoice.id, provider: "stripe", appUrl: "http://x" })).rejects.toThrow(/not authorized to pay/);
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, open.invoice.id))).toHaveLength(0);
  });

  it("Casey sees nothing for Leo; Chris sees only his own family; coaches see no billing", async () => {
    const db = testDb();
    const casey = await viewerFor(ctx, "casey");
    expect(await viewablePayerIds(db, casey)).toEqual([]);
    expect(await listInvoices(db, casey)).toHaveLength(0);
    expect(await listMemberships(db, casey)).toHaveLength(0);
    await expect(assertCanViewPayer(db, casey, ctx.payers.rivera)).rejects.toThrow();

    const chris = await viewerFor(ctx, "chris");
    const ci = await listInvoices(db, chris);
    expect(ci.every((r) => r.invoice.payerAccountId === ctx.payers.chris_parker)).toBe(true);
    await expect(assertCanViewPayer(db, chris, ctx.payers.parker)).rejects.toThrow();

    for (const coach of ["marcus", "tess"]) {
      const v = await viewerFor(ctx, coach);
      expect(await viewablePayerIds(db, v)).toEqual([]);
      expect(await listInvoices(db, v)).toHaveLength(0);
      expect(await listMemberships(db, v)).toHaveLength(0);
      await expect(assertCanViewPayer(db, v, ctx.payers.parker)).rejects.toThrow();
    }
    const erin = await viewerFor(ctx, "erin");
    expect(await viewablePayerIds(db, erin)).toBe("all");
  });

  it("guardians cannot record payments, create invoices, or refund", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.orgId, ctx.orgId), eq(invoices.status, "open"), eq(invoices.payerAccountId, ctx.payers.parker)));
    await expect(db.transaction((tx) => recordManualPayment(tx, alex, { invoiceId: inv.id, amountMinor: 100, method: "cash", reference: "x" }))).rejects.toThrow();
    await expect(db.transaction((tx) => createManualInvoice(tx, alex, { payerAccountId: ctx.payers.parker, lines: [{ description: "x", unitAmountMinor: 1 }] }))).rejects.toThrow();
    const erin = await viewerFor(ctx, "erin");
    const [txn] = await db.select().from(transactions).where(and(eq(transactions.orgId, ctx.orgId), eq(transactions.kind, "manual_payment")));
    await expect(requestRefund(db, erin, { transactionId: txn.id, amountMinor: 100, reason: "x" })).rejects.toThrow(); // operations lacks billing.refund
  });
});

describe("manual / offline payments", () => {
  it("require a reference and are attributed + staff_attested (never provider_verified)", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const { invoice } = await db.transaction((tx) => createManualInvoice(tx, erin, { payerAccountId: ctx.payers.liam, lines: [{ description: "Sample — Camp", unitAmountMinor: 30000 }] }));
    await expect(db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: 10000, method: "personal_venmo", reference: "   " }))).rejects.toThrow(/reference/);
    await expect(db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: 40000, method: "cash", reference: "R1" }))).rejects.toThrow(/exceeds/);
    const r = await db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: 10000, method: "personal_venmo", reference: "@liam-dad 3/2" }));
    expect(r.invoicePaid).toBe(false);
    expect(r.transaction).toMatchObject({ verification: "staff_attested", recordedBy: erin.userId, provider: "manual", manualReference: "@liam-dad 3/2" });
    expect((await invoiceMoney(db, invoice.id)).balanceMinor).toBe(20000);
    const r2 = await db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: 20000, method: "check", reference: "CHK 55" }));
    expect(r2.invoicePaid).toBe(true);
    // DB backstops: an unattributed staff_attested row or a "verified" manual row is rejected.
    await expect(
      db.insert(transactions).values({ orgId: ctx.orgId, kind: "manual_payment", status: "settled", amountMinor: 1, currency: "USD", provider: "manual", verification: "staff_attested", manualReference: "x" }),
    ).rejects.toThrow();
    await expect(
      db.insert(transactions).values({ orgId: ctx.orgId, kind: "manual_payment", status: "settled", amountMinor: 1, currency: "USD", provider: "manual", verification: "provider_verified" }),
    ).rejects.toThrow();
  });

  it("cannot record an offline payment while a provider payment is still pending", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(
      db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: B.danaInvoiceId, amountMinor: 25000, method: "cash", reference: "dup" })),
    ).rejects.toThrow(/still processing/);
  });

  it("money stays integer cents end to end", async () => {
    expect(() => int(1.5)).toThrow();
    expect(int("12345")).toBe(12345);
    expect(decimalToMinor("10.10")).toBe(1010);
    expect(decimalToMinor("0.07")).toBe(7);
    expect(decimalToMinor("1.005")).toBeNull();
    expect(minorToDecimal(1999)).toBe("19.99");
    expect(parseMoneyToMinor("$1,234.56")).toBe(123456);
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => createManualInvoice(tx, erin, { payerAccountId: ctx.payers.liam, lines: [{ description: "x", unitAmountMinor: 10.5 }] }))).rejects.toThrow(/integer/);
    const { invoice } = await db.transaction((tx) =>
      createManualInvoice(tx, erin, { payerAccountId: ctx.payers.liam, discountMinor: 333, lines: [{ description: "a", unitAmountMinor: 1999, quantity: 3 }] }),
    );
    expect(invoice.subtotalMinor).toBe(5997);
    expect(invoice.totalMinor).toBe(5664);
    const m = await invoiceMoney(db, invoice.id);
    for (const v of Object.values(m)) expect(Number.isInteger(v)).toBe(true);
  });

  it("voiding is blocked once money is recorded", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const { invoice } = await db.transaction((tx) => createManualInvoice(tx, rod, { payerAccountId: ctx.payers.owen, lines: [{ description: "x", unitAmountMinor: 5000 }] }));
    await db.transaction((tx) => recordManualPayment(tx, rod, { invoiceId: invoice.id, amountMinor: 1000, method: "cash", reference: "c1" }));
    await expect(db.transaction((tx) => voidInvoice(tx, rod, invoice.id, "mistake"))).rejects.toThrow(/payments/);
  });
});

describe("refunds", () => {
  it("are blocked (blocked_config) when the provider is not configured — nothing sent, no money entry", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const [card] = await db.select().from(transactions).where(and(eq(transactions.invoiceId, B.masonInvoiceId), eq(transactions.kind, "charge")));
    const before = await db.select().from(transactions).where(eq(transactions.invoiceId, B.masonInvoiceId));
    const r = await requestRefund(db, rod, { transactionId: card.id, amountMinor: 9500, reason: "Customer request" });
    expect(r.status).toBe("blocked_config");
    expect(r.message).toMatch(/not configured/);
    const [row] = await db.select().from(refunds).where(eq(refunds.id, r.refundId));
    expect(row.status).toBe("blocked_config");
    const after = await db.select().from(transactions).where(eq(transactions.invoiceId, B.masonInvoiceId));
    expect(after.length).toBe(before.length);
    // An offline refund (e.g. by check) can still be recorded, staff attested and referenced.
    await expect(requestRefund(db, rod, { transactionId: card.id, amountMinor: 1000, reason: "Partial", offline: true })).rejects.toThrow(/reference/);
    const off = await requestRefund(db, rod, { transactionId: card.id, amountMinor: 1000, reason: "Partial", offline: true, reference: "CHK 9001" });
    expect(off.status).toBe("succeeded");
    expect((await invoiceMoney(db, B.masonInvoiceId)).refundedMinor).toBe(1000);
  });
});

describe("checkout", () => {
  it("returns an honest not-configured error and creates nothing when credentials are missing", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.payerAccountId, ctx.payers.parker), eq(invoices.status, "open")));
    for (const provider of ["stripe", "paypal", "venmo"] as const) {
      const r = await startCheckout(db, alex, { invoiceId: inv.id, provider, appUrl: "http://localhost" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.notConfigured?.provider).toBe(provider);
    }
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, inv.id))).toHaveLength(0);
  });

  it("refuses live keys outside production", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    const { invoice } = await db.transaction((tx) => createManualInvoice(tx, rod, { payerAccountId: ctx.payers.jackson, lines: [{ description: "x", unitAmountMinor: 5000 }] }));
    const r = await startCheckout(db, rod, { invoiceId: invoice.id, provider: "stripe", appUrl: "http://localhost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/live credentials are refused/);
  });
});

describe("catalog versions", () => {
  it("price changes create immutable versions with history; old versions cannot be edited", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const pid = B.unlimitedProductId;
    const before = await db.select().from(productVersions).where(eq(productVersions.productId, pid));
    const latest = before.sort((a, b) => b.version - a.version)[0];
    await expect(db.transaction((tx) => createProductVersion(tx, rod, pid, { priceMinor: 1, interval: "month", unlimited: true, effectiveFrom: latest.effectiveFrom }))).rejects.toThrow(/after/);
    const v = await db.transaction((tx) => createProductVersion(tx, rod, pid, { priceMinor: 21900, interval: "month", unlimited: true, effectiveFrom: addDaysYmd(latest.effectiveFrom, 60) }));
    expect(v.version).toBe(latest.version + 1);
    const after = await db.select().from(productVersions).where(eq(productVersions.productId, pid));
    const prev = after.find((x) => x.id === latest.id)!;
    expect(prev.effectiveTo).toBe(addDaysYmd(v.effectiveFrom, -1));
    expect(prev.priceMinor).toBe(latest.priceMinor);
    await expect(db.update(productVersions).set({ priceMinor: 1 }).where(eq(productVersions.id, latest.id))).rejects.toThrow();
    await expect(db.delete(productVersions).where(eq(productVersions.id, latest.id))).rejects.toThrow();
    expect((await versionOn(db, pid, T))?.priceMinor).toBe(19900);
    const cat = await listCatalog(db, ctx.orgId, T);
    const entry = cat.find((c) => c.product.id === pid)!;
    expect(entry.versions.length).toBe(after.length);
    expect(entry.upcoming.length).toBeGreaterThanOrEqual(2);
    expect(cat.every((c) => c.product.name.startsWith("Sample — "))).toBe(true);
    // Existing memberships keep the version they bought.
    const [maya] = await db.select().from(memberships).where(eq(memberships.id, B.mayaMembershipId));
    expect(maya.productVersionId).toBe(B.unlimitedVersionId);
  });
});

describe("memberships and renewals", () => {
  it("renewal job is idempotent, skips external Zen Planner memberships, and defers held periods", async () => {
    const db = testDb();
    const day = addDaysYmd(T, 40);
    const r1 = await db.transaction((tx) => generateRenewals(tx, ctx.orgId, day));
    const count1 = (await db.select().from(invoices).where(eq(invoices.orgId, ctx.orgId))).length;
    const r2 = await db.transaction((tx) => generateRenewals(tx, ctx.orgId, day));
    const count2 = (await db.select().from(invoices).where(eq(invoices.orgId, ctx.orgId))).length;
    expect(r1.invoicesCreated).toBeGreaterThan(0);
    expect(r2.invoicesCreated).toBe(0);
    expect(count2).toBe(count1);
    expect(r1.skippedExternal).toBe(1);
    expect(await db.select().from(invoices).where(eq(invoices.membershipId, B.sofiaExternalMembershipId))).toHaveLength(0);
    // Leo's hold covered a period start → deferral event; no invoice dated inside the hold.
    const ev = await db.select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, B.leoMembershipId), eq(membershipEvents.type, "renewal_deferred_hold")));
    expect(ev.length).toBeGreaterThan(0);
    const leoInv = await db.select().from(invoices).where(eq(invoices.membershipId, B.leoMembershipId));
    const holdStart = addDaysYmd(T, -5);
    const holdEnd = addDaysYmd(T, 35);
    // The March period was billed (and paid) before the hold was recorded; nothing is billed inside the hold after that.
    expect(leoInv.some((i) => i.periodStart! > T && i.periodStart! >= holdStart && i.periodStart! <= holdEnd)).toBe(false);
    // Billing resumes on the restart date with a partial-month stub, then the 1st.
    expect(leoInv.some((i) => i.periodStart === addDaysYmd(holdEnd, 1))).toBe(true);
    // Concurrent runs also create nothing twice.
    const day2 = addDaysYmd(T, 75);
    await Promise.allSettled([1, 2, 3].map(() => db.transaction((tx) => generateRenewals(tx, ctx.orgId, day2))));
    const dup = await db.execute(sql`select membership_id, period_start, count(*) from invoices where org_id = ${ctx.orgId} and membership_id is not null and status <> 'void' group by 1,2 having count(*) > 1`);
    expect(dup.rows).toHaveLength(0);
  });

  it("external Zen Planner memberships can never be invoiced or changed here", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    await expect(
      db.transaction((tx) => createManualInvoice(tx, rod, { payerAccountId: ctx.payers.aria, membershipId: B.sofiaExternalMembershipId, lines: [{ description: "x", unitAmountMinor: 100 }] })),
    ).rejects.toThrow(/Zen Planner/);
    await expect(db.transaction((tx) => changePlan(tx, rod, { membershipId: B.sofiaExternalMembershipId, toVersionId: B.unlimitedVersionId, effectiveOn: T, today: T }))).rejects.toThrow(/Zen Planner/);
  });

  it("cutover from Zen Planner requires confirmation and a future first bill date", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const { cutoverMembership } = await import("@/lib/billing/memberships");
    const id = B.sofiaExternalMembershipId;
    await expect(db.transaction((tx) => cutoverMembership(tx, rod, { membershipId: id, firstBillDate: addDaysYmd(T, 10), zenPlannerStopped: false, today: T }))).rejects.toThrow(/stopped/);
    await expect(db.transaction((tx) => cutoverMembership(tx, rod, { membershipId: id, firstBillDate: addDaysYmd(T, -1), zenPlannerStopped: true, today: T }))).rejects.toThrow(/today or later/);
    await db.transaction((tx) => cutoverMembership(tx, rod, { membershipId: id, firstBillDate: addDaysYmd(T, 200), zenPlannerStopped: true, today: T }));
    const [m] = await db.select().from(memberships).where(eq(memberships.id, id));
    expect(m.billingProvider).toBe("manual");
    expect(m.nextBillDate).toBe(addDaysYmd(T, 200));
  });

  it("creates with sibling discount, holds, upgrades with history, and cancels honoring notice", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    // Dana has no sibling membership on her payer account → discount refused.
    await expect(
      db.transaction((tx) => createMembership(tx, rod, { athleteId: ctx.athletes.dana, payerAccountId: ctx.payers.dana, productVersionId: B.twiceVersionId, startDate: T, applyFamilyDiscount: true, today: T })),
    ).rejects.toThrow(/Family discount/);
    // Payer must be linked to the athlete.
    await expect(
      db.transaction((tx) => createMembership(tx, rod, { athleteId: ctx.athletes.dana, payerAccountId: ctx.payers.parker, productVersionId: B.twiceVersionId, startDate: T, today: T })),
    ).rejects.toThrow(/not set up to pay/);
    const { membership, firstInvoice } = await db.transaction((tx) =>
      createMembership(tx, rod, { athleteId: ctx.athletes.dana, payerAccountId: ctx.payers.dana, productVersionId: B.twiceVersionId, startDate: T, today: T }),
    );
    expect(membership.status).toBe("pending");
    expect(firstInvoice?.totalMinor).toBe(14900);
    // Paying activates and grants the period's credits once.
    await db.transaction((tx) => recordManualPayment(tx, rod, { invoiceId: firstInvoice!.id, amountMinor: 14900, method: "cash", reference: "R-dana" }));
    const [active] = await db.select().from(memberships).where(eq(memberships.id, membership.id));
    expect(active.status).toBe("active");
    const credits = await db.execute(sql`select sum(granted)::int as g from credit_buckets where membership_id = ${membership.id}`);
    expect((credits.rows[0] as { g: number }).g).toBe(8);

    await expect(db.transaction((tx) => addHold(tx, rod, { membershipId: membership.id, startDate: addDaysYmd(T, 10), endDate: addDaysYmd(T, 5), reason: "x", today: T }))).rejects.toThrow();
    await db.transaction((tx) => addHold(tx, rod, { membershipId: membership.id, startDate: addDaysYmd(T, 10), endDate: addDaysYmd(T, 20), reason: "Vacation", today: T }));
    await expect(db.transaction((tx) => addHold(tx, rod, { membershipId: membership.id, startDate: addDaysYmd(T, 15), endDate: addDaysYmd(T, 25), reason: "Overlap", today: T }))).rejects.toThrow(/overlaps/);

    const up = await db.transaction((tx) => changePlan(tx, rod, { membershipId: membership.id, toVersionId: B.unlimitedVersionId, effectiveOn: addDaysYmd(T, 31), today: T }));
    expect(up).toMatchObject({ direction: "upgrade", scheduled: true });
    // Commitment (3 months, counted from the first full period on the 1st after the stub) beats the 30-day notice.
    expect(membership.commitmentStartsOn).toBe("2026-04-01");
    expect(membership.commitmentEndsOn).toBe("2026-06-30");
    const c = await db.transaction((tx) => cancelMembership(tx, rod, { membershipId: membership.id, requestedOn: T, reason: "Moving", today: T }));
    expect(c.cancelAt).toBe(addMonthsYmd("2026-04-01", 3));
    expect(c.immediate).toBe(false);
    expect(earliestCancelDate({ startDate: "2026-01-01" }, { cancellationNoticeDays: 30, commitmentMonths: 0 }, "2026-03-01")).toBe("2026-03-31");
    // Renewals run up to cancel_at apply the scheduled upgrade and then stop billing.
    await db.transaction((tx) => generateRenewals(tx, ctx.orgId, addDaysYmd(T, 130)));
    const [ended] = await db.select().from(memberships).where(eq(memberships.id, membership.id));
    expect(ended.status).toBe("cancelled");
    expect(ended.productVersionId).toBe(B.unlimitedVersionId);
    const invs = await db.select().from(invoices).where(eq(invoices.membershipId, membership.id));
    expect(invs.every((i) => i.periodStart! < c.cancelAt)).toBe(true);
    const types = (await db.select().from(membershipEvents).where(eq(membershipEvents.membershipId, membership.id))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["created", "activated", "hold_added", "plan_change_scheduled", "plan_changed", "cancel_scheduled", "cancelled"]));
  });
});

describe("POS and exceptions", () => {
  it("sells retail with stock checks and inventory movements", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const before = (await onHandCounts(db, ctx.orgId))[B.shirtProductId];
    await expect(db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, quantity: before + 1 }], payment: { kind: "invoice" }, today: T }))).rejects.toThrow(/on hand/);
    const s = await db.transaction((tx) => quickSale(tx, erin, { items: [{ productId: B.shirtProductId, quantity: 2 }], payment: { kind: "manual", method: "cash", reference: "REG-2" }, today: T }));
    expect(s.paid).toBe(true);
    expect((await onHandCounts(db, ctx.orgId))[B.shirtProductId]).toBe(before - 2);
  });

  it("paymentExceptions surfaces past-due memberships and pending bank payments", async () => {
    const db = testDb();
    const ex = await paymentExceptions(db, ctx.orgId, { today: T });
    expect(ex.some((e) => e.kind === "past_due_membership")).toBe(true);
    expect(ex.some((e) => e.kind === "pending_too_long")).toBe(true);
  });
});
