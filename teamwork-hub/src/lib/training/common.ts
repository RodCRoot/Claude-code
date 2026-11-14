import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, organizations, people, workoutItems, workouts } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, AuthzError, requireOnAthlete, type Capability, type Viewer } from "@/lib/authz/policy";
import type { AuditActor } from "@/lib/audit";
import { DEFAULT_INCREMENT, type LoadUnit } from "./formulas";

export class TrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingError";
  }
}

export const actor = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export type TrainingSettings = { increment: Record<LoadUnit, number> };

/** Plate increments are org-configurable (organizations.settings.training); defaults 5 lb / 2.5 kg. */
export async function trainingSettings(tx: Tx, orgId: string): Promise<TrainingSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const t = (o?.settings?.training ?? {}) as { incrementLb?: number; incrementKg?: number };
  return {
    increment: {
      lb: t.incrementLb && t.incrementLb > 0 ? t.incrementLb : DEFAULT_INCREMENT.lb,
      kg: t.incrementKg && t.incrementKg > 0 ? t.incrementKg : DEFAULT_INCREMENT.kg,
    },
  };
}

/** Display names for athletes (org-scoped). */
export async function athleteNames(tx: Tx, orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, preferred: people.preferredName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, orgId), inArray(athletes.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, `${r.preferred ?? r.first} ${r.last}`]));
}

/** Load a workout and check the viewer's capability on its athlete. Throws AuthzError when out of scope. */
export async function workoutForViewer(tx: Tx, v: Viewer, workoutId: string, cap: Capability) {
  const [w] = await tx.select().from(workouts).where(and(eq(workouts.id, workoutId), eq(workouts.orgId, v.orgId)));
  if (!w) throw new AuthzError("Workout not found or not accessible.");
  await requireOnAthlete(tx, v, w.athleteId, cap);
  return w;
}

/** Load a workout item + its workout and check capability on the athlete. */
export async function itemForViewer(tx: Tx, v: Viewer, itemId: string, cap: Capability) {
  const [row] = await tx
    .select({ item: workoutItems, workout: workouts })
    .from(workoutItems)
    .innerJoin(workouts, eq(workouts.id, workoutItems.workoutId))
    .where(and(eq(workoutItems.id, itemId), eq(workouts.orgId, v.orgId)));
  if (!row) throw new AuthzError("Workout item not found or not accessible.");
  await requireOnAthlete(tx, v, row.workout.athleteId, cap);
  return row;
}

/** Active athletes the viewer can program for (training.write), as [id, name] sorted by name. */
export async function writableAthletes(tx: Tx, v: Viewer): Promise<[string, string][]> {
  const scope = await accessibleAthleteIds(tx, v, "training.write");
  if (scope !== "all" && !scope.length) return [];
  const rows = await tx
    .select({ id: athletes.id })
    .from(athletes)
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)));
  const names = await athleteNames(tx, v.orgId, rows.map((r) => r.id));
  return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

export const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
