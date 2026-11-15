import type { SignerRequirement } from "@/db/schema";

export const SAMPLE_AGREEMENT_NAME = "Membership Agreement (plan terms)";

/**
 * Teamwork's draft membership agreement and contract (v2026.11; source and notes in
 * docs/member-agreements/04-membership-contract.md). Every {{field}} is filled from the actual membership when it
 * is issued. Cancellation, hold and family discount rules are written out in the text because Teamwork's rules
 * (early termination fee, holds per 365 days, tiered family discount) differ from the built-in merge wording.
 * Pending attorney review: labelled SAMPLE TEXT on screen and on the PDF until an owner or admin marks approved text.
 */
export const SAMPLE_AGREEMENT_BODY = `# Teamwork Bloomington
## Membership Agreement and Contract
### Membership Commitment, Recurring Payment Authorization, and Cancellation Terms

**SAMPLE TEXT: Teamwork draft wording, pending attorney review. Not yet approved for members.**

**THIS IS A BINDING CONTRACT. IT INCLUDES A RECURRING CHARGE TO YOUR CARD OR BANK ACCOUNT AND A FEE FOR CANCELING A COMMITMENT EARLY. READ IT BEFORE SIGNING.**

**Seller:** T2 Indiana, Inc., doing business as Teamwork Bloomington and Teamwork Indiana ("Teamwork"), 2013 S. Yost Ave, Bloomington, IN. Phone 812-445-5551. Email memberships@teamworkbloomington.com.

**Responsible Party ("you"):** the adult account holder who signs below. You are the buyer under this contract.

**Athlete(s):** each person training under this membership, as listed on your Teamwork account.

---

## BUYER'S RIGHT TO CANCEL
**YOU MAY CANCEL THIS CONTRACT BEFORE MIDNIGHT OF THE THIRD FULL BUSINESS DAY AFTER YOU SIGN IT.** A business day is any day except Sunday or a legal holiday. To cancel, deliver a signed, written notice of cancellation to Teamwork at 2013 S. Yost Ave, Bloomington, IN in person or by certified or registered mail. Teamwork will also accept a notice of cancellation emailed to memberships@teamworkbloomington.com within the same time. **All money you paid under this contract will be refunded within 30 days after Teamwork receives your notice.**

---

### 1. Your Membership

These are the terms of this membership, filled in from the membership record at the time you sign:

- Athlete: {{member_name}}
- Responsible Party: {{payer_name}}
- Plan: **{{plan_name}}** ({{sessions_per_week}})
- Standard rate: {{price}}
- Your rate: {{price_after_discount}}
- Start date: {{start_date}}
- Partial first month: {{first_partial_month}}
- First regular bill: {{first_regular_bill_date}}, then billed on {{billing_day}}
- Commitment: {{commitment_length}}
- Commitment end date: {{commitment_end_date}}
- End of term: {{end_of_term}}
- Payment method: {{payment_method}}

Current standard rates are listed in Exhibit A. Services begin within 45 days after you sign.

### 2. Commitment Term

- **Options.** Teamwork offers month-to-month, 6-month, and 12-month commitments. The 1x per week plan is available month-to-month only.
- **Start.** Your commitment term begins on the 1st of the month your regular plan starts. If you start mid-month, the first partial month is prorated and does not count toward the commitment term.
- **Rate lock.** Your monthly rate will not increase during your commitment term.
- **Changing frequency.** You may change weekly frequency (for example, 3x down to 2x) during a commitment. You keep your commitment tier and pay that tier's rate for the new frequency. Those months still count toward your commitment. Changes take effect on the next billing date after Teamwork confirms them in writing.

### 3. What Happens When the Commitment Ends: Automatic Continuation

**YOUR MEMBERSHIP DOES NOT END AUTOMATICALLY.** When your commitment term ends, your membership continues month to month at the same monthly rate, and Teamwork will keep charging your payment method each month, until you cancel under Section 8.

During month-to-month periods, Teamwork may change the monthly rate by emailing you at least 30 days before the new rate takes effect.

This contract, including month-to-month continuation, will not run longer than 36 months from the date you sign it. Before that date, Teamwork will ask you to sign a new agreement to continue.

### 4. Recurring Payment Authorization

**You authorize Teamwork to charge the credit card, debit card, or bank account you keep on file with Teamwork as a recurring transaction:**

- **Amount:** your rate shown in Section 1, plus any prorated first-month charge and any fees owed under this contract and the User Agreement.
- **Frequency:** monthly, on the 1st of each month. The first prorated charge is made at signup.
- **Duration:** until your membership is canceled under this contract and all amounts owed are paid.
- **Statement descriptor:** charges appear as **"T2 Indiana."**

You also authorize Teamwork to charge your payment method on file for past-due balances and fees owed under this contract, after Teamwork notifies you by email or text.

If you pay a different way (cash, check, or another payment method Teamwork approves), payments are still due on the 1st, and all terms of this contract still apply.

**Bank account authorization:** {{ach_authorization}}

You agree to keep a valid payment method on file and to update it yourself in your Teamwork account if your card expires or changes. If the payment method on file belongs to someone else, that person must also sign the cardholder authorization below.

### 5. Family Discount

When more than one family member holds an active monthly membership, each membership's monthly rate is discounted:

- 2 active family members: 10% off each membership
- 3 active family members: 15% off each membership
- 4 active family members: 20% off each membership
- 5 active family members: 25% off each membership

The family discount never applies to the $99 in-season rate. If the number of active family memberships drops, the discount on the remaining memberships adjusts to the new tier starting the next billing date.

### 6. Holds (Pauses)

- Holds are available for up to **2 months in any 365-day period**, with a firm restart date.
- Request a hold by email to memberships@teamworkbloomington.com at least **one week before the billing date**. The one-week notice is waived for injuries.
- Holds are not backdated. A hold starts on a date Teamwork confirms in writing.
- During a hold, billing pauses and then **restarts automatically** on the restart date.
- Your commitment pauses during the hold. Your commitment end date moves back by the length of the hold.
- If a hold runs longer than 2 months, the membership is treated as canceled by you. Section 9 applies if you are still within a commitment, and rejoining is at the rates in effect at that time.
- Teamwork may approve exceptions in writing.

### 7. In-Season Plan

- 12-month members may switch to the in-season plan: **$99 per month for 1 session per week (4 sessions per month).**
- In-season is available for up to **2 months in any 365-day period**, with set start and end dates confirmed in writing.
- No family or other discount applies to the in-season rate.
- During in-season, your regular membership is paused. It **restarts automatically** at your regular rate on the end date Teamwork confirms. Your commitment end date moves back by the length of the in-season period.

### 8. Cancellation: 30 Days' Written Notice

- **To cancel, you must email memberships@teamworkbloomington.com at least 30 days before your next billing date.** Include the athlete's name and your request to cancel.
- **Only an email to memberships@teamworkbloomington.com is notice of cancellation.** Telling a coach, a text, a phone call, a voicemail, a social media message, a web form, or simply not attending is not notice of cancellation.
- Teamwork will confirm your cancellation in writing within 3 business days. If you do not receive confirmation, email again or call 812-445-5551.
- **Example:** your billing date is the 1st. If Teamwork receives your email on November 14, the December 1 charge still processes, because it is less than 30 days away. The membership ends December 31, and there is no January charge.
- The athlete may keep training through the end of the last paid period. Unused sessions end when the membership ends.
- You must also give 30 days' notice at the end of a commitment. Memberships do not cancel on their own when a commitment ends.

### 9. Early Termination of a Commitment

If you cancel a 6-month or 12-month commitment before it ends, or your membership ends early for any reason other than those in Section 10, you will owe an **early termination fee**. The fee is the discount you received for committing, for the months you paid:

**Early termination fee = (months paid × month-to-month rate) − (months paid × your committed rate)**

Both rates are calculated with the same family discount, if one applied.

- **Example:** you chose a 2x per week, 6-month plan at $197.99. The 2x per week month-to-month rate is $232.99. You cancel after paying 4 months. The fee is 4 × ($232.99 − $197.99) = **$140.00**.
- The fee will never be more than the total of the monthly payments remaining on your commitment.
- The 30-day notice in Section 8 still applies.
- **Return credit:** if the athlete rejoins Teamwork within 12 months after the cancellation date, the early termination fee you paid will be credited toward the new membership's dues.

### 10. Cancellation Without a Fee (Death, Disability, Relocation, or Closure)

**YOU OR YOUR ESTATE MAY CANCEL THIS CONTRACT WITHOUT AN EARLY TERMINATION FEE IF:**

- **(1) THE BUYER DIES;**
- **(2) THE BUYER BECOMES TOTALLY PHYSICALLY DISABLED FOR THE REST OF THE CONTRACT TERM;**
- **(3) TEAMWORK MOVES ITS FACILITY MORE THAN FIVE (5) MILES FROM 2013 S. YOST AVE, BLOOMINGTON, IN, AND DOES NOT OFFER SIMILAR SERVICES WITHIN FIVE (5) MILES; OR**
- **(4) TEAMWORK PERMANENTLY STOPS OPERATING.**

Teamwork may ask for reasonable proof of death or disability. For disability, Teamwork may require an exam by a doctor both parties agree on, at Teamwork's cost. Teamwork will also waive the early termination fee if the athlete has a serious injury that a doctor documents will prevent training for the rest of the commitment. Refunds owed under this section are paid within 30 days after Teamwork receives notice.

### 11. Fees

You agree to pay the fees listed in the Teamwork User Agreement fee schedule, including:

- **$30 late fee** for each month a balance is more than 14 days past due without an approved payment arrangement.
- **$30 fee** for each declined, reversed, or returned (NSF) payment.
- **$10 no-show fee** for each no-show after the first warning.
- **Dispute processing fee** equal to the actual fee Teamwork's processor charges, up to $40, for each card or bank dispute that is decided in Teamwork's favor or withdrawn.

### 12. Refunds

Membership payments are not refundable except:

- under the Buyer's Right to Cancel above,
- under Section 10, or
- for a billing error by Teamwork. Report billing errors by email to memberships@teamworkbloomington.com. Teamwork will correct verified errors within 30 days.

Missed sessions, unused sessions, and non-attendance do not qualify for refunds or credits.

### 13. Billing Questions and Card Disputes

- **Please contact Teamwork first.** If you believe a charge is wrong, email memberships@teamworkbloomington.com. Teamwork will respond within 3 business days and will correct any verified error.
- **You agree that every charge made under the terms of this contract is authorized by you,** including charges during the 30-day notice period, monthly charges after your commitment ends until you cancel, and charges for months the athlete did not attend.
- If you dispute a charge with your card issuer or bank, Teamwork may give the issuer a copy of this contract, your signed documents, your membership and billing records, the athlete's attendance and reservation history, and your communications with Teamwork.
- If you dispute a charge and the dispute is decided in Teamwork's favor, the charge and any fees under Section 11 remain owed.
- Nothing in this section limits any right you have under federal or state law.

### 14. Past-Due Accounts and Collections

- Teamwork may pause the athlete's training reservations while an account is past due.
- If any balance stays unpaid for 60 days, Teamwork may refer the account to a collection agency or file a claim in court.
- **You agree to pay Teamwork's reasonable costs of collecting any past-due amount, including collection agency fees, court costs, and reasonable attorney fees, to the extent Indiana law allows.**
- Teamwork will email or mail you a written notice at least 14 days before referring an account to collections.

### 15. Who Is Responsible for Payment

- **You, the Responsible Party, are personally responsible for all amounts owed under this contract,** for every athlete on your account. This is true even if the athlete is a minor, even if another person (such as a co-parent) usually pays, and even if the payment method belongs to someone else.
- Minor athletes are not financially responsible under this contract.

### 16. Other Documents That Are Part of This Contract

This contract includes, and you agree to: (a) your membership record and signup confirmation; (b) the Teamwork Member User Agreement; and (c) the Teamwork release of liability you signed. If any of those conflict with this contract, this contract controls.

### 17. General Terms

- **Changes.** This contract can only be changed in writing. An email from memberships@teamworkbloomington.com counts as writing. No coach or staff member can change it verbally.
- **Indiana law and venue.** Indiana law governs this contract. Any lawsuit about it must be filed in the state courts located in Monroe County, Indiana, including small claims court.
- **Severability.** If any part of this contract is found unenforceable, the rest stays in effect.
- **Electronic signature and records.** You agree to sign and receive this contract electronically under the Indiana Uniform Electronic Transactions Act (IC 26-2-8). Your electronic signature has the same effect as a handwritten signature. Teamwork will give you a copy of this signed contract at signup, and you may request another copy at any time by email.
- **Notices to you.** Teamwork sends notices to the email address and mobile number on your Teamwork account. Keep them current.
- **Assignment.** If Teamwork sells or transfers its business, this contract may be transferred to the new owner, who must honor it.

---

### Key Terms I Specifically Agree To

By signing, I confirm that I have read and understand each of these:

1. I authorize recurring monthly charges on the 1st to my payment method on file, appearing as "T2 Indiana."
2. My membership **does not end automatically**, even after my commitment ends. It continues month to month until I cancel.
3. To cancel, I must **email memberships@teamworkbloomington.com at least 30 days before my next billing date.** No other method counts.
4. If I cancel a 6- or 12-month commitment early, I owe the **early termination fee** in Section 9.
5. Not attending does not stop billing, and unused sessions are not refunded.
6. Late, declined payment, no-show, and dispute fees apply as stated.
7. I am personally responsible for all amounts owed for every athlete on my account, including collection costs.
8. I may cancel this contract before midnight of the third full business day after signing for a full refund.

---

### Exhibit A: Standard Monthly Rates (as of November 2026)

- **1x per week (4 sessions per month):** month-to-month $129.00. No 6- or 12-month option.
- **2x per week (8 sessions per month):** 12-month $178.99; 6-month $197.99; month-to-month $232.99.
- **3x per week (12 sessions per month):** 12-month $221.99; 6-month $261.99; month-to-month $348.00.
- **4x per week (16 sessions per month):** 12-month $295.99; 6-month $375.99; month-to-month $465.00.
- **Unlimited:** 12-month $309.99; 6-month $419.99; month-to-month $569.00.
- **In-season (12-month members only, up to 2 months per 365 days, 4 sessions per month):** $99.00.

Family discounts are in Section 5. The in-season rate is never discounted. Drop-in or pre-start sessions cost the monthly rate of the chosen plan divided by 8. Special programs (camps, challenges, summer programs) are priced separately. The rate in Section 1 is the rate you agreed to and controls over this list.
`;

export const SAMPLE_AGREEMENT_SIGNERS: SignerRequirement[] = [
  { role: "guardian", required: true },
  { role: "adult_athlete", required: true },
];
