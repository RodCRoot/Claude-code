import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  discounts,
  membershipEvents,
  membershipHolds,
  memberships,
  payerAccounts,
  payerBeneficiaries,
  products,
  productVersions,
  type MembershipStatus,
} from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { UserError } from "./errors";
import { percentOf } from "@/lib/money";
import { addDaysYmd } from "@/lib/time";
import { createInvoiceRecord } from "./invoices";
import { actorOf, addIntervalYmd, addMonthsYmd } from "./util";

export const LIVE_STATUSES: MembershipStatus[] = ["pending", "trialing", "active", "on_hold", "past_due"];
export type InternalBillingProvider = "manual" | "none";

/** Billed by a provider subscription (Stripe Billing / PayPal Subscriptions) rather than Teamwork invoices. */
export function isProviderBilled(m: Pick<Membership, "billingProvider">): m is Pick<Membership, "billingProvider"> & { billingProvider: "stripe" | "paypal" } {
  return m.billingProvider === "stripe" || m.billingProvider === "paypal";
}

function refuseProviderBilled(m: Membership, what: string) {
  if (isProviderBilled(m)) {
    throw new UserError(`${what} is not available while the ${m.billingProvider === "stripe" ? "Stripe" : "PayPal"} subscription bills this membership — it would not change what the provider charges. Switch back to Teamwork invoices first.`);
  }
}

type Membership = typeof memberships.$inferSelect;
type Version = typeof productVersions.$inferSelect;

async function loadVersion(tx: Tx, orgId: string, versionId: string) {
  const [row] = await tx
    .select({ version: productVersions, product: products })
    .from(productVersions)
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(and(eq(productVersions.id, versionId), eq(products.orgId, orgId)));
  if (!row) throw new UserError("Plan version not found.");
  return row;
}

async function lockMembership(tx: Tx, orgId: string, id: string) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.orgId, orgId))).for("update");
  if (!m) throw new UserError("Membership not found.");
  return m;
}

async function event(tx: Tx, m: { id: string }, type: string, actorUserId: string | null, extra: Partial<typeof membershipEvents.$inferInsert> = {}) {
  await tx.insert(membershipEvents).values({ membershipId: m.id, type, actorUserId, ...extra });
}

/** Find (or create) the configured sibling discount for a percentage taken from the plan version. */
async function siblingDiscountId(tx: Tx, orgId: string, percent: number) {
  const name = `Sibling discount ${percent}%`;
  const [d] = await tx.select().from(discounts).where(and(eq(discounts.orgId, orgId), eq(discounts.name, name), eq(discounts.kind, "percent"), eq(discounts.value, percent)));
  if (d) return d.id;
  const [nd] = await tx.insert(discounts).values({ orgId, name, kind: "percent", value: percent }).returning();
  return nd.id;
}

export async function createMembership(
  tx: Tx,
  v: Viewer,
  input: {
    athleteId: string;
    payerAccountId: string;
    productVersionId: string;
    startDate: string;
    billingAnchorDay?: number | null;
    billingProvider?: InternalBillingProvider;
    applyFamilyDiscount?: boolean;
    today: string;
    isDemo?: boolean;
  },
) {
  assertCan(v, "billing.manage");
  const [a] = await tx.select().from(athletes).where(and(eq(athletes.id, input.athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new UserError("Athlete not found.");
  const [p] = await tx.select().from(payerAccounts).where(and(eq(payerAccounts.id, input.payerAccountId), eq(payerAccounts.orgId, v.orgId)));
  if (!p) throw new UserError("Payer account not found.");
  const [link] = await tx
    .select()
    .from(payerBeneficiaries)
    .where(and(eq(payerBeneficiaries.payerAccountId, p.id), eq(payerBeneficiaries.athleteId, a.id)));
  if (!link) throw new UserError("That payer account is not set up to pay for this athlete.");
  const { version, product } = await loadVersion(tx, v.orgId, input.productVersionId);
  if (product.kind !== "recurring_membership") throw new UserError("Choose a recurring membership plan.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new UserError("Start date is required.");
  const anchor = input.billingAnchorDay ?? Number(input.startDate.slice(8, 10));
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new UserError("Billing anchor day must be 1–31.");

  let discountId: string | null = null;
  const pct = version.familyDiscount?.siblingPercentOff;
  if (input.applyFamilyDiscount) {
    if (!pct) throw new UserError("This plan version has no sibling discount configured.");
    const siblings = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.payerAccountId, p.id), ne(memberships.athleteId, a.id), inArray(memberships.status, LIVE_STATUSES)));
    if (!siblings.length) throw new UserError("Family discount needs another live membership on the same payer account.");
    discountId = await siblingDiscountId(tx, v.orgId, pct);
  }

  const trial = version.trialDays > 0;
  const billingProvider = input.billingProvider ?? "manual";
  if (billingProvider !== "manual" && billingProvider !== "none") {
    throw new UserError("Create the membership with Teamwork invoices, then switch it to a Stripe or PayPal subscription from the membership page.");
  }
  const [m] = await tx
    .insert(memberships)
    .values({
      orgId: v.orgId,
      athleteId: a.id,
      payerAccountId: p.id,
      productVersionId: version.id,
      status: trial ? "trialing" : billingProvider === "none" ? "active" : "pending",
      startDate: input.startDate,
      billingAnchorDay: anchor,
      nextBillDate: billingProvider === "none" ? null : trial ? addDaysYmd(input.startDate, version.trialDays) : input.startDate,
      discountId,
      billingProvider,
      source: "teamwork",
      createdBy: v.userId,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  await event(tx, m, "created", v.userId, { toVersionId: version.id, effectiveOn: input.startDate, details: { trialDays: version.trialDays, discountPercent: discountId ? pct : null, billingProvider } });
  await audit(tx, actorOf(v), "billing.membership.create", "membership", m.id, { summary: `${product.name} v${version.version} for athlete starting ${input.startDate}`, after: m });

  // Internally invoiced plans bill the first period now (unless trialing or starting later).
  let firstInvoice = null;
  if (billingProvider === "manual" && !trial && input.startDate <= input.today) {
    firstInvoice = await billPeriod(tx, actorOf(v), m, version, product.name, input.startDate);
  }
  return { membership: m, firstInvoice };
}

/** Amount for one period after the membership's discount. */
export async function periodPrice(tx: Tx, m: Pick<Membership, "discountId">, version: Version) {
  let discount = 0;
  if (m.discountId) {
    const [d] = await tx.select().from(discounts).where(eq(discounts.id, m.discountId));
    if (d?.active) discount = d.kind === "percent" ? percentOf(version.priceMinor, d.value) : Math.min(d.value, version.priceMinor);
  }
  return { gross: version.priceMinor, discount, net: version.priceMinor - discount };
}

/**
 * Create the invoice for one billing period and advance next_bill_date. The unique
 * (membership_id, period_start) index guarantees a period is billed at most once.
 */
export async function billPeriod(tx: Tx, actor: AuditActor, m: Membership, version: Version, productName: string, periodStart: string) {
  if (m.billingProvider !== "manual") throw new UserError("Only internally invoiced memberships are billed here.");
  const periodEnd = addDaysYmd(addIntervalYmd(periodStart, version.interval, version.intervalCount, m.billingAnchorDay), -1);
  const price = await periodPrice(tx, m, version);
  const res = await createInvoiceRecord(tx, actor, {
    orgId: m.orgId,
    payerAccountId: m.payerAccountId!,
    membershipId: m.id,
    periodStart,
    periodEnd,
    source: "membership_renewal",
    idempotencyKey: `membership:${m.id}:${periodStart}`,
    discountMinor: price.discount,
    dueDate: periodStart,
    isDemo: m.isDemo,
    lines: [
      {
        description: `${productName} — ${periodStart} to ${periodEnd}`,
        unitAmountMinor: version.priceMinor,
        productVersionId: version.id,
        athleteId: m.athleteId,
        entitlement: {
          credits: version.unlimited ? undefined : (version.creditsPerPeriod ?? undefined),
          unlimitedUntil: version.unlimited ? periodEnd : undefined,
          activateMembershipId: m.id,
          serviceTypeIds: version.serviceTypeIds,
        },
      },
    ],
  });
  await tx
    .update(memberships)
    .set({ nextBillDate: addIntervalYmd(periodStart, version.interval, version.intervalCount, m.billingAnchorDay), updatedAt: new Date() })
    .where(eq(memberships.id, m.id));
  return res.invoice;
}

export async function addHold(tx: Tx, v: Viewer, input: { membershipId: string; startDate: string; endDate: string; reason: string; requestedAt?: Date | null; today: string }) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A reason is required for a hold.");
  if (!input.startDate || !input.endDate || input.endDate < input.startDate) throw new UserError("Hold end date must be on or after its start date.");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.status === "cancelled" || m.status === "expired") throw new UserError("Cannot hold a cancelled or expired membership.");
  refuseProviderBilled(m, "A hold");
  const overlap = await tx
    .select()
    .from(membershipHolds)
    .where(and(eq(membershipHolds.membershipId, m.id), lte(membershipHolds.startDate, input.endDate), gte(membershipHolds.endDate, input.startDate)));
  if (overlap.length) throw new UserError("This hold overlaps an existing hold.");
  const [h] = await tx
    .insert(membershipHolds)
    .values({ membershipId: m.id, startDate: input.startDate, endDate: input.endDate, reason: input.reason.trim(), requestedAt: input.requestedAt ?? new Date(), createdBy: v.userId })
    .returning();
  await event(tx, m, "hold_added", v.userId, { effectiveOn: input.startDate, details: { holdId: h.id, endDate: input.endDate, reason: input.reason } });
  if (input.startDate <= input.today && input.endDate >= input.today && m.status !== "on_hold") {
    await tx.update(memberships).set({ status: "on_hold", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  }
  await audit(tx, actorOf(v), "billing.membership.hold", "membership", m.id, { summary: `Hold ${input.startDate} → ${input.endDate}: ${input.reason}`, after: h });
  return h;
}

export async function removeHold(tx: Tx, v: Viewer, holdId: string, today: string) {
  assertCan(v, "billing.manage");
  const [h] = await tx.select().from(membershipHolds).where(eq(membershipHolds.id, holdId));
  if (!h) throw new UserError("Hold not found.");
  const m = await lockMembership(tx, v.orgId, h.membershipId);
  if (h.startDate <= today) {
    // Past/active holds are history: end it today instead of deleting.
    if (h.endDate < today) throw new UserError("This hold has already ended.");
    await tx.update(membershipHolds).set({ endDate: addDaysYmd(today, -1) < h.startDate ? h.startDate : addDaysYmd(today, -1) }).where(eq(membershipHolds.id, h.id));
  } else {
    await tx.delete(membershipHolds).where(eq(membershipHolds.id, h.id));
  }
  if (m.status === "on_hold") await tx.update(memberships).set({ status: "active", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  await event(tx, m, "hold_removed", v.userId, { effectiveOn: today, details: { holdId } });
  await audit(tx, actorOf(v), "billing.membership.hold_remove", "membership", m.id, { summary: `Hold ${h.startDate}→${h.endDate} ended early/removed`, before: h });
}

/** Upgrade/downgrade. Effective today or earlier applies now; future dates are applied by the renewal job. */
export async function changePlan(tx: Tx, v: Viewer, input: { membershipId: string; toVersionId: string; effectiveOn: string; today: string; note?: string }) {
  assertCan(v, "billing.manage");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.billingProvider === "external_zenplanner") throw new UserError("Plan changes for Zen Planner-billed memberships must be made in Zen Planner until cutover.");
  refuseProviderBilled(m, "A plan change");
  if (!LIVE_STATUSES.includes(m.status)) throw new UserError("Only live memberships can change plans.");
  const { version: to, product } = await loadVersion(tx, v.orgId, input.toVersionId);
  if (product.kind !== "recurring_membership") throw new UserError("Choose a recurring membership plan.");
  if (to.id === m.productVersionId) throw new UserError("That is already the current plan.");
  const [from] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
  const direction = to.priceMinor > from.priceMinor ? "upgrade" : to.priceMinor < from.priceMinor ? "downgrade" : "change";
  if (input.effectiveOn <= input.today) {
    await tx.update(memberships).set({ productVersionId: to.id, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await event(tx, m, "plan_changed", v.userId, { fromVersionId: from.id, toVersionId: to.id, effectiveOn: input.effectiveOn, details: { direction, note: input.note ?? null } });
  } else {
    await event(tx, m, "plan_change_scheduled", v.userId, { fromVersionId: from.id, toVersionId: to.id, effectiveOn: input.effectiveOn, details: { direction, applied: false, note: input.note ?? null } });
  }
  await audit(tx, actorOf(v), "billing.membership.plan_change", "membership", m.id, {
    summary: `${direction} to ${product.name} v${to.version} effective ${input.effectiveOn}`,
    before: { productVersionId: from.id },
    after: { productVersionId: to.id, effectiveOn: input.effectiveOn },
  });
  return { direction, scheduled: input.effectiveOn > input.today };
}

/** Earliest allowed cancellation date under the plan's notice period and commitment. */
export function earliestCancelDate(m: Pick<Membership, "startDate">, version: Pick<Version, "cancellationNoticeDays" | "commitmentMonths">, requestedOn: string) {
  const byNotice = addDaysYmd(requestedOn, version.cancellationNoticeDays);
  const byCommitment = version.commitmentMonths > 0 ? addMonthsYmd(m.startDate, version.commitmentMonths) : m.startDate;
  return byNotice > byCommitment ? byNotice : byCommitment;
}

/**
 * Schedule cancellation. Billing stops for periods starting on/after cancel_at.
 * Staff may override terms only with an explicit reason (audited).
 */
export async function cancelMembership(
  tx: Tx,
  v: Viewer,
  input: { membershipId: string; requestedOn: string; reason: string; today: string; overrideCancelAt?: string | null; overrideReason?: string | null },
) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A cancellation reason is required.");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.status === "cancelled" || m.status === "expired") throw new UserError("Membership is already ended.");
  if (m.billingProvider === "external_zenplanner") throw new UserError("Cancel Zen Planner-billed memberships in Zen Planner until cutover (Teamwork Hub does not bill them).");
  if (isProviderBilled(m)) throw new UserError("This membership is billed by a provider subscription. Use “Cancel subscription at period end” so the provider stops charging too.");
  const [version] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
  const earliest = earliestCancelDate(m, version, input.requestedOn);
  let cancelAt = earliest;
  if (input.overrideCancelAt) {
    if (!input.overrideReason?.trim()) throw new UserError("Overriding notice/commitment terms requires a reason.");
    cancelAt = input.overrideCancelAt;
  }
  const immediate = cancelAt <= input.today;
  await tx
    .update(memberships)
    .set({
      cancelAt,
      cancelReason: input.reason.trim(),
      status: immediate ? "cancelled" : m.status,
      endDate: immediate ? cancelAt : m.endDate,
      nextBillDate: immediate ? null : m.nextBillDate,
      updatedAt: new Date(),
    })
    .where(eq(memberships.id, m.id));
  await event(tx, m, immediate ? "cancelled" : "cancel_scheduled", v.userId, {
    effectiveOn: cancelAt,
    details: { requestedOn: input.requestedOn, earliestAllowed: earliest, overridden: !!input.overrideCancelAt, overrideReason: input.overrideReason ?? null, reason: input.reason },
  });
  await audit(tx, actorOf(v), "billing.membership.cancel", "membership", m.id, {
    summary: `Cancellation ${immediate ? "effective" : "scheduled"} ${cancelAt}${input.overrideCancelAt ? " (terms overridden)" : ""}: ${input.reason}`,
  });
  return { cancelAt, earliest, immediate };
}

/**
 * Cutover from Zen Planner: only after staff confirm the Zen Planner recurring charge is stopped.
 * The first Teamwork bill date must be on/after today so no past period is billed twice.
 */
export async function cutoverMembership(tx: Tx, v: Viewer, input: { membershipId: string; firstBillDate: string; zenPlannerStopped: boolean; today: string }) {
  assertCan(v, "billing.manage");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.billingProvider !== "external_zenplanner") throw new UserError("This membership is not billed by Zen Planner.");
  if (!input.zenPlannerStopped) throw new UserError("Confirm the Zen Planner recurring charge has been stopped first (prevents double billing).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstBillDate) || input.firstBillDate < input.today) throw new UserError("First Teamwork bill date must be today or later.");
  await tx
    .update(memberships)
    .set({ billingProvider: "manual", nextBillDate: input.firstBillDate, billingAnchorDay: Number(input.firstBillDate.slice(8, 10)), updatedAt: new Date() })
    .where(eq(memberships.id, m.id));
  await event(tx, m, "cutover_from_zenplanner", v.userId, { effectiveOn: input.firstBillDate, details: { confirmedZenPlannerStopped: true } });
  await audit(tx, actorOf(v), "billing.membership.cutover", "membership", m.id, { summary: `Cut over from Zen Planner; first Teamwork bill ${input.firstBillDate}` });
}

export async function holdsFor(tx: Tx, membershipId: string) {
  return tx.select().from(membershipHolds).where(eq(membershipHolds.membershipId, membershipId)).orderBy(asc(membershipHolds.startDate));
}

/** Holds covering a date (pauses renewals and credit grants). */
export async function holdOn(tx: Tx, membershipId: string, ymd: string) {
  const [h] = await tx
    .select()
    .from(membershipHolds)
    .where(and(eq(membershipHolds.membershipId, membershipId), lte(membershipHolds.startDate, ymd), gte(membershipHolds.endDate, ymd)));
  return h ?? null;
}
