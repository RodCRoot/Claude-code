import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  invoiceLines,
  invoices,
  memberships,
  membershipEvents,
  organizations,
  transactions,
  type EntitlementSpec,
} from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { UserError } from "./errors";
import { grantCredits } from "@/lib/credits";
import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import { assertCanViewPayer } from "./access";
import { actorOf, assertMinor, billingSettings, int } from "./util";

export type LineInput = {
  description: string;
  quantity?: number;
  unitAmountMinor: number;
  productVersionId?: string | null;
  athleteId?: string | null;
  entitlement?: EntitlementSpec | null;
};

/** Sequential per-org number, serialized with a transaction-scoped advisory lock. */
export async function nextInvoiceNumber(tx: Tx, orgId: string): Promise<string> {
  const { invoicePrefix } = await billingSettings(tx, orgId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"invoice-number:" + orgId}))`);
  const res = await tx.execute(sql`
    select coalesce(max(nullif(regexp_replace(number, '\\D', '', 'g'), '')::bigint), 0) as n
    from invoices where org_id = ${orgId} and number like ${invoicePrefix + "%"}`);
  const n = int((res.rows[0] as { n: unknown }).n) + 1;
  return `${invoicePrefix}${String(n).padStart(6, "0")}`;
}

export type CreateInvoiceInput = {
  orgId: string;
  payerAccountId: string;
  lines: LineInput[];
  status?: "draft" | "open";
  dueDate?: string | null;
  memo?: string | null;
  membershipId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  discountMinor?: number;
  source?: (typeof invoices.$inferInsert)["source"];
  idempotencyKey?: string | null;
  currency?: string;
  isDemo?: boolean;
};

/**
 * Creates an invoice with totals computed server-side from the lines. Idempotent on idempotencyKey.
 * Memberships billed externally (Zen Planner) can never be invoiced here.
 */
export async function createInvoiceRecord(tx: Tx, actor: AuditActor, input: CreateInvoiceInput) {
  if (!input.lines.length) throw new UserError("Add at least one line.");
  if (input.idempotencyKey) {
    const [prior] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.orgId, input.orgId), eq(invoices.idempotencyKey, input.idempotencyKey)));
    if (prior) return { invoice: prior, created: false };
  }
  if (input.membershipId) {
    const [m] = await tx.select().from(memberships).where(eq(memberships.id, input.membershipId));
    if (!m || m.orgId !== input.orgId) throw new UserError("Membership not found.");
    if (m.billingProvider === "external_zenplanner") {
      throw new UserError("This membership is billed by Zen Planner until cutover. Teamwork Hub will not invoice it (prevents double billing).");
    }
  }
  const [org] = await tx.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, input.orgId));
  const currency = (input.currency ?? org?.currency ?? "USD").toUpperCase();
  let subtotal = 0;
  const lines = input.lines.map((l) => {
    const qty = l.quantity ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) throw new UserError("Quantity must be a positive whole number.");
    assertMinor(l.unitAmountMinor, "unit amount");
    if (l.unitAmountMinor < 0) throw new UserError("Line amounts cannot be negative; use the invoice discount.");
    if (!l.description.trim()) throw new UserError("Each line needs a description.");
    const amount = qty * l.unitAmountMinor;
    subtotal += amount;
    return { ...l, quantity: qty, amountMinor: amount };
  });
  const discount = input.discountMinor ?? 0;
  assertMinor(discount, "discount");
  if (discount < 0 || discount > subtotal) throw new UserError("Discount must be between $0 and the subtotal.");
  const total = subtotal - discount;
  const number = await nextInvoiceNumber(tx, input.orgId);
  const status = input.status ?? "open";
  const { invoiceDueDays } = await billingSettings(tx, input.orgId);
  const [inv] = await tx
    .insert(invoices)
    .values({
      orgId: input.orgId,
      payerAccountId: input.payerAccountId,
      number,
      status,
      currency,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: 0,
      totalMinor: total,
      issuedAt: status === "open" ? new Date() : null,
      dueDate: input.dueDate ?? (status === "open" ? addDaysYmd(todayLocal(), invoiceDueDays) : null),
      membershipId: input.membershipId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      source: input.source ?? "teamwork",
      memo: input.memo ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: actor.actorUserId,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  const insertedLines = await tx
    .insert(invoiceLines)
    .values(
      lines.map((l) => ({
        invoiceId: inv.id,
        productVersionId: l.productVersionId ?? null,
        athleteId: l.athleteId ?? null,
        description: l.description.trim(),
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        amountMinor: l.amountMinor,
        entitlement: l.entitlement ?? null,
      })),
    )
    .returning();
  await audit(tx, actor, "billing.invoice.create", "invoice", inv.id, { summary: `Invoice ${number} for ${total} ${currency} (${status})`, after: { number, total, status } });
  // A $0 invoice is settled immediately (e.g. 100% discount / comp).
  if (total === 0 && status === "open") await settleInvoiceIfCovered(tx, inv.id, actor);
  return { invoice: inv, lines: insertedLines, created: true };
}

/** Staff-created manual invoice. */
export async function createManualInvoice(tx: Tx, v: Viewer, input: Omit<CreateInvoiceInput, "orgId" | "source">) {
  assertCan(v, "billing.manage");
  await assertCanViewPayer(tx, v, input.payerAccountId);
  return createInvoiceRecord(tx, actorOf(v), { ...input, orgId: v.orgId, source: "teamwork" });
}

async function lockInvoice(tx: Tx, orgId: string, invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId))).for("update");
  if (!inv) throw new UserError("Invoice not found.");
  return inv;
}

export async function issueInvoice(tx: Tx, v: Viewer, invoiceId: string) {
  assertCan(v, "billing.manage");
  const inv = await lockInvoice(tx, v.orgId, invoiceId);
  if (inv.status !== "draft") throw new UserError("Only draft invoices can be issued.");
  const { invoiceDueDays } = await billingSettings(tx, v.orgId);
  await tx
    .update(invoices)
    .set({ status: "open", issuedAt: new Date(), dueDate: inv.dueDate ?? addDaysYmd(todayLocal(), invoiceDueDays), updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));
  await audit(tx, actorOf(v), "billing.invoice.issue", "invoice", inv.id, { summary: `Issued ${inv.number}` });
}

export async function voidInvoice(tx: Tx, v: Viewer, invoiceId: string, reason: string) {
  assertCan(v, "billing.manage");
  if (!reason.trim()) throw new UserError("A reason is required to void an invoice.");
  const inv = await lockInvoice(tx, v.orgId, invoiceId);
  if (inv.status === "paid" || inv.status === "void") throw new UserError(`A ${inv.status} invoice cannot be voided.`);
  const money = await invoiceMoney(tx, inv.id);
  if (money.settledMinor > 0 || money.pendingMinor > 0) throw new UserError("This invoice has payments recorded. Refund them before voiding.");
  await tx.update(invoices).set({ status: "void", updatedAt: new Date() }).where(eq(invoices.id, inv.id));
  await audit(tx, actorOf(v), "billing.invoice.void", "invoice", inv.id, { summary: `Voided ${inv.number}: ${reason}`, before: { status: inv.status } });
}

export async function markUncollectible(tx: Tx, v: Viewer, invoiceId: string, reason: string) {
  assertCan(v, "billing.manage");
  if (!reason.trim()) throw new UserError("A reason is required.");
  const inv = await lockInvoice(tx, v.orgId, invoiceId);
  if (inv.status !== "open") throw new UserError("Only open invoices can be marked uncollectible.");
  await tx.update(invoices).set({ status: "uncollectible", updatedAt: new Date() }).where(eq(invoices.id, inv.id));
  await audit(tx, actorOf(v), "billing.invoice.uncollectible", "invoice", inv.id, { summary: `${inv.number} marked uncollectible: ${reason}` });
}

export type InvoiceMoney = {
  totalMinor: number;
  /** Settled money in (charges + manual payments). */
  settledMinor: number;
  /** Money in flight (e.g. ACH processing) — never counted as paid. */
  pendingMinor: number;
  /** Settled refunds (positive number). */
  refundedMinor: number;
  balanceMinor: number;
};

/** Balances are derived from the transaction ledger, never stored. */
export async function invoiceMoney(tx: Tx, invoiceId: string): Promise<InvoiceMoney> {
  return (await invoiceMoneyMany(tx, [invoiceId]))[invoiceId] ?? { totalMinor: 0, settledMinor: 0, pendingMinor: 0, refundedMinor: 0, balanceMinor: 0 };
}

export async function invoiceMoneyMany(tx: Tx, invoiceIds: string[]): Promise<Record<string, InvoiceMoney>> {
  if (!invoiceIds.length) return {};
  const invs = await tx.select({ id: invoices.id, total: invoices.totalMinor }).from(invoices).where(inArray(invoices.id, invoiceIds));
  const rows = await tx
    .select({
      invoiceId: transactions.invoiceId,
      settled: sql<string>`coalesce(sum(case when ${transactions.kind} in ('charge','manual_payment') and ${transactions.status} = 'settled' then ${transactions.amountMinor} else 0 end),0)::bigint`,
      pending: sql<string>`coalesce(sum(case when ${transactions.kind} in ('charge','manual_payment') and ${transactions.status} = 'pending' then ${transactions.amountMinor} else 0 end),0)::bigint`,
      refunded: sql<string>`coalesce(sum(case when ${transactions.kind} = 'refund' and ${transactions.status} = 'settled' then -${transactions.amountMinor} else 0 end),0)::bigint`,
    })
    .from(transactions)
    .where(inArray(transactions.invoiceId, invoiceIds))
    .groupBy(transactions.invoiceId);
  const out: Record<string, InvoiceMoney> = {};
  for (const i of invs) {
    const r = rows.find((x) => x.invoiceId === i.id);
    const settled = int(r?.settled);
    out[i.id] = {
      totalMinor: i.total,
      settledMinor: settled,
      pendingMinor: int(r?.pending),
      refundedMinor: int(r?.refunded),
      balanceMinor: Math.max(0, i.total - settled),
    };
  }
  return out;
}

export const MANUAL_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "personal_venmo", label: "Venmo (personal / QR — not provider-verified)" },
  { value: "zelle", label: "Zelle" },
  { value: "other", label: "Other offline" },
] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number]["value"];

/**
 * Record an offline payment. Always staff_attested + attributed to the recording user + a required
 * reference (check #, receipt #, Venmo handle/transaction note). Never provider_verified.
 */
export async function recordManualPayment(
  tx: Tx,
  v: Viewer,
  input: { invoiceId: string; amountMinor: number; method: ManualMethod; reference: string; notes?: string | null; isDemo?: boolean },
) {
  assertCan(v, "billing.manage");
  const reference = (input.reference ?? "").trim();
  if (!reference) throw new UserError("A reference is required for offline payments (check #, receipt #, Venmo note…).", { reference: "Required" });
  if (!MANUAL_METHODS.some((m) => m.value === input.method)) throw new UserError("Choose a payment method.");
  assertMinor(input.amountMinor);
  if (input.amountMinor <= 0) throw new UserError("Amount must be greater than $0.");
  const inv = await lockInvoice(tx, v.orgId, input.invoiceId);
  if (inv.status !== "open") throw new UserError(`Payments can only be recorded on open invoices (this one is ${inv.status}).`);
  const money = await invoiceMoney(tx, inv.id);
  // Money already in flight (e.g. ACH processing) is reserved against the balance to prevent double collection.
  const collectible = money.balanceMinor - money.pendingMinor;
  if (money.pendingMinor > 0 && input.amountMinor > collectible) {
    throw new UserError("A bank/provider payment for this invoice is still processing. Wait for it to settle or fail before recording an offline payment.");
  }
  if (input.amountMinor > money.balanceMinor) throw new UserError(`Amount exceeds the balance due (${money.balanceMinor} cents).`);
  const [txn] = await tx
    .insert(transactions)
    .values({
      orgId: v.orgId,
      payerAccountId: inv.payerAccountId,
      invoiceId: inv.id,
      kind: "manual_payment",
      status: "settled",
      amountMinor: input.amountMinor,
      currency: inv.currency,
      provider: "manual",
      methodType: input.method,
      settledAt: new Date(),
      recordedBy: v.userId,
      manualReference: reference,
      verification: "staff_attested",
      notes: input.notes ?? null,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  await audit(tx, actorOf(v), "billing.payment.manual", "transaction", txn.id, {
    summary: `Recorded ${input.method} payment on ${inv.number} (staff attested, ref ${reference})`,
    after: { amountMinor: input.amountMinor, method: input.method, reference },
  });
  const settled = await settleInvoiceIfCovered(tx, inv.id, actorOf(v));
  return { transaction: txn, invoicePaid: settled.paid };
}

/**
 * Mark an invoice paid once settled money covers its total, then apply entitlements.
 * Safe to call repeatedly / concurrently: the invoice row is locked and grants are idempotent.
 */
export async function settleInvoiceIfCovered(tx: Tx, invoiceId: string, actor: AuditActor) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv) return { paid: false };
  if (inv.status === "paid") {
    await applyInvoiceEntitlements(tx, inv.id, actor);
    return { paid: true };
  }
  if (inv.status !== "open") return { paid: false };
  const money = await invoiceMoney(tx, inv.id);
  if (money.settledMinor < inv.totalMinor) return { paid: false };
  await tx.update(invoices).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() }).where(eq(invoices.id, inv.id));
  await audit(tx, { ...actor, orgId: inv.orgId }, "billing.invoice.paid", "invoice", inv.id, { summary: `${inv.number} paid in full` });
  await applyInvoiceEntitlements(tx, inv.id, actor);
  return { paid: true };
}

/**
 * Grant what each line entitles: credits (exactly once per invoice line via the unique
 * source_invoice_line_id) and membership activation.
 */
export async function applyInvoiceEntitlements(tx: Tx, invoiceId: string, actor: AuditActor) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return { granted: 0 };
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  let granted = 0;
  for (const line of lines) {
    const e = line.entitlement;
    if (!e) continue;
    if (e.credits && e.credits > 0 && line.athleteId) {
      const membershipId = e.activateMembershipId ?? inv.membershipId ?? null;
      const expiresAt = e.creditExpiryDays
        ? new Date(Date.now() + e.creditExpiryDays * 86_400_000)
        : inv.periodEnd
          ? localToUtc(addDaysYmd(inv.periodEnd, 1), "00:00")
          : null;
      const r = await grantCredits(tx, {
        orgId: inv.orgId,
        athleteId: line.athleteId,
        amount: e.credits * line.quantity,
        sourceKind: membershipId ? "membership_period" : "purchase",
        sourceInvoiceLineId: line.id,
        membershipId,
        serviceTypeIds: e.serviceTypeIds ?? [],
        expiresAt,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        actorUserId: actor.actorUserId,
        reason: `Invoice ${inv.number}`,
        idempotencyKey: `invoice-line:${line.id}`,
        isDemo: inv.isDemo,
      });
      if (r.created) granted += e.credits * line.quantity;
    }
    if (e.activateMembershipId) await activateMembership(tx, e.activateMembershipId, inv.id, actor);
  }
  return { granted };
}

async function activateMembership(tx: Tx, membershipId: string, invoiceId: string, actor: AuditActor) {
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).for("update");
  if (!m || !["pending", "past_due", "trialing"].includes(m.status)) return;
  // Only activate when no other invoice for this membership is still past due.
  const outstanding = await tx.execute(sql`
    select 1 from invoices where membership_id = ${membershipId} and status = 'open' and id <> ${invoiceId}
      and due_date < ${todayLocal()} limit 1`);
  if (outstanding.rows.length) return;
  await tx.update(memberships).set({ status: "active", updatedAt: new Date() }).where(eq(memberships.id, membershipId));
  await tx.insert(membershipEvents).values({
    membershipId,
    type: "activated",
    effectiveOn: todayLocal(),
    details: { invoiceId, from: m.status },
    actorUserId: actor.actorUserId,
  });
  await audit(tx, { ...actor, orgId: m.orgId }, "billing.membership.activate", "membership", membershipId, { summary: `Membership active after payment (was ${m.status})` });
}
