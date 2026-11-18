import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { invoices, payerAccounts } from "@/db/schema";
import { AuthzError, can, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";

/**
 * Billing visibility:
 * - owner/admin/operations (billing.view_all): every payer account in their org.
 * - guardians/athletes: only payer accounts where they hold a payer_authorization
 *   (view and pay are distinct — Jordan views, Alex pays; Casey has none for Leo).
 * - coaches and kiosks: nothing.
 */
export async function viewablePayerIds(tx: Tx, v: Viewer): Promise<string[] | "all"> {
  if (can(v, "billing.view_all")) return "all";
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  return orgFilter(tx, v, await payerAccountIdsFor(tx, v, "view"));
}

export async function payablePayerIds(tx: Tx, v: Viewer): Promise<string[] | "all"> {
  if (can(v, "billing.manage")) return "all";
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  return orgFilter(tx, v, await payerAccountIdsFor(tx, v, "pay"));
}

async function orgFilter(tx: Tx, v: Viewer, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx
    .select({ id: payerAccounts.id })
    .from(payerAccounts)
    .where(and(inArray(payerAccounts.id, ids), eq(payerAccounts.orgId, v.orgId)));
  return rows.map((r) => r.id);
}

export function inScope(scope: string[] | "all", id: string | null | undefined) {
  if (!id) return false;
  return scope === "all" || scope.includes(id);
}

export async function assertCanViewPayer(tx: Tx, v: Viewer, payerAccountId: string) {
  const [p] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, payerAccountId));
  if (!p || p.orgId !== v.orgId) throw new AuthzError();
  if (!inScope(await viewablePayerIds(tx, v), payerAccountId)) throw new AuthzError();
}

export async function assertCanPayPayer(tx: Tx, v: Viewer, payerAccountId: string) {
  const [p] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, payerAccountId));
  if (!p || p.orgId !== v.orgId) throw new AuthzError();
  if (!inScope(await payablePayerIds(tx, v), payerAccountId)) throw new AuthzError("You can view this account but are not authorized to pay it.");
}

/** Load an invoice the viewer may see (org + payer scope), else throw. */
export async function loadInvoiceForViewer(tx: Tx, v: Viewer, invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, v.orgId)));
  if (!inv) throw new AuthzError();
  await assertCanViewPayer(tx, v, inv.payerAccountId);
  return inv;
}

export function isBillingStaff(v: Viewer) {
  return can(v, "billing.view_all");
}
