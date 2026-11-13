import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, discounts, membershipEvents, memberships, organizations, payerAccounts, payerAuthorizations, people, products, productVersions } from "@/db/schema";
import { autopaySettings, bankPayDiscountMinor, type AutopaySettings } from "@/lib/billing/autopay-settings";
import { UserError } from "@/lib/billing/errors";
import { mandateText, MANDATE_TEXT_VERSION } from "@/lib/billing/mandate-text";
import { computeStub, isStubStart, periodPrice, type StubComputation } from "@/lib/billing/memberships";
import { canonicalJson, sha256Hex } from "@/lib/forms/hash";
import { effectiveNoticeDays, membershipPolicy, PRORATION_LABELS, type MembershipPolicy } from "@/lib/membership-policy";
import { formatMoney } from "@/lib/money";
import { addDaysYmd, fmtDate } from "@/lib/time";

/**
 * The facts a membership agreement is rendered from. Every value comes from the membership, its immutable
 * product version, the organization's policy settings and the payer's saved method: nothing is typed by hand.
 * Dates are facility-local calendar dates (YYYY-MM-DD).
 */
export type AgreementTerms = {
  membershipId: string;
  productVersionId: string;
  productId: string;
  planName: string;
  versionNumber: number;
  organizationName: string;
  memberName: string;
  payerName: string;
  sessionsPerWeek: number | null;
  unlimited: boolean;
  interval: "none" | "week" | "month" | "year";
  intervalCount: number;
  currency: string;
  priceMinor: number;
  discountPercent: number | null;
  discountName: string | null;
  netPriceMinor: number;
  billingDay: number | null;
  startDate: string;
  /** First partial month, when the membership starts off the billing day. */
  firstPartial: { amountMinor: number; netAmountMinor: number; periodStart: string; periodEnd: string; billDate: string; rule: string } | null;
  firstRegularBillDate: string;
  trialDays: number;
  commitmentMonths: number;
  commitmentStartsOn: string | null;
  commitmentEndsOn: string | null;
  endDate: string | null;
  noticeDays: number;
  paymentMethodType: "card" | "us_bank_account" | "none";
  autopay: boolean;
  bankPayDiscountMinor: number;
};

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** Build the terms for one membership as it stands now. */
export async function buildAgreementTerms(tx: Tx, orgId: string, membershipId: string): Promise<{ terms: AgreementTerms; policy: MembershipPolicy; autopay: AutopaySettings }> {
  const [row] = await tx
    .select({ m: memberships, v: productVersions, p: products, first: people.firstName, last: people.lastName })
    .from(memberships)
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, orgId)));
  if (!row) throw new UserError("Membership not found.");
  const { m, v, p } = row;
  const policy = await membershipPolicy(tx, orgId);
  const auto = await autopaySettings(tx, orgId);
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [payer] = m.payerAccountId ? await tx.select().from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId)) : [];
  const payerPeople = m.payerAccountId
    ? await tx
        .select({ first: people.firstName, last: people.lastName })
        .from(payerAuthorizations)
        .innerJoin(people, eq(people.id, payerAuthorizations.personId))
        .where(and(eq(payerAuthorizations.payerAccountId, m.payerAccountId), eq(payerAuthorizations.canPay, true)))
    : [];
  const [disc] = m.discountId ? await tx.select().from(discounts).where(eq(discounts.id, m.discountId)) : [];
  const price = await periodPrice(tx, m, v);

  // The first partial month: what was actually computed when the membership was created (including a staff
  // override), else the policy computation for a start off the billing day.
  let stub: StubComputation | null = null;
  const [created] = await tx.select().from(membershipEvents).where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, "created"))).orderBy(desc(membershipEvents.createdAt)).limit(1);
  const recorded = (created?.details as { stub?: StubComputation | null } | null)?.stub ?? null;
  // A membership still billed by Zen Planner has no Teamwork first bill: its first bill date is set at cutover.
  const external = m.billingProvider === "external_zenplanner";
  if (external) stub = null;
  else if (recorded) stub = recorded;
  else if (v.trialDays === 0 && m.billingProvider !== "none" && isStubStart(v, m.billingAnchorDay, m.startDate)) stub = computeStub(v.priceMinor, m.startDate, m.billingAnchorDay!, policy.prorationMethod);
  const stubNet = stub ? (await periodPrice(tx, m, v, stub.grossMinor)).net : 0;

  // Method the membership would be charged with: its autopay method, else the payer's default saved method.
  let methodType: AgreementTerms["paymentMethodType"] = "none";
  if (m.payerAccountId) {
    const { paymentMethods } = await import("@/db/schema");
    const ms = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, m.payerAccountId), eq(paymentMethods.status, "active")));
    const pick = (m.autopayMethodId ? ms.find((x) => x.id === m.autopayMethodId) : null) ?? ms.find((x) => x.isDefault) ?? null;
    if (pick && m.autopay) methodType = pick.type === "us_bank_account" ? "us_bank_account" : "card";
  }
  const firstRegular = external ? (m.nextBillDate ?? m.startDate) : stub ? stub.nextBillDate : v.trialDays > 0 ? addDaysYmd(m.startDate, v.trialDays) : m.startDate;
  const terms: AgreementTerms = {
    membershipId: m.id,
    productVersionId: v.id,
    productId: p.id,
    planName: p.name,
    versionNumber: v.version,
    organizationName: org?.name ?? "Teamwork",
    memberName: `${row.first} ${row.last}`,
    payerName: payerPeople.length ? payerPeople.map((x) => `${x.first} ${x.last}`).sort().join(" and ") : (payer?.name ?? "Payer"),
    sessionsPerWeek: v.classesPerWeek,
    unlimited: v.unlimited,
    interval: v.interval,
    intervalCount: v.intervalCount,
    currency: v.currency,
    priceMinor: v.priceMinor,
    discountPercent: disc?.active && disc.kind === "percent" ? disc.value : null,
    discountName: disc?.active ? disc.name : null,
    netPriceMinor: price.net,
    billingDay: v.interval === "month" ? m.billingAnchorDay : null,
    startDate: m.startDate,
    firstPartial: stub ? { amountMinor: stub.grossMinor, netAmountMinor: stubNet, periodStart: stub.periodStart, periodEnd: stub.periodEnd, billDate: stub.periodStart, rule: stub.overridden ? "set by staff" : stub.rule } : null,
    firstRegularBillDate: firstRegular,
    trialDays: v.trialDays,
    commitmentMonths: m.commitmentStartsOn ? v.commitmentMonths : 0,
    commitmentStartsOn: m.commitmentStartsOn,
    commitmentEndsOn: m.commitmentEndsOn,
    endDate: m.kind === "in_season" ? m.endDate : null,
    noticeDays: effectiveNoticeDays(v.cancellationNoticeDays, policy),
    paymentMethodType: methodType,
    autopay: m.autopay,
    bankPayDiscountMinor: methodType === "us_bank_account" && v.interval === "month" ? bankPayDiscountMinor(auto, price.net) : 0,
  };
  return { terms, policy, autopay: auto };
}

/** Changes that can require a new signature. Which ones do is an organization setting. */
export const RESIGN_TRIGGERS = [
  { key: "plan", label: "Different plan", hint: "The membership moves to a different product (for example 1x/week to 2x/week)." },
  { key: "price", label: "Price change", hint: "The plan price before discounts changes (a new price version, or a different plan)." },
  { key: "sessions", label: "Sessions per week change", hint: "The weekly allowance changes." },
  { key: "commitment", label: "Commitment change", hint: "The commitment length or its end date changes (for example renewing onto a new term)." },
  { key: "billing_day", label: "Billing day change", hint: "The day of the month bills are issued changes." },
  { key: "discount", label: "Discount change", hint: "The discount on the membership changes (the family discount comes and goes as siblings enroll)." },
  { key: "bank_debit", label: "Switching to bank account autopay", hint: "Autopay moves to a bank account and the signed agreement has no ACH debit authorization paragraph." },
] as const;
export type ResignTrigger = (typeof RESIGN_TRIGGERS)[number]["key"];
export const DEFAULT_RESIGN_ON: ResignTrigger[] = ["plan", "price", "sessions", "commitment", "bank_debit"];

/** Which configured triggers fire when going from the signed terms to the current terms. */
export function resignReasons(signed: AgreementTerms, now: AgreementTerms, enabled: readonly ResignTrigger[]): ResignTrigger[] {
  const out: ResignTrigger[] = [];
  const on = (k: ResignTrigger) => enabled.includes(k);
  if (on("plan") && signed.productId !== now.productId) out.push("plan");
  if (on("price") && (signed.priceMinor !== now.priceMinor || signed.currency !== now.currency || signed.interval !== now.interval || signed.intervalCount !== now.intervalCount)) out.push("price");
  if (on("sessions") && (signed.sessionsPerWeek !== now.sessionsPerWeek || signed.unlimited !== now.unlimited)) out.push("sessions");
  if (on("commitment") && (signed.commitmentMonths !== now.commitmentMonths || signed.commitmentEndsOn !== now.commitmentEndsOn)) out.push("commitment");
  if (on("billing_day") && signed.billingDay !== now.billingDay) out.push("billing_day");
  if (on("discount") && (signed.discountPercent !== now.discountPercent || signed.netPriceMinor !== now.netPriceMinor)) out.push("discount");
  if (on("bank_debit") && now.paymentMethodType === "us_bank_account" && signed.paymentMethodType !== "us_bank_account") out.push("bank_debit");
  return out;
}

export function termsHash(t: AgreementTerms): string {
  return sha256Hex(canonicalJson({ schema: "teamwork.agreement-terms.v1", terms: t }));
}

// ---------------------------------------------------------------------------
// Merge fields
// ---------------------------------------------------------------------------

export const MERGE_FIELDS = [
  { key: "organization_name", label: "Organization name" },
  { key: "member_name", label: "Member (athlete) name" },
  { key: "payer_name", label: "Payer name(s)" },
  { key: "plan_name", label: "Plan name" },
  { key: "sessions_per_week", label: "Sessions per week" },
  { key: "price", label: "Price per billing period" },
  { key: "price_after_discount", label: "Price after the membership's discount" },
  { key: "billing_day", label: "Billing day" },
  { key: "start_date", label: "Start date" },
  { key: "first_partial_month", label: "Partial first month amount and date" },
  { key: "first_regular_bill_date", label: "First regular bill date" },
  { key: "commitment_length", label: "Commitment length" },
  { key: "commitment_end_date", label: "Commitment end date" },
  { key: "end_of_term", label: "What happens at the end of the term" },
  { key: "hold_rules", label: "Hold rules" },
  { key: "cancellation_notice", label: "Cancellation notice" },
  { key: "family_discount", label: "Family discount" },
  { key: "payment_terms", label: "Late / declined payment terms" },
  { key: "payment_method", label: "Payment method" },
  { key: "ach_authorization", label: "Recurring ACH debit authorization (bank account only)" },
] as const;
export type MergeKey = (typeof MERGE_FIELDS)[number]["key"];
const KEYS = new Set<string>(MERGE_FIELDS.map((f) => f.key));

const per = (t: AgreementTerms) => (t.interval === "month" ? (t.intervalCount === 1 ? "month" : `${t.intervalCount} months`) : t.interval === "week" ? (t.intervalCount === 1 ? "week" : `${t.intervalCount} weeks`) : t.interval === "year" ? "year" : "purchase");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Display strings for every merge field. Sentences here are SAMPLE wording around the configured values. */
export function mergeValues(t: AgreementTerms, policy: MembershipPolicy, auto: AutopaySettings): Record<MergeKey, string> {
  const money = (n: number) => formatMoney(n, t.currency);
  const retries = auto.cardRetryDays.length ? `If a card payment is declined we try the same card again ${auto.cardRetryDays.map((d) => `${plural(d, "day")}`).join(" and ")} after the failed attempt.` : "A declined card payment is not retried automatically.";
  return {
    organization_name: t.organizationName,
    member_name: t.memberName,
    payer_name: t.payerName,
    plan_name: t.planName,
    sessions_per_week: t.unlimited ? "Unlimited sessions" : t.sessionsPerWeek != null ? `${plural(t.sessionsPerWeek, "session")} per week` : "As described for this plan",
    price: `${money(t.priceMinor)} per ${per(t)}`,
    price_after_discount: t.netPriceMinor !== t.priceMinor ? `${money(t.netPriceMinor)} per ${per(t)} after ${t.discountName ?? "discount"}` : `${money(t.priceMinor)} per ${per(t)}`,
    billing_day: t.billingDay != null ? `the ${ordinal(t.billingDay)} of each month` : t.interval === "week" ? `every ${t.intervalCount === 1 ? "week" : `${t.intervalCount} weeks`} from the start date` : "the start date",
    start_date: fmtDate(t.startDate),
    first_partial_month: t.firstPartial
      ? `${money(t.firstPartial.netAmountMinor)} billed on ${fmtDate(t.firstPartial.billDate)} for ${fmtDate(t.firstPartial.periodStart)} through ${fmtDate(t.firstPartial.periodEnd)}`
      : "None. The membership starts on a billing day, so the first bill is a full period.",
    first_regular_bill_date: fmtDate(t.firstRegularBillDate),
    commitment_length: t.commitmentMonths > 0 ? plural(t.commitmentMonths, "month") : "No commitment (month to month)",
    commitment_end_date: t.commitmentEndsOn ? fmtDate(t.commitmentEndsOn) : t.endDate ? fmtDate(t.endDate) : "Not applicable",
    end_of_term: t.endDate
      ? `This membership ends on ${fmtDate(t.endDate)} and does not renew automatically.`
      : t.commitmentMonths > 0
        ? policy.commitmentRollsToMonthToMonth
          ? `After ${fmtDate(t.commitmentEndsOn)} the membership continues month to month at the same price until cancelled. It does not start a new commitment.`
          : `The commitment ends on ${fmtDate(t.commitmentEndsOn)}. Ask the front desk about continuing afterwards.`
        : "The membership continues month to month until cancelled.",
    hold_rules: `A membership can be put on hold for up to ${plural(policy.holdMaxMonthsPerMembershipYear, "month")} in each membership year, with a firm restart date. A hold is not a cancellation.`,
    cancellation_notice: `${plural(t.noticeDays, "day")} written notice${t.commitmentEndsOn ? `; a cancellation cannot take effect before the commitment ends on ${fmtDate(t.commitmentEndsOn)}` : ""}`,
    family_discount: policy.familyDiscountPercent > 0 ? `${policy.familyDiscountPercent}% off each membership while two or more athletes in the family are enrolled${t.discountPercent != null ? ` (currently applied: ${t.discountPercent}%)` : " (not currently applied)"}` : "No family discount is offered.",
    payment_terms: `Bills are due on the billing day. ${retries} A bank payment returned for insufficient funds is tried once more after ${plural(auto.achRetryWaitDays, "day")}. Unpaid bills can pause reservations until they are paid.`,
    payment_method: t.paymentMethodType === "us_bank_account" ? "Automatic payment from a bank account (ACH debit)" : t.paymentMethodType === "card" ? "Automatic payment by card" : "Each bill is paid by the payer (no automatic payment method on file)",
    ach_authorization: t.paymentMethodType === "us_bank_account" ? `${mandateText(t.organizationName)} (Authorization text version ${MANDATE_TEXT_VERSION}.)` : "Not applicable: this membership is not paid automatically from a bank account.",
  };
}

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Merge field keys used in a template body that are not known. */
export function unknownMergeFields(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TOKEN)) if (!KEYS.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Fill `{{field}}` tokens. Throws on an unknown field so a typo can never reach a signer as raw braces. */
export function renderAgreement(body: string, values: Record<string, string>): string {
  const unknown = unknownMergeFields(body);
  if (unknown.length) throw new UserError(`The membership agreement template uses unknown merge fields: ${unknown.map((u) => `{{${u}}}`).join(", ")}.`);
  return body.replace(TOKEN, (_all, k: string) => values[k] ?? "");
}

/** Proration wording for staff previews. */
export function prorationLabel(p: MembershipPolicy) {
  return PRORATION_LABELS[p.prorationMethod];
}
