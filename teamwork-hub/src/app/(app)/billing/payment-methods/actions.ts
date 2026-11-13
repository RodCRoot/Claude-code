"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { unpaidAutopayBills } from "@/lib/billing/autopay";
import { removeMethod, setDefaultMethod, setMembershipAutopay, startMethodSetup } from "@/lib/billing/payment-methods";
import { formatMoney } from "@/lib/money";
import { env } from "@/lib/env";

async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) {
    revalidatePath("/billing", "layout");
  }
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Evidence recorded with a bank debit authorization (same convention as form signatures). */
async function evidence() {
  const h = await headers();
  return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null, userAgent: h.get("user-agent")?.slice(0, 500) ?? null };
}

/** Send the payer to the Stripe-hosted page to save a card or bank account. Nothing is saved by this redirect. */
export async function startMethodSetupAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let url: string | null = null;
  const res = await run(async () => {
    const v = await requireViewer();
    const type = s(fd, "type") === "us_bank_account" ? "us_bank_account" : "card";
    const r = await startMethodSetup(db, v, {
      payerAccountId: s(fd, "payerAccountId"),
      type,
      mandateAccepted: fd.get("mandateAccepted") === "on",
      evidence: await evidence(),
      appUrl: env().APP_URL,
      signupFlowId: s(fd, "signupFlowId") || null,
      makeDefault: fd.get("makeDefault") === "on",
    });
    if (!r.ok) return { ok: false, error: r.error, data: r.notConfigured ? { notConfigured: r.notConfigured } : undefined };
    url = r.checkoutUrl;
  });
  if (url) redirect(url);
  return res;
}

export async function setDefaultMethodAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    await db.transaction((tx) => setDefaultMethod(tx, v, s(fd, "methodId")));
    return { ok: true, message: "Default payment method updated." };
  });
}

export async function removeMethodAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const r = await removeMethod(db, v, { methodId: s(fd, "methodId"), replacementMethodId: s(fd, "replacementMethodId") || null });
    return { ok: true, message: r.detachedAtProvider ? "Payment method removed." : "Payment method removed here. Stripe is not connected, so ask the front desk to confirm it is removed there too." };
  });
}

export async function setAutopayAction(_p: ActionState, fd: FormData) {
  return run(async () => {
    const v = await requireViewer();
    const on = s(fd, "autopay") === "on";
    const membershipId = s(fd, "membershipId");
    await db.transaction((tx) => setMembershipAutopay(tx, v, { membershipId, autopay: on, methodId: s(fd, "methodId") || null }));
    if (!on) return { ok: true, message: "Autopay is off. Each bill is paid with Pay Now or at the front desk." };
    // Bills that already exist are not charged by switching autopay on: say so, and the page lists them with a way to charge each now.
    const unpaid = await unpaidAutopayBills(db, v, membershipId);
    const total = unpaid.reduce((sum, b) => sum + b.balanceMinor, 0);
    return {
      ok: true,
      message: unpaid.length
        ? `Autopay is on for new bills. ${unpaid.length === 1 ? `Bill ${unpaid[0].number}` : `${unpaid.length} bills`} (${formatMoney(total, unpaid[0].currency)}) already existed and ${unpaid.length === 1 ? "was" : "were"} not charged: see the notice on this page to charge ${unpaid.length === 1 ? "it" : "them"} now.`
        : "Autopay is on. Each bill will be charged automatically on its due date.",
    };
  });
}
