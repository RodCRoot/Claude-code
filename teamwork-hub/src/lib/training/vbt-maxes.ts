import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { exercises, maxes, vbtReadings } from "@/db/schema";
import { requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { actor, TrainingError } from "./common";
import { KG_PER_LB } from "./formulas";
import { refreshUnstartedLoads } from "./assignments";
import { e1rmFromLvProfile, lvLinearFit, mvtForName, type LvPoint } from "./vbt";

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
  current: { value: number; unit: string; recordedOn: string; method: string } | null;
};

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

  const byExercise = new Map<string, { name: string; rows: { loadKg: number; meanVelocityMs: number }[] }>();
  for (const r of rows) {
    if (!r.exerciseId || r.load == null || r.meanVelocityMs == null) continue;
    const loadNum = Number(r.load);
    if (!Number.isFinite(loadNum)) continue;
    const loadKg = r.loadUnit === "lb" ? loadNum * KG_PER_LB : loadNum;
    const e = byExercise.get(r.exerciseId) ?? { name: r.exerciseName, rows: [] };
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
      .where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athleteId), eq(maxes.exerciseId, exerciseId)))
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
      current: cur ? { value: Number(cur.value), unit: cur.unit, recordedOn: cur.recordedOn, method: cur.method } : null,
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
      value: String(s.e1rmKg),
      unit: "kg",
      kind: "estimated",
      method: "lv_profile_v1",
      recordedOn: today,
      enteredBy: v.userId,
    })
    .returning();
  const refreshed = await refreshUnstartedLoads(tx, v.orgId, input.athleteId, today, actor(v));
  await audit(tx, actor(v), "training.max.record", "max", m.id, {
    summary: `lv_profile_v1 estimated max ${s.e1rmKg} kg for ${s.exerciseName} (${s.points.length} loads, ${s.readingsUsed} readings)`,
    after: { ...input, e1rmKg: s.e1rmKg, points: s.points },
  });
  return { max: m, suggestion: s, refreshed };
}

export { lvLinearFit };
