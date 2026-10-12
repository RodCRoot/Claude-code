import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  bookings,
  creditBuckets,
  discounts,
  invoices,
  membershipEvents,
  membershipHolds,
  memberships,
  payerAccounts,
  payerBeneficiaries,
  people,
  products,
  productVersions,
  scheduleSessions,
  REQUEST_CHANNELS,
  type MembershipKind,
  type MembershipStatus,
  type RequestChannel,
} from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { grantCredits } from "@/lib/credits";
import { enqueue } from "@/lib/jobs";
import { CAP_DAYS_PER_MONTH, effectiveNoticeDays, membershipPolicy, partialPeriodPriceMinor, type MembershipPolicy } from "@/lib/membership-policy";
import { percentOf } from "@/lib/money";
import { addDaysYmd, daysBetween, localToUtc, todayLocal } from "@/lib/time";
import { UserError } from "./errors";
import { createInvoiceRecord, invoiceMoney } from "./invoices";
import { billingTask } from "./tasks";
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

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: string | null | undefined): s is string => !!s && YMD.test(s);

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

async function athleteFirstName(tx: Tx, athleteId: string) {
  const [r] = await tx.select({ first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(eq(athletes.id, athleteId));
  return r ?? { first: "Athlete", last: "" };
}

// ---------------------------------------------------------------------------
// Billing anchor + first-period stub
// ---------------------------------------------------------------------------

function daysInMonthOf(ymd: string) {
  const [y, m] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The anchor day as it falls in `ymd`'s month (anchor 31 → 30/28 in short months). */
function anchorIn(ymd: string, anchor: number) {
  return Math.min(anchor, daysInMonthOf(ymd));
}

/** First billing-anchor date strictly after `ymd` (or `ymd` itself when it already is the anchor). */
export function nextAnchorOnOrAfter(ymd: string, anchor: number): string {
  const day = Number(ymd.slice(8, 10));
  if (day === anchorIn(ymd, anchor)) return ymd;
  if (day < anchorIn(ymd, anchor)) return `${ymd.slice(0, 8)}${String(anchorIn(ymd, anchor)).padStart(2, "0")}`;
  return addMonthsYmd(`${ymd.slice(0, 8)}01`, 1, anchor);
}

/** A monthly period starting off-anchor is a stub that runs up to the day before the next anchor date. */
export function isStubStart(version: Pick<Version, "interval">, anchorDay: number | null, periodStart: string) {
  return version.interval === "month" && anchorDay != null && Number(periodStart.slice(8, 10)) !== anchorIn(periodStart, anchorDay);
}

export type StubComputation = {
  periodStart: string;
  periodEnd: string;
  coveredDays: number;
  periodDays: number;
  grossMinor: number;
  policyAmountMinor: number;
  rule: string;
  overridden: boolean;
  overrideReason: string | null;
  nextBillDate: string;
};

/** Stub computation shown to staff before confirming, and used when billing it. */
export function computeStub(monthlyMinor: number, periodStart: string, anchorDay: number, method: MembershipPolicy["prorationMethod"], override?: { amountMinor: number; reason: string } | null): StubComputation {
  const nextBillDate = nextAnchorOnOrAfter(addDaysYmd(periodStart, 1), anchorDay);
  const prevAnchor = addMonthsYmd(nextBillDate, -1, anchorDay);
  const coveredDays = daysBetween(periodStart, nextBillDate);
  const periodDays = daysBetween(prevAnchor, nextBillDate);
  const p = partialPeriodPriceMinor(monthlyMinor, coveredDays, periodDays, method);
  return {
    periodStart,
    periodEnd: addDaysYmd(nextBillDate, -1),
    coveredDays,
    periodDays,
    grossMinor: override ? override.amountMinor : p.amountMinor,
    policyAmountMinor: p.amountMinor,
    rule: p.rule,
    overridden: !!override,
    overrideReason: override?.reason ?? null,
    nextBillDate,
  };
}

function discountOn(amount: number, d: typeof discounts.$inferSelect | null | undefined) {
  if (!d?.active) return 0;
  return d.kind === "percent" ? percentOf(amount, d.value) : Math.min(d.value, amount);
}

async function discountRow(tx: Tx, id: string | null) {
  if (!id) return null;
  const [d] = await tx.select().from(discounts).where(eq(discounts.id, id));
  return d ?? null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateMembershipInput = {
  athleteId: string;
  payerAccountId: string;
  productVersionId: string;
  startDate: string;
  /** Defaults to the policy anchor (the 1st). Recurring billing never anchors to the start day by default. */
  billingAnchorDay?: number | null;
  billingProvider?: InternalBillingProvider;
  /** Legacy explicit request; the family discount is now applied automatically from policy. */
  applyFamilyDiscount?: boolean;
  /** Staff override of the first-period stub amount (requires a reason; audited). */
  stubOverride?: { amountMinor: number; reason: string } | null;
  /** in_season memberships have a fixed end and never auto-renew. */
  kind?: MembershipKind;
  endDate?: string | null;
  today: string;
  isDemo?: boolean;
};

/** What creating this membership would bill: shown to staff before they confirm. */
export async function previewMembershipStart(tx: Tx, v: Viewer, input: Pick<CreateMembershipInput, "productVersionId" | "startDate" | "billingAnchorDay" | "payerAccountId" | "athleteId" | "stubOverride">) {
  assertCan(v, "billing.manage");
  if (!isYmd(input.startDate)) throw new UserError("Start date is required.");
  const policy = await membershipPolicy(tx, v.orgId);
  const { version, product } = await loadVersion(tx, v.orgId, input.productVersionId);
  const anchor = input.billingAnchorDay ?? policy.billingAnchorDay;
  const willHaveFamily = await familyAthleteCount(tx, v.orgId, input.payerAccountId, input.athleteId);
  const discountPercent = willHaveFamily >= 2 && policy.familyDiscountPercent > 0 ? policy.familyDiscountPercent : 0;
  const stub = version.trialDays === 0 && isStubStart(version, anchor, input.startDate) ? computeStub(version.priceMinor, input.startDate, anchor, policy.prorationMethod, input.stubOverride) : null;
  const firstRegular = stub ? stub.nextBillDate : version.trialDays > 0 ? addDaysYmd(input.startDate, version.trialDays) : input.startDate;
  return {
    productName: product.name,
    version,
    anchorDay: version.interval === "month" ? anchor : null,
    prorationMethod: policy.prorationMethod,
    stub: stub ? { ...stub, discountMinor: percentOf(stub.grossMinor, discountPercent), netMinor: stub.grossMinor - percentOf(stub.grossMinor, discountPercent) } : null,
    firstRegularBillDate: firstRegular,
    regular: { grossMinor: version.priceMinor, discountMinor: percentOf(version.priceMinor, discountPercent), netMinor: version.priceMinor - percentOf(version.priceMinor, discountPercent) },
    discountPercent,
    commitment: version.commitmentMonths > 0 ? { startsOn: firstRegular, endsOn: addDaysYmd(addMonthsYmd(firstRegular, version.commitmentMonths), -1), months: version.commitmentMonths } : null,
  };
}

export async function createMembership(tx: Tx, v: Viewer, input: CreateMembershipInput) {
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
  if (!isYmd(input.startDate)) throw new UserError("Start date is required.");
  const policy = await membershipPolicy(tx, v.orgId);
  const anchor = input.billingAnchorDay ?? policy.billingAnchorDay;
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new UserError("Billing anchor day must be 1–31.");
  const kind = input.kind ?? "regular";
  if (kind === "in_season" && (!isYmd(input.endDate) || input.endDate < input.startDate)) throw new UserError("An In Season membership needs an end date on or after its start.");
  if (input.stubOverride) {
    if (!input.stubOverride.reason?.trim()) throw new UserError("Overriding the first-period amount requires a reason.", { stubOverrideReason: "Required" });
    if (!Number.isInteger(input.stubOverride.amountMinor) || input.stubOverride.amountMinor < 0) throw new UserError("Enter the first-period amount in dollars and cents.");
  }

  if (input.applyFamilyDiscount) {
    const siblings = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.payerAccountId, p.id), ne(memberships.athleteId, a.id), inArray(memberships.status, LIVE_STATUSES)));
    if (!siblings.length) throw new UserError("Family discount needs another live membership on the same payer account.");
  }

  const trial = version.trialDays > 0;
  const billingProvider = input.billingProvider ?? "manual";
  if (billingProvider !== "manual" && billingProvider !== "none") {
    throw new UserError("Create the membership with Teamwork invoices, then switch it to a Stripe or PayPal subscription from the membership page.");
  }
  const stub = billingProvider === "manual" && !trial && isStubStart(version, anchor, input.startDate) ? computeStub(version.priceMinor, input.startDate, anchor, policy.prorationMethod, input.stubOverride) : null;
  const firstRegular = stub ? stub.nextBillDate : trial ? addDaysYmd(input.startDate, version.trialDays) : input.startDate;
  const commitmentStartsOn = version.commitmentMonths > 0 && kind === "regular" ? firstRegular : null;
  const commitmentEndsOn = commitmentStartsOn ? addDaysYmd(addMonthsYmd(commitmentStartsOn, version.commitmentMonths), -1) : null;
  const [m] = await tx
    .insert(memberships)
    .values({
      orgId: v.orgId,
      athleteId: a.id,
      payerAccountId: p.id,
      productVersionId: version.id,
      status: trial ? "trialing" : billingProvider === "none" ? "active" : "pending",
      startDate: input.startDate,
      endDate: kind === "in_season" ? input.endDate! : null,
      cancelAt: kind === "in_season" ? addDaysYmd(input.endDate!, 1) : null,
      billingAnchorDay: version.interval === "month" ? anchor : Number(input.startDate.slice(8, 10)),
      nextBillDate: billingProvider === "none" ? null : trial ? addDaysYmd(input.startDate, version.trialDays) : input.startDate,
      billingProvider,
      kind,
      commitmentStartsOn,
      commitmentEndsOn,
      source: kind === "in_season" ? "in_season" : "teamwork",
      createdBy: v.userId,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  await event(tx, m, "created", v.userId, {
    toVersionId: version.id,
    effectiveOn: input.startDate,
    details: { trialDays: version.trialDays, billingProvider, kind, anchorDay: anchor, stub, commitmentStartsOn, commitmentEndsOn },
  });
  await audit(tx, actorOf(v), "billing.membership.create", "membership", m.id, {
    summary: `${product.name} v${version.version} for athlete starting ${input.startDate}${stub ? `; first period ${stub.periodStart}→${stub.periodEnd} ${stub.overridden ? `amount overridden (${stub.overrideReason})` : stub.rule}` : ""}`,
    after: m,
  });

  await syncFamilyDiscount(tx, actorOf(v), v.orgId, p.id, { policy });
  const [fresh] = await tx.select().from(memberships).where(eq(memberships.id, m.id));

  // Internally invoiced plans bill the first period now. A mid-month start bills its stub right away
  // (due on the start date) even when the start is in the future, so the computation staff saw is what is billed.
  let firstInvoice = null;
  if (billingProvider === "manual" && !trial && (stub || input.startDate <= input.today)) {
    firstInvoice = await billPeriod(tx, actorOf(v), fresh, version, product.name, input.startDate, { stub, policy });
  }
  const [after] = await tx.select().from(memberships).where(eq(memberships.id, m.id));
  return { membership: after, firstInvoice, stub };
}

/** Amount for one period after the membership's discount. */
export async function periodPrice(tx: Tx, m: Pick<Membership, "discountId">, version: Version, grossMinor = version.priceMinor) {
  const discount = discountOn(grossMinor, await discountRow(tx, m.discountId));
  return { gross: grossMinor, discount, net: grossMinor - discount };
}

/**
 * Create the invoice for one billing period and advance next_bill_date. The unique
 * (membership_id, period_start) index guarantees a period is billed at most once.
 * A monthly period starting off the anchor (mid-month start, restart after a hold) is a stub
 * priced by the policy method up to the next anchor date; a fixed-term membership's last period
 * is cut at its end date and priced the same way.
 */
export async function billPeriod(
  tx: Tx,
  actor: AuditActor,
  m: Membership,
  version: Version,
  productName: string,
  periodStart: string,
  opts: { stub?: StubComputation | null; policy?: MembershipPolicy } = {},
) {
  if (m.billingProvider !== "manual") throw new UserError("Only internally invoiced memberships are billed here.");
  const policy = opts.policy ?? (await membershipPolicy(tx, m.orgId));
  const stub = opts.stub ?? (isStubStart(version, m.billingAnchorDay, periodStart) ? computeStub(version.priceMinor, periodStart, m.billingAnchorDay!, policy.prorationMethod) : null);
  const nextBillDate = stub ? stub.nextBillDate : addIntervalYmd(periodStart, version.interval, version.intervalCount, m.billingAnchorDay);
  let periodEnd = addDaysYmd(nextBillDate, -1);
  let gross = stub ? stub.grossMinor : version.priceMinor;
  let rule = stub ? (stub.overridden ? `first-period amount set by staff: ${stub.overrideReason}` : stub.rule) : null;
  if (m.endDate && periodEnd > m.endDate && version.interval === "month") {
    const covered = daysBetween(periodStart, addDaysYmd(m.endDate, 1));
    const p = partialPeriodPriceMinor(version.priceMinor, covered, daysBetween(periodStart, nextBillDate), policy.prorationMethod);
    periodEnd = m.endDate;
    gross = Math.min(gross, p.amountMinor);
    rule = `final period ends ${m.endDate}: ${p.rule}`;
  }
  const price = await periodPrice(tx, m, version, gross);
  const fraction = version.priceMinor > 0 ? gross / version.priceMinor : 1;
  const credits = version.unlimited || version.classesPerWeek != null || !version.creditsPerPeriod ? undefined : Math.max(1, Math.ceil(version.creditsPerPeriod * Math.min(1, fraction)));
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
    memo: rule ? `Partial period (${rule}).` : undefined,
    lines: [
      {
        description: `${productName} — ${periodStart} to ${periodEnd}${stub ? " (first partial month)" : ""}`,
        unitAmountMinor: gross,
        productVersionId: version.id,
        athleteId: m.athleteId,
        entitlement: {
          credits,
          unlimitedUntil: version.unlimited ? periodEnd : undefined,
          activateMembershipId: m.id,
          serviceTypeIds: version.serviceTypeIds,
        },
      },
    ],
  });
  await tx
    .update(memberships)
    .set({ nextBillDate: m.endDate && nextBillDate > m.endDate ? null : nextBillDate, updatedAt: new Date() })
    .where(eq(memberships.id, m.id));
  if (stub && res.created) {
    await event(tx, m, "stub_billed", actor.actorUserId ?? null, { effectiveOn: periodStart, details: { ...stub, invoiceId: res.invoice.id, discountMinor: price.discount } });
  }
  return res.invoice;
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/**
 * Commitment progress for the membership page. After the term the membership simply continues
 * month-to-month at the committed rate (same version); it never rolls into a new commitment.
 */
export function commitmentStatus(m: Pick<Membership, "commitmentStartsOn" | "commitmentEndsOn">, version: Pick<Version, "commitmentMonths">, today: string, netMonthlyMinor: number) {
  if (!m.commitmentStartsOn || !m.commitmentEndsOn || version.commitmentMonths <= 0) return null;
  const total = version.commitmentMonths;
  let served = 0;
  for (let i = 1; i <= total; i++) if (addMonthsYmd(m.commitmentStartsOn, i) <= addDaysYmd(today, 1)) served = i;
  if (today < m.commitmentStartsOn) served = 0;
  const remaining = Math.max(0, total - served);
  return {
    months: total,
    startsOn: m.commitmentStartsOn,
    endsOn: m.commitmentEndsOn,
    served,
    remaining,
    remainingValueMinor: remaining * netMonthlyMinor,
    ended: today > m.commitmentEndsOn,
  };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export type AddHoldInput = {
  membershipId: string;
  startDate: string;
  /** Last held day. Either this or restartDate (first day back) is required. */
  endDate?: string | null;
  /** Firm restart date (first day the membership is active again). */
  restartDate?: string | null;
  reason: string;
  /** Local date the family SENT the request; the hold may be backdated to it. Defaults to today. */
  requestedOn?: string | null;
  requestChannel?: RequestChannel | null;
  requestedAt?: Date | null;
  /** Past the cap: staff reason (audited). */
  overrideReason?: string | null;
  /** Already-billed case: staff-set number of unused sessions (required when the plan has no weekly cap). */
  unusedSessions?: { count: number; reason: string } | null;
  /** Grant a punch card even though the member is not eligible (month-to-month: staff decision). */
  grantMakeup?: { reason: string } | null;
  today: string;
};

/** Membership-year boundaries (anniversaries of the start date) overlapping [from, to]. */
function membershipYears(startDate: string, from: string, to: string) {
  const out: { start: string; end: string }[] = [];
  let ys = startDate;
  for (let i = 0; i < 50 && addMonthsYmd(ys, 12) <= from; i++) ys = addMonthsYmd(startDate, 12 * (i + 1));
  for (let i = 0; i < 50 && ys <= to; i++) {
    const next = addMonthsYmd(ys, 12);
    out.push({ start: ys, end: addDaysYmd(next, -1) });
    ys = next;
  }
  return out;
}

function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return e < s ? 0 : daysBetween(s, e) + 1;
}

/** Hold days used per membership year vs. the cap (policy holdMaxMonthsPerMembershipYear × 31 days). */
export function holdCapCheck(startDate: string, existing: { startDate: string; endDate: string }[], next: { startDate: string; endDate: string }, capMonths: number) {
  const capDays = capMonths * CAP_DAYS_PER_MONTH;
  const years = membershipYears(startDate < next.startDate ? startDate : next.startDate, next.startDate, next.endDate);
  return years.map((y) => {
    const used = existing.reduce((s, h) => s + overlapDays(h.startDate, h.endDate, y.start, y.end), 0);
    const adding = overlapDays(next.startDate, next.endDate, y.start, y.end);
    return { yearStart: y.start, yearEnd: y.end, usedDays: used, addingDays: adding, capDays, over: used + adding > capDays };
  });
}

/** In-season days in every rolling 365-day window touching the new term vs. the cap. */
export function inSeasonCapCheck(existing: { startDate: string; endDate: string }[], next: { startDate: string; endDate: string }, capMonths: number) {
  const capDays = capMonths * CAP_DAYS_PER_MONTH;
  const all = [...existing, next];
  const windows = all.flatMap((t) => [
    { start: t.startDate, end: addDaysYmd(t.startDate, 364) },
    { start: addDaysYmd(t.endDate, -364), end: t.endDate },
  ]).filter((w) => overlapDays(w.start, w.end, next.startDate, next.endDate) > 0);
  let worst = { start: next.startDate, end: addDaysYmd(next.startDate, 364), days: 0 };
  for (const w of windows) {
    const days = all.reduce((s, t) => s + overlapDays(t.startDate, t.endDate, w.start, w.end), 0);
    if (days > worst.days) worst = { ...w, days };
  }
  return { capDays, worstWindow: worst, over: worst.days > capDays };
}

/**
 * Unused sessions in the already-paid period from the request date forward: weekly cap × weeks in that
 * window minus sessions actually used (attended / no-show) under this membership in that window.
 */
async function unusedSessionsInPeriod(tx: Tx, m: Membership, version: Version, fromYmd: string, periodEnd: string) {
  if (fromYmd > periodEnd) return { entitled: 0, used: 0, unused: 0, method: "request after period end" };
  const windowDays = daysBetween(fromYmd, periodEnd) + 1;
  if (version.classesPerWeek != null) {
    const entitled = Math.round((version.classesPerWeek * windowDays) / 7);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
      .where(
        and(
          eq(bookings.athleteId, m.athleteId),
          eq(bookings.membershipId, m.id),
          inArray(bookings.status, ["attended", "no_show"]),
          sql`${scheduleSessions.startsAt} >= ${localToUtc(fromYmd, "00:00").toISOString()}::timestamptz`,
          sql`${scheduleSessions.startsAt} < ${localToUtc(addDaysYmd(periodEnd, 1), "00:00").toISOString()}::timestamptz`,
        ),
      );
    const used = row?.n ?? 0;
    return { entitled, used, unused: Math.max(0, entitled - used), method: `${version.classesPerWeek}x/week × ${windowDays} days ÷ 7 = ${entitled}, minus ${used} used` };
  }
  if (version.creditsPerPeriod && !version.unlimited) {
    const [row] = await tx
      .select({ n: sql<number>`coalesce(sum(${creditBuckets.available}),0)::int` })
      .from(creditBuckets)
      .where(and(eq(creditBuckets.membershipId, m.id), eq(creditBuckets.status, "active"), lte(creditBuckets.periodStart, periodEnd), gte(creditBuckets.periodEnd, fromYmd)));
    return { entitled: version.creditsPerPeriod, used: version.creditsPerPeriod - (row?.n ?? 0), unused: row?.n ?? 0, method: "unused credits left in the paid period" };
  }
  return null; // unlimited: staff enter the number
}

export async function addHold(tx: Tx, v: Viewer, input: AddHoldInput) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A reason is required for a hold.");
  const restartDate = isYmd(input.restartDate) ? input.restartDate : isYmd(input.endDate) ? addDaysYmd(input.endDate, 1) : null;
  if (!restartDate) throw new UserError("A firm restart date is required for a hold.", { restartDate: "Required" });
  const endDate = addDaysYmd(restartDate, -1);
  if (!isYmd(input.startDate) || endDate < input.startDate) throw new UserError("Hold end date must be on or after its start date (restart after the hold start).");
  const requestedOn = isYmd(input.requestedOn) ? input.requestedOn : input.today;
  if (input.requestChannel && !REQUEST_CHANNELS.includes(input.requestChannel)) throw new UserError("Choose how the family sent the request.");
  if (input.startDate < input.today && input.startDate < requestedOn) {
    throw new UserError(`A hold can be backdated only to the date the family sent the request (${requestedOn}).`, { startDate: "Before the request date" });
  }
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.status === "cancelled" || m.status === "expired") throw new UserError("Cannot hold a cancelled or expired membership.");
  if (m.billingProvider === "external_zenplanner") throw new UserError("Holds for Zen Planner-billed memberships must be made in Zen Planner until cutover.");
  refuseProviderBilled(m, "A hold");
  const policy = await membershipPolicy(tx, v.orgId);
  const existing = await holdsFor(tx, m.id);
  if (existing.some((h) => h.startDate <= endDate && h.endDate >= input.startDate)) throw new UserError("This hold overlaps an existing hold.");

  const cap = holdCapCheck(
    m.startDate,
    existing.filter((h) => h.kind === "hold"),
    { startDate: input.startDate, endDate },
    policy.holdMaxMonthsPerMembershipYear,
  );
  const over = cap.find((c) => c.over);
  if (over && !input.overrideReason?.trim()) {
    throw new UserError(
      `This hold would bring the membership year starting ${over.yearStart} to ${over.usedDays + over.addingDays} held days; the policy allows ${policy.holdMaxMonthsPerMembershipYear} months (${over.capDays} days). Add an override reason to continue.`,
      { overrideReason: "Over the hold cap" },
    );
  }

  const [h] = await tx
    .insert(membershipHolds)
    .values({
      membershipId: m.id,
      startDate: input.startDate,
      endDate,
      kind: "hold",
      reason: input.reason.trim(),
      requestedAt: input.requestedAt ?? new Date(),
      requestedOn,
      requestChannel: input.requestChannel ?? null,
      overrideReason: over ? input.overrideReason!.trim() : null,
      createdBy: v.userId,
    })
    .returning();

  // Already-billed case: the period containing the request date was paid when the family asked.
  const [version] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
  const [paidPeriod] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.membershipId, m.id), lte(invoices.periodStart, requestedOn), gte(invoices.periodEnd, requestedOn), sql`${invoices.status} <> 'void'`));
  let makeup: { granted: number; bucketId: string | null; eligible: boolean; computation: string; decision: string } | null = null;
  const paidWhenAsked = !!paidPeriod && paidPeriod.status === "paid" && !!paidPeriod.paidAt && paidPeriod.paidAt < localToUtc(addDaysYmd(requestedOn, 1), "00:00");
  if (paidWhenAsked) {
    const eligible = version.commitmentMonths >= policy.holdCreditEligibleCommitmentMonths && m.status === "active";
    const counted = await unusedSessionsInPeriod(tx, m, version, requestedOn > input.startDate ? requestedOn : input.startDate, paidPeriod.periodEnd!);
    if (input.unusedSessions && !input.unusedSessions.reason?.trim()) throw new UserError("Setting the unused-session count needs a reason.");
    const count = input.unusedSessions ? input.unusedSessions.count : counted?.unused ?? null;
    const computation = input.unusedSessions ? `set by staff: ${input.unusedSessions.count} (${input.unusedSessions.reason})` : counted ? counted.method : "unlimited plan: staff must enter the unused sessions";
    const grant = eligible || !!input.grantMakeup?.reason?.trim();
    let bucketId: string | null = null;
    let granted = 0;
    if (grant && count != null && count > 0) {
      const expiresOn = addMonthsYmd(input.today, policy.punchCardExpiryMonths);
      const r = await grantCredits(tx, {
        orgId: v.orgId,
        athleteId: m.athleteId,
        amount: count,
        sourceKind: "hold_makeup",
        membershipId: m.id,
        serviceTypeIds: version.serviceTypeIds,
        periodStart: restartDate,
        periodEnd: expiresOn,
        expiresAt: localToUtc(expiresOn, "00:00"),
        actorUserId: v.userId,
        reason: `Punch card for ${count} unused paid session(s) (${computation}); usable from ${restartDate}, expires ${expiresOn}`,
        idempotencyKey: `hold-makeup:${h.id}`,
        isDemo: m.isDemo,
      });
      bucketId = r.bucket.id;
      granted = count;
      await tx.update(membershipHolds).set({ makeupBucketId: bucketId }).where(eq(membershipHolds.id, h.id));
    }
    const decision = !grant ? "staff decision needed (not a 12-month commitment, or not active)" : count == null ? "staff must enter unused sessions" : count === 0 ? "no unused sessions" : eligible ? "granted (eligible)" : `granted by staff decision: ${input.grantMakeup!.reason}`;
    makeup = { granted, bucketId, eligible, computation, decision };
    if (!grant || count == null) {
      const who = await athleteFirstName(tx, m.athleteId);
      await billingTask(tx, v.orgId, {
        title: `Hold punch card decision: ${who.first} ${who.last}`,
        description: `Invoice ${paidPeriod.number} was paid when the hold request was sent (${requestedOn}). ${computation}. ${!grant ? "Month-to-month or not active: decide whether to grant a punch card." : "Enter the number of unused sessions."}`,
        relatedType: "membership",
        relatedId: m.id,
        dedupeKey: `hold-makeup-decision:${h.id}`,
        priority: "normal",
      });
    }
  }

  await event(tx, m, "hold_added", v.userId, {
    effectiveOn: input.startDate,
    details: { holdId: h.id, endDate, restartDate, reason: input.reason, requestedOn, requestChannel: input.requestChannel ?? null, backdated: input.startDate < input.today, capOverride: h.overrideReason, makeup },
  });
  if (input.startDate <= input.today && endDate >= input.today && m.status !== "on_hold") {
    await tx.update(memberships).set({ status: "on_hold", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  }
  await audit(tx, actorOf(v), "billing.membership.hold", "membership", m.id, {
    summary: `Hold ${input.startDate} → restart ${restartDate}: ${input.reason}${h.overrideReason ? ` (hold cap overridden: ${h.overrideReason})` : ""}${makeup?.granted ? `; punch card ${makeup.granted} session(s)` : ""}`,
    after: h,
  });
  const who = await athleteFirstName(tx, m.athleteId);
  await scheduleRestartNudge(tx, v.orgId, { membershipId: m.id, holdId: h.id, restartDate, label: `${who.first} ${who.last}`, kind: "hold", policy, isDemo: m.isDemo });
  return { ...h, restartDate, makeup, cap };
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

// ---------------------------------------------------------------------------
// Restart nudges
// ---------------------------------------------------------------------------

export const RESTART_TRIGGER = "membership_restart_upcoming" as const;

/**
 * When a hold or in-season term is created, schedule (a) an automation evaluation for the
 * membership_restart_upcoming trigger at restart − restartNudgeDaysBefore (it only messages families
 * when an enabled rule exists, and delivery stays gated by messaging rules) and (b) a staff task.
 * Both are deduped per hold.
 */
export async function scheduleRestartNudge(
  tx: Tx,
  orgId: string,
  r: { membershipId: string; holdId: string; restartDate: string; label: string; kind: "hold" | "in_season"; policy: MembershipPolicy; isDemo?: boolean },
) {
  const nudgeOn = addDaysYmd(r.restartDate, -r.policy.restartNudgeDaysBefore);
  const at = localToUtc(nudgeOn, "09:00");
  const runAt = at.getTime() < Date.now() ? new Date() : at;
  const jobId = await enqueue(tx, {
    type: "automation.evaluate",
    orgId,
    payload: { orgId, trigger: RESTART_TRIGGER, membershipId: r.membershipId },
    dedupeKey: `restart_nudge:${r.holdId}`,
    runAt,
  });
  await billingTask(tx, orgId, {
    title: `Restart nudge: ${r.label} restarts ${r.restartDate}`,
    description: `${r.kind === "hold" ? "Hold" : "In-season term"} ends ${addDaysYmd(r.restartDate, -1)}. Confirm the restart with the family (training days, payment method).`,
    relatedType: "membership",
    relatedId: r.membershipId,
    dedupeKey: `restart-nudge:${r.holdId}`,
    dueAt: runAt,
    isDemo: r.isDemo,
  });
  return { runAt, jobId };
}

// ---------------------------------------------------------------------------
// In-season
// ---------------------------------------------------------------------------

/**
 * Switch to In Season: pause the regular membership for [start, end] (an in_season hold, never a
 * cancellation) and add an In Season membership with an explicit start/end that never auto-renews.
 * The regular membership resumes on its own the day after; its commitment term carries over unchanged.
 * 12-month members are capped at inSeasonMaxMonthsPer365Days per rolling 365 days (override with a reason).
 */
export async function startInSeason(
  tx: Tx,
  v: Viewer,
  input: {
    membershipId: string;
    inSeasonVersionId: string;
    startDate: string;
    endDate: string;
    reason: string;
    requestedOn?: string | null;
    requestChannel?: RequestChannel | null;
    overrideReason?: string | null;
    stubOverride?: { amountMinor: number; reason: string } | null;
    today: string;
  },
) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A reason is required (e.g. the sport and season).");
  if (!isYmd(input.startDate) || !isYmd(input.endDate) || input.endDate < input.startDate) throw new UserError("In-season start and end dates are required, end on or after start.");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.kind !== "regular") throw new UserError("Start the in-season term from the athlete's regular membership.");
  if (!LIVE_STATUSES.includes(m.status)) throw new UserError("Only a live membership can switch to In Season.");
  if (m.billingProvider !== "manual" && m.billingProvider !== "none") refuseProviderBilled(m, "An in-season switch");
  if (m.billingProvider === "external_zenplanner") throw new UserError("Zen Planner-billed memberships switch to In Season in Zen Planner until cutover.");
  const policy = await membershipPolicy(tx, v.orgId);
  const [regularVersion] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
  const existing = await holdsFor(tx, m.id);
  if (existing.some((h) => h.startDate <= input.endDate && h.endDate >= input.startDate)) throw new UserError("The in-season dates overlap an existing hold or in-season term.");
  let capInfo: ReturnType<typeof inSeasonCapCheck> | null = null;
  if (regularVersion.commitmentMonths >= 12) {
    capInfo = inSeasonCapCheck(existing.filter((h) => h.kind === "in_season"), { startDate: input.startDate, endDate: input.endDate }, policy.inSeasonMaxMonthsPer365Days);
    if (capInfo.over && !input.overrideReason?.trim()) {
      throw new UserError(
        `12-month members can be in season ${policy.inSeasonMaxMonthsPer365Days} months (${capInfo.capDays} days) per rolling 365 days; ${capInfo.worstWindow.start} to ${capInfo.worstWindow.end} would have ${capInfo.worstWindow.days}. Add an override reason to continue.`,
        { overrideReason: "Over the in-season cap" },
      );
    }
  }
  const { membership: ins, firstInvoice } = await createMembership(tx, v, {
    athleteId: m.athleteId,
    payerAccountId: m.payerAccountId!,
    productVersionId: input.inSeasonVersionId,
    startDate: input.startDate,
    endDate: input.endDate,
    kind: "in_season",
    billingProvider: m.billingProvider === "none" ? "none" : "manual",
    stubOverride: input.stubOverride,
    today: input.today,
    isDemo: m.isDemo,
  });
  const [h] = await tx
    .insert(membershipHolds)
    .values({
      membershipId: m.id,
      startDate: input.startDate,
      endDate: input.endDate,
      kind: "in_season",
      reason: input.reason.trim(),
      requestedOn: isYmd(input.requestedOn) ? input.requestedOn : input.today,
      requestChannel: input.requestChannel ?? null,
      overrideReason: capInfo?.over ? input.overrideReason!.trim() : null,
      relatedMembershipId: ins.id,
      requestedAt: new Date(),
      createdBy: v.userId,
    })
    .returning();
  if (input.startDate <= input.today && input.endDate >= input.today && m.status !== "on_hold") {
    await tx.update(memberships).set({ status: "on_hold", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  }
  await event(tx, m, "in_season_started", v.userId, {
    effectiveOn: input.startDate,
    details: { holdId: h.id, inSeasonMembershipId: ins.id, endDate: input.endDate, resumesOn: addDaysYmd(input.endDate, 1), commitmentCarriesOver: !!m.commitmentEndsOn, commitmentEndsOn: m.commitmentEndsOn, capOverride: h.overrideReason },
  });
  await event(tx, ins, "in_season_term", v.userId, { effectiveOn: input.startDate, details: { regularMembershipId: m.id, endDate: input.endDate, autoRenews: false } });
  await audit(tx, actorOf(v), "billing.membership.in_season", "membership", m.id, {
    summary: `In season ${input.startDate} → ${input.endDate} (${input.reason}); regular membership resumes ${addDaysYmd(input.endDate, 1)}${h.overrideReason ? `; cap overridden: ${h.overrideReason}` : ""}`,
    after: { hold: h, inSeasonMembershipId: ins.id },
  });
  const who = await athleteFirstName(tx, m.athleteId);
  await scheduleRestartNudge(tx, v.orgId, { membershipId: m.id, holdId: h.id, restartDate: addDaysYmd(input.endDate, 1), label: `${who.first} ${who.last}`, kind: "in_season", policy, isDemo: m.isDemo });
  return { hold: h, inSeasonMembership: ins, firstInvoice, cap: capInfo };
}

// ---------------------------------------------------------------------------
// Family discount
// ---------------------------------------------------------------------------

const FAMILY_DISCOUNT_PREFIXES = ["Family discount", "Sibling discount"];
const isFamilyDiscount = (d: { name: string } | null) => !!d && FAMILY_DISCOUNT_PREFIXES.some((p) => d.name.startsWith(p));

async function familyDiscountId(tx: Tx, orgId: string, percent: number) {
  const name = `Family discount ${percent}%`;
  const [d] = await tx.select().from(discounts).where(and(eq(discounts.orgId, orgId), eq(discounts.name, name), eq(discounts.kind, "percent"), eq(discounts.value, percent)));
  if (d) return d.id;
  const [nd] = await tx.insert(discounts).values({ orgId, name, kind: "percent", value: percent }).returning();
  return nd.id;
}

/** Distinct athletes with a live membership on this payer account (optionally counting one more athlete). */
async function familyAthleteCount(tx: Tx, orgId: string, payerAccountId: string, plusAthleteId?: string) {
  const rows = await tx
    .selectDistinct({ athleteId: memberships.athleteId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.payerAccountId, payerAccountId), inArray(memberships.status, LIVE_STATUSES)));
  const ids = new Set(rows.map((r) => r.athleteId));
  if (plusAthleteId) ids.add(plusAthleteId);
  return ids.size;
}

/**
 * Family discount: once 2+ athletes on a payer account have live memberships, every one of their
 * Teamwork-billed memberships gets the policy percentage; below 2 it is removed. Other (non-family)
 * discounts are never touched. Every change writes a membership event and an audit entry.
 * Provider-billed memberships are left alone (the provider amount is fixed) and get a staff task.
 */
export async function syncFamilyDiscount(tx: Tx, actor: AuditActor, orgId: string, payerAccountId: string, opts: { policy?: MembershipPolicy } = {}) {
  const policy = opts.policy ?? (await membershipPolicy(tx, orgId));
  const live = await tx
    .select({ m: memberships, d: discounts })
    .from(memberships)
    .leftJoin(discounts, eq(discounts.id, memberships.discountId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.payerAccountId, payerAccountId), inArray(memberships.status, LIVE_STATUSES)))
    .for("update", { of: memberships });
  const athletesEnrolled = new Set(live.map((r) => r.m.athleteId)).size;
  const qualifies = athletesEnrolled >= 2 && policy.familyDiscountPercent > 0;
  const targetId = qualifies ? await familyDiscountId(tx, orgId, policy.familyDiscountPercent) : null;
  const changes: { membershipId: string; action: "applied" | "removed" }[] = [];
  for (const { m, d } of live) {
    if (m.billingProvider === "external_zenplanner") continue;
    if (d && !isFamilyDiscount(d)) continue; // another discount is in place: don't stack or replace
    const want = qualifies ? targetId : null;
    if ((m.discountId ?? null) === want) continue;
    if (isProviderBilled(m)) {
      await billingTask(tx, orgId, {
        title: `Family discount change needs the ${m.billingProvider} subscription updated`,
        description: `${athletesEnrolled} athlete(s) enrolled on this payer account; the family discount should be ${qualifies ? `${policy.familyDiscountPercent}%` : "removed"}.`,
        relatedType: "membership",
        relatedId: m.id,
        dedupeKey: `family-discount:${m.id}:${want ?? "none"}`,
      });
      continue;
    }
    await tx.update(memberships).set({ discountId: want, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    const action = want ? "applied" : "removed";
    changes.push({ membershipId: m.id, action });
    await tx.insert(membershipEvents).values({
      membershipId: m.id,
      type: want ? "family_discount_applied" : "family_discount_removed",
      effectiveOn: todayLocal(),
      actorUserId: actor.actorUserId,
      details: { percent: want ? policy.familyDiscountPercent : null, previous: d ? { name: d.name, value: d.value } : null, athletesEnrolled },
    });
    await audit(tx, { ...actor, orgId }, `billing.membership.family_discount_${action}`, "membership", m.id, {
      summary: want ? `Family discount ${policy.familyDiscountPercent}% applied (${athletesEnrolled} athletes enrolled)` : `Family discount removed (${athletesEnrolled} athlete enrolled)`,
      before: { discountId: m.discountId },
      after: { discountId: want },
    });
  }
  return { athletesEnrolled, qualifies, changes };
}

// ---------------------------------------------------------------------------
// Plan change / cancel / cutover
// ---------------------------------------------------------------------------

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
export function earliestCancelDate(
  m: Pick<Membership, "startDate"> & Partial<Pick<Membership, "commitmentEndsOn">>,
  version: Pick<Version, "cancellationNoticeDays" | "commitmentMonths">,
  requestedOn: string,
) {
  const byNotice = addDaysYmd(requestedOn, version.cancellationNoticeDays);
  const byCommitment = m.commitmentEndsOn ? addDaysYmd(m.commitmentEndsOn, 1) : version.commitmentMonths > 0 ? addMonthsYmd(m.startDate, version.commitmentMonths) : m.startDate;
  return byNotice > byCommitment ? byNotice : byCommitment;
}

/**
 * What a cancellation requested on `requestedOn` means: effective date (request + notice, or the end of
 * the commitment), the last bill date and the periods (and amount) still to be billed before it ends.
 */
export async function cancellationPreview(tx: Tx, orgId: string, membershipId: string, requestedOn: string, overrideCancelAt?: string | null) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, orgId)));
  if (!m) throw new UserError("Membership not found.");
  const [version] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
  const policy = await membershipPolicy(tx, orgId);
  const noticeDays = effectiveNoticeDays(version.cancellationNoticeDays, policy);
  const earliest = earliestCancelDate(m, { ...version, cancellationNoticeDays: noticeDays }, requestedOn);
  const effectiveOn = overrideCancelAt ?? earliest;
  const remaining: { periodStart: string; amountMinor: number }[] = [];
  const holds = await holdsFor(tx, m.id);
  if (m.billingProvider === "manual" && m.nextBillDate) {
    let d = m.nextBillDate;
    for (let i = 0; i < 36 && d < effectiveOn; i++) {
      const held = holds.find((h) => h.startDate <= d && h.endDate >= d);
      if (held) {
        d = addDaysYmd(held.endDate, 1);
        continue;
      }
      const stub = isStubStart(version, m.billingAnchorDay, d) ? computeStub(version.priceMinor, d, m.billingAnchorDay!, policy.prorationMethod) : null;
      const price = await periodPrice(tx, m, version, stub ? stub.grossMinor : version.priceMinor);
      remaining.push({ periodStart: d, amountMinor: price.net });
      d = stub ? stub.nextBillDate : addIntervalYmd(d, version.interval, version.intervalCount, m.billingAnchorDay);
    }
  }
  const invs = await tx.select().from(invoices).where(and(eq(invoices.membershipId, m.id), sql`${invoices.status} <> 'void'`)).orderBy(asc(invoices.periodStart));
  let openBalanceMinor = 0;
  for (const i of invs) if (i.status === "open") openBalanceMinor += (await invoiceMoney(tx, i.id)).balanceMinor;
  const lastInvoiced = invs.filter((i) => i.periodStart && i.periodStart < effectiveOn).pop()?.periodStart ?? null;
  return {
    requestedOn,
    noticeDays,
    earliest,
    effectiveOn,
    commitmentEndsOn: m.commitmentEndsOn,
    lastBillDate: remaining.length ? remaining[remaining.length - 1].periodStart : lastInvoiced,
    remaining,
    remainingTotalMinor: remaining.reduce((s, r) => s + r.amountMinor, 0),
    openBalanceMinor,
  };
}

/**
 * Schedule cancellation. 30 days' written notice (policy; a plan version can set its own), from the date
 * the family sent the request via any channel (recorded). Billing stops for periods starting on/after
 * cancel_at. Staff may override terms only with an explicit reason (audited).
 */
export async function cancelMembership(
  tx: Tx,
  v: Viewer,
  input: { membershipId: string; requestedOn: string; reason: string; today: string; requestChannel?: RequestChannel | null; overrideCancelAt?: string | null; overrideReason?: string | null },
) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A cancellation reason is required.");
  const m = await lockMembership(tx, v.orgId, input.membershipId);
  if (m.status === "cancelled" || m.status === "expired") throw new UserError("Membership is already ended.");
  if (m.billingProvider === "external_zenplanner") throw new UserError("Cancel Zen Planner-billed memberships in Zen Planner until cutover (Teamwork Hub does not bill them).");
  if (isProviderBilled(m)) throw new UserError("This membership is billed by a provider subscription. Use “Cancel subscription at period end” so the provider stops charging too.");
  if (input.requestChannel && !REQUEST_CHANNELS.includes(input.requestChannel)) throw new UserError("Choose how the family sent the request.");
  if (input.overrideCancelAt && !input.overrideReason?.trim()) throw new UserError("Overriding notice/commitment terms requires a reason.");
  const preview = await cancellationPreview(tx, v.orgId, m.id, input.requestedOn, input.overrideCancelAt ?? null);
  const { earliest } = preview;
  const cancelAt = preview.effectiveOn;
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
    details: {
      requestedOn: input.requestedOn,
      requestChannel: input.requestChannel ?? null,
      noticeDays: preview.noticeDays,
      earliestAllowed: earliest,
      lastBillDate: preview.lastBillDate,
      remainingTotalMinor: preview.remainingTotalMinor,
      overridden: !!input.overrideCancelAt,
      overrideReason: input.overrideReason ?? null,
      reason: input.reason,
    },
  });
  await audit(tx, actorOf(v), "billing.membership.cancel", "membership", m.id, {
    summary: `Cancellation ${immediate ? "effective" : "scheduled"} ${cancelAt}${input.requestChannel ? ` (requested ${input.requestedOn} by ${input.requestChannel.replaceAll("_", " ")})` : ""}${input.overrideCancelAt ? " (terms overridden)" : ""}: ${input.reason}`,
  });
  if (immediate && m.payerAccountId) await syncFamilyDiscount(tx, actorOf(v), v.orgId, m.payerAccountId);
  return { cancelAt, earliest, immediate, preview };
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
