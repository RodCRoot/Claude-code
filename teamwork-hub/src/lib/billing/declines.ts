/**
 * Provider decline reasons → what staff should do.
 * - card_needs_update: retrying the same card will not work (expired, closed/no account, suspected fraud,
 *   lost/stolen, wrong number). Ask the family to update the card (app first).
 * - retryable: a temporary condition (insufficient funds, processing error, issuer unavailable). Retry later.
 * - unknown: not recognised; staff decide.
 *
 * Codes cover Stripe card decline codes, Stripe ACH return reasons (account_closed, no_account, …) and
 * PayPal issue names. Matching is case-insensitive on the code, with a fallback on the message text.
 */
export type DeclineCategory = "card_needs_update" | "retryable" | "unknown";

const NEEDS_UPDATE = new Set([
  "expired_card",
  "card_expired",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_number",
  "invalid_number",
  "invalid_account",
  "invalid_account_number",
  "account_closed",
  "bank_account_closed",
  "no_account",
  "bank_account_unusable",
  "account_frozen",
  "debit_not_authorized",
  "bank_account_restricted",
  "fraudulent",
  "suspected_fraud",
  "merchant_blacklist",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "card_not_supported",
  "currency_not_supported",
  "new_account_information_available",
  "revocation_of_authorization",
  "stop_payment_order",
  "authentication_required",
  "incorrect_cvc",
  "invalid_cvc",
  "incorrect_zip",
  "do_not_try_again",
  // PayPal
  "instrument_declined",
  "payer_account_restricted",
  "payer_cannot_pay",
  "payer_account_locked_or_closed",
]);

const RETRYABLE = new Set([
  "insufficient_funds",
  "processing_error",
  "try_again_later",
  "issuer_not_available",
  "reenter_transaction",
  "approve_with_id",
  "card_velocity_exceeded",
  "withdrawal_count_limit_exceeded",
  "generic_decline",
  "card_declined",
  "do_not_honor",
  "service_not_allowed",
  "rate_limit",
  "transaction_refused",
  // PayPal
  "internal_service_error",
  "pending_review",
]);

/** Family-facing instructions (app first; plain text; no em dashes). Sample wording for Rod to confirm. */
export const CARD_UPDATE_INSTRUCTIONS =
  "Your card on file was declined and needs to be updated. The quickest way is the Teamwork app: open Billing, choose the unpaid invoice, tap Pay, and enter your new card. If you would rather not use the app, reply to this message or call the front desk and we will help.";

export const RETRY_INSTRUCTIONS =
  "Your payment did not go through this time. We will try again in a few days. If you would like to pay sooner, open Billing in the Teamwork app, choose the unpaid invoice, and tap Pay.";

const MESSAGE_HINTS: [RegExp, DeclineCategory][] = [
  [/expired/i, "card_needs_update"],
  [/fraud/i, "card_needs_update"],
  [/(account|card).*(closed|not found|invalid|no longer)/i, "card_needs_update"],
  [/no (bank )?account/i, "card_needs_update"],
  [/(lost|stolen)/i, "card_needs_update"],
  [/insufficient funds/i, "retryable"],
  [/(try again|temporar|processing error|unavailable|timeout)/i, "retryable"],
];

export function classifyDecline(code: string | null | undefined, message?: string | null): { category: DeclineCategory; label: string; familyText: string | null } {
  const c = (code ?? "").trim().toLowerCase();
  let category: DeclineCategory = NEEDS_UPDATE.has(c) ? "card_needs_update" : RETRYABLE.has(c) ? "retryable" : "unknown";
  if (category === "unknown" && message) category = MESSAGE_HINTS.find(([re]) => re.test(message))?.[1] ?? "unknown";
  return {
    category,
    label: category === "card_needs_update" ? "Card needs updating" : category === "retryable" ? "Retryable" : "Unclassified decline",
    familyText: category === "card_needs_update" ? CARD_UPDATE_INSTRUCTIONS : category === "retryable" ? RETRY_INSTRUCTIONS : null,
  };
}
