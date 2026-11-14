import { autopaySettingsOf } from "@/lib/billing/autopay-settings";
import { growthFromSettings } from "@/lib/growth/settings";
import { policyFromSettings } from "@/lib/membership-policy";
import { newsSettingsOf } from "@/lib/newswatch/shared";
import { policiesOf } from "@/lib/settings";

/**
 * Open decisions that map to a setting.
 *
 * DECISIONS.md is prose for people; nothing reads it at runtime. This list is the structured
 * source the go-live page shows: each entry names the question, what the hub does today, where to
 * change it, and how to read the current value out of `organizations.settings`. Decisions that are
 * not a setting (code changes, wording, provider choices) stay in DECISIONS.md only.
 *
 * When DECISIONS.md gains or loses a settings-backed question, change this list in the same commit.
 */
export type OpenDecision = {
  id: string;
  /** Section and number in DECISIONS.md, for the person maintaining the list. */
  ref: string;
  question: string;
  currentBehaviour: string;
  /** Page where the setting is changed. */
  changeHref: string;
  changeLabel: string;
  /** The current value in plain words. Also stored when an owner confirms, to notice later changes. */
  value: (settings: Record<string, unknown> | null) => string;
};

const yesNo = (b: boolean) => (b ? "Yes" : "No");

export const OPEN_DECISIONS: OpenDecision[] = [
  {
    id: "family_discount_percent",
    ref: "Membership policy 1",
    question: "Is the family discount 10% or 15%?",
    currentBehaviour: "Every active athlete on a billing account gets this percent off once two or more are enrolled.",
    changeHref: "/settings",
    changeLabel: "Settings, Membership policy",
    value: (s) => `${policyFromSettings(s).familyDiscountPercent}%`,
  },
  {
    id: "cancellation_notice_days",
    ref: "Membership policy 10",
    question: "How much written notice does a cancellation need?",
    currentBehaviour: "A plan's own notice period wins over this number when the plan has one.",
    changeHref: "/settings",
    changeLabel: "Settings, Membership policy",
    value: (s) => `${policyFromSettings(s).cancellationNoticeDays} days`,
  },
  {
    id: "hold_cap_months",
    ref: "Membership policy 3 and 6",
    question: "How many months may a membership be on hold in a membership year?",
    currentBehaviour: "A hold does not extend the commitment end date. Two months is counted as 62 days. Staff can override with a reason.",
    changeHref: "/settings",
    changeLabel: "Settings, Membership policy",
    value: (s) => `${policyFromSettings(s).holdMaxMonthsPerMembershipYear} months`,
  },
  {
    id: "in_season_cap_months",
    ref: "Membership policy 4 and 5",
    question: "How many In Season months are allowed in a rolling year?",
    currentBehaviour: "In Season months count toward the commitment and the end date does not move. The cap applies to 12-month members only.",
    changeHref: "/settings",
    changeLabel: "Settings, Membership policy",
    value: (s) => `${policyFromSettings(s).inSeasonMaxMonthsPer365Days} months`,
  },
  {
    id: "makeup_needs_active_membership",
    ref: "Membership policy 8",
    question: "Do punch-card and makeup sessions need an active membership?",
    currentBehaviour: "A past-due membership does not count as active for punch-card use.",
    changeHref: "/settings",
    changeLabel: "Settings, Membership policy",
    value: (s) => yesNo(policyFromSettings(s).makeupRequiresActiveMembership),
  },
  {
    id: "pending_bank_payments",
    ref: "Settings, Security & payments policy",
    question: "Does a bank payment that has not settled yet unlock the membership or credits?",
    currentBehaviour: "Bank payments take days to settle and can still fail.",
    changeHref: "/settings",
    changeLabel: "Settings, Security & payments policy",
    value: (s) => (policiesOf(s).pendingBankPaymentPolicy === "grant_on_pending" ? "Granted right away, while pending" : "Granted only after the money settles"),
  },
  {
    id: "card_retry_schedule",
    ref: "Membership policy 9",
    question: "When is a declined card tried again, and how long after a returned bank debit?",
    currentBehaviour: "A generic decline is treated as worth retrying. The same saved method is charged again on these days.",
    changeHref: "/settings/payments",
    changeLabel: "Settings, Payments & agreements",
    value: (s) => {
      const a = autopaySettingsOf(s);
      return `Card: ${a.cardRetryDays.length ? `day ${a.cardRetryDays.join(", ")} after the failure` : "no retry"}. Bank: once, after ${a.achRetryWaitDays} days`;
    },
  },
  {
    id: "bank_pay_discount",
    ref: "Owner tools 7",
    question: "Is there a monthly discount for paying by bank account?",
    currentBehaviour: "Card surcharges are not built. A bank pay discount comes off each monthly bill when it is on.",
    changeHref: "/settings/payments",
    changeLabel: "Settings, Payments & agreements",
    value: (s) => {
      const b = autopaySettingsOf(s).bankPayDiscount;
      if (!b.enabled) return "Off";
      return b.kind === "percent" ? `${b.value}% off` : `$${(b.value / 100).toFixed(2)} off`;
    },
  },
  {
    id: "referral_earned_when",
    ref: "Athlete experience 4",
    question: "When has a referred family \"signed up\" for the referral reward?",
    currentBehaviour: "A discount larger than the new family's first invoice is not carried over to a later invoice.",
    changeHref: "/settings/growth",
    changeLabel: "Settings, Growth",
    value: (s) => {
      const r = growthFromSettings(s).referral;
      if (!r.enabled) return "Referral program is off";
      return r.earnedWhen === "days_active" ? `After ${r.daysActive ?? "?"} days active` : "When their first payment settles";
    },
  },
  {
    id: "news_clip_approvers",
    ref: "Decisions Rod has made, news clips",
    question: "Who may approve news clips besides the owner and admins?",
    currentBehaviour: "Nothing is shared until a person approves it.",
    changeHref: "/settings/newswatch",
    changeLabel: "Settings, News watch",
    value: (s) => {
      const n = newsSettingsOf(s);
      const extra = [n.operationsMayApprove ? "operations" : null, n.coachesMayApprove ? "coaches" : null].filter(Boolean);
      return extra.length ? `Owner, admins and ${extra.join(" and ")}` : "Owner and admins only";
    },
  },
];

export const decisionKey = (id: string) => `decision:${id}`;
