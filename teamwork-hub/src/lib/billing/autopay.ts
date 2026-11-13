import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { invoices, memberships, paymentAttempts, paymentMethods, payerAccounts, transactions } from "@/db/schema";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs";
import { formatMoney } from "@/lib/money";
import { getSavedMethodProvider } from "@/lib/payments";
import type { NormalizedEvent } from "@/lib/payments/provider";
import { addDaysYmd, fmtDate, localToUtc, todayLocal } from "@/lib/time";
import { autopaySettings } from "./autopay-settings";
import { classifyDecline } from "./declines";
import { invoiceMoney } from "./invoices";
import { markMethodFailed, methodLabel, resolveAutopayMethod } from "./payment-methods";
import { billingTask } from "./tasks";

export const AUTOPAY_JOB = "billing.autopay_charge";
export const FEE_JOB = "billing.record_fee";
const SYSTEM = (orgId: string) => ({ orgId, actorUserId: null, actorRole: "system" });
const RESUME_AFTER_MS = 10 * 60_000;
const IN_FLIGHT = ["created", "requires_action", "processing", "pending"] as const;

/**
 * Queue the automatic charge for a newly issued membership bill. Runs on the bill's due date
 * (immediately when it is due today or earlier). Deduped per invoice, so issuing twice queues once.
 */
export async function scheduleAutopayCharge(tx: Tx, inv: { id: string; orgId: string; dueDate: string | null }, attemptNumber = 1, runAt?: Date) {
  const today = todayLocal();
  const when = runAt ?? (inv.dueDate && inv.dueDate > today ? localToUtc(inv.dueDate, "06:00") : new Date());
  return enqueue(tx, { type: AUTOPAY_JOB, orgId: inv.orgId, payload: { orgId: inv.orgId, invoiceId: inv.id, attemptNumber }, dedupeKey: `${AUTOPAY_JOB}:${inv.id}:${attemptNumber}`, runAt: when });
}

export type AutopayOutcome =
  | { charged: true; attemptId: string; status: "submitted" | "declined" | "requires_action" }
  | { charged: false; reason: "not_open" | "not_membership" | "autopay_off" | "nothing_due" | "pending_money" | "in_flight" | "no_method" | "not_configured" | "stale" | "error"; detail?: string };

/**
 * Charge one open membership invoice with the saved autopay method, off-session.
 *
 * Idempotency: the invoice row is locked while the attempt row is created, an in-flight attempt blocks a
 * new one, and attempt N has the unique idempotency key `autopay:<invoice>:<N>` (also sent to Stripe).
 * `attemptNumber` must be exactly "attempts so far + 1", so a duplicated or late job is a no-op.
 * The provider's answer never marks anything paid: only the verified webhook does.
 */
export async function chargeInvoiceAutopay(db: DB, input: { orgId: string; invoiceId: string; attemptNumber: number }): Promise<AutopayOutcome> {
  const adapter = getSavedMethodProvider();
  const prep = await db.transaction(async (tx): Promise<AutopayOutcome | { go: { attempt: typeof paymentAttempts.$inferSelect; number: string; customerId: string; methodId: string; methodType: "card" | "us_bank_account"; mandateRef: string | null } }> => {
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, input.orgId))).for("update");
    if (!inv || inv.status !== "open") return { charged: false, reason: "not_open" };
    if (!inv.membershipId) return { charged: false, reason: "not_membership" };
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, inv.membershipId));
    if (!m || m.billingProvider !== "manual") return { charged: false, reason: "not_membership", detail: "not invoiced by Teamwork" };
    if (!m.autopay) return { charged: false, reason: "autopay_off" };
    const money = await invoiceMoney(tx, inv.id);
    if (money.pendingMinor > 0) return { charged: false, reason: "pending_money" };
    if (money.balanceMinor <= 0) return { charged: false, reason: "nothing_due" };
    const prior = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.invoiceId, inv.id), eq(paymentAttempts.origin, "autopay")));
    const open = prior.find((a) => (IN_FLIGHT as readonly string[]).includes(a.status));
    // A crash between writing the attempt and calling Stripe leaves `created` with no provider reference:
    // after 10 minutes resume it with the same idempotency key (Stripe then returns the original result
    // rather than charging twice). Younger ones are another worker mid-call.
    const resume =
      open && open.status === "created" && !open.providerRef && open.idempotencyKey === `autopay:${inv.id}:${input.attemptNumber}` && open.createdAt.getTime() < Date.now() - RESUME_AFTER_MS ? open : null;
    if (open && !resume) return { charged: false, reason: "in_flight" };
    if (!resume && prior.length + 1 !== input.attemptNumber) return { charged: false, reason: "stale", detail: `attempt ${input.attemptNumber} requested, ${prior.length} already made` };
    const method = await resolveAutopayMethod(tx, m);
    if (!method) {
      await billingTask(tx, inv.orgId, {
        title: `Autopay could not charge ${inv.number}: no active payment method`,
        description: "Autopay is on for this membership but the family has no active saved card or bank account. They see a notice under Payment Methods. Collect payment another way or ask them to add one.",
        relatedType: "invoice",
        relatedId: inv.id,
        dedupeKey: `autopay-nomethod:${inv.id}`,
        priority: "high",
        isDemo: inv.isDemo,
      });
      return { charged: false, reason: "no_method" };
    }
    if (!adapter.isConfigured() || method.provider !== adapter.name) return { charged: false, reason: "not_configured" };
    const [payer] = await tx.select().from(payerAccounts).where(eq(payerAccounts.id, inv.payerAccountId));
    const customerId = method.providerCustomerId ?? payer?.providerRefs?.stripeCustomerId ?? null;
    const type = method.type === "us_bank_account" ? "us_bank_account" : "card";
    if (!customerId || (type === "us_bank_account" && !method.mandateRef)) {
      await billingTask(tx, inv.orgId, {
        title: `Autopay could not charge ${inv.number}: saved method is incomplete`,
        description: type === "us_bank_account" && customerId ? "The bank account has no debit authorization (mandate) on record. Ask the family to save it again." : "The saved method has no Stripe customer reference. Ask the family to save it again.",
        relatedType: "invoice",
        relatedId: inv.id,
        dedupeKey: `autopay-incomplete:${inv.id}`,
        priority: "high",
        isDemo: inv.isDemo,
      });
      return { charged: false, reason: "no_method", detail: "incomplete method" };
    }
    if (resume) return { go: { attempt: resume, number: inv.number, customerId, methodId: method.providerMethodId, methodType: type, mandateRef: method.mandateRef } };
    const id = randomUUID();
    const ins = await tx
      .insert(paymentAttempts)
      .values({
        id,
        orgId: inv.orgId,
        invoiceId: inv.id,
        provider: "stripe",
        amountMinor: money.balanceMinor,
        currency: inv.currency,
        methodType: type,
        status: "created",
        idempotencyKey: `autopay:${inv.id}:${input.attemptNumber}`,
        origin: "autopay",
        paymentMethodId: method.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!ins.length) return { charged: false, reason: "stale", detail: "attempt already exists" };
    await audit(tx, SYSTEM(inv.orgId), "billing.autopay.charge", "payment_attempt", id, { summary: `Autopay attempt ${input.attemptNumber} for ${inv.number}: ${formatMoney(money.balanceMinor, inv.currency)} on ${methodLabel(method)}` });
    return { go: { attempt: ins[0], number: inv.number, customerId, methodId: method.providerMethodId, methodType: type, mandateRef: method.mandateRef } };
  });
  if (!("go" in prep)) return prep;
  const { attempt } = prep.go;
  try {
    const res = await adapter.chargeSavedMethod({
      attemptId: attempt.id,
      invoiceId: attempt.invoiceId,
      invoiceNumber: prep.go.number,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      providerCustomerId: prep.go.customerId,
      providerMethodId: prep.go.methodId,
      methodType: prep.go.methodType,
      mandateRef: prep.go.mandateRef,
      idempotencyKey: attempt.idempotencyKey,
    });
    await db.transaction(async (tx) => {
      const [a] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)).for("update");
      if (res.status === "submitted") {
        // Stays `created` (with the provider reference) until the verified webhook reports processing / succeeded / failed.
        if (!a.providerRef && res.providerRef) await tx.update(paymentAttempts).set({ providerRef: res.providerRef, updatedAt: new Date() }).where(eq(paymentAttempts.id, a.id));
        return;
      }
      if (a.status !== "created") return; // a webhook got here first
      await tx
        .update(paymentAttempts)
        .set({ status: "failed", providerRef: a.providerRef ?? res.providerRef, failureCode: res.failureCode ?? "provider_failed", failureMessage: res.failureMessage?.slice(0, 500) ?? null, lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(paymentAttempts.id, a.id));
      await afterAutopayFailure(tx, a.id);
    });
    return { charged: true, attemptId: attempt.id, status: res.status };
  } catch (e) {
    await db
      .update(paymentAttempts)
      .set({ status: "failed", failureCode: "charge_error", failureMessage: (e as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, "created")));
    await db.transaction((tx) =>
      billingTask(tx, attempt.orgId, {
        title: `Autopay request for ${prep.go.number} was not accepted by Stripe`,
        description: "Nothing was charged. Check the Stripe dashboard and collect this bill another way or try again.",
        relatedType: "invoice",
        relatedId: attempt.invoiceId,
        dedupeKey: `autopay-error:${attempt.id}`,
        priority: "high",
      }),
    );
    return { charged: false, reason: "error", detail: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Failure handling (declines, ACH returns)
// ---------------------------------------------------------------------------

export type AchFailureAction = "retry_once" | "method_failed" | "staff_review";

/** Bank account is gone or the payer withdrew permission: never debit it again. */
const ACH_METHOD_FAILED = new Set([
  "account_closed",
  "bank_account_closed",
  "no_account",
  "invalid_account_number",
  "incorrect_account_details",
  "bank_account_unusable",
  "bank_account_restricted",
  "account_frozen",
  "debit_not_authorized",
  "revocation_of_authorization",
  "stop_payment_order",
  "mandate_inactive",
  "payment_method_microdeposit_verification_attempts_exceeded",
]);

/**
 * What to do when a bank debit fails or is returned. Insufficient funds is worth exactly one more try
 * after a wait; a closed account or revoked authorization means the saved method is dead.
 */
export function classifyAchFailure(code: string | null | undefined): { action: AchFailureAction; label: string } {
  const c = (code ?? "").trim().toLowerCase();
  if (c === "insufficient_funds") return { action: "retry_once", label: "Insufficient funds" };
  if (ACH_METHOD_FAILED.has(c)) return { action: "method_failed", label: "Bank account can no longer be debited" };
  return { action: "staff_review", label: "Bank payment failed" };
}

/** Family-facing wording (sample; plain text). */
export const BANK_UPDATE_INSTRUCTIONS =
  "Your bank account on file could not be charged and needs to be replaced. Open Payment Methods in the Teamwork app, add a new card or bank account, then pay the open bill under Bills. If you would rather not use the app, the front desk can help.";
export const BANK_RETRY_INSTRUCTIONS =
  "Your bank returned this payment for insufficient funds. We will try once more in a few days. To pay sooner, open Bills in the Teamwork app and tap Pay.";

/** Runs once when an autopay attempt becomes `failed` (synchronous decline or verified webhook). */
export async function afterAutopayFailure(tx: Tx, attemptId: string) {
  const [a] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
  if (!a || a.origin !== "autopay" || a.status !== "failed") return;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, a.invoiceId));
  if (!inv) return;
  const settings = await autopaySettings(tx, a.orgId);
  const all = await tx.select().from(paymentAttempts).where(and(eq(paymentAttempts.invoiceId, inv.id), eq(paymentAttempts.origin, "autopay")));
  const failedCount = all.filter((x) => x.status === "failed").length;
  const nextNumber = all.length + 1;
  const [method] = a.paymentMethodId ? await tx.select().from(paymentMethods).where(eq(paymentMethods.id, a.paymentMethodId)).for("update") : [];
  const base = { relatedType: "invoice", relatedId: inv.id, isDemo: inv.isDemo } as const;
  const today = todayLocal();

  if (a.methodType === "us_bank_account") {
    const ach = classifyAchFailure(a.failureCode);
    const priorNsf = all.filter((x) => x.id !== a.id && x.status === "failed" && classifyAchFailure(x.failureCode).action === "retry_once").length;
    if (ach.action === "retry_once" && priorNsf === 0) {
      const on = addDaysYmd(today, settings.achRetryWaitDays);
      await scheduleAutopayCharge(tx, inv, nextNumber, localToUtc(on, "06:00"));
      await billingTask(tx, a.orgId, { ...base, title: `Bank payment for ${inv.number} returned: insufficient funds`, description: `One automatic retry is scheduled for ${fmtDate(on)}. The family sees a notice under Bills. No message was sent.`, dedupeKey: `autopay-fail:${a.id}` });
    } else if (ach.action === "method_failed") {
      if (method) await markMethodFailed(tx, a.orgId, method, a.failureCode ?? "bank_account_unusable", a.failureMessage);
      await billingTask(tx, a.orgId, { ...base, title: `Bank account can no longer be debited (${inv.number} unpaid)`, description: `${a.failureCode ?? "The bank refused the debit"}. The saved bank account is marked as needing replacement and will not be charged again. Ask the family for a new payment method; they see a notice under Payment Methods. No message was sent.`, dedupeKey: `autopay-fail:${a.id}`, priority: "high" });
    } else {
      await billingTask(tx, a.orgId, { ...base, title: `Bank payment for ${inv.number} failed${ach.action === "retry_once" ? " again (insufficient funds)" : ""}`, description: `${a.failureMessage ?? a.failureCode ?? "The bank returned the payment"}. No further automatic retry is scheduled. Contact the family or collect another way.`, dedupeKey: `autopay-fail:${a.id}`, priority: "high" });
    }
  } else {
    const d = classifyDecline(a.failureCode, a.failureMessage);
    const waitDays = d.category === "card_needs_update" ? null : (settings.cardRetryDays[failedCount - 1] ?? null);
    if (waitDays != null) {
      const on = addDaysYmd(today, waitDays);
      await scheduleAutopayCharge(tx, inv, nextNumber, localToUtc(on, "06:00"));
      await billingTask(tx, a.orgId, { ...base, title: `Card payment for ${inv.number} declined (${d.label.toLowerCase()})`, description: `${a.failureMessage ?? a.failureCode ?? "Declined"}. Automatic retry ${failedCount} of ${settings.cardRetryDays.length} is scheduled for ${fmtDate(on)}. No message was sent.`, dedupeKey: `autopay-fail:${a.id}` });
    } else {
      await billingTask(tx, a.orgId, {
        ...base,
        title: d.category === "card_needs_update" ? `Card needs updating (${inv.number} unpaid)` : `Card payment for ${inv.number} declined; retries used up`,
        description: `${a.failureMessage ?? a.failureCode ?? "Declined"}. ${d.category === "card_needs_update" ? "Retrying the same card will not work." : "No further automatic retry is scheduled."} The family sees a notice under Bills and Payment Methods. No message was sent.`,
        dedupeKey: `autopay-fail:${a.id}`,
        priority: "high",
      });
    }
  }
  await audit(tx, SYSTEM(a.orgId), "billing.autopay.failed", "payment_attempt", a.id, { summary: `Autopay for ${inv.number} failed: ${a.failureCode ?? "provider reported failure"}` });
}

/**
 * A dispute on a BANK DEBIT is a late return: the money left after the bill was already paid.
 * The existing dispute machinery has written the reversal entry; here the bill is reopened so it shows as
 * owed again, and staff get a follow-up. Credits are not auto-revoked (same rule as refunds).
 */
export async function afterDispute(tx: Tx, charge: typeof transactions.$inferSelect, ev: Extract<NormalizedEvent, { kind: "dispute" }>) {
  if (charge.methodType !== "us_bank_account" || !charge.invoiceId) return;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, charge.invoiceId)).for("update");
  if (!inv) return;
  const money = await invoiceMoney(tx, inv.id);
  if (ev.phase === "closed" && ev.status === "won") {
    const { settleInvoiceIfCovered } = await import("./invoices");
    await settleInvoiceIfCovered(tx, inv.id, SYSTEM(inv.orgId));
    return;
  }
  if (inv.status === "paid" && money.balanceMinor > 0) {
    await tx.update(invoices).set({ status: "open", paidAt: null, updatedAt: new Date() }).where(eq(invoices.id, inv.id));
    await audit(tx, SYSTEM(inv.orgId), "billing.invoice.reopened", "invoice", inv.id, { summary: `${inv.number} reopened: the bank returned the payment (${ev.reason ?? "no reason given"})`, before: { status: "paid" }, after: { status: "open" } });
  }
  if (ev.phase !== "created") return;
  const [attempt] = charge.paymentAttemptId ? await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, charge.paymentAttemptId)) : [];
  const [method] = attempt?.paymentMethodId ? await tx.select().from(paymentMethods).where(eq(paymentMethods.id, attempt.paymentMethodId)).for("update") : [];
  const ach = classifyAchFailure(ev.reason);
  if (method && ach.action === "method_failed") await markMethodFailed(tx, inv.orgId, method, ev.reason ?? "bank_account_unusable", "The bank returned a payment from this account.");
  await billingTask(tx, inv.orgId, {
    title: `Bank payment returned after ${inv.number} was marked paid`,
    description: `The bank took back ${formatMoney(ev.amountMinor, ev.currency)} (${ev.reason ?? "no reason given"}). The bill is open again and is not retried automatically. Credits were not removed: review them, then contact the family. No message was sent.`,
    relatedType: "invoice",
    relatedId: inv.id,
    dedupeKey: `ach-return:${ev.providerDisputeId}`,
    priority: "high",
    isDemo: inv.isDemo,
  });
}

// ---------------------------------------------------------------------------
// Processor fees
// ---------------------------------------------------------------------------

/** Queue a fee lookup for a settled Stripe charge. Deduped per payment. */
export async function scheduleFeeLookup(tx: Tx, orgId: string, providerTxnId: string) {
  if (!providerTxnId.startsWith("pi_")) return null;
  return enqueue(tx, { type: FEE_JOB, orgId, payload: { orgId, providerTxnId }, dedupeKey: `${FEE_JOB}:${providerTxnId}`, runAt: new Date(Date.now() + 60_000) });
}

/**
 * Record the processor's fee on the charge, as reported by the provider's balance transaction.
 * Until this runs the fee is unknown (fee_reported_at is null), never assumed.
 */
export async function recordProcessorFee(db: DB, input: { orgId: string; providerTxnId: string }): Promise<{ recorded: boolean; reason?: string; feeMinor?: number }> {
  const adapter = getSavedMethodProvider();
  if (!adapter.isConfigured()) return { recorded: false, reason: "not_configured" };
  const [t] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.orgId, input.orgId), eq(transactions.provider, "stripe"), eq(transactions.kind, "charge"), eq(transactions.providerTxnId, input.providerTxnId)));
  if (!t) return { recorded: false, reason: "no_local_charge" };
  if (t.feeReportedAt) return { recorded: false, reason: "already_recorded", feeMinor: t.feeMinor };
  const fee = await adapter.fetchFee(input.providerTxnId);
  if (!fee) return { recorded: false, reason: "fee_not_available_yet" };
  if (fee.currency !== t.currency.toUpperCase()) return { recorded: false, reason: `fee currency ${fee.currency} differs from charge` };
  await db.transaction(async (tx) => {
    const upd = await tx.update(transactions).set({ feeMinor: fee.feeMinor, feeReportedAt: new Date() }).where(and(eq(transactions.id, t.id), sql`${transactions.feeReportedAt} is null`)).returning({ id: transactions.id });
    if (upd.length) await audit(tx, SYSTEM(t.orgId), "billing.fee.recorded", "transaction", t.id, { summary: `Processor fee ${formatMoney(fee.feeMinor, fee.currency)} recorded from Stripe` });
  });
  return { recorded: true, feeMinor: fee.feeMinor };
}

export type FeeMonthRow = { month: string; methodType: string; payments: number; volumeMinor: number; feeMinor: number; paymentsWithFee: number; paymentsWithoutFee: number; currency: string };

/**
 * Processor fees by month and method type, from provider-verified settled charges. `feeMinor` sums only
 * fees the processor reported; `paymentsWithoutFee` counts charges whose fee is not known yet.
 */
export async function processingFeesByMonth(tx: Tx, orgId: string, opts: { from?: string; to?: string } = {}): Promise<FeeMonthRow[]> {
  const from = opts.from ?? "1970-01-01";
  const to = opts.to ?? "2999-12-31";
  const rows = await tx.execute(sql`
    select to_char((coalesce(t.settled_at, t.occurred_at) at time zone o.timezone), 'YYYY-MM') as month,
      coalesce(t.method_type, 'unknown') as method_type, t.currency,
      count(*)::int as payments, coalesce(sum(t.amount_minor),0)::bigint as volume,
      coalesce(sum(case when t.fee_reported_at is not null then t.fee_minor else 0 end),0)::bigint as fee,
      count(*) filter (where t.fee_reported_at is not null)::int as with_fee,
      count(*) filter (where t.fee_reported_at is null)::int as without_fee
    from transactions t join organizations o on o.id = t.org_id
    where t.org_id = ${orgId} and t.kind = 'charge' and t.status = 'settled' and t.verification = 'provider_verified'
      and (coalesce(t.settled_at, t.occurred_at) at time zone o.timezone)::date between ${from}::date and ${to}::date
    group by 1, 2, 3 order by 1 desc, 2`);
  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    month: String(r.month),
    methodType: String(r.method_type),
    currency: String(r.currency),
    payments: Number(r.payments),
    volumeMinor: Number(r.volume),
    feeMinor: Number(r.fee),
    paymentsWithFee: Number(r.with_fee),
    paymentsWithoutFee: Number(r.without_fee),
  }));
}

/** Open-invoice autopay attempts that failed most recently, for family notices. */
export async function failedAutopayNotices(tx: Tx, orgId: string, payerAccountIds: string[]) {
  if (!payerAccountIds.length) return [];
  const rows = await tx
    .select({ a: paymentAttempts, number: invoices.number, invoiceId: invoices.id })
    .from(paymentAttempts)
    .innerJoin(invoices, eq(invoices.id, paymentAttempts.invoiceId))
    .where(and(eq(paymentAttempts.orgId, orgId), eq(paymentAttempts.origin, "autopay"), eq(invoices.status, "open"), inArray(invoices.payerAccountId, payerAccountIds)))
    .orderBy(sql`${paymentAttempts.createdAt} desc`);
  const seen = new Set<string>();
  const out: { invoiceId: string; number: string; text: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.invoiceId)) continue;
    seen.add(r.invoiceId);
    if (r.a.status !== "failed") continue;
    const text =
      r.a.methodType === "us_bank_account"
        ? classifyAchFailure(r.a.failureCode).action === "retry_once"
          ? BANK_RETRY_INSTRUCTIONS
          : BANK_UPDATE_INSTRUCTIONS
        : (classifyDecline(r.a.failureCode, r.a.failureMessage).familyText ?? "Your automatic payment did not go through. Open Bills to pay, or ask the front desk.");
    out.push({ invoiceId: r.invoiceId, number: r.number, text });
  }
  return out;
}
