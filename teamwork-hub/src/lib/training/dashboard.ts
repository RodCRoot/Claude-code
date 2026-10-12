import { and, asc, desc, eq, inArray, lte, gte } from "drizzle-orm";
import type { Tx } from "@/db";
import { setLogs, workoutItems, workouts, exercises } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { athleteNames, num } from "./common";
import { workoutProgress, workoutsWithItems } from "./logging";
import { adherence } from "./formulas";

/**
 * Workouts the viewer can see for a date: athletes see their own (loggable); guardians see
 * children with training access (read-only); staff see their scoped athletes.
 * Exported for the Today dashboard.
 */
export async function workoutsForDate(tx: Tx, v: Viewer, date = todayLocal(), opts: { athleteIds?: string[] } = {}) {
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  if (scope !== "all" && !scope.length) return [];
  const ws = await tx
    .select()
    .from(workouts)
    .where(
      and(
        eq(workouts.orgId, v.orgId),
        eq(workouts.scheduledDate, date),
        athleteScopeFilter(scope, workouts.athleteId),
        opts.athleteIds ? inArray(workouts.athleteId, opts.athleteIds.length ? opts.athleteIds : ["00000000-0000-0000-0000-000000000000"]) : undefined,
      ),
    )
    .orderBy(asc(workouts.title));
  const full = await workoutsWithItems(tx, v.orgId, ws);
  return full.map((w) => ({ ...w, progress: workoutProgress(w) }));
}

export type TodayWorkoutSummary = {
  workoutId: string;
  athleteId: string;
  athleteName: string;
  title: string;
  status: string;
  setsDone: number;
  setsTotal: number;
  href: string;
};

/** Compact summary for the Today dashboard card (athlete/guardian: own; staff: scoped, capped). */
export async function todaysWorkoutSummary(tx: Tx, v: Viewer, date = todayLocal(), limit = 12): Promise<TodayWorkoutSummary[]> {
  const ws = await workoutsForDate(tx, v, date);
  return ws.slice(0, limit).map((w) => ({
    workoutId: w.id,
    athleteId: w.athleteId,
    athleteName: w.athleteName,
    title: w.title,
    status: w.status,
    setsDone: w.progress.done,
    setsTotal: w.progress.total,
    href: v.role === "athlete" ? "/training/today" : `/training/workouts/${w.id}`,
  }));
}

export type RecentLog = { workoutId: string; athleteId: string; athleteName: string; date: string; exercise: string; summary: string; loggedAt: string };

/** Most recent logged sets across a coach's scoped athletes (for Today/People coach cards). */
export async function recentLogsForCoach(tx: Tx, v: Viewer, limit = 15): Promise<RecentLog[]> {
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  if (scope !== "all" && !scope.length) return [];
  const rows = await tx
    .select({ log: setLogs, workoutId: workouts.id, date: workouts.scheduledDate, ex: exercises.name })
    .from(setLogs)
    .innerJoin(workoutItems, eq(workoutItems.id, setLogs.workoutItemId))
    .innerJoin(workouts, eq(workouts.id, workoutItems.workoutId))
    .innerJoin(exercises, eq(exercises.id, workoutItems.exerciseId))
    .where(and(eq(setLogs.orgId, v.orgId), athleteScopeFilter(scope, setLogs.athleteId)))
    .orderBy(desc(setLogs.loggedAt))
    .limit(limit);
  const names = await athleteNames(tx, v.orgId, rows.map((r) => r.log.athleteId));
  return rows.map((r) => ({
    workoutId: r.workoutId,
    athleteId: r.log.athleteId,
    athleteName: names.get(r.log.athleteId) ?? "Athlete",
    date: r.date,
    exercise: r.ex,
    summary: `Set ${r.log.setIndex + 1}: ${r.log.reps ?? "—"} reps${r.log.load != null ? ` @ ${num(r.log.load)} ${r.log.loadUnit}` : ""}`,
    loggedAt: r.log.loggedAt.toISOString(),
  }));
}

/** Per-athlete training snapshot for a People profile: adherence (last 28 days) + next workout. */
export async function athleteTrainingSnapshot(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()) {
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  if (scope !== "all" && !scope.includes(athleteId)) return null;
  const ws = await tx
    .select({ id: workouts.id, scheduledDate: workouts.scheduledDate, status: workouts.status, title: workouts.title })
    .from(workouts)
    .where(and(eq(workouts.orgId, v.orgId), eq(workouts.athleteId, athleteId), gte(workouts.scheduledDate, addDaysYmd(today, -28)), lte(workouts.scheduledDate, addDaysYmd(today, 28))))
    .orderBy(asc(workouts.scheduledDate));
  const next = ws.find((w) => w.scheduledDate >= today && w.status !== "completed" && w.status !== "skipped") ?? null;
  return { adherence28d: adherence(ws, today), next, href: `/training/athletes/${athleteId}` };
}
