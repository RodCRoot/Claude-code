"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireStaff } from "@/lib/auth/viewer";
import { bpsToPercent, percentToBps } from "@/lib/payroll/calc";
import {
  acknowledgeFlag,
  addManualEntry,
  approveRun,
  createRun,
  discardRun,
  editEntry,
  importZenPlanner,
  localInputToUtc,
  recalculateRun,
  setPayRate,
  setStaffClockPin,
  updatePayrollSettings,
  voidEntry,
} from "@/lib/payroll/service";
import { formatMoney } from "@/lib/money";

const uuid = z.string().uuid();
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const done = (message: string): ActionState => {
  revalidatePath("/payroll", "layout");
  return { ok: true, message };
};

export const editEntryAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const entryId = uuid.parse(fd.get("entryId"));
  await db.transaction(async (tx) => {
    const changed = (k: string) => str(fd, k) !== "" && str(fd, k) !== str(fd, `orig${k[0].toUpperCase()}${k.slice(1)}`);
    const clockIn = changed("clockIn") ? await localInputToUtc(tx, v.orgId, str(fd, "clockIn")) : undefined;
    const clockOut = changed("clockOut") ? await localInputToUtc(tx, v.orgId, str(fd, "clockOut")) : undefined;
    await editEntry(tx, v, { entryId, clockIn, clockOut, reason: str(fd, "reason") });
  });
  return done("Entry corrected. Totals updated.");
});

export const voidEntryAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  await db.transaction((tx) => voidEntry(tx, v, { entryId: uuid.parse(fd.get("entryId")), reason: str(fd, "reason") }));
  return done("Entry voided.");
});

export const ackFlagAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  await db.transaction((tx) => acknowledgeFlag(tx, v, { entryId: uuid.parse(fd.get("entryId")), code: str(fd, "code"), note: str(fd, "note") }));
  return done("Flag acknowledged.");
});

export const addEntryAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  await db.transaction(async (tx) => {
    const clockIn = await localInputToUtc(tx, v.orgId, str(fd, "clockIn"));
    const clockOut = await localInputToUtc(tx, v.orgId, str(fd, "clockOut"));
    await addManualEntry(tx, v, { userId: uuid.parse(fd.get("userId")), clockIn, clockOut, reason: str(fd, "reason") });
  });
  return done("Entry added.");
});

export const createRunAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const run = await db.transaction((tx) => createRun(tx, v, { from: str(fd, "from"), to: str(fd, "to") }));
  revalidatePath("/payroll", "layout");
  redirect(`/payroll/runs/${run.id}`);
});

export const runAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const id = uuid.parse(fd.get("runId"));
  const op = str(fd, "op");
  if (op === "recalculate") {
    await db.transaction((tx) => recalculateRun(tx, v, id));
    return done("Recalculated from current entries.");
  }
  if (op === "approve") {
    await db.transaction((tx) => approveRun(tx, v, id));
    return done("Payroll approved. Export the CSV for your payroll provider.");
  }
  if (op === "discard") {
    await db.transaction((tx) => discardRun(tx, v, id));
    revalidatePath("/payroll", "layout");
    redirect("/payroll");
  }
  throw new UserError("Unknown action.");
});

export const saveSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const bps = percentToBps(str(fd, "deductionPercent"));
  if (bps == null) throw new UserError("Enter a deduction percent between 0 and 100.", { deductionPercent: "0–100" });
  const t = (k: string) => fd.get(k);
  await db.transaction((tx) =>
    updatePayrollSettings(tx, v, {
      deductionBps: bps,
      rounding: str(fd, "rounding"),
      thresholds: Object.fromEntries(
        ["runawayMaxHours", "runawayCrossDayMinHours", "runawayNormFactor", "tinyHours", "tinyNormMinHours", "offPatternMinutes", "orphanMaxHours", "lookbackWeeks", "expectedWeekdayMinWeeks", "estimateSampleDays", "minSamplesForNorm"].map((k) => [k, t(k)]),
      ),
      importMapping: Object.fromEntries(["dateCol", "rateLabelCol", "rateCol", "timeInCol", "timeOutCol", "hoursCol", "amountCol", "noEntryMarker"].map((k) => [k, t(k)])),
      accessUserIds: fd.getAll("accessUserIds").map(String),
    }),
  );
  return done(`Payroll settings saved (deduction ${bpsToPercent(bps)}%).`);
});

export const setRateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const r = await db.transaction((tx) => setPayRate(tx, v, { userId: str(fd, "userId"), label: str(fd, "label"), rate: str(fd, "rate"), effectiveFrom: str(fd, "effectiveFrom") }));
  return done(`Rate ${formatMoney(r.rateMinor)}/h effective ${r.effectiveFrom} saved.`);
});

export const setStaffPinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const clear = fd.get("clear") === "1";
  await db.transaction((tx) => setStaffClockPin(tx, v, { userId: uuid.parse(fd.get("userId")), pin: clear ? null : str(fd, "pin") }));
  return done(clear ? "PIN removed." : "PIN saved. Share it privately with the staff member.");
});

export const importAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const commit = fd.get("commit") === "1";
  const res = await db.transaction((tx) => importZenPlanner(tx, v, { userId: uuid.parse(fd.get("userId")), text: String(fd.get("text") ?? ""), commit }));
  if (commit) revalidatePath("/payroll", "layout");
  return {
    ok: true,
    message: commit ? `Imported ${res.created} entr${res.created === 1 ? "y" : "ies"}; ${res.duplicates} duplicate${res.duplicates === 1 ? "" : "s"} skipped.` : `Preview: ${res.entries} shift${res.entries === 1 ? "" : "s"} found, ${res.duplicates} already recorded. Nothing saved yet.`,
    data: {
      committed: commit,
      configuredRateMinor: res.configuredRateMinor,
      rows: res.rows.map((r) => ({
        line: r.line,
        status: r.status,
        date: r.date ?? null,
        clockIn: r.clockIn?.toISOString() ?? null,
        clockOut: r.clockOut?.toISOString() ?? null,
        plusDays: r.plusDays ?? 0,
        rateMinor: r.rateMinor ?? null,
        recomputedHundredths: r.recomputedHundredths ?? null,
        listedHundredths: r.listedHundredths ?? null,
        warnings: r.warnings,
        error: r.error ?? null,
      })),
    },
  };
});
