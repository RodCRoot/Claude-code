import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Teamwork membership policy, stored in `organizations.settings.membershipPolicy`.
 *
 * Provenance: defaults come from Rod's own documented operating procedures (his
 * hold-request, membership-hold, membership-status-check and add-membership
 * playbooks), not invented. Values marked `confirm` conflict between those
 * sources or are labeled "confirm before quoting" there; the Settings UI shows
 * them as needing confirmation until an owner saves them.
 */
export type MembershipPolicy = {
  /** Recurring bills anchor to this day of month (policy: the 1st). */
  billingAnchorDay: number;
  /**
   * First partial month for a mid-month start ("stub"): Teamwork's rule is half the
   * monthly price when the stub covers ~2 training weeks. Methods:
   * - teamwork_half_month: 50% when 8–22 days remain, full price above, 25% below (staff can override)
   * - daily: price × remainingDays / daysInMonth
   * - weekly: price × ceil(remainingDays / 7) / weeksInMonth
   */
  prorationMethod: "teamwork_half_month" | "daily" | "weekly";
  /** Written notice required to cancel (policy: 30 days, by email to memberships@). */
  cancellationNoticeDays: number;
  /** Max months on hold per membership year (policy: 2). */
  holdMaxMonthsPerMembershipYear: number;
  /** Max in-season months per rolling 365 days, 12-month members only (policy: 2). */
  inSeasonMaxMonthsPer365Days: number;
  /** Default hold length when the agreement applies (policy: 2 months). */
  defaultHoldMonths: number;
  /** Unused already-billed sessions become a punch card that expires this many months after issue (policy: 3). */
  punchCardExpiryMonths: number;
  /** Punch-card / makeup sessions require an active membership (policy: yes; 1x/week counts). */
  makeupRequiresActiveMembership: boolean;
  /** Hold-credit eligibility (policy: 12-month commitment and active; month-to-month is case by case). */
  holdCreditEligibleCommitmentMonths: number;
  /** After a commitment ends the membership continues month-to-month at the committed rate (agreement §5). */
  commitmentRollsToMonthToMonth: boolean;
  /** Sibling/family discount percent once 2+ athletes in a family are enrolled. `confirm`: 10% (hold playbook) vs "15% Off" (add-membership playbook). */
  familyDiscountPercent: number;
  /** Days before a hold / in-season term ends to nudge the family (playbooks say 1–2 weeks). */
  restartNudgeDaysBefore: number;
  /** Members inactive this many days while still billed are flagged in the audit. */
  dormantAfterDays: number;
  /** Gap (days) in attendance that the audit reports. */
  attendanceGapDays: number;
  /** Keys that still need an owner's confirmation. */
  unconfirmed: string[];
};

export const DEFAULT_MEMBERSHIP_POLICY: MembershipPolicy = {
  billingAnchorDay: 1,
  prorationMethod: "teamwork_half_month",
  cancellationNoticeDays: 30,
  holdMaxMonthsPerMembershipYear: 2,
  inSeasonMaxMonthsPer365Days: 2,
  defaultHoldMonths: 2,
  punchCardExpiryMonths: 3,
  makeupRequiresActiveMembership: true,
  holdCreditEligibleCommitmentMonths: 12,
  commitmentRollsToMonthToMonth: true,
  familyDiscountPercent: 10,
  restartNudgeDaysBefore: 14,
  dormantAfterDays: 30,
  attendanceGapDays: 21,
  unconfirmed: ["familyDiscountPercent"],
};

/**
 * Reference plan shapes from Rod's playbooks. Prices conflict between sources
 * (e.g. 1x/week $119 in-season vs $129 month-to-month; 2x/week $142 vs $232.99),
 * so they are seeded as SAMPLE versions for Rod to confirm, never as truth.
 */
export const REFERENCE_PLANS = [
  { key: "perf_1x_m2m", name: "Athlete/Adult Performance 1x per Week (Month to Month)", classesPerWeek: 1, commitmentMonths: 0, interval: "month" as const, referencePriceMinor: 12900 },
  { key: "perf_2x_m2m", name: "Athlete/Adult Performance 2x per Week (Month to Month)", classesPerWeek: 2, commitmentMonths: 0, interval: "month" as const, referencePriceMinor: 23299 },
  { key: "perf_3x_6mo", name: "Athlete/Adult Performance 3x per Week (6 Months)", classesPerWeek: 3, commitmentMonths: 6, interval: "month" as const, referencePriceMinor: 26199 },
  { key: "in_season_1x", name: "In Season 1x per Week", classesPerWeek: 1, commitmentMonths: 0, interval: "month" as const, referencePriceMinor: 11900, inSeason: true },
  { key: "college_break", name: "College Plan (breaks & summer, unlimited)", classesPerWeek: null, commitmentMonths: 0, interval: "week" as const, referencePriceMinor: 5000 },
] as const;

export function policyFromSettings(settings: Record<string, unknown> | null | undefined): MembershipPolicy {
  const saved = (settings?.membershipPolicy ?? {}) as Partial<MembershipPolicy>;
  return { ...DEFAULT_MEMBERSHIP_POLICY, ...saved };
}

export async function membershipPolicy(tx: Tx, orgId: string): Promise<MembershipPolicy> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return policyFromSettings(o?.settings);
}

/** First-period ("stub") price for a mid-month start, before discounts. Pure; documented in Settings. */
export function stubPriceMinor(monthlyMinor: number, startYmd: string, method: MembershipPolicy["prorationMethod"]): { amountMinor: number; coveredDays: number; daysInMonth: number; rule: string } {
  const [y, m, d] = startYmd.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const coveredDays = daysInMonth - d + 1;
  if (d === 1) return { amountMinor: monthlyMinor, coveredDays, daysInMonth, rule: "starts on the 1st: no stub" };
  if (method === "daily") return { amountMinor: Math.round((monthlyMinor * coveredDays) / daysInMonth), coveredDays, daysInMonth, rule: "daily proration" };
  if (method === "weekly") {
    const weeks = Math.ceil(coveredDays / 7);
    return { amountMinor: Math.round((monthlyMinor * weeks) / (daysInMonth / 7)), coveredDays, daysInMonth, rule: `weekly proration (${weeks} week(s))` };
  }
  const fraction = coveredDays > 22 ? 1 : coveredDays >= 8 ? 0.5 : 0.25;
  return { amountMinor: Math.round(monthlyMinor * fraction), coveredDays, daysInMonth, rule: `Teamwork half-month rule (${fraction * 100}% for ${coveredDays} days)` };
}
