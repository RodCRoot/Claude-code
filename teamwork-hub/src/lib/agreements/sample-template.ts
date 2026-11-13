import type { SignerRequirement } from "@/db/schema";

export const SAMPLE_AGREEMENT_NAME = "Membership Agreement (plan terms)";

/**
 * SAMPLE membership agreement. Every {{field}} is filled from the actual membership when it is issued.
 * This wording is a placeholder for the owner's lawyer to replace. It is not legal advice and is labelled
 * SAMPLE TEXT on screen and on the PDF until an owner or admin marks approved text.
 */
export const SAMPLE_AGREEMENT_BODY = `# Sample membership agreement

**SAMPLE TEXT. This wording is a placeholder for {{organization_name}}'s attorney to replace. It is not legal advice.**

This agreement is between {{organization_name}} and {{payer_name}} (the payer) for the membership of {{member_name}} (the member).

## 1. Plan

- Plan: **{{plan_name}}**
- Sessions: {{sessions_per_week}}
- Price: **{{price}}**
- Price after discount: {{price_after_discount}}
- Start date: {{start_date}}

## 2. Billing

- Bills are issued on {{billing_day}}.
- Partial first month: {{first_partial_month}}
- First regular bill: {{first_regular_bill_date}}
- Payment method: {{payment_method}}

## 3. Commitment

- Commitment length: {{commitment_length}}
- Commitment end date: {{commitment_end_date}}
- At the end of the term: {{end_of_term}}

## 4. Holds

{{hold_rules}}

## 5. Cancellation

Cancellation requires {{cancellation_notice}}.

## 6. Family discount

{{family_discount}}

## 7. Late or declined payments

{{payment_terms}}

## 8. Bank account authorization

{{ach_authorization}}

## 9. Signature

By signing, the payer agrees to the plan terms above for {{member_name}}.
`;

export const SAMPLE_AGREEMENT_SIGNERS: SignerRequirement[] = [
  { role: "guardian", required: true },
  { role: "adult_athlete", required: true },
];
