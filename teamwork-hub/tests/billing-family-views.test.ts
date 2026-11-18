import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { memberships, paymentMethods } from "@/db/schema";
import { billExtras, listInvoices, listMemberships, listPaymentMethods, listPayments, scheduledBills } from "@/lib/billing/queries";
import { navFor } from "@/lib/nav";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-03-02";
let ctx: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  ctx = await seedOrg(T);
});
afterAll(closeTestDb);

describe("family My Profile read models", () => {
  it("bill descriptions come from the bill's own lines and only for bills in the viewer's org", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const rows = await listInvoices(db, alex);
    expect(rows.length).toBeGreaterThan(0);
    const extras = await billExtras(db, alex, rows.map((r) => r.invoice.id));
    for (const r of rows) {
      expect(extras[r.invoice.id]).toBeDefined();
      expect(typeof extras[r.invoice.id].lastAttemptFailed).toBe("boolean");
    }
    expect(Object.values(extras).some((e) => e.description.length > 0)).toBe(true);
    expect(await billExtras(db, alex, [])).toEqual({});
  });

  it("payment history is limited to payer accounts the viewer may see", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const jordan = await viewerFor(ctx, "jordan");
    const chris = await viewerFor(ctx, "chris");
    const mine = await listPayments(db, alex);
    expect(mine.length).toBeGreaterThan(0);
    const alexInvoiceIds = new Set((await listInvoices(db, alex)).map((r) => r.invoice.id));
    expect(mine.every((t) => !t.invoiceId || alexInvoiceIds.has(t.invoiceId))).toBe(true);
    // Jordan may view (not pay) the same account, so sees the same history.
    expect((await listPayments(db, jordan)).map((t) => t.id).sort()).toEqual(mine.map((t) => t.id).sort());
    // Chris is on a different account and sees none of the Parker payments.
    const theirs = new Set((await listPayments(db, chris)).map((t) => t.id));
    expect(mine.some((t) => theirs.has(t.id))).toBe(false);
  });

  it("payment methods show only tokenised details for the viewer's own accounts", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const chris = await viewerFor(ctx, "chris");
    await db.insert(paymentMethods).values({ payerAccountId: ctx.payers.parker, provider: "stripe", providerMethodId: `pm_test_${ctx.payers.parker}`, type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2028, isDefault: true });
    const list = await listPaymentMethods(db, alex);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ brand: "visa", last4: "4242", isDefault: true, payerAccountId: ctx.payers.parker });
    expect(Object.keys(list[0])).not.toContain("providerMethodId");
    expect((await listPaymentMethods(db, chris)).some((m) => m.payerAccountId === ctx.payers.parker)).toBe(false);
  });

  it("upcoming bills preview the next bill of memberships billed here and skip ones billed elsewhere or ending first", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const ms = await listMemberships(db, alex);
    const upcoming = await db.transaction((tx) => scheduledBills(tx, alex));
    for (const u of upcoming) {
      const m = ms.find((x) => x.m.id === u.membershipId)!;
      expect(m).toBeDefined();
      expect(["manual", "stripe", "paypal"]).toContain(m.m.billingProvider);
      expect(["active", "trialing"]).toContain(m.m.status);
      expect(u.dueDate).toBe(m.m.nextBillDate);
      expect(Number.isInteger(u.amountMinor)).toBe(true);
      expect(u.amountMinor).toBeLessThanOrEqual(m.priceMinor);
    }
    const first = upcoming[0];
    if (first) {
      // A membership set to end on or before its next bill date has no upcoming bill.
      await db.update(memberships).set({ cancelAt: first.dueDate }).where(eq(memberships.id, first.membershipId));
      const after = await db.transaction((tx) => scheduledBills(tx, alex));
      expect(after.some((u) => u.membershipId === first.membershipId)).toBe(false);
      await db.update(memberships).set({ cancelAt: null }).where(eq(memberships.id, first.membershipId));
    }
    expect(upcoming.length).toBeGreaterThan(0);
  });
});

describe("family navigation words", () => {
  it("families see My Profile; staff keep Memberships & Billing", () => {
    expect(navFor("guardian").find((n) => n.key === "billing")?.label).toBe("My Profile");
    expect(navFor("athlete").find((n) => n.key === "billing")?.label).toBe("My Profile");
    expect(navFor("owner").find((n) => n.key === "billing")?.label).toBe("Memberships & Billing");
  });
});
