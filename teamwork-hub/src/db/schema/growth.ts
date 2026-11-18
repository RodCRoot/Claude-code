import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { athletes, payerAccounts, people, users } from "./core";
import { creditBuckets, invoices, memberships, products, productVersions } from "./billing";
import { leads } from "./crm";

/** Money is always integer minor units + ISO currency. */
const minor = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------
// Referral program
// ---------------------------------------------------------------------------

/**
 * A payer account's shareable referral code (`/r/<code>`). Short, random, revocable.
 * At most one active code per payer account; revoked codes stay for history and never resolve.
 */
export const referralCodes = pgTable(
  "referral_codes",
  {
    id: id(),
    orgId: orgId(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    code: text("code").notNull(),
    status: text("status").$type<"active" | "revoked">().notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("referral_codes_code_uq").on(t.code),
    uniqueIndex("referral_codes_active_payer_uq")
      .on(t.payerAccountId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type ReferralStatus = "inquired" | "started" | "earned" | "rejected";
export type ReferralRejection = "self_referral" | "same_household" | "existing_member" | "already_referred" | "code_revoked";

/**
 * Referrer payer → lead → converted athlete / membership. One row per lead (unique lead_id), so the
 * first valid code wins. Rejected rows keep the reason for staff and are never shown to families.
 */
export const referrals = pgTable(
  "referrals",
  {
    id: id(),
    orgId: orgId(),
    codeId: uuid("code_id")
      .notNull()
      .references(() => referralCodes.id),
    referrerPayerAccountId: uuid("referrer_payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id),
    status: text("status").$type<ReferralStatus>().notNull().default("inquired"),
    rejectionReason: text("rejection_reason").$type<ReferralRejection>(),
    /** How the code was attached: the public link or staff entering it on the lead. */
    attachedVia: text("attached_via").$type<"link" | "staff">().notNull().default("link"),
    attachedBy: uuid("attached_by").references(() => users.id),
    convertedAthleteId: uuid("converted_athlete_id").references(() => athletes.id),
    convertedPayerAccountId: uuid("converted_payer_account_id").references(() => payerAccounts.id),
    membershipId: uuid("membership_id").references(() => memberships.id),
    qualifyingInvoiceId: uuid("qualifying_invoice_id").references(() => invoices.id),
    startedAt: ts("started_at"),
    earnedAt: ts("earned_at"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("referrals_lead_uq").on(t.leadId), index("referrals_referrer_idx").on(t.orgId, t.referrerPayerAccountId)],
);

/**
 * `invoice_discount` is the new family's reward (owner decision 2026-11-11): money off the referred
 * family's FIRST invoice. It is reserved as `pending` when the referred athlete starts, applied
 * automatically to the first open invoice (`approved`, `applied_invoice_id` set) and never pays
 * money out. If the first invoice was already paid before it could apply, it is converted to a
 * pending `account_credit` that needs the usual staff approval.
 */
export type RewardKind = "account_credit" | "session_credits" | "invoice_discount";

/**
 * A reward that was earned and waits for staff approval. Nothing is issued until a staff member
 * approves it; (referral, beneficiary) is unique so a referral can earn each side at most once.
 */
export const referralRewards = pgTable(
  "referral_rewards",
  {
    id: id(),
    orgId: orgId(),
    referralId: uuid("referral_id")
      .notNull()
      .references(() => referrals.id),
    beneficiary: text("beneficiary").$type<"referrer" | "referred">().notNull(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    kind: text("kind").$type<RewardKind>().notNull(),
    /** Snapshot of the configured reward at the time it was earned. */
    amountMinor: minor("amount_minor"),
    currency: text("currency"),
    credits: integer("credits"),
    creditExpiryDays: integer("credit_expiry_days"),
    status: text("status").$type<"pending" | "approved" | "declined">().notNull().default("pending"),
    /** Athlete who received session credits (chosen at approval). */
    athleteId: uuid("athlete_id").references(() => athletes.id),
    creditBucketId: uuid("credit_bucket_id").references(() => creditBuckets.id),
    /** invoice_discount only: the invoice the discount was applied to, and how much of it was used. */
    appliedInvoiceId: uuid("applied_invoice_id").references(() => invoices.id),
    appliedMinor: minor("applied_minor"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    declineReason: text("decline_reason"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("referral_rewards_uq").on(t.referralId, t.beneficiary),
    index("referral_rewards_status_idx").on(t.orgId, t.status),
    // One live new-family reward per payer account, whatever referral it came from (not stackable).
    uniqueIndex("referral_rewards_referred_payer_uq")
      .on(t.payerAccountId)
      .where(sql`${t.beneficiary} = 'referred' AND ${t.status} <> 'declined'`),
  ],
);

/**
 * Account credit ledger (signed minor units; positive = credit owed to the family). The balance is
 * the sum of entries. Entries are only ever written by a staff action (reward approval, applying
 * credit to an invoice) and carry a unique idempotency key. This is NOT money received: it never
 * appears in the transactions ledger and never marks an invoice paid.
 */
export const accountCreditLedger = pgTable(
  "account_credit_ledger",
  {
    id: id(),
    orgId: orgId(),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    deltaMinor: minor("delta_minor").notNull(),
    currency: text("currency").notNull(),
    kind: text("kind").$type<"referral_reward" | "applied_to_invoice">().notNull(),
    rewardId: uuid("reward_id").references(() => referralRewards.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    reason: text("reason"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("account_credit_idem_uq").on(t.orgId, t.idempotencyKey), index("account_credit_payer_idx").on(t.payerAccountId)],
);

// ---------------------------------------------------------------------------
// Family Shop
// ---------------------------------------------------------------------------

/** Per-product "sellable online" flag (default: no row = not sellable) plus the storefront blurb. */
export const shopListings = pgTable(
  "shop_listings",
  {
    id: id(),
    orgId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sellableOnline: boolean("sellable_online").notNull().default(false),
    /** Plain-language "what it includes", written by staff. */
    includes: text("includes"),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("shop_listings_product_uq").on(t.productId)],
);

/** One row per shop checkout; the invoice is the financial record. */
export const shopOrders = pgTable(
  "shop_orders",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    payerAccountId: uuid("payer_account_id")
      .notNull()
      .references(() => payerAccounts.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => productVersions.id),
    placedByUserId: uuid("placed_by_user_id").references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shop_orders_idem_uq").on(t.orgId, t.idempotencyKey), uniqueIndex("shop_orders_invoice_uq").on(t.invoiceId)],
);

// ---------------------------------------------------------------------------
// Helpful offers
// ---------------------------------------------------------------------------

export type OfferKey = "weekly_cap" | "credits_low" | "commitment_savings" | "sibling_discount" | "assessment_due" | "in_season_ending";

/** A family member chose "Not now" on a suggestion; it stays hidden for them until `until`. */
export const offerDismissals = pgTable(
  "offer_dismissals",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    offerKey: text("offer_key").$type<OfferKey>().notNull(),
    dismissedAt: ts("dismissed_at").notNull().defaultNow(),
    until: ts("until").notNull(),
  },
  (t) => [uniqueIndex("offer_dismissals_uq").on(t.userId, t.athleteId, t.offerKey)],
);

/** Reporting only: shown (once per user, athlete, offer and day), accepted, dismissed, task created. */
export const offerEvents = pgTable(
  "offer_events",
  {
    id: id(),
    orgId: orgId(),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    offerKey: text("offer_key").$type<OfferKey>().notNull(),
    event: text("event").$type<"shown" | "accepted" | "dismissed" | "task_created">().notNull(),
    audience: text("audience").$type<"family" | "staff">().notNull(),
    userId: uuid("user_id").references(() => users.id),
    day: date("day").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("offer_events_daily_uq").on(t.userId, t.athleteId, t.offerKey, t.event, t.day), index("offer_events_org_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Gift / trial passes
// ---------------------------------------------------------------------------

/** A free trial pass: N session credits with an expiry, granted through the credit ledger. */
export const trialPasses = pgTable(
  "trial_passes",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").references(() => leads.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    athleteId: uuid("athlete_id")
      .notNull()
      .references(() => athletes.id),
    credits: integer("credits").notNull(),
    expiresAt: ts("expires_at").notNull(),
    reason: text("reason").notNull(),
    creditBucketId: uuid("credit_bucket_id").references(() => creditBuckets.id),
    issuedBy: uuid("issued_by").references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("trial_passes_idem_uq").on(t.orgId, t.idempotencyKey), index("trial_passes_lead_idx").on(t.leadId)],
);
