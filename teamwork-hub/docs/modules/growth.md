# Growth: referrals, Family Shop, helpful offers, trial passes

Module `growth`. Domain code in `src/lib/growth/*.ts`, schema in `src/db/schema/growth.ts`
(migration `0018_growth.sql`), server actions in `src/app/(app)/_growth/actions.ts`, UI pieces in
`src/components/growth/*`, seed in `scripts/seed/growth.ts`, tests in `tests/growth-*.test.ts`.

The aim is revenue that feels helpful to families. Nothing here charges a card, sends a message,
predicts behaviour, or uses pressure tactics.

## Hard rules this module keeps

- **No live charges and no simulated success.** The shop creates an OPEN invoice and stops. Payment
  happens in the existing hosted checkout (or at the front desk). An invoice becomes paid only
  through the billing module's `settleInvoiceIfCovered`, which needs settled money: a verified
  provider webhook or a staff-recorded offline payment.
- **Entitlements only after settlement.** Shop invoice lines carry the entitlement; credits are
  granted by the existing `applyInvoiceEntitlements` path, once per invoice line.
- **Honest not-configured state.** With no payment provider configured the shop and the order page
  say that online payment is not set up and that the invoice can be paid at the front desk.
- **No invented prices or policies.** The referral program is off with no reward until an
  owner/admin enters one. Every price shown comes from Billing → Products. Demo values are labelled
  "Sample".
- **No money without staff approval.** An earned reward is a pending row. Account credit or session
  credits exist only after a staff member approves it. Account credit is applied to an invoice by
  staff, never automatically.
- **No external messages.** Nothing in this module emails or texts anyone.

## 1. Referral program

| Piece | Where |
|---|---|
| Codes, attribution, progress, approval, account credit | `src/lib/growth/referrals.ts` |
| Public inquiry with a code | `src/lib/growth/intake.ts`, `src/app/(public)/r/[code]` |
| Family page | `/refer` |
| Staff page | `/people/referrals` (People tab "Referrals") |
| Lead detail | "Referral & trial pass" card (`src/components/growth/lead-growth-card.tsx`) |
| Settings | `/settings/growth` (owner/admin) |

**Codes.** One active code per payer account (`referral_codes`, partial unique index), created the
first time the family opens `/refer`. 10 characters from a 31-symbol alphabet without look-alikes
(about 49 bits). Staff with `crm.manage` can revoke a code; a new one is issued and the old one
stops attributing at once.

**Public route `/r/<code>`.**
- The page does **not** look the code up. Every code, real or not, renders the same inquiry form,
  so the URL cannot be used to enumerate codes. Nothing about the referring family is shown.
- The code travels as a hidden form field (at most 16 URL-safe characters). It is not PII.
- On submit the lead is created by the normal CRM intake (same validation, honeypot, per-IP limit
  of 5 per hour and org-wide ceiling of 30 web inquiries per hour), then the code is attributed in
  the same transaction. The response is the same thanks page whether or not the code was valid.
- The lookup at submit always runs one indexed equality query, including for malformed input.

**Attribution rules** (`attributeReferral`; the first failing rule decides):
1. The program is on and the code is an active code of this organization. Otherwise nothing is recorded.
2. A lead keeps its first referral (`referrals.lead_id` is unique).
3. Self-referral: the inquirer matches (person, email or phone) someone authorized on the referrer's payer account. Always blocked.
4. Same household: the inquirer matches anyone in the referrer's household, their athletes or those athletes' guardians. Blocked unless "Block referrals within the same household" is off.
5. New family: nobody matching the inquirer has a membership created before the inquiry (as athlete, guardian or payer). Configurable.
6. Already referred: the same people already have a valid referral from an earlier inquiry. The earlier one stands.

Blocked attempts are stored as `rejected` with the reason, visible to staff only. Staff can also add
a code to a lead by hand (same rules, recorded as "code added by staff").

**Progress** (`syncReferrals`, idempotent, row-locked):
- `inquired` → `started` when the lead is converted to an athlete. Rules 3 to 5 are re-checked against the real family (for example a lead that staff linked onto the referrer's own account is rejected).
- `started` → `earned` per Settings → Growth: the referred member's first invoice above $0 is **paid**, or a membership has been active for N days. A $0 invoice, an open invoice or a pending bank payment never earns.
- Earning inserts pending `referral_rewards` rows (unique per referral and side) with a snapshot of the configured reward.

`syncReferrals` runs when staff open People → Referrals and when a family opens Refer a friend.
It is not on the job queue yet (see "Not done").

**Approval** (`approveReward`, needs `billing.manage`): locks the reward row, so concurrent clicks
issue once and later clicks report "already approved". Account credit → one `account_credit_ledger`
row with idempotency key `referral-reward:<id>`. Session credits → `grantCredits` (source
`staff_grant`) with the same key; when the family has several athletes, staff choose who receives
them. Declining needs a reason. Both are audited (`growth.reward.approve` / `growth.reward.decline`).

**Account credit.** The billing module had no account credit, so this module adds a small signed
ledger (`account_credit_ledger`; the balance is the sum). It is deliberately **not** a row in
`transactions`: credit is not money received and must never make an invoice look paid. Staff apply
credit to one of the family's open invoices from People → Referrals (`applyAccountCredit`): the
amount is added to the invoice's discount and the total goes down. Refused for invoices billed by a
provider subscription or Zen Planner, and while a checkout or bank payment is in flight.

**What a family sees on `/refer`:** their link, a copy button, a QR code (generated server-side with
`qrcode` as a data URL), the reward in plain words from settings, and each referral as first name +
last initial + stage (Inquired / Started / Reward earned). Rejected referrals, surnames, contact
details and everything else stay with staff. People with no billing account (for example Casey)
have no link.

## 2. Family Shop (`/shop`)

`src/lib/growth/shop.ts`. For guardians and adult athletes.

- A product appears only when staff tick **Sellable online** under Billing → Products (stored in
  `shop_listings`, default off, audited). Staff can add a short "what it includes" text.
- Sellable kinds: session packs, single sessions (drop-in), assessments and one-time add-ons.
  **Camps and clinics are not shop products**: they are sold as events with their own seat count
  (`docs/modules/events.md`, family page `/shop/camps`, linked from the shop). Catalog `camp`
  products are not linked to scheduled sessions and stay off the shop; the Products page says so.
  Memberships use the membership flow; retail uses the point of sale (stock); free items are never listed.
- Each card shows the name, what it includes, facts from the catalog version (credits, expiry) and
  the price in effect today. Product names and descriptions are shown without em dashes.
- **Who can buy:** people with `can_pay` on a payer account, for athletes who are beneficiaries of
  that account. Jordan (view only) can browse but not order; Casey and minors' own logins cannot order.
- **Checkout** (`shopCheckout`): re-checks the listing and price server-side, then calls the
  existing `createInvoiceRecord` (status open, idempotency key `shop:<user>:<form key>`, advisory
  lock for double clicks) and records a `shop_orders` row. It then shows `/shop/order/<invoice>`:
  "Continue to payment" leads to the existing invoice page and its hosted checkout form, or, with
  no provider configured, an explanation that payment is made at the front desk.

## 3. Helpful offers

`src/lib/growth/offers.ts`. Plain rules over facts already in the system. Each offer carries its
evidence, a family sentence, an estimate with its basis, and links into existing flows.

| Rule | Fires when | Suggests | Estimate |
|---|---|---|---|
| `weekly_cap` | Class bookings reached the plan's weekly limit in 3 of the last 4 full weeks | The next plan up (same billing interval, more classes or unlimited, preferring the same commitment). Only if one exists | Catalog price difference per month |
| `credits_low` | Purchased credits at or below the threshold, or credits expiring within N days | Renewing the same pack (shop link if sellable) | Catalog price of the pack, one time |
| `commitment_savings` | On a plan with no commitment for N months | The same plan with a commitment, if the catalog has a cheaper one | None claimed (the family saves) |
| `sibling_discount` | Another active athlete on the same billing account has no membership, and the family discount is above 0% | The family discount. Only siblings already on file as athletes | None (depends on the plan) |
| `assessment_due` | A member for at least N months with no test session or assessment in N months | An assessment (shop link if sellable) | Catalog price, one time |
| `in_season_ending` | An In Season membership ends within N days | The paused regular plan it returns to, or choosing one | Monthly price of the paused plan |

Thresholds (N, the low-credit count, the dismissal period) are in Settings → Growth. They are
operating defaults, not prices.

**Staff** (needs `billing.view_all`; coaches see nothing): an "Opportunities" card on the member
profile and the `/billing/opportunities` list with the evidence, the estimate (labelled as an
estimate, with its basis), "Create task" (one task per athlete, rule and month) and a link to the
membership page for plan changes. Nothing on these pages contacts a family or changes a membership.

**Families:** at most one suggestion at a time, inline on `/shop` and on the billing overview. Never
a modal, no countdowns, no urgency wording. "Not now" stores a dismissal for the configured period
(per person, athlete and rule). Shown only to people who can see billing for that athlete (payer
view access, checked through `policy.ts`). The org can turn family suggestions off entirely. The
sibling discount suggestion stays staff-only until an owner confirms the family discount percent in
Settings → Membership policy.

## 4. Trial passes

`src/lib/growth/passes.ts`. From the lead page, staff with `crm.manage` issue N session credits
with an expiry and a required reason. Credits go through the existing credit ledger (`staff_grant`,
idempotency key per pass) and the pass is audited (`growth.trial_pass.issue`). The form key makes a
double click issue one pass.

Credits belong to an athlete record, so the lead's person gets one when the first pass is issued.
The lead stays open; converting it later reuses that athlete.

## 5. Reports (Reports → Growth)

All need `reports.financial`, state their definitions on the page, and export CSV.

- **Referrals funnel** (`growth-referrals`): per referring family, referred / started / earned / not counted, rewards pending and approved, account credit approved.
- **Shop sales by item** (`growth-shop-sales`): orders, paid, open, voided; ordered (billed) and paid (settled) dollars kept separate.
- **Suggestions shown, followed and dismissed** (`growth-offers`): per rule. "Followed" means the button was used, not that anything was bought.
- **Trial pass conversion** (`growth-trial-passes`): sessions used, converted, joined.

## Authorization summary

| Action | Who |
|---|---|
| Growth settings | owner, admin (`settings.manage`) |
| Mark a product sellable online | owner, admin, operations (`billing.manage`) |
| Approve / decline rewards, apply account credit | owner, admin, operations (`billing.manage`) |
| Referrals page, add a code to a lead, revoke a code, issue a trial pass | owner, admin, operations (`crm.manage`) |
| Opportunities list and profile card | owner, admin, operations (`billing.view_all`) |
| Shop checkout | guardian or adult athlete with `can_pay`, for athletes on that payer account |
| See a family suggestion, dismiss it | guardian or adult athlete with payer view access for that athlete |
| Refer a friend page | guardian or adult athlete authorized on a payer account |

Every query filters on `org_id`; ids from forms are re-checked against the viewer's scope.

## Demo data

`pnpm db:fresh` seeds: sample growth settings (a sample $25.00 account credit and one session credit
for the new family, both labelled sample), two sellable sample products, referral codes for the
Parker and Rivera demo families (`/r/parkerdemo26`), one converted and paid referral with rewards
waiting for approval, two referrals at the inquiry stage, a nearly used sample pack for Maya
(suggestion on Alex's shop and billing pages) and a sample 1x per week plan for Ella.

## Not done / follow-ups

- Referral progress is evaluated on page load, not by a scheduled job. A daily job on the existing queue would make "earned" appear without anyone opening the page.
- Camps and clinics are sold as events (`docs/modules/events.md`), not through the shop. Catalog `camp` products stay off the shop.
- Account credit is applied by staff only and shows on the invoice as a discount, not as a named line.
- Families cannot regenerate their own referral code (staff can).
- The trial pass form exists on the lead page only.
- No notification is sent when a reward is approved (this module sends nothing by design).
