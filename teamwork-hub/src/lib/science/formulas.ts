/**
 * Teamwork sports-science formulas. Pure functions only — no database, no Next.
 *
 * Every calculation has a version key (e.g. `srpe_load_v1`). If the math ever
 * changes, add a new key instead of editing an old one so stored/derived values
 * can always be traced to the exact formula that produced them.
 *
 * Conventions:
 *  - Missing or non-calculable results are `null`, never 0.
 *  - Vendor aggregate rows (e.g. a Hawkin "mean of trials" row) are never mixed with trials.
 *  - Units are never compared without an explicit conversion (see `convertUnit`).
 *  - These are Teamwork calculations. None of them claims to reproduce any vendor's
 *    proprietary index (TeamBuildr, Hawkin, or otherwise).
 *
 * Every formula is documented in docs/modules/sports-science.md.
 */

import type { QuestionDef } from "@/db/schema/science";

// ---------------------------------------------------------------------------
// Registry (shown in the UI next to every derived number)
// ---------------------------------------------------------------------------

export type FormulaKey =
  | "srpe_load_v1"
  | "tw_readiness_v1"
  | "acwr_rolling_v1"
  | "monotony_v1"
  | "strain_v1"
  | "tonnage_v1"
  | "intensity_zone_v1"
  | "trial_selection_v1"
  | "swc_02sd_v1"
  | "change_pct_v1"
  | "asymmetry_v1"
  | "habit_adherence_v1"
  | "attendance_rate_v1";

export const FORMULAS: Record<FormulaKey, { name: string; unit: string; definition: string }> = {
  srpe_load_v1: {
    name: "Session load (sRPE)",
    unit: "AU (arbitrary units)",
    definition: "duration (min) × session RPE (CR-10, 0–10). Null when either input is missing.",
  },
  tw_readiness_v1: {
    name: "Teamwork readiness (v1)",
    unit: "0–100 (Teamwork scale)",
    definition:
      "Mean of polarity-normalized 0–100 scores over answered, required scale items with a direction. Null when fewer than half of those items were answered. A Teamwork calculation, not a vendor index.",
  },
  acwr_rolling_v1: {
    name: "Acute:chronic workload ratio (rolling, v1)",
    unit: "ratio (unitless)",
    definition:
      "7-day mean daily load ÷ 28-day mean daily load (coupled windows ending on the as-of date). Only days with known load count: logged sessions, or days explicitly recorded as rest (0). Null when coverage of either window is below the configured threshold or chronic mean is 0.",
  },
  monotony_v1: {
    name: "Training monotony (v1)",
    unit: "ratio (unitless)",
    definition: "Mean daily load ÷ SD of daily load over 7 days. Requires all 7 days known. Null if SD is 0.",
  },
  strain_v1: {
    name: "Training strain (v1)",
    unit: "AU",
    definition: "Weekly total load × monotony_v1. Null when monotony is null.",
  },
  tonnage_v1: {
    name: "Tonnage (v1)",
    unit: "display mass unit (lb or kg) × reps",
    definition:
      "Σ load × reps over completed working sets. Warm-ups excluded by default; sets missing load are excluded from tonnage but counted in reps; bodyweight movements use bodyweight_factor × body mass when known; unilateral sets summed per side; lb↔kg converted with 1 lb = 0.45359237 kg.",
  },
  intensity_zone_v1: {
    name: "Intensity zone (v1)",
    unit: "% of dated max",
    definition: "Set load ÷ the most recent max recorded on or before the set's date (same exercise or its max-source exercise), unit-converted. Zones <60, 60–70, 70–80, 80–90, ≥90; 'no max' when none is available.",
  },
  trial_selection_v1: {
    name: "Trial selection (v1)",
    unit: "metric unit",
    definition: "best / mean / latest over included individual trials only. Vendor aggregate rows and excluded trials are never included; null values are skipped.",
  },
  swc_02sd_v1: {
    name: "Smallest-worthwhile-change band (Teamwork convention)",
    unit: "metric unit",
    definition: "0.2 × between-session SD of the athlete's session values (needs ≥ 3 sessions). A Teamwork convention, not a vendor statistic.",
  },
  change_pct_v1: {
    name: "Change vs baseline",
    unit: "%",
    definition: "(current − baseline) ÷ |baseline| × 100. Null if either is missing or baseline is 0.",
  },
  asymmetry_v1: {
    name: "Bilateral asymmetry (Teamwork-derived)",
    unit: "%",
    definition: "(left − right) ÷ ((left + right) ÷ 2) × 100. Positive = left greater. Null if either side is missing or both are 0.",
  },
  habit_adherence_v1: {
    name: "Habit adherence (v1)",
    unit: "%",
    definition: "(done + 0.5 × partial) ÷ expected check-ins × 100 over the window. Days with no check-in count as not adhered and are reported separately from explicit 'missed'.",
  },
  attendance_rate_v1: {
    name: "Attendance rate (v1)",
    unit: "%",
    definition: "attended ÷ (attended + no-show) bookings in the window × 100. Cancelled bookings are excluded. Null if no eligible bookings.",
  },
};

// ---------------------------------------------------------------------------
// Basic statistics (null-aware)
// ---------------------------------------------------------------------------

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Mean of present values; null when none are present (missing is never treated as 0). */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation of present values; null when fewer than 2. */
export function sd(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function sum(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

export function round(v: number | null | undefined, digits = 2): number | null {
  if (!isNum(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Units — explicit conversion only
// ---------------------------------------------------------------------------

/** Exact by definition (international pound, 1959). */
export const KG_PER_LB = 0.45359237;
/** Exact by definition (international inch). */
export const CM_PER_IN = 2.54;

const MASS: Record<string, number> = { kg: 1, lb: KG_PER_LB };
const LENGTH: Record<string, number> = { m: 1, cm: 0.01, in: CM_PER_IN / 100, ft: 0.3048, yd: 0.9144 };
const TIME: Record<string, number> = { s: 1, ms: 0.001, min: 60 };

export type UnitFamily = "mass" | "length" | "time" | "other";

export function unitFamily(unit: string): UnitFamily {
  if (unit in MASS) return "mass";
  if (unit in LENGTH) return "length";
  if (unit in TIME) return "time";
  return "other";
}

/**
 * Convert between compatible units. Returns null (never a guess) when the units are
 * in different families or unknown. Identical unit strings pass through unchanged.
 */
export function convertUnit(value: number | null | undefined, from: string, to: string): number | null {
  if (!isNum(value)) return null;
  if (from === to) return value;
  for (const table of [MASS, LENGTH, TIME]) {
    if (from in table && to in table) return (value * table[from]) / table[to];
  }
  return null;
}

export const convertMass = (v: number | null | undefined, from: "lb" | "kg", to: "lb" | "kg") => convertUnit(v, from, to);

// ---------------------------------------------------------------------------
// Load monitoring
// ---------------------------------------------------------------------------

/** srpe_load_v1: duration_min × sRPE (CR-10). AU. Null if missing or out of range. */
export function srpeLoad(durationMin: number | null | undefined, rpe: number | null | undefined): number | null {
  if (!isNum(durationMin) || !isNum(rpe)) return null;
  if (durationMin < 0 || rpe < 0 || rpe > 10) return null;
  return durationMin * rpe;
}

export type LoadEntry = { date: string; durationMin: number | null; rpe: number | null; kind?: string };

export type DailyLoad = {
  date: string;
  /** Known daily load in AU; null = unknown (no entry, or an entry whose load can't be calculated). */
  load: number | null;
  status: "logged" | "rest" | "incomplete" | "no_data";
  sessions: number;
};

/**
 * Build a dense daily series. A day is:
 *  - "rest": explicitly recorded as no activity → load 0 (the ONLY way a gap becomes 0)
 *  - "logged": every session that day has a computable sRPE load → sum
 *  - "incomplete": at least one session lacks duration or RPE → null
 *  - "no_data": nothing recorded → null (coverage gap)
 */
export function dailyLoadSeries(entries: readonly LoadEntry[], startYmd: string, endYmd: string, restDays: ReadonlySet<string> = new Set()): DailyLoad[] {
  const byDate = new Map<string, LoadEntry[]>();
  for (const e of entries) {
    if (e.kind === "rest") continue;
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }
  const restFromEntries = new Set(entries.filter((e) => e.kind === "rest").map((e) => e.date));
  const out: DailyLoad[] = [];
  for (let d = startYmd; d <= endYmd; d = addDaysYmdPure(d, 1)) {
    const list = byDate.get(d);
    if (list?.length) {
      const loads = list.map((e) => srpeLoad(e.durationMin, e.rpe));
      const complete = loads.every(isNum);
      out.push({ date: d, load: complete ? (loads as number[]).reduce((a, b) => a + b, 0) : null, status: complete ? "logged" : "incomplete", sessions: list.length });
    } else if (restDays.has(d) || restFromEntries.has(d)) {
      out.push({ date: d, load: 0, status: "rest", sessions: 0 });
    } else {
      out.push({ date: d, load: null, status: "no_data", sessions: 0 });
    }
  }
  return out;
}

export type AcwrResult = {
  formula: "acwr_rolling_v1";
  asOf: string;
  acuteWindow: { start: string; end: string; days: number };
  chronicWindow: { start: string; end: string; days: number };
  acuteMean: number | null;
  chronicMean: number | null;
  acuteCoverage: number;
  chronicCoverage: number;
  ratio: number | null;
  reason: string | null;
};

/**
 * acwr_rolling_v1. `series` must cover at least the chronic window ending at asOf
 * (days outside it are ignored; missing days are treated as unknown).
 */
export function acwrRolling(
  series: readonly DailyLoad[],
  asOf: string,
  opts: { acuteDays?: number; chronicDays?: number; minCoverage?: number } = {},
): AcwrResult {
  const acuteDays = opts.acuteDays ?? 7;
  const chronicDays = opts.chronicDays ?? 28;
  const minCoverage = opts.minCoverage ?? 0.75;
  const byDate = new Map(series.map((d) => [d.date, d]));
  const window = (n: number) => {
    const start = addDaysYmdPure(asOf, -(n - 1));
    const vals: (number | null)[] = [];
    for (let d = start; d <= asOf; d = addDaysYmdPure(d, 1)) vals.push(byDate.get(d)?.load ?? null);
    const known = vals.filter(isNum);
    return { start, coverage: known.length / n, mean: mean(known) };
  };
  const a = window(acuteDays);
  const c = window(chronicDays);
  let ratio: number | null = null;
  let reason: string | null = null;
  if (c.coverage < minCoverage) reason = `Chronic window coverage ${Math.round(c.coverage * 100)}% is below the ${Math.round(minCoverage * 100)}% threshold.`;
  else if (a.coverage < minCoverage) reason = `Acute window coverage ${Math.round(a.coverage * 100)}% is below the ${Math.round(minCoverage * 100)}% threshold.`;
  else if (!isNum(c.mean) || c.mean === 0) reason = "Chronic mean load is 0 or unknown; a ratio is not meaningful.";
  else if (isNum(a.mean)) ratio = a.mean / c.mean;
  return {
    formula: "acwr_rolling_v1",
    asOf,
    acuteWindow: { start: a.start, end: asOf, days: acuteDays },
    chronicWindow: { start: c.start, end: asOf, days: chronicDays },
    acuteMean: a.mean,
    chronicMean: c.mean,
    acuteCoverage: a.coverage,
    chronicCoverage: c.coverage,
    ratio,
    reason,
  };
}

/** monotony_v1 + strain_v1 over the 7 days ending asOf. Null unless all 7 days are known. */
export function monotonyStrain(series: readonly DailyLoad[], asOf: string): { monotony: number | null; strain: number | null; weeklyLoad: number | null } {
  const byDate = new Map(series.map((d) => [d.date, d.load]));
  const vals: (number | null)[] = [];
  for (let i = 6; i >= 0; i--) vals.push(byDate.get(addDaysYmdPure(asOf, -i)) ?? null);
  if (!vals.every(isNum)) return { monotony: null, strain: null, weeklyLoad: null };
  const weekly = (vals as number[]).reduce((a, b) => a + b, 0);
  const s = sd(vals);
  const m = mean(vals);
  const monotony = isNum(s) && s > 0 && isNum(m) ? m / s : null;
  return { monotony, strain: isNum(monotony) ? weekly * monotony : null, weeklyLoad: weekly };
}

// ---------------------------------------------------------------------------
// Wellness
// ---------------------------------------------------------------------------

/** Polarity-normalized 0–100 score for one scale answer. Null for neutral/unscored items or missing values. */
export function normalizeScale(value: unknown, q: Pick<QuestionDef, "min" | "max" | "polarity" | "kind">): number | null {
  if (q.kind !== "scale" || !isNum(value) || !isNum(q.min) || !isNum(q.max) || q.max === q.min) return null;
  if (q.polarity !== "higher_better" && q.polarity !== "lower_better") return null;
  const clamped = Math.min(Math.max(value, q.min), q.max);
  const frac = (clamped - q.min) / (q.max - q.min);
  return (q.polarity === "higher_better" ? frac : 1 - frac) * 100;
}

export type ReadinessResult = { formula: "tw_readiness_v1"; score: number | null; answered: number; eligible: number; reason: string | null };

/**
 * tw_readiness_v1. Eligible items: required scale questions with a higher/lower-is-better polarity.
 * `answers === null` (no response at all) always yields null — a missing check-in is never "ready".
 */
export function readinessV1(questions: readonly QuestionDef[], answers: Record<string, unknown> | null | undefined): ReadinessResult {
  const eligible = questions.filter((q) => q.kind === "scale" && q.required && (q.polarity === "higher_better" || q.polarity === "lower_better"));
  if (!answers) return { formula: "tw_readiness_v1", score: null, answered: 0, eligible: eligible.length, reason: "No response" };
  if (!eligible.length) return { formula: "tw_readiness_v1", score: null, answered: 0, eligible: 0, reason: "No eligible scale items" };
  const scores = eligible.map((q) => normalizeScale(answers[q.key], q)).filter(isNum);
  if (scores.length * 2 < eligible.length) {
    return { formula: "tw_readiness_v1", score: null, answered: scores.length, eligible: eligible.length, reason: `Only ${scores.length} of ${eligible.length} items answered` };
  }
  return { formula: "tw_readiness_v1", score: mean(scores), answered: scores.length, eligible: eligible.length, reason: null };
}

export type FlagRule = { below?: number | null; above?: number | null };
export type WellnessFlag = { key: string; label: string; value: number | boolean; rule: string };

/**
 * Concerning answers per configured thresholds. Missing answers are never flags *or* "fine":
 * they are reported separately by the completion grid.
 */
export function wellnessFlags(questions: readonly QuestionDef[], answers: Record<string, unknown> | null | undefined, rules: Record<string, FlagRule>): WellnessFlag[] {
  if (!answers) return [];
  const out: WellnessFlag[] = [];
  for (const q of questions) {
    const r = rules[q.key];
    const v = answers[q.key];
    if (!r || !isNum(v)) continue;
    if (isNum(r.below) && v < r.below) out.push({ key: q.key, label: q.label, value: v, rule: `< ${r.below}` });
    else if (isNum(r.above) && v > r.above) out.push({ key: q.key, label: q.label, value: v, rule: `> ${r.above}` });
  }
  return out;
}

export type CompletionStatus = "answered" | "partial" | "no_response" | "not_scheduled";

/** "no_response" is its own state — never coerced into a favorable or neutral value. */
export function completionStatus(questions: readonly QuestionDef[], answers: Record<string, unknown> | null | undefined, scheduled = true): CompletionStatus {
  if (!scheduled) return "not_scheduled";
  if (!answers) return "no_response";
  const missingRequired = questions.some((q) => q.required && (answers[q.key] === null || answers[q.key] === undefined || answers[q.key] === ""));
  return missingRequired ? "partial" : "answered";
}

/** Whether a questionnaire with the given frequency is due on a date. pre_session needs session info. */
export function isScheduledOn(frequency: string | undefined, ymd: string, hasSession = false): boolean {
  if (frequency === "weekdays") return isoWeekdayPure(ymd) <= 5;
  if (frequency === "pre_session") return hasSession;
  return true;
}

// ---------------------------------------------------------------------------
// Volume tracker
// ---------------------------------------------------------------------------

export type VolumeSet = {
  id: string;
  athleteId: string;
  date: string;
  exerciseId: string;
  exerciseName: string;
  category: string;
  movementPattern: string | null;
  trackingType: string;
  isUnilateral: boolean;
  bodyweightFactor: number | null;
  side: "both" | "left" | "right";
  isWarmup: boolean;
  completed: boolean;
  reps: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  durationS: number | null;
  distanceM: number | null;
  /** Athlete body mass in kg, if known. */
  bodyMassKg: number | null;
  /** Dated max for this set (already selected via `selectDatedMax`), or null. */
  max: { value: number; unit: string } | null;
};

export type IntensityZone = "<60" | "60-70" | "70-80" | "80-90" | ">=90" | "no_max" | "no_load";
export const ZONES: IntensityZone[] = ["<60", "60-70", "70-80", "80-90", ">=90", "no_max", "no_load"];

export function intensityZone(pct: number | null): IntensityZone {
  if (!isNum(pct)) return "no_max";
  if (pct < 60) return "<60";
  if (pct < 70) return "60-70";
  if (pct < 80) return "70-80";
  if (pct < 90) return "80-90";
  return ">=90";
}

/** Most recent max recorded on or before `date` (inclusive). Never uses a future max. */
export function selectDatedMax<T extends { recordedOn: string }>(maxes: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const m of maxes) if (m.recordedOn <= date && (!best || m.recordedOn > best.recordedOn)) best = m;
  return best;
}

export type VolumeBucket = {
  key: string;
  label: string;
  tonnage: number;
  /** Tonnage per side for unilateral sets logged per side (labeled in the UI). */
  tonnageLeft: number;
  tonnageRight: number;
  reps: number;
  sets: number;
  setsInTonnage: number;
  excludedMissingLoad: number;
  excludedBodyweightNoMass: number;
  excludedWarmup: number;
  excludedNotCompleted: number;
  durationS: number;
  distanceM: number;
  zones: Record<IntensityZone, { sets: number; reps: number }>;
};

export type VolumeOptions = {
  includeWarmups?: boolean;
  displayUnit: "lb" | "kg";
  groupBy: "exercise" | "category" | "movement_pattern" | "athlete" | "date";
  labelFor?: (s: VolumeSet) => string;
};

const emptyZones = () => Object.fromEntries(ZONES.map((z) => [z, { sets: 0, reps: 0 }])) as VolumeBucket["zones"];

/** Effective load of one set in kg, or a reason it can't be computed. */
export function setLoadKg(s: VolumeSet): { kg: number | null; reason: "ok" | "missing_load" | "bodyweight_no_mass" } {
  const isBodyweight = s.trackingType === "bodyweight_reps";
  const externalKg = isNum(s.load) && s.loadUnit ? convertUnit(s.load, s.loadUnit, "kg") : null;
  if (isBodyweight) {
    if (!isNum(s.bodyweightFactor) || !isNum(s.bodyMassKg)) return { kg: null, reason: "bodyweight_no_mass" };
    return { kg: s.bodyweightFactor * s.bodyMassKg + (externalKg ?? 0), reason: "ok" };
  }
  if (!isNum(externalKg)) return { kg: null, reason: "missing_load" };
  return { kg: externalKg, reason: "ok" };
}

/** tonnage_v1 + intensity_zone_v1 aggregation. See docs for every rule. */
export function computeVolume(sets: readonly VolumeSet[], opts: VolumeOptions): VolumeBucket[] {
  const buckets = new Map<string, VolumeBucket>();
  const keyOf = (s: VolumeSet) =>
    opts.groupBy === "exercise" ? [s.exerciseId, s.exerciseName]
    : opts.groupBy === "category" ? [s.category, s.category]
    : opts.groupBy === "movement_pattern" ? [s.movementPattern ?? "unspecified", s.movementPattern ?? "Unspecified pattern"]
    : opts.groupBy === "athlete" ? [s.athleteId, opts.labelFor?.(s) ?? s.athleteId]
    : [s.date, s.date];
  for (const s of sets) {
    const [key, label] = keyOf(s);
    let b = buckets.get(key);
    if (!b) {
      b = { key, label, tonnage: 0, tonnageLeft: 0, tonnageRight: 0, reps: 0, sets: 0, setsInTonnage: 0, excludedMissingLoad: 0, excludedBodyweightNoMass: 0, excludedWarmup: 0, excludedNotCompleted: 0, durationS: 0, distanceM: 0, zones: emptyZones() };
      buckets.set(key, b);
    }
    if (s.isWarmup && !opts.includeWarmups) { b.excludedWarmup++; continue; }
    if (!s.completed) { b.excludedNotCompleted++; continue; }
    b.sets++;
    if (isNum(s.durationS)) b.durationS += s.durationS;
    if (isNum(s.distanceM)) b.distanceM += s.distanceM;
    const timeOrDistance = s.trackingType === "time" || s.trackingType === "distance" || s.trackingType === "time_distance";
    if (timeOrDistance) continue; // kept separate from tonnage
    if (isNum(s.reps)) b.reps += s.reps;
    const { kg, reason } = setLoadKg(s);
    if (reason === "missing_load") { b.excludedMissingLoad++; b.zones.no_load.sets++; b.zones.no_load.reps += s.reps ?? 0; continue; }
    if (reason === "bodyweight_no_mass") { b.excludedBodyweightNoMass++; b.zones.no_max.sets++; b.zones.no_max.reps += s.reps ?? 0; continue; }
    if (!isNum(s.reps) || !isNum(kg)) continue;
    const loadDisplay = convertUnit(kg, "kg", opts.displayUnit)!;
    const t = loadDisplay * s.reps;
    b.tonnage += t;
    b.setsInTonnage++;
    if (s.side === "left") b.tonnageLeft += t;
    if (s.side === "right") b.tonnageRight += t;
    // Intensity vs dated max (external load only; bodyweight sets have no % max).
    let pct: number | null = null;
    if (s.trackingType !== "bodyweight_reps" && s.max && isNum(s.load) && s.loadUnit) {
      const inMaxUnit = convertUnit(s.load, s.loadUnit, s.max.unit);
      if (isNum(inMaxUnit) && s.max.value > 0) pct = (inMaxUnit / s.max.value) * 100;
    }
    const z = intensityZone(pct);
    b.zones[z].sets++;
    b.zones[z].reps += s.reps;
  }
  return [...buckets.values()].sort((a, b) => b.tonnage - a.tonnage || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Tests, trials, KPIs
// ---------------------------------------------------------------------------

export type TrialValue = { trialId: string; trialNumber: number | null; value: number | null; isAggregate: boolean; excluded: boolean };

/**
 * trial_selection_v1 over individual, included trials. Aggregate rows are returned
 * separately (as `vendorAggregate`) and never mixed in.
 */
export function selectTrials(
  rows: readonly TrialValue[],
  rule: "best" | "mean" | "latest",
  higherIsBetter: boolean | null,
): { value: number | null; n: number; usedTrialIds: string[]; vendorAggregate: number | null; reason: string | null } {
  const agg = rows.find((r) => r.isAggregate && isNum(r.value));
  const usable = rows.filter((r) => !r.isAggregate && !r.excluded && isNum(r.value)) as (TrialValue & { value: number })[];
  const base = { n: usable.length, vendorAggregate: agg?.value ?? null };
  if (!usable.length) return { ...base, value: null, usedTrialIds: [], reason: "No included trials with a value" };
  if (rule === "mean") return { ...base, value: mean(usable.map((r) => r.value)), usedTrialIds: usable.map((r) => r.trialId), reason: null };
  if (rule === "latest") {
    const last = [...usable].sort((a, b) => (a.trialNumber ?? 0) - (b.trialNumber ?? 0)).at(-1)!;
    return { ...base, value: last.value, usedTrialIds: [last.trialId], reason: null };
  }
  if (higherIsBetter === null) return { ...base, value: null, usedTrialIds: [], reason: "'best' needs a metric direction (higher or lower is better)" };
  const best = usable.reduce((a, b) => ((higherIsBetter ? b.value > a.value : b.value < a.value) ? b : a));
  return { ...base, value: best.value, usedTrialIds: [best.trialId], reason: null };
}

/** swc_02sd_v1: 0.2 × between-session SD (≥ 3 session values). */
export function swcBand(sessionValues: readonly (number | null)[]): number | null {
  const xs = sessionValues.filter(isNum);
  if (xs.length < 3) return null;
  const s = sd(xs);
  return isNum(s) ? 0.2 * s : null;
}

export function changePct(current: number | null | undefined, baseline: number | null | undefined): number | null {
  if (!isNum(current) || !isNum(baseline) || baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

/** Classify a change against an SWC band, respecting metric direction. */
export function classifyChange(delta: number | null, swc: number | null, higherIsBetter: boolean | null): "improved" | "declined" | "within_swc" | "unknown" {
  if (!isNum(delta) || !isNum(swc) || higherIsBetter === null) return "unknown";
  if (Math.abs(delta) <= swc) return "within_swc";
  return (delta > 0) === higherIsBetter ? "improved" : "declined";
}

/** asymmetry_v1 (Teamwork-derived). Positive = left greater. */
export function asymmetryPct(left: number | null | undefined, right: number | null | undefined): number | null {
  if (!isNum(left) || !isNum(right) || left + right === 0) return null;
  return ((left - right) / ((left + right) / 2)) * 100;
}

/** Progress toward a target from a baseline, 0–100+ (direction-aware). */
export function progressToTarget(current: number | null, baseline: number | null, target: number | null): number | null {
  if (!isNum(current) || !isNum(baseline) || !isNum(target) || target === baseline) return null;
  return ((current - baseline) / (target - baseline)) * 100;
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export type HabitStatus = "done" | "partial" | "missed";

/** Dates a habit is expected within [start, end]. Weekly habits return the Monday of each ISO week. */
export function expectedHabitDates(frequency: "daily" | "weekdays" | "weekly", start: string, end: string): string[] {
  const out: string[] = [];
  if (start > end) return out;
  if (frequency === "weekly") {
    for (let d = startOfIsoWeekPure(start); d <= end; d = addDaysYmdPure(d, 7)) out.push(d);
    return out;
  }
  for (let d = start; d <= end; d = addDaysYmdPure(d, 1)) if (frequency === "daily" || isoWeekdayPure(d) <= 5) out.push(d);
  return out;
}

export type AdherenceResult = {
  formula: "habit_adherence_v1";
  expected: number;
  done: number;
  partial: number;
  missed: number;
  noCheckin: number;
  adherencePct: number | null;
};

/**
 * habit_adherence_v1. For weekly habits the check-in map is keyed by any date; it is
 * folded into its ISO week (best status in the week wins).
 */
export function habitAdherence(frequency: "daily" | "weekdays" | "weekly", expected: readonly string[], checkins: ReadonlyMap<string, HabitStatus>): AdherenceResult {
  const resolved = resolveHabitStatuses(frequency, expected, checkins);
  let done = 0, partial = 0, missed = 0, none = 0;
  for (const s of resolved.values()) {
    if (s === "done") done++;
    else if (s === "partial") partial++;
    else if (s === "missed") missed++;
    else none++;
  }
  return {
    formula: "habit_adherence_v1",
    expected: expected.length,
    done,
    partial,
    missed,
    noCheckin: none,
    adherencePct: expected.length ? ((done + 0.5 * partial) / expected.length) * 100 : null,
  };
}

const RANK: Record<HabitStatus, number> = { done: 3, partial: 2, missed: 1 };

export function resolveHabitStatuses(frequency: "daily" | "weekdays" | "weekly", expected: readonly string[], checkins: ReadonlyMap<string, HabitStatus>): Map<string, HabitStatus | null> {
  const out = new Map<string, HabitStatus | null>();
  if (frequency === "weekly") {
    const byWeek = new Map<string, HabitStatus>();
    for (const [d, s] of checkins) {
      const w = startOfIsoWeekPure(d);
      const prev = byWeek.get(w);
      if (!prev || RANK[s] > RANK[prev]) byWeek.set(w, s);
    }
    for (const w of expected) out.set(w, byWeek.get(w) ?? null);
    return out;
  }
  for (const d of expected) out.set(d, checkins.get(d) ?? null);
  return out;
}

/**
 * Current streak of consecutive expected periods marked "done", counting back from the
 * latest expected period on/before `today`. If today's period has no check-in yet, it is
 * skipped (the day isn't over) rather than breaking the streak.
 */
export function habitStreak(frequency: "daily" | "weekdays" | "weekly", expected: readonly string[], checkins: ReadonlyMap<string, HabitStatus>, today: string): number {
  const resolved = resolveHabitStatuses(frequency, expected, checkins);
  const periods = expected.filter((d) => d <= today).sort();
  let streak = 0;
  for (let i = periods.length - 1; i >= 0; i--) {
    const s = resolved.get(periods[i]);
    const isCurrent = i === periods.length - 1 && (frequency === "weekly" ? periods[i] === startOfIsoWeekPure(today) : periods[i] === today);
    if (s === "done") streak++;
    else if (s == null && isCurrent) continue;
    else break;
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export function attendanceRate(attended: number, noShow: number): number | null {
  const d = attended + noShow;
  return d ? (attended / d) * 100 : null;
}

// ---------------------------------------------------------------------------
// Pure calendar helpers (no timezone; YYYY-MM-DD strings, UTC-noon arithmetic so DST never shifts a date)
// ---------------------------------------------------------------------------

export function addDaysYmdPure(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

export function isoWeekdayPure(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function startOfIsoWeekPure(ymd: string): string {
  return addDaysYmdPure(ymd, -(isoWeekdayPure(ymd) - 1));
}

export function weeklyTotals(series: readonly DailyLoad[]): { weekStart: string; total: number | null; knownDays: number; days: number }[] {
  const map = new Map<string, { vals: (number | null)[] }>();
  for (const d of series) {
    const w = startOfIsoWeekPure(d.date);
    const e = map.get(w) ?? { vals: [] };
    e.vals.push(d.load);
    map.set(w, e);
  }
  return [...map.entries()].map(([weekStart, { vals }]) => ({
    weekStart,
    total: sum(vals),
    knownDays: vals.filter(isNum).length,
    days: vals.length,
  }));
}
