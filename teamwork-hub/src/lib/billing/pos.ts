import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { inventoryMovements, payerAccounts, payerBeneficiaries, products } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { versionOn } from "./catalog";
import { createInvoiceRecord, recordManualPayment, type LineInput, type ManualMethod } from "./invoices";
import { actorOf, int } from "./util";

export const WALK_IN_NAME = "Walk-in customer (POS)";

/** Shared payer account for anonymous counter sales (invoices always need a payer). */
export async function walkInPayer(tx: Tx, orgId: string) {
  const [p] = await tx
    .select()
    .from(payerAccounts)
    .where(and(eq(payerAccounts.orgId, orgId), eq(payerAccounts.name, WALK_IN_NAME), isNull(payerAccounts.householdId)));
  if (p) return p;
  const [np] = await tx.insert(payerAccounts).values({ orgId, name: WALK_IN_NAME, providerRefs: { kind: "walk_in" } }).returning();
  return np;
}

export async function onHandCounts(tx: Tx, orgId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ productId: inventoryMovements.productId, n: sql<string>`coalesce(sum(${inventoryMovements.delta}),0)::bigint` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.orgId, orgId))
    .groupBy(inventoryMovements.productId);
  return Object.fromEntries(rows.map((r) => [r.productId, int(r.n)]));
}

export async function adjustStock(tx: Tx, v: Viewer, input: { productId: string; delta: number; reason: "receive" | "adjust" | "return"; note?: string | null }) {
  assertCan(v, "billing.manage");
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new UserError("Quantity must be a non-zero whole number.");
  if (input.reason === "receive" && input.delta < 0) throw new UserError("Received quantity must be positive.");
  if (input.reason === "adjust" && !input.note?.trim()) throw new UserError("Stock adjustments need a note.");
  const [p] = await tx.select().from(products).where(and(eq(products.id, input.productId), eq(products.orgId, v.orgId))).for("update");
  if (!p || !p.trackInventory) throw new UserError("That product does not track inventory.");
  const counts = await onHandCounts(tx, v.orgId);
  if ((counts[p.id] ?? 0) + input.delta < 0) throw new UserError("Adjustment would make on-hand stock negative.");
  const [mv] = await tx.insert(inventoryMovements).values({ orgId: v.orgId, productId: p.id, delta: input.delta, reason: input.reason, actorUserId: v.userId, note: input.note ?? null }).returning();
  await audit(tx, actorOf(v), "billing.inventory." + input.reason, "product", p.id, { summary: `${input.delta > 0 ? "+" : ""}${input.delta} ${p.name}${input.note ? ` (${input.note})` : ""}` });
  return mv;
}

export type SaleInput = {
  payerAccountId?: string | null;
  athleteId?: string | null;
  items: { productId: string; quantity: number }[];
  payment: { kind: "manual"; method: ManualMethod; reference: string } | { kind: "invoice" };
  today: string;
  isDemo?: boolean;
};

/**
 * Counter sale. Stock is checked under a row lock on each tracked product, so two registers can't
 * sell the last item twice. Payment is either recorded offline now (staff_attested) or left as an
 * open invoice to pay through provider checkout.
 */
export async function quickSale(tx: Tx, v: Viewer, input: SaleInput) {
  assertCan(v, "billing.manage");
  const items = input.items.filter((i) => i.quantity > 0);
  if (!items.length) throw new UserError("Add at least one item.");
  if (items.some((i) => !Number.isInteger(i.quantity))) throw new UserError("Quantities must be whole numbers.");
  const payer = input.payerAccountId
    ? (await tx.select().from(payerAccounts).where(and(eq(payerAccounts.id, input.payerAccountId), eq(payerAccounts.orgId, v.orgId))))[0]
    : await walkInPayer(tx, v.orgId);
  if (!payer) throw new UserError("Payer account not found.");
  if (input.athleteId) {
    const [b] = await tx.select().from(payerBeneficiaries).where(and(eq(payerBeneficiaries.payerAccountId, payer.id), eq(payerBeneficiaries.athleteId, input.athleteId)));
    if (!b) throw new UserError("That athlete is not linked to this payer account.");
  }
  const ids = [...new Set(items.map((i) => i.productId))];
  const ps = await tx.select().from(products).where(and(inArray(products.id, ids), eq(products.orgId, v.orgId))).orderBy(products.id).for("update");
  if (ps.length !== ids.length) throw new UserError("One of the products was not found.");
  const counts = await onHandCounts(tx, v.orgId);
  const lines: LineInput[] = [];
  const productByVersion = new Map<string, (typeof ps)[number]>();
  for (const it of items) {
    const p = ps.find((x) => x.id === it.productId)!;
    if (!p.active) throw new UserError(`${p.name} is archived.`);
    if (p.kind === "recurring_membership") throw new UserError("Sell memberships from the Memberships page.");
    if (p.trackInventory) {
      const need = items.filter((x) => x.productId === p.id).reduce((s, x) => s + x.quantity, 0);
      if ((counts[p.id] ?? 0) < need) throw new UserError(`Only ${counts[p.id] ?? 0} × ${p.name} on hand.`);
    }
    const ver = await versionOn(tx, p.id, input.today);
    if (!ver) throw new UserError(`${p.name} has no price in effect today.`);
    productByVersion.set(ver.id, p);
    const grantsCredits = (p.kind === "package" || p.kind === "drop_in" || p.kind === "trial" || p.kind === "assessment") && ver.creditsPerPeriod;
    if (grantsCredits && !input.athleteId) throw new UserError(`${p.name} grants session credits — choose the athlete.`);
    lines.push({
      description: p.name,
      quantity: it.quantity,
      unitAmountMinor: ver.priceMinor,
      productVersionId: ver.id,
      athleteId: input.athleteId ?? null,
      entitlement: grantsCredits ? { credits: ver.creditsPerPeriod!, creditExpiryDays: ver.creditExpiryDays ?? undefined, serviceTypeIds: ver.serviceTypeIds } : null,
    });
  }
  const { invoice, lines: created } = await createInvoiceRecord(tx, actorOf(v), {
    orgId: v.orgId,
    payerAccountId: payer.id,
    lines,
    source: "pos",
    status: "open",
    dueDate: input.today,
    isDemo: input.isDemo ?? false,
  });
  for (const l of created ?? []) {
    const p = l.productVersionId ? productByVersion.get(l.productVersionId) : undefined;
    if (p?.trackInventory) {
      await tx.insert(inventoryMovements).values({ orgId: v.orgId, productId: p.id, delta: -l.quantity, reason: "sale", invoiceLineId: l.id, actorUserId: v.userId });
    }
  }
  let paid = false;
  if (input.payment.kind === "manual" && invoice.totalMinor > 0) {
    const r = await recordManualPayment(tx, v, { invoiceId: invoice.id, amountMinor: invoice.totalMinor, method: input.payment.method, reference: input.payment.reference, isDemo: input.isDemo });
    paid = r.invoicePaid;
  }
  await audit(tx, actorOf(v), "billing.pos.sale", "invoice", invoice.id, { summary: `POS sale ${invoice.number} (${input.payment.kind})` });
  return { invoice, paid };
}
