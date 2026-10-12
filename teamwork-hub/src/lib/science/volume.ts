import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Tx } from "@/db";
import { exercises, maxes, setLogs, workoutItems, workouts } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { scopedAthletes } from "./access";
import { computeVolume, selectDatedMax, unitFamily, type VolumeBucket, type VolumeOptions, type VolumeSet } from "./formulas";

export type VolumeQuery = {
  athleteIds?: string[];
  from: string;
  to: string;
  groupBy: VolumeOptions["groupBy"];
  includeWarmups: boolean;
  displayUnit: "lb" | "kg";
};

/**
 * Volume tracker over set_logs (training module data, read-only here), joined to the exercise
 * actually performed (substitution-aware). Scoped to athletes the viewer can read training for.
 */
export async function volumeReport(tx: Tx, v: Viewer, q: VolumeQuery): Promise<{ buckets: VolumeBucket[]; totalSets: number; athletes: { id: string; name: string }[]; hasAnySetLogs: boolean }> {
  const scope = await scopedAthletes(tx, v, "training.read", { includeInactive: true });
  const allowed = q.athleteIds?.length ? scope.filter((a) => q.athleteIds!.includes(a.id)) : scope;
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(setLogs).where(eq(setLogs.orgId, v.orgId));
  if (!allowed.length) return { buckets: [], totalSets: 0, athletes: [], hasAnySetLogs: n > 0 };
  const sets = await loadVolumeSets(tx, v.orgId, allowed, q.from, q.to);
  const names = new Map(allowed.map((a) => [a.id, a.name]));
  const buckets = computeVolume(sets, { includeWarmups: q.includeWarmups, displayUnit: q.displayUnit, groupBy: q.groupBy, labelFor: (s) => names.get(s.athleteId) ?? "Athlete" });
  return { buckets, totalSets: sets.length, athletes: allowed.map((a) => ({ id: a.id, name: a.name })), hasAnySetLogs: n > 0 };
}

export async function loadVolumeSets(tx: Tx, orgId: string, athletes: { id: string; bodyMassKg: number | null }[], from: string, to: string): Promise<VolumeSet[]> {
  const performed = alias(exercises, "performed");
  const rows = await tx
    .select({
      s: setLogs,
      date: workouts.scheduledDate,
      planned: exercises,
      performed: performed,
    })
    .from(setLogs)
    .innerJoin(workoutItems, eq(workoutItems.id, setLogs.workoutItemId))
    .innerJoin(workouts, eq(workouts.id, workoutItems.workoutId))
    .innerJoin(exercises, eq(exercises.id, workoutItems.exerciseId))
    .leftJoin(performed, eq(performed.id, workoutItems.substitutedExerciseId))
    .where(and(eq(setLogs.orgId, orgId), inArray(setLogs.athleteId, athletes.map((a) => a.id)), gte(workouts.scheduledDate, from), lte(workouts.scheduledDate, to)));
  const mass = new Map(athletes.map((a) => [a.id, a.bodyMassKg]));
  const maxRows = rows.length
    ? await tx.select().from(maxes).where(and(eq(maxes.orgId, orgId), inArray(maxes.athleteId, athletes.map((a) => a.id)), lte(maxes.recordedOn, to)))
    : [];
  const maxesBy = new Map<string, { recordedOn: string; value: number; unit: string }[]>();
  for (const m of maxRows) {
    if (unitFamily(m.unit) !== "mass") continue;
    const k = `${m.athleteId}:${m.exerciseId}`;
    maxesBy.set(k, [...(maxesBy.get(k) ?? []), { recordedOn: m.recordedOn, value: Number(m.value), unit: m.unit }]);
  }
  return rows.map(({ s, date, planned, performed: perf }) => {
    const ex = perf ?? planned;
    const maxEx = ex.maxSourceExerciseId ?? ex.id;
    const max = selectDatedMax(maxesBy.get(`${s.athleteId}:${maxEx}`) ?? [], date);
    return {
      id: s.id,
      athleteId: s.athleteId,
      date,
      exerciseId: ex.id,
      exerciseName: ex.name,
      category: ex.category,
      movementPattern: ex.movementPattern,
      trackingType: ex.trackingType,
      isUnilateral: ex.isUnilateral,
      bodyweightFactor: ex.bodyweightFactor,
      side: s.side,
      isWarmup: s.isWarmup,
      completed: s.completed,
      reps: s.reps,
      load: s.load === null ? null : Number(s.load),
      loadUnit: s.loadUnit,
      durationS: s.durationS === null ? null : Number(s.durationS),
      distanceM: s.distanceM === null ? null : Number(s.distanceM),
      bodyMassKg: mass.get(s.athleteId) ?? null,
      max: max ? { value: max.value, unit: max.unit } : null,
    };
  });
}
