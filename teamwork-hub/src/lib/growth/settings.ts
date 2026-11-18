import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations, type RewardKind } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/billing/errors";
import { parseMoneyToMinor } from "@/lib/money";

/**
 * Growth settings, stored in `organizations.settings.growth`.
 *
 * Nothing here is a price or a policy the app made up: the referral program starts OFF with no
 * reward, and every amount is entered by an owner/admin in Settings → Growth. The offer
 * thresholds below are operating defaults (when a hint is worth showing), not prices, and each
 * one is editable.
 */
export type RewardSpec = {
  /** "none" = no automatic reward; staff handle any thank-you by hand. */
  type: "none" | RewardKind;
  amountMinor: number | null;
  credits: number | null;
  creditExpiryDays: number | null;
};

export type GrowthSettings = {
  referral: {
    enabled: boolean;
    reward: RewardSpec;
    /**
     * Legacy "reward for the referred family" (pending, staff-approved at earn time). No longer
     * offered in Settings: the new family's reward is `newFamilyDiscountMinor`. Still honoured if
     * an organization has one saved and no discount set.
     */
    referredReward: RewardSpec;
    /**
     * Owner decision 2026-11-11: money off the referred family's FIRST invoice, in minor units.
     * Null = off (the default in a real organization). Applied automatically as an invoice
     * discount; see `applyNewFamilyDiscounts` in referrals.ts for the exact rules.
     */
    newFamilyDiscountMinor: number | null;
    earnedWhen: "first_paid_invoice" | "days_active";
    /** Only with earnedWhen = days_active. */
    daysActive: number | null;
    /** The referred family must have no earlier membership here. */
    requireNewFamily: boolean;
    blockSameHousehold: boolean;
    /** "How it works" text shown to families on /refer. */
    howItWorks: string;
    /** The text above is still placeholder wording (see src/lib/sample-text.ts). Cleared by an owner in Settings. */
    howItWorksIsSample: boolean;
  };
  offers: {
    /** Turn every family-facing suggestion off (staff still see opportunities). */
    familyFacing: boolean;
    /** "Not now" hides a suggestion for this many days. */
    dismissalDays: number;
    /** Purchased credits at or below this count suggest a renewal. */
    lowCreditsThreshold: number;
    creditsExpiringDays: number;
    /** Months on a month-to-month plan before commitment savings are shown. */
    monthToMonthMonths: number;
    /** Months without a baseline test before an assessment is suggested. */
    assessmentMonths: number;
    inSeasonEndingDays: number;
  };
};

const NO_REWARD: RewardSpec = { type: "none", amountMinor: null, credits: null, creditExpiryDays: null };

export const DEFAULT_GROWTH: GrowthSettings = {
  referral: {
    enabled: false,
    reward: NO_REWARD,
    referredReward: NO_REWARD,
    newFamilyDiscountMinor: null,
    earnedWhen: "first_paid_invoice",
    daysActive: null,
    requireNewFamily: true,
    blockSameHousehold: true,
    howItWorks: "",
    howItWorksIsSample: false,
  },
  offers: {
    familyFacing: true,
    dismissalDays: 30,
    lowCreditsThreshold: 2,
    creditsExpiringDays: 14,
    monthToMonthMonths: 3,
    assessmentMonths: 6,
    inSeasonEndingDays: 21,
  },
};

export function growthFromSettings(settings: Record<string, unknown> | null | undefined): GrowthSettings {
  const g = (settings?.growth ?? {}) as { referral?: Partial<GrowthSettings["referral"]>; offers?: Partial<GrowthSettings["offers"]> };
  return {
    referral: {
      ...DEFAULT_GROWTH.referral,
      ...(g.referral ?? {}),
      reward: { ...NO_REWARD, ...(g.referral?.reward ?? {}) },
      referredReward: { ...NO_REWARD, ...(g.referral?.referredReward ?? {}) },
    },
    offers: { ...DEFAULT_GROWTH.offers, ...(g.offers ?? {}) },
  };
}

export async function growthSettings(tx: Tx, orgId: string): Promise<GrowthSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return growthFromSettings(o?.settings);
}

/** Plain sentence describing a reward, or null when none is configured. Family-safe (no dashes). */
export function describeReward(r: RewardSpec, currency = "USD"): string | null {
  if (r.type === "account_credit" && r.amountMinor) {
    return `a ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(r.amountMinor / 100)} account credit`;
  }
  if (r.type === "session_credits" && r.credits) return `${r.credits} session credit${r.credits === 1 ? "" : "s"}`;
  return null;
}

/** "$50.00 off their first invoice", or null when no new-family discount is set. Family-safe. */
export function describeNewFamilyDiscount(amountMinor: number | null | undefined, currency = "USD"): string | null {
  if (!amountMinor || amountMinor <= 0) return null;
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100)} off their first invoice`;
}

/** The new family's side in plain words: the first-invoice discount, else a legacy reward, else null. */
export function describeReferredSide(r: GrowthSettings["referral"], currency = "USD"): string | null {
  return describeNewFamilyDiscount(r.newFamilyDiscountMinor, currency) ?? describeReward(r.referredReward, currency);
}

const s = (raw: Record<string, unknown>, k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
const on = (raw: Record<string, unknown>, k: string) => raw[k] === true || raw[k] === "on" || raw[k] === "true";

function parseReward(raw: Record<string, unknown>, prefix: string, errors: Record<string, string>): RewardSpec {
  const type = s(raw, `${prefix}Type`) || "none";
  if (type === "account_credit") {
    const amount = parseMoneyToMinor(s(raw, `${prefix}Amount`));
    if (amount == null || amount <= 0) errors[`${prefix}Amount`] = "Enter the credit amount, e.g. 25.00";
    return { type, amountMinor: amount ?? null, credits: null, creditExpiryDays: null };
  }
  if (type === "session_credits") {
    const credits = Number(s(raw, `${prefix}Credits`));
    if (!Number.isInteger(credits) || credits <= 0 || credits > 50) errors[`${prefix}Credits`] = "Enter a whole number of session credits";
    const expRaw = s(raw, `${prefix}CreditExpiryDays`);
    const exp = expRaw === "" ? null : Number(expRaw);
    if (exp != null && (!Number.isInteger(exp) || exp <= 0 || exp > 730)) errors[`${prefix}CreditExpiryDays`] = "Enter days until the credits expire, or leave empty";
    return { type, amountMinor: null, credits: Number.isInteger(credits) ? credits : null, creditExpiryDays: exp };
  }
  if (type !== "none") errors[`${prefix}Type`] = "Choose a reward type";
  return NO_REWARD;
}

function intIn(raw: Record<string, unknown>, k: string, min: number, max: number, errors: Record<string, string>): number {
  const n = Number(s(raw, k));
  if (!Number.isInteger(n) || n < min || n > max) {
    errors[k] = `Enter a whole number from ${min} to ${max}`;
    return min;
  }
  return n;
}

export function parseGrowthSettings(raw: Record<string, unknown>): { settings: GrowthSettings; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const earnedWhen = s(raw, "earnedWhen") === "days_active" ? ("days_active" as const) : ("first_paid_invoice" as const);
  const discountRaw = s(raw, "newFamilyDiscount");
  let newFamilyDiscountMinor: number | null = null;
  if (discountRaw !== "") {
    const amount = parseMoneyToMinor(discountRaw);
    if (amount == null || amount <= 0 || amount > 100_000_00) errors.newFamilyDiscount = "Enter the discount amount, e.g. 50.00, or leave it empty for none";
    else newFamilyDiscountMinor = amount;
  }
  const settings: GrowthSettings = {
    referral: {
      enabled: on(raw, "referralEnabled"),
      reward: parseReward(raw, "reward", errors),
      referredReward: parseReward(raw, "referredReward", errors),
      newFamilyDiscountMinor,
      earnedWhen,
      daysActive: earnedWhen === "days_active" ? intIn(raw, "daysActive", 1, 365, errors) : null,
      requireNewFamily: on(raw, "requireNewFamily"),
      blockSameHousehold: on(raw, "blockSameHousehold"),
      howItWorks: s(raw, "howItWorks").slice(0, 1200),
      howItWorksIsSample: on(raw, "howItWorksIsSample"),
    },
    offers: {
      familyFacing: on(raw, "familyFacing"),
      dismissalDays: intIn(raw, "dismissalDays", 1, 365, errors),
      lowCreditsThreshold: intIn(raw, "lowCreditsThreshold", 0, 20, errors),
      creditsExpiringDays: intIn(raw, "creditsExpiringDays", 1, 120, errors),
      monthToMonthMonths: intIn(raw, "monthToMonthMonths", 1, 36, errors),
      assessmentMonths: intIn(raw, "assessmentMonths", 1, 36, errors),
      inSeasonEndingDays: intIn(raw, "inSeasonEndingDays", 1, 90, errors),
    },
  };
  // Family-facing copy never carries em dashes.
  settings.referral.howItWorks = settings.referral.howItWorks.replace(/\s*[—―]\s*/g, ", ");
  return { settings, errors };
}

/** Owner/admin only (settings.manage). Audited with before/after. */
export async function saveGrowthSettings(tx: Tx, v: Viewer, raw: Record<string, unknown>) {
  assertCan(v, "settings.manage");
  const { settings, errors } = parseGrowthSettings(raw);
  if (Object.keys(errors).length) throw new UserError("Please fix the highlighted fields.", errors);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = growthFromSettings(org.settings);
  await tx.update(organizations).set({ settings: { ...org.settings, growth: settings } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "growth.settings_update", "organization", v.orgId, {
    summary: "Growth settings updated",
    before,
    after: settings,
  });
  return settings;
}
