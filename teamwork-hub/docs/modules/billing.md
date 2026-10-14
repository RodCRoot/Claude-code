# Billing module — memberships, invoicing, payments, ledger, refunds/disputes, reconciliation, POS

Owner paths: `src/app/(app)/billing/**`, `src/app/api/webhooks/**`, `src/app/api/payments/**`,
`src/lib/billing/**`, `src/lib/payments/**`, `scripts/seed/billing.ts`, `tests/billing*.test.ts`,
`tests/fixtures/payments/**`.

## Provider research (2026-10-12)

Evidence levels: **verified** = read on the official page during this build; **partial** = some facts
verified, others not; **unverified** = from prior knowledge, not re-checked. No provider API was called
with credentials (none exist).

| Fact | Evidence | Source |
|---|---|---|
| Stripe signs webhooks with `Stripe-Signature: t=…,v1=…[,v0=…]`; `v1` = HMAC-SHA256 of `` `${t}.${rawBody}` `` with the `whsec_` endpoint secret; only `v1` is valid (ignore others to prevent downgrade); compare in constant time; multiple `v1` during secret roll | verified | https://docs.stripe.com/webhooks |
| Libraries default to a 5-minute timestamp tolerance; don't use 0; retries get a fresh `t`/signature | verified | https://docs.stripe.com/webhooks |
| Raw body required; events may be duplicated and arrive out of order; dedupe on event id; don't use `created` for ordering; live retries up to 3 days | verified | https://docs.stripe.com/webhooks |
| Checkout fulfilment must be webhook-driven (`checkout.session.completed`; delayed methods later send `checkout.session.async_payment_succeeded` / `_failed`); `payment_status` `unpaid` means not yet paid; fulfilment must be idempotent and safe concurrently; landing page alone is not reliable | verified | https://docs.stripe.com/checkout/fulfillment |
| ACH Direct Debit: delayed notification, up to 4 business days (T+4; T+2 for eligible); US customers, USD; can fail after success (then arrives as a dispute); disputes up to 60 days, single round; full refunds only, async ≤3 business days; recurring supported; Checkout collects the mandate | verified | https://docs.stripe.com/payments/ach-direct-debit |
| Subscriptions: statuses `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`; provision on `invoice.paid`; `invoice.payment_failed` for failures; with ACH a subscription can go straight to `active` while the PaymentIntent is `processing` | verified | https://docs.stripe.com/billing/subscriptions/overview |
| `Idempotency-Key` header, ≤255 chars, keys may be pruned after ≥24h, mismatched params on reuse error | verified | https://docs.stripe.com/api/idempotent_requests |
| Data migration: new customers first, then existing; PAN import from another processor only through Stripe's Data Migrations team, with customer records + payment data | verified | https://docs.stripe.com/get-started/data-migrations |
| `charge.refunded` carries cumulative `amount_refunded`; `charge.dispute.*` and `payout.paid` payload fields | unverified (field names) | Stripe API reference |
| PayPal webhooks: headers `paypal-transmission-id/-time/-sig`, `paypal-cert-url` (+ `paypal-auth-algo`); postback to `/v1/notifications/verify-webhook-signature` with `webhook_id` and the event "posted back exactly as it was received", or self-verify via CRC32 + cert; postback unsupported for mock events | verified | https://developer.paypal.com/api/rest/webhooks/rest/ |
| PayPal `verification_status` enum `SUCCESS` / `FAILURE` (required field of the verify response) | verified (OpenAPI schema, 2026-10-12) | https://developer.paypal.com/api/webhooks/v1/schema.json |
| Orders v2: `POST /v2/checkout/orders`, capture `POST /v2/checkout/orders/{id}/capture`; `intent` CAPTURE/AUTHORIZE; order statuses CREATED/SAVED/APPROVED/VOIDED/COMPLETED/PAYER_ACTION_REQUIRED; capture statuses COMPLETED/DECLINED/PARTIALLY_REFUNDED/PENDING/REFUNDED/FAILED, pending reasons incl. ECHECK; `PayPal-Request-Id` header for idempotency; `payment_source.venmo` exists | verified (OpenAPI schema) | https://developer.paypal.com/api/orders/v2/schema.json |
| `PayPal-Request-Id` retention window | unverified | — |
| PayPal Subscriptions bills at regular intervals; overview page does not list funding sources | partial | https://developer.paypal.com/docs/subscriptions/ |
| Pay with Venmo: US merchants + US buyers, **USD only**, **must use the JavaScript SDK**, buyer needs the Venmo app (mobile Safari iOS / Chrome Android; desktop QR); "Save Venmo during purchase" Yes, "Save Venmo for purchase later" **No**; recurring/subscriptions not mentioned | verified | https://developer.paypal.com/docs/checkout/pay-with-venmo/ |
| Vaulted Venmo: US only, eligibility review, later orders without the vault attribute for "subsequent or recurring transactions"; Venmo not fully supported in sandbox; RDA data needed; merchant-initiated recurring not described; Subscriptions API not mentioned | partial | https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/js-sdk/venmo/ |
| PayPal refunds `POST /v2/payments/captures/{id}/refund`; `CUSTOMER.DISPUTE.*`, `PAYMENT.CAPTURE.*` event names | unverified | — |

### Provider subscriptions & Venmo SDK research (2026-10-12, second pass)

Read with WebFetch / the published OpenAPI files during this build. No account, key or sandbox was used.

| Fact | Evidence | Source |
|---|---|---|
| Checkout Session `mode=subscription` takes recurring Prices in `line_items` (max 20 recurring); a Customer is created automatically in subscription mode; `customer_email` prefills; `client_reference_id` ≤200 chars; `metadata` | verified | https://docs.stripe.com/api/checkout/sessions/create |
| `subscription_data.metadata`, `subscription_data.description` (≤500), `subscription_data.billing_cycle_anchor` = "a future timestamp to anchor the subscription's billing cycle", `subscription_data.proration_behavior` `create_prorations`/`none` "resulting from the billing_cycle_anchor", `trial_end` ≥48h ahead | verified | https://docs.stripe.com/api/checkout/sessions/create?query=subscription_data |
| That `billing_cycle_anchor` + `proration_behavior=none` makes Checkout charge nothing until the anchor (first invoice $0) | **unverified** (inferred from the parameter text) — we ignore $0 provider invoices either way | — |
| Prices: `lookup_key` ≤200 chars, `product_data` creates the product inline, `recurring.interval`/`interval_count`; list prices filters by `lookup_keys` (≤10) | verified | https://docs.stripe.com/api/prices/create, https://docs.stripe.com/api/prices/list |
| Subscription object: status enum `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`; `cancel_at_period_end`, `cancel_at`, `metadata`; **`current_period_start/end` live on `items.data[]`** | verified | https://docs.stripe.com/api/subscriptions/object |
| Update subscription: `cancel_at_period_end` "cancel at the end of the current period"; `cancel_at` timestamp or `min_period_end`/`max_period_end` | verified | https://docs.stripe.com/api/subscriptions/update |
| Invoice: `parent.subscription_details.subscription` and `.metadata` ("immutable snapshot of the subscription metadata at the time of invoice finalization", invoices on/after 2023-06-29); `billing_reason` enum incl. `subscription_create`/`subscription_cycle`; line `period` gives the service period; `amount_paid`; `payments` (not `payment_intent`) on current API versions | verified | https://docs.stripe.com/api/invoices/object |
| Subscription events: `customer.subscription.created` (may be `incomplete`), `.updated`, `.deleted` ("subscription ends"), `.paused`/`.resumed`; `invoice.paid` → provision; `invoice.payment_failed`; `invoice.payment_action_required` (customer authentication); `past_due` → ask payer to update details; `canceled`/`unpaid` → revoke; `canceled` is terminal; `incomplete_expired` never bills; retries governed by Dashboard settings / Smart Retries | verified | https://docs.stripe.com/billing/subscriptions/webhooks |
| Refund/dispute → subscription mapping on API ≥ `2025-03-31.basil` needs the Invoice Payments API (charges no longer carry `invoice`) | verified (not implemented: subscription refunds/disputes go to staff via the existing charge path only when the provider txn id matches) | https://docs.stripe.com/billing/subscriptions/webhooks |
| PayPal Subscriptions v1 endpoints: `POST /v1/billing/plans`, `POST /v1/billing/subscriptions`, `GET /v1/billing/subscriptions/{id}`, `POST /v1/billing/subscriptions/{id}/cancel` (204; body `reason` required), `/suspend`, `/activate`; `PayPal-Request-Id` on create calls, "The server stores keys for 72 hours" | verified (OpenAPI schema) | https://developer.paypal.com/api/subscriptions/v1/schema.json |
| Plan: required `product_id`, `name`, `billing_cycles`, `payment_preferences`; cycle `frequency.interval_unit` DAY/WEEK/MONTH/YEAR + `interval_count`, `tenure_type` REGULAR/TRIAL, `sequence`, `total_cycles` 0 = infinite; `pricing_scheme.fixed_price {value,currency_code}`; `payment_preferences` defaults `auto_bill_outstanding=true`, `payment_failure_threshold=0` | verified (OpenAPI schema) | same |
| Subscription: `plan_id` required; `custom_id` ≤127 chars; `start_time`; `subscriber.email_address`; `application_context` (return/cancel URL, `user_action` SUBSCRIBE_NOW) is marked **DEPRECATED**; statuses `APPROVAL_PENDING`, `APPROVED`, `ACTIVE`, `SUSPENDED`, `CANCELLED`, `EXPIRED`; `billing_info.next_billing_time`, `last_failed_payment` | verified (OpenAPI schema) | same |
| Create-subscription response link `rel: "approve"` | **unverified** (not in schema/guide; the guide documents the JS SDK `createSubscription` button flow instead) | https://developer.paypal.com/docs/subscriptions/integrate/ |
| Catalog product: `POST /v1/catalogs/products`, required `name`, `type` PHYSICAL/DIGITAL/SERVICE | verified (OpenAPI schema) | https://developer.paypal.com/api/catalog-products/v1/schema.json |
| Webhook names `BILLING.SUBSCRIPTION.CREATED/ACTIVATED/UPDATED/EXPIRED/CANCELLED/SUSPENDED/PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED` ("a payment is made on a subscription"), `PAYMENT.SALE.REFUNDED/REVERSED` | verified | https://developer.paypal.com/api/rest/webhooks/event-names/ |
| `PAYMENT.SALE.COMPLETED` resource fields `id`, `billing_agreement_id`, `amount.total`, `amount.currency` | **unverified** (no schema/sample on the pages read) | — |
| PayPal subscription funding sources: guide names PayPal and debit/credit cards; Venmo not mentioned; v6 SDK reference lists a PayPal subscription session but no Venmo subscription session | verified (absence) | https://developer.paypal.com/docs/subscriptions/integrate/, https://developer.paypal.com/sdk/js/reference/ |
| Venmo button: SDK `https://www.paypal.com/sdk/js?client-id=…&enable-funding=venmo`; "Venmo is available in the US only"; mobile experience needing the Venmo app; sandbox needs `buyer-country=US` (sandbox only) | verified | https://developer.paypal.com/docs/checkout/pay-with-venmo/integrate/, https://developer.paypal.com/sdk/js/configuration/ |
| Standalone button: `paypal.Buttons({ fundingSource: paypal.FUNDING.VENMO })`, render only if `button.isEligible()` | verified | https://developer.paypal.com/docs/checkout/standard/customize/standalone-buttons/ |
| SDK `createOrder` returns an order id from the server; `onApprove(data.orderID)` captures on the server (v5 standard flow). The v6 SDK documents `onApprove` "capture or authorize the payment on your server" with `data.orderId` | partial (v6 verified; the v5 callback names we use are from prior knowledge + standalone-buttons sample) | https://developer.paypal.com/sdk/js/reference/ |

**Venmo decision:** Venmo recurring for memberships is **not verified**, so the UI never offers it for
recurring billing. The verified recurring alternatives are Stripe Billing (card / ACH) and PayPal
Subscriptions. Venmo is one-time only, through the PayPal JS SDK button page
`/billing/invoices/[id]/venmo` (see "Venmo checkout" below); the redirect adapter still refuses and points
there. The same matrix appears in the UI at `/billing/providers` (`src/lib/payments/{stripe,paypal,index}.ts → capabilities()`).

## Design

- **Catalog.** `products` and immutable `product_versions`. A price or terms change creates a new version.
  The previous open-ended version is closed the day before the new one starts. A DB trigger (`0002`)
  rejects any edit to a version's terms or its deletion; only `effective_to` may be set. Sibling
  discount %, trial, commitment, notice, credits/period, expiry and unlimited are stored on the version.
- **Memberships.** `billing_provider` is one of:
  - `manual`: Teamwork Hub invoices each period. The payer can pay online or offline.
  - `none`: complimentary.
  - `stripe` / `paypal`: provider subscriptions (see "Provider subscriptions" below). Linked through `provider_subscription_id` only by a verified webhook; never renewed by Teamwork.
  - `external_zenplanner`: imported. These are **never** invoiced, renewed, plan-changed or cancelled here.

  Holds pause renewals and credit grants; a period whose start falls inside a hold is deferred to the
  day after the hold. Plan changes take effect now or are scheduled for the first renewal on or after the
  effective date. Cancellation date = max(request + notice, end of commitment + 1 day). Staff can override it
  only with a reason, and the override is audited. Every change writes `membership_events`. See "Teamwork
  membership policies" below for anchoring, stubs, holds, in-season and the family discount.
- **Renewal job** `billing.generate_renewals` (`src/lib/billing/renewals.ts`). It locks due memberships
  with `FOR UPDATE SKIP LOCKED`. Each period is idempotent through the unique
  `(membership_id, period_start)` index and the invoice idempotency key `membership:<id>:<periodStart>`.
  The job then syncs statuses: on_hold, cancelled at `cancel_at`, and past_due when an open invoice is
  past its due date.
- **Invoices.** Numbers come from a per-org sequence (`TW-000001`) under an advisory lock. Totals are
  computed server-side. Balance = total − settled money, **derived from `transactions`**. Pending money
  is shown separately and is never counted as paid. An invoice moves to `paid` only when settled money
  covers it. Entitlements then apply: credits through `grantCredits` with
  `sourceInvoiceLineId` + `invoice-line:<id>`, so a grant happens at most once. Membership activation
  happens at the same point.
- **Payments.** The adapter interface lives in `src/lib/payments/provider.ts`, with Stripe, PayPal, Venmo and
  Manual implementations. Checkout is created on the server. The amount is the invoice balance. The
  idempotency key is `checkout:<attemptId>`. An open attempt for the same amount is reused. Live keys are
  refused unless `APP_MODE=production`. Without credentials no attempt is created and the UI shows
  `<NotConfigured>`.
- **Return URL** `/api/payments/return` is read-only and shows "We're confirming your payment". For PayPal
  it may request a capture, but records still change only on a verified webhook.
- **Webhooks** (`src/lib/billing/webhooks.ts`):
  1. Verify the raw body. A rejection is recorded as `rejected:<uuid>`, so a forged delivery can never claim the real event id.
  2. Insert into `webhook_events`. The unique `(provider, event id)` makes duplicates no-ops.
  3. Process under a row lock in one transaction.
  4. Attempt states are monotonic: terminal states never move, and in-flight states only move forward.
  5. An amount or currency mismatch marks the attempt `failed`/`amount_mismatch`, creates a high-priority task, and grants nothing.
  6. A refund or dispute that arrives before its charge raises `DeferError`. The event is retried through job `billing.reprocess_webhook` with backoff, up to 8 times, and then marked failed.
  7. Stripe `charge.refunded` is cumulative, so only the delta is recorded.
- **Pending bank payments.** These are written as a `pending` transaction. Org setting `pendingBankPaymentPolicy`:
  - `grant_on_settlement` (default): nothing is granted until the payment settles.
  - `grant_on_pending`: entitlements are granted at pending. If the payment later fails, a task is created.
- **Manual payments.** Allowed methods are cash, check, personal Venmo, Zelle and other. A reference and the recording user are required. These are always `staff_attested`; DB CHECK constraints make it impossible for a manual row to be `provider_verified` or unattributed. A manual payment is refused while provider money is pending, to prevent double collection.
- **Refunds.**
  - Requires `billing.refund` (owner/admin).
  - Manual payments, or the "offline" option, are recorded as staff_attested with a reference.
  - Provider refunds go through the adapter with an idempotency key. If the provider is not configured the refund is recorded as `blocked_config` and nothing is sent.
  - Money entries are written only on the verified refund webhook.
  - **Credits are never auto-revoked**; a deduped staff task is created.
- **Disputes.** These create a `dispute` reversal transaction (−amount). A `won` close adds a `dispute_reversal` (+amount). An urgent task is created.
- **Reconciliation** (`/billing/reconciliation`) shows:
  - verified vs attested vs pending totals, and totals by method;
  - pending payments older than `pendingAlertDays` (default 5);
  - open or failed attempts;
  - webhook events, including unmatched/rejected/failed ones;
  - refunds, disputes and payouts;
  - invoice-vs-ledger mismatches.
- **POS.** Counter sales of non-membership products. Sales use a walk-in payer account, or a payer +
  athlete when credits are involved. Tracked stock is checked under product row locks.
  `inventory_movements` records receive, adjust (note required), return and sale.

## Teamwork membership policies (`src/lib/membership-policy.ts`)

Values live in `organizations.settings.membershipPolicy` (defaults + provenance in `membership-policy.ts`;
owners/admins edit them at Settings → Membership policy, where values listed in `unconfirmed` show a
"Needs confirmation" badge until confirmed). Migration `0012_bill_membership_policy` (additive) adds
`product_versions.classes_per_week`, `memberships.kind/commitment_starts_on/commitment_ends_on`, hold request
fields (`requested_on`, `request_channel`, `override_reason`, `kind`, `related_membership_id`,
`makeup_bucket_id`), CHECKs, and keeps the product-version immutability trigger covering the new column.
Tests: `tests/billing-membership-policy.test.ts`.

- **Weekly class caps.** A version with `classes_per_week` resolves to entitlement `weekly`. `bookSession` /
  waitlist promotion lock the membership row and count the athlete's membership-paid bookings
  (booked/attended/no-show; cancelled never) in the ISO week, Monday 00:00 → next Monday 00:00 in facility time
  (DST-safe). Over the cap: use session credits if any, else refuse with "Maya's 2x/week plan already has 2
  sessions booked the week of Mar 2." Staff can pass `capOverride {reason}` (audited). Bookings it covers have
  `entitlement_source = 'membership'`.
- **Billing on the 1st + stub.** Monthly plans anchor to `billingAnchorDay` (1st); never the start day. A
  mid-month start (or a restart after a hold) bills a stub from that day to the day before the next anchor,
  priced by `prorationMethod` (`computeStub`). Staff see `previewMembershipStart` before confirming on
  /billing/memberships and can override the stub amount with a reason (audited). Weekly plans (College) bill
  every 7 days from the start, no stub.
- **Commitments.** `commitment_starts_on` = first full period (the 1st after a stub); `commitment_ends_on` =
  start + months − 1 day. After it, the membership keeps its version (committed rate), the renewal job records
  `commitment_ended` once, and cancellation only needs notice. Nothing ever creates a new commitment.
- **Holds.** Firm restart date required; start may be backdated only to `requestedOn` (date the family sent
  it; channel recorded). Cap `holdMaxMonthsPerMembershipYear` × 31 days per membership year (anniversary of
  start); override needs a reason. A hold is never a cancellation. Already billed: if the invoice for the
  period containing the request date was paid before the request, the money is kept and unused sessions
  (cap × days/7 from the request date to period end, minus attended/no-show) become a `hold_makeup` credit
  bucket usable from the restart date and expiring `punchCardExpiryMonths` after issue. Automatic only for
  ≥12-month commitments that are active; otherwise a staff task (staff can grant with a reason).
- **Makeup rule.** `hold_makeup` credits can only be spent on a day the athlete has a live, not-held
  membership (`activeMembershipOnDay`, enforced in `resolveEntitlement` and credit reservation).
- **In season.** `startInSeason`: an `in_season` hold pauses the regular membership and a new `kind='in_season'`
  membership with explicit start/end (`cancel_at` = end + 1, DB CHECK) bills for the window, then expires.
  Regular billing resumes the day after; its commitment is unchanged. 12-month members are capped at
  `inSeasonMaxMonthsPer365Days` × 31 days in any rolling 365-day window (override with reason).
- **Cancellation.** Effective = max(request + notice, commitment end + 1); notice = version's own if set,
  else policy (30). Channel recorded. `cancellationPreview` shows effective date, last bill date, remaining
  periods/amount and open balance (membership page).
- **Family discount.** `syncFamilyDiscount` runs on create, immediate cancel and when the renewal job ends a
  membership: 2+ athletes with live memberships on one payer account → "Family discount N%" on each
  Teamwork-billed membership; below 2 → removed. Other discounts are never replaced; provider-billed ones get a
  task. Events + audit for every change.
- **Restart nudges.** Each hold / in-season term enqueues `automation.evaluate` (trigger
  `membership_restart_upcoming`, deduped `restart_nudge:<holdId>`, run at restart − `restartNudgeDaysBefore`,
  09:00 local) plus a deduped staff task. Families are messaged only if an enabled automation rule exists;
  delivery stays gated by messaging rules.
- **Declines.** `classifyDecline` (`src/lib/billing/declines.ts`) maps provider codes/messages to "card needs
  updating" vs "retryable"; payment exceptions show the label and the app-first family text (sample wording).

## Exported for other modules

- `paymentExceptions(tx, orgId, { today?, limit? })` → `PaymentException[]`, for the staff dashboard (`src/lib/billing/reconciliation.ts`).
- `billingJobHandlers(db?)` → handlers for `billing.generate_renewals` and `billing.reprocess_webhook` (`src/lib/billing/jobs.ts`). **The worker must register them.**
- `scheduleRenewals(tx, orgId, today)`: enqueues the daily renewal run, deduped per org per day.
- `createInvoiceRecord`, `settleInvoiceIfCovered`, `applyInvoiceEntitlements`, `invoiceMoney`: for bookings that need to bill (source `booking`).
- `viewablePayerIds`, `payablePayerIds`, `assertCanViewPayer`, `assertCanPayPayer` (`src/lib/billing/access.ts`).

## Zen Planner cutover plan

1. Imported memberships are created as `external_zenplanner` (Zen Planner keeps charging). They are excluded from renewals, checkout, invoicing, plan changes and cancellation.
2. Connect Stripe in sandbox and verify webhooks end to end (`stripe listen --forward-to …/api/webhooks/stripe`).
3. For each member, pick the first date Zen Planner will **not** bill, and stop the Zen Planner recurring charge.
4. On the membership page, use **Cut over**. It requires ticking "Zen Planner charge stopped" and a first bill date of today or later. Billing switches to `manual` and the anchor is set to that date. The step is audited and recorded as an event.
5. Payment details cannot be exported by us. Payers re-enter them on hosted checkout, or Rod arranges a PAN migration through Stripe's Data Migrations team.

## Provider subscriptions (Stripe Billing / PayPal Subscriptions)

Code: `src/lib/billing/subscriptions.ts` (domain + webhook application), adapters `stripeSubscriptions` /
`paypalSubscriptions` behind `SubscriptionProviderAdapter` (`src/lib/payments/provider.ts`), UI card
`src/app/(app)/billing/memberships/[id]/_billing-method.tsx`. Tests: `tests/billing-subscriptions.test.ts`
with fixtures in `tests/fixtures/payments/subscriptions.ts` (mocked `fetch`; signed Stripe fixtures; PayPal
verification answered by a mocked verify-webhook-signature call).

1. **Start (staff, `billing.manage`).** Allowed only for a live, Teamwork-invoiced (`manual`) membership with a
   next bill date, no scheduled cancellation, no current/upcoming hold and no other open request. Without
   credentials nothing is written and the card shows `<NotConfigured>`. Otherwise:
   - A `provider_subscription_requested` membership event is written first (`requestId`, amount, first charge date).
   - Price/plan per **product version × net period price × currency**, cached in `provider_plans`.
     Stripe: looked up by `lookup_key = twhub:<org>:<version>:<amount>:<currency>`, else created with
     `product_data`. PayPal: catalog product + ACTIVE plan (`total_cycles: 0`).
     Idempotency key `plan:<org>:<version>:<amount>:<currency>` (PayPal adds `:product` / `:plan`).
   - Stripe: Checkout Session `mode=subscription`, `subscription_data.metadata {membership_id, request_id}`,
     `billing_cycle_anchor` = local midnight of the next Teamwork bill date (+`proration_behavior=none`) when
     that date is in the future. PayPal: `POST /v1/billing/subscriptions` with `custom_id = <membership>.<request>`,
     `start_time` = next bill date, approve link. Idempotency key `subscription:<requestId>`.
   - Staff share the approval link with the payer. **Nothing changes locally yet.**
2. **Link (verified webhook only).** The first signed event that names the subscription and matches an open
   request (metadata/custom_id, or the PayPal subscription id we got back) sets `billing_provider`,
   `provider_subscription_id` and `next_bill_date = NULL` under a row lock. Not linked, with a high-priority
   "cancel it at the provider" task: no request, a withdrawn/failed request, a membership already linked to
   another subscription, a non-`manual` or ended membership.
3. **Never billed twice.** The renewal job selects only `billing_provider='manual'` (now also reports
   `skippedProviderBilled`). DB CHECKs (`0005_bill_provider_billing_guard`): a stripe/paypal membership has
   `next_bill_date IS NULL` and a `provider_subscription_id`. `createInvoiceRecord` refuses provider-billed
   memberships except for the verified provider ingest. Holds, plan changes and the plain cancel are refused
   for provider-billed memberships (they would not change what the provider charges).
4. **Money.** `invoice.paid` / `PAYMENT.SALE.COMPLETED` → one local invoice (`<provider>-invoice:<id>`,
   period from the Stripe line period; for PayPal sales, the day after the last provider-paid period or the
   handed-over bill date), one `provider_verified` settled transaction (unique provider txn id), then the
   existing `settleInvoiceIfCovered` → `grantCredits` with `invoice-line:<id>` (credits from the product
   version) + membership activation. If Teamwork already invoiced that period, the money is applied to that
   invoice instead; if it was already settled a "paid twice — refund one" task is raised. Amount ≠ plan's net
   price → task (money is still recorded). $0 provider invoices are ignored (no period billed).
5. **Status sync.** `customer.subscription.*` / `BILLING.SUBSCRIPTION.*` map to local status
   (`active`, `trialing`, `past_due` incl. Stripe `unpaid` and PayPal `SUSPENDED`, `paused` → `on_hold`).
   `invoice.payment_failed` / `BILLING.SUBSCRIPTION.PAYMENT.FAILED` → `past_due` + task;
   `invoice.payment_action_required` → task. Ordering: each applied status records the provider event time
   (`provider_status` event); an older event is ignored. A failure for an invoice already paid is ignored.
   `cancelled`/`expired` memberships never change again. `incomplete_expired` with no provider payment hands
   billing back to Teamwork at the original date.
6. **Cancel at period end (Teamwork → provider).** Stripe `cancel_at_period_end=true`; PayPal `cancel`
   (no further cycles). Idempotency key `cancel:<membership>:<sub>`. `cancel_at` = day after the paid-through
   date; the membership runs to it and the daily status sync ends it. Notice/commitment terms still apply
   (override needs a reason). Unconfigured → refused, nothing sent.
7. **Switch back to Teamwork invoices.** Open request → withdrawn (a late approval is refused + flagged).
   Linked → provider stops at period end; on the provider's cancellation (Stripe `customer.subscription.deleted`,
   or immediately after PayPal's 204) the membership returns to `manual` with `next_bill_date` = day after the
   paid period, without being cancelled.

## Venmo checkout (`/billing/invoices/[id]/venmo`)

- Renders only when PayPal is fully configured (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`).
  The client id is passed to the page (it is public); the secret stays on the server.
- Loads `https://www.paypal.com/sdk/js?client-id=…&currency=USD&intent=capture&components=buttons&enable-funding=venmo`
  (+`buyer-country=US` in sandbox only) and renders `paypal.Buttons({ fundingSource: paypal.FUNDING.VENMO })`
  only if `isEligible()`; otherwise it explains the requirements.
- `POST /api/payments/venmo/order` (session + same-origin + `canPay`) creates the order server-side for the
  invoice balance (USD only), `PayPal-Request-Id = checkout:<attemptId>`, no `payment_source`.
- `POST /api/payments/venmo/capture` captures server-side; PayPal's capture response (authenticated
  server-to-server) goes through the same idempotent, amount-checked `applyPayment` path as a verified
  webhook (`applyVerifiedPayment`). `PENDING` stays pending; amount mismatch is never granted. The later
  `PAYMENT.CAPTURE.COMPLETED` webhook is a no-op (same capture id). The browser never reports "paid".
- One-time only; the page states US / USD / Venmo app requirements and that recurring Venmo isn't offered.

## Known gaps / needs credentials or production review

- **Provider subscriptions were never exercised against a sandbox.** Everything above is contract-tested
  against documented shapes only. Before go-live, in Stripe test mode / PayPal sandbox, verify:
  Checkout `billing_cycle_anchor` + `proration_behavior=none` really defers the first charge (and the $0
  first invoice is ignored); `invoice.paid` line `period` matches the handed-over bill date in facility time;
  `cancel_at_period_end` round trip; PayPal `approve` link rel, `application_context` (deprecated) still
  honoured for return URLs, `PAYMENT.SALE.COMPLETED` field names (`billing_agreement_id`, `amount.total`),
  `start_time` behaviour, and that `BILLING.SUBSCRIPTION.CANCELLED` arrives after our cancel call.
- Stripe subscription **refunds/disputes**: on API ≥ 2025-03-31.basil the invoice no longer carries
  `payment_intent`, so a subscription charge is recorded with the invoice id and a later `charge.refunded`
  (keyed by payment intent) will not match it; it is deferred, then marked failed and shown in
  Reconciliation for staff. Mapping via the Invoice Payments API is not implemented.
- PayPal sale periods are derived locally (sales carry no service period).
- Subscription plan changes, provider-side pause/hold and trials on provider subscriptions are not supported
  (refused with an explanation); the payer cannot self-start a subscription (staff create the link).
- Venmo SDK page: v5 SDK callbacks (`createOrder`/`onApprove(data.orderID)`) are used; PayPal now documents a
  v6 SDK. Needs a sandbox run on iOS Safari / Android Chrome with the Venmo app.

- No live or sandbox provider call was ever made. The Stripe and PayPal request shapes in `createCheckout`, `refund` and `capturePaypalOrder` follow the docs but **have not been exercised against a sandbox**.
- The PayPal refund and dispute event shapes, and the Stripe refund, dispute and payout field names are unverified. Validate them with sandbox fixtures before go-live. (`verification_status` SUCCESS/FAILURE is now verified from the OpenAPI schema.)
- Saved payment methods UI has not been built (the `payment_methods` table is unused).
- `webhook_events` has no `org_id`. Events are attributed through payment attempts. Payout routing assumes one org per provider account. Unmatched and rejected events are visible to every org's billing staff (they hold no customer data beyond the type and the claimed id).
- Tax is always 0. Partial refunds of ACH are not supported by Stripe; this is not enforced locally.
- Families cannot request holds or cancellations in-app (staff-only actions).
