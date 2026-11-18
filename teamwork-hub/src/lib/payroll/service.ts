import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  kioskPinAttempts,
  organizations,
  payrollRuns,
  payrollSettings,
  staffClockPins,
  staffPayRates,
  timeEntries,
  users,
  type FlagAck,
  type PayrollRunStatus,
  type TimeEntrySource,
} from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit, type AuditActor } from "@/lib/audit";
import { AuthzError, can, STAFF, type Viewer } from "@/lib/authz/policy";
import { parseMoneyToMinor } from "@/lib/money";
import { hashCheckInPin, isTrivialPin, PIN_PATTERN } from "@/lib/scheduling/pin-hash";
import { addDaysYmd, DEFAULT_TZ, localDayBounds, localToUtc, todayLocal } from "@/lib/time";
import { ACKABLE, computePayroll, historyStart, type FlagCode, type PayrollResult } from "./engine";
import { DEFAULT_IMPORT_MAPPING, DEFAULT_PAYROLL_CONFIG, DEFAULT_THRESHOLDS, type ImportMapping, type PayrollConfig, type PayrollThresholds } from "./settings";
import { parseZenPlannerPayroll, type ParsedRow } from "./zp-import";

const actor = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
const pgCode = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const reasonSchema = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(500);
export const MAX_RANGE_DAYS = 62;

async function orgTz(tx: Tx, orgId: string): Promise<string> {
  const [o] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return o?.tz ?? DEFAULT_TZ;
}

// ---------------------------------------------------------------------------
// Settings & access
// ---------------------------------------------------------------------------

export async function payrollConfig(tx: Tx, orgId: string): Promise<PayrollConfig> {
  const [row] = await tx.select().from(payrollSettings).where(eq(payrollSettings.orgId, orgId));
  if (!row) return DEFAULT_PAYROLL_CONFIG;
  return {
    deductionBps: row.deductionBps,
    rounding: row.rounding,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(row.thresholds as Partial<PayrollThresholds>) },
    importMapping: { ...DEFAULT_IMPORT_MAPPING, ...(row.importMapping as Partial<ImportMapping>) },
    accessUserIds: row.accessUserIds ?? [],
  };
}

/** Owner/admin always; operations only when explicitly granted in Payroll → Settings; coaches never. */
export async function canManagePayroll(tx: Tx, v: Viewer): Promise<boolean> {
  if (can(v, "payroll.manage")) return true;
  if (v.role !== "operations") return false;
  return (await payrollConfig(tx, v.orgId)).accessUserIds.includes(v.userId);
}

export async function assertPayroll(tx: Tx, v: Viewer): Promise<void> {
  if (!(await canManagePayroll(tx, v))) throw new AuthzError();
}

const thresholdsSchema = z.object({
  runawayMaxHours: z.coerce.number().min(4).max(48),
  runawayCrossDayMinHours: z.coerce.number().min(1).max(24),
  runawayNormFactor: z.coerce.number().min(1.2).max(10),
  tinyHours: z.coerce.number().min(0).max(4),
  tinyNormMinHours: z.coerce.number().min(0).max(12),
  offPatternMinutes: z.coerce.number().int().min(15).max(720),
  orphanMaxHours: z.coerce.number().min(0).max(6),
  lookbackWeeks: z.coerce.number().int().min(1).max(26),
  expectedWeekdayMinWeeks: z.coerce.number().int().min(1).max(26),
  estimateSampleDays: z.coerce.number().int().min(1).max(12),
  minSamplesForNorm: z.coerce.number().int().min(1).max(50),
});
const col = z.coerce.number().int().min(0).max(30);
const mappingSchema = z.object({
  dateCol: col,
  rateLabelCol: col,
  rateCol: col,
  timeInCol: col,
  timeOutCol: col,
  hoursCol: col,
  amountCol: col,
  noEntryMarker: z.string().trim().min(1).max(20),
});
export const payrollSettingsSchema = z.object({
  deductionBps: z.coerce.number().int().min(0).max(10_000),
  rounding: z.enum(["truncate_2dp", "exact"]),
  thresholds: thresholdsSchema,
  importMapping: mappingSchema,
  accessUserIds: z.array(z.string().uuid()).default([]),
});

/** Only owner/admin change payroll settings (incl. who else gets access). */
export async function updatePayrollSettings(tx: Tx, v: Viewer, raw: unknown) {
  if (!can(v, "payroll.manage")) throw new AuthzError();
  const input = payrollSettingsSchema.parse(raw);
  if (input.accessUserIds.length) {
    const rows = await tx.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.orgId, v.orgId), inArray(users.id, input.accessUserIds)));
    if (rows.length !== input.accessUserIds.length || rows.some((r) => r.role !== "operations")) throw new UserError("Payroll access can only be granted to operations staff in this organization.");
  }
  const before = await payrollConfig(tx, v.orgId);
  const values = { ...input, updatedBy: v.userId, updatedAt: new Date() };
  await tx.insert(payrollSettings).values({ orgId: v.orgId, ...values }).onConflictDoUpdate({ target: payrollSettings.orgId, set: values });
  await audit(tx, actor(v), "payroll.settings_update", "organization", v.orgId, { before, after: input });
}

// ---------------------------------------------------------------------------
// Staff, rates, PINs
// ---------------------------------------------------------------------------

export type StaffMember = { userId: string; name: string; role: string; disabled: boolean };

export async function staffMembers(tx: Tx, orgId: string): Promise<StaffMember[]> {
  const rows = await tx
    .select({ userId: users.id, name: users.displayName, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.role, STAFF)))
    .orderBy(asc(users.displayName));
  return rows.map((r) => ({ userId: r.userId, name: r.name, role: r.role, disabled: !!r.disabledAt }));
}

async function requireStaffUser(tx: Tx, orgId: string, userId: string) {
  const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, orgId)));
  if (!u || !STAFF.includes(u.role)) throw new UserError("That person isn't a staff member here.");
  return u;
}

export const payRateSchema = z.object({
  userId: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
  rate: z.string().trim().min(1),
  effectiveFrom: ymd,
});

export async function setPayRate(tx: Tx, v: Viewer, raw: unknown) {
  await assertPayroll(tx, v);
  const input = payRateSchema.parse(raw);
  await requireStaffUser(tx, v.orgId, input.userId);
  const rateMinor = parseMoneyToMinor(input.rate);
  if (rateMinor == null || rateMinor <= 0) throw new UserError("Enter an hourly rate like 15.00.", { rate: "Hourly rate in dollars" });
  const [prev] = await tx.select().from(staffPayRates).where(and(eq(staffPayRates.userId, input.userId), eq(staffPayRates.effectiveFrom, input.effectiveFrom)));
  const [row] = await tx
    .insert(staffPayRates)
    .values({ orgId: v.orgId, userId: input.userId, label: input.label, rateMinor, effectiveFrom: input.effectiveFrom, createdBy: v.userId })
    .onConflictDoUpdate({ target: [staffPayRates.userId, staffPayRates.effectiveFrom], set: { label: input.label, rateMinor } })
    .returning();
  await audit(tx, actor(v), prev ? "payroll.rate_update" : "payroll.rate_set", "user", input.userId, {
    summary: `Pay rate ${input.label} effective ${input.effectiveFrom}`,
    before: prev ? { rateMinor: prev.rateMinor, label: prev.label } : null,
    after: { rateMinor, label: input.label, effectiveFrom: input.effectiveFrom },
  });
  return row;
}

export async function payRates(tx: Tx, v: Viewer, userId?: string) {
  if (userId !== v.userId) await assertPayroll(tx, v);
  return tx
    .select()
    .from(staffPayRates)
    .where(and(eq(staffPayRates.orgId, v.orgId), userId ? eq(staffPayRates.userId, userId) : sql`true`))
    .orderBy(asc(staffPayRates.userId), desc(staffPayRates.effectiveFrom));
}

/** Staff set their own kiosk time-clock PIN; payroll managers can set anyone's. Never logged. */
export async function setStaffClockPin(tx: Tx, v: Viewer, input: { userId: string; pin: string | null }) {
  if (!STAFF.includes(v.role)) throw new AuthzError();
  if (input.userId !== v.userId) await assertPayroll(tx, v);
  await requireStaffUser(tx, v.orgId, input.userId);
  if (input.pin === null) {
    await tx.delete(staffClockPins).where(and(eq(staffClockPins.userId, input.userId), eq(staffClockPins.orgId, v.orgId)));
    await audit(tx, actor(v), "staff.clock_pin_clear", "user", input.userId, { summary: "Time-clock PIN removed" });
    return { set: false };
  }
  const pin = input.pin.trim();
  if (!PIN_PATTERN.test(pin)) throw new UserError("A time-clock PIN is 4 to 6 digits.", { pin: "4–6 digits" });
  if (isTrivialPin(pin)) throw new UserError("That PIN is too easy to guess. Avoid repeated digits and straight runs like 1234.", { pin: "Too easy to guess" });
  const pinHash = hashCheckInPin(v.orgId, `staff:${pin}`);
  const unavailable = new UserError("That PIN isn't available. Please choose a different one.", { pin: "Choose another PIN" });
  const [taken] = await tx.select({ u: staffClockPins.userId }).from(staffClockPins).where(and(eq(staffClockPins.orgId, v.orgId), eq(staffClockPins.pinHash, pinHash)));
  if (taken && taken.u !== input.userId) throw unavailable;
  try {
    await tx
      .insert(staffClockPins)
      .values({ userId: input.userId, orgId: v.orgId, pinHash, setByUserId: v.userId })
      .onConflictDoUpdate({ target: staffClockPins.userId, set: { pinHash, setByUserId: v.userId, updatedAt: new Date() } });
  } catch (e) {
    if (pgCode(e) === "23505") throw unavailable;
    throw e;
  }
  await audit(tx, actor(v), "staff.clock_pin_set", "user", input.userId, { summary: "Time-clock PIN set" });
  return { set: true };
}

export async function hasStaffClockPin(tx: Tx, v: Viewer, userId: string) {
  if (userId !== v.userId) await assertPayroll(tx, v);
  const [r] = await tx.select({ u: staffClockPins.userId }).from(staffClockPins).where(and(eq(staffClockPins.userId, userId), eq(staffClockPins.orgId, v.orgId)));
  return !!r;
}

// ---------------------------------------------------------------------------
// Clock in / out
// ---------------------------------------------------------------------------

export type ClockResult = { action: "in" | "out"; entryId: string; at: Date; userId: string; name: string; shiftMs?: number };

async function openEntry(tx: Tx, orgId: string, userId: string) {
  const [e] = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.userId, userId), isNull(timeEntries.clockOut), isNull(timeEntries.voidedAt)))
    .for("update");
  return e ?? null;
}

async function doClock(tx: Tx, a: AuditActor, orgId: string, userId: string, op: "in" | "out" | "toggle", source: TimeEntrySource, now: Date, createdBy: string): Promise<ClockResult> {
  const u = await requireStaffUser(tx, orgId, userId);
  if (u.disabledAt) throw new UserError("This staff login is disabled.");
  const open = await openEntry(tx, orgId, userId);
  const want = op === "toggle" ? (open ? "out" : "in") : op;
  if (want === "in") {
    if (open) throw new UserError("Already clocked in. Clock out first.");
    let row;
    try {
      [row] = await tx.insert(timeEntries).values({ orgId, userId, clockIn: now, originalClockIn: now, source, createdBy }).returning();
    } catch (e) {
      // Two clock-ins racing: the partial unique index (one open entry per person) is the backstop.
      if (pgCode(e) === "23505") throw new UserError("Already clocked in. Clock out first.");
      throw e;
    }
    await audit(tx, a, "time_entry.clock_in", "time_entry", row.id, { summary: `${u.displayName} clocked in (${source})`, after: { userId, clockIn: now.toISOString(), source } });
    return { action: "in", entryId: row.id, at: now, userId, name: u.displayName };
  }
  if (!open) throw new UserError("Not clocked in.");
  if (now <= open.clockIn) throw new UserError("Clock-out must be after clock-in.");
  await tx.update(timeEntries).set({ clockOut: now, originalClockOut: now }).where(eq(timeEntries.id, open.id));
  await audit(tx, a, "time_entry.clock_out", "time_entry", open.id, { summary: `${u.displayName} clocked out (${source})`, after: { clockOut: now.toISOString() } });
  return { action: "out", entryId: open.id, at: now, userId, name: u.displayName, shiftMs: now.getTime() - open.clockIn.getTime() };
}

/**
 * Staff clock themselves in/out (Today button or a staff session on the kiosk).
 * Clocking someone else is a payroll-manager correction and is recorded as `manual`.
 */
export async function clock(tx: Tx, v: Viewer, input: { op: "in" | "out" | "toggle"; userId?: string; now?: Date; source?: "staff" | "kiosk" }): Promise<ClockResult> {
  if (!STAFF.includes(v.role)) throw new AuthzError();
  const target = input.userId ?? v.userId;
  const self = target === v.userId;
  if (!self) await assertPayroll(tx, v);
  return doClock(tx, actor(v), v.orgId, target, input.op, self ? (input.source ?? "staff") : "manual", input.now ?? new Date(), v.userId);
}

export const STAFF_PIN_MAX_FAILED = 5;
export const STAFF_PIN_WINDOW_MINUTES = 15;
export const STAFF_PIN_LOCK_MINUTES = 5;

export type KioskClockResult =
  | ({ ok: true } & ClockResult)
  | { ok: false; reason: "invalid_format" }
  | { ok: false; reason: "no_match"; attemptsLeft: number }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

/**
 * Kiosk time clock by staff PIN (toggles in/out). Rate limited per kiosk login session, sharing
 * the kiosk PIN-attempt table under a "staff:" key. Returns (never throws) on wrong PINs so the
 * attempt counter commits.
 */
export async function kioskStaffClock(tx: Tx, v: Viewer, input: { pin: string; sessionKey: string; now?: Date }): Promise<KioskClockResult> {
  if (v.role !== "kiosk") throw new AuthzError();
  if (!input.sessionKey) throw new UserError("Kiosk session not found. Please sign the kiosk in again.");
  const now = input.now ?? new Date();
  const pin = input.pin.trim();
  if (!PIN_PATTERN.test(pin)) return { ok: false, reason: "invalid_format" };
  const key = `staff:${input.sessionKey}`;
  await tx.insert(kioskPinAttempts).values({ orgId: v.orgId, sessionKey: key, windowStartedAt: now }).onConflictDoNothing();
  const [att] = await tx.select().from(kioskPinAttempts).where(and(eq(kioskPinAttempts.orgId, v.orgId), eq(kioskPinAttempts.sessionKey, key))).for("update");
  if (att.lockedUntil && att.lockedUntil > now) return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((att.lockedUntil.getTime() - now.getTime()) / 1000) };
  const windowExpired = now.getTime() - att.windowStartedAt.getTime() > STAFF_PIN_WINDOW_MINUTES * 60_000;
  const failedSoFar = windowExpired || att.lockedUntil ? 0 : att.failedCount;
  const [match] = await tx
    .select({ userId: staffClockPins.userId })
    .from(staffClockPins)
    .innerJoin(users, eq(users.id, staffClockPins.userId))
    .where(and(eq(staffClockPins.orgId, v.orgId), eq(staffClockPins.pinHash, hashCheckInPin(v.orgId, `staff:${pin}`)), eq(users.orgId, v.orgId), isNull(users.disabledAt)));
  const where = and(eq(kioskPinAttempts.orgId, v.orgId), eq(kioskPinAttempts.sessionKey, key));
  if (!match) {
    const failed = failedSoFar + 1;
    const lock = failed >= STAFF_PIN_MAX_FAILED;
    await tx
      .update(kioskPinAttempts)
      .set({ failedCount: lock ? 0 : failed, windowStartedAt: failedSoFar === 0 ? now : att.windowStartedAt, lockedUntil: lock ? new Date(now.getTime() + STAFF_PIN_LOCK_MINUTES * 60_000) : null, updatedAt: now })
      .where(where);
    if (lock) {
      await audit(tx, actor(v), "kiosk.staff_pin_lockout", "user", v.userId, { summary: `Staff time-clock PIN entry locked for ${STAFF_PIN_LOCK_MINUTES} minutes` });
      return { ok: false, reason: "locked", retryAfterSeconds: STAFF_PIN_LOCK_MINUTES * 60 };
    }
    return { ok: false, reason: "no_match", attemptsLeft: STAFF_PIN_MAX_FAILED - failed };
  }
  await tx.update(kioskPinAttempts).set({ failedCount: 0, lockedUntil: null, windowStartedAt: now, updatedAt: now }).where(where);
  const r = await doClock(tx, actor(v), v.orgId, match.userId, "toggle", "kiosk", now, v.userId);
  return { ok: true, ...r };
}

/** The viewer's own clock status: open entry and today's closed hours. */
export async function myClockStatus(tx: Tx, v: Viewer, now = new Date()) {
  if (!STAFF.includes(v.role)) return null;
  const tz = await orgTz(tx, v.orgId);
  const { start, end } = localDayBounds(todayLocal(tz, now), tz);
  const rows = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, v.orgId), eq(timeEntries.userId, v.userId), isNull(timeEntries.voidedAt), gte(timeEntries.clockIn, start), lt(timeEntries.clockIn, end)));
  const open = rows.find((r) => !r.clockOut) ?? (await tx.select().from(timeEntries).where(and(eq(timeEntries.orgId, v.orgId), eq(timeEntries.userId, v.userId), isNull(timeEntries.clockOut), isNull(timeEntries.voidedAt))))[0] ?? null;
  const closedMs = rows.filter((r) => r.clockOut).reduce((a, r) => a + (r.clockOut!.getTime() - r.clockIn.getTime()), 0);
  return { open, closedMsToday: closedMs };
}

// ---------------------------------------------------------------------------
// Entries: list, correct, add, void, acknowledge
// ---------------------------------------------------------------------------

export async function listEntries(tx: Tx, v: Viewer, input: { userId?: string; from: string; to: string; includeVoided?: boolean }) {
  if (!STAFF.includes(v.role)) throw new AuthzError();
  const target = input.userId ?? v.userId;
  if (target !== v.userId) await assertPayroll(tx, v);
  const tz = await orgTz(tx, v.orgId);
  const start = localDayBounds(input.from, tz).start;
  const end = localDayBounds(input.to, tz).end;
  return tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.orgId, v.orgId),
        eq(timeEntries.userId, target),
        gte(timeEntries.clockIn, start),
        lt(timeEntries.clockIn, end),
        input.includeVoided ? sql`true` : isNull(timeEntries.voidedAt),
      ),
    )
    .orderBy(desc(timeEntries.clockIn));
}

async function lockEntry(tx: Tx, v: Viewer, entryId: string) {
  const [e] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, entryId), eq(timeEntries.orgId, v.orgId))).for("update");
  if (!e) throw new UserError("Time entry not found.");
  if (e.voidedAt) throw new UserError("That entry was voided.");
  return e;
}

/** Parse a facility-local "YYYY-MM-DDTHH:MM" (datetime-local input) into an instant. */
export async function localInputToUtc(tx: Tx, orgId: string, s: string): Promise<Date> {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(s.trim());
  if (!m) throw new UserError("Use a date and time.", { time: "Date and time" });
  return localToUtc(m[1], m[2], await orgTz(tx, orgId));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Owner/admin (or granted operations) correct an entry. Reason required; originals are preserved; audited. */
export async function editEntry(tx: Tx, v: Viewer, input: { entryId: string; clockIn?: Date; clockOut?: Date; reason: string; now?: Date }) {
  await assertPayroll(tx, v);
  const reason = reasonSchema.parse(input.reason);
  const e = await lockEntry(tx, v, input.entryId);
  const clockIn = input.clockIn ?? e.clockIn;
  const clockOut = input.clockOut ?? e.clockOut;
  if (clockOut && clockOut <= clockIn) throw new UserError("Clock-out must be after clock-in.");
  if (clockOut && clockOut > (input.now ?? new Date())) throw new UserError("Clock-out can't be in the future.");
  if (clockOut && clockOut.getTime() - clockIn.getTime() > 24 * 3_600_000) throw new UserError("A shift can't be longer than 24 hours. Split it into separate entries.");
  if (clockIn.getTime() === e.clockIn.getTime() && (clockOut?.getTime() ?? null) === (e.clockOut?.getTime() ?? null)) throw new UserError("Nothing changed.");
  await tx.update(timeEntries).set({ clockIn, clockOut, editedBy: v.userId, editedAt: new Date(), editReason: reason }).where(eq(timeEntries.id, e.id));
  await audit(tx, actor(v), "time_entry.edit", "time_entry", e.id, {
    summary: `Corrected time entry: ${reason}`,
    before: { clockIn: iso(e.clockIn), clockOut: iso(e.clockOut), originalClockIn: iso(e.originalClockIn), originalClockOut: iso(e.originalClockOut) },
    after: { clockIn: iso(clockIn), clockOut: iso(clockOut), reason },
  });
}

export async function addManualEntry(tx: Tx, v: Viewer, input: { userId: string; clockIn: Date; clockOut: Date; reason: string; now?: Date }) {
  await assertPayroll(tx, v);
  const reason = reasonSchema.parse(input.reason);
  await requireStaffUser(tx, v.orgId, input.userId);
  if (input.clockOut <= input.clockIn) throw new UserError("Clock-out must be after clock-in.");
  if (input.clockOut > (input.now ?? new Date())) throw new UserError("Clock-out can't be in the future.");
  if (input.clockOut.getTime() - input.clockIn.getTime() > 24 * 3_600_000) throw new UserError("A shift can't be longer than 24 hours.");
  const [row] = await tx
    .insert(timeEntries)
    .values({ orgId: v.orgId, userId: input.userId, clockIn: input.clockIn, clockOut: input.clockOut, originalClockIn: input.clockIn, originalClockOut: input.clockOut, source: "manual", createdBy: v.userId, editReason: reason, editedBy: v.userId, editedAt: new Date() })
    .returning();
  await audit(tx, actor(v), "time_entry.manual_add", "time_entry", row.id, { summary: `Manual entry added: ${reason}`, after: { userId: input.userId, clockIn: iso(input.clockIn), clockOut: iso(input.clockOut), reason } });
  return row;
}

export async function voidEntry(tx: Tx, v: Viewer, input: { entryId: string; reason: string }) {
  await assertPayroll(tx, v);
  const reason = reasonSchema.parse(input.reason);
  const e = await lockEntry(tx, v, input.entryId);
  await tx.update(timeEntries).set({ voidedAt: new Date(), voidedBy: v.userId, voidReason: reason }).where(eq(timeEntries.id, e.id));
  await audit(tx, actor(v), "time_entry.void", "time_entry", e.id, { summary: `Voided time entry: ${reason}`, before: { clockIn: iso(e.clockIn), clockOut: iso(e.clockOut) } });
}

export async function acknowledgeFlag(tx: Tx, v: Viewer, input: { entryId: string; code: string; note: string }) {
  await assertPayroll(tx, v);
  if (!ACKABLE.includes(input.code as FlagCode)) throw new UserError("That flag can't be acknowledged — fix the entry instead.");
  const note = reasonSchema.parse(input.note);
  const e = await lockEntry(tx, v, input.entryId);
  if (e.ackFlags.some((a) => a.code === input.code)) return;
  const ack: FlagAck = { code: input.code, by: v.userId, at: new Date().toISOString(), note };
  await tx.update(timeEntries).set({ ackFlags: [...e.ackFlags, ack] }).where(eq(timeEntries.id, e.id));
  await audit(tx, actor(v), "time_entry.flag_ack", "time_entry", e.id, { summary: `Acknowledged ${input.code}: ${note}`, after: ack });
}

// ---------------------------------------------------------------------------
// Payroll calculation & runs
// ---------------------------------------------------------------------------

export function validateRange(from: string, to: string) {
  ymd.parse(from);
  ymd.parse(to);
  if (from > to) throw new UserError("The start date must be on or before the end date.");
  if (addDaysYmd(from, MAX_RANGE_DAYS - 1) < to) throw new UserError(`Pick a range of at most ${MAX_RANGE_DAYS} days.`);
}

export async function calculatePayroll(tx: Tx, v: Viewer, input: { from: string; to: string; now?: Date }): Promise<PayrollResult> {
  await assertPayroll(tx, v);
  validateRange(input.from, input.to);
  const now = input.now ?? new Date();
  const tz = await orgTz(tx, v.orgId);
  const config = await payrollConfig(tx, v.orgId);
  const start = localDayBounds(historyStart(input.from, now, tz, config.thresholds), tz).start;
  const end = localDayBounds(input.to, tz).end;
  // Sequential: these may share one transaction client.
  const staff = await staffMembers(tx, v.orgId);
  const rates = await tx.select().from(staffPayRates).where(eq(staffPayRates.orgId, v.orgId));
  const entries = await tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, v.orgId), isNull(timeEntries.voidedAt), gte(timeEntries.clockIn, start), lt(timeEntries.clockIn, end)));
  return computePayroll({
    from: input.from,
    to: input.to,
    now,
    tz,
    config,
    staff: staff.map((s) => ({ userId: s.userId, name: s.name })),
    rates: rates.map((r) => ({ userId: r.userId, effectiveFrom: r.effectiveFrom, rateMinor: r.rateMinor, label: r.label })),
    entries: entries.map((e) => ({ id: e.id, userId: e.userId, clockIn: e.clockIn, clockOut: e.clockOut, source: e.source, ackCodes: e.ackFlags.map((a) => a.code), edited: !!e.editedAt })),
  });
}

export type RunSnapshot = { result: PayrollResult; config: Pick<PayrollConfig, "deductionBps" | "rounding" | "thresholds"> };

export async function createRun(tx: Tx, v: Viewer, input: { from: string; to: string; now?: Date }) {
  const result = await calculatePayroll(tx, v, input);
  const config = await payrollConfig(tx, v.orgId);
  const snapshot: RunSnapshot = { result, config: { deductionBps: config.deductionBps, rounding: config.rounding, thresholds: config.thresholds } };
  const [run] = await tx
    .insert(payrollRuns)
    .values({
      orgId: v.orgId,
      fromDate: input.from,
      toDate: input.to,
      snapshot: snapshot as unknown as Record<string, unknown>,
      grossMinor: result.combined.actual.grossMinor,
      deductionMinor: result.combined.actual.deductionMinor,
      netMinor: result.combined.actual.netMinor,
      createdBy: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "payroll.run_create", "payroll_run", run.id, { summary: `Draft payroll ${input.from}..${input.to}`, after: { gross: run.grossMinor, net: run.netMinor } });
  return run;
}

async function lockRun(tx: Tx, v: Viewer, runId: string) {
  await assertPayroll(tx, v);
  const [r] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, v.orgId))).for("update");
  if (!r) throw new UserError("Payroll run not found.");
  return r;
}

/** Recalculate a draft run from current entries (after flags were resolved). */
export async function recalculateRun(tx: Tx, v: Viewer, runId: string, now?: Date) {
  const r = await lockRun(tx, v, runId);
  if (r.status !== "draft") throw new UserError("Only draft runs can be recalculated.");
  const result = await calculatePayroll(tx, v, { from: r.fromDate, to: r.toDate, now });
  const config = await payrollConfig(tx, v.orgId);
  const snapshot: RunSnapshot = { result, config: { deductionBps: config.deductionBps, rounding: config.rounding, thresholds: config.thresholds } };
  await tx
    .update(payrollRuns)
    .set({ snapshot: snapshot as unknown as Record<string, unknown>, grossMinor: result.combined.actual.grossMinor, deductionMinor: result.combined.actual.deductionMinor, netMinor: result.combined.actual.netMinor })
    .where(eq(payrollRuns.id, r.id));
  await audit(tx, actor(v), "payroll.run_recalculate", "payroll_run", r.id, { before: { gross: r.grossMinor }, after: { gross: result.combined.actual.grossMinor } });
}

export async function approveRun(tx: Tx, v: Viewer, runId: string) {
  const r = await lockRun(tx, v, runId);
  if (r.status !== "draft") throw new UserError("This run is already approved.");
  const snap = r.snapshot as unknown as RunSnapshot;
  if (snap.result.blockingOpen > 0) throw new UserError(`Resolve the ${snap.result.blockingOpen} open flag(s) (runaway shifts, missed clock-outs, stray entries, missing rates), then recalculate before approving.`);
  if (snap.result.employees.some((e) => e.incomplete)) throw new UserError("Some hours have no pay rate. Add the rate, then recalculate.");
  await tx.update(payrollRuns).set({ status: "approved", approvedBy: v.userId, approvedAt: new Date() }).where(eq(payrollRuns.id, r.id));
  await audit(tx, actor(v), "payroll.run_approve", "payroll_run", r.id, { summary: `Approved payroll ${r.fromDate}..${r.toDate}`, after: { gross: r.grossMinor, deduction: r.deductionMinor, net: r.netMinor } });
}

export async function discardRun(tx: Tx, v: Viewer, runId: string) {
  const r = await lockRun(tx, v, runId);
  if (r.status !== "draft") throw new UserError("Approved runs can't be discarded.");
  await tx.delete(payrollRuns).where(eq(payrollRuns.id, r.id));
  await audit(tx, actor(v), "payroll.run_discard", "payroll_run", r.id, { summary: `Discarded draft ${r.fromDate}..${r.toDate}` });
}

/** Returns the CSV for an approved/exported run and records the export. */
export async function exportRun(tx: Tx, v: Viewer, runId: string): Promise<{ csv: string; filename: string }> {
  const r = await lockRun(tx, v, runId);
  if (r.status === "draft") throw new UserError("Approve the run before exporting.");
  await tx.update(payrollRuns).set({ status: "exported", exportedBy: v.userId, exportedAt: new Date() }).where(eq(payrollRuns.id, r.id));
  await audit(tx, actor(v), "payroll.run_export", "payroll_run", r.id, { summary: `Exported payroll ${r.fromDate}..${r.toDate}` });
  return { csv: runToCsv(r.snapshot as unknown as RunSnapshot), filename: `teamwork-payroll-${r.fromDate}-to-${r.toDate}.csv` };
}

export async function listRuns(tx: Tx, v: Viewer) {
  await assertPayroll(tx, v);
  return tx
    .select({ id: payrollRuns.id, fromDate: payrollRuns.fromDate, toDate: payrollRuns.toDate, status: payrollRuns.status, grossMinor: payrollRuns.grossMinor, netMinor: payrollRuns.netMinor, createdAt: payrollRuns.createdAt })
    .from(payrollRuns)
    .where(eq(payrollRuns.orgId, v.orgId))
    .orderBy(desc(payrollRuns.createdAt))
    .limit(50);
}

export async function getRun(tx: Tx, v: Viewer, runId: string) {
  await assertPayroll(tx, v);
  const [r] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, v.orgId)));
  return r ? { ...r, status: r.status as PayrollRunStatus, snap: r.snapshot as unknown as RunSnapshot } : null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const csvEsc = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const dollars = (m: number | null) => (m == null ? "" : (m / 100).toFixed(2));
const hours = (h: number) => (h / 100).toFixed(2);

/** One line per shift/estimate plus per-employee and combined totals. Estimates are labeled, never mixed into actual totals. */
export function runToCsv(snap: RunSnapshot): string {
  const { result } = snap;
  const lines: string[] = [];
  lines.push(["Employee", "Date", "Kind", "Clock in", "Clock out", "Hours", "Rate", "Pay", "Included", "Flags"].map(csvEsc).join(","));
  for (const e of result.employees) {
    for (const r of e.rows) {
      if (r.kind === "none") continue;
      lines.push(
        [
          e.name,
          r.date,
          r.kind === "estimate" ? "ESTIMATE" : r.kind,
          r.clockIn ?? "",
          r.clockOut ?? "",
          hours(r.hoursHundredths),
          dollars(r.rateMinor),
          dollars(r.payMinor),
          r.included ? "yes" : "no",
          r.flags.map((f) => `${f.code}${f.acknowledged ? " (acknowledged)" : ""}`).join("; "),
        ]
          .map(csvEsc)
          .join(","),
      );
    }
  }
  lines.push("");
  lines.push(["Employee", "Hours (actual)", "Gross (actual)", `Deduction ${result.deductionBps / 100}%`, "Net (actual)", "Hours (estimated)", "Gross (estimated)", "Gross (projected)", "Net (projected)"].map(csvEsc).join(","));
  const tot = (name: string, a: (typeof result.combined)["actual"], est: (typeof result.combined)["estimated"], p: (typeof result.combined)["projected"]) =>
    [name, hours(a.hoursHundredths), dollars(a.grossMinor), dollars(a.deductionMinor), dollars(a.netMinor), hours(est.hoursHundredths), dollars(est.grossMinor), dollars(p.grossMinor), dollars(p.netMinor)].map(csvEsc).join(",");
  for (const e of result.employees) lines.push(tot(e.name, e.actual, e.estimated, e.projected));
  lines.push(tot("COMBINED", result.combined.actual, result.combined.estimated, result.combined.projected));
  lines.push("");
  lines.push(csvEsc(`Rounding: ${result.rounding}. Deduction is an estimate (confirm with your accountant). Range ${result.from}..${result.to}; times are UTC ISO-8601.`));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Zen Planner import
// ---------------------------------------------------------------------------

export type ImportPreview = { rows: ParsedRow[]; entries: number; duplicates: number; created: number; configuredRateMinor: number | null };

/** Parse (and optionally commit) a pasted Zen Planner payroll report for one staff member. Duplicate rows are skipped. */
export async function importZenPlanner(tx: Tx, v: Viewer, input: { userId: string; text: string; commit: boolean }): Promise<ImportPreview> {
  await assertPayroll(tx, v);
  await requireStaffUser(tx, v.orgId, input.userId);
  if (input.text.length > 500_000) throw new UserError("That paste is too large; import one pay period at a time.");
  const tz = await orgTz(tx, v.orgId);
  const config = await payrollConfig(tx, v.orgId);
  const rows = parseZenPlannerPayroll(input.text, config.importMapping, tz);
  const entries = rows.filter((r) => r.status === "entry");
  const existing = entries.length ? await tx.select({ clockIn: timeEntries.clockIn }).from(timeEntries).where(and(eq(timeEntries.orgId, v.orgId), eq(timeEntries.userId, input.userId), isNull(timeEntries.voidedAt), inArray(timeEntries.clockIn, entries.map((r) => r.clockIn!)))) : [];
  const existingIn = new Set(existing.map((e) => e.clockIn.getTime()));
  let duplicates = 0;
  let created = 0;
  for (const r of entries) {
    if (existingIn.has(r.clockIn!.getTime())) {
      duplicates++;
      r.warnings.push("Already recorded — will be skipped.");
    }
  }
  const [rate] = await tx.select().from(staffPayRates).where(eq(staffPayRates.userId, input.userId)).orderBy(desc(staffPayRates.effectiveFrom)).limit(1);
  if (input.commit) {
    for (const r of entries) {
      if (existingIn.has(r.clockIn!.getTime())) continue;
      const ins = await tx
        .insert(timeEntries)
        .values({
          orgId: v.orgId,
          userId: input.userId,
          clockIn: r.clockIn!,
          clockOut: r.clockOut!,
          originalClockIn: r.clockIn!,
          originalClockOut: r.clockOut!,
          source: "import",
          createdBy: v.userId,
          importKey: `${input.userId}:${r.clockIn!.toISOString()}`,
          importRaw: r.raw.slice(0, 500),
        })
        .onConflictDoNothing()
        .returning({ id: timeEntries.id });
      if (ins.length) created++;
      else duplicates++;
    }
    await audit(tx, actor(v), "time_entry.import", "user", input.userId, { summary: `Imported ${created} Zen Planner time entr${created === 1 ? "y" : "ies"} (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` });
  }
  return { rows, entries: entries.length, duplicates, created, configuredRateMinor: rate?.rateMinor ?? null };
}
