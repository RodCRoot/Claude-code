import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  invoiceLines,
  invoices,
  membershipEvents,
  memberships,
  paymentAttempts,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  people,
  products,
  productVersions,
  refunds,
  transactions,
  users,
} from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { creditSummary } from "@/lib/credits";
import { inScope, isBillingStaff, loadInvoiceForViewer, payablePayerIds, viewablePayerIds } from "./access";
import { invoiceMoney, invoiceMoneyMany } from "./invoices";
import { holdsFor } from "./memberships";
import { int } from "./util";

function payerFilter(scope: string[] | "all", col: Parameters<typeof inArray>[0]): SQL {
  if (scope === "all") return sql`true`;
  if (!scope.length) return sql`false`;
  return inArray(col, scope);
}

export async function listInvoices(tx: Tx, v: Viewer, f: { status?: string; payerAccountId?: string; limit?: number } = {}) {
  const scope = await viewablePayerIds(tx, v);
  const rows = await tx
    .select({ invoice: invoices, payerName: payerAccounts.name })
    .from(invoices)
    .innerJoin(payerAccounts, eq(payerAccounts.id, invoices.payerAccountId))
    .where(
      and(
        eq(invoices.orgId, v.orgId),
        payerFilter(scope, invoices.payerAccountId),
        // Drafts are internal until issued.
        isBillingStaff(v) ? sql`true` : sql`${invoices.status} <> 'draft'`,
        f.status && f.status !== "all" ? (f.status === "past_due" ? sql`${invoices.status} = 'open' and ${invoices.dueDate} < current_date` : eq(invoices.status, f.status as "open")) : sql`true`,
        f.payerAccountId ? eq(invoices.payerAccountId, f.payerAccountId) : sql`true`,
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(f.limit ?? 200);
  const money = await invoiceMoneyMany(tx, rows.map((r) => r.invoice.id));
  return rows.map((r) => ({ ...r, money: money[r.invoice.id] }));
}

export async function invoiceDetail(tx: Tx, v: Viewer, invoiceId: string) {
  const inv = await loadInvoiceForViewer(tx, v, invoiceId);
  const staff = isBillingStaff(v);
  const [payer] = await tx.select().from(payerAccounts).where(eq(payerAccounts.id, inv.payerAccountId));
  const lines = await tx
    .select({ line: invoiceLines, athleteFirst: people.firstName, athleteLast: people.lastName })
    .from(invoiceLines)
    .leftJoin(athletes, eq(athletes.id, invoiceLines.athleteId))
    .leftJoin(people, eq(people.id, athletes.personId))
    .where(eq(invoiceLines.invoiceId, inv.id));
  const txns = await tx
    .select({ t: transactions, recorder: users.displayName })
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.recordedBy))
    .where(eq(transactions.invoiceId, inv.id))
    .orderBy(asc(transactions.occurredAt));
  const attempts = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, inv.id)).orderBy(desc(paymentAttempts.createdAt));
  const refundRows = txns.length
    ? await tx.select().from(refunds).where(inArray(refunds.transactionId, txns.map((x) => x.t.id))).orderBy(desc(refunds.createdAt))
    : [];
  const money = await invoiceMoney(tx, inv.id);
  const canPay = inScope(await payablePayerIds(tx, v), inv.payerAccountId);
  return {
    invoice: inv,
    payer,
    lines,
    // Families see their payments but not staff notes/recorders.
    transactions: staff ? txns : txns.map((x) => ({ t: { ...x.t, notes: null }, recorder: null })),
    attempts,
    refunds: refundRows,
    money,
    canPay,
    staff,
  };
}

export async function listMemberships(tx: Tx, v: Viewer, f: { status?: string } = {}) {
  const scope = await viewablePayerIds(tx, v);
  return tx
    .select({
      m: memberships,
      first: people.firstName,
      last: people.lastName,
      productName: products.name,
      version: productVersions.version,
      priceMinor: productVersions.priceMinor,
      currency: productVersions.currency,
      interval: productVersions.interval,
      unlimited: productVersions.unlimited,
      credits: productVersions.creditsPerPeriod,
      payerName: payerAccounts.name,
    })
    .from(memberships)
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .leftJoin(payerAccounts, eq(payerAccounts.id, memberships.payerAccountId))
    .where(
      and(
        eq(memberships.orgId, v.orgId),
        scope === "all" ? sql`true` : payerFilter(scope, memberships.payerAccountId),
        f.status && f.status !== "all" ? eq(memberships.status, f.status as "active") : sql`true`,
      ),
    )
    .orderBy(asc(people.lastName), asc(people.firstName));
}

export async function membershipDetail(tx: Tx, v: Viewer, id: string) {
  const [row] = (await listMemberships(tx, v)).filter((r) => r.m.id === id);
  if (!row) throw new AuthzError();
  const events = await tx
    .select({ e: membershipEvents, actor: users.displayName })
    .from(membershipEvents)
    .leftJoin(users, eq(users.id, membershipEvents.actorUserId))
    .where(eq(membershipEvents.membershipId, id))
    .orderBy(desc(membershipEvents.createdAt));
  const holds = await holdsFor(tx, id);
  const invs = await tx.select().from(invoices).where(eq(invoices.membershipId, id)).orderBy(desc(invoices.periodStart));
  const money = await invoiceMoneyMany(tx, invs.map((i) => i.id));
  const [version] = await tx.select().from(productVersions).where(eq(productVersions.id, row.m.productVersionId));
  const credits = await creditSummary(tx, row.m.athleteId);
  return { ...row, events, holds, invoices: invs.map((i) => ({ invoice: i, money: money[i.id] })), version, credits };
}

/** Payer accounts the viewer can see, with their own permission flags (for the family portal). */
export async function myPayerAccounts(tx: Tx, v: Viewer) {
  if (!v.personId) return [];
  const rows = await tx
    .select({ payer: payerAccounts, auth: payerAuthorizations })
    .from(payerAuthorizations)
    .innerJoin(payerAccounts, eq(payerAccounts.id, payerAuthorizations.payerAccountId))
    .where(and(eq(payerAuthorizations.personId, v.personId), eq(payerAccounts.orgId, v.orgId), eq(payerAuthorizations.canViewInvoices, true)));
  const out = [];
  for (const r of rows) {
    const bens = await tx
      .select({ athleteId: athletes.id, first: people.firstName, last: people.lastName })
      .from(payerBeneficiaries)
      .innerJoin(athletes, eq(athletes.id, payerBeneficiaries.athleteId))
      .innerJoin(people, eq(people.id, athletes.personId))
      .where(eq(payerBeneficiaries.payerAccountId, r.payer.id));
    const credits = [];
    for (const b of bens) credits.push({ ...b, summary: await creditSummary(tx, b.athleteId) });
    out.push({ payer: r.payer, canPay: r.auth.canPay, athletes: credits });
  }
  return out;
}

export async function staffOverview(tx: Tx, orgId: string, today: string) {
  const inv = await tx.execute(sql`
    select
      count(*) filter (where i.status = 'open')::int as open_count,
      count(*) filter (where i.status = 'open' and i.due_date < ${today})::int as past_due_count,
      coalesce(sum(i.total_minor) filter (where i.status = 'open'),0)::bigint as open_total,
      coalesce(sum(i.total_minor) filter (where i.status = 'open' and i.due_date < ${today}),0)::bigint as past_due_total
    from invoices i where i.org_id = ${orgId}`);
  const col = await tx.execute(sql`
    select
      coalesce(sum(amount_minor) filter (where status='settled' and verification='provider_verified'),0)::bigint as settled_verified,
      coalesce(sum(amount_minor) filter (where status='settled' and verification='staff_attested'),0)::bigint as settled_attested,
      coalesce(sum(amount_minor) filter (where status='pending'),0)::bigint as pending
    from transactions where org_id = ${orgId} and kind in ('charge','manual_payment') and occurred_at > now() - interval '30 days'`);
  const ms = await tx.execute(sql`select status, billing_provider, count(*)::int as n from memberships where org_id = ${orgId} group by 1,2`);
  const i = inv.rows[0] as Record<string, unknown>;
  const c = col.rows[0] as Record<string, unknown>;
  // Open balance excludes amounts already settled on partially-paid invoices.
  const partial = await tx.execute(sql`
    select coalesce(sum(t.amount_minor),0)::bigint as s from transactions t join invoices i on i.id = t.invoice_id
    where i.org_id = ${orgId} and i.status = 'open' and t.status = 'settled' and t.kind in ('charge','manual_payment')`);
  return {
    openCount: Number(i.open_count),
    pastDueCount: Number(i.past_due_count),
    openBalance: int(i.open_total) - int((partial.rows[0] as Record<string, unknown>).s),
    pastDueTotal: int(i.past_due_total),
    settledVerified30: int(c.settled_verified),
    settledAttested30: int(c.settled_attested),
    pending30: int(c.pending),
    memberships: ms.rows as { status: string; billing_provider: string; n: number }[],
  };
}

export async function payerOptions(tx: Tx, orgId: string) {
  const rows = await tx.select({ id: payerAccounts.id, name: payerAccounts.name }).from(payerAccounts).where(eq(payerAccounts.orgId, orgId)).orderBy(asc(payerAccounts.name));
  const bens = await tx
    .select({ payerAccountId: payerBeneficiaries.payerAccountId, athleteId: athletes.id, first: people.firstName, last: people.lastName })
    .from(payerBeneficiaries)
    .innerJoin(athletes, eq(athletes.id, payerBeneficiaries.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(athletes.orgId, orgId));
  return rows.map((p) => ({ ...p, athletes: bens.filter((b) => b.payerAccountId === p.id) }));
}

export async function membershipPlanOptions(tx: Tx, orgId: string, today: string) {
  return tx
    .select({ versionId: productVersions.id, name: products.name, version: productVersions.version, priceMinor: productVersions.priceMinor, currency: productVersions.currency, interval: productVersions.interval, sibling: productVersions.familyDiscount, effectiveFrom: productVersions.effectiveFrom, effectiveTo: productVersions.effectiveTo })
    .from(productVersions)
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(
      and(
        eq(products.orgId, orgId),
        eq(products.kind, "recurring_membership"),
        eq(products.active, true),
        sql`(${productVersions.effectiveTo} is null or ${productVersions.effectiveTo} >= ${today})`,
      ),
    )
    .orderBy(asc(products.name), asc(productVersions.version));
}
