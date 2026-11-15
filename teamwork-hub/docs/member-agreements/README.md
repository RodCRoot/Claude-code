# Teamwork Member Agreements (v2026.11)

Four documents every member signs before training. They replace the three signature documents currently in ZenPlanner (Settings > Registration > Signatures):

| Current ZenPlanner document | Status today | Replaced by |
|---|---|---|
| Membership Terms Agreement/Contract | Active, Universal, people registered after Jan 3, 2025 | All four documents below |
| Member Contract (2023 version) | Inactive | 03 and 04 |
| Waiver (2021 version) | Inactive | 01 and 02 |

## The four documents

| File | Purpose | ZenPlanner type | Who signs |
|---|---|---|---|
| `01-minor-liability-waiver.md` | Indiana release of liability, assumption of risk, parent indemnity, medical authorization for athletes under 18 | Universal | Parent or guardian |
| `02-media-likeness-release.md` | Photo, video, name, likeness, and performance-data permission, with 4 opt-in levels | Universal | Parent or guardian (or athlete if 18+) |
| `03-member-user-agreement.md` | Day-to-day policies, procedures, communication rules, and fee schedule | Universal | Account holder |
| `04-membership-contract.md` | The binding membership commitment, recurring payment authorization, cancellation and early termination terms, collections, Exhibit A rates | Membership (all membership categories) | Responsible Party (and cardholder if different) |

`html/` holds the same four documents as HTML, ready to paste into ZenPlanner's signature document editor (use the editor's source/HTML view).

**Teamwork Hub:** these are the approved-language source for the Hub's Documents > Templates (waiver, media, membership agreement). They replace the seeded SAMPLE TEXT once counsel signs off. In the Hub, the media permission level can be a required select field on the template instead of a ZenPlanner custom field.

## What changed from the current forms

- **Split into four documents.** A chargeback reviewer or judge sees a contract that is only about money, and a waiver that is only about injury. Courts and card issuers both favor documents that are clearly titled and not buried in each other.
- **Waiver now meets Indiana's negligence rule.** The current form releases "claims, including those due to negligence" in one line. Indiana requires the release to specifically and explicitly refer to the negligence of the party being released. The new waiver names it in the title banner, the risk list, the release, and the signature statement, in bold caps. It also adds parent indemnity, medical authorization, health disclosure, concussion return rules, and Monroe County venue.
- **Indiana Health Spa Services Act terms added to the contract.** This act (IC 24-5-7) covers paid instruction or training in exercising at a gymnasium or similar facility, and a contract that does not comply is voidable by the member. Added: the 3-business-day cancellation right in bold, the death / total disability / relocation over 5 miles / closure cancellation rights in bold, 30-day refund timing, services start within 45 days, and a 36-month maximum term.
- **Recurring-billing language for chargebacks.** The contract now uses the words card networks look for: "recurring transaction," amount, frequency, duration, statement descriptor "T2 Indiana," express authorization, auto-continuation in bold caps, the one cancellation method, a dated example, and a "contact us first" clause. Key terms are repeated as numbered acknowledgments right above the signature.
- **Policies brought current.** Proration and billing on the 1st, 6- and 12-month and month-to-month only (no 3-month), 1x per week month-to-month only, frequency changes keep the tier, 8 sessions per month for 2x plans, family discount tiers (10/15/20/25%), $99 in-season rules, 2-month hold cap with firm restart dates, early termination formula with a cap and the 12-month return credit, no-show policy, drop-in rate, "T2 Indiana" descriptor, and the rule that only email to memberships@ counts as notice.
- **Old items dropped or fixed.** The "$40 per month" refund-dispute fee is now the actual processor fee up to $40 per dispute, only when Teamwork wins. The old "5 minute call" cancellation requirement and the 2021 one-month hold limit are gone. "Parent meetings" are now the virtual progress checks.

## Loading into ZenPlanner

1. Settings > Registration > Signatures. Add each document (Universal for 01, 02, 03; Membership for 04 with All Membership Categories).
2. Paste the HTML from `html/` into each document's editor.
3. Mark all four **Active**. Activating creates a blocking alert, so existing members will be asked to sign before their next check-in or signup. Plan a heads-up email to all families before you flip them on.
4. Deactivate the old "Membership Terms Agreement/Contract" once the new four are active.
5. **Media permission level.** ZenPlanner signature documents capture a signature, not checkbox answers. Add a required "Media Permission" custom field (Full / Limited / Group only / None) in Settings > Database Tools > Custom Fields or the registration Form Builder, so the choice is saved on the profile. Document 02 says Teamwork uses Limited permission if no choice is recorded.
6. Test with a dummy account to confirm the order, that each signature saves to the member profile, and that ZenPlanner emails the signer a copy (the contract promises a copy at signup, and the Health Spa Act requires it).

## Chargeback and collections evidence packet

When a dispute or past-due account comes in, pull these from ZenPlanner and GHL:

1. Signed **04 Membership Agreement and Contract** with the signature timestamp and IP/device info ZenPlanner records.
2. The member's ZenPlanner membership record (plan, rate, start date, commitment) and signup confirmation email.
3. Billing history showing each charge matched the agreed rate on the 1st.
4. Attendance and reservation history, especially any check-ins after the date they claim they canceled.
5. The memberships@ inbox showing **no cancellation email**, or showing the cancellation date and that charges stopped per Section 8.
6. Any texts or emails where the member was reminded of the policy.
7. A short cover letter that quotes Section 3 (automatic continuation), Section 4 (recurring authorization), Section 8 (30-day email notice), and Section 9 (early termination).

## Decisions for Rod before going live

These are judgment calls I made or could not confirm. Each is easy to change.

1. **No-show timing.** The no-show policy counts a no-show as not canceling "before the session starts." If you want a cutoff (like 2 hours before), it goes in User Agreement Section 3.
2. **Cancellation web form.** Per your rule, only an email to memberships@ counts as notice. A member who used the GHL cancellation form could still show that submission to their card issuer as proof they asked to cancel. Consider having the GHL form auto-forward to memberships@ so it becomes an email.
3. **In-season and holds share a cap?** The contract treats in-season (2 months per 365 days) and holds (2 months per 365 days) as separate allowances. If they should share one 2-month allowance, edit Contract Sections 6 and 7.
4. **Private sessions.** Exhibit A leaves out private session pricing ($60 add-on for members, $75 standalone in earlier notes) because it is not a ZenPlanner membership option. Add it if you want it in the contract.
5. **36-month cap.** The Health Spa Act limits a contract to 3 years. Members who keep going month to month past 36 months will need to re-sign. Worth a ZenPlanner task or GHL reminder.
6. **Adult members.** Document 01 is written for minors as requested. Adult Performance members need an adult version of the release. I can make one.
7. **Disability waiver of the early termination fee for serious injury.** I added it to match your old forms ("memberships may be paused or canceled" for serious injuries). Remove it from Section 10 if you want only the statutory reasons.
8. **Surety bond.** The Health Spa Act also has bonding rules. They appear aimed at facilities that are planned or under construction, which would not apply to an existing facility, but have your attorney confirm.

**Have an Indiana attorney review all four before they go live.** These drafts are built on Indiana case law and statutes, but they are not legal advice, and a one-time review is cheap compared with losing a waiver defense or a contract that turns out to be voidable.

## Legal basis (for the attorney)

- Parent-signed pre-injury releases for minors upheld: *Wabash County YMCA v. Thompson* (Ind. Ct. App. 2012). Ambiguous parent release not enforced against the minor: *Sauter v. Perfect North Slopes* (S.D. Ind. 2014).
- Release must specifically and explicitly refer to the releasee's own negligence: *Powell v. American Health Fitness Center* (Ind. Ct. App. 1998); *Marsh v. Dixon* (1999); *Avant v. Community Hospital* (2005); *City of Hammond v. Plys* (2008). Conspicuous "THIS IS A RELEASE" formatting supports "knowingly and willingly": *LaFrenz v. Lake County Fair Board* (1977).
- Indiana Health Spa Services Act, IC 24-5-7-1 through -18 (written contract and copy, 3-year term limit, 45-day start, 3-business-day cancellation in 10-point bold, death/disability/relocation/closure cancellation, 30-day refunds, voidability and cure, waiver of the chapter is void).
- Indiana Uniform Electronic Transactions Act, IC 26-2-8.
