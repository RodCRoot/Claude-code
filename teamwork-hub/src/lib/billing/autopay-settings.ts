import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "./errors";
import { actorOf } from "./util";

/** An owner-entered fee estimate for one method type. Never hardcoded: null until someone enters it. */
export type FeeEstimate = { percentBps: number; fixedMinor: number; capMinor: number | null };

export type AutopaySettings = {
  /** Days after a retryable CARD failure to try the same card again (one entry per retry). */
  cardRetryDays: number[];
  /** Days to wait before the single retry after a bank debit is returned for insufficient funds. */
  achRetryWaitDays: number;
  /** Optional discount on each monthly bill when the autopay method is a bank account. Off by default. */
  bankPayDiscount: { enabled: boolean; kind: "fixed" | "percent"; value: number };
  /** ESTIMATES the owner typed in from Stripe's pricing page, used only before real fee data exists. */
  feeEstimates: { card: FeeEstimate | null; us_bank_account: FeeEstimate | null };
  /** Keys still on their sample default (shown as "Needs confirmation"). */
  unconfirmed: string[];
};

/** Sample defaults: the retry timing is a starting point for the owner to confirm, not Teamwork policy. */
export const DEFAULT_AUTOPAY_SETTINGS: AutopaySettings = {
  cardRetryDays: [3, 7],
  achRetryWaitDays: 5,
  bankPayDiscount: { enabled: false, kind: "fixed", value: 0 },
  feeEstimates: { card: null, us_bank_account: null },
  unconfirmed: ["cardRetryDays", "achRetryWaitDays"],
};

const intIn = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

function estimateOf(v: unknown): FeeEstimate | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const percentBps = intIn(o.percentBps, 0, 10_000);
  const fixedMinor = intIn(o.fixedMinor, 0, 100_000);
  if (percentBps == null || fixedMinor == null) return null;
  return { percentBps, fixedMinor, capMinor: intIn(o.capMinor, 0, 10_000_000) };
}

export function autopaySettingsOf(settings: Record<string, unknown> | null | undefined): AutopaySettings {
  const raw = ((settings ?? {}) as Record<string, unknown>).autopay as Record<string, unknown> | undefined;
  const d = DEFAULT_AUTOPAY_SETTINGS;
  if (!raw || typeof raw !== "object") return d;
  const days = Array.isArray(raw.cardRetryDays) ? raw.cardRetryDays.map((x) => intIn(x, 1, 60)).filter((x): x is number => x != null).slice(0, 6) : null;
  const disc = (raw.bankPayDiscount ?? {}) as Record<string, unknown>;
  const kind = disc.kind === "percent" ? "percent" : "fixed";
  const value = intIn(disc.value, 0, kind === "percent" ? 100 : 1_000_000) ?? 0;
  const est = (raw.feeEstimates ?? {}) as Record<string, unknown>;
  return {
    cardRetryDays: days ?? d.cardRetryDays,
    achRetryWaitDays: intIn(raw.achRetryWaitDays, 1, 60) ?? d.achRetryWaitDays,
    bankPayDiscount: { enabled: disc.enabled === true && value > 0, kind, value },
    feeEstimates: { card: estimateOf(est.card), us_bank_account: estimateOf(est.us_bank_account) },
    unconfirmed: Array.isArray(raw.unconfirmed) ? raw.unconfirmed.filter((x): x is string => typeof x === "string") : d.unconfirmed,
  };
}

export async function autopaySettings(tx: Tx, orgId: string): Promise<AutopaySettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return autopaySettingsOf(o?.settings);
}

export async function saveAutopaySettings(tx: Tx, v: Viewer, next: Omit<AutopaySettings, "unconfirmed">) {
  assertCan(v, "settings.manage");
  if (next.cardRetryDays.some((d) => !Number.isInteger(d) || d < 1 || d > 60) || next.cardRetryDays.length > 6) throw new UserError("Card retry days must be whole numbers from 1 to 60 (up to 6 retries).", { cardRetryDays: "Use numbers like 3, 7" });
  if (!Number.isInteger(next.achRetryWaitDays) || next.achRetryWaitDays < 1 || next.achRetryWaitDays > 60) throw new UserError("The bank retry wait must be 1 to 60 days.", { achRetryWaitDays: "1 to 60" });
  const b = next.bankPayDiscount;
  if (!Number.isInteger(b.value) || b.value < 0 || (b.kind === "percent" && b.value > 100)) throw new UserError("Enter the bank pay discount as dollars and cents, or a whole percent up to 100.", { bankPayDiscountValue: "Check this amount" });
  if (b.enabled && b.value === 0) throw new UserError("Enter a discount amount before turning the bank pay discount on.", { bankPayDiscountValue: "Required" });
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = autopaySettingsOf(o?.settings);
  const after: AutopaySettings = { ...next, unconfirmed: [] };
  await tx.update(organizations).set({ settings: { ...(o?.settings ?? {}), autopay: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "billing.autopay_settings", "org", v.orgId, { summary: "Autopay, bank pay discount and fee estimate settings updated", before, after });
  return after;
}

/** Discount for one bill of `grossAfterOtherDiscounts` when paid by bank account. 0 when off. */
export function bankPayDiscountMinor(s: AutopaySettings, amountMinor: number): number {
  const b = s.bankPayDiscount;
  if (!b.enabled || amountMinor <= 0) return 0;
  const d = b.kind === "percent" ? Math.round((amountMinor * b.value) / 100) : b.value;
  return Math.max(0, Math.min(d, amountMinor));
}

export function estimateFeeMinor(e: FeeEstimate | null, amountMinor: number): number | null {
  if (!e) return null;
  const fee = Math.round((amountMinor * e.percentBps) / 10_000) + e.fixedMinor;
  return e.capMinor != null ? Math.min(fee, e.capMinor) : fee;
}
