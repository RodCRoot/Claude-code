import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, exercises, maxes, metricDefinitions, metricValues, trials } from "@/db/schema";
import { AuthzError, athleteCapabilities, isStaff, type Viewer } from "@/lib/authz/policy";
import { DEFAULT_TZ, localYmd } from "@/lib/time";
import { KG_PER_LB } from "./formulas";
import { isBarSpeedMethod, liftProfileForName, relativeStrength, relStrengthTier, type RelStrengthTier } from "./vbt";

/**
 * Relative strength (rel_strength_v1): a lift max divided by body mass.
 *
 * Body weight is sensitive. This is for staff who hold BOTH training.read and health.read on the
 * athlete (owner, admin, the athlete's coaches). Operations, guardians, athletes, boards, the TV
 * board and public pages never get it from here, and nothing here is written anywhere else.
 */

/** Standard gravity, for Hawkin "System Weight (N)" → kg. */
const G = 9.80665;
/** Hawkin metric keys that carry body mass, as slugged by the importer ("Body Weight(kg)" → body_weight__kg). */
const BODY_MASS_KEY = /^(body_weight|body_mass|bodyweight|system_weight)(__|$)/;

export type BodyMass = { kg: number; source: "hawkin_trial" | "recorded"; measuredOn: string | null };

function toKg(value: number, unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (!(value > 0)) return null;
  if (u === "kg") return value;
  if (u === "lb" || u === "lbs") return value * KG_PER_LB;
  if (u === "n") return value / G;
  return null;
}

/**
 * Body mass for one athlete: the most recent Hawkin force-plate body-weight value from an
 * included trial, else the body weight recorded on the athlete profile, else null (never 0).
 * No authorization here: callers must have checked health.read.
 */
export async function bodyMassFor(tx: Tx, orgId: string, athleteId: string, tz = DEFAULT_TZ): Promise<BodyMass | null> {
  const rows = await tx
    .select({ key: metricDefinitions.key, value: metricValues.value, unit: metricValues.unit, at: metricValues.recordedAt })
    .from(metricValues)
    .innerJoin(metricDefinitions, eq(metricDefinitions.id, metricValues.metricDefinitionId))
    .leftJoin(trials, eq(trials.id, metricValues.trialId))
    .where(
      and(
        eq(metricValues.orgId, orgId),
        eq(metricValues.athleteId, athleteId),
        eq(metricValues.source, "hawkin"),
        isNotNull(metricValues.value),
        sql`(${trials.id} is null or ${trials.excluded} = false)`,
        sql`${metricDefinitions.key} ~ '^(body_weight|body_mass|bodyweight|system_weight)(__|$)'`,
      ),
    )
    .orderBy(desc(metricValues.recordedAt))
    .limit(20);
  for (const r of rows) {
    if (!BODY_MASS_KEY.test(r.key) || r.value == null) continue;
    const kg = toKg(r.value, r.unit);
    if (kg != null && kg >= 20 && kg <= 250) return { kg: Math.round(kg * 10) / 10, source: "hawkin_trial", measuredOn: localYmd(r.at, tz) };
  }
  const [a] = await tx.select({ mass: athletes.bodyMassKg }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  const n = a?.mass == null || a.mass.trim() === "" ? NaN : Number(a.mass);
  return Number.isFinite(n) && n > 0 ? { kg: n, source: "recorded", measuredOn: null } : null;
}

export type RelStrengthRow = {
  exerciseId: string;
  exerciseName: string;
  max: { value: number; unit: string; kind: string; method: string; recordedOn: string };
  /** True when the max used is an estimate (rep formula or bar speed), not a tested lift. */
  estimated: boolean;
  fromBarSpeed: boolean;
  maxKg: number;
  /** Multiple of body weight; null when body mass is unknown. */
  xbw: number | null;
  tier: RelStrengthTier | null;
};
export type RelStrengthView = { method: "rel_strength_v1"; bodyMass: BodyMass | null; rows: RelStrengthRow[] };

export async function canSeeRelativeStrength(tx: Tx, v: Viewer, athleteId: string): Promise<boolean> {
  if (!isStaff(v)) return false;
  const caps = await athleteCapabilities(tx, v, athleteId);
  return caps.has("training.read") && caps.has("health.read");
}

/** Latest lb/kg max per lift as a multiple of body weight. Throws unless staff with training + health access. */
export async function relativeStrengthFor(tx: Tx, v: Viewer, athleteId: string): Promise<RelStrengthView> {
  if (!(await canSeeRelativeStrength(tx, v, athleteId))) throw new AuthzError("Relative strength is limited to staff with health access for this athlete.");
  const bodyMass = await bodyMassFor(tx, v.orgId, athleteId);
  const maxRows = await tx
    .select({ m: maxes, name: exercises.name })
    .from(maxes)
    .innerJoin(exercises, eq(exercises.id, maxes.exerciseId))
    .where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athleteId), inArray(maxes.unit, ["lb", "kg"])))
    .orderBy(desc(maxes.recordedOn), desc(maxes.createdAt));
  const seen = new Set<string>();
  const rows: RelStrengthRow[] = [];
  for (const { m, name } of maxRows) {
    if (seen.has(m.exerciseId)) continue; // newest first: the current max for the lift
    seen.add(m.exerciseId);
    const maxKg = toKg(Number(m.value), m.unit);
    if (maxKg == null) continue;
    const xbw = bodyMass ? relativeStrength(maxKg, bodyMass.kg) : null;
    rows.push({
      exerciseId: m.exerciseId,
      exerciseName: name,
      max: { value: Number(m.value), unit: m.unit, kind: m.kind, method: m.method, recordedOn: m.recordedOn },
      estimated: m.kind === "estimated",
      fromBarSpeed: isBarSpeedMethod(m.method),
      maxKg: Math.round(maxKg * 10) / 10,
      xbw,
      tier: xbw == null ? null : relStrengthTier(xbw, liftProfileForName(name)),
    });
  }
  return { method: "rel_strength_v1", bodyMass, rows: rows.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName)) };
}
