/**
 * Velocity-based training math. Pure — no I/O, unit tested directly.
 * Ported from the proven Vantage engine (athlete-training-platform branch),
 * adapted to Teamwork Hub conventions: named, versioned methods so every
 * derived number says how it was produced; null for invalid input, never 0.
 *
 * Methods:
 *   lv_profile_v1   Athlete's own load–velocity line (least squares over sets
 *                   at 2+ distinct loads), extrapolated to the lift's minimum
 *                   velocity threshold (MVT) → estimated 1RM. Preferred
 *                   whenever enough data exists.
 *   mpv_squat_v1    %1RM = 121.03 − 71.684 · MPV  (free-weight full squat,
 *                   Martínez-Cava/Sánchez-Medina line, R² ≈ .96).
 *   mpv_bench_v1    %1RM = 8.4326·v² − 73.501·v + 112.33 (bench press,
 *                   González-Badillo & Sánchez-Medina 2010, R² ≈ .98).
 *   mpv_generic_v1  Squat-line slope re-anchored at the exercise MVT (v=MVT ⇒
 *                   100%). Fallback for lifts without a published profile.
 *   rel_strength_v1 e1RM ÷ body mass (kg), judged against coaching-standard
 *                   tiers. Guidelines, not gospel — label them as such in UI.
 */

export type LvPoint = { loadKg: number; velocityMs: number };

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minimum velocity thresholds (m/s) at 1RM, by broad lift family. Literature midpoints. */
export const MVT_DEFAULTS: Record<string, number> = {
  squat: 0.3,
  bench: 0.17,
  deadlift: 0.15,
  press: 0.19,
};
export const FALLBACK_MVT = 0.3;

export type LiftProfile = "squat" | "bench" | "generic";

/** Which published velocity curve fits an exercise, from its name. */
export function liftProfileForName(name: string | null | undefined): LiftProfile {
  const n = (name ?? "").toLowerCase();
  if (/squat/.test(n) && !/split|bulgarian|pistol/.test(n)) return "squat";
  if (/bench/.test(n) && !/leg/.test(n)) return "bench";
  return "generic";
}

export function mvtForName(name: string | null | undefined): number {
  const n = (name ?? "").toLowerCase();
  for (const [family, mvt] of Object.entries(MVT_DEFAULTS)) {
    if (n.includes(family)) return mvt;
  }
  return FALLBACK_MVT;
}

/** Ordinary least squares velocity = a + b·load. Null unless 2+ distinct loads. */
export function lvLinearFit(points: LvPoint[]): { a: number; b: number } | null {
  const clean = points.filter(
    (p) => Number.isFinite(p.loadKg) && p.loadKg > 0 && Number.isFinite(p.velocityMs) && p.velocityMs > 0,
  );
  const loads = new Set(clean.map((p) => p.loadKg));
  if (loads.size < 2) return null;
  const n = clean.length;
  const sx = clean.reduce((s, p) => s + p.loadKg, 0);
  const sy = clean.reduce((s, p) => s + p.velocityMs, 0);
  const sxx = clean.reduce((s, p) => s + p.loadKg * p.loadKg, 0);
  const sxy = clean.reduce((s, p) => s + p.loadKg * p.velocityMs, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/**
 * lv_profile_v1: estimated 1RM from an athlete's own load–velocity points,
 * extrapolated to the MVT. Null when the fit is impossible or nonsensical
 * (velocity must fall as load rises; the answer must exceed no measured load
 * by an absurd margin — capped at 2.5× the heaviest point to reject junk fits).
 */
export function e1rmFromLvProfile(points: LvPoint[], mvtMs: number): number | null {
  const fit = lvLinearFit(points);
  if (!fit || fit.b >= 0 || !(mvtMs > 0)) return null;
  const e1rm = (mvtMs - fit.a) / fit.b;
  const heaviest = Math.max(...points.map((p) => p.loadKg));
  if (!(e1rm > 0) || e1rm < heaviest * 0.8 || e1rm > heaviest * 2.5) return null;
  return round1(e1rm);
}

/** Estimated %1RM (5–100, 0.1 steps) for one rep at `velocityMs`, by lift profile. */
export function pctFromVelocity(velocityMs: number, profile: LiftProfile, mvtMs = FALLBACK_MVT): number | null {
  if (!(velocityMs > 0)) return null;
  let pct: number;
  if (profile === "squat") pct = 121.03 - 71.684 * velocityMs;
  else if (profile === "bench") pct = 8.4326 * velocityMs * velocityMs - 73.501 * velocityMs + 112.33;
  else pct = 100 - 71.684 * (velocityMs - (mvtMs > 0 ? mvtMs : FALLBACK_MVT));
  return Math.max(5, Math.min(100, round1(pct)));
}

/**
 * mpv_*_v1: estimated 1RM from ONE submax set (load + mean velocity) via the
 * published generic curve. Lower confidence than lv_profile_v1 — callers
 * should prefer the athlete's own profile whenever 2+ loads exist.
 */
export function e1rmFromSingleSet(loadKg: number, velocityMs: number, profile: LiftProfile, mvtMs = FALLBACK_MVT): number | null {
  if (!(loadKg > 0)) return null;
  const pct = pctFromVelocity(velocityMs, profile, mvtMs);
  if (pct == null || pct <= 0) return null;
  return round1(loadKg / (pct / 100));
}

/** Classic VBT intent zones (mean concentric velocity, m/s). */
export type VelocityZone = "strength" | "strength_speed" | "speed_strength" | "speed";
export const VELOCITY_ZONES: Record<VelocityZone, { min: number; max: number; label: string }> = {
  strength: { min: 0, max: 0.5, label: "Strength (<0.5 m/s)" },
  strength_speed: { min: 0.5, max: 0.75, label: "Strength-speed (0.5–0.75 m/s)" },
  speed_strength: { min: 0.75, max: 1.0, label: "Speed-strength (0.75–1.0 m/s)" },
  speed: { min: 1.0, max: Infinity, label: "Speed (>1.0 m/s)" },
};
export function zoneForVelocity(velocityMs: number): VelocityZone | null {
  if (!(velocityMs > 0)) return null;
  if (velocityMs < 0.5) return "strength";
  if (velocityMs < 0.75) return "strength_speed";
  if (velocityMs < 1.0) return "speed_strength";
  return "speed";
}

/** rel_strength_v1: e1RM expressed in bodyweights. Null unless both sides are positive. */
export function relativeStrength(e1rmKg: number, bodyMassKg: number): number | null {
  if (!(e1rmKg > 0) || !(bodyMassKg > 0)) return null;
  return round2(e1rmKg / bodyMassKg);
}

export type RelStrengthTier = "developing" | "solid" | "strong" | "elite";
const REL_TIERS: Record<LiftProfile, [number, number, number]> = {
  // thresholds for solid / strong / elite (×BW), HS→collegiate coaching standards
  squat: [1.0, 1.5, 2.0],
  bench: [0.8, 1.2, 1.5],
  generic: [1.2, 1.7, 2.2],
};
export function relStrengthTier(xbw: number, profile: LiftProfile): RelStrengthTier {
  const [solid, strong, elite] = REL_TIERS[profile];
  if (xbw >= elite) return "elite";
  if (xbw >= strong) return "strong";
  if (xbw >= solid) return "solid";
  return "developing";
}

export const VBT_METHOD_LABEL: Record<string, string> = {
  lv_profile_v1: "Load–velocity profile v1 (own data → MVT)",
  mpv_squat_v1: "Velocity estimate v1 (squat curve)",
  mpv_bench_v1: "Velocity estimate v1 (bench curve)",
  mpv_generic_v1: "Velocity estimate v1 (generic curve)",
  rel_strength_v1: "Relative strength v1 (e1RM ÷ body mass)",
};
