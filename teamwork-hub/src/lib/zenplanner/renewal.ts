/**
 * What Zen Planner will do when an imported fixed-term membership reaches its end date, read from the Membership
 * grid's Months, Auto Renew and Renewal Type columns.
 *
 * Teamwork's member agreement: a fixed-term commitment (6 months, 12 months) rolls to month-to-month at the
 * committed rate when the term ends. It never renews into another fixed term. The hub applies that rule to the
 * memberships it bills itself (renewals.ts). Imported memberships are billed by Zen Planner, so the hub can only
 * point at the ones Zen Planner is set to renew the wrong way; it never changes, charges or schedules them.
 */
export type ZpRenewalOutcome =
  /** Not a fixed term (Months empty or 1), or Auto Renew is off: nothing renews into a term. */
  | "none"
  /** Fixed term, Auto Renew on, Renewal Type is month-to-month: what the agreement says. */
  | "month_to_month"
  /** Fixed term, Auto Renew on, Renewal Type is something else: it will start another fixed term. */
  | "fixed_term"
  /** Fixed term, Auto Renew on, but the export has no Renewal Type for it. */
  | "unknown";

export const RENEWS_INTO_FIXED_TERM_FLAG = "renews_into_fixed_term";
/** Zen Planner Installment Plan "Single Payment": a one-off purchase, not a recurring membership. */
export const SINGLE_PAYMENT_FLAG = "single_payment";

const MONTH_TO_MONTH = /month[\s-]*(to|2)[\s-]*month|^m2m$|^mtm$|^monthly$/i;

export function zpRenewalOutcome(input: { months: number | null; autoRenew: boolean | null; renewalType: string | null }): ZpRenewalOutcome {
  if (input.months == null || input.months <= 1 || input.autoRenew !== true) return "none";
  const type = input.renewalType?.trim() ?? "";
  if (!type) return "unknown";
  return MONTH_TO_MONTH.test(type) ? "month_to_month" : "fixed_term";
}
