/**
 * Provider-billed memberships: Stripe Billing subscriptions and PayPal Subscriptions.
 *
 * Invariants
 * - A membership is billed by exactly one system. Teamwork renewals only bill `billing_provider='manual'`;
 *   a provider-billed row has `next_bill_date IS NULL` (DB CHECK `memberships_provider_billed_not_renewed`),
 *   and createInvoiceRecord refuses provider-billed memberships unless the verified provider ingest records
 *   what the provider already charged.
 * - Staff start a switch with a *request* (membership event). Only a signed provider event that echoes the
 *   request (Stripe subscription metadata / PayPal custom_id, or the PayPal subscription id we got back)
 *   links the subscription. A second subscription, or one that starts after the request was withdrawn, is
 *   never linked: a high-priority task tells staff to cancel it at the provider.
 * - Money only moves on verified provider data. Each provider invoice/sale becomes one local invoice
 *   (idempotency key `<provider>-invoice:<id>`), one provider_verified transaction (unique provider txn id)
 *   and at most one credit grant per invoice line (grantCredits `invoice-line:<id>`), however many times or
 *   in whatever order the events arrive.
 * - Status events are applied only if they are not older than the last applied provider status for the
 *   membership (provider event timestamps); `cancelled` is terminal.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import {
  invoices,
  membershipEvents,
  membershipHolds,
  memberships,
  payerAccounts,
  products,
  productVersions,
  providerPlans,
  transactions,
} from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { getSubscriptionProvider, ProviderNotConfiguredError, ProviderUnsupportedError, type SubscriptionProviderName } from "@/lib/payments";
import type { NormalizedEvent, SubscriptionHint } from "@/lib/payments/provider";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { DeferError, UserError } from "./errors";
import { createInvoiceRecord, invoiceMoney, settleInvoiceIfCovered } from "./invoices";
import { earliestCancelDate, isProviderBilled, periodPrice } from "./memberships";
import { billingTask } from "./tasks";
import { actorOf, addIntervalYmd } from "./util";
import type { ProcessOutcome } from "./webhooks";

type Membership = typeof memberships.$inferSelect;
type Provider = SubscriptionProviderName;

const SYSTEM = (orgId: string) => ({ orgId, actorUserId: null, actorRole: "webhook" });
const LABEL: Record<Provider, string> = { stripe: "Stripe", paypal: "PayPal" };
const LIVE = ["pending", "trialing", "active", "on_hold", "past_due"] as const;

export const EV = {
  requested: "provider_subscription_requested",
  withdrawn: "provider_subscription_withdrawn",
  linked: "provider_subscription_linked",
  status: "provider_status",
  setupExpired: "provider_setup_expired",
  switchScheduled: "switch_to_teamwork_scheduled",
  switched: "billing_switched_to_teamwork",
  providerCancelled: "provider_subscription_cancelled",
} as const;

export type RequestState = "creating" | "pending" | "linked" | "withdrawn" | "failed" | "ended";
export type RequestDetails = {
  provider: Provider;
  requestId: string;
  state: RequestState;
  firstChargeDate: string | null;
  amountMinor: number;
  currency: string;
  providerPlanId?: string | null;
  providerRef?: string | null;
  approvalUrl?: string | null;
  providerSubscriptionId?: string | null;
  error?: string | null;
};

async function mergeDetails(tx: Tx | DB, eventId: string, patch: Record<string, unknown>) {
  await tx.execute(sql`update membership_events set details = coalesce(details, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb where id = ${eventId}`);
}

async function lockMembership(tx: Tx, orgId: string, id: string) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.orgId, orgId))).for("update");
  if (!m) throw new UserError("Membership not found.");
  return m;
}

async function requestEvents(tx: Tx, membershipId: string) {
  return tx
    .select()
    .from(membershipEvents)
    .where(and(eq(membershipEvents.membershipId, membershipId), eq(membershipEvents.type, EV.requested)))
    .orderBy(desc(membershipEvents.createdAt));
}

/** The open (creating/pending) switch request, if any. */
export async function openRequest(tx: Tx, membershipId: string) {
  const rows = await requestEvents(tx, membershipId);
  const r = rows.find((e) => {
    const st = (e.details as RequestDetails | null)?.state;
    return st === "creating" || st === "pending";
  });
  return r ? { event: r, details: r.details as RequestDetails } : null;
}

async function latestEvent(tx: Tx, membershipId: string, type: string) {
  const [e] = await tx
    .select()
    .from(membershipEvents)
    .where(and(eq(membershipEvents.membershipId, membershipId), eq(membershipEvents.type, type)))
    .orderBy(desc(membershipEvents.createdAt))
    .limit(1);
  return e ?? null;
}

/** Last day already covered by provider-paid invoices for this membership (null if none yet). */
async function providerPaidThrough(tx: Tx, m: Membership): Promise<string | null> {
  const [row] = await tx
    .select({ end: sql<string | null>`max(${invoices.periodEnd})` })
    .from(invoices)
    .where(and(eq(invoices.membershipId, m.id), eq(invoices.status, "paid"), sql`${invoices.idempotencyKey} like ${"%-invoice:%"}`));
  return row?.end ?? null;
}

// ---------------------------------------------------------------------------
// Staff actions (provider calls happen outside DB transactions)
// ---------------------------------------------------------------------------

export type StartOutcome =
  | { ok: true; approvalUrl: string; reused: boolean }
  | { ok: false; error: string; notConfigured?: { provider: Provider; envVars: string[] } };

/**
 * Start moving a Teamwork-invoiced membership onto a provider subscription. Creates (or reuses) the
 * provider price/plan for the membership's product version at its net period price, then a hosted
 * approval step for the payer. Nothing changes locally until a verified webhook links the subscription.
 * The first provider charge is scheduled for the membership's next Teamwork bill date, so no period is
 * charged twice.
 */
export async function startProviderSubscription(db: DB, v: Viewer, input: { membershipId: string; provider: Provider; appUrl: string; today?: string }): Promise<StartOutcome> {
  assertCan(v, "billing.manage");
  if (input.provider !== "stripe" && input.provider !== "paypal") return { ok: false, error: "Choose Stripe or PayPal." };
  const adapter = getSubscriptionProvider(input.provider);
  const today = input.today ?? todayLocal();

  const prep = await db.transaction(async (tx) => {
    const m = await lockMembership(tx, v.orgId, input.membershipId);
    if (m.billingProvider === "external_zenplanner") throw new UserError("This membership is still billed by Zen Planner. Cut it over to Teamwork invoices first.");
    if (m.billingProvider === "none") throw new UserError("This membership is complimentary; there is nothing to bill.");
    if (isProviderBilled(m)) throw new UserError(`This membership is already billed by its ${LABEL[m.billingProvider]} subscription.`);
    if (!(LIVE as readonly string[]).includes(m.status)) throw new UserError("Only live memberships can move to a provider subscription.");
    if (m.cancelAt) throw new UserError("A cancellation is scheduled for this membership; a subscription would keep charging after it.");
    if (!m.nextBillDate) throw new UserError("This membership has no next bill date to hand over to the provider.");
    if (!m.payerAccountId) throw new UserError("This membership has no payer account.");
    const holds = await tx.select().from(membershipHolds).where(and(eq(membershipHolds.membershipId, m.id), gte(membershipHolds.endDate, today)));
    if (holds.length) throw new UserError("This membership has a current or upcoming hold. Provider subscriptions do not honour Teamwork holds; finish or remove the hold first.");
    const open = await openRequest(tx, m.id);
    if (open) {
      if (open.details.provider === input.provider && open.details.state === "pending" && open.details.approvalUrl) return { reuse: open.details.approvalUrl };
      throw new UserError(`A ${LABEL[open.details.provider]} subscription request is already open. Withdraw it before starting another.`);
    }
    const [row] = await tx
      .select({ version: productVersions, product: products })
      .from(productVersions)
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(eq(productVersions.id, m.productVersionId));
    const ver = row.version;
    if (ver.interval === "none") throw new UserError("This plan has no billing interval.");
    if (!adapter.isConfigured()) return { notConfigured: true as const };
    const price = await periodPrice(tx, m, ver);
    if (price.net <= 0) throw new UserError("This plan's period price is $0; there is nothing for a provider to charge.");
    const currency = ver.currency.toUpperCase();
    const [cached] = await tx
      .select()
      .from(providerPlans)
      .where(and(eq(providerPlans.orgId, v.orgId), eq(providerPlans.provider, input.provider), eq(providerPlans.productVersionId, ver.id), eq(providerPlans.amountMinor, price.net), eq(providerPlans.currency, currency)));
    const [payer] = await tx.select({ email: payerAccounts.billingEmail }).from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId));
    const requestId = randomUUID();
    const details: RequestDetails = { provider: input.provider, requestId, state: "creating", firstChargeDate: m.nextBillDate, amountMinor: price.net, currency, providerPlanId: cached?.providerPlanId ?? null };
    const [ev] = await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.requested, actorUserId: v.userId, effectiveOn: m.nextBillDate, details }).returning();
    await audit(tx, actorOf(v), "billing.membership.subscription_requested", "membership", m.id, { summary: `${LABEL[input.provider]} subscription requested at ${price.net} ${currency}/${ver.interval}; first provider charge ${m.nextBillDate}` });
    return { m, ver, productName: row.product.name, price, currency, cached: cached ?? null, email: payer?.email ?? null, requestId, eventId: ev.id };
  });

  if ("reuse" in prep) return { ok: true, approvalUrl: prep.reuse as string, reused: true };
  if ("notConfigured" in prep) {
    return { ok: false, error: `${adapter.label} is not configured, so nothing was created or charged. The membership stays on Teamwork invoices.`, notConfigured: { provider: input.provider, envVars: adapter.missingEnv() } };
  }
  const { m, ver, productName, price, currency, requestId, eventId, email } = prep;
  try {
    let planId = prep.cached?.providerPlanId ?? null;
    if (!planId) {
      const plan = await adapter.ensurePlan({
        orgId: v.orgId,
        productVersionId: ver.id,
        productName,
        versionNumber: ver.version,
        amountMinor: price.net,
        currency,
        interval: ver.interval as "week" | "month" | "year",
        intervalCount: ver.intervalCount,
        idempotencyKey: `plan:${v.orgId}:${ver.id}:${price.net}:${currency}`,
      });
      await db
        .insert(providerPlans)
        .values({ orgId: v.orgId, provider: input.provider, productVersionId: ver.id, amountMinor: price.net, currency, providerProductId: plan.providerProductId, providerPlanId: plan.providerPlanId })
        .onConflictDoNothing();
      const [stored] = await db
        .select()
        .from(providerPlans)
        .where(and(eq(providerPlans.orgId, v.orgId), eq(providerPlans.provider, input.provider), eq(providerPlans.productVersionId, ver.id), eq(providerPlans.amountMinor, price.net), eq(providerPlans.currency, currency)));
      planId = stored.providerPlanId;
    }
    const res = await adapter.startSubscription({
      membershipId: m.id,
      requestId,
      providerPlanId: planId,
      description: `${productName} — Teamwork membership ${m.id}`,
      customerEmail: email,
      firstChargeDate: m.nextBillDate,
      successUrl: `${input.appUrl}/billing/memberships/${m.id}?subscription=returned`,
      cancelUrl: `${input.appUrl}/billing/memberships/${m.id}?subscription=cancelled`,
      idempotencyKey: `subscription:${requestId}`,
    });
    await mergeDetails(db, eventId, { state: "pending", providerPlanId: planId, providerRef: res.providerRef, approvalUrl: res.approvalUrl, providerSubscriptionId: res.providerSubscriptionId });
    return { ok: true, approvalUrl: res.approvalUrl, reused: false };
  } catch (e) {
    await mergeDetails(db, eventId, { state: "failed", error: (e as Error).message.slice(0, 500) });
    if (e instanceof ProviderNotConfiguredError) return { ok: false, error: e.message, notConfigured: { provider: input.provider, envVars: e.envVars } };
    if (e instanceof ProviderUnsupportedError) return { ok: false, error: e.message };
    return { ok: false, error: `${LABEL[input.provider]} did not accept the request, so nothing was created. The membership stays on Teamwork invoices.` };
  }
}

/**
 * "Bill with Teamwork invoices". An open request is withdrawn (a late approval will be refused and
 * flagged). A linked subscription is cancelled at period end; Teamwork renewals resume from the day after
 * the paid-through date once the provider confirms the subscription ended.
 */
export async function switchToTeamworkBilling(db: DB, v: Viewer, input: { membershipId: string; reason: string; today?: string }) {
  assertCan(v, "billing.manage");
  const today = input.today ?? todayLocal();
  const reason = input.reason.trim() || "Switched to Teamwork invoices";
  const step = await db.transaction(async (tx) => {
    const m = await lockMembership(tx, v.orgId, input.membershipId);
    const open = await openRequest(tx, m.id);
    if (open && !isProviderBilled(m)) {
      await mergeDetails(tx, open.event.id, { state: "withdrawn" });
      await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.withdrawn, actorUserId: v.userId, effectiveOn: today, details: { provider: open.details.provider, requestId: open.details.requestId, reason } });
      await audit(tx, actorOf(v), "billing.membership.subscription_withdrawn", "membership", m.id, { summary: `${LABEL[open.details.provider]} subscription request withdrawn: ${reason}` });
      return { withdrawn: true as const };
    }
    if (!isProviderBilled(m)) throw new UserError("This membership is already billed with Teamwork invoices.");
    if (m.cancelAt) throw new UserError("A cancellation is already scheduled for this membership.");
    const pending = await latestEvent(tx, m.id, EV.switchScheduled);
    if (pending && (pending.details as { providerSubscriptionId?: string } | null)?.providerSubscriptionId === m.providerSubscriptionId) {
      throw new UserError("The switch back to Teamwork invoices is already scheduled.");
    }
    return { m, paidThrough: await providerPaidThrough(tx, m) };
  });
  if ("withdrawn" in step) return { withdrawn: true, firstTeamworkBillDate: null as string | null };

  const { m } = step;
  const provider = m.billingProvider as Provider;
  const adapter = getSubscriptionProvider(provider);
  if (!adapter.isConfigured()) {
    throw new UserError(`${adapter.label} is not configured, so the subscription cannot be cancelled from here. Nothing was sent. Cancel it in the ${LABEL[provider]} dashboard; the verified cancellation webhook will then end it here.`);
  }
  const res = await adapter.cancelAtPeriodEnd({ providerSubscriptionId: m.providerSubscriptionId!, reason, idempotencyKey: `switch:${m.id}:${m.providerSubscriptionId}` });
  const paidThrough = res.paidThrough ?? step.paidThrough;
  const firstBill = paidThrough ? addDaysYmd(paidThrough, 1) : today;
  return db.transaction(async (tx) => {
    const fresh = await lockMembership(tx, v.orgId, m.id);
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.switchScheduled, actorUserId: v.userId, effectiveOn: firstBill, details: { provider, providerSubscriptionId: m.providerSubscriptionId, firstBillDate: firstBill, reason } });
    await audit(tx, actorOf(v), "billing.membership.switch_to_teamwork", "membership", m.id, { summary: `${LABEL[provider]} subscription set to stop; Teamwork invoices from ${firstBill}` });
    // PayPal's cancel endpoint answers 204 synchronously (authenticated API call): finish the switch now.
    if (res.immediate && isProviderBilled(fresh) && fresh.providerSubscriptionId === m.providerSubscriptionId) {
      await revertToTeamwork(tx, fresh, firstBill, actorOf(v), "provider cancel confirmed by API");
    }
    return { withdrawn: false, firstTeamworkBillDate: firstBill };
  });
}

/**
 * Cancel a provider-billed membership at the end of the paid period (Stripe cancel_at_period_end;
 * PayPal cancel = no further cycles). Notice/commitment terms still apply: if they end later than the
 * paid-through date, staff must schedule later or override with a reason.
 */
export async function cancelProviderSubscription(
  db: DB,
  v: Viewer,
  input: { membershipId: string; reason: string; requestedOn?: string; today?: string; overrideReason?: string | null },
) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A cancellation reason is required.");
  const today = input.today ?? todayLocal();
  const pre = await db.transaction(async (tx) => {
    const m = await lockMembership(tx, v.orgId, input.membershipId);
    if (!isProviderBilled(m) || !m.providerSubscriptionId) throw new UserError("This membership is not billed by a provider subscription.");
    if (!(LIVE as readonly string[]).includes(m.status)) throw new UserError("Membership is already ended.");
    if (m.cancelAt) throw new UserError("A cancellation is already scheduled.");
    const [version] = await tx.select().from(productVersions).where(eq(productVersions.id, m.productVersionId));
    const earliest = earliestCancelDate(m, version, input.requestedOn ?? today);
    const paid = await providerPaidThrough(tx, m);
    const candidate = paid ? addDaysYmd(paid, 1) : today;
    if (earliest > candidate && !input.overrideReason?.trim()) {
      throw new UserError(`Under the plan terms the earliest end is ${earliest}, but the subscription would stop after ${paid ?? "today"}. Cancel closer to ${earliest}, or override the terms with a reason.`);
    }
    return { m, earliest, candidate };
  });
  const provider = pre.m.billingProvider as Provider;
  const adapter = getSubscriptionProvider(provider);
  if (!adapter.isConfigured()) {
    throw new UserError(`${adapter.label} is not configured, so nothing was sent. Cancel it in the ${LABEL[provider]} dashboard; the verified webhook will update this membership.`);
  }
  const res = await adapter.cancelAtPeriodEnd({ providerSubscriptionId: pre.m.providerSubscriptionId!, reason: input.reason.trim(), idempotencyKey: `cancel:${pre.m.id}:${pre.m.providerSubscriptionId}` });
  const cancelAt = res.paidThrough ? addDaysYmd(res.paidThrough, 1) : pre.candidate;
  return db.transaction(async (tx) => {
    const m = await lockMembership(tx, v.orgId, pre.m.id);
    const immediate = cancelAt <= today;
    await tx
      .update(memberships)
      .set({ cancelAt, cancelReason: input.reason.trim(), status: immediate ? "cancelled" : m.status, endDate: immediate ? cancelAt : m.endDate, updatedAt: new Date() })
      .where(eq(memberships.id, m.id));
    await tx.insert(membershipEvents).values({
      membershipId: m.id,
      type: immediate ? "cancelled" : "cancel_scheduled",
      actorUserId: v.userId,
      effectiveOn: cancelAt,
      details: { provider, providerSubscriptionId: m.providerSubscriptionId, atPeriodEnd: true, earliestAllowed: pre.earliest, overrideReason: input.overrideReason ?? null, reason: input.reason.trim() },
    });
    await audit(tx, actorOf(v), "billing.membership.cancel", "membership", m.id, { summary: `${LABEL[provider]} subscription cancelled at period end; membership ends ${cancelAt}: ${input.reason.trim()}` });
    return { cancelAt, immediate };
  });
}

async function revertToTeamwork(tx: Tx, m: Membership, firstBillDate: string, actor: ReturnType<typeof actorOf>, why: string) {
  const subId = m.providerSubscriptionId;
  await tx.update(memberships).set({ billingProvider: "manual", providerSubscriptionId: null, nextBillDate: firstBillDate, updatedAt: new Date() }).where(eq(memberships.id, m.id));
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.switched, actorUserId: actor.actorUserId, effectiveOn: firstBillDate, details: { from: m.billingProvider, providerSubscriptionId: subId, firstBillDate, why } });
  for (const r of await requestEvents(tx, m.id)) {
    const d = r.details as RequestDetails | null;
    if (d?.providerSubscriptionId === subId || d?.state === "linked") await mergeDetails(tx, r.id, { state: "ended" });
  }
  await audit(tx, { ...actor, orgId: m.orgId }, "billing.membership.billing_switched", "membership", m.id, { summary: `Billing moved from ${m.billingProvider} back to Teamwork invoices from ${firstBillDate} (${why})` });
}

// ---------------------------------------------------------------------------
// Webhook application
// ---------------------------------------------------------------------------

type Resolved = { m: Membership; linkedNow: boolean } | { conflict: string } | { quiet: string } | null;

/**
 * Find the membership a provider subscription bills, linking it on first sight when it answers an open
 * request. Returns null when nothing local refers to the subscription.
 */
async function resolveMembership(tx: Tx, provider: Provider, subId: string, hint: SubscriptionHint | null): Promise<Resolved> {
  const [linked] = await tx.select().from(memberships).where(eq(memberships.providerSubscriptionId, subId)).for("update");
  if (linked) return linked.billingProvider === provider ? { m: linked, linkedNow: false } : { conflict: `subscription id linked to a ${linked.billingProvider} membership` };

  let membershipId = hint?.membershipId ?? null;
  let requestId = hint?.requestId ?? null;
  if (!membershipId) {
    const rows = await tx.execute(sql`
      select membership_id, details->>'requestId' as request_id from membership_events
      where type = ${EV.requested} and details->>'provider' = ${provider} and details->>'providerSubscriptionId' = ${subId}
      order by created_at desc limit 1`);
    const r = rows.rows[0] as { membership_id: string; request_id: string } | undefined;
    if (!r) return null;
    membershipId = r.membership_id;
    requestId = r.request_id;
  }
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).for("update");
  if (!m) return null;
  const reqs = await requestEvents(tx, m.id);
  const req = reqs.find((e) => {
    const d = e.details as RequestDetails | null;
    return d?.provider === provider && (requestId ? d.requestId === requestId : true) && (!d.providerSubscriptionId || d.providerSubscriptionId === subId);
  });
  const d = req?.details as RequestDetails | undefined;
  const flag = async (why: string) => {
    await billingTask(tx, m.orgId, {
      title: `Cancel unexpected ${LABEL[provider]} subscription ${subId}`,
      description: `${why}. Teamwork Hub did NOT link it, so it must not keep charging: cancel it in the ${LABEL[provider]} dashboard and refund anything it collected. Membership ${m.id}.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-conflict:${provider}:${subId}`,
      priority: "high",
    });
    await audit(tx, SYSTEM(m.orgId), "billing.subscription.conflict", "membership", m.id, { summary: `${provider} subscription ${subId} not linked: ${why}` });
    return { conflict: why } as const;
  };
  if (!req || !d) return flag("No matching subscription request from Teamwork staff");
  if (d.state === "ended") return { quiet: "subscription already ended locally" };
  if (d.state === "withdrawn" || d.state === "failed") return flag(`The request was ${d.state} before the payer completed it`);
  if (m.providerSubscriptionId && m.providerSubscriptionId !== subId) return flag(`Membership already billed by subscription ${m.providerSubscriptionId}`);
  if (m.billingProvider !== "manual") return flag(`Membership is billed by ${m.billingProvider}`);
  if (m.status === "cancelled" || m.status === "expired") return flag("Membership has ended");

  // Link: from now on only the provider bills this membership.
  await tx
    .update(memberships)
    .set({ billingProvider: provider, providerSubscriptionId: subId, nextBillDate: null, updatedAt: new Date() })
    .where(eq(memberships.id, m.id));
  await mergeDetails(tx, req.id, { state: "linked", providerSubscriptionId: subId });
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.linked, effectiveOn: d.firstChargeDate, details: { provider, providerSubscriptionId: subId, requestId: d.requestId, previousNextBillDate: m.nextBillDate } });
  await audit(tx, SYSTEM(m.orgId), "billing.membership.subscription_linked", "membership", m.id, { summary: `${LABEL[provider]} subscription ${subId} now bills this membership; Teamwork renewals stopped (next Teamwork bill date was ${m.nextBillDate ?? "none"})` });
  const openInv = await tx.select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.membershipId, m.id), eq(invoices.status, "open")));
  if (openInv.length) {
    await billingTask(tx, m.orgId, {
      title: `Open Teamwork invoices remain after ${LABEL[provider]} subscription started`,
      description: `${openInv.map((i) => i.number).join(", ")} stay payable. The subscription bills from ${d.firstChargeDate ?? "its start"}; void any open invoice for a period the subscription also charges.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-open-invoices:${subId}`,
    });
  }
  const [fresh] = await tx.select().from(memberships).where(eq(memberships.id, m.id));
  return { m: fresh, linkedNow: true };
}

/** Out-of-order guard: returns false if a newer provider status was already applied. Records this one otherwise. */
async function statusClock(tx: Tx, m: Membership, provider: Provider, eventAt: Date, what: string): Promise<boolean> {
  const last = await latestEvent(tx, m.id, EV.status);
  const lastAt = (last?.details as { eventAt?: string } | null)?.eventAt;
  if (lastAt && new Date(lastAt).getTime() > eventAt.getTime()) return false;
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.status, details: { provider, eventAt: eventAt.toISOString(), what } });
  return true;
}

async function setStatus(tx: Tx, m: Membership, status: Membership["status"], type: string, details: Record<string, unknown>) {
  if (m.status === status) return false;
  await tx.update(memberships).set({ status, updatedAt: new Date() }).where(eq(memberships.id, m.id));
  await tx.insert(membershipEvents).values({ membershipId: m.id, type, effectiveOn: todayLocal(), details: { from: m.status, ...details } });
  return true;
}

export async function applySubscriptionStatus(tx: Tx, provider: Provider, ev: Extract<NormalizedEvent, { kind: "subscription_status" }>, eventAt: Date): Promise<ProcessOutcome> {
  const r = await resolveMembership(tx, provider, ev.providerSubscriptionId, ev.hint);
  if (!r) return { outcome: "ignored", detail: "unmatched: no membership or request for this subscription" };
  if ("conflict" in r) return { outcome: "processed", detail: `not linked: ${r.conflict}` };
  if ("quiet" in r) return { outcome: "processed", detail: r.quiet };
  const m = r.m;
  const actor = SYSTEM(m.orgId);
  if (ev.status == null) return { outcome: "processed", detail: r.linkedNow ? "linked" : "already linked" };
  if (m.status === "cancelled" || m.status === "expired") return { outcome: "processed", detail: "membership ended; status change ignored" };
  if (!(await statusClock(tx, m, provider, eventAt, `status:${ev.rawStatus ?? ev.status}`))) {
    return { outcome: "processed", detail: "stale status event ignored (a newer one was applied)" };
  }
  const today = todayLocal();

  if (ev.status === "setup_expired") {
    const paid = await providerPaidThrough(tx, m);
    if (paid) return { outcome: "processed", detail: "setup_expired after payments — left for staff" };
    const linkedEv = await latestEvent(tx, m.id, EV.linked);
    const prev = (linkedEv?.details as { previousNextBillDate?: string | null } | null)?.previousNextBillDate ?? today;
    await revertToTeamwork(tx, m, prev, actor, "provider subscription never activated");
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.setupExpired, effectiveOn: today, details: { provider, providerSubscriptionId: ev.providerSubscriptionId } });
    await billingTask(tx, m.orgId, {
      title: `${LABEL[provider]} subscription was never completed`,
      description: `The payer did not finish the first payment. Teamwork invoicing resumed from ${prev}.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-expired:${ev.providerSubscriptionId}`,
    });
    return { outcome: "processed", detail: "setup expired; reverted to Teamwork invoices" };
  }

  if (ev.status === "cancelled") {
    const sw = await latestEvent(tx, m.id, EV.switchScheduled);
    const swd = sw?.details as { providerSubscriptionId?: string; firstBillDate?: string } | null;
    if (swd?.providerSubscriptionId === ev.providerSubscriptionId && swd.firstBillDate) {
      await revertToTeamwork(tx, m, swd.firstBillDate, actor, "provider confirmed the subscription ended");
      return { outcome: "processed", detail: "switched back to Teamwork invoices" };
    }
    if (m.cancelAt && m.cancelAt > today) {
      // Billing stopped at the provider; the membership runs to the end of what was paid.
      await tx.insert(membershipEvents).values({ membershipId: m.id, type: EV.providerCancelled, effectiveOn: today, details: { provider, providerSubscriptionId: ev.providerSubscriptionId, membershipEnds: m.cancelAt } });
      return { outcome: "processed", detail: `provider billing stopped; membership ends ${m.cancelAt}` };
    }
    const end = m.cancelAt && m.cancelAt <= today ? m.cancelAt : today;
    await tx.update(memberships).set({ status: "cancelled", endDate: end, cancelAt: m.cancelAt ?? end, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: "cancelled", effectiveOn: end, details: { by: provider, providerSubscriptionId: ev.providerSubscriptionId, rawStatus: ev.rawStatus } });
    await audit(tx, actor, "billing.membership.cancel", "membership", m.id, { summary: `${LABEL[provider]} subscription ended; membership cancelled ${end}` });
    return { outcome: "processed", detail: "membership cancelled by provider" };
  }

  let detail = `status ${ev.status}`;
  if (ev.status === "active" && ["pending", "past_due", "on_hold", "trialing"].includes(m.status)) {
    await setStatus(tx, m, "active", "activated", { by: provider });
  } else if (ev.status === "trialing" && m.status === "pending") {
    await setStatus(tx, m, "trialing", "trialing", { by: provider });
  } else if (ev.status === "past_due" && m.status !== "past_due") {
    await setStatus(tx, m, "past_due", "payment_failed", { by: provider, rawStatus: ev.rawStatus });
    await billingTask(tx, m.orgId, {
      title: `${LABEL[provider]} subscription is past due`,
      description: `The provider reports ${ev.rawStatus}. Ask the payer to update their payment method in ${LABEL[provider]}; Teamwork will not invoice this membership separately.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-past-due:${ev.providerSubscriptionId}:${today}`,
      priority: "high",
    });
  } else if (ev.status === "paused" && m.status !== "on_hold") {
    await setStatus(tx, m, "on_hold", "paused_by_provider", { by: provider });
  } else {
    detail = `status ${ev.status} (no local change)`;
  }

  // Cancel-at-period-end set or cleared at the provider (e.g. from its dashboard).
  const sw = await latestEvent(tx, m.id, EV.switchScheduled);
  const switching = (sw?.details as { providerSubscriptionId?: string } | null)?.providerSubscriptionId === ev.providerSubscriptionId;
  if (!switching && ev.cancelAtPeriodEnd === true && ev.cancelAt && m.cancelAt !== ev.cancelAt) {
    await tx.update(memberships).set({ cancelAt: ev.cancelAt, cancelReason: m.cancelReason ?? `Cancelled at ${LABEL[provider]}`, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: "cancel_scheduled", effectiveOn: ev.cancelAt, details: { by: provider, atPeriodEnd: true } });
    detail += `; cancel scheduled ${ev.cancelAt}`;
  } else if (!switching && ev.cancelAtPeriodEnd === false && !ev.cancelAt && m.cancelAt) {
    await tx.update(memberships).set({ cancelAt: null, cancelReason: null, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    await tx.insert(membershipEvents).values({ membershipId: m.id, type: "cancel_unscheduled", effectiveOn: today, details: { by: provider } });
    detail += "; scheduled cancellation cleared at provider";
  }
  return { outcome: "processed", detail };
}

export async function applySubscriptionInvoice(tx: Tx, provider: Provider, ev: Extract<NormalizedEvent, { kind: "subscription_invoice" }>, eventAt: Date): Promise<ProcessOutcome> {
  if (!ev.providerSubscriptionId) return { outcome: "ignored", detail: "invoice without subscription" };
  const r = await resolveMembership(tx, provider, ev.providerSubscriptionId, ev.hint ?? null);
  if (!r) {
    // A PayPal sale carries no hint and can beat BILLING.SUBSCRIPTION.ACTIVATED; retry later.
    if (provider === "paypal" && ev.status === "paid") throw new DeferError(`PayPal sale for unknown subscription ${ev.providerSubscriptionId}`);
    return { outcome: "ignored", detail: "unmatched: no membership for subscription" };
  }
  if ("conflict" in r) return { outcome: "processed", detail: `not linked: ${r.conflict}` };
  if ("quiet" in r) return { outcome: "processed", detail: r.quiet };
  const m = r.m;
  const actor = SYSTEM(m.orgId);
  const key = `${provider}-invoice:${ev.providerInvoiceId}`;
  const [already] = await tx.select().from(invoices).where(and(eq(invoices.orgId, m.orgId), eq(invoices.idempotencyKey, key)));

  if (ev.status === "action_required") {
    await billingTask(tx, m.orgId, {
      title: `Payer must confirm a ${LABEL[provider]} subscription payment`,
      description: `Invoice ${ev.providerInvoiceId} needs customer authentication. ${LABEL[provider]} emails/hosts the confirmation; nothing is granted until it is paid.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-action:${ev.providerInvoiceId}`,
    });
    return { outcome: "processed", detail: "payer action required" };
  }

  if (ev.status === "payment_failed") {
    if (already?.status === "paid") return { outcome: "processed", detail: "failure for an invoice already paid — ignored" };
    if (m.status === "cancelled" || m.status === "expired") return { outcome: "processed", detail: "membership ended" };
    if (!(await statusClock(tx, m, provider, eventAt, `payment_failed:${ev.providerInvoiceId}`))) return { outcome: "processed", detail: "stale payment failure ignored" };
    await setStatus(tx, m, "past_due", "payment_failed", { by: provider, providerInvoiceId: ev.providerInvoiceId });
    await billingTask(tx, m.orgId, {
      title: `${LABEL[provider]} subscription payment failed`,
      description: `Payment of ${ev.amountMinor} ${ev.currency} failed (${ev.providerInvoiceId}). The provider handles retries; nothing was granted.`,
      relatedType: "membership",
      relatedId: m.id,
      dedupeKey: `sub-failed:${ev.providerInvoiceId}`,
      priority: "high",
    });
    return { outcome: "processed", detail: "membership past_due" };
  }

  // paid
  if (ev.amountMinor <= 0) return { outcome: "ignored", detail: "zero-amount provider invoice (nothing charged, no period billed)" };
  const [row] = await tx
    .select({ version: productVersions, name: products.name })
    .from(productVersions)
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(eq(productVersions.id, m.productVersionId));
  const ver = row.version;
  let target = already ?? null;
  let doubleCollected = false;
  if (!target) {
    let periodStart = ev.periodStart;
    if (!periodStart) {
      const paid = await providerPaidThrough(tx, m);
      const linkedEv = await latestEvent(tx, m.id, EV.linked);
      periodStart = paid ? addDaysYmd(paid, 1) : ((linkedEv?.details as { previousNextBillDate?: string | null } | null)?.previousNextBillDate ?? todayLocal());
    }
    const periodEnd = ev.periodEnd ?? addDaysYmd(addIntervalYmd(periodStart, ver.interval, ver.intervalCount, m.billingAnchorDay), -1);
    const [other] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.membershipId, m.id), eq(invoices.periodStart, periodStart), sql`${invoices.status} <> 'void'`))
      .for("update");
    if (other) {
      // Teamwork already invoiced this period (e.g. before the switch). Apply the provider money to it.
      const money = await invoiceMoney(tx, other.id);
      doubleCollected = other.status === "paid" || money.settledMinor >= other.totalMinor;
      target = other;
    } else {
      const res = await createInvoiceRecord(tx, actor, {
        orgId: m.orgId,
        payerAccountId: m.payerAccountId!,
        membershipId: m.id,
        periodStart,
        periodEnd,
        source: "membership_renewal",
        idempotencyKey: key,
        currency: ev.currency,
        dueDate: periodStart,
        isDemo: m.isDemo,
        providerBilled: true,
        memo: `Charged by ${LABEL[provider]} (${ev.providerInvoiceId}).`,
        lines: [
          {
            description: `${row.name} — ${periodStart} to ${periodEnd} (${LABEL[provider]} subscription)`,
            unitAmountMinor: ev.amountMinor,
            productVersionId: ver.id,
            athleteId: m.athleteId,
            entitlement: {
              credits: ver.unlimited ? undefined : (ver.creditsPerPeriod ?? undefined),
              unlimitedUntil: ver.unlimited ? periodEnd : undefined,
              activateMembershipId: m.id,
              serviceTypeIds: ver.serviceTypeIds,
            },
          },
        ],
      });
      target = res.invoice;
    }
  }
  const ins = await tx
    .insert(transactions)
    .values({
      orgId: m.orgId,
      payerAccountId: m.payerAccountId,
      invoiceId: target.id,
      kind: "charge",
      status: "settled",
      amountMinor: ev.amountMinor,
      currency: ev.currency,
      provider,
      providerTxnId: ev.providerTxnId ?? ev.providerInvoiceId,
      methodType: "subscription",
      settledAt: new Date(),
      verification: "provider_verified",
      notes: `subscription:${ev.providerSubscriptionId} invoice:${ev.providerInvoiceId}`,
      isDemo: m.isDemo,
    })
    .onConflictDoNothing()
    .returning();
  if (ins.length && doubleCollected) {
    await billingTask(tx, m.orgId, {
      title: `Period ${target.periodStart} was paid twice (Teamwork invoice ${target.number} and ${LABEL[provider]})`,
      description: `${LABEL[provider]} charged ${ev.amountMinor} ${ev.currency} (${ev.providerInvoiceId}) for a period already settled on ${target.number}. Refund one of the payments.`,
      relatedType: "invoice",
      relatedId: target.id,
      dedupeKey: `sub-double:${ev.providerInvoiceId}`,
      priority: "high",
    });
  }
  if (ins.length) {
    const [m2] = await tx.select().from(memberships).where(eq(memberships.id, m.id));
    const expected = await periodPrice(tx, m2, ver);
    if (expected.net !== ev.amountMinor) {
      await billingTask(tx, m.orgId, {
        title: `${LABEL[provider]} charged a different amount than the plan`,
        description: `Provider charged ${ev.amountMinor} ${ev.currency}; the plan's period price is ${expected.net}. Check the subscription's price in ${LABEL[provider]}.`,
        relatedType: "membership",
        relatedId: m.id,
        dedupeKey: `sub-amount:${ev.providerInvoiceId}`,
      });
    }
    await statusClock(tx, m, provider, eventAt, `paid:${ev.providerInvoiceId}`);
    await audit(tx, actor, "billing.subscription.invoice_paid", "invoice", target.id, { summary: `${LABEL[provider]} subscription payment ${ev.amountMinor} ${ev.currency} recorded on ${target.number}` });
  }
  await settleInvoiceIfCovered(tx, target.id, actor);
  return { outcome: "processed", detail: ins.length ? "subscription invoice paid" : "subscription invoice already recorded" };
}

// ---------------------------------------------------------------------------
// Read model for the membership page
// ---------------------------------------------------------------------------

export type ChecklistItem = { label: string; ok: boolean | null; detail?: string };

export async function billingMethodView(tx: Tx, v: Viewer, membershipId: string) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, v.orgId)));
  if (!m) throw new UserError("Membership not found.");
  const open = await openRequest(tx, m.id);
  const sw = await latestEvent(tx, m.id, EV.switchScheduled);
  const swd = sw?.details as { providerSubscriptionId?: string; firstBillDate?: string } | null;
  const switchScheduled = isProviderBilled(m) && swd?.providerSubscriptionId === m.providerSubscriptionId ? swd.firstBillDate ?? null : null;
  const providers = (["stripe", "paypal"] as const).map((p) => {
    const a = getSubscriptionProvider(p);
    return { name: p, label: a.label, configured: a.isConfigured(), missing: a.missingEnv() };
  });
  const [payer] = m.payerAccountId ? await tx.select({ email: payerAccounts.billingEmail }).from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId)) : [];
  const today = todayLocal();
  const holds = await tx.select({ id: membershipHolds.id }).from(membershipHolds).where(and(eq(membershipHolds.membershipId, m.id), gte(membershipHolds.endDate, today)));
  const overdue = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.membershipId, m.id), inArray(invoices.status, ["open"]), sql`${invoices.dueDate} < ${today}`));
  const checklist: ChecklistItem[] = [
    { label: "Provider credentials set on the server (sandbox keys first)", ok: providers.some((p) => p.configured), detail: providers.map((p) => `${p.label}: ${p.configured ? "configured" : `missing ${p.missing.join(", ")}`}`).join(" · ") },
    { label: "Webhook endpoint registered and verified end to end in the provider sandbox", ok: null, detail: "Stripe: /api/webhooks/stripe (customer.subscription.*, invoice.paid, invoice.payment_failed, invoice.payment_action_required, checkout.session.completed). PayPal: /api/webhooks/paypal (BILLING.SUBSCRIPTION.*, PAYMENT.SALE.COMPLETED). Not verifiable from here." },
    { label: "Membership is billed by Teamwork invoices today", ok: m.billingProvider === "manual" || isProviderBilled(m), detail: m.billingProvider === "external_zenplanner" ? "Cut over from Zen Planner first." : undefined },
    { label: "No overdue Teamwork invoices for this membership", ok: overdue.length === 0, detail: overdue.length ? `${overdue.length} overdue — collect or void before switching.` : undefined },
    { label: "No current or upcoming hold", ok: holds.length === 0, detail: holds.length ? "Provider subscriptions do not honour Teamwork holds." : undefined },
    { label: "Payer has a billing email (prefills the hosted page)", ok: !!payer?.email },
    { label: "Next Teamwork bill date known (first provider charge is scheduled for it)", ok: !!m.nextBillDate || isProviderBilled(m), detail: m.nextBillDate ? `First provider charge: ${m.nextBillDate}` : undefined },
  ];
  return { m, open, switchScheduled, providers, checklist };
}
