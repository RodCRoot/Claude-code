import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, payerAccounts, users } from "./core";
import { bookings } from "./scheduling";

/** Money is always integer minor units + ISO currency. */
const minor = (name: string) => bigint(name, { mode: "number" });

export type ProductKind =
  | "recurring_membership"
  | "package"
  | "one_time"
  | "drop_in"
  | "assessment"
  | "camp"
  | "trial"
  | "retail";

export const products = pgTable("products", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<ProductKind>().notNull(),
  description: text("description"),
  category: text("category"),
  active: boolean("active").notNull().default(true),
  publiclyListed: boolean("publicly_listed").notNull().default(false),
  sku: text("sku"),
  trackInventory: boolean("track_inventory").notNull().default(false),
  isDemo: isDemo(),
  createdAt: createdAt(),
});

/**
 * Immutable price/terms version. Changing a price creates a new version with an
 * effective date; existing memberships keep pointing at the version they bought.
 */
export const productVersions = pgTable(
  "product_versions",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    version: integer("version").notNull(),
    priceMinor: minor("price_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    interval: text("interval").$type<"none" | "week" | "month" | "year">().notNull().default("none"),
    intervalCount: integer("interval_count").notNull().default(1),
    /** Credits granted per purchase / billing period. Null with unlimited=false means no credits. */
    creditsPerPeriod: integer("credits_per_period"),
    unlimited: boolean("unlimited").notNull().default(false),
    creditExpiryDays: integer("credit_expiry_days"),
    rolloverMax: integer("rollover_max").notNull().default(0),
    /** Service type ids these credits can be spent on; empty = any. */
    serviceTypeIds: jsonb("service_type_ids").$type<string[]>().notNull().default([]),
    trialDays: integer("trial_days").notNull().default(0),
    commitmentMonths: integer("commitment_months").notNull().default(0),
    cancellationNoticeDays: integer("cancellation_notice_days").notNull().default(0),
    /** e.g. { siblingPercentOff: 10 } — policy configured, not invented. */
    familyDiscount: jsonb("family_discount").$type<{ siblingPercentOff?: number }>().notNull().default({}),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("product_versions_uq").on(t.productId, t.version)],
);

export const discounts = pgTable("discounts", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").$type<"percent" | "fixed">().notNull(),
  value: integer("value").notNull(),
  code: text("code"),
  active: boolean("active").notNull().default(true),
});

export type MembershipStatus = "pending" | "trialing" | "active" | "on_hold" | "past_due" | "cancelled" | "expired";

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    payerAccountId: uuid("payer_account_id").references(() => payerAccounts.id),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => productVersions.id),
    status: text("status").$type<MembershipStatus>().notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextBillDate: date("next_bill_date"),
    billingAnchorDay: integer("billing_anchor_day"),
    cancelAt: date("cancel_at"),
    cancelReason: text("cancel_reason"),
    discountId: uuid("discount_id").references(() => discounts.id),
    /** Which system bills this membership. Imported Zen Planner memberships stay "external" until cutover. */
    billingProvider: text("billing_provider").$type<"stripe" | "paypal" | "manual" | "external_zenplanner" | "none">().notNull(),
    providerSubscriptionId: text("provider_subscription_id"),
    source: text("source").notNull().default("teamwork"),
    createdBy: uuid("created_by"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memberships_athlete_idx").on(t.athleteId), uniqueIndex("memberships_provider_sub_uq").on(t.providerSubscriptionId)],
);

export const membershipHolds = pgTable("membership_holds", {
  id: id(),
  membershipId: uuid("membership_id")
    .notNull()
    .references(() => memberships.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason"),
  requestedAt: ts("requested_at"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export const membershipEvents = pgTable("membership_events", {
  id: id(),
  membershipId: uuid("membership_id")
    .notNull()
    .references(() => memberships.id),
  type: text("type").notNull(),
  fromVersionId: uuid("from_version_id"),
  toVersionId: uuid("to_version_id"),
  effectiveOn: date("effective_on"),
  details: jsonb("details"),
  actorUserId: uuid("actor_user_id"),
  createdAt: createdAt(),
});

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: orgId(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    number: text("number").notNull(),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    currency: text("currency").notNull().default("USD"),
    subtotalMinor: minor("subtotal_minor").notNull().default(0),
    discountMinor: minor("discount_minor").notNull().default(0),
    taxMinor: minor("tax_minor").notNull().default(0),
    totalMinor: minor("total_minor").notNull().default(0),
    issuedAt: ts("issued_at"),
    dueDate: date("due_date"),
    paidAt: ts("paid_at"),
    membershipId: uuid("membership_id").references(() => memberships.id),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    source: text("source").$type<"teamwork" | "pos" | "membership_renewal" | "imported" | "booking">().notNull().default("teamwork"),
    memo: text("memo"),
    idempotencyKey: text("idempotency_key"),
    createdBy: uuid("created_by"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.orgId, t.number),
    uniqueIndex("invoices_idem_uq").on(t.orgId, t.idempotencyKey),
    // A membership period is billed at most once.
    uniqueIndex("invoices_membership_period_uq")
      .on(t.membershipId, t.periodStart)
      .where(sql`${t.status} <> 'void'`),
  ],
);

/** What an invoice line grants once the invoice is settled. */
export type EntitlementSpec = {
  credits?: number;
  unlimitedUntil?: string;
  activateMembershipId?: string;
  serviceTypeIds?: string[];
  creditExpiryDays?: number;
  bookingId?: string;
};

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  productVersionId: uuid("product_version_id").references(() => productVersions.id),
  athleteId: uuid("athlete_id").references(() => athletes.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitAmountMinor: minor("unit_amount_minor").notNull(),
  amountMinor: minor("amount_minor").notNull(),
  entitlement: jsonb("entitlement").$type<EntitlementSpec>(),
});

export type PaymentProvider = "stripe" | "paypal" | "venmo" | "manual";
export type AttemptStatus =
  | "created"
  | "requires_action"
  | "processing"
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/** A checkout / charge attempt. Browser redirects never move this to succeeded — only verified webhooks do. */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    provider: text("provider").$type<PaymentProvider>().notNull(),
    providerRef: text("provider_ref"),
    checkoutUrl: text("checkout_url"),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency").notNull(),
    methodType: text("method_type"),
    status: text("status").$type<AttemptStatus>().notNull().default("created"),
    idempotencyKey: text("idempotency_key").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    lastEventAt: ts("last_event_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("attempts_idem_uq").on(t.orgId, t.idempotencyKey),
    uniqueIndex("attempts_provider_ref_uq").on(t.provider, t.providerRef),
  ],
);

export type TxnKind = "charge" | "refund" | "dispute" | "dispute_reversal" | "fee" | "payout" | "manual_payment" | "adjustment";
export type TxnStatus = "pending" | "settled" | "failed" | "reversed";

/** Local transaction ledger. Signed amounts: positive = money in. */
export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    orgId: orgId(),
    payerAccountId: uuid("payer_account_id").references(() => payerAccounts.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    paymentAttemptId: uuid("payment_attempt_id").references(() => paymentAttempts.id),
    kind: text("kind").$type<TxnKind>().notNull(),
    status: text("status").$type<TxnStatus>().notNull(),
    amountMinor: minor("amount_minor").notNull(),
    feeMinor: minor("fee_minor").notNull().default(0),
    currency: text("currency").notNull(),
    provider: text("provider").$type<PaymentProvider>().notNull(),
    providerTxnId: text("provider_txn_id"),
    methodType: text("method_type"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    settledAt: ts("settled_at"),
    /** Manual/offline payments must be attributable. */
    recordedBy: uuid("recorded_by").references(() => users.id),
    manualReference: text("manual_reference"),
    /** "provider_verified" | "staff_attested" — a screenshot/QR scan is staff_attested, never provider_verified. */
    verification: text("verification").$type<"provider_verified" | "staff_attested">().notNull(),
    notes: text("notes"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("txn_provider_uq").on(t.provider, t.kind, t.providerTxnId),
    index("txn_invoice_idx").on(t.invoiceId),
  ],
);

export const refunds = pgTable("refunds", {
  id: id(),
  orgId: orgId(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id),
  amountMinor: minor("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").$type<"requested" | "pending" | "succeeded" | "failed" | "blocked_config">().notNull(),
  reason: text("reason"),
  providerRefundId: text("provider_refund_id").unique(),
  requestedBy: uuid("requested_by"),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: createdAt(),
});

export const disputes = pgTable("disputes", {
  id: id(),
  orgId: orgId(),
  transactionId: uuid("transaction_id").references(() => transactions.id),
  provider: text("provider").notNull(),
  providerDisputeId: text("provider_dispute_id").notNull().unique(),
  amountMinor: minor("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  evidenceDueBy: ts("evidence_due_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payouts = pgTable("payouts", {
  id: id(),
  orgId: orgId(),
  provider: text("provider").notNull(),
  providerPayoutId: text("provider_payout_id").notNull().unique(),
  amountMinor: minor("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  arrivalDate: date("arrival_date"),
  createdAt: createdAt(),
});

/**
 * Provider-side recurring price/plan created for one immutable product version at one net amount
 * (a sibling discount changes the amount, so it is part of the key). Stripe: product + price ids;
 * PayPal: catalog product + billing plan ids. Cached so a plan is created at most once per key.
 */
export const providerPlans = pgTable(
  "provider_plans",
  {
    id: id(),
    orgId: orgId(),
    provider: text("provider").$type<"stripe" | "paypal">().notNull(),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => productVersions.id),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency").notNull(),
    providerProductId: text("provider_product_id").notNull(),
    providerPlanId: text("provider_plan_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("provider_plans_uq").on(t.orgId, t.provider, t.productVersionId, t.amountMinor, t.currency)],
);

/** Tokenized references only. */
export const paymentMethods = pgTable("payment_methods", {
  id: id(),
  payerAccountId: uuid("payer_account_id")
    .notNull()
    .references(() => payerAccounts.id),
  provider: text("provider").notNull(),
  providerMethodId: text("provider_method_id").notNull(),
  type: text("type").notNull(),
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
});

/** Raw provider webhooks; (provider, provider_event_id) uniqueness makes ingestion idempotent. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    providerCreatedAt: ts("provider_created_at"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    status: text("status").$type<"received" | "processed" | "ignored" | "failed" | "rejected">().notNull(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [uniqueIndex("webhook_events_uq").on(t.provider, t.providerEventId)],
);

// ---------------------------------------------------------------------------
// Session-credit ledger
// ---------------------------------------------------------------------------

/**
 * A grant of credits. source_invoice_line_id is unique so a settled invoice line
 * can grant credits at most once, no matter how many webhooks arrive.
 */
export const creditBuckets = pgTable(
  "credit_buckets",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    membershipId: uuid("membership_id").references(() => memberships.id),
    sourceInvoiceLineId: uuid("source_invoice_line_id").references(() => invoiceLines.id),
    sourceKind: text("source_kind").$type<"purchase" | "membership_period" | "staff_grant" | "imported" | "rollover">().notNull(),
    serviceTypeIds: jsonb("service_type_ids").$type<string[]>().notNull().default([]),
    granted: integer("granted").notNull(),
    /** Denormalized balance maintained in the same transaction as each ledger entry. */
    available: integer("available").notNull(),
    reserved: integer("reserved").notNull().default(0),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    expiresAt: ts("expires_at"),
    status: text("status").$type<"active" | "expired" | "void">().notNull().default("active"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_bucket_source_uq").on(t.sourceInvoiceLineId),
    index("credit_bucket_athlete_idx").on(t.athleteId, t.status),
  ],
);

export type CreditEntryKind = "grant" | "reserve" | "consume" | "release" | "restore" | "expire" | "adjust" | "forfeit";

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    orgId: orgId(),
    bucketId: uuid("bucket_id")
      .notNull()
      .references(() => creditBuckets.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    kind: text("kind").$type<CreditEntryKind>().notNull(),
    /** Change to available credits. reserve = -1, release = +1, consume = 0 (moves reserved→used). */
    deltaAvailable: integer("delta_available").notNull(),
    deltaReserved: integer("delta_reserved").notNull().default(0),
    bookingId: uuid("booking_id").references(() => bookings.id),
    actorUserId: uuid("actor_user_id"),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("credit_ledger_idem_uq").on(t.idempotencyKey), index("credit_ledger_bucket_idx").on(t.bucketId)],
);

// ---------------------------------------------------------------------------
// Retail / POS
// ---------------------------------------------------------------------------

export const inventoryMovements = pgTable("inventory_movements", {
  id: id(),
  orgId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  delta: integer("delta").notNull(),
  reason: text("reason").$type<"receive" | "sale" | "adjust" | "return">().notNull(),
  invoiceLineId: uuid("invoice_line_id").references(() => invoiceLines.id),
  actorUserId: uuid("actor_user_id"),
  note: text("note"),
  createdAt: createdAt(),
});
