# Saved payment methods, autopay, membership agreements and the guided sign-up

Owner paths: `src/lib/billing/{payment-methods,autopay,autopay-settings,mandate-text}.ts`, `src/lib/payments/stripe-methods.ts`,
`src/lib/agreements/**`, `src/lib/signup/**`, `src/app/(app)/billing/{payment-methods,signup}/**`, `src/app/(app)/settings/payments/**`,
`src/components/billing/add-method.tsx`, `scripts/seed/signup.ts`, `tests/billing-payment-methods.test.ts`, `tests/billing-autopay.test.ts`,
`tests/signup-agreements.test.ts`, `tests/fixtures/payments/methods.ts`, `e2e/signup.spec.ts`. Migration `0032_signup`.
Read `billing.md` and `forms-signatures.md` first; this module builds on both and adds no second ledger.

## The three questions this answers

1. **How does monthly billing tie to agreements and waivers?** A membership can be created "awaiting agreement". The agreement is
   a form request whose text is filled in from that membership (plan, price, billing day, partial first month, commitment, holds,
   notice, discount, payment terms) and frozen when issued. It is linked to the membership and product version
   (`membership_agreements`). Waivers stay ordinary required forms and ride along in the same sign-up flow.
2. **Can we bill checking accounts through Stripe?** Yes in design: ACH Direct Debit (`us_bank_account`) is saved and charged
   the same way as a card. **No fee rate is stated anywhere in this app.** Real fees are recorded per payment from Stripe and
   reported by method type so card and bank costs can be compared from real data.
3. **Are payment details stored?** The card or bank account is stored in Stripe's vault. This app stores a reference
   (`pm_…`, `cus_…`, mandate id), the brand or bank name, the last four digits and, for cards, the expiry month and year.
   It never receives or stores a card number, CVC, routing number or account number: they are typed on a Stripe-hosted page.

## Stripe facts relied on

Evidence levels as in `billing.md`. Pages were fetched on 2026-11-13 (the `.md` form of each docs page). No Stripe API was
called and no account or sandbox exists.

| Fact | Evidence | Source |
|---|---|---|
| The Setup Intents flow saves a customer's payment details without an initial payment; later charges use a PaymentIntent with `customer`, `payment_method`, `off_session=true`, `confirm=true` | verified | https://docs.stripe.com/payments/save-and-reuse |
| A failed off-session charge is reported as an error whose code can be `authentication_required`; the PaymentIntent then needs the customer back on-session | verified (page text); the exact error body shape we parse (`error.payment_intent.id`, `error.decline_code`, HTTP 402) is **unverified** | same |
| Checkout in `mode=setup` with `customer` collects a US bank account for later ACH debits; `payment_method_options[us_bank_account][financial_connections][permissions][]=payment_method` | verified | https://docs.stripe.com/payments/ach-direct-debit/set-up-payment?payment-ui=checkout |
| By default bank collection uses Financial Connections for instant verification with a fallback to manual entry + microdeposits; microdeposits take 1 to 2 business days and **Stripe emails the customer a link** to confirm them; `verification_method=instant` would force instant only (not used) | verified | same |
| ACH Direct Debit is a delayed-notification method; "a payment typically takes 4 business days to arrive" | verified | same |
| The page's webhook sample handles `setup_intent.succeeded` | verified | same |
| ACH can fail after initial success (arrives as a dispute), disputes up to 60 days | verified earlier (see `billing.md`) | https://docs.stripe.com/payments/ach-direct-debit |
| Passing one entry in `payment_method_types[]` to a setup-mode Checkout Session, `setup_intent_data[metadata]`, `client_reference_id` on setup sessions | **unverified** (parameter names from the API reference by memory; not re-read) | — |
| Event names and fields: `setup_intent.requires_action` with `next_action.verify_with_microdeposits.hosted_verification_url`, `setup_intent.setup_failed.last_setup_error`, `payment_method.attached/updated/automatically_updated/detached` (`card.brand/last4/exp_month/exp_year`, `us_bank_account.bank_name/last4`), `mandate.updated.status`, `payment_intent.processing/succeeded/payment_failed` (`last_payment_error.code/decline_code`), `charge.succeeded/updated.balance_transaction` | **unverified** (prior knowledge; fixtures are shaped from it, never captured from an account) | — |
| `mandate` parameter on a PaymentIntent for `us_bank_account`; whether Checkout setup mode returns the mandate id on the SetupIntent (`mandate`) | **unverified** | — |
| Fee of a payment = `fee` on the charge's balance transaction, read with `GET /v1/payment_intents/:id?expand[]=latest_charge.balance_transaction` | **unverified** | — |
| ACH failure/return codes used for sorting (`insufficient_funds`, `account_closed`, `no_account`, `debit_not_authorized`, …) and ACH dispute `reason` values | **unverified** | — |
| Stripe's docs now recommend "customer-configured Account objects" over `Customer` for most cases | verified (noted on both pages); we use classic `Customer`, which the pages still document | both pages |
| API version | the existing adapter sends no `Stripe-Version` header (the account default applies); this module follows that | `src/lib/payments/stripe.ts` |

## Saved payment methods

- **Collection.** `startMethodSetup` (family action) creates, in order: a Stripe Customer for the payer account if none
  (`POST /v1/customers`, idempotency key `customer:<org>:<payer>`, id kept in `payer_accounts.provider_refs.stripeCustomerId`),
  then a Checkout Session in `setup` mode for exactly one type (`card` or `us_bank_account`), idempotency key
  `pmsetup:<setupId>`, our `setup_id` in session and SetupIntent metadata. The browser is redirected to Stripe. An open
  session for the same person, payer and type is reused for 20 hours (double click, back button).
- **Bank authorization.** Before a bank setup the payer must tick Teamwork's own recurring debit authorization
  (`mandate-text.ts`, **SAMPLE wording**, version `sample-ach-2026-11`). Stored on the setup and copied to the method:
  when, user id, person id, IP, user agent, text version and the exact text. Stripe's hosted page shows and records
  its own mandate too; its id is stored as `mandate_ref`.
- **Rows.** `payment_method_setups` (one per hosted session) and `payment_methods` (extended: `provider_customer_id`,
  `bank_name`, `status`, `details_at`, `setup_succeeded_at`, `mandate_ref`, `mandate_status`, `mandate_acceptance`,
  failure fields, removal fields; unique `(provider, provider_method_id)`).
- **Activation only by verified webhook.** A method is `active` only when Stripe has both confirmed the setup
  (`setup_intent.succeeded`) and told us what the method is (`payment_method.attached`), in either order. Until then it
  is `requires_verification`. The browser return (`?setup=<id>`) is read-only and shows "confirming".
  - Duplicates: `webhook_events` uniqueness plus row locks (existing pipeline). Out of order: handled both ways.
  - A failed try followed by success in the same hosted session ends `active`; a late failure after success is ignored.
  - A setup event naming a different Stripe customer than the payer's saves nothing and raises a task.
  - `setup_intent.requires_action` (microdeposits) keeps the hosted verification URL so the page can link to Stripe's own
    page; amounts are never typed into this app.
  - `payment_method.detached` → `removed`; `mandate.updated` `inactive` → `failed` + staff task when autopay depended on it.
  - The stored webhook payload for `payment_method.*` events is reduced to id, customer, type, brand, last four, expiry and
    bank name before it is saved (routing number, fingerprints and billing details are dropped).
- **Who can do what** (`assertCanManageMethods`): add, set default and remove need `payer_authorizations.can_pay` on the
  account (Alex, Sam, Chris, Dana). Jordan (view only) sees summaries. Casey sees nothing. Staff never add or remove a
  family's method: owner/admin/operations see summaries at `/billing/payment-methods?payer=<id>` (from the membership
  page) with a link and QR code to hand over; the family signs in and adds it on their own phone. Coaches and the kiosk
  have no access. `payer_authorizations.can_manage_methods` exists in the schema but is not used (the rule is `can_pay`).
- **Removal.** Detached at Stripe first, then marked `removed`. Refused while it is the only working method an autopay
  membership depends on, with a plain explanation ("Add another payment method first, or turn off autopay…"). With other
  methods, autopay moves to the one remaining or the one chosen.
- **Not configured.** Without `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` nothing is written or sent; families see
  "Saving a card or bank account is not available yet", staff see which env vars are missing. All manual billing works.

## Autopay

- **Per membership**: `memberships.autopay` and `autopay_method_id` (null = payer default). Set by the paying family or by
  billing staff (staff can only pick a method the family already saved). Only Teamwork-invoiced (`manual`) memberships are
  charged; on a Zen Planner membership it is a stored preference that takes effect at cutover.
- **When a bill is issued** (`billPeriod`, the one place membership invoices are created) and autopay is on, a job
  `billing.autopay_charge` is queued for the due date (deduped `billing.autopay_charge:<invoice>:1`). Turning autopay on
  later does **not** charge bills that already exist; the family uses Pay Now for those.
- **Charging** (`chargeInvoiceAutopay`): under the invoice row lock it refuses if the invoice is not open, money is pending,
  an attempt is in flight, or the attempt number is not exactly "attempts so far + 1"; then inserts a `payment_attempts`
  row (`origin='autopay'`, unique key `autopay:<invoice>:<n>`), and outside the transaction creates an off-session
  PaymentIntent with the same key as Stripe's `Idempotency-Key`. Issuing twice, re-running the job or four concurrent
  workers produce one attempt and one Stripe call. An attempt left `created` with no provider reference for 10 minutes
  (crash) is resumed with the same key.
- **Money state is webhook-only.** Stripe's synchronous answer never marks anything paid. `payment_intent.processing`
  writes the existing `pending` transaction: the bill shows **Pending bank payment** and is not paid.
  `payment_intent.succeeded` settles it through the existing `settleInvoiceIfCovered`. Entitlements follow the existing
  `pendingBankPaymentPolicy` (default: nothing granted while pending). Only PaymentIntents we created
  (`metadata.origin=autopay`) are handled; hosted Checkout payments keep using `checkout.session.*`.
- **Failures** (`afterAutopayFailure`, run once per failed attempt, from the sync decline or the webhook):
  - Card: the existing `classifyDecline`. "Card needs updating" → no retry, high task. Retryable or unknown → retried after
    `cardRetryDays` (setting; sample default 3 and 7 days), then a high task.
  - Bank: insufficient funds → one retry after `achRetryWaitDays` (setting; sample default 5). Account closed, no account,
    not authorized, authorization revoked, restricted → the method is marked `failed`, never retried, and the family is
    asked for a new one. Anything else → staff task, no retry.
  - **No message is sent.** Families see notices under Payment Methods and the Failed / Returned status under Bills; staff
    get deduped tasks.
- **Late return** (a dispute on a bank debit after the bill was paid): the existing dispute machinery records the
  reversal entry; `invoiceMoney` now deducts bank-debit disputes (net of a won dispute) from settled money, the invoice
  is reopened (`paid` → `open`, audited) and staff get a follow-up. Credits are not auto-revoked (existing rule). It is
  not retried automatically. Card disputes behave exactly as before.
- **Bank pay discount** (`settings.autopay.bankPayDiscount`, **off by default**): fixed amount or percent per monthly
  bill when the autopay method is a bank account at issue time. It is added to the invoice discount and named in the
  invoice memo ("Bank pay discount: $5.00 off…") plus a `bank_pay_discount` membership event. Invoice lines cannot be
  negative in this ledger, so it is not a separate line. There is no card surcharge feature.
- **Fees.** After a Stripe charge settles, job `billing.record_fee` reads the fee from Stripe and stores it on the
  charge (`transactions.fee_minor`, `fee_reported_at`). Unknown stays unknown: `fee_reported_at` null. Report
  **Processing fees by payment method** (`/reports/processing-fees`, CSV through the reports export) shows, per month
  and method: payments, collected, fees reported, fee rate (only when every payment has a reported fee), payments with no
  fee yet, and an estimate column that is empty unless the owner typed estimate rates in Settings.
- **Query functions for other modules** (the scoreboard page was not edited):
  - `expiringCards(tx, orgId, { today?, withinDays? = 60 })` → active cards whose expiry month ends within the window.
    Also listed on Settings, Payments and agreements.
  - `autopayOffMembershipIds(tx, orgId)` and `AUTOPAY_READY_SQL`: "autopay off" = live Teamwork-invoiced membership with
    autopay off **or** no active saved method. The scoreboard's `autopay_off` row SQL now uses it (definition bumped to
    version 2 with the change explained). With no saved methods the listed memberships are the same as before.
  - `processingFeesByMonth(tx, orgId, { from?, to? })`, `failedAutopayNotices`, `listMethodViews`.

## Membership agreement

- **Template kind** `membership_agreement` (Documents, Templates). Body uses `{{merge_fields}}`; publishing refuses unknown
  fields and fill-in fields. The seeded/"create sample" template is **SAMPLE TEXT for a lawyer to replace, not legal
  advice**, and carries the existing sample label on screen and on the PDF until an owner/admin marks approved text.
- **Merge fields** (`MERGE_FIELDS`, listed in Settings): organization, member, payer(s) allowed to pay, plan, sessions per
  week, price, price after discount, billing day, start date, partial first month amount/date/period, first regular bill
  date, commitment length and end date, end of term, hold rules, cancellation notice, family discount, late/declined
  payment terms, payment method, and the recurring ACH authorization (only when autopay is a bank account; otherwise it
  renders "Not applicable…"). Every value is computed from the membership, its immutable product version, the membership
  policy and the autopay settings (`buildAgreementTerms`). The connecting sentences in `mergeValues` are sample wording.
- **Snapshot.** The rendered text and merge values are stored on the form request when it is issued
  (`rendered_body_markdown`, `merge_values`); a DB trigger refuses any later change. The signature covers the SHA-256 of
  that text through the existing data hash (`_agreement` in the frozen submitted data); the verify view re-checks it and
  the PDF prints the rendered text. Later price, policy or template edits never change a signed agreement.
- **Link.** `membership_agreements` ties the request to the membership and product version, with the terms snapshot and
  reason. A superseded signed agreement stays on file.
- **When a new signature is required** (org setting `agreements.resignOn`, Settings, Payments and agreements):

  | Trigger | Fires when | Default |
  |---|---|---|
  | `plan` | the membership moves to a different product | on |
  | `price` | price, currency or interval of the plan version changes (a new price version or another plan) | on |
  | `sessions` | sessions per week / unlimited changes | on |
  | `commitment` | commitment months or end date changes | on |
  | `bank_debit` | autopay becomes a bank account and the signed copy has no ACH paragraph | on |
  | `billing_day` | the billing day changes | off |
  | `discount` | the membership's discount or net price changes (the family discount comes and goes) | off |

  Checked on: immediate plan change, a scheduled plan change applied by the renewal job, autopay on/off/method change, and
  the staff "Re-issue" button. A new template version published with "require re-signing" re-renders every open (unsigned)
  agreement. While an agreement is still unsigned, any change in terms re-renders it rather than stacking requests.
  **Not automatic:** a commitment ending and rolling to month-to-month does not change the stored terms, so it does not
  trigger; a change of the default payment method without touching autopay is picked up at the next check.
- **Awaiting agreement.** `memberships.agreement_state` (`not_required` | `awaiting` | `signed`). Settings:
  `blockReservationsUntilSigned` (default on; enforced in `checkEligibility` next to required forms) and
  `billingWaitsForSignature` (default off: bills go out as scheduled; when on, the first bill is not issued and the renewal
  job skips the membership until it is signed). Staff see unsigned agreements on Settings, Payments and agreements; the
  pending request feeds the existing journey step "Documents signed" and the membership audit conflict
  "billed while unsigned documents block booking" (which the scoreboard's "Needs a decision" counts). No new list page.
- Identity step-up: `membership_agreement` joined the default kinds that require it (emailed code, MFA session or staff
  in person). Until email delivery is configured, families cannot self-sign and the front desk witnesses the signature.

## One sign-up flow (`/billing/signup`)

Steps: plan → review and sign → how you will pay → confirm. State is derived from the linked records, so every step can be
left and resumed; one open flow per athlete (starting again returns it), shared by the parent and the front desk.

1. **Plan** (new members): active recurring plans with a version in effect today (`publishedPlans`; the unused
   `products.publicly_listed` flag is not consulted), family discount shown when another athlete on the account is
   enrolled, pending referral new-family discount shown. Choosing creates the membership `pending`, `awaiting`, **first
   bill deferred**, and issues the agreement plus any required waivers not already valid. Re-choosing the same plan is a
   no-op; changing it before signing cancels the unbilled pending membership.
2. **Sign**: links to the existing signing page (with a way back). Waivers are the existing required forms.
3. **Pay**: add a card / bank account (Stripe-hosted), choose a saved method for automatic payments, or "pay each bill
   myself". Not configured → honest notice and only the manual choice. Staff see a QR code and never enter payment details.
   Choosing a bank account after signing triggers the `bank_debit` re-sign (the flow steps back to Sign).
4. **Confirm**: shows the first bill amount and date. Finishing issues the deferred first bill if due (a partial first
   month always; a full first month only once the start date has arrived). With autopay on, the charge for a bill due
   today is queued through the normal autopay job. Nothing else is charged in the flow.

**Zen Planner conversion.** For an athlete whose live membership is `external_zenplanner` the same flow collects the new
agreement, waivers and a payment method; nothing is billed. Finishing creates a "Ready to cut over" task. **Cut over** now
requires, besides the existing "Zen Planner charge stopped" tick and a first bill date of today or later: a signed
agreement **and** an active saved method (autopay is then switched on). Staff can cut over without them only with a
written reason (audited), for example a family that pays at the front desk or while Stripe is not connected. Imported
memberships are still never invoiced before cutover, and the first Teamwork bill is issued once, on the chosen date.

**Moving saved cards out of Zen Planner.** This app does not and cannot move card or bank details out of Zen Planner's
processor. That is a processor-to-processor import the owner must request (Stripe's Data Migrations team with the current
processor's cooperation; see `billing.md`). The alternative, which this flow supports, is each family entering their
card or bank account once on Stripe's page during sign-up.

## CSP

`form-action` additionally allows `https://checkout.stripe.com` on `/billing/payment-methods` and `/billing/signup/<id>`
only (the two pages with the "Add a card / bank account" form). No script, frame or connect source was added; Stripe.js
is not loaded. Covered by `tests/health-csp.test.ts`.

## What is verified, and how

**Verified locally (vitest, mocked `fetch`, locally signed webhook fixtures; 38 tests in 3 files, plus edits to 3 existing
files):** activation only by verified webhook (forged event rejected, browser return inert); duplicate, concurrent and
out-of-order deliveries; microdeposit wait; mandate acceptance and text version stored; nothing sensitive stored including
the raw event log; customer mismatch; removal rules; permissions for every demo role; autopay idempotency (re-issue,
repeat, 4 concurrent, stale attempt number, crash resume); ACH pending → succeeded and pending → failed; late return
reopening a paid invoice; card and ACH decline sorting and retry schedule; fee recording and the by-month query; bank pay
discount; merge fields against hand-built memberships; snapshot immutability (policy edit, template edit, direct SQL, PDF
text, verify view); re-sign triggers and settings; awaiting-agreement eligibility and billing-waits; the sign-up flow
(resume, idempotency, authz, nothing charged); cutover requiring agreement + method and billing exactly once; not-configured.

**Verified in a browser (Playwright, production build, desktop and 390px):** the sign-up flow in not-configured mode
(`e2e/signup.spec.ts`, 8 tests) and axe checks on `/billing/signup`, `/settings/payments`, `/reports/processing-fees`,
`/billing/payment-methods`. There is no fake-provider browser mode in this app, so no browser test saves a method.

**Unverified against Stripe (needs test keys):**
- A real setup: Checkout `mode=setup` accepting our parameters, the events actually sent and their order, whether
  `payment_method.attached` is delivered for Checkout setups (activation waits for it), and the mandate id on the SetupIntent.
- A real off-session charge: request acceptance, the decline error shape, `payment_intent.*` payload fields.
- ACH timing (the 4 business days), the microdeposit email + hosted page, ACH failure and dispute reason codes.
- Financial Connections instant verification (may need activation and has its own pricing).
- Fee reporting: the expand path and when the balance transaction becomes available.
- Webhook endpoint event selection: the endpoint must subscribe to `setup_intent.*`, `payment_method.*`, `mandate.updated`,
  `payment_intent.processing/succeeded/payment_failed/canceled`, `charge.succeeded/updated`, `charge.dispute.*`,
  `checkout.session.completed/expired` in addition to what `billing.md` lists.

## Known gaps

- No staff "charge now" / "retry now" button; retries are automatic or the family pays with Pay Now.
- The bank pay discount is decided when the bill is issued; if that bank charge fails and the bill is paid another way
  the discount stays.
- Bank-debit disputes reopen the bill; a later `won` dispute re-settles it, but ACH disputes are normally final.
- Removing a method when Stripe is not configured only marks it removed locally (said plainly to the user).
- The flow page `/billing/signup/<id>` is not in the a11y sweep's dynamic list (the sweep's guardian has no open flow);
  it is exercised by `e2e/signup.spec.ts` but not by axe.
- Families must return to the flow page after signing (a link is shown on the document); there is no automatic redirect.
- Payment methods saved outside this flow (Stripe dashboard) are picked up only if the customer is one we created.
- `webhook_events` still has no org column (see `billing.md`); payer lookup by Stripe customer assumes one org per account.
