// Velocity-based training (VBT) utilities: 1RM estimation, velocity zones,
// per-set target computation, and age-group bucketing.
//
// Teamwork Bloomington programs by bar speed rather than testing true 1RMs, so
// these helpers (a) estimate 1RM from rep-maxes or load-velocity data, and
// (b) turn a coach's structured prescription into concrete per-athlete targets.

export type E1rmMethod = "DIRECT" | "EPLEY" | "BRZYCKI" | "VBT_LV";

export interface LvPoint {
  loadKg: number;
  velocity: number; // mean concentric velocity, m/s
}

// --- Rep-max → estimated 1RM ------------------------------------------------

export function epley1rm(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

export function brzycki1rm(weightKg: number, reps: number): number {
  // Undefined at 37 reps; callers should keep reps in a sane (<37) range.
  return (weightKg * 36) / (37 - reps);
}

export function repMaxTo1rm(weightKg: number, reps: number, method: "EPLEY" | "BRZYCKI" = "EPLEY"): number {
  if (reps <= 1) return weightKg;
  return method === "BRZYCKI" ? brzycki1rm(weightKg, reps) : epley1rm(weightKg, reps);
}

// --- Load-velocity → estimated 1RM ------------------------------------------

// Minimum velocity threshold (m/s) at ~1RM, by exercise category. Used when an
// exercise has no explicit `mvt`. Values are typical literature midpoints.
export const DEFAULT_MVT_BY_CATEGORY: Record<string, number> = {
  LOWER: 0.3, // back squat ≈ 0.30
  UPPER: 0.17, // bench press ≈ 0.15–0.17
  OLYMPIC: 0.6,
  PLYO: 0.3,
  CORE: 0.3,
  CONDITIONING: 0.3,
};
export const FALLBACK_MVT = 0.3;

export function mvtForExercise(exercise: { mvt?: number | null; category?: string | null }): number {
  if (exercise.mvt != null) return exercise.mvt;
  if (exercise.category && DEFAULT_MVT_BY_CATEGORY[exercise.category] != null) {
    return DEFAULT_MVT_BY_CATEGORY[exercise.category];
  }
  return FALLBACK_MVT;
}

// Ordinary least-squares fit of velocity = a + b·load. Returns null if fewer
// than two distinct loads (can't define a line).
export function linearFit(points: LvPoint[]): { a: number; b: number } | null {
  const pts = points.filter((p) => Number.isFinite(p.loadKg) && Number.isFinite(p.velocity));
  if (pts.length < 2) return null;
  const distinctLoads = new Set(pts.map((p) => p.loadKg));
  if (distinctLoads.size < 2) return null;

  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.loadKg, 0);
  const sy = pts.reduce((s, p) => s + p.velocity, 0);
  const sxx = pts.reduce((s, p) => s + p.loadKg * p.loadKg, 0);
  const sxy = pts.reduce((s, p) => s + p.loadKg * p.velocity, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

// Estimate 1RM as the load where the fitted line reaches the MVT. Returns null
// when the relationship isn't valid (non-decreasing velocity, or load ≤ 0).
export function e1rmFromLoadVelocity(points: LvPoint[], mvt: number): number | null {
  const fit = linearFit(points);
  if (!fit || fit.b >= 0) return null; // velocity must fall as load rises
  const load = (mvt - fit.a) / fit.b;
  return load > 0 && Number.isFinite(load) ? load : null;
}

// --- Velocity zones ---------------------------------------------------------

export type VelocityZone = "STRENGTH" | "STRENGTH_SPEED" | "SPEED_STRENGTH" | "SPEED";

export const ZONE_RANGES: Record<VelocityZone, [number, number]> = {
  STRENGTH: [0, 0.5],
  STRENGTH_SPEED: [0.5, 0.75],
  SPEED_STRENGTH: [0.75, 1.0],
  SPEED: [1.0, Infinity],
};

export const ZONE_LABELS: Record<VelocityZone, string> = {
  STRENGTH: "Strength",
  STRENGTH_SPEED: "Strength-Speed",
  SPEED_STRENGTH: "Speed-Strength",
  SPEED: "Speed",
};

export function zoneForVelocity(v: number): VelocityZone {
  if (v < 0.5) return "STRENGTH";
  if (v < 0.75) return "STRENGTH_SPEED";
  if (v < 1.0) return "SPEED_STRENGTH";
  return "SPEED";
}

// Representative target velocity for a zone (midpoint; SPEED is open-ended).
export function zoneMidVelocity(zone: VelocityZone): number {
  const [lo, hi] = ZONE_RANGES[zone];
  return hi === Infinity ? lo + 0.1 : (lo + hi) / 2;
}

// --- Loading helpers --------------------------------------------------------

export function roundToIncrement(kg: number, increment = 2.5): number {
  if (increment <= 0) return kg;
  return Math.round(kg / increment) * increment;
}

// --- Age grouping -----------------------------------------------------------

export type AgeGroup = "U10" | "U12" | "U14" | "U16" | "U18" | "Open";
export const AGE_GROUPS: AgeGroup[] = ["U10", "U12", "U14", "U16", "U18", "Open"];

export function ageYears(birthDate: Date, asOf: Date = new Date()): number {
  let age = asOf.getFullYear() - birthDate.getFullYear();
  const m = asOf.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < birthDate.getDate())) age--;
  return age;
}

export function ageGroup(birthDate: Date, asOf: Date = new Date()): AgeGroup {
  const age = ageYears(birthDate, asOf);
  if (age < 10) return "U10";
  if (age < 12) return "U12";
  if (age < 14) return "U14";
  if (age < 16) return "U16";
  if (age < 18) return "U18";
  return "Open";
}

// --- Per-set target computation ---------------------------------------------

export interface PrescriptionInput {
  prescribeBy?: string | null; // PCT | VELOCITY | ZONE | RPE | TEXT
  targetPctE1rm?: number | null;
  targetVelocity?: number | null;
  velocityZone?: string | null;
  load?: string | null; // free-text fallback
}

export interface ComputedTargets {
  targetLoadKg: number | null;
  targetVelocity: number | null;
  zone: VelocityZone | null;
  display: string; // human-readable target shown to the athlete
}

// Resolve a coach's structured prescription into concrete targets for one
// athlete, given that athlete's estimated 1RM for the exercise (or null).
export function computeTargets(
  item: PrescriptionInput,
  e1rmKg: number | null,
  increment = 2.5
): ComputedTargets {
  const parts: string[] = [];
  let targetLoadKg: number | null = null;
  let targetVelocity: number | null = item.targetVelocity ?? null;
  let zone: VelocityZone | null = null;

  const mode = item.prescribeBy || (item.targetPctE1rm != null ? "PCT" : item.targetVelocity != null ? "VELOCITY" : item.velocityZone ? "ZONE" : "TEXT");

  if ((mode === "PCT" || item.targetPctE1rm != null) && item.targetPctE1rm != null) {
    const pct = item.targetPctE1rm;
    if (e1rmKg != null) {
      targetLoadKg = roundToIncrement(e1rmKg * pct, increment);
      parts.push(`${targetLoadKg} kg (${Math.round(pct * 100)}% e1RM)`);
    } else {
      parts.push(`${Math.round(pct * 100)}% e1RM`);
    }
  }

  if (item.velocityZone) {
    const z = item.velocityZone as VelocityZone;
    if (ZONE_RANGES[z]) {
      zone = z;
      if (targetVelocity == null) targetVelocity = zoneMidVelocity(z);
      const [lo, hi] = ZONE_RANGES[z];
      parts.push(`${ZONE_LABELS[z]} (${lo}-${hi === Infinity ? "∞" : hi} m/s)`);
    }
  }

  if (targetVelocity != null) {
    if (!zone) zone = zoneForVelocity(targetVelocity);
    if (!item.velocityZone) parts.push(`${targetVelocity} m/s`);
  }

  if (parts.length === 0) {
    return { targetLoadKg: null, targetVelocity: null, zone: null, display: item.load || "" };
  }
  return { targetLoadKg, targetVelocity, zone, display: parts.join(" · ") };
}

// ---------------------------------------------------------------------------
// %1RM from a single set's velocity (generic published profiles).
//
// When an athlete has a personal load-velocity profile (2+ loads) we always
// prefer it: pct = load / e1RM. These generic curves are the fallback for a
// single submax set, from large validated samples:
//  - Full squat (Martínez-Cava / Sánchez-Medina line, R²≈.96):
//      %1RM = 121.03 − 71.684 · MPV
//  - Bench press (González-Badillo & Sánchez-Medina 2010, R²≈.98):
//      %1RM = 8.4326·v² − 73.501·v + 112.33
//  - Anything else: a linear profile anchored at the exercise's MVT (→100%)
//    with the squat curve's slope, shifted to that MVT.
// ---------------------------------------------------------------------------

export type LiftProfile = "SQUAT" | "BENCH" | "GENERIC";

export function liftProfileForExercise(exercise: { name?: string | null; category?: string | null }): LiftProfile {
  const n = (exercise.name || "").toLowerCase();
  if (/squat/.test(n) && !/split|bulgarian|pistol/.test(n)) return "SQUAT";
  if (/bench|press/.test(n) && !/leg|shoulder|overhead|push ?press/.test(n)) return "BENCH";
  return "GENERIC";
}

/** Estimated %1RM (0–100, clamped) for a rep performed at `velocity` m/s. */
export function pctFromVelocity(
  velocity: number,
  exercise: { name?: string | null; category?: string | null; mvt?: number | null }
): number {
  const profile = liftProfileForExercise(exercise);
  let pct: number;
  if (profile === "SQUAT") {
    pct = 121.03 - 71.684 * velocity;
  } else if (profile === "BENCH") {
    pct = 8.4326 * velocity * velocity - 73.501 * velocity + 112.33;
  } else {
    // Same slope as the squat line, re-anchored so v = MVT ⇒ 100%.
    const mvt = mvtForExercise(exercise);
    pct = 100 - 71.684 * (velocity - mvt);
  }
  return Math.max(5, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * e1RM from ONE submax set (load + mean velocity), via the generic profile.
 * Lower confidence than a personal LV fit — callers should prefer
 * e1rmFromLoadVelocity whenever 2+ distinct loads exist.
 */
export function e1rmFromSingleSet(
  loadKg: number,
  velocity: number,
  exercise: { name?: string | null; category?: string | null; mvt?: number | null }
): number | null {
  if (!(loadKg > 0) || !(velocity > 0)) return null;
  const pct = pctFromVelocity(velocity, exercise);
  if (pct <= 0) return null;
  return Math.round((loadKg / (pct / 100)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Relative strength: e1RM expressed in bodyweights (xBW), judged against
// widely used coaching standards. Guidelines, not gospel — shown as tiers.
// ---------------------------------------------------------------------------

export interface RelStrengthTier { label: string; min: number; }
export const REL_STRENGTH_TIERS: Record<LiftProfile, RelStrengthTier[]> = {
  // xBW thresholds (high-school → collegiate coaching standards)
  SQUAT: [
    { label: "Elite", min: 2.0 },
    { label: "Strong", min: 1.5 },
    { label: "Solid", min: 1.0 },
    { label: "Developing", min: 0 },
  ],
  BENCH: [
    { label: "Elite", min: 1.5 },
    { label: "Strong", min: 1.2 },
    { label: "Solid", min: 0.8 },
    { label: "Developing", min: 0 },
  ],
  GENERIC: [
    { label: "Elite", min: 2.2 },
    { label: "Strong", min: 1.7 },
    { label: "Solid", min: 1.2 },
    { label: "Developing", min: 0 },
  ],
};

export function relativeStrength(e1rmKg: number, bodyMassKg: number): number | null {
  if (!(e1rmKg > 0) || !(bodyMassKg > 0)) return null;
  return Math.round((e1rmKg / bodyMassKg) * 100) / 100;
}

export function relStrengthTier(xbw: number, profile: LiftProfile): string {
  for (const t of REL_STRENGTH_TIERS[profile]) if (xbw >= t.min) return t.label;
  return "Developing";
}
