import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { paymentMethods, formRequests, formTemplates, formTemplateVersions, invoices, jobs, membershipAgreements, memberships, organizations, paymentAttempts, signatures, signupFlows, tasks } from "@/db/schema";
import { agreementBlock, agreementSettingsOf, currentAgreement, DEFAULT_AGREEMENT_SETTINGS, issueMembershipAgreement, requireAgreement, saveAgreementSettings, syncMembershipAgreement, unsignedAgreements } from "@/lib/agreements/issue";
import { buildAgreementTerms, DEFAULT_RESIGN_ON, mergeValues, renderAgreement, resignReasons, unknownMergeFields, type AgreementTerms } from "@/lib/agreements/terms";
import { AUTOPAY_JOB } from "@/lib/billing/autopay";
import { createProduct, createProductVersion } from "@/lib/billing/catalog";
import { MANDATE_TEXT_VERSION } from "@/lib/billing/mandate-text";
import { changePlan, createMembership, cutoverMembership } from "@/lib/billing/memberships";
import { setMembershipAutopay } from "@/lib/billing/payment-methods";
import { generateRenewals } from "@/lib/billing/renewals";
import { loadRequestContext } from "@/lib/forms/context";
import { sha256Hex } from "@/lib/forms/hash";
import { issueRequests } from "@/lib/forms/requests";
import { signRequest } from "@/lib/forms/signing";
import { createDraftVersion, publishVersion, saveDraft } from "@/lib/forms/templates";
import { verifyRequest } from "@/lib/forms/verify";
import { membershipPolicy, saveMembershipPolicy } from "@/lib/membership-policy";
import { checkEligibility } from "@/lib/scheduling/eligibility";
import { choosePayment, choosePlan, completeSignup, publishedPlans, signupCandidates, signupView, startSignupFlow } from "@/lib/signup/flow";
import { addDaysYmd } from "@/lib/time";
import { TEST_WHSEC } from "./fixtures/payments/stripe";
import { activeMethod } from "./billing-helpers";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { extractPdfText } from "./helpers/pdf-text";
import { verifyByEmail } from "./helpers/step-up";

// Monday the 12th: a start today is off the billing day (the 1st), so there is a partial first month.
const T = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let v12: string; // 2x/week, 12-month commitment, $200
let vM2M: string; // 1x/week month to month, $120
let p12: string;
const db = () => testDb();
const who = (k: string) => viewerFor(ctx, k);
const EVID = { ip: "203.0.113.20", userAgent: "vitest", authMethod: "session_password" };

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["billing", "documents", "signup"] });
  const rod = await who("rod");
  const a = await db().transaction((tx) => createProduct(tx, rod, { name: "Test 2x per Week (12 Months)", kind: "recurring_membership", version: { priceMinor: 20000, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2020-01-01" } }));
  const b = await db().transaction((tx) => createProduct(tx, rod, { name: "Test 1x per Week (Month to Month)", kind: "recurring_membership", version: { priceMinor: 12000, interval: "month", classesPerWeek: 1, effectiveFrom: "2020-01-01" } }));
  v12 = a.version.id;
  p12 = a.product.id;
  vM2M = b.version.id;
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await closeTestDb();
});

/** Save the membership policy with a few values changed (the settings form posts every field). */
async function setPolicy(over: Record<string, unknown>) {
  const cur = await db().transaction((tx) => membershipPolicy(tx, ctx.orgId));
  const r = await db().transaction(async (tx) => saveMembershipPolicy(tx, await who("rod"), { ...cur, ...over }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
}

const reqRow = async (id: string) => (await db().select().from(formRequests).where(eq(formRequests.id, id)))[0];
const mRow = async (id: string) => (await db().select().from(memberships).where(eq(memberships.id, id)))[0];

/** Front-desk signature: staff witness the guardian (or adult athlete) in person. */
async function signInPerson(requestId: string, staff = "erin") {
  const v = await who(staff);
  const { signingState } = await import("@/lib/forms/signing");
  for (let i = 0; i < 3; i++) {
    const c = await db().transaction((tx) => loadRequestContext(tx, ctx.orgId, requestId));
    if (!c || c.req.status === "completed") return;
    const st = await db().transaction((tx) => signingState(tx, v, c));
    const opt = st.inPerson.find((o) => st.remainingRequired.includes(o.role)) ?? st.inPerson[0];
    const values: Record<string, unknown> = {};
    for (const f of c.version.fields ?? []) values[`field_${f.key}`] = f.type === "checkbox" ? "on" : f.type === "date" ? "2026-01-01" : f.type === "email" ? "sample@example.test" : f.type === "phone" ? "+1 812 555 0100" : f.type === "select" ? (f.options?.[0] ?? "x") : "Sample";
    await db().transaction((tx) => signRequest(tx, v, { requestId, role: opt.role, typedName: opt.signerName, consent: true, values, inPersonSignerPersonId: opt.signerPersonId, identityAttested: true }, EVID));
  }
}

async function newMembership(athleteKey: string, payerKey: string, versionId: string, start: string, extra: Partial<Parameters<typeof createMembership>[2]> = {}) {
  await db().update(memberships).set({ status: "cancelled", agreementState: "not_required" }).where(and(eq(memberships.athleteId, ctx.athletes[athleteKey]), eq(memberships.orgId, ctx.orgId)));
  return db().transaction(async (tx) => createMembership(tx, await who("rod"), { athleteId: ctx.athletes[athleteKey], payerAccountId: ctx.payers[payerKey], productVersionId: versionId, startDate: start, today: T, requireAgreement: true, ...extra }));
}

describe("merge fields come from the membership, product version and policy", () => {
  it("partial first month, commitment end date in facility-local dates, family discount, notice, holds", async () => {
    // Maya (seeded) is on the Parker account, so Eli's new membership gets the 10% family discount.
    const { membership, firstInvoice, stub } = await newMembership("eli", "parker", v12, T);
    expect(stub).toMatchObject({ periodStart: "2026-10-12", periodEnd: "2026-10-31", nextBillDate: "2026-11-01" });
    const { terms, policy, autopay } = await db().transaction((tx) => buildAgreementTerms(tx, ctx.orgId, membership.id));
    expect(terms).toMatchObject({
      memberName: "Eli Parker",
      payerName: "Alex Parker", // only people allowed to pay are named; Jordan is view-only
      planName: "Test 2x per Week (12 Months)",
      sessionsPerWeek: 2,
      priceMinor: 20000,
      discountPercent: 10,
      netPriceMinor: 18000,
      billingDay: 1,
      startDate: "2026-10-12",
      firstRegularBillDate: "2026-11-01",
      commitmentMonths: 12,
      commitmentStartsOn: "2026-11-01",
      commitmentEndsOn: "2027-10-31",
      noticeDays: 30,
      paymentMethodType: "none",
    });
    // Teamwork half-month rule: 20 of 31 days left → 50% → $100, less 10% family discount = $90.
    expect(terms.firstPartial).toMatchObject({ amountMinor: 10000, netAmountMinor: 9000, periodStart: "2026-10-12", periodEnd: "2026-10-31", billDate: "2026-10-12" });
    expect(firstInvoice).toMatchObject({ totalMinor: 9000, periodStart: "2026-10-12", periodEnd: "2026-10-31" });
    const mv = mergeValues(terms, policy, autopay);
    expect(mv.member_name).toBe("Eli Parker");
    expect(mv.sessions_per_week).toBe("2 sessions per week");
    expect(mv.price).toBe("$200.00 per month");
    expect(mv.price_after_discount).toMatch(/^\$180\.00 per month after Family discount 10%/);
    expect(mv.billing_day).toBe("the 1st of each month");
    expect(mv.first_partial_month).toBe("$90.00 billed on Oct 12, 2026 for Oct 12, 2026 through Oct 31, 2026");
    expect(mv.first_regular_bill_date).toBe("Nov 1, 2026");
    expect(mv.commitment_length).toBe("12 months");
    expect(mv.commitment_end_date).toBe("Oct 31, 2027");
    expect(mv.end_of_term).toMatch(/After Oct 31, 2027 the membership continues month to month at the same price/);
    expect(mv.hold_rules).toMatch(/up to 2 months/);
    expect(mv.cancellation_notice).toBe("30 days written notice; a cancellation cannot take effect before the commitment ends on Oct 31, 2027");
    expect(mv.family_discount).toMatch(/10% off each membership.*currently applied: 10%/);
    expect(mv.payment_terms).toMatch(/3 days and 7 days.*once more after 5 days/);
    expect(mv.ach_authorization).toMatch(/^Not applicable/);
    // Family-facing text never uses em dashes.
    expect(Object.values(mv).join(" ")).not.toMatch(/—/);

    // The issued request carries the rendered text; no braces are left; the template itself is untouched.
    const cur = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    const req = await reqRow(cur.formRequestId);
    expect(req.renderedBodyMarkdown).toContain("**Test 2x per Week (12 Months)**");
    expect(req.renderedBodyMarkdown).toContain("$90.00 billed on Oct 12, 2026");
    expect(req.renderedBodyMarkdown).toContain("Commitment end date: Oct 31, 2027");
    expect(req.renderedBodyMarkdown).toContain("SAMPLE TEXT");
    expect(req.renderedBodyMarkdown).not.toMatch(/\{\{|\}\}/);
    expect(cur.productVersionId).toBe(v12);
    expect(cur.membershipId).toBe(membership.id);
    expect((await mRow(membership.id)).agreementState).toBe("awaiting");
  });

  it("a start on the billing day has no partial month; month-to-month wording; values follow policy settings, not constants", async () => {
    await setPolicy({ cancellationNoticeDays: 45, holdMaxMonthsPerMembershipYear: 3 });
    const { membership } = await newMembership("ava", "chris_parker", vM2M, "2026-11-01");
    const { terms, policy, autopay } = await db().transaction((tx) => buildAgreementTerms(tx, ctx.orgId, membership.id));
    expect(terms.firstPartial).toBeNull();
    expect(terms).toMatchObject({ commitmentMonths: 0, commitmentEndsOn: null, discountPercent: null, netPriceMinor: 12000, firstRegularBillDate: "2026-11-01", noticeDays: 45 });
    const mv = mergeValues(terms, policy, autopay);
    expect(mv.first_partial_month).toMatch(/^None/);
    expect(mv.commitment_length).toBe("No commitment (month to month)");
    expect(mv.commitment_end_date).toBe("Not applicable");
    expect(mv.cancellation_notice).toBe("45 days written notice");
    expect(mv.hold_rules).toMatch(/up to 3 months/);
    expect(mv.family_discount).toMatch(/not currently applied/);
    await setPolicy({ cancellationNoticeDays: 30, holdMaxMonthsPerMembershipYear: 2 });
  });

  it("unknown merge fields are refused at render and at publish; a membership agreement cannot be issued as a blank form", async () => {
    expect(unknownMergeFields("Hello {{member_name}} {{ price }} {{favourite_color}}")).toEqual(["favourite_color"]);
    expect(() => renderAgreement("{{nope}}", {})).toThrow(/unknown merge fields/);
    const rod = await who("rod");
    const [tpl] = await db().select().from(formTemplates).where(and(eq(formTemplates.orgId, ctx.orgId), eq(formTemplates.kind, "membership_agreement")));
    const draft = await db().transaction((tx) => createDraftVersion(tx, rod, tpl.id));
    const [cur] = await db().select().from(formTemplateVersions).where(eq(formTemplateVersions.id, draft.version.id));
    await db().transaction((tx) => saveDraft(tx, rod, draft.version.id, { title: cur.title, bodyMarkdown: `${cur.bodyMarkdown}\n\nExtra {{made_up_field}}`, fields: [], signers: cur.signers }));
    await expect(db().transaction((tx) => publishVersion(tx, rod, draft.version.id, { requireResign: false }))).rejects.toThrow(/made_up_field/);
    const { discardDraft } = await import("@/lib/forms/templates");
    await db().transaction((tx) => discardDraft(tx, rod, draft.version.id));
    await expect(db().transaction((tx) => issueRequests(tx, rod, { templateId: tpl.id, target: { kind: "athlete", athleteId: ctx.athletes.ava } }))).rejects.toThrow(/issued from a membership/);
  });
});

describe("snapshot: what was signed never changes", () => {
  it("the signed text is frozen against policy edits, template edits and direct updates, and the PDF and verification use it", async () => {
    const { membership } = await newMembership("eli", "parker", v12, T);
    const cur = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    const before = (await reqRow(cur.formRequestId)).renderedBodyMarkdown!;
    // Alex signs for Eli after the emailed one-time code (membership agreements require identity step-up by default).
    const alex = await who("alex");
    await expect(db().transaction((tx) => signRequest(tx, alex, { requestId: cur.formRequestId, role: "guardian", typedName: "Alex Parker", consent: true, values: {} }, EVID))).rejects.toThrow(/Verify your identity/);
    await db().update(organizations).set({ settings: sql`${organizations.settings} || '{"formsStepUp": {"requireForKinds": ["waiver","agreement","membership_agreement"], "allowSessionMfa": false}}'::jsonb` }).where(eq(organizations.id, ctx.orgId));
    await verifyByEmail(db(), alex, cur.formRequestId);
    const res = await db().transaction((tx) => signRequest(tx, alex, { requestId: cur.formRequestId, role: "guardian", typedName: "Alex Parker", consent: true, values: {} }, EVID));
    expect(res.status).toBe("completed");
    expect((await mRow(membership.id)).agreementState).toBe("signed");
    const [agr] = await db().select().from(membershipAgreements).where(eq(membershipAgreements.id, cur.id));
    expect(agr.signedAt).not.toBeNull();
    const signed = await reqRow(cur.formRequestId);
    expect((signed.submittedData as { _agreement: { renderedBodySha256: string } })._agreement.renderedBodySha256).toBe(sha256Hex(before));
    const [sig] = await db().select().from(signatures).where(eq(signatures.formRequestId, signed.id));
    expect(sig.authMethod).toMatch(/step_up=email_otp/);

    // 1) Policy changes afterwards: the signed record is unchanged.
    await setPolicy({ cancellationNoticeDays: 60, familyDiscountPercent: 15 });
    expect((await reqRow(cur.formRequestId)).renderedBodyMarkdown).toBe(before);
    expect(before).toContain("30 days written notice");
    // 2) A new template version afterwards: unchanged.
    const rod = await who("rod");
    const [tpl] = await db().select().from(formTemplates).where(and(eq(formTemplates.orgId, ctx.orgId), eq(formTemplates.kind, "membership_agreement")));
    const draft = await db().transaction((tx) => createDraftVersion(tx, rod, tpl.id));
    const [dv] = await db().select().from(formTemplateVersions).where(eq(formTemplateVersions.id, draft.version.id));
    await db().transaction((tx) => saveDraft(tx, rod, draft.version.id, { title: dv.title, bodyMarkdown: `${dv.bodyMarkdown}\n\n## 10. New clause\n\nSample new clause for {{member_name}}.`, fields: [], signers: dv.signers }));
    await db().transaction((tx) => publishVersion(tx, rod, draft.version.id, { requireResign: true }));
    const again = await reqRow(cur.formRequestId);
    expect(again.renderedBodyMarkdown).toBe(before);
    expect(again.status).toBe("completed");
    // 3) The database refuses to rewrite the frozen text or its merge values.
    await expect(db().update(formRequests).set({ renderedBodyMarkdown: "tampered" }).where(eq(formRequests.id, signed.id))).rejects.toThrow();
    await expect(db().update(formRequests).set({ mergeValues: { price: "$1.00" } }).where(eq(formRequests.id, signed.id))).rejects.toThrow();
    // 4) Verification recomputes the hash of the stored text, and the PDF prints the rendered text.
    const c = (await db().transaction((tx) => loadRequestContext(tx, ctx.orgId, signed.id)))!;
    const report = await db().transaction((tx) => verifyRequest(tx, c, { checkPdfBytes: true }));
    expect(report.ok).toBe(true);
    expect(report.checks.map((x) => x.label)).toContain("Agreement text on file is the exact text that was signed");
    const { objectStore } = await import("@/lib/storage");
    const { storedObjects } = await import("@/db/schema");
    const [obj] = await db().select().from(storedObjects).where(eq(storedObjects.id, signed.completedPdfObjectId!));
    const text = (await extractPdfText(await objectStore().get(obj.storageKey))).text;
    expect(text).toContain("Test 2x per Week (12 Months)");
    expect(text).toContain("Oct 31, 2027");
    expect(text).not.toContain("{{");
    await setPolicy({ cancellationNoticeDays: 30, familyDiscountPercent: 10 });
    await db().update(organizations).set({ settings: sql`${organizations.settings} - 'formsStepUp'` }).where(eq(organizations.id, ctx.orgId));
  });
});

describe("which changes require signing again (configurable)", () => {
  const base = { productId: "p1", priceMinor: 20000, currency: "USD", interval: "month", intervalCount: 1, sessionsPerWeek: 2, unlimited: false, commitmentMonths: 12, commitmentEndsOn: "2027-10-31", billingDay: 1, discountPercent: null, netPriceMinor: 20000, paymentMethodType: "card" } as unknown as AgreementTerms;
  it("pure rules", () => {
    expect(DEFAULT_RESIGN_ON).toEqual(["plan", "price", "sessions", "commitment", "bank_debit"]);
    expect(resignReasons(base, base, DEFAULT_RESIGN_ON)).toEqual([]);
    expect(resignReasons(base, { ...base, productId: "p2" }, DEFAULT_RESIGN_ON)).toEqual(["plan"]);
    expect(resignReasons(base, { ...base, priceMinor: 21000 }, DEFAULT_RESIGN_ON)).toEqual(["price"]);
    expect(resignReasons(base, { ...base, sessionsPerWeek: 3 }, DEFAULT_RESIGN_ON)).toEqual(["sessions"]);
    expect(resignReasons(base, { ...base, commitmentMonths: 0, commitmentEndsOn: null }, DEFAULT_RESIGN_ON)).toEqual(["commitment"]);
    expect(resignReasons(base, { ...base, paymentMethodType: "us_bank_account" }, DEFAULT_RESIGN_ON)).toEqual(["bank_debit"]);
    // Off by default: the family discount coming and going, a billing day change.
    expect(resignReasons(base, { ...base, discountPercent: 10, netPriceMinor: 18000, billingDay: 15 }, DEFAULT_RESIGN_ON)).toEqual([]);
    expect(resignReasons(base, { ...base, discountPercent: 10, netPriceMinor: 18000, billingDay: 15 }, ["discount", "billing_day"])).toEqual(["billing_day", "discount"]);
    expect(resignReasons(base, { ...base, priceMinor: 1 }, [])).toEqual([]);
  });

  it("plan change, price change and switching to bank account autopay each issue a new agreement; an unlisted trigger does not", async () => {
    const { membership } = await newMembership("ava", "chris_parker", v12, "2026-11-01");
    const first = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    await signInPerson(first.formRequestId);
    expect((await mRow(membership.id)).agreementState).toBe("signed");
    // Nothing changed: no new agreement.
    const sys = { orgId: ctx.orgId, actorUserId: null, actorRole: "system" };
    expect(await db().transaction((tx) => syncMembershipAgreement(tx, sys, membership.id))).toMatchObject({ action: "none" });

    // 1) Autopay by card: no re-sign. By bank account: re-sign with the ACH paragraph.
    const card = await activeMethod(ctx.payers.chris_parker);
    await db().transaction(async (tx) => setMembershipAutopay(tx, await who("chris"), { membershipId: membership.id, autopay: true }));
    expect((await mRow(membership.id)).agreementState).toBe("signed");
    const bank = await activeMethod(ctx.payers.chris_parker, { type: "us_bank_account", isDefault: false });
    await db().transaction(async (tx) => setMembershipAutopay(tx, await who("chris"), { membershipId: membership.id, autopay: true, methodId: bank.id }));
    expect((await mRow(membership.id)).agreementState).toBe("awaiting");
    const second = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    expect(second.id).not.toBe(first.id);
    expect(second.reason).toBe("payment_method_type");
    const body2 = (await reqRow(second.formRequestId)).renderedBodyMarkdown!;
    expect(body2).toContain("authorize");
    expect(body2).toContain(`Authorization text version ${MANDATE_TEXT_VERSION}`);
    expect(body2).toContain("Automatic payment from a bank account (ACH debit)");
    // The first signed agreement is kept as the record of what was signed then.
    const [old] = await db().select().from(membershipAgreements).where(eq(membershipAgreements.id, first.id));
    expect(old.signedAt).not.toBeNull();
    expect(old.supersededById).toBe(second.id);
    expect((await reqRow(first.formRequestId)).status).toBe("completed");
    expect((await reqRow(first.formRequestId)).renderedBodyMarkdown).toContain("Not applicable: this membership is not paid automatically from a bank account.");
    await signInPerson(second.formRequestId);
    expect((await mRow(membership.id)).agreementState).toBe("signed");

    // 2) Plan change now: new agreement linked to the new product version.
    await db().transaction(async (tx) => changePlan(tx, await who("rod"), { membershipId: membership.id, toVersionId: vM2M, effectiveOn: T, today: T }));
    const third = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    expect(third).toMatchObject({ reason: "plan_change", productVersionId: vM2M, requestStatus: "pending" });
    expect((await mRow(membership.id)).agreementState).toBe("awaiting");
    // While unsigned, a further change re-renders the open agreement instead of stacking requests.
    await db().transaction(async (tx) => changePlan(tx, await who("rod"), { membershipId: membership.id, toVersionId: v12, effectiveOn: T, today: T }));
    const fourth = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    expect(fourth.productVersionId).toBe(v12);
    expect((await reqRow(third.formRequestId)).status).toBe("superseded");
    await signInPerson(fourth.formRequestId);

    // 3) A price change through a scheduled move to a new price version (applied by the renewal job) re-signs.
    const nv = await db().transaction(async (tx) => createProductVersion(tx, await who("rod"), p12, { priceMinor: 21500, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2026-12-01" }));
    await db().transaction(async (tx) => changePlan(tx, await who("rod"), { membershipId: membership.id, toVersionId: nv.id, effectiveOn: "2026-12-01", today: T }));
    expect((await mRow(membership.id)).agreementState).toBe("signed"); // scheduled, not applied yet
    await db().update(paymentMethods).set({ status: "removed", isDefault: false }).where(eq(paymentMethods.payerAccountId, ctx.payers.chris_parker));
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-01"));
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-12-01"));
    const fifth = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    expect(fifth.productVersionId).toBe(nv.id);
    expect(["price_change", "payment_method_type", "plan_change"]).toContain(fifth.reason);
    expect((await reqRow(fifth.formRequestId)).renderedBodyMarkdown).toContain("$215.00 per month");
    expect((await mRow(membership.id)).agreementState).toBe("awaiting");
    void card;

    // 4) With the price trigger switched off in settings, the same kind of change does not re-sign.
    await signInPerson(fifth.formRequestId);
    await expect(db().transaction(async (tx) => saveAgreementSettings(tx, await who("erin"), { ...DEFAULT_AGREEMENT_SETTINGS, resignOn: [] }))).rejects.toMatchObject({ name: "AuthzError" });
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), { ...DEFAULT_AGREEMENT_SETTINGS, resignOn: ["plan"] }));
    const nv2 = await db().transaction(async (tx) => createProductVersion(tx, await who("rod"), p12, { priceMinor: 22000, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2027-01-01" }));
    await db().transaction(async (tx) => changePlan(tx, await who("rod"), { membershipId: membership.id, toVersionId: nv2.id, effectiveOn: T, today: T }));
    expect((await mRow(membership.id)).agreementState).toBe("signed");
    expect((await db().transaction((tx) => currentAgreement(tx, membership.id)))!.id).toBe(fifth.id);
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), DEFAULT_AGREEMENT_SETTINGS));
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(agreementSettingsOf(org.settings)).toEqual(DEFAULT_AGREEMENT_SETTINGS);
  });
});

describe("awaiting agreement: reservations and billing", () => {
  it("blocks reservations until signed by default, bills as scheduled by default, and both rules are settings", async () => {
    const { membership, firstInvoice } = await newMembership("ava", "chris_parker", vM2M, T);
    // Default: billing starts as scheduled even though the agreement is unsigned.
    expect(firstInvoice).not.toBeNull();
    const elig = () => db().transaction((tx) => checkEligibility(tx, { orgId: ctx.orgId, athleteId: ctx.athletes.ava, serviceType: { name: "Sample class", eligibility: {} }, at: new Date() }));
    let e = await elig();
    expect(e.ok).toBe(false);
    expect(e.reasons.join(" ")).toMatch(/membership agreement for Test 1x per Week \(Month to Month\) has not been signed yet/);
    // Staff see who is unsigned.
    const list = await db().transaction((tx) => unsignedAgreements(tx, ctx.orgId));
    expect(list.find((u) => u.membershipId === membership.id)).toMatchObject({ athleteName: "Ava Parker", product: "Test 1x per Week (Month to Month)" });
    // Setting off: not blocked.
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), { ...DEFAULT_AGREEMENT_SETTINGS, blockReservationsUntilSigned: false }));
    expect(await db().transaction((tx) => agreementBlock(tx, ctx.orgId, ctx.athletes.ava))).toBeNull();
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), DEFAULT_AGREEMENT_SETTINGS));
    const cur = (await db().transaction((tx) => currentAgreement(tx, membership.id)))!;
    await signInPerson(cur.formRequestId);
    e = await elig();
    expect(e.reasons.join(" ")).not.toMatch(/membership agreement/);
    expect((await db().transaction((tx) => unsignedAgreements(tx, ctx.orgId))).some((u) => u.membershipId === membership.id)).toBe(false);

    // Billing waits for the signature when the org says so: no first bill, the renewal job skips it, then bills once signed.
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), { ...DEFAULT_AGREEMENT_SETTINGS, billingWaitsForSignature: true }));
    const w = await newMembership("ava", "chris_parker", vM2M, T);
    expect(w.firstInvoice).toBeNull();
    let run = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, T));
    expect(run.waitingForAgreement).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, w.membership.id))).toHaveLength(0);
    await signInPerson((await db().transaction((tx) => currentAgreement(tx, w.membership.id)))!.formRequestId);
    run = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, T));
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, w.membership.id))).toHaveLength(1);
    await db().transaction(async (tx) => saveAgreementSettings(tx, await who("rod"), DEFAULT_AGREEMENT_SETTINGS));
    // Staff can require an agreement on an existing membership; coaches cannot.
    await expect(db().transaction(async (tx) => requireAgreement(tx, await who("marcus"), ctx.extra.billing.mayaMembershipId))).rejects.toMatchObject({ name: "AuthzError" });
  });
});

describe("the guided sign-up flow", () => {
  it("only the paying guardian or billing staff can use it", async () => {
    await db().update(memberships).set({ status: "cancelled", agreementState: "not_required" }).where(eq(memberships.athleteId, ctx.athletes.ava));
    const start = async (u: string, athlete: string, payer: string) => {
      try {
        await db().transaction(async (tx) => {
          await startSignupFlow(tx, await who(u), { athleteId: ctx.athletes[athlete], payerAccountId: ctx.payers[payer] });
          throw new Error("rollback");
        });
      } catch (e) {
        return (e as Error).message === "rollback" ? "ok" : (e as Error).name;
      }
    };
    expect(await start("chris", "ava", "chris_parker")).toBe("ok");
    for (const u of ["erin", "rod"]) expect(await start(u, "ava", "chris_parker")).toBe("ok");
    for (const u of ["alex", "jordan", "sam", "casey", "dana", "maya", "marcus", "tess", "kiosk"]) expect(`${u}:${await start(u, "ava", "chris_parker")}`).toBe(`${u}:AuthzError`);
    // Jordan can view Parker bills but not pay: cannot sign Eli or Maya up. Casey has no payer authorization for Leo.
    expect(await start("jordan", "eli", "parker")).toBe("AuthzError");
    expect(await start("casey", "leo", "rivera")).toBe("AuthzError");
    // A payer account that does not cover the athlete is refused even for staff.
    expect(await start("rod", "ava", "parker")).toBe("AuthzError");
    const cands = await db().transaction(async (tx) => signupCandidates(tx, await who("chris")));
    expect(cands).toMatchObject([{ name: "Ava Parker", state: "new" }]);
    expect(await db().transaction(async (tx) => signupCandidates(tx, await who("jordan")))).toEqual([]);
  });

  it("new member end to end in not-configured mode: plan, agreement + waivers, pay each bill, first bill; every step is resumable and idempotent", async () => {
    const chris = await who("chris");
    const erin = await who("erin");
    const s1 = await db().transaction((tx) => startSignupFlow(tx, chris, { athleteId: ctx.athletes.ava, payerAccountId: ctx.payers.chris_parker }));
    const s2 = await db().transaction((tx) => startSignupFlow(tx, erin, { athleteId: ctx.athletes.ava, payerAccountId: ctx.payers.chris_parker }));
    expect(s2.flow.id).toBe(s1.flow.id); // staff and parent share the same flow
    expect(s2.created).toBe(false);
    const id = s1.flow.id;
    let view = await db().transaction((tx) => signupView(tx, chris, id, T));
    expect(view.current).toBe("plan");
    expect(view.plans.map((p) => p.versionId)).toEqual(expect.arrayContaining([v12, vM2M]));
    expect(view.providerConfigured).toBe(false);
    // Plans not in effect yet or retired are not offered.
    const plans = await db().transaction((tx) => publishedPlans(tx, ctx.orgId, T));
    expect(plans.every((p) => p.priceMinor > 0)).toBe(true);
    await expect(db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: ctx.extra.billing.packVersionId, startDate: T, today: T }))).rejects.toThrow(/listed plans/);
    await expect(db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: v12, startDate: addDaysYmd(T, -1), today: T }))).rejects.toThrow(/today or later/);
    // Another family cannot touch this flow.
    await expect(db().transaction(async (tx) => choosePlan(tx, await who("alex"), { flowId: id, productVersionId: v12, startDate: T, today: T }))).rejects.toMatchObject({ name: "AuthzError" });
    await expect(db().transaction(async (tx) => signupView(tx, await who("alex"), id, T))).rejects.toMatchObject({ name: "AuthzError" });

    const c1 = await db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: vM2M, startDate: T, today: T }));
    const c1b = await db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: vM2M, startDate: T, today: T }));
    expect(c1b).toMatchObject({ changed: false, membershipId: c1.membershipId });
    // Changing their mind before signing replaces the pending membership; nothing was billed.
    const c2 = await db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: v12, startDate: T, today: T }));
    expect(c2.membershipId).not.toBe(c1.membershipId);
    expect((await mRow(c1.membershipId)).status).toBe("cancelled");
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, c1.membershipId))).toHaveLength(0);
    const m = await mRow(c2.membershipId);
    expect(m).toMatchObject({ status: "pending", agreementState: "awaiting", autopay: false, billingProvider: "manual" });
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, m.id))).toHaveLength(0); // first bill deferred

    view = await db().transaction((tx) => signupView(tx, chris, id, T));
    expect(view.current).toBe("documents");
    expect(view.documents.filter((d) => d.isAgreement)).toHaveLength(1);
    expect(view.documents.some((d) => !d.isAgreement)).toBe(true); // required waivers ride along
    expect(view.firstBill).toMatchObject({ amountMinor: 10000, date: "2026-10-12" }); // half month, no family discount for a single athlete
    expect(view.familyDiscountPercent).toBe(0);
    // Cannot finish early.
    await expect(completeSignup(db(), chris, { flowId: id, today: T })).rejects.toThrow(/sign the membership agreement/);
    for (const d of view.documents) await signInPerson(d.requestId);
    view = await db().transaction((tx) => signupView(tx, chris, id, T));
    expect(view.current).toBe("payment");
    await expect(db().transaction((tx) => choosePlan(tx, chris, { flowId: id, productVersionId: vM2M, startDate: T, today: T }))).rejects.toThrow(/already signed/);
    // No saved method and Stripe not connected: autopay cannot be chosen; paying each bill can.
    await expect(db().transaction((tx) => choosePayment(tx, chris, { flowId: id, choice: "autopay" }))).rejects.toThrow(/Save a card or bank account first/);
    await expect(completeSignup(db(), chris, { flowId: id, today: T })).rejects.toThrow(/how you will pay/);
    await db().transaction((tx) => choosePayment(tx, chris, { flowId: id, choice: "manual" }));
    view = await db().transaction((tx) => signupView(tx, chris, id, T));
    expect(view.current).toBe("confirm");

    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const done = await completeSignup(db(), chris, { flowId: id, today: T });
    expect(done).toMatchObject({ completed: true, already: false });
    const again = await completeSignup(db(), erin, { flowId: id, today: T });
    expect(again).toMatchObject({ completed: true, already: true });
    const invs = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({ status: "open", totalMinor: 10000, periodStart: "2026-10-12", periodEnd: "2026-10-31", dueDate: "2026-10-12" });
    // Nothing was charged and no charge was queued: autopay is off.
    expect(f).not.toHaveBeenCalled();
    expect(await db().select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invs[0].id))).toHaveLength(0);
    expect(await db().select().from(jobs).where(like(jobs.dedupeKey, `${AUTOPAY_JOB}:${invs[0].id}:%`))).toHaveLength(0);
    view = await db().transaction((tx) => signupView(tx, chris, id, T));
    expect(view.current).toBe("done");
    // A finished flow frees the athlete for nothing new: they are a member now.
    await expect(db().transaction((tx) => startSignupFlow(tx, chris, { athleteId: ctx.athletes.ava, payerAccountId: ctx.payers.chris_parker }))).rejects.toThrow(/already has a membership/);
  });

  it("with a saved method: autopay is switched on and the first bill due today is charged only through the autopay queue", async () => {
    const dana = await who("dana");
    await db().update(memberships).set({ status: "cancelled", agreementState: "not_required" }).where(eq(memberships.athleteId, ctx.athletes.dana));
    const { flow } = await db().transaction((tx) => startSignupFlow(tx, dana, { athleteId: ctx.athletes.dana, payerAccountId: ctx.payers.dana }));
    const c = await db().transaction((tx) => choosePlan(tx, dana, { flowId: flow.id, productVersionId: vM2M, startDate: T, today: T }));
    let view = await db().transaction((tx) => signupView(tx, dana, flow.id, T));
    for (const d of view.documents) await signInPerson(d.requestId);
    const card = await activeMethod(ctx.payers.dana);
    await db().transaction((tx) => choosePayment(tx, dana, { flowId: flow.id, choice: "autopay" }));
    view = await db().transaction((tx) => signupView(tx, dana, flow.id, T));
    expect(view).toMatchObject({ current: "confirm", autopay: true, autopayMethodLabel: "Visa ending 4242, expires 08/28" });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const done = await completeSignup(db(), dana, { flowId: flow.id, today: T });
    expect(done.invoiceId).not.toBeNull();
    // The flow itself never calls Stripe: the charge is a queued job for the bill due today.
    expect(f).not.toHaveBeenCalled();
    const queued = await db().select().from(jobs).where(eq(jobs.dedupeKey, `${AUTOPAY_JOB}:${done.invoiceId}:1`));
    expect(queued).toHaveLength(1);
    expect(queued[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await mRow(c.membershipId)).autopay).toBe(true);
    void card;
  });

  it("a start date in the future on the billing day bills nothing at sign-up", async () => {
    const sam = await who("sam");
    await db().update(memberships).set({ status: "cancelled", agreementState: "not_required" }).where(eq(memberships.athleteId, ctx.athletes.leo));
    const { flow } = await db().transaction((tx) => startSignupFlow(tx, sam, { athleteId: ctx.athletes.leo, payerAccountId: ctx.payers.rivera }));
    const c = await db().transaction((tx) => choosePlan(tx, sam, { flowId: flow.id, productVersionId: vM2M, startDate: "2026-11-01", today: T }));
    const view = await db().transaction((tx) => signupView(tx, sam, flow.id, T));
    expect(view.firstBill).toMatchObject({ amountMinor: 12000, date: "2026-11-01" });
    for (const d of view.documents) await signInPerson(d.requestId);
    await db().transaction((tx) => choosePayment(tx, sam, { flowId: flow.id, choice: "manual" }));
    const done = await completeSignup(db(), sam, { flowId: flow.id, today: T });
    expect(done.invoiceId).toBeNull();
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, c.membershipId))).toHaveLength(0);
    // The renewal job issues it on the day.
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-01"));
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, c.membershipId))).toHaveLength(1);
  });
});

describe("Zen Planner cutover through the same flow", () => {
  it("collects the agreement and a payment method, never bills while Zen Planner bills, and Cut over requires both", async () => {
    const erin = await who("erin");
    const mid = ctx.extra.billing.sofiaExternalMembershipId; // Aria's imported membership (still billed by Zen Planner)
    const cut = (o: Partial<Parameters<typeof cutoverMembership>[2]> = {}) => db().transaction((tx) => cutoverMembership(tx, erin, { membershipId: mid, firstBillDate: "2026-11-01", zenPlannerStopped: true, today: T, ...o }));
    await expect(cut({ zenPlannerStopped: false })).rejects.toThrow(/Zen Planner recurring charge has been stopped/);
    await expect(cut()).rejects.toThrow(/needs a signed membership agreement and a saved payment method/);

    const { flow } = await db().transaction((tx) => startSignupFlow(tx, erin, { athleteId: ctx.athletes.aria, payerAccountId: ctx.payers.aria }));
    expect(flow).toMatchObject({ kind: "cutover", membershipId: mid });
    await expect(db().transaction((tx) => choosePlan(tx, erin, { flowId: flow.id, productVersionId: vM2M, startDate: T, today: T }))).rejects.toThrow(/plan stays the same/);
    let view = await db().transaction((tx) => signupView(tx, erin, flow.id, T));
    expect(view.current).toBe("documents");
    expect(view.firstBill).toBeNull();
    const agr = view.documents.find((d) => d.isAgreement)!;
    expect((await reqRow(agr.requestId)).renderedBodyMarkdown).toContain("Partial first month: None.");
    for (const d of view.documents) await signInPerson(d.requestId);
    await expect(cut()).rejects.toThrow(/needs a saved payment method/);
    const card = await activeMethod(ctx.payers.aria);
    await db().transaction((tx) => choosePayment(tx, erin, { flowId: flow.id, choice: "autopay" }));
    // Still billed by Zen Planner: autopay is only a stored preference, and nothing is invoiced.
    await completeSignup(db(), erin, { flowId: flow.id, today: T });
    expect(await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:signup-cutover:${flow.id}`))).toHaveLength(1);
    let m = await mRow(mid);
    expect(m).toMatchObject({ billingProvider: "external_zenplanner", autopay: true, agreementState: "signed" });
    let run = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, T));
    expect(run.skippedExternal).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, mid))).toHaveLength(0);

    const res = await cut();
    expect(res).toMatchObject({ autopay: true, agreementSigned: true, methodOnFile: true });
    m = await mRow(mid);
    expect(m).toMatchObject({ billingProvider: "manual", nextBillDate: "2026-11-01", autopay: true });
    // Not billed before the first Teamwork bill date; billed exactly once on it, with the autopay charge queued.
    run = await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-10-31"));
    expect(await db().select().from(invoices).where(eq(invoices.membershipId, mid))).toHaveLength(0);
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-01"));
    await db().transaction((tx) => generateRenewals(tx, ctx.orgId, "2026-11-01"));
    const invs = await db().select().from(invoices).where(eq(invoices.membershipId, mid));
    expect(invs).toHaveLength(1);
    expect(invs[0].periodStart).toBe("2026-11-01");
    expect(await db().select().from(jobs).where(eq(jobs.dedupeKey, `${AUTOPAY_JOB}:${invs[0].id}:1`))).toHaveLength(1);
    await expect(cut()).rejects.toThrow(/not billed by Zen Planner/);
    void card;
    expect((await db().select().from(signupFlows).where(eq(signupFlows.id, flow.id)))[0].status).toBe("completed");
  });
});
