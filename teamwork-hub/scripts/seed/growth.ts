import { and, eq } from "drizzle-orm";
import { creditBuckets, creditLedger, invoiceLines, leads, memberships, membershipEvents, organizations, products, productVersions, users } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { createInvoiceRecord, recordManualPayment } from "../../src/lib/billing/invoices";
import { convertLead } from "../../src/lib/crm/convert";
import type { InquiryInput } from "../../src/lib/crm/intake";
import { createReferredInquiry } from "../../src/lib/growth/intake";
import { ensureReferralCode, syncReferrals } from "../../src/lib/growth/referrals";
import { DEFAULT_GROWTH, type GrowthSettings } from "../../src/lib/growth/settings";
import { setShopListing } from "../../src/lib/growth/shop";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/** Fixed demo referral codes so the public link can be opened in demos and e2e runs. */
export const DEMO_REFERRAL_CODES = { parker: "parkerdemo26", rivera: "riverademo26" } as const;

/**
 * Growth demo data. Everything is synthetic and flagged is_demo. The reward, the "how it works"
 * text and the shop blurbs are SAMPLES (labelled as such), not Teamwork's real reward or prices.
 * Built through the real domain functions wherever one exists.
 * Needs the billing, crm and scheduling seeds; does nothing when they were not run.
 */
export async function seedGrowth(ctx: SeedCtx) {
  const { tx, orgId, today: T } = ctx;
  const B = ctx.extra.billing;
  if (!B || !ctx.extra.crm || !ctx.extra.scheduling) return;
  const viewer = async (key: string): Promise<Viewer> => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.users[key]));
    return { userId: u.id, orgId: u.orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
  };
  const rod = await viewer("rod");
  const erin = await viewer("erin");

  // --- Settings: SAMPLE reward so the screens have something to show ------------------
  const growth: GrowthSettings = {
    referral: {
      ...DEFAULT_GROWTH.referral,
      enabled: true,
      reward: { type: "account_credit", amountMinor: 5000, credits: null, creditExpiryDays: null },
      // Owner decision 2026-11-11: the new family also gets $50 off (their first invoice).
      newFamilyDiscountMinor: 5000,
      howItWorks: "Thank you for telling friends about us. When a new family joins through your link, you get a $50 account credit and they get $50 off their first invoice. (Sample wording for the demo.)",
    },
    offers: DEFAULT_GROWTH.offers,
  };
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  await tx.update(organizations).set({ settings: { ...org.settings, growth } }).where(eq(organizations.id, orgId));

  // --- Shop: two sellable SAMPLE products ---------------------------------------------
  const productByName = async (name: string) => (await tx.select().from(products).where(and(eq(products.orgId, orgId), eq(products.name, name))))[0];
  const pack = await productByName("Sample — 10-Session Pack");
  const assessment = await productByName("Sample — Performance Assessment");
  const dropIn = await productByName("Sample — Drop-in Session");
  await setShopListing(tx, rod, { productId: pack.id, sellableOnline: true, includes: "Sample description: ten group training sessions to use at your own pace." });
  await setShopListing(tx, rod, { productId: assessment.id, sellableOnline: true, includes: "Sample description: a one hour baseline test with a coach and a written summary." });

  // --- Referral codes (fixed only in the demo org; codes are unique across the database) ---
  const fixed = org.slug === "teamwork-demo";
  const parkerCode = (await ensureReferralCode(tx, orgId, ctx.payers.parker, { actorUserId: rod.userId, isDemo: true, code: fixed ? DEMO_REFERRAL_CODES.parker : undefined })).code;
  const riveraCode = (await ensureReferralCode(tx, orgId, ctx.payers.rivera, { actorUserId: rod.userId, isDemo: true, code: fixed ? DEMO_REFERRAL_CODES.rivera : undefined })).code;

  const inquiry = (x: Partial<InquiryInput> & Pick<InquiryInput, "contactFirstName" | "contactLastName">): InquiryInput => ({
    inquiringFor: "child",
    consentEmail: true,
    consentSms: false,
    preferredTimes: ["Weekday evenings"],
    heardFrom: "A friend (sample)",
    ...x,
  });
  // 1) Converted + paid → reward earned, waiting for staff approval.
  const won = await createReferredInquiry(
    tx,
    orgId,
    inquiry({ contactFirstName: "Renee", contactLastName: "Sampleton", email: "renee.sampleton@example.test", athleteFirstName: "Milo", athleteLastName: "Sampleton", athleteAge: 13, sport: "Soccer", goals: "Referred by a friend (sample)" }),
    parkerCode,
    { isDemo: true },
  );
  const conv = await convertLead(tx, erin, { leadId: won.leadId, household: "new", payer: "new", dateOfBirth: `${Number(T.slice(0, 4)) - 13}-01-15`, sport: "Soccer" });
  const [firstPackVer] = await tx.select().from(productVersions).where(eq(productVersions.id, B.packVersionId));
  const inv = await createInvoiceRecord(tx, { orgId, actorUserId: erin.userId, actorRole: "operations" }, {
    orgId,
    payerAccountId: conv.payerAccountId,
    source: "teamwork",
    isDemo: true,
    lines: [{ description: pack.name, unitAmountMinor: firstPackVer.priceMinor, productVersionId: firstPackVer.id, athleteId: conv.athleteId, entitlement: { credits: 10, creditExpiryDays: firstPackVer.creditExpiryDays ?? undefined } }],
  });
  // createInvoiceRecord applied the $50 new-family discount to this first invoice; the family pays the rest.
  await recordManualPayment(tx, erin, { invoiceId: inv.invoice.id, amountMinor: inv.invoice.totalMinor, method: "cash", reference: "SAMPLE-CASH-REFERRAL", notes: "Sample payment", isDemo: true });
  // 2) and 3) Still at the inquiry stage.
  const open1 = await createReferredInquiry(
    tx,
    orgId,
    inquiry({ contactFirstName: "Tomas", contactLastName: "Exampleby", email: "tomas.exampleby@example.test", athleteFirstName: "Ines", athleteLastName: "Exampleby", athleteAge: 15, sport: "Volleyball" }),
    parkerCode,
    { isDemo: true },
  );
  const open2 = await createReferredInquiry(
    tx,
    orgId,
    inquiry({ contactFirstName: "Farah", contactLastName: "Demoski", email: "farah.demoski@example.test", athleteFirstName: "Zane", athleteLastName: "Demoski", athleteAge: 11, sport: "Basketball" }),
    riveraCode,
    { isDemo: true },
  );
  await tx.update(leads).set({ createdAt: new Date(Date.now() - 9 * 86_400_000) }).where(eq(leads.id, open2.leadId));
  await syncReferrals(tx, orgId, T);

  // --- Suggestions for demo athletes ---------------------------------------------------
  // Maya: a sample 10-pack paid by check with 2 sessions left → "session pack running low".
  const [packVer] = await tx.select().from(productVersions).where(eq(productVersions.id, B.packVersionId));
  const mayaInv = await createInvoiceRecord(tx, { orgId, actorUserId: erin.userId, actorRole: "operations" }, {
    orgId,
    payerAccountId: ctx.payers.parker,
    source: "teamwork",
    dueDate: addDaysYmd(T, -40),
    isDemo: true,
    lines: [{ description: pack.name, unitAmountMinor: packVer.priceMinor, productVersionId: packVer.id, athleteId: ctx.athletes.maya, entitlement: { credits: 10, creditExpiryDays: 90 } }],
  });
  await recordManualPayment(tx, erin, { invoiceId: mayaInv.invoice.id, amountMinor: mayaInv.invoice.totalMinor, method: "check", reference: "SAMPLE-CHK-2210", notes: "Sample payment", isDemo: true });
  const [line] = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, mayaInv.invoice.id));
  const [bucket] = await tx.select().from(creditBuckets).where(eq(creditBuckets.sourceInvoiceLineId, line.id));
  await tx.update(creditBuckets).set({ available: 2 }).where(eq(creditBuckets.id, bucket.id));
  await tx.insert(creditLedger).values({ orgId, bucketId: bucket.id, athleteId: ctx.athletes.maya, kind: "adjust", deltaAvailable: -8, actorUserId: erin.userId, reason: "Sample: sessions already used (synthetic demo data)", idempotencyKey: `seed-growth-used:${bucket.id}` });

  // Ella: a sample 1x per week plan; her seeded class bookings reach that limit most weeks → "next plan up".
  if (B.ref_perf_1x_m2m) {
    const [m] = await tx
      .insert(memberships)
      .values({ orgId, athleteId: ctx.athletes.ella, payerAccountId: ctx.payers.ella, productVersionId: B.ref_perf_1x_m2m, status: "active", startDate: addDaysYmd(T, -75), billingProvider: "none", source: "teamwork", isDemo: true })
      .returning();
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: "created", effectiveOn: m.startDate, details: { note: "Sample membership for the growth demo (not billed)" } });
  }

  ctx.extra.growth = { parkerCode, riveraCode, convertedLeadId: won.leadId, openLeadId: open1.leadId, packProductId: pack.id, assessmentProductId: assessment.id };
}
