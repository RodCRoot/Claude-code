import { defineWording } from "@/lib/sample-text";
/**
 * SAMPLE recurring ACH debit authorization shown to a payer before they save a bank account.
 * It is sample wording for the owner's lawyer to replace, not legal advice. Stripe's hosted page shows
 * and records its own mandate as well; this is Teamwork's own record of what the payer was shown.
 * Changing the wording requires a new version string: stored acceptances keep the version and exact text.
 */
export const MANDATE_TEXT_VERSION = "sample-ach-2026-11";

export function mandateText(orgName: string): string {
  return (
    `SAMPLE TEXT. By saving this bank account, I authorize ${orgName} to electronically debit it through the ACH network ` +
    "for my membership bills and any other amounts I owe on this account, on or after the date each bill is due, " +
    "until I cancel this authorization. Amounts and dates can vary from bill to bill; each bill is shown under Bills before it is charged. " +
    "I can cancel this authorization at any time by removing the bank account under Payment Methods or by telling the front desk, " +
    "at least 3 business days before the next bill. I confirm I am an authorized signer on this account."
  );
}

/** Plain summary of what is stored, shown wherever a method can be saved. */
export const STORAGE_NOTICE =
  "Your card or bank account number is entered on a secure page run by Stripe, our payment processor, and is stored there. " +
  "Teamwork keeps only a reference, the brand or bank name, and the last four digits.";

export const ACH_MANDATE_WORDING = defineWording({
  id: "ach_mandate",
  label: "Bank debit authorization",
  version: MANDATE_TEXT_VERSION,
  isSample: true,
  shownAt: "Shown to a payer before they save a bank account, and printed in the membership agreement.",
  source: "src/lib/billing/mandate-text.ts",
  href: "/settings/payments",
});
