import { and, eq } from "drizzle-orm";
import {
  invoices,
  memberships,
  membershipEvents,
  paymentAttempts,
  products,
  refunds,
  transactions,
  users,
} from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { createProduct, createProductVersion } from "../../src/lib/billing/catalog";
import { createInvoiceRecord, recordManualPayment, settleInvoiceIfCovered } from "../../src/lib/billing/invoices";
import { addHold, createMembership } from "../../src/lib/billing/memberships";
import { adjustStock, quickSale } from "../../src/lib/billing/pos";
import { generateRenewals } from "../../src/lib/billing/renewals";
import { refundableMinor } from "../../src/lib/billing/refunds";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Billing demo data. Every product is a "Sample — …" with a PLACEHOLDER price clearly labelled;
 * real prices/policies are the owner's to enter. All rows are synthetic and is_demo.
 * Built through the real domain functions so the seed exercises the same rules as the app.
 */
export async function seedBilling(ctx: SeedCtx) {
  const { tx, orgId, today: T } = ctx;
  const [rodU] = await tx.select().from(users).where(eq(users.id, ctx.users.rod));
  const [erinU] = await tx.select().from(users).where(eq(users.id, ctx.users.erin));
  const rod: Viewer = { userId: rodU.id, orgId, role: "owner", personId: rodU.personId, displayName: rodU.displayName, mfaVerified: true };
  const erin: Viewer = { userId: erinU.id, orgId, role: "operations", personId: erinU.personId, displayName: erinU.displayName, mfaVerified: true };
  const sample = "Placeholder price for demonstration only — not a real Teamwork price.";
  const from = addDaysYmd(T, -365);

  const unlimited = await createProduct(tx, rod, {
    name: "Sample — Unlimited Monthly Membership",
    kind: "recurring_membership",
    description: sample,
    category: "Memberships",
    isDemo: true,
    version: { priceMinor: 19900, interval: "month", unlimited: true, siblingPercentOff: 10, cancellationNoticeDays: 30, effectiveFrom: from },
  });
  // Price history: a scheduled sample price change shows how versions work.
  await createProductVersion(tx, rod, unlimited.product.id, { priceMinor: 20900, interval: "month", unlimited: true, siblingPercentOff: 10, cancellationNoticeDays: 30, effectiveFrom: addDaysYmd(T, 30) });
  const twice = await createProduct(tx, rod, {
    name: "Sample — 2x/Week Monthly Membership",
    kind: "recurring_membership",
    description: sample,
    category: "Memberships",
    isDemo: true,
    version: { priceMinor: 14900, interval: "month", creditsPerPeriod: 8, siblingPercentOff: 10, cancellationNoticeDays: 30, commitmentMonths: 3, effectiveFrom: from },
  });
  const pack = await createProduct(tx, rod, {
    name: "Sample — 10-Session Pack",
    kind: "package",
    description: sample,
    category: "Packages",
    isDemo: true,
    version: { priceMinor: 25000, creditsPerPeriod: 10, creditExpiryDays: 90, effectiveFrom: from },
  });
  await createProduct(tx, rod, { name: "Sample — Drop-in Session", kind: "drop_in", description: sample, category: "Sessions", isDemo: true, version: { priceMinor: 3000, creditsPerPeriod: 1, creditExpiryDays: 30, effectiveFrom: from } });
  const assess = await createProduct(tx, rod, { name: "Sample — Performance Assessment", kind: "assessment", description: sample, category: "Assessments", isDemo: true, version: { priceMinor: 9500, creditsPerPeriod: 1, creditExpiryDays: 60, effectiveFrom: from } });
  await createProduct(tx, rod, { name: "Sample — Summer Speed Camp", kind: "camp", description: sample, category: "Camps", isDemo: true, version: { priceMinor: 30000, effectiveFrom: from } });
  await createProduct(tx, rod, { name: "Sample — Free Trial Week", kind: "trial", description: sample, category: "Trials", isDemo: true, version: { priceMinor: 0, creditsPerPeriod: 2, creditExpiryDays: 7, effectiveFrom: from } });
  const shirt = await createProduct(tx, rod, { name: "Sample — Team T-Shirt", kind: "retail", description: sample, category: "Retail", sku: "SAMPLE-TEE", trackInventory: true, isDemo: true, version: { priceMinor: 2500, effectiveFrom: from } });
  const bottle = await createProduct(tx, rod, { name: "Sample — Shaker Bottle", kind: "retail", description: sample, category: "Retail", sku: "SAMPLE-BTL", trackInventory: true, isDemo: true, version: { priceMinor: 1200, effectiveFrom: from } });
  await adjustStock(tx, rod, { productId: shirt.product.id, delta: 24, reason: "receive", note: "Sample opening stock" });
  await adjustStock(tx, rod, { productId: bottle.product.id, delta: 10, reason: "receive", note: "Sample opening stock" });

  const pay = async (invoiceId: string, method: "cash" | "check" | "personal_venmo" | "zelle", ref: string) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    return recordManualPayment(tx, erin, { invoiceId, amountMinor: inv.totalMinor, method, reference: ref, notes: "Sample payment", isDemo: true });
  };

  // Maya: unlimited monthly, two months paid offline, current month open.
  const maya = await createMembership(tx, rod, { athleteId: ctx.athletes.maya, payerAccountId: ctx.payers.parker, productVersionId: unlimited.version.id, startDate: addDaysYmd(T, -60), billingAnchorDay: Number(addDaysYmd(T, -60).slice(8, 10)), today: T, isDemo: true });
  // Leo: unlimited monthly, then placed on hold.
  const leo = await createMembership(tx, rod, { athleteId: ctx.athletes.leo, payerAccountId: ctx.payers.rivera, productVersionId: unlimited.version.id, startDate: addDaysYmd(T, -45), today: T, isDemo: true });
  await generateRenewals(tx, orgId, addDaysYmd(T, -1));
  for (const m of [maya.membership, leo.membership]) {
    const invs = await tx.select().from(invoices).where(eq(invoices.membershipId, m.id));
    let i = 0;
    for (const inv of invs.sort((a, b) => (a.periodStart ?? "").localeCompare(b.periodStart ?? ""))) {
      await pay(inv.id, i % 2 ? "check" : "cash", `SAMPLE-${i % 2 ? "CHK" : "CASH"}-${inv.number}`);
      i++;
    }
  }
  await addHold(tx, rod, { membershipId: leo.membership.id, startDate: addDaysYmd(T, -5), endDate: addDaysYmd(T, 20), reason: "Injury — doctor's note on file (sample)", today: T });

  // Eli: 2x/week with configured sibling discount, first invoice unpaid → past due.
  const eli = await createMembership(tx, rod, { athleteId: ctx.athletes.eli, payerAccountId: ctx.payers.parker, productVersionId: twice.version.id, startDate: addDaysYmd(T, -10), applyFamilyDiscount: true, today: T, isDemo: true });
  // Today's renewals: Maya's current period → open invoice; statuses sync (Eli → past_due, Leo → on_hold).
  await generateRenewals(tx, orgId, T);

  // Aria: imported from Zen Planner, still billed THERE until cutover. Never invoiced here.
  const [ext] = await tx
    .insert(memberships)
    .values({
      orgId,
      athleteId: ctx.athletes.aria,
      payerAccountId: ctx.payers.aria,
      productVersionId: twice.version.id,
      status: "active",
      startDate: addDaysYmd(T, -200),
      nextBillDate: addDaysYmd(T, -2),
      billingAnchorDay: 1,
      billingProvider: "external_zenplanner",
      source: "zenplanner_import",
      isDemo: true,
    })
    .returning();
  await tx.insert(membershipEvents).values({ membershipId: ext.id, type: "imported", effectiveOn: ext.startDate, details: { from: "Zen Planner (sample import)", note: "Billed by Zen Planner until cutover" } });

  // Zoe: 10-pack paid by check → 10 credits granted from the invoice line.
  const zoeInv = await createInvoiceRecord(tx, { orgId, actorUserId: erin.userId, actorRole: "operations" }, {
    orgId,
    payerAccountId: ctx.payers.zoe,
    source: "teamwork",
    dueDate: addDaysYmd(T, -3),
    isDemo: true,
    lines: [{ description: pack.product.name, unitAmountMinor: pack.version.priceMinor, productVersionId: pack.version.id, athleteId: ctx.athletes.zoe, entitlement: { credits: 10, creditExpiryDays: 90 } }],
  });
  await pay(zoeInv.invoice.id, "check", "SAMPLE-CHK-1042");

  // Dana: 10-pack via an ACH-style bank payment that is still PENDING (synthetic; no provider was called).
  const danaInv = await createInvoiceRecord(tx, { orgId, actorUserId: rod.userId, actorRole: "owner" }, {
    orgId,
    payerAccountId: ctx.payers.dana,
    source: "teamwork",
    dueDate: addDaysYmd(T, -2),
    isDemo: true,
    lines: [{ description: pack.product.name, unitAmountMinor: pack.version.priceMinor, productVersionId: pack.version.id, athleteId: ctx.athletes.dana, entitlement: { credits: 10, creditExpiryDays: 90 } }],
  });
  const [att] = await tx
    .insert(paymentAttempts)
    .values({ orgId, invoiceId: danaInv.invoice.id, provider: "stripe", providerRef: `cs_demo_ach_${danaInv.invoice.id}`, amountMinor: danaInv.invoice.totalMinor, currency: "USD", methodType: "us_bank_account", status: "processing", idempotencyKey: `seed-ach-${danaInv.invoice.id}` })
    .returning();
  await tx.insert(transactions).values({
    orgId,
    payerAccountId: ctx.payers.dana,
    invoiceId: danaInv.invoice.id,
    paymentAttemptId: att.id,
    kind: "charge",
    status: "pending",
    amountMinor: danaInv.invoice.totalMinor,
    currency: "USD",
    provider: "stripe",
    providerTxnId: `pi_demo_ach_${danaInv.invoice.id}`,
    methodType: "us_bank_account",
    occurredAt: new Date(Date.now() - 7 * 86_400_000),
    verification: "provider_verified",
    notes: "SYNTHETIC demo row — no provider was contacted",
    isDemo: true,
  });

  // Mason: assessment paid by card (synthetic provider-verified row) — used to demo a refund blocked by missing config.
  const masonInv = await createInvoiceRecord(tx, { orgId, actorUserId: rod.userId, actorRole: "owner" }, {
    orgId,
    payerAccountId: ctx.payers.mason,
    source: "teamwork",
    dueDate: addDaysYmd(T, -12),
    isDemo: true,
    lines: [{ description: assess.product.name, unitAmountMinor: assess.version.priceMinor, productVersionId: assess.version.id, athleteId: ctx.athletes.mason, entitlement: { credits: 1, creditExpiryDays: 60 } }],
  });
  await tx.insert(transactions).values({
    orgId,
    payerAccountId: ctx.payers.mason,
    invoiceId: masonInv.invoice.id,
    kind: "charge",
    status: "settled",
    amountMinor: masonInv.invoice.totalMinor,
    currency: "USD",
    provider: "stripe",
    providerTxnId: `pi_demo_card_${masonInv.invoice.id}`,
    methodType: "card",
    occurredAt: new Date(Date.now() - 12 * 86_400_000),
    settledAt: new Date(Date.now() - 12 * 86_400_000),
    verification: "provider_verified",
    notes: "SYNTHETIC demo row — no provider was contacted",
    isDemo: true,
  });
  await settleInvoiceIfCovered(tx, masonInv.invoice.id, { orgId, actorUserId: null, actorRole: "seed" });

  // Owen: drop-in paid by personal Venmo (staff attested), then a partial offline refund.
  const sale = await quickSale(tx, erin, {
    payerAccountId: ctx.payers.owen,
    athleteId: ctx.athletes.owen,
    items: [{ productId: (await productIdByName(tx, orgId, "Sample — Drop-in Session"))!, quantity: 2 }],
    payment: { kind: "manual", method: "personal_venmo", reference: "SAMPLE @owen-family-demo note 'drop-ins'" },
    today: T,
    isDemo: true,
  });
  const [avaPay] = await tx.select().from(transactions).where(eq(transactions.invoiceId, sale.invoice.id));
  const refundAmt = 3000;
  if ((await refundableMinor(tx, avaPay.id, avaPay.amountMinor)) >= refundAmt) {
    await tx.insert(refunds).values({ orgId, transactionId: avaPay.id, amountMinor: refundAmt, currency: "USD", status: "succeeded", reason: "Session cancelled by facility (sample)", requestedBy: rod.userId, idempotencyKey: `seed-refund-${avaPay.id}` });
    await tx.insert(transactions).values({
      orgId,
      payerAccountId: avaPay.payerAccountId,
      invoiceId: avaPay.invoiceId,
      kind: "refund",
      status: "settled",
      amountMinor: -refundAmt,
      currency: "USD",
      provider: "manual",
      methodType: "offline_refund",
      settledAt: new Date(),
      recordedBy: rod.userId,
      manualReference: "SAMPLE-CASH-REFUND-7",
      verification: "staff_attested",
      notes: `refund-of:${avaPay.id}`,
      isDemo: true,
    });
  }

  // Walk-in retail sale.
  await quickSale(tx, erin, { items: [{ productId: shirt.product.id, quantity: 1 }, { productId: bottle.product.id, quantity: 2 }], payment: { kind: "manual", method: "cash", reference: "SAMPLE-REG-0001" }, today: T, isDemo: true });

  ctx.extra.billing = {
    unlimitedProductId: unlimited.product.id,
    unlimitedVersionId: unlimited.version.id,
    twiceVersionId: twice.version.id,
    packVersionId: pack.version.id,
    shirtProductId: shirt.product.id,
    mayaMembershipId: maya.membership.id,
    leoMembershipId: leo.membership.id,
    eliMembershipId: eli.membership.id,
    sofiaExternalMembershipId: ext.id,
    danaInvoiceId: danaInv.invoice.id,
    masonInvoiceId: masonInv.invoice.id,
    zoeInvoiceId: zoeInv.invoice.id,
  };
}

async function productIdByName(tx: SeedCtx["tx"], orgId: string, name: string) {
  const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.orgId, orgId), eq(products.name, name)));
  return p?.id;
}
