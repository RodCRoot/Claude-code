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
| PayPal `verification_status == "SUCCESS"` response value | unverified | verify-webhook-signature API reference |
| Orders v2: `POST /v2/checkout/orders`, capture `POST /v2/checkout/orders/{id}/capture`; `intent` CAPTURE/AUTHORIZE; order statuses CREATED/SAVED/APPROVED/VOIDED/COMPLETED/PAYER_ACTION_REQUIRED; capture statuses COMPLETED/DECLINED/PARTIALLY_REFUNDED/PENDING/REFUNDED/FAILED, pending reasons incl. ECHECK; `PayPal-Request-Id` header for idempotency; `payment_source.venmo` exists | verified (OpenAPI schema) | https://developer.paypal.com/api/orders/v2/schema.json |
| `PayPal-Request-Id` retention window | unverified | — |
| PayPal Subscriptions bills at regular intervals; overview page does not list funding sources | partial | https://developer.paypal.com/docs/subscriptions/ |
| Pay with Venmo: US merchants + US buyers, **USD only**, **must use the JavaScript SDK**, buyer needs the Venmo app (mobile Safari iOS / Chrome Android; desktop QR); "Save Venmo during purchase" Yes, "Save Venmo for purchase later" **No**; recurring/subscriptions not mentioned | verified | https://developer.paypal.com/docs/checkout/pay-with-venmo/ |
| Vaulted Venmo: US only, eligibility review, later orders without the vault attribute for "subsequent or recurring transactions"; Venmo not fully supported in sandbox; RDA data needed; merchant-initiated recurring not described; Subscriptions API not mentioned | partial | https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/js-sdk/venmo/ |
| PayPal refunds `POST /v2/payments/captures/{id}/refund`; `CUSTOMER.DISPUTE.*`, `PAYMENT.CAPTURE.*` event names | unverified | — |

**Venmo decision:** Venmo recurring for memberships is **not verified**, so the UI never offers it for
recurring billing. The verified recurring alternatives are Stripe Billing (card / ACH) and PayPal
Subscriptions. Venmo is one-time only, and its checkout needs the PayPal JS SDK button page, which is
not built yet (the adapter refuses with an explanation even when PayPal is configured). The same
matrix appears in the UI at `/billing/providers` (`src/lib/payments/{stripe,paypal,index}.ts → capabilities()`).

## Design

- **Catalog.** `products` and immutable `product_versions`. A price or terms change creates a new version.
  The previous open-ended version is closed the day before the new one starts. A DB trigger (`0002`)
  rejects any edit to a version's terms or its deletion; only `effective_to` may be set. Sibling
  discount %, trial, commitment, notice, credits/period, expiry and unlimited are stored on the version.
- **Memberships.** `billing_provider` is one of:
  - `manual`: Teamwork Hub invoices each period. The payer can pay online or offline.
  - `none`: complimentary.
  - `stripe` / `paypal`: provider subscriptions. These are linked through `provider_subscription_id`, and `invoice.paid` is ingested for them.
  - `external_zenplanner`: imported. These are **never** invoiced, renewed, plan-changed or cancelled here.

  Holds pause renewals and credit grants; a period whose start falls inside a hold is deferred to the
  day after the hold. Plan changes take effect now or are scheduled for the first renewal on or after the
  effective date. Cancellation date = max(request + notice, start + commitment). Staff can override it
  only with a reason, and the override is audited. Every change writes `membership_events`.
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

## Known gaps / needs credentials or production review

- No live or sandbox provider call was ever made. The Stripe and PayPal request shapes in `createCheckout`, `refund` and `capturePaypalOrder` follow the docs but **have not been exercised against a sandbox**.
- The PayPal `verification_status` field name, the PayPal refund and dispute event shapes, and the Stripe refund, dispute and payout field names are unverified. Validate them with sandbox fixtures before go-live.
- Provider subscription creation (Stripe Billing / PayPal Subscriptions) is not implemented. Recurring memberships are invoiced by Teamwork each period and paid by one-time checkout or offline. `invoice.paid` ingestion for provider subscriptions exists but needs a subscription-creation flow.
- The Venmo SDK button page has not been built.
- Saved payment methods UI has not been built (the `payment_methods` table is unused).
- `webhook_events` has no `org_id`. Events are attributed through payment attempts. Payout routing assumes one org per provider account. Unmatched and rejected events are visible to every org's billing staff (they hold no customer data beyond the type and the claimed id).
- Tax is always 0. Partial refunds of ACH are not supported by Stripe; this is not enforced locally.
- Families cannot request holds or cancellations in-app (staff-only actions).
