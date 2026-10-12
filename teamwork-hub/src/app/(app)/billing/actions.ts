"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products, type ProductKind } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { assertCan } from "@/lib/authz/policy";
import { createProduct, createProductVersion, setProductActive, setProductLocations, versionOn, type VersionInput } from "@/lib/billing/catalog";
import { startCheckout } from "@/lib/billing/checkout";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { createManualInvoice, issueInvoice, markUncollectible, recordManualPayment, voidInvoice, type LineInput, type ManualMethod } from "@/lib/billing/invoices";
import { addHold, cancelMembership, changePlan, createMembership, cutoverMembership, removeHold, type InternalBillingProvider } from "@/lib/billing/memberships";
import { adjustStock, quickSale } from "@/lib/billing/pos";
import { requestRefund } from "@/lib/billing/refunds";
import { generateRenewals } from "@/lib/billing/renewals";
import { cancelProviderSubscription, startProviderSubscription, switchToTeamworkBilling } from "@/lib/billing/subscriptions";
import { env } from "@/lib/env";
import { parseMoneyToMinor } from "@/lib/money";
import type { ProviderName, SubscriptionProviderName } from "@/lib/payments";
import { todayLocal } from "@/lib/time";

/** Runs a billing mutation: translates domain errors into form state, revalidates billing pages. */
async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) revalidatePath("/billing", "layout");
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => s(fd, k) || null;
const optInt = (fd: FormData, k: string) => (s(fd, k) === "" ? null : Number(s(fd, k)));
function money(fd: FormData, k: string, label: string, required = true): number {
  const raw = s(fd, k);
  if (!raw && !required) return 0;
  const v = parseMoneyToMinor(raw);
  if (v == null) throw new UserError(`Enter ${label} as dollars and cents, e.g. 25.00`, { [k]: "Invalid amount" });
  return v;
}

function versionFromForm(fd: FormData): VersionInput {
  const interval = (s(fd, "interval") || "none") as VersionInput["interval"];
  return {
    priceMinor: money(fd, "price", "the price"),
    interval,
    intervalCount: optInt(fd, "intervalCount") ?? 1,
    creditsPerPeriod: optInt(fd, "credits"),
    unlimited: fd.get("unlimited") === "on",
    creditExpiryDays: optInt(fd, "creditExpiryDays"),
    trialDays: optInt(fd, "trialDays") ?? 0,
    commitmentMonths: optInt(fd, "commitmentMonths") ?? 0,
    cancellationNoticeDays: optInt(fd, "noticeDays") ?? 0,
    siblingPercentOff: optInt(fd, "siblingPercentOff"),
    effectiveFrom: s(fd, "effectiveFrom"),
  };
}

// --- Catalog -------------------------------------------------------------------

export async function createProductAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) =>
      createProduct(tx, v, {
        name: s(fd, "name"),
        kind: s(fd, "kind") as ProductKind,
        description: opt(fd, "description"),
        category: opt(fd, "category"),
        sku: opt(fd, "sku"),
        version: versionFromForm(fd),
      }),
    );
    return { ok: true, message: `Created ${r.product.name} (v1).` };
  });
}

export async function createVersionAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const ver = await db.transaction((tx) => createProductVersion(tx, v, s(fd, "productId"), versionFromForm(fd)));
    return { ok: true, message: `Version ${ver.version} takes effect ${ver.effectiveFrom}. Existing memberships keep their version.` };
  });
}

export async function productLocationsAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const ids = fd.getAll("locationIds").filter((x): x is string => typeof x === "string" && x !== "");
    await db.transaction((tx) => setProductLocations(tx, v, s(fd, "productId"), ids));
    return { ok: true, message: ids.length ? "Location limits saved." : "Valid at every location." };
  });
}

export async function toggleProductAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => setProductActive(tx, v, s(fd, "productId"), fd.get("active") === "true"));
    return { ok: true, message: "Saved." };
  });
}

// --- Memberships ---------------------------------------------------------------

export async function createMembershipAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const [athleteId, payerAccountId] = s(fd, "athletePayer").split(":");
    if (!athleteId || !payerAccountId) throw new UserError("Choose an athlete and payer.", { athletePayer: "Required" });
    const r = await db.transaction((tx) =>
      createMembership(tx, v, {
        athleteId,
        payerAccountId,
        productVersionId: s(fd, "productVersionId"),
        startDate: s(fd, "startDate"),
        billingAnchorDay: optInt(fd, "anchorDay"),
        billingProvider: (s(fd, "billingProvider") || "manual") as InternalBillingProvider,
        applyFamilyDiscount: fd.get("familyDiscount") === "on",
        today: todayLocal(),
      }),
    );
    redirect(`/billing/memberships/${r.membership.id}`);
  });
}

export async function addHoldAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) =>
      addHold(tx, v, { membershipId: s(fd, "membershipId"), startDate: s(fd, "startDate"), endDate: s(fd, "endDate"), reason: s(fd, "reason"), requestedAt: opt(fd, "requestedOn") ? new Date(`${s(fd, "requestedOn")}T12:00:00Z`) : null, today: todayLocal() }),
    );
    return { ok: true, message: "Hold saved. Renewals and credit grants pause during the hold." };
  });
}

export async function removeHoldAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => removeHold(tx, v, s(fd, "holdId"), todayLocal()));
    return { ok: true, message: "Hold ended." };
  });
}

export async function changePlanAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => changePlan(tx, v, { membershipId: s(fd, "membershipId"), toVersionId: s(fd, "toVersionId"), effectiveOn: s(fd, "effectiveOn"), today: todayLocal(), note: opt(fd, "note") ?? undefined }));
    return { ok: true, message: r.scheduled ? `${r.direction} scheduled; it applies at the first renewal on/after the effective date.` : `${r.direction} applied.` };
  });
}

export async function cancelMembershipAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) =>
      cancelMembership(tx, v, {
        membershipId: s(fd, "membershipId"),
        requestedOn: s(fd, "requestedOn") || todayLocal(),
        reason: s(fd, "reason"),
        today: todayLocal(),
        overrideCancelAt: opt(fd, "overrideCancelAt"),
        overrideReason: opt(fd, "overrideReason"),
      }),
    );
    return { ok: true, message: r.immediate ? `Cancelled effective ${r.cancelAt}.` : `Cancellation scheduled for ${r.cancelAt} (earliest allowed by terms: ${r.earliest}).` };
  });
}

export async function startSubscriptionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await requireViewer();
    const provider = s(fd, "provider") as SubscriptionProviderName;
    const r = await startProviderSubscription(db, v, { membershipId: s(fd, "membershipId"), provider, appUrl: env().APP_URL });
    if (!r.ok) return { ok: false, error: r.error, data: r.notConfigured ? { notConfigured: r.notConfigured } : undefined };
    return { ok: true, message: r.reused ? "A request is already open — share the same approval link below." : "Approval link created. Share it with the payer; nothing changes here until the provider confirms the subscription.", data: { approvalUrl: r.approvalUrl } };
  });
}

export async function switchToTeamworkAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await switchToTeamworkBilling(db, v, { membershipId: s(fd, "membershipId"), reason: s(fd, "reason") });
    if (r.withdrawn) return { ok: true, message: "Subscription request withdrawn. The membership stays on Teamwork invoices." };
    return { ok: true, message: `The provider subscription will stop at the end of its paid period. Teamwork invoices resume from ${r.firstTeamworkBillDate}.` };
  });
}

export async function cancelSubscriptionAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await cancelProviderSubscription(db, v, { membershipId: s(fd, "membershipId"), reason: s(fd, "reason"), requestedOn: s(fd, "requestedOn") || todayLocal(), overrideReason: opt(fd, "overrideReason") });
    return { ok: true, message: r.immediate ? `Cancelled effective ${r.cancelAt}.` : `Subscription cancelled at period end; membership ends ${r.cancelAt}.` };
  });
}

export async function cutoverAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => cutoverMembership(tx, v, { membershipId: s(fd, "membershipId"), firstBillDate: s(fd, "firstBillDate"), zenPlannerStopped: fd.get("zpStopped") === "on", today: todayLocal() }));
    return { ok: true, message: "Membership now billed by Teamwork Hub from the chosen date." };
  });
}

export async function runRenewalsAction(_p: ActionState, _fd: FormData) {
  void _fd;
  return run(async () => {
    const v = await requireViewer();
    assertCan(v, "billing.manage");
    const r = await db.transaction((tx) => generateRenewals(tx, v.orgId, todayLocal()));
    return { ok: true, message: `Renewals run: ${r.invoicesCreated} invoice(s) created, ${r.deferredForHold} deferred for holds, ${r.skippedExternal} Zen Planner and ${r.skippedProviderBilled} provider-subscription membership(s) skipped, ${r.cancelled} ended.` };
  });
}

// --- Invoices & payments ---------------------------------------------------------

export async function createInvoiceAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const lines: LineInput[] = [];
    const today = todayLocal();
    for (let i = 0; i < 4; i++) {
      const productId = s(fd, `line${i}Product`);
      const desc = s(fd, `line${i}Desc`);
      const qty = Number(s(fd, `line${i}Qty`) || "1");
      const athleteId = opt(fd, `line${i}Athlete`) ?? opt(fd, "athleteId");
      if (productId) {
        const ver = await versionOn(db, productId, today);
        if (!ver) throw new UserError("That product has no price in effect today.");
        const [p] = await db.select().from(products).where(eq(products.id, productId));
        if (!p || p.orgId !== v.orgId) throw new UserError("Product not found.");
        if (p.kind === "recurring_membership") throw new UserError("Memberships are billed from the Memberships page.");
        const credits = ver.creditsPerPeriod && p.kind !== "retail" && p.kind !== "camp" ? ver.creditsPerPeriod : null;
        if (credits && !athleteId) throw new UserError(`${p.name} grants credits — choose the athlete.`);
        lines.push({ description: desc || p.name, quantity: qty, unitAmountMinor: ver.priceMinor, productVersionId: ver.id, athleteId, entitlement: credits ? { credits, creditExpiryDays: ver.creditExpiryDays ?? undefined, serviceTypeIds: ver.serviceTypeIds } : null });
      } else if (desc) {
        lines.push({ description: desc, quantity: qty, unitAmountMinor: money(fd, `line${i}Amount`, "the line amount"), athleteId });
      }
    }
    const r = await db.transaction((tx) =>
      createManualInvoice(tx, v, {
        payerAccountId: s(fd, "payerAccountId"),
        lines,
        status: fd.get("draft") === "on" ? "draft" : "open",
        dueDate: opt(fd, "dueDate"),
        memo: opt(fd, "memo"),
        discountMinor: money(fd, "discount", "the discount", false),
      }),
    );
    redirect(`/billing/invoices/${r.invoice.id}`);
  });
}

export async function issueInvoiceAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => issueInvoice(tx, v, s(fd, "invoiceId")));
    return { ok: true, message: "Invoice issued." };
  });
}

export async function voidInvoiceAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => voidInvoice(tx, v, s(fd, "invoiceId"), s(fd, "reason")));
    return { ok: true, message: "Invoice voided." };
  });
}

export async function uncollectibleAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => markUncollectible(tx, v, s(fd, "invoiceId"), s(fd, "reason")));
    return { ok: true, message: "Marked uncollectible." };
  });
}

export async function recordPaymentAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) =>
      recordManualPayment(tx, v, { invoiceId: s(fd, "invoiceId"), amountMinor: money(fd, "amount", "the amount"), method: s(fd, "method") as ManualMethod, reference: s(fd, "reference"), notes: opt(fd, "notes") }),
    );
    return { ok: true, message: r.invoicePaid ? "Payment recorded (staff attested). Invoice paid." : "Partial payment recorded (staff attested)." };
  });
}

export async function startCheckoutAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let url: string | null = null;
  const res = await run(async () => {
    const v = await requireViewer();
    const r = await startCheckout(db, v, { invoiceId: s(fd, "invoiceId"), provider: s(fd, "provider") as ProviderName, appUrl: env().APP_URL });
    if (!r.ok) return { ok: false, error: r.error, data: r.notConfigured ? { notConfigured: r.notConfigured } : undefined };
    url = r.checkoutUrl;
  });
  if (url) redirect(url);
  return res;
}

export async function refundAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await requestRefund(db, v, {
      transactionId: s(fd, "transactionId"),
      amountMinor: money(fd, "amount", "the refund amount"),
      reason: s(fd, "reason"),
      offline: fd.get("offline") === "on",
      reference: opt(fd, "reference"),
    });
    if (r.status === "blocked_config" || r.status === "failed") return { ok: false, error: r.message };
    return { ok: true, message: r.message };
  });
}

// --- POS -------------------------------------------------------------------------

export async function posSaleAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const items: { productId: string; quantity: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const pid = s(fd, `item${i}`);
      const q = Number(s(fd, `qty${i}`) || "0");
      if (pid && q > 0) items.push({ productId: pid, quantity: q });
    }
    const [athleteId, payerFromAthlete] = s(fd, "athletePayer").split(":");
    const payment = s(fd, "paymentKind") === "invoice" ? ({ kind: "invoice" } as const) : ({ kind: "manual", method: s(fd, "method") as ManualMethod, reference: s(fd, "reference") } as const);
    const r = await db.transaction((tx) =>
      quickSale(tx, v, { payerAccountId: payerFromAthlete || opt(fd, "payerAccountId"), athleteId: athleteId || null, items, payment, today: todayLocal() }),
    );
    if (payment.kind === "invoice") redirect(`/billing/invoices/${r.invoice.id}`);
    return { ok: true, message: `Sale ${r.invoice.number} recorded${r.paid ? " and paid (staff attested)" : ""}.`, data: { invoiceId: r.invoice.id } };
  });
}

export async function stockAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const reason = s(fd, "reason") as "receive" | "adjust" | "return";
    await db.transaction((tx) => adjustStock(tx, v, { productId: s(fd, "productId"), delta: Number(s(fd, "delta")), reason, note: opt(fd, "note") }));
    return { ok: true, message: "Stock updated." };
  });
}
