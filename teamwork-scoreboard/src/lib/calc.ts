/**
 * Canonical calculation helpers. Every rate/ratio in the app goes through
 * these so division-by-zero and status logic behave identically everywhere.
 * Covered by unit tests in src/lib/__tests__/calc.test.ts.
 */

export type Status = "red" | "yellow" | "green" | "none";
export type Direction = "up" | "down";

/** Safe division: returns null when the denominator is zero/invalid. */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

/** Safe percentage (0-100), null when denominator is zero. */
export function safePct(numerator: number, denominator: number): number | null {
  const r = safeDiv(numerator, denominator);
  return r === null ? null : r * 100;
}

/**
 * Goal attainment as a percentage.
 * - direction "up"  : actual / goal
 * - direction "down": goal / actual (lower actual = better; capped at 200%)
 * Returns null when it cannot be computed (no goal, zero denominators).
 */
export function goalAttainment(
  actual: number | null,
  goal: number | null | undefined,
  direction: Direction = "up"
): number | null {
  if (actual === null || goal === null || goal === undefined) return null;
  if (direction === "up") {
    if (goal === 0) return actual === 0 ? 100 : null;
    const pct = (actual / goal) * 100;
    return Math.round(pct * 10) / 10;
  }
  // lower is better
  if (actual === 0) return 200; // hit or beat a "lower is better" goal completely
  if (goal === 0) return null;
  const pct = Math.min((goal / actual) * 100, 200);
  return Math.round(pct * 10) / 10;
}

/**
 * Red/yellow/green from attainment % and configurable thresholds.
 * attainment >= yellowBelowPct -> green
 * attainment >= redBelowPct    -> yellow
 * otherwise                    -> red
 */
export function statusFor(
  attainmentPct: number | null,
  redBelowPct = 70,
  yellowBelowPct = 90
): Status {
  if (attainmentPct === null) return "none";
  if (attainmentPct >= yellowBelowPct) return "green";
  if (attainmentPct >= redBelowPct) return "yellow";
  return "red";
}

/** Difference from goal respecting direction (positive = ahead of goal). */
export function goalDiff(
  actual: number | null,
  goal: number | null | undefined,
  direction: Direction = "up"
): number | null {
  if (actual === null || goal === null || goal === undefined) return null;
  const d = actual - goal;
  return direction === "up" ? d : -d;
}

/** Percentage change from previous period, null-safe. */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  const r = safeDiv(current - previous, Math.abs(previous));
  return r === null ? null : Math.round(r * 1000) / 10;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Format a value for display given a metric unit. */
export function formatValue(
  value: number | null,
  unit: string,
  opts: { compact?: boolean } = {}
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  switch (unit) {
    case "percent":
      return `${Math.round(value * 10) / 10}%`;
    case "currency": {
      const whole = opts.compact || Number.isInteger(value);
      return value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: whole ? 0 : 2,
        minimumFractionDigits: whole ? 0 : 2,
      });
    }
    case "minutes": {
      if (value >= 60 * 24) return `${Math.round(value / (60 * 24))}d`;
      if (value >= 90) return `${Math.round((value / 60) * 10) / 10}h`;
      return `${Math.round(value)}m`;
    }
    case "days":
      return `${Math.round(value * 10) / 10}d`;
    default:
      return Number.isInteger(value)
        ? value.toLocaleString("en-US")
        : (Math.round(value * 10) / 10).toLocaleString("en-US");
  }
}
