import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { exercises, maxes, setLogs, workoutItems, workouts } from "@/db/schema";
import { requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { actor, TrainingError } from "./common";
import { estimateOneRepMax, MAX_REPS_FOR_ESTIMATE, type E1rmMethod, type LoadUnit } from "./formulas";
import { refreshUnstartedLoads } from "./assignments";

const maxInput = z.object({
  athleteId: z.string().uuid(),
  exerciseId: z.string().uuid(),
  value: z.number().positive().max(5000),
  unit: z.enum(["lb", "kg", "s", "m", "reps"]),
  kind: z.enum(["tested", "manual"]),
  recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Tested or coach-entered max. History is append-only; the latest on/before a date wins. */
export async function recordMax(tx: Tx, v: Viewer, raw: z.input<typeof maxInput>) {
  const input = maxInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "training.write");
  const [ex] = await tx.select().from(exercises).where(and(eq(exercises.id, input.exerciseId), eq(exercises.orgId, v.orgId)));
  if (!ex) throw new TrainingError("Exercise not found.");
  if (input.recordedOn > todayLocal()) throw new TrainingError("A max can't be recorded in the future.");
  const [m] = await tx
    .insert(maxes)
    .values({ orgId: v.orgId, ...input, value: String(input.value), method: input.kind === "tested" ? "tested" : "manual", enteredBy: v.userId })
    .returning();
  const refreshed = await refreshUnstartedLoads(tx, v.orgId, input.athleteId, input.recordedOn, actor(v));
  await audit(tx, actor(v), "training.max.record", "max", m.id, { summary: `${input.kind} max ${input.value} ${input.unit} for ${ex.name}`, after: input });
  return { max: m, refreshed };
}

export async function maxHistory(tx: Tx, v: Viewer, athleteId: string) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  return tx
    .select({ m: maxes, exerciseName: exercises.name })
    .from(maxes)
    .innerJoin(exercises, eq(exercises.id, maxes.exerciseId))
    .where(and(eq(maxes.athleteId, athleteId), eq(maxes.orgId, v.orgId)))
    .orderBy(asc(exercises.name), desc(maxes.recordedOn), desc(maxes.createdAt));
}

export type E1rmPoint = { date: string; e1rm: number; unit: LoadUnit; load: number; reps: number; setLogId: string; exerciseId: string };

/** Every completed weight×reps set (reps 1–10) with its e1RM, for history charts and PR detection. */
export async function e1rmPoints(tx: Tx, orgId: string, athleteIds: string[], opts: { since?: string; method?: E1rmMethod; exerciseIds?: string[] } = {}) {
  if (!athleteIds.length) return [] as (E1rmPoint & { athleteId: string })[];
  const rows = await tx
    .select({
      id: setLogs.id,
      athleteId: setLogs.athleteId,
      reps: setLogs.reps,
      load: setLogs.load,
      unit: setLogs.loadUnit,
      date: workouts.scheduledDate,
      exerciseId: workoutItems.exerciseId,
      sub: workoutItems.substitutedExerciseId,
      warm: setLogs.isWarmup,
    })
    .from(setLogs)
    .innerJoin(workoutItems, eq(workoutItems.id, setLogs.workoutItemId))
    .innerJoin(workouts, eq(workouts.id, workoutItems.workoutId))
    .where(
      and(
        eq(setLogs.orgId, orgId),
        inArray(setLogs.athleteId, athleteIds),
        eq(setLogs.completed, true),
        isNotNull(setLogs.load),
        isNotNull(setLogs.reps),
        opts.since ? gte(workouts.scheduledDate, opts.since) : undefined,
      ),
    )
    .orderBy(asc(workouts.scheduledDate));
  const out: (E1rmPoint & { athleteId: string })[] = [];
  for (const r of rows) {
    const exId = r.sub ?? r.exerciseId;
    if (opts.exerciseIds && !opts.exerciseIds.includes(exId)) continue;
    if (r.warm || !r.reps || r.reps > MAX_REPS_FOR_ESTIMATE || (r.unit !== "lb" && r.unit !== "kg")) continue;
    const e = estimateOneRepMax(opts.method ?? "epley_v1", Number(r.load), r.reps);
    if (e == null) continue;
    out.push({ athleteId: r.athleteId, date: r.date, e1rm: e, unit: r.unit, load: Number(r.load), reps: r.reps, setLogId: r.id, exerciseId: exId });
  }
  return out;
}

export type MaxSuggestion = { exerciseId: string; exerciseName: string; current: { value: number; unit: string; recordedOn: string } | null; suggested: E1rmPoint };

/**
 * Suggest estimated maxes from recent logged sets (last 42 days) where the best e1RM beats
 * the current recorded max in the same unit. Coach confirms before anything is stored.
 */
export async function suggestEstimatedMaxes(tx: Tx, v: Viewer, athleteId: string, method: E1rmMethod = "epley_v1", today = todayLocal()): Promise<MaxSuggestion[]> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const pts = await e1rmPoints(tx, v.orgId, [athleteId], { since: addDaysYmd(today, -42), method });
  const best = new Map<string, E1rmPoint>();
  for (const p of pts) {
    const k = `${p.exerciseId}:${p.unit}`;
    if (!best.has(k) || best.get(k)!.e1rm < p.e1rm) best.set(k, p);
  }
  if (!best.size) return [];
  const exIds = [...new Set([...best.values()].map((b) => b.exerciseId))];
  const exRows = await tx.select().from(exercises).where(inArray(exercises.id, exIds));
  const exMap = new Map(exRows.map((e) => [e.id, e]));
  const current = await tx.select().from(maxes).where(and(eq(maxes.athleteId, athleteId), inArray(maxes.exerciseId, exIds))).orderBy(desc(maxes.recordedOn), desc(maxes.createdAt));
  const out: MaxSuggestion[] = [];
  for (const p of best.values()) {
    const cur = current.find((m) => m.exerciseId === p.exerciseId && m.unit === p.unit);
    if (cur && cur.sourceSetLogId === p.setLogId) continue;
    if (cur && Number(cur.value) >= p.e1rm) continue;
    out.push({ exerciseId: p.exerciseId, exerciseName: exMap.get(p.exerciseId)?.name ?? "Exercise", current: cur ? { value: Number(cur.value), unit: cur.unit, recordedOn: cur.recordedOn } : null, suggested: p });
  }
  return out.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));
}

/** Coach confirms a suggestion: stores an estimated max derived from a specific set log. */
export async function confirmEstimatedMax(tx: Tx, v: Viewer, setLogId: string, method: E1rmMethod) {
  const [row] = await tx
    .select({ log: setLogs, exerciseId: workoutItems.exerciseId, sub: workoutItems.substitutedExerciseId, date: workouts.scheduledDate })
    .from(setLogs)
    .innerJoin(workoutItems, eq(workoutItems.id, setLogs.workoutItemId))
    .innerJoin(workouts, eq(workouts.id, workoutItems.workoutId))
    .where(and(eq(setLogs.id, setLogId), eq(setLogs.orgId, v.orgId)));
  if (!row) throw new TrainingError("Set not found.");
  await requireOnAthlete(tx, v, row.log.athleteId, "training.write");
  const e = estimateOneRepMax(method, Number(row.log.load), row.log.reps ?? 0);
  if (e == null || (row.log.loadUnit !== "lb" && row.log.loadUnit !== "kg")) throw new TrainingError("That set can't produce a valid estimate.");
  const exerciseId = row.sub ?? row.exerciseId;
  const [m] = await tx
    .insert(maxes)
    .values({ orgId: v.orgId, athleteId: row.log.athleteId, exerciseId, value: String(e), unit: row.log.loadUnit, kind: "estimated", method, sourceSetLogId: setLogId, recordedOn: row.date, enteredBy: v.userId })
    .returning();
  await refreshUnstartedLoads(tx, v.orgId, row.log.athleteId, row.date, actor(v));
  await audit(tx, actor(v), "training.max.confirm_estimate", "max", m.id, { summary: `Confirmed estimated max ${e} ${row.log.loadUnit} (${method}) from ${row.log.load}×${row.log.reps}` });
  return m;
}
