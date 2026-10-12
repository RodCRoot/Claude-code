/**
 * Pure payroll arithmetic. All money is integer cents; hours are carried as milliseconds (exact)
 * or hundredths of an hour (Zen Planner style), never floats that feed money.
 */
import type { PayrollRounding } from "@/db/schema";

export const MS_PER_HOUR = 3_600_000;
/** One hundredth of an hour = 36 seconds. */
export const MS_PER_HUNDREDTH = 36_000;

/** Half-up rounding of a non-negative rational a/b to an integer (exact integer arithmetic via BigInt). */
export function divRoundHalfUp(a: number, b: number): number {
  if (b <= 0) throw new Error("divisor must be positive");
  const A = BigInt(Math.round(a));
  const B = BigInt(Math.round(b));
  const ZERO = BigInt(0);
  const TWO = BigInt(2);
  const neg = A < ZERO;
  const absA = neg ? -A : A;
  const q = (absA * TWO + B) / (TWO * B);
  return Number(neg ? -q : q);
}

/**
 * Hours for one shift in hundredths.
 * - truncate_2dp: Zen Planner's display — fractional hours truncated to 2 decimals (3h 17m 59s = 3.2997 h → 3.29).
 * - exact: rounded half-up to the hundredth for display only; pay uses the exact duration.
 */
export function shiftHundredths(durationMs: number, rounding: PayrollRounding): number {
  if (durationMs <= 0) return 0;
  return rounding === "truncate_2dp" ? Math.floor(durationMs / MS_PER_HUNDREDTH) : divRoundHalfUp(durationMs, MS_PER_HUNDREDTH);
}

/** Pay for one shift in cents. truncate_2dp: truncated hours × rate; exact: exact duration × rate. Both round half-up to the cent. */
export function shiftPayMinor(durationMs: number, rateMinor: number, rounding: PayrollRounding): number {
  if (durationMs <= 0) return 0;
  if (rounding === "truncate_2dp") return divRoundHalfUp(shiftHundredths(durationMs, rounding) * rateMinor, 100);
  return divRoundHalfUp(durationMs * rateMinor, MS_PER_HOUR);
}

/** Pay for a number of hundredths (used for estimates, which are already in hundredths). */
export function hundredthsPayMinor(hundredths: number, rateMinor: number): number {
  return divRoundHalfUp(hundredths * rateMinor, 100);
}

export type Totals = { hoursHundredths: number; grossMinor: number; deductionMinor: number; netMinor: number };

/** Deduction = gross × bps / 10000, half-up to the cent; net = gross − deduction (so the parts always add up). */
export function applyDeduction(grossMinor: number, deductionBps: number): { deductionMinor: number; netMinor: number } {
  const deductionMinor = divRoundHalfUp(grossMinor * deductionBps, 10_000);
  return { deductionMinor, netMinor: grossMinor - deductionMinor };
}

export function totalsOf(hoursHundredths: number, grossMinor: number, deductionBps: number): Totals {
  return { hoursHundredths, grossMinor, ...applyDeduction(grossMinor, deductionBps) };
}

/** Sum per-employee totals. Deductions are summed (each computed per employee), not recomputed on the combined gross. */
export function sumTotals(list: Totals[]): Totals {
  return list.reduce(
    (a, t) => ({
      hoursHundredths: a.hoursHundredths + t.hoursHundredths,
      grossMinor: a.grossMinor + t.grossMinor,
      deductionMinor: a.deductionMinor + t.deductionMinor,
      netMinor: a.netMinor + t.netMinor,
    }),
    { hoursHundredths: 0, grossMinor: 0, deductionMinor: 0, netMinor: 0 },
  );
}

export function fmtHundredths(h: number): string {
  return (h / 100).toFixed(2);
}

/** "17.5" → 1750 bps; null if invalid. */
export function percentToBps(input: string): number | null {
  const s = input.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const bps = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return bps <= 10_000 ? bps : null;
}

export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}
