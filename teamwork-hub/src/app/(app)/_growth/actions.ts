"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { UserError as BillingUserError } from "@/lib/billing/errors";
import { acceptOffer, createOfferTask, dismissOffer, isOfferKey } from "@/lib/growth/offers";
import { issueTrialPass } from "@/lib/growth/passes";
import { applyAccountCredit, approveReward, attachReferralByStaff, declineReward, revokeReferralCode } from "@/lib/growth/referrals";
import { saveGrowthSettings } from "@/lib/growth/settings";
import { setShopListing, shopCheckout } from "@/lib/growth/shop";
import { parseMoneyToMinor } from "@/lib/money";
import { todayLocal } from "@/lib/time";

/** Runs a growth mutation: domain errors become form state; the listed paths are revalidated. */
async function run(paths: string[], fn: () => Promise<ActionState | void>): Promise<ActionState> {
  const res = await safeAction(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingUserError) throw new UserError(e.message, e.fieldErrors);
      throw e;
    }
  })();
  if (res.ok) for (const p of paths) revalidatePath(p, "layout");
  return res;
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

// --- Settings ---------------------------------------------------------------------------------

export async function saveGrowthSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/settings/growth", "/refer", "/shop"], async () => {
    const v = await requireViewer();
    const raw: Record<string, unknown> = {};
    for (const [k, val] of fd.entries()) if (typeof val === "string") raw[k] = val;
    await db.transaction((tx) => saveGrowthSettings(tx, v, raw));
    return { ok: true, message: "Growth settings saved." };
  });
}

// --- Referrals --------------------------------------------------------------------------------

export async function approveRewardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/referrals", "/refer"], async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => approveReward(tx, v, { rewardId: s(fd, "rewardId"), athleteId: s(fd, "athleteId") || null }));
    return { ok: true, message: r.alreadyApproved ? "This reward was already approved." : "Reward approved and issued." };
  });
}

export async function declineRewardAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/referrals"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) => declineReward(tx, v, { rewardId: s(fd, "rewardId"), reason: s(fd, "reason") }));
    return { ok: true, message: "Reward declined." };
  });
}

export async function applyAccountCreditAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/referrals", "/billing"], async () => {
    const v = await requireViewer();
    const amount = parseMoneyToMinor(s(fd, "amount"));
    if (amount == null) throw new UserError("Enter the amount as dollars and cents, e.g. 25.00", { amount: "Invalid amount" });
    await db.transaction((tx) => applyAccountCredit(tx, v, { invoiceId: s(fd, "invoiceId"), amountMinor: amount, idempotencyKey: s(fd, "key") }));
    return { ok: true, message: "Credit applied to the invoice." };
  });
}

export async function attachReferralAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/leads", "/people/referrals"], async () => {
    const v = await requireViewer();
    const res = await db.transaction((tx) => attachReferralByStaff(tx, v, { leadId: s(fd, "leadId"), code: s(fd, "code") }));
    return { ok: true, message: res.attributed ? "Referral attached." : "Code recorded, but the referral does not count. See the reason below." };
  });
}

export async function revokeReferralCodeAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/referrals", "/refer"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) => revokeReferralCode(tx, v, s(fd, "codeId")));
    return { ok: true, message: "Code revoked. The family has a new link." };
  });
}

// --- Trial passes -----------------------------------------------------------------------------

export async function issueTrialPassAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/people/leads"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) =>
      issueTrialPass(tx, v, { leadId: s(fd, "leadId"), credits: Number(s(fd, "credits")), expiresInDays: Number(s(fd, "expiresInDays")), reason: s(fd, "reason"), idempotencyKey: s(fd, "key") }),
    );
    return { ok: true, message: "Trial pass issued." };
  });
}

// --- Shop -------------------------------------------------------------------------------------

export async function setShopListingAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/billing/products", "/shop"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) => setShopListing(tx, v, { productId: s(fd, "productId"), sellableOnline: fd.get("sellableOnline") === "on", includes: s(fd, "includes") }));
    return { ok: true, message: "Saved." };
  });
}

export async function shopCheckoutAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let invoiceId: string | null = null;
  const res = await run(["/shop", "/billing"], async () => {
    const v = await requireViewer();
    const athleteId = s(fd, "athleteId");
    if (!athleteId) throw new UserError("Choose who this is for.", { athleteId: "Choose an athlete" });
    const r = await db.transaction((tx) => shopCheckout(tx, v, { productId: s(fd, "productId"), athleteId, idempotencyKey: s(fd, "key"), today: todayLocal() }));
    invoiceId = r.invoiceId;
  });
  if (res.ok && invoiceId) redirect(`/shop/order/${invoiceId}`);
  return res;
}

// --- Suggestions ------------------------------------------------------------------------------

export async function dismissOfferAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/shop", "/billing"], async () => {
    const v = await requireViewer();
    await db.transaction((tx) => dismissOffer(tx, v, { athleteId: s(fd, "athleteId"), offerKey: s(fd, "offerKey"), today: todayLocal() }));
    return { ok: true };
  });
}

export async function acceptOfferAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  let href: string | null = null;
  const res = await run([], async () => {
    const v = await requireViewer();
    const r = await db.transaction((tx) => acceptOffer(tx, v, { athleteId: s(fd, "athleteId"), offerKey: s(fd, "offerKey"), today: todayLocal() }));
    href = r.href;
  });
  if (res.ok && href) redirect(href);
  return res;
}

export async function createOfferTaskAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(["/billing/opportunities", "/people"], async () => {
    const v = await requireViewer();
    const key = s(fd, "offerKey");
    if (!isOfferKey(key)) throw new UserError("Unknown opportunity.");
    const r = await db.transaction((tx) => createOfferTask(tx, v, { athleteId: s(fd, "athleteId"), offerKey: key, today: todayLocal() }));
    return { ok: true, message: r.created ? "Task created in People → Tasks." : "A task for this already exists this month." };
  });
}
