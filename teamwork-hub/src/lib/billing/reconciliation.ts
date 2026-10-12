import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { paymentAttempts, payouts, refunds } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { todayLocal } from "@/lib/time";
import { billingSettings, int } from "./util";

export type PaymentException = {
  kind: "failed_payment" | "amount_mismatch" | "pending_too_long" | "past_due_membership" | "webhook_problem" | "refund_blocked" | "dispute_open" | "invoice_mismatch";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  href: string;
  at: Date | string | null;
};

/**
 * Payment exceptions for the staff dashboard (exported for other modules).
 * Scoped to one org; read-only. Webhook rows have no org column, so they are attributed
 * through the payment attempt they reference (unmatched ones are surfaced on /billing/reconciliation).
 */
export async function paymentExceptions(tx: Tx, orgId: string, opts: { today?: string; limit?: number } = {}): Promise<PaymentException[]> {
  const today = opts.today ?? todayLocal();
  const { pendingAlertDays } = await billingSettings(tx, orgId);
  const out: PaymentException[] = [];

  const failed = await tx.execute(sql`
    select a.id, a.invoice_id, a.provider, a.amount_minor, a.currency, a.failure_code, a.failure_message, a.updated_at, i.number, i.status as invoice_status
    from payment_attempts a join invoices i on i.id = a.invoice_id
    where a.org_id = ${orgId} and a.status = 'failed' and a.updated_at > now() - interval '30 days'
      and coalesce(a.failure_code,'') <> 'unsupported'
    order by a.updated_at desc limit 50`);
  for (const r of failed.rows as Record<string, unknown>[]) {
    const mismatch = r.failure_code === "amount_mismatch";
    if (!mismatch && r.invoice_status === "paid") continue; // later paid another way
    out.push({
      kind: mismatch ? "amount_mismatch" : "failed_payment",
      severity: mismatch ? "high" : "medium",
      title: `${mismatch ? "Amount mismatch" : "Failed payment"} on ${r.number}`,
      detail: `${r.provider}: ${r.failure_message ?? r.failure_code ?? "provider reported failure"}`,
      href: `/billing/invoices/${r.invoice_id}`,
      at: r.updated_at as Date,
    });
  }

  const pending = await tx.execute(sql`
    select t.id, t.invoice_id, t.amount_minor, t.currency, t.provider, t.method_type, t.occurred_at, i.number
    from transactions t left join invoices i on i.id = t.invoice_id
    where t.org_id = ${orgId} and t.status = 'pending' and t.occurred_at < now() - make_interval(days => ${pendingAlertDays})
    order by t.occurred_at limit 50`);
  for (const r of pending.rows as Record<string, unknown>[]) {
    out.push({
      kind: "pending_too_long",
      severity: "medium",
      title: `Payment pending > ${pendingAlertDays} days${r.number ? ` (${r.number})` : ""}`,
      detail: `${r.provider} ${r.method_type ?? ""} ${formatMoney(int(r.amount_minor), String(r.currency))} still not settled`,
      href: r.invoice_id ? `/billing/invoices/${r.invoice_id}` : "/billing/reconciliation",
      at: r.occurred_at as Date,
    });
  }

  const pastDue = await tx.execute(sql`
    select m.id, p.first_name, p.last_name, pr.name as product, min(i.due_date) as oldest
    from memberships m
    join athletes a on a.id = m.athlete_id join people p on p.id = a.person_id
    join product_versions v on v.id = m.product_version_id join products pr on pr.id = v.product_id
    left join invoices i on i.membership_id = m.id and i.status = 'open' and i.due_date < ${today}
    where m.org_id = ${orgId} and m.billing_provider <> 'external_zenplanner'
      and (m.status = 'past_due' or i.id is not null)
    group by m.id, p.first_name, p.last_name, pr.name limit 100`);
  for (const r of pastDue.rows as Record<string, unknown>[]) {
    out.push({
      kind: "past_due_membership",
      severity: "medium",
      title: `Past due: ${r.first_name} ${r.last_name}`,
      detail: `${r.product}${r.oldest ? ` — oldest unpaid invoice due ${String(r.oldest)}` : ""}`,
      href: `/billing/memberships/${r.id}`,
      at: (r.oldest as string) ?? null,
    });
  }

  const hooks = await tx.execute(sql`
    select w.id, w.provider, w.type, w.status, w.error, w.received_at
    from webhook_events w
    join payment_attempts a on a.id::text = coalesce(w.payload#>>'{data,object,metadata,attempt_id}', w.payload#>>'{resource,custom_id}')
    where a.org_id = ${orgId} and w.status in ('failed','received') and w.received_at < now() - interval '5 minutes'
    order by w.received_at desc limit 25`);
  for (const r of hooks.rows as Record<string, unknown>[]) {
    out.push({ kind: "webhook_problem", severity: "high", title: `Webhook ${r.status}: ${r.type}`, detail: String(r.error ?? ""), href: "/billing/reconciliation", at: r.received_at as Date });
  }

  const blocked = await tx.select().from(refunds).where(and(eq(refunds.orgId, orgId), eq(refunds.status, "blocked_config"))).orderBy(desc(refunds.createdAt)).limit(25);
  for (const r of blocked) {
    out.push({ kind: "refund_blocked", severity: "medium", title: "Refund blocked: provider not configured", detail: `${formatMoney(int(r.amountMinor), r.currency)} — ${r.reason ?? ""}`, href: "/billing/reconciliation", at: r.createdAt });
  }

  const disp = await tx.execute(sql`
    select d.id, d.provider, d.amount_minor, d.currency, d.status, d.reason, d.evidence_due_by, t.invoice_id
    from disputes d left join transactions t on t.id = d.transaction_id
    where d.org_id = ${orgId} and d.status not in ('won','lost','closed','RESOLVED','charge_refunded')
    limit 25`);
  for (const r of disp.rows as Record<string, unknown>[]) {
    out.push({
      kind: "dispute_open",
      severity: "high",
      title: `Open dispute (${r.provider})`,
      detail: `${formatMoney(int(r.amount_minor), String(r.currency))} — ${r.reason ?? r.status}${r.evidence_due_by ? `; evidence due ${new Date(r.evidence_due_by as string).toISOString().slice(0, 10)}` : ""}`,
      href: r.invoice_id ? `/billing/invoices/${r.invoice_id}` : "/billing/reconciliation",
      at: (r.evidence_due_by as Date) ?? null,
    });
  }

  const mism = await invoiceLedgerMismatches(tx, orgId);
  for (const r of mism) {
    out.push({ kind: "invoice_mismatch", severity: "high", title: `Invoice ${r.number} ${r.problem}`, detail: `total ${formatMoney(r.total)}, settled ${formatMoney(r.settled)}`, href: `/billing/invoices/${r.id}`, at: null });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out.slice(0, opts.limit ?? 200);
}

/** Invoices whose status disagrees with the settled ledger. */
export async function invoiceLedgerMismatches(tx: Tx, orgId: string) {
  const res = await tx.execute(sql`
    select i.id, i.number, i.status, i.total_minor as total,
      coalesce(sum(case when t.kind in ('charge','manual_payment') and t.status = 'settled' then t.amount_minor else 0 end),0)::bigint as settled
    from invoices i left join transactions t on t.invoice_id = i.id
    where i.org_id = ${orgId} and i.status in ('open','paid')
    group by i.id`);
  return (res.rows as Record<string, unknown>[])
    .map((r) => ({ id: String(r.id), number: String(r.number), status: String(r.status), total: int(r.total), settled: int(r.settled) }))
    .filter((r) => (r.status === "paid" && r.settled < r.total) || (r.status === "open" && r.total > 0 && r.settled >= r.total))
    .map((r) => ({ ...r, problem: r.status === "paid" ? "is marked paid but settled money is short" : "is fully settled but still open" }));
}

/** Data for /billing/reconciliation. */
export async function reconciliationData(tx: Tx, orgId: string, today = todayLocal()) {
  const { pendingAlertDays } = await billingSettings(tx, orgId);
  const summary = await tx.execute(sql`
    select
      coalesce(sum(case when kind in ('charge','manual_payment') and status='settled' then amount_minor end),0)::bigint as settled_in,
      coalesce(sum(case when kind in ('charge','manual_payment') and status='settled' and verification='provider_verified' then amount_minor end),0)::bigint as settled_verified,
      coalesce(sum(case when kind in ('charge','manual_payment') and status='settled' and verification='staff_attested' then amount_minor end),0)::bigint as settled_attested,
      coalesce(sum(case when kind in ('charge','manual_payment') and status='pending' then amount_minor end),0)::bigint as pending_in,
      coalesce(sum(case when kind='refund' and status='settled' then -amount_minor end),0)::bigint as refunded,
      coalesce(sum(case when kind in ('dispute','dispute_reversal') and status='settled' then -amount_minor end),0)::bigint as disputed_net
    from transactions where org_id = ${orgId}`);
  const s = summary.rows[0] as Record<string, unknown>;
  const byMethod = await tx.execute(sql`
    select provider, verification, coalesce(method_type,'—') as method, status, count(*)::int as n, coalesce(sum(amount_minor),0)::bigint as total
    from transactions where org_id = ${orgId} and kind in ('charge','manual_payment')
    group by 1,2,3,4 order by 1,3`);
  const pending = await tx.execute(sql`
    select t.id, t.invoice_id, i.number, t.provider, t.method_type, t.amount_minor, t.currency, t.occurred_at,
      (now() - t.occurred_at) > make_interval(days => ${pendingAlertDays}) as overdue
    from transactions t left join invoices i on i.id = t.invoice_id
    where t.org_id = ${orgId} and t.status = 'pending' order by t.occurred_at`);
  const attempts = await tx
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.orgId, orgId), inArray(paymentAttempts.status, ["failed", "processing", "pending", "requires_action", "created"])))
    .orderBy(desc(paymentAttempts.updatedAt))
    .limit(50);
  // Webhook events are not org-scoped. Show events that map to this org's attempts, plus events that map to no attempt at all
  // (unmatched/rejected — they cannot belong to a known org and need operator review).
  const hooks = await tx.execute(sql`
    select w.id, w.provider, w.provider_event_id, w.type, w.status, w.error, w.signature_verified, w.received_at, w.attempts, a.org_id
    from webhook_events w
    left join payment_attempts a on a.id::text = coalesce(w.payload#>>'{data,object,metadata,attempt_id}', w.payload#>>'{resource,custom_id}')
    where (a.org_id = ${orgId}) or (a.id is null and (w.status in ('rejected','failed','received') or w.error like 'unmatched%'))
    order by w.received_at desc limit 100`);
  const payoutRows = await tx.select().from(payouts).where(eq(payouts.orgId, orgId)).orderBy(desc(payouts.createdAt)).limit(50);
  const refundRows = await tx.execute(sql`
    select r.*, t.provider, t.invoice_id, i.number from refunds r join transactions t on t.id = r.transaction_id left join invoices i on i.id = t.invoice_id
    where r.org_id = ${orgId} order by r.created_at desc limit 50`);
  const disputeRows = await tx.execute(sql`
    select d.*, t.invoice_id from disputes d left join transactions t on t.id = d.transaction_id where d.org_id = ${orgId} order by d.created_at desc limit 50`);
  return {
    today,
    pendingAlertDays,
    totals: {
      settledIn: int(s.settled_in),
      settledVerified: int(s.settled_verified),
      settledAttested: int(s.settled_attested),
      pendingIn: int(s.pending_in),
      refunded: int(s.refunded),
      disputedNet: int(s.disputed_net),
    },
    byMethod: (byMethod.rows as Record<string, unknown>[]).map((r) => ({ ...r, total: int(r.total) })) as { provider: string; verification: string; method: string; status: string; n: number; total: number }[],
    pending: pending.rows as Record<string, unknown>[],
    attempts,
    webhooks: hooks.rows as Record<string, unknown>[],
    payouts: payoutRows,
    refunds: refundRows.rows as Record<string, unknown>[],
    disputes: disputeRows.rows as Record<string, unknown>[],
    mismatches: await invoiceLedgerMismatches(tx, orgId),
  };
}
