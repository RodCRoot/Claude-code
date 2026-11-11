import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { exercises, maxes, vbtMaxDismissals, vbtReadings } from "@/db/schema";
import { requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { actor, TrainingError } from "./common";
import { KG_PER_LB } from "./formulas";
import { refreshUnstartedLoads } from "./assignments";
import { BAR_SPEED_SOURCE, e1rmFromLvProfile, liftProfileForName, lvLinearFit, mvtForName, type LiftProfile, type LvPoint } from "./vbt";

/**
 * Load–velocity profile maxes (lv_profile_v1): estimate a 1RM from the
 * athlete's own vbt_readings (device bar-speed data), by fitting their
 * load–velocity line and extrapolating to the lift's minimum velocity
 * threshold. Suggestions are recomputed server-side on confirm — the client
 * never supplies the number.
 */

export type VbtMaxSuggestion = {
  exerciseId: string;
  exerciseName: string;
  e1rmKg: number;
  method: "lv_profile_v1";
  mvtMs: number;
  /** Distinct-load aggregates the fit used (kg, mean of mean velocities). */
  points: LvPoint[];
  readingsUsed: number;
  windowDays: number;
  current: { value: number; unit: string; recordedOn: string; method: string; kind: string } | null;
  /**
   * What confirming would store: the estimate in the unit this athlete's max for the lift is
   * already kept in (so %-based loads do not switch units), else the exercise's unit, else kg.
   * lb = kg ÷ 0.45359237, rounded to 0.1.
   */
  store: { value: number; unit: "lb" | "kg" };
};

/** The estimate expressed in the athlete's working unit for the lift. Explicit, never silent. */
export function storeValueFor(e1rmKg: number, currentUnit: string | null | undefined, exerciseUnit: string | null | undefined): { value: number; unit: "lb" | "kg" } {
  const unit = currentUnit === "lb" || currentUnit === "kg" ? currentUnit : exerciseUnit === "lb" ? "lb" : "kg";
  return { unit, value: unit === "kg" ? e1rmKg : Math.round((e1rmKg / KG_PER_LB) * 10) / 10 };
}

const DEFAULT_WINDOW_DAYS = 120;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Per-exercise distinct-load aggregation of raw readings into LV points. */
export function lvPointsFromReadings(
  rows: { loadKg: number; meanVelocityMs: number }[],
): { points: LvPoint[]; readingsUsed: number } {
  const byLoad = new Map<number, { sum: number; n: number }>();
  let used = 0;
  for (const r of rows) {
    if (!(r.loadKg > 0) || !(r.meanVelocityMs > 0)) continue;
    const key = round1(r.loadKg);
    const b = byLoad.get(key) ?? { sum: 0, n: 0 };
    b.sum += r.meanVelocityMs;
    b.n += 1;
    byLoad.set(key, b);
    used += 1;
  }
  const points = [...byLoad.entries()].map(([loadKg, b]) => ({ loadKg, velocityMs: b.sum / b.n }));
  return { points, readingsUsed: used };
}

export async function suggestVbtMaxes(
  tx: Tx,
  v: Viewer,
  athleteId: string,
  opts: { windowDays?: number; today?: string } = {},
): Promise<VbtMaxSuggestion[]> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const today = opts.today ?? todayLocal();
  const since = new Date(`${addDaysYmd(today, -windowDays)}T00:00:00Z`);

  const rows = await tx
    .select({
      exerciseId: vbtReadings.exerciseId,
      exerciseName: exercises.name,
      exerciseUnit: exercises.defaultUnit,
      load: vbtReadings.load,
      loadUnit: vbtReadings.loadUnit,
      meanVelocityMs: vbtReadings.meanVelocityMs,
    })
    .from(vbtReadings)
    .innerJoin(exercises, eq(exercises.id, vbtReadings.exerciseId))
    .where(
      and(
        eq(vbtReadings.orgId, v.orgId),
        eq(vbtReadings.athleteId, athleteId),
        isNotNull(vbtReadings.exerciseId),
        isNotNull(vbtReadings.load),
        isNotNull(vbtReadings.meanVelocityMs),
        gte(vbtReadings.performedAt, since),
      ),
    );

  const byExercise = new Map<string, { name: string; unit: string | null; rows: { loadKg: number; meanVelocityMs: number }[] }>();
  for (const r of rows) {
    if (!r.exerciseId || r.load == null || r.meanVelocityMs == null) continue;
    const loadNum = Number(r.load);
    if (!Number.isFinite(loadNum)) continue;
    const loadKg = r.loadUnit === "lb" ? loadNum * KG_PER_LB : loadNum;
    const e = byExercise.get(r.exerciseId) ?? { name: r.exerciseName, unit: r.exerciseUnit, rows: [] };
    e.rows.push({ loadKg, meanVelocityMs: r.meanVelocityMs });
    byExercise.set(r.exerciseId, e);
  }

  const out: VbtMaxSuggestion[] = [];
  for (const [exerciseId, e] of byExercise) {
    const { points, readingsUsed } = lvPointsFromReadings(e.rows);
    const mvtMs = mvtForName(e.name);
    const e1rmKg = e1rmFromLvProfile(points, mvtMs);
    if (e1rmKg == null) continue;

    const [cur] = await tx
      .select()
      .from(maxes)
      .where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athleteId), eq(maxes.exerciseId, exerciseId), inArray(maxes.unit, ["lb", "kg"])))
      .orderBy(desc(maxes.recordedOn), desc(maxes.createdAt))
      .limit(1);

    out.push({
      exerciseId,
      exerciseName: e.name,
      e1rmKg,
      method: "lv_profile_v1",
      mvtMs,
      points: points.sort((a, b) => a.loadKg - b.loadKg),
      readingsUsed,
      windowDays,
      current: cur ? { value: Number(cur.value), unit: cur.unit, recordedOn: cur.recordedOn, method: cur.method, kind: cur.kind } : null,
      store: storeValueFor(e1rmKg, cur?.unit, e.unit),
    });
  }
  return out.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));
}

/**
 * Confirm a suggested lv_profile_v1 max: recompute from the data (never trust
 * a client-sent value), append to maxes (kind "estimated"), refresh unstarted
 * %-based loads, audit. Throws when the data no longer supports an estimate.
 */
export async function confirmVbtMax(
  tx: Tx,
  v: Viewer,
  input: { athleteId: string; exerciseId: string; windowDays?: number; today?: string },
) {
  await requireOnAthlete(tx, v, input.athleteId, "training.write");
  const today = input.today ?? todayLocal();
  const suggestions = await suggestVbtMaxes(tx, v, input.athleteId, { windowDays: input.windowDays, today });
  const s = suggestions.find((x) => x.exerciseId === input.exerciseId);
  if (!s) throw new TrainingError("Not enough load–velocity data for that lift (needs sets at 2+ loads with bar speeds).");

  const [m] = await tx
    .insert(maxes)
    .values({
      orgId: v.orgId,
      athleteId: input.athleteId,
      exerciseId: input.exerciseId,
      value: String(s.store.value),
      unit: s.store.unit,
      // Always an estimate, never a tested max: boards, showcase and recaps skip it.
      kind: "estimated",
      method: "lv_profile_v1",
      source: BAR_SPEED_SOURCE,
      recordedOn: today,
      enteredBy: v.userId,
    })
    .returning();
  const refreshed = await refreshUnstartedLoads(tx, v.orgId, input.athleteId, today, actor(v));
  await audit(tx, actor(v), "training.max.confirm_bar_speed", "max", m.id, {
    summary: `Confirmed max estimated from bar speed (lv_profile_v1): ${s.e1rmKg} kg${s.store.unit === "lb" ? ` = ${s.store.value} lb` : ""} for ${s.exerciseName} (${s.points.length} loads, ${s.readingsUsed} readings)`,
    before: s.current,
    after: { ...input, e1rmKg: s.e1rmKg, stored: s.store, mvtMs: s.mvtMs, points: s.points, source: BAR_SPEED_SOURCE },
  });
  return { max: m, suggestion: s, refreshed };
}

/**
 * Suggestions a coach still has to decide on: not already confirmed at this value and not
 * dismissed at this value. Staff with training.write only; nothing here is ever auto-applied.
 */
export async function pendingVbtSuggestions(tx: Tx, v: Viewer, athleteId: string, opts: { windowDays?: number; today?: string } = {}): Promise<VbtMaxSuggestion[]> {
  await requireOnAthlete(tx, v, athleteId, "training.write");
  const all = await suggestVbtMaxes(tx, v, athleteId, opts);
  if (!all.length) return [];
  const dismissed = await tx
    .select()
    .from(vbtMaxDismissals)
    .where(and(eq(vbtMaxDismissals.orgId, v.orgId), eq(vbtMaxDismissals.athleteId, athleteId)))
    .orderBy(desc(vbtMaxDismissals.createdAt));
  return all.filter((s) => {
    if (s.current && s.current.method === "lv_profile_v1" && s.current.unit === s.store.unit && s.current.value === s.store.value) return false;
    const d = dismissed.find((x) => x.exerciseId === s.exerciseId);
    return !(d && Number(d.e1rmKg) === s.e1rmKg);
  });
}

/** Dismiss the current suggestion for one lift. It returns only if new readings change the estimate. */
export async function dismissVbtMax(tx: Tx, v: Viewer, input: { athleteId: string; exerciseId: string; windowDays?: number; today?: string }) {
  await requireOnAthlete(tx, v, input.athleteId, "training.write");
  const s = (await suggestVbtMaxes(tx, v, input.athleteId, { windowDays: input.windowDays, today: input.today })).find((x) => x.exerciseId === input.exerciseId);
  if (!s) throw new TrainingError("There is no bar-speed suggestion for that lift.");
  const [d] = await tx
    .insert(vbtMaxDismissals)
    .values({ orgId: v.orgId, athleteId: input.athleteId, exerciseId: input.exerciseId, method: s.method, e1rmKg: String(s.e1rmKg), readingsUsed: s.readingsUsed, dismissedBy: v.userId })
    .returning();
  await audit(tx, actor(v), "training.max.dismiss_bar_speed", "vbt_max_dismissal", d.id, {
    summary: `Dismissed bar-speed max suggestion ${s.e1rmKg} kg for ${s.exerciseName}; no max stored`,
    after: { athleteId: input.athleteId, exerciseId: input.exerciseId, e1rmKg: s.e1rmKg, readingsUsed: s.readingsUsed },
  });
  return d;
}

export type VbtLiftInfo = { profile: LiftProfile; mvtMs: number; method: "mpv_squat_v1" | "mpv_bench_v1" | "mpv_generic_v1" };
export const vbtLiftKey = (athleteId: string, exerciseId: string) => `${athleteId}:${exerciseId}`;

/**
 * Which (athlete, exercise) pairs have enough bar-speed data to show a live %1RM estimate:
 * the same test as a max suggestion (a valid lv_profile_v1 fit in the window). Pairs without it
 * are simply absent, so the logger shows nothing rather than a guess. Callers scope the athletes.
 */
export async function vbtReadyLifts(
  tx: Tx,
  orgId: string,
  pairs: { athleteId: string; exerciseId: string; exerciseName: string }[],
  opts: { windowDays?: number; today?: string } = {},
): Promise<Map<string, VbtLiftInfo>> {
  const out = new Map<string, VbtLiftInfo>();
  if (!pairs.length) return out;
  const since = new Date(`${addDaysYmd(opts.today ?? todayLocal(), -(opts.windowDays ?? DEFAULT_WINDOW_DAYS))}T00:00:00Z`);
  const rows = await tx
    .select({ athleteId: vbtReadings.athleteId, exerciseId: vbtReadings.exerciseId, load: vbtReadings.load, loadUnit: vbtReadings.loadUnit, v: vbtReadings.meanVelocityMs })
    .from(vbtReadings)
    .where(
      and(
        eq(vbtReadings.orgId, orgId),
        inArray(vbtReadings.athleteId, [...new Set(pairs.map((p) => p.athleteId))]),
        inArray(vbtReadings.exerciseId, [...new Set(pairs.map((p) => p.exerciseId))]),
        isNotNull(vbtReadings.load),
        isNotNull(vbtReadings.meanVelocityMs),
        gte(vbtReadings.performedAt, since),
      ),
    );
  for (const p of pairs) {
    const key = vbtLiftKey(p.athleteId, p.exerciseId);
    if (out.has(key)) continue;
    const mine = rows
      .filter((r) => r.athleteId === p.athleteId && r.exerciseId === p.exerciseId && Number.isFinite(Number(r.load)))
      .map((r) => ({ loadKg: r.loadUnit === "lb" ? Number(r.load) * KG_PER_LB : Number(r.load), meanVelocityMs: r.v! }));
    const mvtMs = mvtForName(p.exerciseName);
    if (e1rmFromLvProfile(lvPointsFromReadings(mine).points, mvtMs) == null) continue;
    const profile = liftProfileForName(p.exerciseName);
    out.set(key, { profile, mvtMs, method: `mpv_${profile}_v1` });
  }
  return out;
}

export { lvLinearFit };
