import { bigint, boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./_common";
import { athletes, people } from "./core";
import { memberships } from "./billing";

const minor = (name: string) => bigint(name, { mode: "number" });

/**
 * Informational Zen Planner Person-grid columns that have no home on `people` (no health data here:
 * Special Needs / Medications / Allergies go to sensitive notes). One row per person, written by
 * the Import Center and removed on revert.
 */
export const zpPersonDetails = pgTable(
  "zp_person_details",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    importBatchId: uuid("import_batch_id"),
    familyId: text("family_id"),
    zpStatus: text("zp_status"),
    primaryLocation: text("primary_location"),
    primaryInstructor: text("primary_instructor"),
    signupDate: date("signup_date"),
    hasPassword: boolean("has_password"),
    signedDocuments: text("signed_documents"),
    /** Vocabulary values that were not on the hub's list when imported, e.g. ["source: Billboard"]. */
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("zp_person_details_person_uq").on(t.personId), index("zp_person_details_family_idx").on(t.orgId, t.familyId)],
);

/**
 * HEALTH DATA. Zen Planner's Special Needs / Medications / Allergies columns, kept in their own
 * table so no general people query ever selects them. Read only through
 * `src/lib/zenplanner/health.ts`, which requires `health.read` on the athlete (policy.ts).
 */
export const zpPersonHealth = pgTable(
  "zp_person_health",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    importBatchId: uuid("import_batch_id"),
    specialNeeds: text("special_needs"),
    medications: text("medications"),
    allergies: text("allergies"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("zp_person_health_person_uq").on(t.personId)],
);

/**
 * Zen Planner Membership-grid columns kept beside an imported (`external_zenplanner`) membership.
 * Read-only history and review context: nothing here is ever billed.
 */
export const zpMembershipDetails = pgTable(
  "zp_membership_details",
  {
    id: id(),
    orgId: orgId(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    importBatchId: uuid("import_batch_id"),
    planName: text("plan_name").notNull(),
    familyId: text("family_id"),
    /** What Zen Planner bills each period for this membership (null = not in the export, never 0). */
    paymentAmountMinor: minor("payment_amount_minor"),
    months: integer("months"),
    autoRenew: boolean("auto_renew"),
    renewalType: text("renewal_type"),
    trialMember: boolean("trial_member"),
    cancelDate: date("cancel_date"),
    cancelBy: text("cancel_by"),
    cancelReason: text("cancel_reason"),
    cancelComments: text("cancel_comments"),
    firstBillDue: date("first_bill_due"),
    incomeCategory: text("income_category"),
    membershipCategory: text("membership_category"),
    attLimit: integer("att_limit"),
    attLimitType: text("att_limit_type"),
    classCardRemaining: integer("class_card_remaining"),
    shared: boolean("shared"),
    autopay: boolean("autopay"),
    discountName: text("discount_name"),
    discountMinor: minor("discount_minor"),
    holdReason: text("hold_reason"),
    holdStart: date("hold_start"),
    holdEnd: date("hold_end"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("zp_membership_details_membership_uq").on(t.membershipId), index("zp_membership_details_org_idx").on(t.orgId, t.importBatchId)],
);

/**
 * Imported Zen Planner bills: history only (membership audit / scoreboard context).
 * Deliberately NOT `invoices`: nothing here is payable, collectable or shown to families as owed.
 */
export const zpBills = pgTable(
  "zp_bills",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    athleteId: uuid("athlete_id").references(() => athletes.id),
    membershipId: uuid("membership_id").references(() => memberships.id, { onDelete: "set null" }),
    importBatchId: uuid("import_batch_id"),
    sourceRecordId: text("source_record_id").notNull(),
    description: text("description"),
    dueDate: date("due_date").notNull(),
    amountDueMinor: minor("amount_due_minor"),
    amountPaidMinor: minor("amount_paid_minor"),
    amountUnpaidMinor: minor("amount_unpaid_minor"),
    discountTotalMinor: minor("discount_total_minor"),
    paidOnTime: boolean("paid_on_time"),
    zpStatus: text("zp_status"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("zp_bills_source_uq").on(t.orgId, t.sourceRecordId), index("zp_bills_person_idx").on(t.personId, t.dueDate)],
);

export type ZpWebhookFeed = "people" | "class-sessions" | "attendance";

/**
 * Raw Zen Planner webhook deliveries (obviously sensitive fields removed before storing).
 * The unique dedupe key makes a redelivery a no-op.
 */
export const zpWebhookEvents = pgTable(
  "zp_webhook_events",
  {
    id: id(),
    orgId: orgId(),
    feed: text("feed").$type<ZpWebhookFeed>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    /** received = waiting to be staged; staged = fed to the Import Center as a batch; stored = kept for inspection only (no import schema for the feed). */
    status: text("status").$type<"received" | "staged" | "stored">().notNull(),
    importBatchId: uuid("import_batch_id"),
    records: integer("records").notNull().default(0),
    note: text("note"),
  },
  (t) => [uniqueIndex("zp_webhook_events_dedupe_uq").on(t.orgId, t.feed, t.dedupeKey), index("zp_webhook_events_recent_idx").on(t.orgId, t.feed, t.receivedAt)],
);

/** Numbers typed in from Zen Planner's dashboard, compared with the hub's own counts at that moment. */
export const zpReconciliations = pgTable(
  "zp_reconciliations",
  {
    id: id(),
    orgId: orgId(),
    importBatchId: uuid("import_batch_id"),
    asOf: date("as_of").notNull(),
    /** { activeMembers, memberships, onHold, pastDueMinor } as typed (null = not entered). */
    entered: jsonb("entered").$type<Record<string, number | null>>().notNull(),
    /** The hub's figures when the entry was saved, with the breakdowns used to explain differences. */
    hub: jsonb("hub").$type<Record<string, number | null>>().notNull(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("zp_reconciliations_org_idx").on(t.orgId, t.asOf)],
);
