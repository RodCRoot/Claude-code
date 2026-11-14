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
  /**
   * Locations this product's memberships/credits are valid at; empty = every location.
   * Lives on the product (not the immutable version) because it is a scope rule, not a price term.
   */
  locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]),
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
    /** Classes per ISO week (facility time) this plan entitles. Null = no weekly cap (unlimited or credit-based). */
    classesPerWeek: integer("classes_per_week"),
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

export type MembershipKind = "regular" | "in_season";

/** How a family sent a hold / cancellation request (all channels are honored and recorded). */
export const REQUEST_CHANNELS = ["email", "forwarded_email", "sms", "messenger", "phone", "voice_agent_recap", "website_form", "in_person"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

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
    /** Per-membership location override; null = use the product's locations. */
    locationIds: jsonb("location_ids").$type<string[]>(),
    source: text("source").notNull().default("teamwork"),
    /** regular = the family's ongoing plan; in_season = a fixed-term plan that never auto-renews. */
    kind: text("kind").$type<MembershipKind>().notNull().default("regular"),
    /** Commitment term (first full period → end). Null when the plan has no commitment. Never extended silently. */
    commitmentStartsOn: date("commitment_starts_on"),
    commitmentEndsOn: date("commitment_ends_on"),
    /** Charge each bill automatically with a saved payment method (Teamwork-invoiced memberships only). */
    autopay: boolean("autopay").notNull().default(false),
    /** Saved method autopay uses; null = the payer account's default method. */
    autopayMethodId: uuid("autopay_method_id"),
    /** not_required | awaiting (a membership agreement must be signed) | signed. Maintained by src/lib/agreements. */
    agreementState: text("agreement_state").$type<"not_required" | "awaiting" | "signed">().notNull().default("not_required"),
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
  /** hold = family pause; in_season = regular plan paused while an In Season membership runs. */
  kind: text("kind").$type<"hold" | "in_season">().notNull().default("hold"),
  /** Local date the family SENT the request (a hold may be backdated to it). */
  requestedOn: date("requested_on"),
  requestChannel: text("request_channel").$type<RequestChannel>(),
  /** Staff reason when a policy cap was overridden (audited). */
  overrideReason: text("override_reason"),
  /** The In Season membership that runs during an in_season pause. */
  relatedMembershipId: uuid("related_membership_id"),
  /** Punch-card bucket granted for already-billed unused sessions. */
  makeupBucketId: uuid("makeup_bucket_id"),
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
  /** Camp / clinic registration: confirmed (and booked into its sessions) once the invoice is paid. */
  eventRegistrationId?: string;
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
    /** checkout = payer on a hosted page; autopay = off-session charge of a saved method. */
    origin: text("origin").$type<"checkout" | "autopay">().notNull().default("checkout"),
    /** Saved method charged (autopay only). */
    paymentMethodId: uuid("payment_method_id"),
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
    /** Set only when the processor itself reported the fee (Stripe balance transaction). Null = fee unknown, not zero. */
    feeReportedAt: ts("fee_reported_at"),
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

export type PaymentMethodStatus = "active" | "requires_verification" | "failed" | "removed";
export type PaymentMethodType = "card" | "us_bank_account";

/** Evidence of the payer authorizing recurring bank debits, recorded by Teamwork before the hosted page. */
export type MandateAcceptance = {
  acceptedAt: string;
  userId: string | null;
  personId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Version of the authorization text shown (src/lib/billing/mandate-text.ts). */
  textVersion: string;
  /** The exact text shown. */
  text: string;
};

/**
 * Saved payment methods. References and display details only: the card or bank account itself lives in
 * the provider's vault. Never a full number, CVC, routing number or account number.
 * A row becomes `active` only from a verified provider webhook.
 */
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: id(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    provider: text("provider").notNull(),
    /** Provider customer the method is attached to (reference only). */
    providerCustomerId: text("provider_customer_id"),
    providerMethodId: text("provider_method_id").notNull(),
    type: text("type").notNull(),
    brand: text("brand"),
    /** Bank name for us_bank_account methods, as reported by the provider. */
    bankName: text("bank_name"),
    last4: text("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    /** Legacy rows (seeds, imports) default to active; the setup flow always writes the status explicitly. */
    status: text("status").$type<PaymentMethodStatus>().notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    /** Details (brand / last four) have arrived from the provider. */
    detailsAt: ts("details_at"),
    /** The provider confirmed the setup succeeded (setup_intent.succeeded). */
    setupSucceededAt: ts("setup_succeeded_at"),
    /** Provider mandate reference for bank debits (Stripe `mandate_…`). */
    mandateRef: text("mandate_ref"),
    mandateStatus: text("mandate_status"),
    mandateAcceptance: jsonb("mandate_acceptance").$type<MandateAcceptance>(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    setupId: uuid("setup_id"),
    removedAt: ts("removed_at"),
    removedBy: uuid("removed_by"),
    lastEventAt: ts("last_event_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_methods_provider_uq").on(t.provider, t.providerMethodId),
    index("payment_methods_payer_idx").on(t.payerAccountId, t.status),
  ],
);

export type MethodSetupStatus = "created" | "requires_verification" | "succeeded" | "failed" | "expired";

/** One hosted "save a payment method" session. The browser return never changes it; verified webhooks do. */
export const paymentMethodSetups = pgTable(
  "payment_method_setups",
  {
    id: id(),
    orgId: orgId(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    provider: text("provider").notNull(),
    requestedType: text("requested_type").$type<PaymentMethodType>().notNull(),
    status: text("status").$type<MethodSetupStatus>().notNull().default("created"),
    providerSessionId: text("provider_session_id"),
    providerSetupIntentId: text("provider_setup_intent_id"),
    providerMethodId: text("provider_method_id"),
    checkoutUrl: text("checkout_url"),
    /** Provider-hosted page for entering microdeposit amounts, when the provider hands one back. */
    verificationUrl: text("verification_url"),
    mandateAcceptance: jsonb("mandate_acceptance").$type<MandateAcceptance>(),
    /** Make this the payer's default once active. */
    makeDefault: boolean("make_default").notNull().default(false),
    /** Where to send the payer afterwards (sign-up flow id), if any. */
    signupFlowId: uuid("signup_flow_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    startedBy: uuid("started_by"),
    lastEventAt: ts("last_event_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pm_setups_idem_uq").on(t.orgId, t.idempotencyKey),
    uniqueIndex("pm_setups_session_uq").on(t.provider, t.providerSessionId),
    uniqueIndex("pm_setups_intent_uq").on(t.provider, t.providerSetupIntentId),
  ],
);

/**
 * A membership agreement to sign for one membership on one product version. The signed text is frozen on
 * the form request (rendered_body_markdown); `terms` is the snapshot used to decide when re-signing is needed.
 */
export const membershipAgreements = pgTable(
  "membership_agreements",
  {
    id: id(),
    orgId: orgId(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => productVersions.id),
    formRequestId: uuid("form_request_id").notNull(),
    /** new | plan_change | price_change | commitment_change | payment_method_type | terms_changed | cutover | staff */
    reason: text("reason").notNull(),
    /** Terms the agreement was rendered from (see AgreementTerms in src/lib/agreements/terms.ts). */
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    termsHash: text("terms_hash").notNull(),
    signedAt: ts("signed_at"),
    supersededAt: ts("superseded_at"),
    supersededById: uuid("superseded_by_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("membership_agreements_m_idx").on(t.membershipId), uniqueIndex("membership_agreements_req_uq").on(t.formRequestId)],
);

export type SignupFlowStatus = "open" | "completed" | "cancelled";

/** Guided sign-up (new member or Zen Planner conversion). Step state is derived from the linked records. */
export const signupFlows = pgTable(
  "signup_flows",
  {
    id: id(),
    orgId: orgId(),
    kind: text("kind").$type<"new" | "cutover">().notNull(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    status: text("status").$type<SignupFlowStatus>().notNull().default("open"),
    productVersionId: uuid("product_version_id").references(() => productVersions.id),
    startDate: date("start_date"),
    membershipId: uuid("membership_id").references(() => memberships.id),
    /** The payer chose to pay each bill themselves (or no provider is configured). */
    paymentChoice: text("payment_choice").$type<"autopay" | "manual">(),
    startedBy: uuid("started_by"),
    startedByStaff: boolean("started_by_staff").notNull().default(false),
    completedAt: ts("completed_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("signup_flows_payer_idx").on(t.payerAccountId, t.status),
    // One open flow per athlete: starting again resumes it.
    uniqueIndex("signup_flows_open_uq").on(t.athleteId).where(sql`${t.status} = 'open'`),
  ],
);

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

/** hold_makeup = punch card for already-billed sessions unused because of a hold (usable only with an active membership). */
export type CreditSourceKind = "purchase" | "membership_period" | "staff_grant" | "imported" | "rollover" | "hold_makeup";

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
    sourceKind: text("source_kind").$type<CreditSourceKind>().notNull(),
    serviceTypeIds: jsonb("service_type_ids").$type<string[]>().notNull().default([]),
    /** Locations these credits can be spent at; empty = any (copied from the product/membership at grant). */
    locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]),
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
