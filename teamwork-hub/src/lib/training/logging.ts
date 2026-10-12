import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { activitySessions, exercises, setLogs, workoutItems, workouts } from "@/db/schema";
import { AuthzError, canOnAthlete, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actor, athleteNames, itemForViewer, num, TrainingError, workoutForViewer } from "./common";
import { expandSets, type ExpandedSet, type ResolvedSetGroup } from "./formulas";

export const setMutationSchema = z.object({
  clientMutationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid client mutation id"),
  workoutItemId: z.string().uuid(),
  setIndex: z.number().int().min(0).max(49),
  side: z.enum(["both", "left", "right"]).default("both"),
  reps: z.number().int().min(0).max(500).nullable().optional(),
  load: z.number().min(0).max(5000).nullable().optional(),
  loadUnit: z.enum(["lb", "kg"]).nullable().optional(),
  durationS: z.number().min(0).max(36000).nullable().optional(),
  distanceM: z.number().min(0).max(100000).nullable().optional(),
  rpe: z.number().min(0).max(10).nullable().optional(),
  completed: z.boolean().default(true),
  /** Client time the entry was made (ms since epoch). Later entries win per slot. */
  loggedAt: z.number().int().positive().optional(),
});
export type SetMutation = z.input<typeof setMutationSchema>;

export type SetMutationResult =
  | { clientMutationId: string; status: "applied" | "duplicate"; setLogId: string }
  | { clientMutationId: string; status: "stale"; setLogId: string | null }
  | { clientMutationId: string; status: "rejected"; error: string };

/**
 * Idempotent set upsert used by the offline queue.
 * 1. Same clientMutationId seen before → returns the existing row ("duplicate"); nothing changes.
 * 2. Otherwise upsert by slot (workout_item, set_index, side): a newer client timestamp
 *    updates the slot in place (never a second row); an older one is ignored ("stale").
 */
export async function applySetMutation(tx: Tx, v: Viewer, raw: SetMutation, via: "athlete_app" | "weight_room" | "coach" = "athlete_app"): Promise<SetMutationResult> {
  const m = setMutationSchema.parse(raw);
  const { item, workout } = await itemForViewer(tx, v, m.workoutItemId, "training.log");

  const [prior] = await tx.select().from(setLogs).where(eq(setLogs.clientMutationId, m.clientMutationId));
  if (prior) {
    if (prior.workoutItemId !== m.workoutItemId || prior.setIndex !== m.setIndex) {
      return { clientMutationId: m.clientMutationId, status: "rejected", error: "Mutation id reused for a different set." };
    }
    return { clientMutationId: m.clientMutationId, status: "duplicate", setLogId: prior.id };
  }
  if (workout.status === "skipped") throw new TrainingError("This workout was marked skipped. Reopen it before logging sets.");

  const [ex] = await tx.select().from(exercises).where(eq(exercises.id, item.substitutedExerciseId ?? item.exerciseId));
  if (m.side !== "both" && !ex?.isUnilateral) throw new TrainingError("Left/right sides only apply to unilateral exercises.");
  const expanded = expandSets(item.prescription as unknown as ResolvedSetGroup[]);
  if (m.setIndex > expanded.length + 5) throw new TrainingError("Set number is out of range for this exercise.");
  if (m.load != null && !m.loadUnit) throw new TrainingError("Load needs a unit (lb or kg).");

  const now = Date.now();
  // Clamp client clocks: never in the future, never more than 30 days old.
  const clientTs = new Date(Math.min(now, Math.max(m.loggedAt ?? now, now - 30 * 86_400_000)));
  const values = {
    orgId: v.orgId,
    workoutItemId: m.workoutItemId,
    athleteId: workout.athleteId,
    setIndex: m.setIndex,
    side: m.side,
    isWarmup: expanded[m.setIndex]?.isWarmup ?? false,
    reps: m.reps ?? null,
    load: m.load != null ? String(m.load) : null,
    loadUnit: m.load != null ? m.loadUnit ?? null : null,
    durationS: m.durationS != null ? String(m.durationS) : null,
    distanceM: m.distanceM != null ? String(m.distanceM) : null,
    rpe: m.rpe != null ? String(m.rpe) : null,
    completed: m.completed,
    clientMutationId: m.clientMutationId,
    loggedBy: v.userId,
    loggedVia: via,
    loggedAt: clientTs,
  };
  const [row] = await tx
    .insert(setLogs)
    .values(values)
    .onConflictDoUpdate({
      target: [setLogs.workoutItemId, setLogs.setIndex, setLogs.side],
      set: {
        reps: values.reps,
        load: values.load,
        loadUnit: values.loadUnit,
        durationS: values.durationS,
        distanceM: values.distanceM,
        rpe: values.rpe,
        completed: values.completed,
        clientMutationId: values.clientMutationId,
        loggedBy: values.loggedBy,
        loggedVia: values.loggedVia,
        loggedAt: values.loggedAt,
        updatedAt: new Date(),
      },
      setWhere: sql`excluded.logged_at >= ${setLogs.loggedAt}`,
    })
    .returning({ id: setLogs.id });
  if (!row) {
    const [cur] = await tx.select({ id: setLogs.id }).from(setLogs).where(and(eq(setLogs.workoutItemId, m.workoutItemId), eq(setLogs.setIndex, m.setIndex), eq(setLogs.side, m.side)));
    return { clientMutationId: m.clientMutationId, status: "stale", setLogId: cur?.id ?? null };
  }
  if (workout.status === "scheduled") {
    await tx.update(workouts).set({ status: "in_progress", startedAt: new Date(), updatedAt: new Date() }).where(eq(workouts.id, workout.id));
  }
  await audit(tx, actor(v), "training.set.log", "set_log", row.id, {
    summary: `Set ${m.setIndex + 1}${m.side !== "both" ? ` (${m.side})` : ""}: ${m.reps ?? "—"} reps${m.load != null ? ` @ ${m.load} ${m.loadUnit}` : ""} via ${via}`,
  });
  return { clientMutationId: m.clientMutationId, status: "applied", setLogId: row.id };
}

const completeInput = z.object({
  sessionRpe: z.number().int().min(0).max(10),
  durationMinutes: z.number().int().min(1).max(600),
  comment: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Complete a workout with session RPE + duration. Creates or updates exactly one
 * activity_sessions row (unique on workout_id) for load monitoring (sRPE × minutes).
 */
export async function completeWorkout(tx: Tx, v: Viewer, workoutId: string, raw: z.input<typeof completeInput>) {
  const input = completeInput.parse(raw);
  const w = await workoutForViewer(tx, v, workoutId, "training.log");
  await tx.execute(sql`select id from workouts where id = ${w.id} for update`);
  const now = new Date();
  await tx
    .update(workouts)
    .set({
      status: "completed",
      completedAt: w.completedAt ?? now,
      startedAt: w.startedAt ?? now,
      sessionRpe: input.sessionRpe,
      durationMinutes: input.durationMinutes,
      athleteComment: input.comment ?? w.athleteComment,
      updatedAt: now,
    })
    .where(eq(workouts.id, w.id));
  const [session] = await tx
    .insert(activitySessions)
    .values({
      orgId: v.orgId,
      athleteId: w.athleteId,
      activityDate: w.scheduledDate,
      kind: "training",
      durationMinutes: input.durationMinutes,
      sessionRpe: input.sessionRpe,
      workoutId: w.id,
      notes: `Workout: ${w.title}`,
      enteredBy: v.userId,
      isDemo: w.isDemo,
    })
    .onConflictDoUpdate({
      target: activitySessions.workoutId,
      set: { durationMinutes: input.durationMinutes, sessionRpe: input.sessionRpe, activityDate: w.scheduledDate, enteredBy: v.userId },
    })
    .returning();
  await audit(tx, actor(v), "training.workout.complete", "workout", w.id, {
    summary: `Completed "${w.title}" sRPE ${input.sessionRpe} × ${input.durationMinutes} min`,
    before: { status: w.status },
    after: { status: "completed", ...input },
  });
  return { workoutId: w.id, activitySessionId: session.id };
}

export async function setWorkoutStatus(tx: Tx, v: Viewer, workoutId: string, status: "skipped" | "scheduled") {
  const w = await workoutForViewer(tx, v, workoutId, "training.log");
  if (status === "skipped" && w.status === "completed") throw new TrainingError("Completed workouts can't be marked skipped.");
  await tx.update(workouts).set({ status, updatedAt: new Date() }).where(eq(workouts.id, w.id));
  await audit(tx, actor(v), `training.workout.${status === "skipped" ? "skip" : "reopen"}`, "workout", w.id, { before: { status: w.status }, after: { status } });
}

/**
 * Athlete-specific substitution on one workout item. Athletes may choose only from the
 * exercise's listed substitutions; staff with training.write may choose any exercise.
 */
export async function substituteItem(tx: Tx, v: Viewer, itemId: string, substituteExerciseId: string | null, modification?: string | null) {
  const { item, workout } = await itemForViewer(tx, v, itemId, "training.log");
  const staffWrite = await canOnAthlete(tx, v, workout.athleteId, "training.write");
  if (substituteExerciseId) {
    const [ex] = await tx.select().from(exercises).where(and(eq(exercises.id, item.exerciseId), eq(exercises.orgId, v.orgId)));
    const [sub] = await tx.select().from(exercises).where(and(eq(exercises.id, substituteExerciseId), eq(exercises.orgId, v.orgId)));
    if (!sub) throw new TrainingError("Substitute exercise not found.");
    if (!staffWrite && !(ex?.substitutionIds ?? []).includes(substituteExerciseId)) {
      throw new AuthzError("Pick one of the coach-approved substitutions, or ask your coach.");
    }
  }
  const mod = modification === undefined ? item.athleteModification : modification?.trim() || null;
  await tx.update(workoutItems).set({ substitutedExerciseId: substituteExerciseId, athleteModification: mod }).where(eq(workoutItems.id, item.id));
  await audit(tx, actor(v), "training.workout_item.modify", "workout_item", item.id, {
    before: { substitutedExerciseId: item.substitutedExerciseId, athleteModification: item.athleteModification },
    after: { substitutedExerciseId: substituteExerciseId, athleteModification: mod },
  });
}

export type WorkoutDetail = Awaited<ReturnType<typeof workoutDetail>>;

/** Full workout with frozen prescriptions, expanded set slots, and logged sets. */
export async function workoutDetail(tx: Tx, v: Viewer, workoutId: string) {
  const w = await workoutForViewer(tx, v, workoutId, "training.read");
  return (await workoutsWithItems(tx, v.orgId, [w]))[0];
}

export async function workoutsWithItems(tx: Tx, orgId: string, ws: (typeof workouts.$inferSelect)[]) {
  if (!ws.length) return [];
  const items = await tx.select().from(workoutItems).where(inArray(workoutItems.workoutId, ws.map((w) => w.id))).orderBy(asc(workoutItems.sortOrder));
  const logs = items.length ? await tx.select().from(setLogs).where(inArray(setLogs.workoutItemId, items.map((i) => i.id))) : [];
  const exIds = [...new Set(items.flatMap((i) => [i.exerciseId, ...(i.substitutedExerciseId ? [i.substitutedExerciseId] : [])]))];
  const exRows = exIds.length ? await tx.select().from(exercises).where(inArray(exercises.id, exIds)) : [];
  const subIds = [...new Set(exRows.flatMap((e) => e.substitutionIds))];
  const subRows = subIds.length ? await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.id, subIds))) : [];
  const exMap = new Map(exRows.map((e) => [e.id, e]));
  const names = await athleteNames(tx, orgId, ws.map((w) => w.athleteId));
  return ws.map((w) => ({
    ...w,
    athleteName: names.get(w.athleteId) ?? "Athlete",
    items: items
      .filter((i) => i.workoutId === w.id)
      .map((i) => {
        const ex = exMap.get(i.exerciseId)!;
        const performed = i.substitutedExerciseId ? exMap.get(i.substitutedExerciseId)! : ex;
        const groups = i.prescription as unknown as ResolvedSetGroup[];
        return {
          id: i.id,
          blockLabel: i.blockLabel,
          notes: i.notes,
          athleteModification: i.athleteModification,
          exercise: { id: ex.id, name: ex.name, trackingType: ex.trackingType, defaultUnit: ex.defaultUnit, isUnilateral: ex.isUnilateral, videoUrl: ex.videoUrl, coachingNotes: ex.coachingNotes },
          performed: { id: performed.id, name: performed.name, isUnilateral: performed.isUnilateral, trackingType: performed.trackingType, defaultUnit: performed.defaultUnit },
          substituted: !!i.substitutedExerciseId,
          substitutionOptions: ex.substitutionIds.map((sid) => subRows.find((s) => s.id === sid)).filter(Boolean) as { id: string; name: string }[],
          groups,
          sets: expandSets(groups) as ExpandedSet[],
          logs: logs
            .filter((l) => l.workoutItemId === i.id)
            .map((l) => ({ id: l.id, setIndex: l.setIndex, side: l.side, reps: l.reps, load: num(l.load), loadUnit: l.loadUnit, rpe: num(l.rpe), durationS: num(l.durationS), distanceM: num(l.distanceM), completed: l.completed, loggedAt: l.loggedAt.toISOString() }))
            .sort((a, b) => a.setIndex - b.setIndex),
        };
      }),
  }));
}

/** Progress for a workout: completed logged slots vs. prescribed slots (unilateral counts both sides). */
export function workoutProgress(w: { items: { sets: ExpandedSet[]; logs: { completed: boolean }[]; performed: { isUnilateral: boolean } }[] }) {
  let total = 0;
  let done = 0;
  for (const i of w.items) {
    total += i.sets.length * (i.performed.isUnilateral ? 2 : 1);
    done += i.logs.filter((l) => l.completed).length;
  }
  return { done: Math.min(done, total), total };
}

export async function ensureCanLog(tx: Tx, v: Viewer, athleteId: string) {
  await requireOnAthlete(tx, v, athleteId, "training.log");
}
