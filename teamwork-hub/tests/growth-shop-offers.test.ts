import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  athletes,
  auditEvents,
  bookings,
  creditBuckets,
  invoiceLines,
  invoices,
  membershipHolds,
  memberships,
  offerDismissals,
  offerEvents,
  organizations,
  payerBeneficiaries,
  paymentAttempts,
  people,
  products,
  referralRewards,
  scheduleSessions,
  shopListings,
  shopOrders,
  tasks,
} from "@/db/schema";
import { createProduct } from "@/lib/billing/catalog";
import { startCheckout } from "@/lib/billing/checkout";
import { createInvoiceRecord, recordManualPayment } from "@/lib/billing/invoices";
import { acceptOffer, computeOffers, createOfferTask, dismissOffer, familySuggestion, staffOpportunities, type Offer } from "@/lib/growth/offers";
import { setShopListing, shopAthletes, shopBlockReason, shopCheckout, shopItems, shopOrderView } from "@/lib/growth/shop";
import { reportByKey } from "@/lib/reports";
import { addDaysYmd, localToUtc, startOfWeekYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { setGrowth } from "./growth-helpers";

// Real "today": credit expiry and bookings are compared with the clock.
const T = todayLocal();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
let packId: string;
let assessId: string;

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["scheduling", "billing"] });
  B = ctx.extra.billing;
  const db = testDb();
  const byName = async (name: string) => (await db.select().from(products).where(and(eq(products.orgId, ctx.orgId), eq(products.name, name))))[0].id;
  packId = await byName("Sample — 10-Session Pack");
  assessId = await byName("Sample — Performance Assessment");
});
beforeEach(() => {
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) delete process.env[k];
});
afterAll(closeTestDb);

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("Family Shop", () => {
  it("nothing is sellable by default; staff opt products in; capacity items and memberships are refused", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const alex = await viewerFor(ctx, "alex");
    expect(await shopItems(db, ctx.orgId, T)).toHaveLength(0);
    await expect(db.transaction((tx) => setShopListing(tx, alex, { productId: packId, sellableOnline: true }))).rejects.toThrow();
    await expect(db.transaction(async (tx) => setShopListing(tx, await viewerFor(ctx, "marcus"), { productId: packId, sellableOnline: true }))).rejects.toThrow();

    const idOf = async (name: string) => (await db.select().from(products).where(and(eq(products.orgId, ctx.orgId), eq(products.name, name))))[0].id;
    await expect(db.transaction(async (tx) => setShopListing(tx, rod, { productId: await idOf("Sample — Summer Speed Camp"), sellableOnline: true }))).rejects.toThrow(/seat cannot be held online/i);
    await expect(db.transaction(async (tx) => setShopListing(tx, rod, { productId: B.unlimitedProductId, sellableOnline: true }))).rejects.toThrow(/Memberships start from/i);
    await expect(db.transaction(async (tx) => setShopListing(tx, rod, { productId: B.shirtProductId, sellableOnline: true }))).rejects.toThrow(/point of sale/i);
    expect(shopBlockReason("package")).toBeNull();
    expect(shopBlockReason("camp")).toMatch(/not linked to scheduled sessions/);

    await db.transaction((tx) => setShopListing(tx, rod, { productId: packId, sellableOnline: true, includes: "Ten sessions (test)" }));
    await db.transaction((tx) => setShopListing(tx, rod, { productId: assessId, sellableOnline: true }));
    // A free item can be flagged but is never listed (a $0 invoice would settle itself).
    await db.transaction(async (tx) => setShopListing(tx, rod, { productId: (await createProduct(tx, rod, { name: "Free add-on (test)", kind: "one_time", version: { priceMinor: 0, effectiveFrom: addDaysYmd(T, -1) } })).product.id, sellableOnline: true }));
    const items = await shopItems(db, ctx.orgId, T);
    expect(items.map((i) => i.productId).sort()).toEqual([packId, assessId].sort());
    const pack = items.find((i) => i.productId === packId)!;
    expect(pack).toMatchObject({ priceMinor: 25000, currency: "USD", includes: "Ten sessions (test)", name: "Sample: 10-Session Pack" });
    expect(pack.facts).toEqual(["10 session credits", "Use within 90 days of payment"]);
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.action, "growth.shop.listing"), eq(auditEvents.entityId, packId)))).toHaveLength(1);
    // Another org's product cannot be flagged from here.
    const other = await seedOrg(T, { modules: ["billing"] });
    await expect(db.transaction((tx) => setShopListing(tx, rod, { productId: other.extra.billing.unlimitedProductId, sellableOnline: true }))).rejects.toThrow(/not found/i);
  });

  it("guardian flags: Alex buys for Maya and Eli; Jordan (view only) and Casey (no payer role) cannot; nobody buys for another family", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    expect((await shopAthletes(db, alex)).map((a) => a.athleteId).sort()).toEqual([ctx.athletes.maya, ctx.athletes.eli].sort());
    for (const who of ["jordan", "casey", "maya", "marcus", "rod"]) expect(await shopAthletes(db, await viewerFor(ctx, who))).toEqual([]);
    expect((await shopAthletes(db, await viewerFor(ctx, "dana"))).map((a) => a.athleteId)).toEqual([ctx.athletes.dana]);
    expect((await shopAthletes(db, await viewerFor(ctx, "sam"))).map((a) => a.athleteId)).toEqual([ctx.athletes.leo]);

    const before = (await db.select().from(invoices).where(eq(invoices.orgId, ctx.orgId))).length;
    const attempt = (who: string, athleteId: string) => db.transaction(async (tx) => shopCheckout(tx, await viewerFor(ctx, who), { productId: packId, athleteId, idempotencyKey: key(), today: T }));
    await expect(attempt("jordan", ctx.athletes.maya)).rejects.toThrow(/not authorized to make purchases/i);
    await expect(attempt("casey", ctx.athletes.leo)).rejects.toThrow(/not authorized/i);
    await expect(attempt("alex", ctx.athletes.ava)).rejects.toThrow(/not authorized/i); // Chris's daughter
    await expect(attempt("alex", ctx.athletes.leo)).rejects.toThrow(/not authorized/i);
    await expect(attempt("maya", ctx.athletes.maya)).rejects.toThrow(/not authorized/i); // minor athlete login is not a payer
    await expect(attempt("rod", ctx.athletes.maya)).rejects.toThrow(/shop is for families/i);
    await expect(attempt("marcus", ctx.athletes.maya)).rejects.toThrow();
    expect((await db.select().from(invoices).where(eq(invoices.orgId, ctx.orgId))).length).toBe(before);
  });

  it("checkout creates an OPEN invoice at the catalog price and grants nothing until payment is settled; no provider = honest state", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const erin = await viewerFor(ctx, "erin");
    const k = key();
    // Double click + retry with the same form key → exactly one invoice.
    const results = await Promise.all(Array.from({ length: 5 }, () => db.transaction((tx) => shopCheckout(tx, alex, { productId: packId, athleteId: ctx.athletes.eli, idempotencyKey: k, today: T }))));
    expect(new Set(results.map((r) => r.invoiceId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.onlinePayment === false)).toBe(true); // no provider configured
    const invoiceId = results[0].invoiceId;
    expect(await db.select().from(shopOrders).where(eq(shopOrders.invoiceId, invoiceId))).toHaveLength(1);

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv).toMatchObject({ status: "open", totalMinor: 25000, currency: "USD", payerAccountId: ctx.payers.parker, paidAt: null });
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    expect(line).toMatchObject({ athleteId: ctx.athletes.eli, unitAmountMinor: 25000, quantity: 1, productVersionId: B.packVersionId });
    expect(line.entitlement).toMatchObject({ credits: 10, creditExpiryDays: 90 });
    // NOTHING is granted and nothing was charged or attempted.
    const bucketsFor = () => db.select().from(creditBuckets).where(eq(creditBuckets.sourceInvoiceLineId, line.id));
    expect(await bucketsFor()).toHaveLength(0);
    expect(await db.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId))).toHaveLength(0);
    expect(await db.execute(sql`select 1 from transactions where invoice_id = ${invoiceId}`).then((r) => r.rows)).toHaveLength(0);

    // The existing hosted checkout reports "not configured" and still grants nothing.
    const co = await startCheckout(db, alex, { invoiceId, provider: "stripe", appUrl: "http://x" });
    expect(co.ok).toBe(false);
    expect(co).toMatchObject({ notConfigured: { provider: "stripe" } });
    expect(await bucketsFor()).toHaveLength(0);
    const view = await shopOrderView(db, alex, invoiceId);
    expect(view).toMatchObject({ canPay: true, onlinePayment: false, athleteFirst: "Eli" });
    expect(view!.money.balanceMinor).toBe(25000);
    // Jordan may look at the order (view access) but not pay; Chris sees nothing.
    expect(await shopOrderView(db, await viewerFor(ctx, "jordan"), invoiceId)).toMatchObject({ canPay: false });
    expect(await shopOrderView(db, await viewerFor(ctx, "chris"), invoiceId)).toBeNull();

    // A pending bank payment still grants nothing.
    await db.execute(sql`insert into transactions (org_id, payer_account_id, invoice_id, kind, status, amount_minor, currency, provider, provider_txn_id, verification)
      values (${ctx.orgId}, ${ctx.payers.parker}, ${invoiceId}, 'charge', 'pending', 25000, 'USD', 'stripe', ${"pi_shop_" + invoiceId}, 'provider_verified')`);
    expect(await bucketsFor()).toHaveLength(0);
    await db.execute(sql`delete from transactions where invoice_id = ${invoiceId}`);

    // Front desk records the payment → the existing settle path grants the credits, once.
    const paid = await db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId, amountMinor: 25000, method: "cash", reference: "TEST-FRONT-DESK" }));
    expect(paid.invoicePaid).toBe(true);
    const buckets = await bucketsFor();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ athleteId: ctx.athletes.eli, granted: 10, available: 10, sourceKind: "purchase" });

    const rep = await reportByKey("growth-shop-sales")!.run(db, ctx.orgId, { from: addDaysYmd(T, -1), to: addDaysYmd(T, 1), tz: ctx.tz });
    expect(rep.rows.find((r) => r.item === "Sample — 10-Session Pack")).toMatchObject({ orders: 1, paid: 1, open: 0 });
  });

  it("with a provider configured the order still starts unpaid (payment is confirmed only by the provider)", async () => {
    const db = testDb();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    const dana = await viewerFor(ctx, "dana");
    const r = await db.transaction((tx) => shopCheckout(tx, dana, { productId: assessId, athleteId: ctx.athletes.dana, idempotencyKey: key(), today: T }));
    expect(r.onlinePayment).toBe(true);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, r.invoiceId));
    expect(inv.status).toBe("open");
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r.invoiceId));
    expect(await db.select().from(creditBuckets).where(eq(creditBuckets.sourceInvoiceLineId, line.id))).toHaveLength(0);
  });

  it("refuses items that are not sellable, archived, or switched off between page load and click", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const alex = await viewerFor(ctx, "alex");
    const buy = (productId: string) => db.transaction((tx) => shopCheckout(tx, alex, { productId, athleteId: ctx.athletes.maya, idempotencyKey: key(), today: T }));
    await expect(buy(B.unlimitedProductId)).rejects.toThrow(/not available in the shop/i);
    await expect(buy(B.shirtProductId)).rejects.toThrow(/not available/i);
    await db.transaction((tx) => setShopListing(tx, rod, { productId: assessId, sellableOnline: false }));
    await expect(buy(assessId)).rejects.toThrow(/not available/i);
    await db.transaction((tx) => setShopListing(tx, rod, { productId: assessId, sellableOnline: true }));
    expect((await db.select().from(shopListings).where(eq(shopListings.productId, assessId)))[0].sellableOnline).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

/** Direct membership row (active, not billed) so each rule has a precise fixture. */
async function membership(athleteKey: string, versionId: string, startDaysAgo: number, extra: Partial<typeof memberships.$inferInsert> = {}) {
  const [m] = await testDb()
    .insert(memberships)
    .values({ orgId: ctx.orgId, athleteId: ctx.athletes[athleteKey], payerAccountId: ctx.payers[athleteKey] ?? null, productVersionId: versionId, status: "active", startDate: addDaysYmd(T, -startDaysAgo), billingProvider: "none", ...extra })
    .returning();
  return m;
}
/** One attended class in each of the given past weeks (1 = last week). */
async function attendClasses(athleteKey: string, weeksAgo: number[], perWeek = 1) {
  const db = testDb();
  for (const w of weeksAgo) {
    for (let i = 0; i < perWeek; i++) {
      const day = addDaysYmd(startOfWeekYmd(T), -7 * w + 1 + i);
      const startsAt = localToUtc(day, "20:15");
      const [s] = await db
        .insert(scheduleSessions)
        .values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.gpt, title: "Rule fixture class", startsAt, endsAt: new Date(+startsAt + 3_600_000), timezone: ctx.tz, capacity: 10 })
        .returning();
      await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes[athleteKey], status: "attended" });
    }
  }
}
/** A paid 10-pack for the athlete, then set how many credits are left / when they expire. */
async function paidPack(athleteKey: string, available: number, expiresInDays?: number) {
  const db = testDb();
  const erin = await viewerFor(ctx, "erin");
  const { invoice } = await db.transaction((tx) =>
    createInvoiceRecord(tx, { orgId: ctx.orgId, actorUserId: erin.userId, actorRole: "operations" }, {
      orgId: ctx.orgId,
      payerAccountId: ctx.payers[athleteKey === "maya" ? "parker" : athleteKey === "leo" ? "rivera" : athleteKey],
      lines: [{ description: "Sample — 10-Session Pack", unitAmountMinor: 25000, productVersionId: B.packVersionId, athleteId: ctx.athletes[athleteKey], entitlement: { credits: 10, creditExpiryDays: 90 } }],
    }),
  );
  await db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: 25000, method: "cash", reference: "TEST" }));
  const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
  await db
    .update(creditBuckets)
    .set({ available, ...(expiresInDays != null ? { expiresAt: new Date(Date.now() + expiresInDays * 86_400_000) } : {}) })
    .where(eq(creditBuckets.sourceInvoiceLineId, line.id));
}
const offersFor = async (athleteKey: string, k?: Offer["key"]) => {
  const all = await computeOffers(testDb(), ctx.orgId, { today: T, athleteIds: [ctx.athletes[athleteKey]] });
  return k ? all.filter((o) => o.key === k) : all;
};

describe("helpful offers: each rule with a fixture and a control athlete", () => {
  it("weekly cap reached in 3 of the last 4 weeks → next plan up with the catalog price difference", async () => {
    await membership("ethan", B.ref_perf_1x_m2m, 60);
    await attendClasses("ethan", [1, 2, 4]);
    await membership("sofia", B.ref_perf_1x_m2m, 60); // control: only 2 of the last 4 weeks
    await attendClasses("sofia", [1, 3]);
    await attendClasses("sofia", [5, 6]); // older weeks do not count

    const [o] = await offersFor("ethan", "weekly_cap");
    expect(o).toBeTruthy();
    expect(o.estMonthlyMinor).toBe(23299 - 12900);
    expect(o.evidence[0]).toBe("Reached the weekly limit of 1 in 3 of the last 4 full weeks");
    expect(o.evidence.join(" ")).toMatch(/2x per Week/);
    expect(o.familyText).toContain("$103.99 more per month");
    expect(o.staffAction).toMatchObject({ label: "Start plan change" });
    expect(o.staffAction.href).toMatch(/^\/billing\/memberships\//);
    expect(await offersFor("sofia", "weekly_cap")).toHaveLength(0);

    // No higher plan in the catalog → the rule stays silent (never suggests something that does not exist).
    await membership("liam", B.ref_perf_3x_6mo, 60);
    await attendClasses("liam", [1, 2, 3], 3);
    expect(await offersFor("liam", "weekly_cap")).toHaveLength(0);
    await testDb().delete(memberships).where(eq(memberships.athleteId, ctx.athletes.liam));
  });

  it("purchased credits low (≤ threshold) or expiring soon → renewal; a fuller pack is left alone", async () => {
    await paidPack("liam", 2);
    await paidPack("harper", 9); // control
    const [low] = await offersFor("liam", "credits_low");
    expect(low).toBeTruthy();
    expect(low.evidence[0]).toBe("2 of 10 purchased session credits left (suggest at 2 or fewer)");
    expect(low.estOneTimeMinor).toBe(25000);
    expect(low.estMonthlyMinor).toBeNull();
    expect(low.familyCta).toEqual({ label: "See it in the shop", href: `/shop#item-${packId}` });
    expect(await offersFor("harper", "credits_low")).toHaveLength(0);

    // Threshold is configurable.
    await setGrowth(ctx.orgId, { offers: { lowCreditsThreshold: 1 } });
    expect(await offersFor("liam", "credits_low")).toHaveLength(0);
    await setGrowth(ctx.orgId, { offers: { lowCreditsThreshold: 2 } });

    // Expiring within N days triggers even with plenty left.
    await testDb().update(creditBuckets).set({ expiresAt: new Date(Date.now() + 5 * 86_400_000) }).where(and(eq(creditBuckets.athleteId, ctx.athletes.harper), eq(creditBuckets.sourceKind, "purchase")));
    const [exp] = await offersFor("harper", "credits_low");
    expect(exp.evidence[0]).toMatch(/^9 credits expire on .* \(within 14 days\)$/);
    expect(exp.familyText).toMatch(/There is still time to book them/);
    await testDb().update(creditBuckets).set({ expiresAt: new Date(Date.now() + 60 * 86_400_000) }).where(and(eq(creditBuckets.athleteId, ctx.athletes.harper), eq(creditBuckets.sourceKind, "purchase")));
    expect(await offersFor("harper", "credits_low")).toHaveLength(0);
    // Staff-granted (comp) credits never count as a pack to renew.
    expect(await offersFor("jackson", "credits_low")).toHaveLength(0);
  });

  it("month to month for N months → commitment savings, only when the catalog has a matching commitment plan", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    await membership("ava", B.ref_perf_2x_m2m, 150, { payerAccountId: ctx.payers.chris_parker });
    await membership("harper", B.ref_perf_2x_m2m, 40); // control: too recent
    expect(await offersFor("ava", "commitment_savings")).toHaveLength(0); // no 2x commitment plan yet
    await db.transaction((tx) => createProduct(tx, rod, { name: "Test 2x per Week (6 Months)", kind: "recurring_membership", version: { priceMinor: 20900, interval: "month", classesPerWeek: 2, commitmentMonths: 6, effectiveFrom: addDaysYmd(T, -10) } }));
    const [o] = await offersFor("ava", "commitment_savings");
    expect(o).toBeTruthy();
    expect(o.familyText).toContain("$23.99 less per month");
    expect(o.familyText).toContain("6 month commitment");
    expect(o.estMonthlyMinor).toBeNull(); // the family saves; no revenue figure is claimed
    expect(o.estBasis).toMatch(/Family saves \$23\.99 per month/);
    expect(await offersFor("harper", "commitment_savings")).toHaveLength(0);
    await setGrowth(ctx.orgId, { offers: { monthToMonthMonths: 1 } });
    expect(await offersFor("harper", "commitment_savings")).toHaveLength(1);
    await setGrowth(ctx.orgId, { offers: { monthToMonthMonths: 3 } });
  });

  it("sibling on file but not enrolled → family discount, staff-only until an owner confirms the percent; never infers children", async () => {
    const db = testDb();
    // Ethan is enrolled; add a sibling who is already an athlete on the same billing account.
    const [sibPerson] = await db.insert(people).values({ orgId: ctx.orgId, firstName: "Nico", lastName: "Cole" }).returning();
    const [sib] = await db.insert(athletes).values({ orgId: ctx.orgId, personId: sibPerson.id }).returning();
    await db.insert(payerBeneficiaries).values({ payerAccountId: ctx.payers.ethan, athleteId: sib.id });
    // A child who is NOT an athlete on file (just a person in the household) is never used.
    await db.insert(people).values({ orgId: ctx.orgId, firstName: "Toddler", lastName: "Reyes" });

    const [o] = await offersFor("ethan", "sibling_discount");
    expect(o).toBeTruthy();
    expect(o.title).toBe("Nico is on file but not enrolled");
    expect(o.familyVisible).toBe(false); // 10% vs 15% is unconfirmed in the seed policy
    expect(o.evidence[1]).toMatch(/not confirmed by an owner yet/);
    expect(o.estMonthlyMinor).toBeNull();
    expect(await offersFor("sofia", "sibling_discount")).toHaveLength(0); // control: only child on the account

    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db.update(organizations).set({ settings: { ...org.settings, membershipPolicy: { familyDiscountPercent: 10, unconfirmed: [] } } }).where(eq(organizations.id, ctx.orgId));
    const [confirmed] = await offersFor("ethan", "sibling_discount");
    expect(confirmed.familyVisible).toBe(true);
    expect(confirmed.familyText).toContain("10% off");
    // No family discount configured → no mention at all.
    await db.update(organizations).set({ settings: { ...org.settings, membershipPolicy: { familyDiscountPercent: 0, unconfirmed: [] } } }).where(eq(organizations.id, ctx.orgId));
    expect(await offersFor("ethan", "sibling_discount")).toHaveLength(0);
    await db.update(organizations).set({ settings: org.settings }).where(eq(organizations.id, ctx.orgId));
    // Once the sibling enrolls, the suggestion goes away.
    await db.insert(memberships).values({ orgId: ctx.orgId, athleteId: sib.id, payerAccountId: ctx.payers.ethan, productVersionId: B.ref_perf_1x_m2m, status: "active", startDate: T, billingProvider: "none" });
    expect(await offersFor("ethan", "sibling_discount")).toHaveLength(0);
  });

  it("no baseline test in N months → assessment; a recent assessment or a new member is left alone", async () => {
    const db = testDb();
    await membership("owen", B.unlimitedVersionId, 300);
    await membership("ella", B.unlimitedVersionId, 300); // control: assessed last month
    await membership("zoe", B.unlimitedVersionId, 20); // control: brand new member
    const startsAt = localToUtc(addDaysYmd(T, -30), "12:00");
    const [s] = await db.insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.assessment, title: "Assessment", startsAt, endsAt: new Date(+startsAt + 3_600_000), timezone: ctx.tz, capacity: 1 }).returning();
    await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes.ella, status: "attended" });

    const [o] = await offersFor("owen", "assessment_due");
    expect(o).toBeTruthy();
    expect(o.evidence[0]).toMatch(/^No test session or assessment on file; member since /);
    expect(o.estOneTimeMinor).toBe(9500);
    expect(o.familyCta.href).toBe(`/shop#item-${assessId}`);
    expect(await offersFor("ella", "assessment_due")).toHaveLength(0);
    expect(await offersFor("zoe", "assessment_due")).toHaveLength(0);
    // An old assessment counts as overdue again.
    await db.update(scheduleSessions).set({ startsAt: localToUtc(addDaysYmd(T, -250), "12:00"), endsAt: localToUtc(addDaysYmd(T, -250), "13:00") }).where(eq(scheduleSessions.id, s.id));
    const [again] = await offersFor("ella", "assessment_due");
    expect(again.evidence[0]).toMatch(/^Last test or assessment: /);
  });

  it("In Season ending soon → returning plan; a season with weeks left is left alone", async () => {
    const db = testDb();
    const regular = await membership("mason", B.ref_perf_2x_m2m, 200, { status: "on_hold" });
    const season = await membership("mason", B.ref_in_season_1x, 50, { kind: "in_season", endDate: addDaysYmd(T, 10), cancelAt: addDaysYmd(T, 10) });
    await db.insert(membershipHolds).values({ membershipId: regular.id, startDate: addDaysYmd(T, -50), endDate: addDaysYmd(T, 10), kind: "in_season", relatedMembershipId: season.id });
    await membership("jackson", B.ref_in_season_1x, 20, { kind: "in_season", endDate: addDaysYmd(T, 60), cancelAt: addDaysYmd(T, 60) }); // control

    const [o] = await offersFor("mason", "in_season_ending");
    expect(o).toBeTruthy();
    expect(o.estMonthlyMinor).toBe(23299);
    expect(o.membershipId).toBe(regular.id);
    expect(o.familyText).toMatch(/In Season plan ends on /);
    expect(o.familyText).toMatch(/picks back up the next day/);
    expect(o.staffAction.href).toBe(`/billing/memberships/${regular.id}`);
    expect(await offersFor("jackson", "in_season_ending")).toHaveLength(0);
    // In Season plans are never offered as "the next plan up".
    expect((await offersFor("mason", "weekly_cap")).length).toBe(0);
  });

  it("every offer carries evidence and family copy with no pressure language or em dashes", async () => {
    const all = await computeOffers(testDb(), ctx.orgId, { today: T });
    expect(new Set(all.map((o) => o.key)).size).toBeGreaterThanOrEqual(5);
    for (const o of all) {
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.estBasis).toBeTruthy();
      expect(o.familyText).not.toMatch(/[—―]/);
      expect(o.familyText).not.toMatch(/hurry|act now|limited time|last chance|don't miss|only \d+ left|today only|expires in \d+ (hours|minutes)/i);
      expect(o.familyCta.href).toMatch(/^\/(shop|messages)/);
    }
  });
});

describe("who sees suggestions", () => {
  it("staff list is for billing staff; coaches and families are refused; tasks are deduped", async () => {
    const db = testDb();
    for (const who of ["marcus", "tess", "alex", "maya"]) await expect(staffOpportunities(db, await viewerFor(ctx, who), { today: T })).rejects.toThrow();
    const erin = await viewerFor(ctx, "erin");
    const list = await staffOpportunities(db, erin, { today: T });
    expect(list.length).toBeGreaterThan(0);
    const values = list.map((o) => o.estMonthlyMinor ?? o.estOneTimeMinor ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    const only = await staffOpportunities(db, erin, { today: T, athleteId: ctx.athletes.ethan });
    expect(only.every((o) => o.athleteId === ctx.athletes.ethan)).toBe(true);

    const first = await db.transaction((tx) => createOfferTask(tx, erin, { athleteId: ctx.athletes.ethan, offerKey: "weekly_cap", today: T }));
    const second = await db.transaction((tx) => createOfferTask(tx, erin, { athleteId: ctx.athletes.ethan, offerKey: "weekly_cap", today: T }));
    expect([first.created, second.created]).toEqual([true, false]);
    const made = await db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "growth")));
    expect(made).toHaveLength(1);
    expect(made[0].description).toMatch(/Reached the weekly limit/);
    await expect(db.transaction((tx) => createOfferTask(tx, erin, { athleteId: ctx.athletes.sofia, offerKey: "weekly_cap", today: T }))).rejects.toThrow(/no longer applies/i);
    await expect(db.transaction(async (tx) => createOfferTask(tx, await viewerFor(ctx, "marcus"), { athleteId: ctx.athletes.ethan, offerKey: "weekly_cap", today: T }))).rejects.toThrow();
  });

  it("families get at most ONE suggestion; dismissal is stored and respected for the configured period", async () => {
    const db = testDb();
    await paidPack("maya", 1);
    const alex = await viewerFor(ctx, "alex");
    const s1 = await db.transaction((tx) => familySuggestion(tx, alex, { today: T }));
    expect(s1).not.toBeNull();
    expect(Array.isArray(s1)).toBe(false);
    expect(s1).toMatchObject({ key: "credits_low", athleteId: ctx.athletes.maya });
    // Shown is recorded once per person, athlete, rule and day.
    await db.transaction((tx) => familySuggestion(tx, alex, { today: T }));
    expect(await db.select().from(offerEvents).where(and(eq(offerEvents.userId, alex.userId), eq(offerEvents.event, "shown")))).toHaveLength(1);

    const d = await db.transaction((tx) => dismissOffer(tx, alex, { athleteId: ctx.athletes.maya, offerKey: "credits_low", today: T }));
    expect(Math.round((+d.until - Date.now()) / 86_400_000)).toBe(30);
    const s2 = await db.transaction((tx) => familySuggestion(tx, alex, { today: T }));
    expect(s2?.key === "credits_low" && s2.athleteId === ctx.athletes.maya).toBe(false);
    // Dismissal is per person: Jordan (who can view billing) still sees it.
    const jordan = await viewerFor(ctx, "jordan");
    expect(await db.transaction((tx) => familySuggestion(tx, jordan, { today: T }))).toMatchObject({ key: "credits_low", athleteId: ctx.athletes.maya });
    // Still hidden near the end of the period; back once it has passed.
    const day29 = new Date(Date.now() + 29 * 86_400_000);
    const day31 = new Date(Date.now() + 31 * 86_400_000);
    const at29 = await db.transaction((tx) => familySuggestion(tx, alex, { today: T, now: day29, record: false }));
    expect(at29?.key === "credits_low" && at29.athleteId === ctx.athletes.maya).toBe(false);
    expect(await db.transaction((tx) => familySuggestion(tx, alex, { today: T, now: day31, record: false }))).toMatchObject({ key: "credits_low", athleteId: ctx.athletes.maya });
    expect(await db.select().from(offerDismissals).where(eq(offerDismissals.userId, alex.userId))).toHaveLength(1);

    // The period is configurable.
    await setGrowth(ctx.orgId, { offers: { dismissalDays: 7 } });
    const d2 = await db.transaction((tx) => dismissOffer(tx, alex, { athleteId: ctx.athletes.maya, offerKey: "credits_low", today: T }));
    expect(Math.round((+d2.until - Date.now()) / 86_400_000)).toBe(7);
    await setGrowth(ctx.orgId, { offers: { dismissalDays: 30 } });

    // Following a suggestion is recorded and leads into the shop.
    const acc = await db.transaction((tx) => acceptOffer(tx, jordan, { athleteId: ctx.athletes.maya, offerKey: "credits_low", today: T }));
    expect(acc.href).toBe(`/shop#item-${packId}`);
    const rep = await reportByKey("growth-offers")!.run(db, ctx.orgId, { from: T, to: T, tz: ctx.tz });
    expect(rep.rows.find((r) => r.offer_key === "credits_low")).toMatchObject({ shown: 2, accepted: 1, dismissed: 1 });
  });

  it("never for guardians who cannot see billing, never for minors' own logins, and the org can turn it off", async () => {
    const db = testDb();
    await paidPack("leo", 1); // Leo now has a live suggestion
    expect((await offersFor("leo", "credits_low")).length).toBe(1);
    const sam = await viewerFor(ctx, "sam");
    expect(await db.transaction((tx) => familySuggestion(tx, sam, { today: T }))).toMatchObject({ athleteId: ctx.athletes.leo });
    // Casey is Leo's guardian but has no billing access.
    const casey = await viewerFor(ctx, "casey");
    expect(await db.transaction((tx) => familySuggestion(tx, casey, { today: T }))).toBeNull();
    await expect(db.transaction((tx) => dismissOffer(tx, casey, { athleteId: ctx.athletes.leo, offerKey: "credits_low", today: T }))).rejects.toThrow();
    await expect(db.transaction((tx) => acceptOffer(tx, casey, { athleteId: ctx.athletes.leo, offerKey: "credits_low", today: T }))).rejects.toThrow();
    // Maya's own (athlete) login is not a payer; Chris cannot touch another family's athlete.
    expect(await db.transaction(async (tx) => familySuggestion(tx, await viewerFor(ctx, "maya"), { today: T }))).toBeNull();
    await expect(db.transaction(async (tx) => dismissOffer(tx, await viewerFor(ctx, "chris"), { athleteId: ctx.athletes.maya, offerKey: "credits_low", today: T }))).rejects.toThrow();
    // Staff and coaches never get the family card.
    for (const who of ["rod", "marcus"]) expect(await db.transaction(async (tx) => familySuggestion(tx, await viewerFor(ctx, who), { today: T }))).toBeNull();

    await setGrowth(ctx.orgId, { offers: { familyFacing: false } });
    expect(await db.transaction((tx) => familySuggestion(tx, sam, { today: T }))).toBeNull();
    expect((await staffOpportunities(db, await viewerFor(ctx, "erin"), { today: T })).length).toBeGreaterThan(0); // staff still see them
    await setGrowth(ctx.orgId, { offers: { familyFacing: true } });
  });
});

describe("demo seed", () => {
  it("seeds a converted referral with a PENDING reward, two sellable sample products and live suggestions", async () => {
    const db = testDb();
    const demo = await seedOrg(T);
    const G = demo.extra.growth;
    expect(G.parkerCode).toMatch(/^[a-z0-9]{8,16}$/);
    const rewards = await db.select().from(referralRewards).where(eq(referralRewards.orgId, demo.orgId));
    expect(rewards.length).toBeGreaterThanOrEqual(1);
    expect(rewards.every((r) => r.status === "pending" && r.isDemo)).toBe(true);
    const items = await shopItems(db, demo.orgId, T);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.name.startsWith("Sample"))).toBe(true);
    const offers = await computeOffers(db, demo.orgId, { today: T });
    expect(offers.some((o) => o.key === "credits_low" && o.athleteId === demo.athletes.maya)).toBe(true);
    const alex = await viewerFor(demo, "alex");
    expect(await db.transaction((tx) => familySuggestion(tx, alex, { today: T, record: false }))).toMatchObject({ key: "credits_low", athleteId: demo.athletes.maya });
  });
});
