import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { exercises, groupMembers, maxes, workouts } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, isStaff, AuthzError, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { actor, athleteNames, workoutForViewer } from "./common";
import { workoutProgress, workoutsWithItems } from "./logging";
import { e1rmPoints } from "./maxes";

export type ReviewFilters = { groupId?: string; athleteId?: string; review?: "unreviewed" | "reviewed" | "all"; from?: string; to?: string; limit?: number };

/** Logged results feed (in-progress + completed workouts) for athletes in the viewer's scope. */
export async function reviewFeed(tx: Tx, v: Viewer, f: ReviewFilters = {}) {
  if (!isStaff(v)) throw new AuthzError();
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const conds = [
    eq(workouts.orgId, v.orgId),
    athleteScopeFilter(scope, workouts.athleteId),
    inArray(workouts.status, ["completed", "in_progress"]),
  ];
  if (f.athleteId) conds.push(eq(workouts.athleteId, f.athleteId));
  if (f.groupId) conds.push(sql`${workouts.athleteId} in (select ${groupMembers.athleteId} from ${groupMembers} where ${groupMembers.groupId} = ${f.groupId})`);
  if (f.review === "unreviewed") conds.push(isNull(workouts.coachReviewedAt));
  if (f.review === "reviewed") conds.push(isNotNull(workouts.coachReviewedAt));
  if (f.from) conds.push(gte(workouts.scheduledDate, f.from));
  if (f.to) conds.push(lte(workouts.scheduledDate, f.to));
  const ws = await tx.select().from(workouts).where(and(...conds)).orderBy(desc(workouts.scheduledDate), desc(workouts.updatedAt)).limit(f.limit ?? 50);
  const full = await workoutsWithItems(tx, v.orgId, ws);
  return full.map((w) => ({ ...w, progress: workoutProgress(w) }));
}

export async function reviewWorkout(tx: Tx, v: Viewer, workoutId: string, feedback: string | null, reviewed = true) {
  const w = await workoutForViewer(tx, v, workoutId, "training.write");
  const fb = feedback?.trim() ? feedback.trim().slice(0, 2000) : w.coachFeedback;
  await tx
    .update(workouts)
    .set({ coachFeedback: fb, coachReviewedAt: reviewed ? new Date() : null, coachReviewedBy: reviewed ? v.userId : null, updatedAt: new Date() })
    .where(eq(workouts.id, w.id));
  await audit(tx, actor(v), reviewed ? "training.workout.review" : "training.workout.unreview", "workout", w.id, {
    summary: feedback?.trim() ? "Coach feedback added" : reviewed ? "Marked reviewed" : "Marked unreviewed",
    before: { coachFeedback: w.coachFeedback, reviewed: !!w.coachReviewedAt },
    after: { coachFeedback: fb, reviewed },
  });
}

export type PrAlert = {
  athleteId: string;
  athleteName: string;
  exerciseId: string;
  exerciseName: string;
  date: string;
  kind: "e1rm" | "tested";
  value: number;
  unit: string;
  previous: number | null;
  detail: string;
};

/**
 * PR alerts since `since`: a logged set whose Epley e1RM beats every earlier e1RM and every
 * earlier recorded max (same athlete, exercise, unit), or a tested max above the previous best.
 */
export async function prAlerts(tx: Tx, v: Viewer, opts: { since?: string; athleteIds?: string[] } = {}): Promise<PrAlert[]> {
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  let ids: string[];
  if (scope === "all") {
    ids = opts.athleteIds ?? (await tx.selectDistinct({ id: workouts.athleteId }).from(workouts).where(eq(workouts.orgId, v.orgId))).map((r) => r.id);
  } else ids = opts.athleteIds ? opts.athleteIds.filter((i) => scope.includes(i)) : scope;
  if (!ids.length) return [];
  const since = opts.since ?? addDaysYmd(todayLocal(), -14);
  const pts = await e1rmPoints(tx, v.orgId, ids);
  const mx = await tx.select().from(maxes).where(and(eq(maxes.orgId, v.orgId), inArray(maxes.athleteId, ids))).orderBy(asc(maxes.recordedOn), asc(maxes.createdAt));
  type Ev = { athleteId: string; exerciseId: string; date: string; unit: string; value: number; kind: "e1rm" | "tested" | "other"; detail: string };
  const events: Ev[] = [
    ...pts.map((p) => ({ athleteId: p.athleteId, exerciseId: p.exerciseId, date: p.date, unit: p.unit, value: p.e1rm, kind: "e1rm" as const, detail: `${p.load} ${p.unit} × ${p.reps} (Epley v1 e1RM)` })),
    ...mx.map((m) => ({ athleteId: m.athleteId, exerciseId: m.exerciseId, date: m.recordedOn, unit: m.unit, value: Number(m.value), kind: m.kind === "tested" ? ("tested" as const) : ("other" as const), detail: `${m.kind} max (${m.method})` })),
  ].sort((a, b) => (a.date === b.date ? (a.kind === "e1rm" ? 1 : -1) : a.date < b.date ? -1 : 1));
  const best = new Map<string, number>();
  const out: Omit<PrAlert, "athleteName" | "exerciseName">[] = [];
  for (const e of events) {
    const k = `${e.athleteId}:${e.exerciseId}:${e.unit}`;
    const prev = best.get(k);
    if (prev == null || e.value > prev) {
      if (prev != null && e.date >= since && e.kind !== "other") out.push({ athleteId: e.athleteId, exerciseId: e.exerciseId, date: e.date, kind: e.kind, value: e.value, unit: e.unit, previous: prev, detail: e.detail });
      best.set(k, e.value);
    }
  }
  const names = await athleteNames(tx, v.orgId, out.map((o) => o.athleteId));
  const exIds = [...new Set(out.map((o) => o.exerciseId))];
  const exRows = exIds.length ? await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(inArray(exercises.id, exIds)) : [];
  const exMap = new Map(exRows.map((e) => [e.id, e.name]));
  // Keep only the best PR per athlete/exercise/day.
  const dedup = new Map<string, (typeof out)[number]>();
  for (const o of out) {
    const k = `${o.athleteId}:${o.exerciseId}:${o.date}`;
    if (!dedup.has(k) || dedup.get(k)!.value < o.value) dedup.set(k, o);
  }
  return [...dedup.values()]
    .map((o) => ({ ...o, athleteName: names.get(o.athleteId) ?? "Athlete", exerciseName: exMap.get(o.exerciseId) ?? "Exercise" }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}
