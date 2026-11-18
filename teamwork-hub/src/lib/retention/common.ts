import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { DEFAULT_TZ } from "@/lib/time";

/**
 * Retention thresholds, stored in `organizations.settings.retention`.
 *
 * Every default below is a STARTING POINT chosen so the radar is useful on day one. None is an
 * industry norm or a Teamwork policy; owners tune them in Settings → Retention radar.
 * (The "days since last visit" threshold is `attendanceGapDays` in the membership policy.)
 */
export type RetentionSettings = {
  /** Recent attendance window (days). */
  attendanceWindowDays: number;
  /** The athlete's own baseline: this many days immediately before the recent window. */
  baselineWindowDays: number;
  /** Flag when the recent weekly visit rate is at least this % below the athlete's own baseline. */
  attendanceDropPercent: number;
  /** Baseline visits needed before a drop can be judged. */
  minBaselineVisits: number;
  /** Window (days) for the no-show / late-cancel rate; compared with the same-length window before it. */
  noShowWindowDays: number;
  /** Flag when no-shows + late cancels are at least this % of resolved bookings in the window… */
  noShowRatePercent: number;
  /** …and there are at least this many misses, and the rate is higher than in the prior window. */
  noShowMinMisses: number;
  /** "No upcoming bookings" looks this many days ahead. */
  upcomingLookaheadDays: number;
  /** Card on file expires within this many days (or already expired). */
  cardExpiryDays: number;
  /** Failed payments are considered for this many days unless a later payment succeeded. */
  failedPaymentLookbackDays: number;
  /** Hold ends within this many days. */
  holdEndingDays: number;
  /** A hold ended within this many days and the athlete has not attended since. */
  holdRestartDays: number;
  /** Commitment ends within this many days. */
  commitmentEndingDays: number;
  /** In Season term ends within this many days. */
  inSeasonEndingDays: number;
  /** Ratings at or below this create a follow-up task and a radar signal. */
  lowRatingThreshold: number;
  /** A rating at or below this WITH a comment counts as a negative comment. */
  negativeCommentMaxRating: number;
  /** Feedback is considered by the radar for this many days. */
  feedbackLookbackDays: number;
  /** Families can leave feedback for this many days after the session. */
  feedbackEntryDays: number;
  /** A coach sees an average only when it has at least this many responses (protects who-said-what). */
  anonymityMinResponses: number;
  /** Expected visits by day 30 / 60 / 90 of a first membership (capped by the plan's weekly allowance). */
  onboardingVisits30: number;
  onboardingVisits60: number;
  onboardingVisits90: number;
  /** This many "watch"-weight signals together make a member "at risk" (any "high" signal does alone). */
  signalsForAtRisk: number;
};

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  attendanceWindowDays: 28,
  baselineWindowDays: 56,
  attendanceDropPercent: 40,
  minBaselineVisits: 4,
  noShowWindowDays: 28,
  noShowRatePercent: 30,
  noShowMinMisses: 2,
  upcomingLookaheadDays: 14,
  cardExpiryDays: 30,
  failedPaymentLookbackDays: 60,
  holdEndingDays: 14,
  holdRestartDays: 21,
  commitmentEndingDays: 45,
  inSeasonEndingDays: 21,
  lowRatingThreshold: 2,
  negativeCommentMaxRating: 3,
  feedbackLookbackDays: 30,
  feedbackEntryDays: 14,
  anonymityMinResponses: 3,
  onboardingVisits30: 3,
  onboardingVisits60: 6,
  onboardingVisits90: 9,
  signalsForAtRisk: 2,
};

export const RETENTION_FIELDS: { key: keyof RetentionSettings; label: string; hint: string; min: number; max: number; group: "Attendance" | "Billing & terms" | "Feedback" | "Onboarding" | "Risk level" }[] = [
  { key: "attendanceWindowDays", label: "Recent attendance window (days)", hint: "Visits in this window are compared with the athlete's own baseline.", min: 7, max: 90, group: "Attendance" },
  { key: "baselineWindowDays", label: "Baseline window (days)", hint: "The days immediately before the recent window.", min: 14, max: 365, group: "Attendance" },
  { key: "attendanceDropPercent", label: "Attendance drop (%)", hint: "Flag when visits per week fall at least this far below the athlete's own baseline.", min: 5, max: 100, group: "Attendance" },
  { key: "minBaselineVisits", label: "Baseline visits needed", hint: "Athletes with fewer baseline visits are not judged for a drop.", min: 1, max: 60, group: "Attendance" },
  { key: "noShowWindowDays", label: "No-show window (days)", hint: "Compared with the same number of days before it.", min: 7, max: 90, group: "Attendance" },
  { key: "noShowRatePercent", label: "No-show / late-cancel rate (%)", hint: "Share of resolved bookings in the window.", min: 5, max: 100, group: "Attendance" },
  { key: "noShowMinMisses", label: "Minimum misses", hint: "At least this many no-shows or late cancels before the rate counts.", min: 1, max: 20, group: "Attendance" },
  { key: "upcomingLookaheadDays", label: "No upcoming bookings (days ahead)", hint: "Flag when nothing is booked in this many days.", min: 1, max: 60, group: "Attendance" },
  { key: "cardExpiryDays", label: "Card expiring within (days)", hint: "The default card on file.", min: 0, max: 120, group: "Billing & terms" },
  { key: "failedPaymentLookbackDays", label: "Failed payment look-back (days)", hint: "Ignored once a later payment succeeds.", min: 7, max: 180, group: "Billing & terms" },
  { key: "holdEndingDays", label: "Hold ending within (days)", hint: "", min: 1, max: 90, group: "Billing & terms" },
  { key: "holdRestartDays", label: "Restarted and not back within (days)", hint: "A hold ended this recently and no visit since.", min: 1, max: 90, group: "Billing & terms" },
  { key: "commitmentEndingDays", label: "Commitment ending within (days)", hint: "", min: 1, max: 180, group: "Billing & terms" },
  { key: "inSeasonEndingDays", label: "In Season term ending within (days)", hint: "", min: 1, max: 90, group: "Billing & terms" },
  { key: "lowRatingThreshold", label: "Low rating (at or below)", hint: "Creates a staff follow-up task and a radar signal.", min: 1, max: 4, group: "Feedback" },
  { key: "negativeCommentMaxRating", label: "Negative comment (rating at or below, with a comment)", hint: "A comment left with a rating this low counts as negative. Comments are never analysed by a model.", min: 1, max: 4, group: "Feedback" },
  { key: "feedbackLookbackDays", label: "Feedback considered for (days)", hint: "", min: 7, max: 180, group: "Feedback" },
  { key: "feedbackEntryDays", label: "Families can rate a session for (days)", hint: "After the session ends.", min: 1, max: 60, group: "Feedback" },
  { key: "anonymityMinResponses", label: "Coach sees an average from (responses)", hint: "Below this a coach sees 'not enough responses', so a single family is never identifiable.", min: 2, max: 20, group: "Feedback" },
  { key: "onboardingVisits30", label: "Expected visits by day 30", hint: "New members only; capped by the plan's weekly allowance.", min: 1, max: 30, group: "Onboarding" },
  { key: "onboardingVisits60", label: "Expected visits by day 60", hint: "", min: 1, max: 60, group: "Onboarding" },
  { key: "onboardingVisits90", label: "Expected visits by day 90", hint: "", min: 1, max: 90, group: "Onboarding" },
  { key: "signalsForAtRisk", label: "Watch signals that make a member at risk", hint: "Any single high-weight signal is at risk on its own.", min: 2, max: 10, group: "Risk level" },
];

export function retentionSettingsFrom(settings: Record<string, unknown> | null | undefined): RetentionSettings {
  const saved = (settings?.retention ?? {}) as Partial<RetentionSettings>;
  const out = { ...DEFAULT_RETENTION_SETTINGS };
  for (const f of RETENTION_FIELDS) {
    const v = saved[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max) out[f.key] = v;
  }
  return out;
}

export async function retentionContext(tx: Tx, orgId: string): Promise<{ settings: RetentionSettings; tz: string; orgSettings: Record<string, unknown>; currency: string }> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone, currency: organizations.currency }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: retentionSettingsFrom(o?.settings), tz: o?.tz ?? DEFAULT_TZ, orgSettings: o?.settings ?? {}, currency: o?.currency ?? "USD" };
}

export function parseRetentionSettings(raw: Record<string, unknown>, current: RetentionSettings): { settings: RetentionSettings; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out = { ...current };
  for (const f of RETENTION_FIELDS) {
    const v = raw[f.key];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
    else if (n < f.min || n > f.max) errors[f.key] = `Must be ${f.min}–${f.max}.`;
    else out[f.key] = n;
  }
  if (!errors.onboardingVisits60 && !errors.onboardingVisits30 && out.onboardingVisits60 < out.onboardingVisits30) errors.onboardingVisits60 = "Must be at least the day-30 number.";
  if (!errors.onboardingVisits90 && !errors.onboardingVisits60 && out.onboardingVisits90 < out.onboardingVisits60) errors.onboardingVisits90 = "Must be at least the day-60 number.";
  if (!errors.negativeCommentMaxRating && !errors.lowRatingThreshold && out.negativeCommentMaxRating < out.lowRatingThreshold) errors.negativeCommentMaxRating = "Must be at least the low-rating threshold.";
  return { settings: out, errors };
}

/** Owner/admin save of `organizations.settings.retention` (validated, audited). */
export async function saveRetentionSettings(tx: Tx, v: Viewer, raw: Record<string, unknown>) {
  assertCan(v, "settings.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = retentionSettingsFrom(org.settings);
  const { settings, errors } = parseRetentionSettings(raw, before);
  if (Object.keys(errors).length) return { ok: false as const, errors };
  await tx.update(organizations).set({ settings: { ...org.settings, retention: settings } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.retention_settings_update", "organization", v.orgId, { summary: "Retention thresholds saved", before, after: settings });
  return { ok: true as const, settings };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "watch" | "at_risk";
export const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", watch: "Watch", at_risk: "At risk" };

export const SIGNALS = {
  attendance_gap: { label: "No recent visit", weight: "high" },
  attendance_drop: { label: "Attendance drop", weight: "medium" },
  no_show_rate: { label: "No-shows rising", weight: "medium" },
  no_upcoming: { label: "Nothing booked", weight: "medium" },
  payment_failed: { label: "Payment failed / past due", weight: "high" },
  card_expiring: { label: "Card needs updating", weight: "medium" },
  hold_ending: { label: "Hold ending soon", weight: "medium" },
  hold_restart: { label: "Restarted, not back yet", weight: "medium" },
  commitment_ending: { label: "Commitment ending", weight: "medium" },
  in_season_ending: { label: "In Season term ending", weight: "medium" },
  open_request: { label: "Open member request", weight: "medium" },
  cancel_requested: { label: "Cancel requested", weight: "high" },
  low_feedback: { label: "Low session feedback", weight: "medium" },
  onboarding: { label: "Onboarding: few visits", weight: "medium" },
  missing_forms: { label: "Forms block booking", weight: "medium" },
} as const satisfies Record<string, { label: string; weight: "high" | "medium" }>;
export type SignalKey = keyof typeof SIGNALS;
export const SIGNAL_KEYS = Object.keys(SIGNALS) as SignalKey[];
/** Signals built from billing data: hidden from viewers without billing access (coaches). */
export const BILLING_SIGNALS: SignalKey[] = ["payment_failed", "card_expiring"];

export const RETENTION_ACTION_KINDS = [
  { key: "called", label: "Called parent / athlete" },
  { key: "messaged", label: "Sent a message" },
  { key: "offered_makeup", label: "Offered a makeup session" },
  { key: "goal_review", label: "Held a goal review" },
  { key: "card_update_request", label: "Asked for a card update" },
  { key: "plan_change", label: "Changed plan / offered hold" },
  { key: "in_person", label: "Talked in person" },
  { key: "other", label: "Other" },
] as const;
export const actionLabel = (k: string) => RETENTION_ACTION_KINDS.find((a) => a.key === k)?.label ?? k;

export const LOSS_REASONS = [
  { key: "schedule", label: "Schedule / time conflict" },
  { key: "sport_season", label: "Sport season" },
  { key: "cost", label: "Cost" },
  { key: "moved", label: "Moved away" },
  { key: "injury", label: "Injury / medical" },
  { key: "experience", label: "Unhappy with experience" },
  { key: "graduated", label: "Graduated / aged out" },
  { key: "other_gym", label: "Went elsewhere" },
  { key: "payment", label: "Payment problem" },
  { key: "unknown", label: "No reason given" },
  { key: "other", label: "Other" },
] as const;
export const reasonLabel = (k: string | null | undefined) => (k ? (LOSS_REASONS.find((r) => r.key === k)?.label ?? k) : "—");

export const OUTCOME_LABEL = { saved: "Saved", still_at_risk: "Still at risk", lost: "Lost" } as const;

/** Whole months between two local dates (floor), never negative. */
export function tenureMonths(startYmd: string, endYmd: string): number {
  const [y1, m1, d1] = startYmd.split("-").map(Number);
  const [y2, m2, d2] = endYmd.split("-").map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

export function tenureLabel(months: number): string {
  if (months < 1) return "under 1 month";
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} yr${y === 1 ? "" : "s"}${m ? ` ${m} mo` : ""}`;
}
