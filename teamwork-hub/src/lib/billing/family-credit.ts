import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { accountCreditLedger, athletes, discounts, invoices, membershipEvents, memberships, people, products, productVersions } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { membershipPolicy, type MembershipPolicy } from "@/lib/membership-policy";
import { formatMoney } from "@/lib/money";
import { daysBetween } from "@/lib/time";
import { FAMILY_COUNTED_STATUSES, householdFamilyRates, isFamilyDiscount, type HouseholdRate } from "./family-rate";
import { int } from "./util";

/**
 * Sibling credit (owner's decision, 2026-11-23: "immediately. You can prorate the sibling for a bill
 * credit for the remainder of the billing period w/ discount so it can be applied to next months bill").
 *
 * When a recalculation RAISES the family rate on a hub-invoiced membership whose current billing period
 * is already billed, the existing member earns a bill credit for the extra discount over the rest of
 * that period:
 *
 *   credit = round( base × (new % − old %) × days remaining ÷ days in period ÷ 100 )
 *
 * - base: the amount billed for the membership for the period BEFORE discounts (the bill's subtotal; a
 *   partial first month uses the partial amount). The family rate is a percent of that amount, so the
 *   extra discount is too.
 * - days remaining: the day the rate changed through the last day of the billed period, both included.
 *   days in period: first through last day of the billed period, both included.
 * - one rounding, half up to the cent (`Math.round`, the same rule as `percentOf`).
 * - old %: the highest rate this period has already had (the rate the bill was priced with, the rate
 *   before this change, or the rate of an earlier credit for the same bill), so a rate that drops and
 *   comes back inside one period is never credited twice.
 *
 * The bill already issued is never re-priced. The credit is an `account_credit_ledger` entry tied to the
 * membership; `billPeriod` takes it off that membership's next bill (never below $0; the rest stays in the
 * ledger for the bill after). Nothing is refunded in cash and nothing is charged when a rate goes down.
 */
export const FAMILY_CREDIT_KIND = "family_rate_credit" as const;

/** Pure formula. Days are whole calendar days, both ends included. */
export function siblingCreditMinor(baseMinor: number, stepPercent: number, daysRemaining: number, daysInPeriod: number): number {
  if (baseMinor <= 0 || stepPercent <= 0 || daysRemaining <= 0 || daysInPeriod <= 0) return 0;
  return Math.round((baseMinor * stepPercent * Math.min(daysRemaining, daysInPeriod)) / (100 * daysInPeriod));
}

export type SiblingCreditCalc = {
  invoiceId: string;
  invoiceNumber: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  baseMinor: number;
  /** Highest rate the period already had; the credit is for `newPercent - fromPercent`. */
  fromPercent: number;
  newPercent: number;
  daysRemaining: number;
  daysInPeriod: number;
  creditMinor: number;
};

type MembershipRef = { id: string; orgId: string; billingProvider: string; payerAccountId: string | null };

/**
 * The credit a rise from `oldPercent` to `newPercent` on `today` earns this membership, or null when
 * there is none: not invoiced by the hub, no bill issued for a period that covers today, or no rise
 * beyond what that period already had.
 */
export async function siblingCreditFor(tx: Tx, m: MembershipRef, input: { oldPercent: number; newPercent: number; today: string }): Promise<SiblingCreditCalc | null> {
  if (m.billingProvider !== "manual" || !m.payerAccountId) return null;
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, m.orgId), eq(invoices.membershipId, m.id), inArray(invoices.status, ["open", "paid"]), lte(invoices.periodStart, input.today), gte(invoices.periodEnd, input.today)))
    .orderBy(desc(invoices.periodStart))
    .limit(1);
  if (!inv?.periodStart || !inv.periodEnd || inv.subtotalMinor <= 0) return null;
  const earlier = await tx
    .select({ p: sql<string | null>`max((${membershipEvents.details}->>'newPercent')::int)` })
    .from(membershipEvents)
    .where(and(eq(membershipEvents.membershipId, m.id), eq(membershipEvents.type, FAMILY_CREDIT_KIND), sql`${membershipEvents.details}->>'invoiceId' = ${inv.id}`));
  const fromPercent = Math.max(input.oldPercent, inv.familyRatePercent ?? 0, earlier[0]?.p == null ? 0 : int(earlier[0].p));
  if (input.newPercent <= fromPercent) return null;
  const daysRemaining = daysBetween(input.today, inv.periodEnd) + 1;
  const daysInPeriod = daysBetween(inv.periodStart, inv.periodEnd) + 1;
  const creditMinor = siblingCreditMinor(inv.subtotalMinor, input.newPercent - fromPercent, daysRemaining, daysInPeriod);
  if (creditMinor <= 0) return null;
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.number,
    currency: inv.currency,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    baseMinor: inv.subtotalMinor,
    fromPercent,
    newPercent: input.newPercent,
    daysRemaining,
    daysInPeriod,
    creditMinor,
  };
}

/** Write the credit (ledger entry, membership event, audit). Idempotent per membership, billed period and new rate. */
export async function grantSiblingCredit(
  tx: Tx,
  actor: AuditActor,
  m: MembershipRef & { isDemo: boolean },
  calc: SiblingCreditCalc,
  ctx: { today: string; rate: Pick<HouseholdRate, "householdId" | "householdName" | "headCount"> },
) {
  const [entry] = await tx
    .insert(accountCreditLedger)
    .values({
      orgId: m.orgId,
      payerAccountId: m.payerAccountId!,
      deltaMinor: calc.creditMinor,
      currency: calc.currency,
      kind: FAMILY_CREDIT_KIND,
      invoiceId: calc.invoiceId,
      membershipId: m.id,
      reason: `Family rate ${calc.fromPercent}% to ${calc.newPercent}% on ${ctx.today}: ${calc.daysRemaining} of ${calc.daysInPeriod} days left in the period billed on ${calc.invoiceNumber}`,
      actorUserId: actor.actorUserId,
      idempotencyKey: `family-credit:${m.id}:${calc.invoiceId}:${calc.newPercent}`,
      isDemo: m.isDemo,
    })
    .onConflictDoNothing()
    .returning({ id: accountCreditLedger.id });
  if (!entry) return null;
  const details = {
    householdId: ctx.rate.householdId,
    activeMembers: ctx.rate.headCount,
    oldPercent: calc.fromPercent,
    newPercent: calc.newPercent,
    invoiceId: calc.invoiceId,
    periodStart: calc.periodStart,
    periodEnd: calc.periodEnd,
    daysRemaining: calc.daysRemaining,
    daysInPeriod: calc.daysInPeriod,
    baseMinor: calc.baseMinor,
    creditMinor: calc.creditMinor,
    currency: calc.currency,
    ledgerEntryId: entry.id,
  };
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: FAMILY_CREDIT_KIND, effectiveOn: ctx.today, actorUserId: actor.actorUserId, details });
  await audit(tx, { ...actor, orgId: m.orgId }, "billing.membership.family_rate_credit", "membership", m.id, {
    summary: `Sibling credit ${formatMoney(calc.creditMinor, calc.currency)} for the next bill: family rate ${calc.fromPercent}% to ${calc.newPercent}% (${ctx.rate.headCount} active in ${ctx.rate.householdName ?? "the household"}), ${calc.daysRemaining} of ${calc.daysInPeriod} days left in ${calc.periodStart} to ${calc.periodEnd}, on ${formatMoney(calc.baseMinor, calc.currency)} billed (${calc.invoiceNumber})`,
    after: details,
  });
  return { ledgerEntryId: entry.id, ...calc };
}

/**
 * Sibling credit waiting for this membership's next bill: what was granted to it less what its bills have
 * already taken. Entries tied to a membership are their own pool, apart from the payer's general account
 * credit (`accountCreditBalances` leaves them out).
 */
export async function siblingCreditOutstanding(tx: Tx, m: { id: string; orgId: string; payerAccountId: string | null }): Promise<number> {
  if (!m.payerAccountId) return 0;
  const [row] = await tx
    .select({ own: sql<string>`coalesce(sum(${accountCreditLedger.deltaMinor}), 0)::bigint` })
    .from(accountCreditLedger)
    .where(and(eq(accountCreditLedger.orgId, m.orgId), eq(accountCreditLedger.payerAccountId, m.payerAccountId), eq(accountCreditLedger.membershipId, m.id)));
  return Math.max(0, int(row?.own));
}

/**
 * How much sibling credit the bill being issued takes: the outstanding credit, capped at what the bill
 * would otherwise come to (a bill never goes below $0; the rest is carried to the bill after).
 * Serialized per membership for the transaction.
 */
export async function siblingCreditToApply(tx: Tx, m: { id: string; orgId: string; payerAccountId: string | null }, billNetMinor: number): Promise<number> {
  if (!m.payerAccountId || billNetMinor <= 0) return 0;
  const [any] = await tx.select({ id: accountCreditLedger.id }).from(accountCreditLedger).where(and(eq(accountCreditLedger.membershipId, m.id), eq(accountCreditLedger.kind, FAMILY_CREDIT_KIND))).limit(1);
  if (!any) return 0;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"family-credit:" + m.id}))`);
  return Math.min(await siblingCreditOutstanding(tx, m), billNetMinor);
}

/** Record that `amountMinor` of sibling credit came off `invoice` (the invoice was created with it in its discount). */
export async function recordSiblingCreditApplied(tx: Tx, actor: AuditActor, m: { id: string; orgId: string; payerAccountId: string | null; isDemo: boolean }, invoice: { id: string; number: string; currency: string }, amountMinor: number) {
  const [entry] = await tx
    .insert(accountCreditLedger)
    .values({
      orgId: m.orgId,
      payerAccountId: m.payerAccountId!,
      deltaMinor: -amountMinor,
      currency: invoice.currency,
      kind: "applied_to_invoice",
      invoiceId: invoice.id,
      membershipId: m.id,
      reason: `Sibling credit (family rate) applied to ${invoice.number}`,
      actorUserId: actor.actorUserId,
      idempotencyKey: `family-credit-apply:${invoice.id}`,
      isDemo: m.isDemo,
    })
    .onConflictDoNothing()
    .returning({ id: accountCreditLedger.id });
  if (!entry) return;
  const left = await siblingCreditOutstanding(tx, m);
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: "family_rate_credit_applied", actorUserId: actor.actorUserId, details: { invoiceId: invoice.id, appliedMinor: amountMinor, carriedForwardMinor: left, currency: invoice.currency } });
  await audit(tx, { ...actor, orgId: m.orgId }, "billing.invoice.family_rate_credit_applied", "invoice", invoice.id, {
    summary: `Sibling credit ${formatMoney(amountMinor, invoice.currency)} taken off ${invoice.number}${left > 0 ? `; ${formatMoney(left, invoice.currency)} carried to the next bill` : ""}`,
    after: { appliedMinor: amountMinor, carriedForwardMinor: left, membershipId: m.id },
  });
}

/** Sibling credit taken off these invoices (invoice id → amount), for the bill and receipt screens. */
export async function siblingCreditOnInvoices(tx: Tx, orgId: string, invoiceIds: string[]): Promise<Record<string, number>> {
  if (!invoiceIds.length) return {};
  const rows = await tx
    .select({ invoiceId: accountCreditLedger.invoiceId, n: sql<string>`coalesce(sum(-${accountCreditLedger.deltaMinor}), 0)::bigint` })
    .from(accountCreditLedger)
    .where(and(eq(accountCreditLedger.orgId, orgId), eq(accountCreditLedger.kind, "applied_to_invoice"), inArray(accountCreditLedger.invoiceId, invoiceIds), sql`${accountCreditLedger.membershipId} is not null`))
    .groupBy(accountCreditLedger.invoiceId);
  return Object.fromEntries(rows.filter((r) => r.invoiceId).map((r) => [r.invoiceId!, int(r.n)]));
}

export type SiblingCreditEstimate = {
  athleteId: string;
  firstName: string;
  membershipId: string;
  payerAccountId: string | null;
  productName: string;
  fromPercent: number;
  newPercent: number;
  creditMinor: number;
  currency: string;
  daysRemaining: number;
  daysInPeriod: number;
  periodEnd: string;
};

/**
 * Estimate for the previews: the credit each existing household member would earn if `athleteId` enrolled
 * on `today`. Nothing is written. Empty when the setting is off, when the athlete already counts as
 * active, or when no existing member has a billed period with days left.
 */
export async function estimateSiblingCredits(tx: Tx, orgId: string, athleteId: string, today: string, opts: { policy?: MembershipPolicy; payerAccountId?: string } = {}): Promise<SiblingCreditEstimate[]> {
  const policy = opts.policy ?? (await membershipPolicy(tx, orgId));
  if (!policy.familyRateSiblingCredit || policy.familyDiscountStepPercent <= 0) return [];
  const now = await householdFamilyRates(tx, orgId, policy);
  if (now.isActive(athleteId)) return [];
  const after = await householdFamilyRates(tx, orgId, policy, { assumeActiveAthleteId: athleteId });
  const household = after.rateOf(athleteId).householdId;
  if (!household) return [];
  const rows = await tx
    .select({ m: memberships, d: discounts, firstName: sql<string>`coalesce(${people.preferredName}, ${people.firstName})`, productName: products.name })
    .from(memberships)
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .leftJoin(discounts, eq(discounts.id, memberships.discountId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.billingProvider, "manual"), inArray(memberships.status, FAMILY_COUNTED_STATUSES), opts.payerAccountId ? eq(memberships.payerAccountId, opts.payerAccountId) : undefined));
  const out: SiblingCreditEstimate[] = [];
  for (const { m, d, firstName, productName } of rows) {
    if (m.athleteId === athleteId) continue;
    if (d && !isFamilyDiscount(d)) continue; // on another discount: no family rate, so no credit
    const next = after.rateOf(m.athleteId);
    if (next.householdId !== household) continue;
    const calc = await siblingCreditFor(tx, m, { oldPercent: d ? d.value : 0, newPercent: next.percent, today });
    if (!calc) continue;
    out.push({ athleteId: m.athleteId, firstName, membershipId: m.id, payerAccountId: m.payerAccountId, productName, fromPercent: calc.fromPercent, newPercent: calc.newPercent, creditMinor: calc.creditMinor, currency: calc.currency, daysRemaining: calc.daysRemaining, daysInPeriod: calc.daysInPeriod, periodEnd: calc.periodEnd });
  }
  return out.sort((a, b) => a.firstName.localeCompare(b.firstName));
}

/** Plain words for the sibling credit entries in a membership's history. */
export function familyCreditText(type: string, d: Record<string, unknown> | null) {
  const n = (k: string) => (typeof d?.[k] === "number" ? (d[k] as number) : 0);
  const currency = typeof d?.currency === "string" ? d.currency : "USD";
  if (type === FAMILY_CREDIT_KIND) {
    return `Sibling credit ${formatMoney(n("creditMinor"), currency)} for the next bill: family rate ${n("oldPercent")}% to ${n("newPercent")}%, ${n("daysRemaining")} of ${n("daysInPeriod")} days left in the period already billed (${formatMoney(n("baseMinor"), currency)}).`;
  }
  return `Sibling credit ${formatMoney(n("appliedMinor"), currency)} taken off a bill${n("carriedForwardMinor") > 0 ? `; ${formatMoney(n("carriedForwardMinor"), currency)} carried to the next bill` : ""}.`;
}

/** Plain sentence for staff screens and the sibling offer. Sample wording, not legal text. */
export const SIBLING_CREDIT_PERK = "Enrolling a sibling now also earns each member already enrolled a credit on next month's bill, for the higher family discount over the rest of this billing period.";
