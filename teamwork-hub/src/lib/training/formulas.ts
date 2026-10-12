/**
 * Pure strength-training math. No I/O — unit tested directly.
 *
 * Named, versioned methods so stored maxes always say how they were derived:
 *   epley_v1   1RM = w × (1 + reps / 30); reps = 1 returns w unchanged.
 *   brzycki_v1 1RM = w × 36 / (37 − reps); only valid for 1 ≤ reps < 37.
 * Both return null for invalid input (non-positive load, reps < 1, non-integer reps).
 */

export type LoadUnit = "lb" | "kg";
export type E1rmMethod = "epley_v1" | "brzycki_v1";

/** Exact international avoirdupois pound definition. Conversions are explicit, never silent. */
export const KG_PER_LB = 0.45359237;

export const DEFAULT_INCREMENT: Record<LoadUnit, number> = { lb: 5, kg: 2.5 };

/** Sets with more reps than this are not used to suggest an estimated max (prediction error grows). */
export const MAX_REPS_FOR_ESTIMATE = 10;

function validInput(weight: number, reps: number) {
  return Number.isFinite(weight) && weight > 0 && Number.isInteger(reps) && reps >= 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function epley(weight: number, reps: number): number | null {
  if (!validInput(weight, reps)) return null;
  if (reps === 1) return round2(weight);
  return round2(weight * (1 + reps / 30));
}

export function brzycki(weight: number, reps: number): number | null {
  if (!validInput(weight, reps) || reps >= 37) return null;
  return round2((weight * 36) / (37 - reps));
}

export function estimateOneRepMax(method: E1rmMethod, weight: number, reps: number): number | null {
  return method === "epley_v1" ? epley(weight, reps) : brzycki(weight, reps);
}

export const METHOD_LABEL: Record<string, string> = {
  epley_v1: "Epley v1 (w × (1 + reps/30))",
  brzycki_v1: "Brzycki v1 (w × 36 / (37 − reps))",
  tested: "Tested 1RM",
  manual: "Coach entered",
  imported: "Imported",
};

/** Explicit unit conversion. Returns the same value when units match. */
export function convertLoad(value: number, from: LoadUnit, to: LoadUnit): number {
  if (from === to) return value;
  return from === "lb" ? value * KG_PER_LB : value / KG_PER_LB;
}

/** Round to the nearest plate increment (e.g. 5 lb or 2.5 kg). */
export function roundToIncrement(value: number, increment: number): number {
  if (!(increment > 0)) return round2(value);
  return round2(Math.round(value / increment) * increment);
}

/** Percent-of-max load, rounded in the max's own unit. */
export function percentLoad(maxValue: number, percent: number, increment: number): number {
  return roundToIncrement((maxValue * percent) / 100, increment);
}

export type ExpandedSet = {
  setIndex: number;
  groupIndex: number;
  isWarmup: boolean;
  reps: number | null;
  repsText: string | null;
  targetLoad: number | null;
  targetUnit: LoadUnit | null;
  durationS: number | null;
  distanceM: number | null;
};

/** Flatten set groups ([{sets: 3, reps: 5}, ...]) into one row per set, indexed from 0. */
export function expandSets(groups: ResolvedSetGroup[]): ExpandedSet[] {
  const out: ExpandedSet[] = [];
  groups.forEach((g, gi) => {
    for (let s = 0; s < Math.max(0, g.sets); s++) {
      out.push({
        setIndex: out.length,
        groupIndex: gi,
        isWarmup: !!g.isWarmup,
        reps: g.reps ?? null,
        repsText: g.repsText ?? null,
        targetLoad: g.targetLoad ?? null,
        targetUnit: g.targetUnit ?? null,
        durationS: g.durationS ?? null,
        distanceM: g.distanceM ?? null,
      });
    }
  });
  return out;
}

/** Snapshot of one set group stored on workout_items.prescription (frozen at instantiation). */
export type ResolvedSetGroup = {
  sets: number;
  reps?: number | null;
  repsText?: string | null;
  isWarmup?: boolean;
  durationS?: number | null;
  distanceM?: number | null;
  tempo?: string | null;
  restS?: number | null;
  loadType: "absolute" | "percent_max" | "rpe" | "rir" | "bodyweight" | "none";
  percent?: number | null;
  rpe?: number | null;
  rir?: number | null;
  targetLoad?: number | null;
  targetUnit?: LoadUnit | null;
  /** Human-readable derivation, e.g. "80% of 225 lb (tested 2026-02-01), rounded to 5 lb". */
  loadMethod?: string | null;
  maxUsed?: { maxId: string; exerciseId: string; value: number; unit: LoadUnit; method: string; kind: string; recordedOn: string } | null;
  /** Set when % load could not be resolved (no max on/before the workout date). */
  loadWarning?: string | null;
  progressionApplied?: string | null;
  /** Exercise whose max drives a %-based load (may differ from the performed exercise). */
  maxExerciseId?: string | null;
  maxExerciseName?: string | null;
  /** Linear progression in absolute units added on top of a %-based load. */
  addLoad?: { value: number; unit: LoadUnit } | null;
};

/** Adherence = completed / scheduled, counting only workouts dated on or before `today`. Null when nothing was scheduled. */
export function adherence(workouts: { scheduledDate: string; status: string }[], today: string): { completed: number; scheduled: number; pct: number | null } {
  const due = workouts.filter((w) => w.scheduledDate <= today);
  const completed = due.filter((w) => w.status === "completed").length;
  return { completed, scheduled: due.length, pct: due.length ? Math.round((completed / due.length) * 1000) / 10 : null };
}

export function describePrescription(g: ResolvedSetGroup): string {
  const reps = g.repsText || (g.reps != null ? `${g.reps}` : g.durationS != null ? `${g.durationS}s` : g.distanceM != null ? `${g.distanceM} m` : "");
  const head = `${g.sets} × ${reps}`.trim();
  let load = "";
  if (g.targetLoad != null && g.targetUnit) load = ` @ ${g.targetLoad} ${g.targetUnit}`;
  else if (g.loadType === "percent_max" && g.percent != null) load = ` @ ${g.percent}%`;
  else if (g.loadType === "rpe" && g.rpe != null) load = ` @ RPE ${g.rpe}`;
  else if (g.loadType === "rir" && g.rir != null) load = ` @ ${g.rir} RIR`;
  else if (g.loadType === "bodyweight") load = " @ bodyweight";
  return `${g.isWarmup ? "Warm-up " : ""}${head}${load}${g.tempo ? ` · tempo ${g.tempo}` : ""}${g.restS ? ` · rest ${g.restS}s` : ""}`;
}
