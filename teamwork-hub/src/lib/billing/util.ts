import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import type { AuditActor } from "@/lib/audit";

/** Postgres returns bigint/numeric aggregates as strings; money must come back as integer numbers. */
export function int(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`Expected integer money value, got ${String(v)}`);
  return n;
}

export function assertMinor(n: number, label = "amount") {
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer number of cents`);
}

export const actorOf = (v: Viewer | null, orgId?: string): AuditActor => ({
  orgId: v?.orgId ?? orgId ?? null,
  actorUserId: v?.userId ?? null,
  actorRole: v?.role ?? "system",
});

/** Add whole months to a YYYY-MM-DD date, clamping to the anchor day (e.g. Jan 31 + 1 month → Feb 28/29). */
export function addMonthsYmd(ymd: string, months: number, anchorDay?: number | null): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(ty, tm + 1, 0, 12)).getUTCDate();
  const day = Math.min(anchorDay ?? d, daysInMonth);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addIntervalYmd(ymd: string, interval: "none" | "week" | "month" | "year", count: number, anchorDay?: number | null): string {
  if (interval === "week") {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 7 * count, 12)).toISOString().slice(0, 10);
  }
  if (interval === "year") return addMonthsYmd(ymd, 12 * count, anchorDay);
  if (interval === "month") return addMonthsYmd(ymd, count, anchorDay);
  return ymd;
}

export type BillingSettings = {
  pendingBankPaymentPolicy: "grant_on_settlement" | "grant_on_pending";
  pendingAlertDays: number;
  invoicePrefix: string;
  invoiceDueDays: number;
};

/** Org-level billing policy. Defaults are conservative; values are configurable in org settings, never invented here. */
export async function billingSettings(tx: Tx, orgId: string): Promise<BillingSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const s = (o?.settings ?? {}) as Record<string, unknown>;
  return {
    pendingBankPaymentPolicy: s.pendingBankPaymentPolicy === "grant_on_pending" ? "grant_on_pending" : "grant_on_settlement",
    pendingAlertDays: typeof s.pendingAlertDays === "number" ? s.pendingAlertDays : 5,
    invoicePrefix: typeof s.invoicePrefix === "string" && s.invoicePrefix ? s.invoicePrefix : "TW-",
    invoiceDueDays: typeof s.invoiceDueDays === "number" ? s.invoiceDueDays : 7,
  };
}
