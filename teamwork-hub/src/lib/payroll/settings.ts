import type { PayrollRounding } from "@/db/schema";

/** Detector thresholds. All configurable in Payroll → Settings. */
export type PayrollThresholds = {
  /** Any shift longer than this is a runaway (likely missed clock-out). */
  runawayMaxHours: number;
  /** A shift that ends on a later local day ("+N days") and is at least this long is a runaway. */
  runawayCrossDayMinHours: number;
  /** A shift longer than factor × the person's median shift (and ≥ 2 h above it) is a runaway. */
  runawayNormFactor: number;
  /** Shifts shorter than this are "tiny" (included, flagged)… */
  tinyHours: number;
  /** …when the person's median shift is at least this long (or unknown). */
  tinyNormMinHours: number;
  /** Start time more than this many minutes from the person's usual start for that weekday is off-pattern. */
  offPatternMinutes: number;
  /** A shift shorter than this on the day after a runaway is a likely stray clock-out (orphan). */
  orphanMaxHours: number;
  /** History window (weeks) for norms and the "usually works this weekday" rule. */
  lookbackWeeks: number;
  /** Worked that weekday in at least this many of the lookback weeks → a missing day is flagged. */
  expectedWeekdayMinWeeks: number;
  /** Estimates average the most recent N worked same-weekday days. */
  estimateSampleDays: number;
  /** Minimum closed shifts before a median norm is trusted. */
  minSamplesForNorm: number;
};

export const DEFAULT_THRESHOLDS: PayrollThresholds = {
  runawayMaxHours: 12,
  runawayCrossDayMinHours: 8,
  runawayNormFactor: 2.5,
  tinyHours: 0.5,
  tinyNormMinHours: 2,
  offPatternMinutes: 90,
  orphanMaxHours: 1.5,
  lookbackWeeks: 6,
  expectedWeekdayMinWeeks: 3,
  estimateSampleDays: 4,
  minSamplesForNorm: 5,
};

/**
 * Zen Planner payroll paste/CSV mapping. UNVERIFIED against a real export — every index is
 * configurable. Columns: `Ddd, DD Mon YYYY | PayRateLabel | $XX.XX / hour | Time In | Time Out | X.XX hours | $XX.XX`.
 */
export type ImportMapping = {
  dateCol: number;
  rateLabelCol: number;
  rateCol: number;
  timeInCol: number;
  timeOutCol: number;
  hoursCol: number;
  amountCol: number;
  /** A row whose last non-empty cell equals this marker has no entry (Zen Planner's "Add" link). */
  noEntryMarker: string;
};

export const DEFAULT_IMPORT_MAPPING: ImportMapping = {
  dateCol: 0,
  rateLabelCol: 1,
  rateCol: 2,
  timeInCol: 3,
  timeOutCol: 4,
  hoursCol: 5,
  amountCol: 6,
  noEntryMarker: "Add",
};

export type PayrollConfig = {
  deductionBps: number;
  rounding: PayrollRounding;
  thresholds: PayrollThresholds;
  importMapping: ImportMapping;
  accessUserIds: string[];
};

/** Teamwork's current practice is 17%; it is an estimate — confirm with your accountant. */
export const DEFAULT_DEDUCTION_BPS = 1700;

export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  deductionBps: DEFAULT_DEDUCTION_BPS,
  rounding: "truncate_2dp",
  thresholds: DEFAULT_THRESHOLDS,
  importMapping: DEFAULT_IMPORT_MAPPING,
  accessUserIds: [],
};

export const ROUNDING_LABEL: Record<PayrollRounding, string> = {
  truncate_2dp: "Truncate to 2 decimals (matches Zen Planner)",
  exact: "Exact minutes (round to the cent)",
};
