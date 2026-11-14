import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import {
  athletes,
  formRequests,
  formTemplates,
  membershipEvents,
  memberships,
  payerAccounts,
  payerBeneficiaries,
  paymentMethods,
  people,
  products,
  productVersions,
  referralRewards,
  signupFlows,
} from "@/db/schema";
import { buildAgreementTerms, type AgreementTerms } from "@/lib/agreements/terms";
import { agreementTemplateVersion, currentAgreement, issueMembershipAgreement } from "@/lib/agreements/issue";
import { audit } from "@/lib/audit";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { inScope, payablePayerIds } from "@/lib/billing/access";
import { UserError } from "@/lib/billing/errors";
import { billPeriod, createMembership, LIVE_STATUSES, type StubComputation } from "@/lib/billing/memberships";
import { methodLabel, setMembershipAutopay } from "@/lib/billing/payment-methods";
import { billingTask } from "@/lib/billing/tasks";
import { actorOf } from "@/lib/billing/util";
import { athleteFormStatus } from "@/lib/forms/status";
import { membershipPolicy } from "@/lib/membership-policy";
import { percentOf } from "@/lib/money";
import { getSavedMethodProvider } from "@/lib/payments";
import { addDaysYmd } from "@/lib/time";

type Flow = typeof signupFlows.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Who may use a sign-up flow: billing staff (front desk), or a person allowed to PAY the payer account
 * that covers the athlete. View-only payers (Jordan) and guardians with no payer authorization (Casey)
 * cannot; coaches cannot.
 */
async function assertFlowAccess(tx: Tx, v: Viewer, payerAccountId: string, athleteId: string) {
  const [link] = await tx
    .select({ orgId: payerAccounts.orgId })
    .from(payerBeneficiaries)
    .innerJoin(payerAccounts, eq(payerAccounts.id, payerBeneficiaries.payerAccountId))
    .innerJoin(athletes, eq(athletes.id, payerBeneficiaries.athleteId))
    .where(and(eq(payerBeneficiaries.payerAccountId, payerAccountId), eq(payerBeneficiaries.athleteId, athleteId), eq(payerAccounts.orgId, v.orgId), eq(athletes.orgId, v.orgId)));
  if (!link) throw new AuthzError("That payer account is not set up to pay for this athlete.");
  if (can(v, "billing.manage")) return;
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError();
  if (!inScope(await payablePayerIds(tx, v), payerAccountId)) throw new AuthzError("Only the person who pays for this account can sign up for a membership.");
}

async function loadFlow(tx: Tx, v: Viewer, flowId: string, lock = false): Promise<Flow> {
  if (!UUID.test(flowId)) throw new AuthzError();
  const q = tx.select().from(signupFlows).where(and(eq(signupFlows.id, flowId), eq(signupFlows.orgId, v.orgId)));
  const [f] = lock ? await q.for("update") : await q;
  if (!f) throw new AuthzError();
  await assertFlowAccess(tx, v, f.payerAccountId, f.athleteId);
  return f;
}

/** Athletes the viewer could start a sign-up for, with what kind of flow it would be. */
export async function signupCandidates(tx: Tx, v: Viewer) {
  const scope = can(v, "billing.manage") ? "all" : await payablePayerIds(tx, v);
  if (scope !== "all" && !scope.length) return [];
  if (scope === "all") return []; // staff pick the athlete from Billing, Memberships
  const rows = await tx
    .select({ athleteId: athletes.id, payerAccountId: payerBeneficiaries.payerAccountId, first: people.firstName, last: people.lastName, payerName: payerAccounts.name })
    .from(payerBeneficiaries)
    .innerJoin(athletes, eq(athletes.id, payerBeneficiaries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(payerAccounts, eq(payerAccounts.id, payerBeneficiaries.payerAccountId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), inArray(payerBeneficiaries.payerAccountId, scope)))
    .orderBy(asc(people.firstName));
  const out = [];
  for (const r of rows) {
    const live = await tx.select().from(memberships).where(and(eq(memberships.athleteId, r.athleteId), eq(memberships.orgId, v.orgId), inArray(memberships.status, LIVE_STATUSES), eq(memberships.kind, "regular")));
    const [open] = await tx.select({ id: signupFlows.id }).from(signupFlows).where(and(eq(signupFlows.athleteId, r.athleteId), eq(signupFlows.status, "open")));
    const external = live.find((m) => m.billingProvider === "external_zenplanner");
    const other = live.find((m) => m.billingProvider !== "external_zenplanner");
    out.push({ ...r, name: `${r.first} ${r.last}`, openFlowId: open?.id ?? null, state: open ? ("resume" as const) : other ? ("member" as const) : external ? ("convert" as const) : ("new" as const) });
  }
  return out;
}

/**
 * Start (or resume) the guided sign-up for one athlete. One open flow per athlete: starting again
 * returns the same flow. An athlete whose membership is still billed by Zen Planner gets a
 * conversion flow for that membership; nothing about its billing changes here.
 */
export async function startSignupFlow(tx: Tx, v: Viewer, input: { athleteId: string; payerAccountId: string }) {
  await assertFlowAccess(tx, v, input.payerAccountId, input.athleteId);
  await tx.select({ id: athletes.id }).from(athletes).where(eq(athletes.id, input.athleteId)).for("update");
  const [open] = await tx.select().from(signupFlows).where(and(eq(signupFlows.athleteId, input.athleteId), eq(signupFlows.status, "open")));
  if (open) {
    if (open.payerAccountId !== input.payerAccountId) throw new UserError("A sign-up is already in progress for this athlete on another payer account. Ask the front desk.");
    return { flow: open, created: false };
  }
  const live = await tx.select().from(memberships).where(and(eq(memberships.athleteId, input.athleteId), eq(memberships.orgId, v.orgId), inArray(memberships.status, LIVE_STATUSES), eq(memberships.kind, "regular")));
  const external = live.find((m) => m.billingProvider === "external_zenplanner");
  const other = live.find((m) => m.billingProvider !== "external_zenplanner");
  if (other) throw new UserError("This athlete already has a membership here. To switch plans, ask the front desk about a plan change.");
  if (external && external.payerAccountId && external.payerAccountId !== input.payerAccountId) throw new UserError("The current membership is on a different payer account. Ask the front desk.");
  const [ath] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(eq(athletes.id, input.athleteId));
  const [flow] = await tx
    .insert(signupFlows)
    .values({
      orgId: v.orgId,
      kind: external ? "cutover" : "new",
      athleteId: input.athleteId,
      payerAccountId: input.payerAccountId,
      productVersionId: external?.productVersionId ?? null,
      startDate: external?.startDate ?? null,
      membershipId: external?.id ?? null,
      startedBy: v.userId,
      startedByStaff: can(v, "billing.manage"),
      isDemo: ath?.isDemo ?? false,
    })
    .returning();
  await audit(tx, actorOf(v), "signup.start", "signup_flow", flow.id, { summary: `${external ? "Zen Planner conversion" : "New membership"} sign-up started${flow.startedByStaff ? " by staff for the family" : ""}` });
  if (external) await prepareDocuments(tx, v, flow, external.id, "cutover");
  return { flow, created: true };
}

/** Plans a family can choose: active recurring plans with a version in effect on `today`. */
export async function publishedPlans(tx: Tx, orgId: string, today: string) {
  const rows = await tx
    .select({ versionId: productVersions.id, productId: products.id, name: products.name, description: products.description, v: productVersions })
    .from(productVersions)
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(
      and(
        eq(products.orgId, orgId),
        eq(products.kind, "recurring_membership"),
        eq(products.active, true),
        sql`${productVersions.effectiveFrom} <= ${today}`,
        sql`(${productVersions.effectiveTo} is null or ${productVersions.effectiveTo} >= ${today})`,
      ),
    )
    .orderBy(asc(productVersions.priceMinor), asc(products.name));
  return rows.map((r) => ({
    versionId: r.versionId,
    productId: r.productId,
    name: r.name,
    description: r.description,
    priceMinor: r.v.priceMinor,
    currency: r.v.currency,
    interval: r.v.interval,
    intervalCount: r.v.intervalCount,
    sessionsPerWeek: r.v.classesPerWeek,
    unlimited: r.v.unlimited,
    commitmentMonths: r.v.commitmentMonths,
    trialDays: r.v.trialDays,
  }));
}

/** Issue the membership agreement and any required waivers that are not already valid or open. */
async function prepareDocuments(tx: Tx, v: Viewer, flow: Flow, membershipId: string, reason: "new" | "cutover") {
  await issueMembershipAgreement(tx, { ...actorOf(v), orgId: v.orgId }, { membershipId, reason, notify: false });
  const required = await tx.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true), eq(formTemplates.requiredForBooking, true)));
  if (!required.length) return;
  const status = (await athleteFormStatus(tx, v.orgId, [flow.athleteId], required)).get(flow.athleteId) ?? [];
  const { createRequest, currentPublishedVersion } = await import("@/lib/forms/requests");
  const [ath] = await tx.select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, flow.athleteId));
  for (const s of status) {
    if (s.state === "valid" || s.state === "pending" || s.state === "partially_signed") continue;
    const ver = await currentPublishedVersion(tx, s.templateId);
    if (!ver) continue;
    await createRequest(tx, { orgId: v.orgId, versionId: ver.id, athleteId: flow.athleteId, subjectPersonId: ath.personId, requestedBy: v.userId, isDemo: flow.isDemo, reason: "signup_flow", notify: false });
  }
}

/**
 * Step 1 (new members): choose the plan and start date. Creates the membership as "awaiting agreement"
 * with its first bill deferred, and issues the agreement and required waivers. Choosing the same plan
 * and date again changes nothing. Changing the choice is allowed until the agreement is signed.
 */
export async function choosePlan(tx: Tx, v: Viewer, input: { flowId: string; productVersionId: string; startDate: string; today: string }) {
  const flow = await loadFlow(tx, v, input.flowId, true);
  if (flow.status !== "open") throw new UserError("This sign-up is already finished.");
  if (flow.kind === "cutover") throw new UserError("This sign-up converts an existing membership; the plan stays the same.");
  if (!YMD.test(input.startDate) || input.startDate < input.today) throw new UserError("Choose a start date of today or later.", { startDate: "Today or later" });
  if (input.startDate > addDaysYmd(input.today, 90)) throw new UserError("Choose a start date within the next 90 days.", { startDate: "Within 90 days" });
  const plans = await publishedPlans(tx, v.orgId, input.today);
  if (!plans.some((p) => p.versionId === input.productVersionId)) throw new UserError("Choose one of the listed plans.", { productVersionId: "Not available" });
  if (!(await agreementTemplateVersion(tx, v.orgId))) throw new UserError("Sign-up is not available yet: the gym has not published its membership agreement. Please ask the front desk.");

  if (flow.membershipId) {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, flow.membershipId)).for("update");
    if (m && m.productVersionId === input.productVersionId && m.startDate === input.startDate && LIVE_STATUSES.includes(m.status)) return { flow, membershipId: m.id, changed: false };
    if (m && m.agreementState === "signed") throw new UserError("The agreement for the plan you chose is already signed. To change plans now, ask the front desk.");
    if (m && LIVE_STATUSES.includes(m.status)) {
      // Never billed (first bill deferred): withdraw the earlier choice.
      const billed = await tx.execute(sql`select 1 from invoices where membership_id = ${m.id} and status <> 'void' limit 1`);
      if (billed.rows.length) throw new UserError("A bill already exists for the plan chosen earlier. Ask the front desk to change it.");
      await tx.update(memberships).set({ status: "cancelled", endDate: input.today, nextBillDate: null, cancelReason: "Plan choice changed during sign-up", agreementState: "not_required", updatedAt: new Date() }).where(eq(memberships.id, m.id));
      await tx.insert(membershipEvents).values({ membershipId: m.id, type: "cancelled", actorUserId: v.userId, effectiveOn: input.today, details: { by: "signup_flow", reason: "plan choice changed before signing" } });
      const cur = await currentAgreement(tx, m.id);
      if (cur && cur.requestStatus !== "completed") await tx.update(formRequests).set({ status: "voided" }).where(eq(formRequests.id, cur.formRequestId));
      const { syncFamilyDiscount } = await import("@/lib/billing/memberships");
      await syncFamilyDiscount(tx, actorOf(v), v.orgId, flow.payerAccountId);
    }
  }
  const { membership } = await createMembership(
    tx,
    v,
    { athleteId: flow.athleteId, payerAccountId: flow.payerAccountId, productVersionId: input.productVersionId, startDate: input.startDate, today: input.today, isDemo: flow.isDemo, requireAgreement: true, deferFirstBill: true },
    { authorizedBySignupFlow: true },
  );
  await tx.update(signupFlows).set({ productVersionId: input.productVersionId, startDate: input.startDate, membershipId: membership.id, updatedAt: new Date() }).where(eq(signupFlows.id, flow.id));
  await prepareDocuments(tx, v, flow, membership.id, "new");
  await audit(tx, actorOf(v), "signup.plan", "signup_flow", flow.id, { summary: `Plan chosen in sign-up; membership created awaiting agreement, first bill deferred`, after: { membershipId: membership.id, productVersionId: input.productVersionId, startDate: input.startDate } });
  return { flow, membershipId: membership.id, changed: true };
}

/**
 * Step 3: how bills will be paid. "autopay" needs an active saved method and switches autopay on for the
 * membership (if that method is a bank account, the agreement may need signing again so it includes the
 * bank debit authorization). "manual" means the payer pays each bill themselves or at the front desk.
 */
export async function choosePayment(tx: Tx, v: Viewer, input: { flowId: string; choice: "autopay" | "manual"; methodId?: string | null }) {
  const flow = await loadFlow(tx, v, input.flowId, true);
  if (flow.status !== "open") throw new UserError("This sign-up is already finished.");
  if (!flow.membershipId) throw new UserError("Choose a plan first.");
  if (input.choice === "autopay") {
    // Staff at the desk may switch autopay on only with a method the family already saved.
    await setMembershipAutopay(tx, v, { membershipId: flow.membershipId, autopay: true, methodId: input.methodId ?? null });
  } else {
    const [m] = await tx.select({ autopay: memberships.autopay }).from(memberships).where(eq(memberships.id, flow.membershipId));
    if (m?.autopay) await setMembershipAutopay(tx, v, { membershipId: flow.membershipId, autopay: false });
  }
  await tx.update(signupFlows).set({ paymentChoice: input.choice, updatedAt: new Date() }).where(eq(signupFlows.id, flow.id));
  await audit(tx, actorOf(v), "signup.payment_choice", "signup_flow", flow.id, { summary: input.choice === "autopay" ? "Automatic payments chosen in sign-up" : "Paying each bill manually chosen in sign-up" });
}

export type SignupDocument = { requestId: string; title: string; kind: string; status: string; isAgreement: boolean; signed: boolean };

export type SignupView = {
  flow: Flow;
  athleteName: string;
  payerName: string;
  viewerIsStaff: boolean;
  plans: Awaited<ReturnType<typeof publishedPlans>>;
  familyDiscountPercent: number;
  /** Pending referral new-family discount that will come off the first bill (capped at that bill). */
  referralDiscountMinor: number;
  agreementAvailable: boolean;
  terms: AgreementTerms | null;
  documents: SignupDocument[];
  methods: { id: string; label: string; type: string; isDefault: boolean }[];
  providerConfigured: boolean;
  missingEnv: string[];
  autopay: boolean;
  autopayMethodLabel: string | null;
  firstBill: { amountMinor: number; date: string; note: string | null; currency: string } | null;
  steps: { plan: boolean; documents: boolean; payment: boolean; done: boolean };
  /** The step to show next. */
  current: "plan" | "documents" | "payment" | "confirm" | "done";
  cutover: { agreementSigned: boolean; methodOnFile: boolean } | null;
};

/** Everything the flow page shows. Read-only; step state is derived from the linked records. */
export async function signupView(tx: Tx, v: Viewer, flowId: string, today: string): Promise<SignupView> {
  const flow = await loadFlow(tx, v, flowId);
  const [a] = await tx.select({ first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.id, flow.athleteId));
  const [payer] = await tx.select({ name: payerAccounts.name }).from(payerAccounts).where(eq(payerAccounts.id, flow.payerAccountId));
  const policy = await membershipPolicy(tx, v.orgId);
  const adapter = getSavedMethodProvider();
  const plans = flow.kind === "new" ? await publishedPlans(tx, v.orgId, today) : [];
  // Family discount applies once two or more athletes on the payer account are enrolled (this one included).
  const others = await tx.execute(sql`select count(distinct athlete_id)::int as n from memberships where org_id = ${v.orgId} and payer_account_id = ${flow.payerAccountId}
    and status in ('pending','trialing','active','on_hold','past_due') and athlete_id <> ${flow.athleteId}`);
  const familyDiscountPercent = Number((others.rows[0] as { n: number }).n) >= 1 && policy.familyDiscountPercent > 0 ? policy.familyDiscountPercent : 0;
  const rewards = await tx.select({ amount: referralRewards.amountMinor }).from(referralRewards).where(and(eq(referralRewards.orgId, v.orgId), eq(referralRewards.payerAccountId, flow.payerAccountId), eq(referralRewards.kind, "invoice_discount"), eq(referralRewards.status, "pending")));
  const referralPending = rewards.reduce((s, r) => s + (r.amount ?? 0), 0);

  const [m] = flow.membershipId ? await tx.select().from(memberships).where(eq(memberships.id, flow.membershipId)) : [];
  const terms = m ? (await buildAgreementTerms(tx, v.orgId, m.id)).terms : null;

  const documents: SignupDocument[] = [];
  if (m) {
    const cur = await currentAgreement(tx, m.id);
    const reqIds: string[] = cur ? [cur.formRequestId] : [];
    const required = await tx.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(and(eq(formTemplates.orgId, v.orgId), eq(formTemplates.active, true), eq(formTemplates.requiredForBooking, true)));
    const status = (await athleteFormStatus(tx, v.orgId, [flow.athleteId], required)).get(flow.athleteId) ?? [];
    for (const s of status) if (s.requestId) reqIds.push(s.requestId);
    if (reqIds.length) {
      const { formTemplateVersions } = await import("@/db/schema");
      const rows = await tx
        .select({ id: formRequests.id, status: formRequests.status, expiresAt: formRequests.expiresAt, title: formTemplateVersions.title, kind: formTemplates.kind })
        .from(formRequests)
        .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
        .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
        .where(inArray(formRequests.id, reqIds));
      for (const id of reqIds) {
        const r = rows.find((x) => x.id === id);
        if (!r) continue;
        const signed = r.status === "completed" && (!r.expiresAt || r.expiresAt > new Date());
        documents.push({ requestId: r.id, title: r.title, kind: r.kind, status: r.status, isAgreement: r.kind === "membership_agreement", signed });
      }
    }
  }
  const methodRows = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, flow.payerAccountId), eq(paymentMethods.status, "active"))).orderBy(sql`${paymentMethods.isDefault} desc`);
  const methods = methodRows.map((x) => ({ id: x.id, label: methodLabel(x), type: x.type, isDefault: x.isDefault }));
  const autopayMethod = m?.autopay ? ((m.autopayMethodId ? methodRows.find((x) => x.id === m.autopayMethodId) : methodRows.find((x) => x.isDefault)) ?? null) : null;

  let firstBill: SignupView["firstBill"] = null;
  if (terms && m && flow.kind === "new") {
    const base = terms.firstPartial ? terms.firstPartial.netAmountMinor : terms.trialDays > 0 ? 0 : terms.netPriceMinor;
    const bank = terms.bankPayDiscountMinor > 0 ? Math.min(terms.bankPayDiscountMinor, base) : 0;
    const afterBank = base - bank;
    const referral = Math.min(referralPending, afterBank);
    firstBill = {
      amountMinor: afterBank - referral,
      date: terms.firstPartial ? terms.firstPartial.billDate : terms.firstRegularBillDate,
      currency: terms.currency,
      note: [terms.firstPartial ? "partial first month" : null, familyDiscountPercent && terms.discountPercent ? `family discount ${terms.discountPercent}%` : null, bank ? "bank pay discount" : null, referral ? "new family referral discount" : null].filter(Boolean).join(", ") || null,
    };
  }
  const agreementDoc = documents.find((d) => d.isAgreement);
  const docsDone = !!m && m.agreementState === "signed" && !!agreementDoc?.signed && documents.every((d) => d.signed);
  const paymentDone = !!m && ((flow.paymentChoice === "autopay" && !!autopayMethod) || flow.paymentChoice === "manual");
  const steps = { plan: !!m, documents: docsDone, payment: paymentDone, done: flow.status === "completed" };
  const current: SignupView["current"] = steps.done ? "done" : !steps.plan ? "plan" : !steps.documents ? "documents" : !steps.payment ? "payment" : "confirm";
  return {
    flow,
    athleteName: a ? `${a.first} ${a.last}` : "Athlete",
    payerName: payer?.name ?? "Payer",
    viewerIsStaff: can(v, "billing.manage"),
    plans: plans.map((p) => ({ ...p })),
    familyDiscountPercent,
    referralDiscountMinor: referralPending,
    agreementAvailable: !!(await agreementTemplateVersion(tx, v.orgId)),
    terms,
    documents,
    methods,
    providerConfigured: adapter.isConfigured(),
    missingEnv: adapter.missingEnv(),
    autopay: !!m?.autopay,
    autopayMethodLabel: autopayMethod ? methodLabel(autopayMethod) : null,
    firstBill,
    steps,
    current,
    cutover: flow.kind === "cutover" && m ? { agreementSigned: m.agreementState === "signed", methodOnFile: methods.length > 0 } : null,
  };
}

/** Price of a plan for this family before choosing it (family discount shown; nothing is created). */
/**
 * Where to send someone who has just finished signing a document: the open sign-up flow that the
 * document belongs to, if they may use that flow. Null for a document that is not part of a flow
 * (they stay on the document, as before) and for anyone the flow is not open to.
 */
export async function signupReturnPath(tx: Tx, v: Viewer, requestId: string, today: string): Promise<string | null> {
  if (!UUID.test(requestId)) return null;
  const [req] = await tx.select({ athleteId: formRequests.athleteId }).from(formRequests).where(and(eq(formRequests.id, requestId), eq(formRequests.orgId, v.orgId)));
  if (!req?.athleteId) return null;
  const flows = await tx.select({ id: signupFlows.id }).from(signupFlows).where(and(eq(signupFlows.orgId, v.orgId), eq(signupFlows.athleteId, req.athleteId), eq(signupFlows.status, "open")));
  for (const f of flows) {
    // signupView re-checks access; a viewer the flow is not open to simply gets no redirect.
    const view = await signupView(tx, v, f.id, today).catch(() => null);
    if (view?.documents.some((d) => d.requestId === requestId)) return `/billing/signup/${f.id}?signed=${requestId}`;
  }
  return null;
}

export function planPricePreview(priceMinor: number, familyDiscountPercent: number) {
  const discount = percentOf(priceMinor, familyDiscountPercent);
  return { grossMinor: priceMinor, discountMinor: discount, netMinor: priceMinor - discount };
}

/**
 * Finish the sign-up. Requires the plan, every document signed and a payment choice.
 * New member: the deferred first bill is issued now if it is due (a partial first month is always issued,
 * dated on the start date; a full first month only once the start date has arrived). With autopay on, the
 * charge for a bill due today is queued through the normal autopay path; nothing else is ever charged here.
 * Zen Planner conversion: nothing is billed; staff get a task to run the Cut over step.
 * Calling it again after it finished changes nothing.
 */
export async function completeSignup(db: DB, v: Viewer, input: { flowId: string; today: string }) {
  return db.transaction(async (tx) => {
    const flow = await loadFlow(tx, v, input.flowId, true);
    if (flow.status === "completed") return { completed: true, already: true, invoiceId: null as string | null };
    if (flow.status !== "open") throw new UserError("This sign-up was cancelled.");
    const view = await signupView(tx, v, flow.id, input.today);
    if (!view.steps.plan) throw new UserError("Choose a plan first.");
    if (!view.steps.documents) throw new UserError("Please sign the membership agreement and the required forms first.");
    if (!view.steps.payment) throw new UserError("Choose how you will pay first.");
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, flow.membershipId!)).for("update");
    let invoiceId: string | null = null;
    if (flow.kind === "new" && m.billingProvider === "manual" && LIVE_STATUSES.includes(m.status)) {
      const [row] = await tx.select({ version: productVersions, name: products.name }).from(productVersions).innerJoin(products, eq(products.id, productVersions.productId)).where(eq(productVersions.id, m.productVersionId));
      const [created] = await tx.select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, "created")));
      const stub = ((created?.details as { stub?: StubComputation | null } | null)?.stub ?? null) as StubComputation | null;
      const neverBilled = !(await tx.execute(sql`select 1 from invoices where membership_id = ${m.id} and status <> 'void' limit 1`)).rows.length;
      if (neverBilled && row.version.trialDays === 0 && m.nextBillDate === m.startDate && (stub || m.startDate <= input.today)) {
        const inv = await billPeriod(tx, actorOf(v), m, row.version, row.name, m.startDate, { stub });
        invoiceId = inv.id;
      }
    }
    if (flow.kind === "cutover") {
      await billingTask(tx, v.orgId, {
        title: `Ready to cut over from Zen Planner: ${view.athleteName}`,
        description: `The new membership agreement is signed${view.cutover?.methodOnFile ? " and a payment method is saved" : "; no payment method is saved (the family chose to pay each bill)"}. Stop the Zen Planner charge, then use Cut over on the membership page. Nothing is billed here until then.`,
        relatedType: "membership",
        relatedId: m.id,
        dedupeKey: `signup-cutover:${flow.id}`,
        isDemo: flow.isDemo,
      });
    }
    await tx.update(signupFlows).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(signupFlows.id, flow.id));
    await audit(tx, actorOf(v), "signup.complete", "signup_flow", flow.id, { summary: `Sign-up finished${invoiceId ? "; first bill issued" : flow.kind === "cutover" ? "; ready for cutover (nothing billed)" : "; first bill will be issued on its date"}`, after: { invoiceId } });
    return { completed: true, already: false, invoiceId };
  });
}

/** Open sign-ups (staff list). */
export async function openSignupFlows(tx: Tx, orgId: string) {
  return tx
    .select({ id: signupFlows.id, kind: signupFlows.kind, athleteId: signupFlows.athleteId, first: people.firstName, last: people.lastName, payerName: payerAccounts.name, createdAt: signupFlows.createdAt, membershipId: signupFlows.membershipId })
    .from(signupFlows)
    .innerJoin(athletes, eq(athletes.id, signupFlows.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(payerAccounts, eq(payerAccounts.id, signupFlows.payerAccountId))
    .where(and(eq(signupFlows.orgId, orgId), eq(signupFlows.status, "open")))
    .orderBy(signupFlows.createdAt);
}
