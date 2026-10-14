import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";

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

type EditableKey = Exclude<keyof MembershipPolicy, "unconfirmed">;

/** Settings → Membership policy form metadata (labels shown to owners/admins). */
export const POLICY_FIELDS: { key: EditableKey; label: string; hint: string; kind: "int" | "bool" | "proration"; min?: number; max?: number }[] = [
  { key: "billingAnchorDay", label: "Billing day of month", hint: "Recurring monthly bills anchor to this day (policy: the 1st).", kind: "int", min: 1, max: 28 },
  { key: "prorationMethod", label: "First partial month (stub) pricing", hint: "How a mid-month start is priced up to the billing day.", kind: "proration" },
  { key: "cancellationNoticeDays", label: "Cancellation notice (days)", hint: "Written notice required; any channel is honored and recorded.", kind: "int", min: 0, max: 180 },
  { key: "holdMaxMonthsPerMembershipYear", label: "Hold cap (months per membership year)", hint: "Staff can override with a reason (audited).", kind: "int", min: 0, max: 12 },
  { key: "inSeasonMaxMonthsPer365Days", label: "In-season cap (months per rolling 365 days)", hint: "Applies to 12-month members. Override needs a reason.", kind: "int", min: 0, max: 12 },
  { key: "defaultHoldMonths", label: "Default hold length (months)", hint: "Suggested restart date when staff enter a hold.", kind: "int", min: 1, max: 12 },
  { key: "punchCardExpiryMonths", label: "Punch card expiry (months after issue)", hint: "Unused already-billed sessions from a hold become a punch card.", kind: "int", min: 1, max: 24 },
  { key: "makeupRequiresActiveMembership", label: "Makeup / punch-card sessions need an active membership", hint: "A 1x/week membership counts as active.", kind: "bool" },
  { key: "holdCreditEligibleCommitmentMonths", label: "Punch card eligibility: commitment (months)", hint: "Members on at least this commitment get a punch card automatically; others are a staff decision.", kind: "int", min: 0, max: 36 },
  { key: "commitmentRollsToMonthToMonth", label: "After a commitment ends, continue month-to-month at the committed rate", hint: "Never rolls silently into a new commitment.", kind: "bool" },
  { key: "familyDiscountPercent", label: "Family discount (%)", hint: "Applied to every active athlete on a payer account once 2 or more are enrolled.", kind: "int", min: 0, max: 100 },
  { key: "restartNudgeDaysBefore", label: "Restart nudge (days before a hold / in-season term ends)", hint: "Schedules the family message (if a rule is enabled) and a staff task.", kind: "int", min: 1, max: 60 },
  { key: "dormantAfterDays", label: "Flag billed members inactive for (days)", hint: "Used by the membership audit.", kind: "int", min: 1, max: 365 },
  { key: "attendanceGapDays", label: "Attendance gap reported after (days)", hint: "Used by the membership audit.", kind: "int", min: 1, max: 365 },
];

export const PRORATION_LABELS: Record<MembershipPolicy["prorationMethod"], string> = {
  teamwork_half_month: "Teamwork half-month rule (full / 50% / 25%)",
  daily: "Daily proration",
  weekly: "Weekly proration",
};

/** Validate a raw policy form (strings from FormData or numbers). Returns field errors by key. */
export function parseMembershipPolicy(raw: Record<string, unknown>, current: MembershipPolicy): { policy: MembershipPolicy; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = { ...current };
  for (const f of POLICY_FIELDS) {
    const v = raw[f.key];
    if (f.kind === "bool") {
      out[f.key] = v === true || v === "on" || v === "true";
      continue;
    }
    if (f.kind === "proration") {
      if (typeof v !== "string" || !(v in PRORATION_LABELS)) errors[f.key] = "Choose a stub pricing method.";
      else out[f.key] = v;
      continue;
    }
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
    else if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) errors[f.key] = `Must be ${f.min}–${f.max}.`;
    else out[f.key] = n;
  }
  const confirmed = new Set(Array.isArray(raw.confirm) ? (raw.confirm as string[]) : []);
  out.unconfirmed = current.unconfirmed.filter((k) => !confirmed.has(k));
  return { policy: out as MembershipPolicy, errors };
}

/** Owner/admin save of `organizations.settings.membershipPolicy` (audited, validated). */
export async function saveMembershipPolicy(tx: Tx, v: Viewer, raw: Record<string, unknown>) {
  assertCan(v, "settings.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = policyFromSettings(org.settings);
  const { policy, errors } = parseMembershipPolicy(raw, before);
  if (Object.keys(errors).length) return { ok: false as const, errors };
  const settings = { ...org.settings, membershipPolicy: policy };
  await tx.update(organizations).set({ settings }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.membership_policy_update", "organization", v.orgId, {
    summary: `Membership policy saved${before.unconfirmed.length !== policy.unconfirmed.length ? ` (confirmed: ${before.unconfirmed.filter((k) => !policy.unconfirmed.includes(k)).join(", ")})` : ""}`,
    before,
    after: policy,
  });
  return { ok: true as const, policy };
}

/** A "month" of hold / in-season time, in days, for cap checks (2 months = 62 days, so any two calendar months fit). */
export const CAP_DAYS_PER_MONTH = 31;

/** Notice that applies: the plan version's own notice when set, else the policy notice. */
export function effectiveNoticeDays(versionNoticeDays: number | null | undefined, policy: Pick<MembershipPolicy, "cancellationNoticeDays">) {
  return versionNoticeDays && versionNoticeDays > 0 ? versionNoticeDays : policy.cancellationNoticeDays;
}

/** Family-facing weekly cap message (no em dashes). */
export function weeklyCapMessage(athleteFirst: string, classesPerWeek: number, booked: number, weekStartYmd: string) {
  const [y, m, d] = weekStartYmd.split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${athleteFirst}'s ${classesPerWeek}x/week plan already has ${booked} session${booked === 1 ? "" : "s"} booked the week of ${label}.`;
}

/** First-period ("stub") price for a mid-month start, before discounts. Pure; documented in Settings. */
export function stubPriceMinor(monthlyMinor: number, startYmd: string, method: MembershipPolicy["prorationMethod"]): { amountMinor: number; coveredDays: number; daysInMonth: number; rule: string } {
  const [y, m, d] = startYmd.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const coveredDays = daysInMonth - d + 1;
  if (d === 1) return { amountMinor: monthlyMinor, coveredDays, daysInMonth, rule: "starts on the 1st: no stub" };
  return { ...partialPeriodPriceMinor(monthlyMinor, coveredDays, daysInMonth, method), coveredDays, daysInMonth };
}

/** Price for `coveredDays` of a `periodDays`-long monthly period under the policy method (used for stubs and short final periods). */
export function partialPeriodPriceMinor(monthlyMinor: number, coveredDays: number, periodDays: number, method: MembershipPolicy["prorationMethod"]): { amountMinor: number; rule: string } {
  if (coveredDays >= periodDays) return { amountMinor: monthlyMinor, rule: "full period" };
  if (method === "daily") return { amountMinor: Math.round((monthlyMinor * coveredDays) / periodDays), rule: `daily proration (${coveredDays}/${periodDays} days)` };
  if (method === "weekly") {
    const weeks = Math.ceil(coveredDays / 7);
    return { amountMinor: Math.min(monthlyMinor, Math.round((monthlyMinor * weeks) / (periodDays / 7))), rule: `weekly proration (${weeks} week(s))` };
  }
  const fraction = coveredDays > 22 ? 1 : coveredDays >= 8 ? 0.5 : 0.25;
  return { amountMinor: Math.round(monthlyMinor * fraction), rule: `Teamwork half-month rule (${fraction * 100}% for ${coveredDays} days)` };
}
