import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, isDemo, orgId, ts, updatedAt } from "./_common";
import { users } from "./core";

// ---------------------------------------------------------------------------
// Staff time clock & payroll
// ---------------------------------------------------------------------------

/**
 * Hourly pay rate history. The rate for a shift is the row with the latest `effective_from` on or
 * before the shift's local date, so changing a rate never rewrites past pay. Money is integer cents.
 */
export const staffPayRates = pgTable(
  "staff_pay_rates",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Free-text label, e.g. "Coach" — mirrors Zen Planner's pay-rate label. */
    label: text("label").notNull(),
    rateMinor: integer("rate_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    effectiveFrom: date("effective_from").notNull(),
    createdBy: uuid("created_by"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("staff_pay_rates_user_from_uq").on(t.userId, t.effectiveFrom),
    index("staff_pay_rates_org_idx").on(t.orgId),
    check("staff_pay_rates_positive", sql`${t.rateMinor} > 0`),
  ],
);

/** Staff kiosk time-clock PIN (keyed hash only; see src/lib/scheduling/pin-hash.ts). Separate from athlete check-in PINs. */
export const staffClockPins = pgTable(
  "staff_clock_pins",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: orgId(),
    pinHash: text("pin_hash").notNull(),
    setByUserId: uuid("set_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("staff_clock_pin_org_hash_uq").on(t.orgId, t.pinHash)],
);

export type TimeEntrySource = "kiosk" | "staff" | "manual" | "import";
export type FlagAck = { code: string; by: string; at: string; note: string };

/**
 * One clock-in/clock-out shift. `clock_out` is null while on shift; the partial unique index allows
 * at most one open (non-voided) entry per person. Corrections keep the first recorded values in
 * `original_*` and every edit is written to the audit log with its reason.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    clockIn: ts("clock_in").notNull(),
    clockOut: ts("clock_out"),
    source: text("source").$type<TimeEntrySource>().notNull(),
    originalClockIn: ts("original_clock_in").notNull(),
    originalClockOut: ts("original_clock_out"),
    createdBy: uuid("created_by"),
    editedBy: uuid("edited_by"),
    editedAt: ts("edited_at"),
    editReason: text("edit_reason"),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    /** Payroll flags a manager reviewed (e.g. confirmed a long shift is real). */
    ackFlags: jsonb("ack_flags").$type<FlagAck[]>().notNull().default([]),
    /** Dedupe key for imported rows ("<user>:<clock_in ISO>"). */
    importKey: text("import_key"),
    /** Raw imported line, kept for traceability. */
    importRaw: text("import_raw"),
    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("time_entries_one_open_uq").on(t.userId).where(sql`${t.clockOut} is null and ${t.voidedAt} is null`),
    uniqueIndex("time_entries_import_uq").on(t.orgId, t.importKey),
    index("time_entries_org_user_in_idx").on(t.orgId, t.userId, t.clockIn),
    check("time_entries_out_after_in", sql`${t.clockOut} is null or ${t.clockOut} > ${t.clockIn}`),
    check("time_entries_source_ck", sql`${t.source} in ('kiosk','staff','manual','import')`),
  ],
);

export type PayrollRunStatus = "draft" | "approved" | "exported";

/** A saved payroll calculation for a date range. `snapshot` freezes lines, flags, estimates, settings. */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: id(),
    orgId: orgId(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    status: text("status").$type<PayrollRunStatus>().notNull().default("draft"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** Actual (clocked, included) totals in cents; estimates are only in the snapshot. */
    grossMinor: integer("gross_minor").notNull(),
    deductionMinor: integer("deduction_minor").notNull(),
    netMinor: integer("net_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    createdBy: uuid("created_by"),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    exportedBy: uuid("exported_by"),
    exportedAt: ts("exported_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payroll_runs_org_idx").on(t.orgId, t.createdAt),
    check("payroll_runs_status_ck", sql`${t.status} in ('draft','approved','exported')`),
    check("payroll_runs_range_ck", sql`${t.fromDate} <= ${t.toDate}`),
  ],
);

export type PayrollRounding = "truncate_2dp" | "exact";

/** Per-org payroll settings (one row). Absent row = defaults from src/lib/payroll/settings.ts. */
export const payrollSettings = pgTable(
  "payroll_settings",
  {
    orgId: uuid("org_id").primaryKey(),
    /** Withholding/deduction estimate in basis points (1700 = 17%). Confirm with your accountant. */
    deductionBps: integer("deduction_bps").notNull(),
    rounding: text("rounding").$type<PayrollRounding>().notNull(),
    /** Detector thresholds (see PayrollThresholds). */
    thresholds: jsonb("thresholds").$type<Record<string, number>>().notNull().default({}),
    /** Column mapping for the Zen Planner payroll paste/CSV import (unverified; configurable). */
    importMapping: jsonb("import_mapping").$type<Record<string, unknown>>().notNull().default({}),
    /** Non-admin users explicitly granted payroll access (operations only). */
    accessUserIds: jsonb("access_user_ids").$type<string[]>().notNull().default([]),
    updatedBy: uuid("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("payroll_settings_bps_ck", sql`${t.deductionBps} >= 0 and ${t.deductionBps} <= 10000`),
    check("payroll_settings_rounding_ck", sql`${t.rounding} in ('truncate_2dp','exact')`),
  ],
);
