import { and, asc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { exercises } from "@/db/schema";
import { assertCan, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actor, TrainingError } from "./common";

export const EXERCISE_CATEGORIES = ["Lower body", "Upper body", "Olympic", "Core", "Speed", "Plyometric", "Conditioning", "Mobility", "Accessory"] as const;
export const MOVEMENT_PATTERNS = ["squat", "hinge", "lunge", "horizontal push", "horizontal pull", "vertical push", "vertical pull", "carry", "rotation", "anti-rotation", "jump", "sprint", "olympic"] as const;
export const TRACKING_TYPES = ["weight_reps", "reps", "bodyweight_reps", "time", "distance", "time_distance"] as const;
export const UNITS = ["lb", "kg", "s", "m", "yd", "reps"] as const;

export type Exercise = typeof exercises.$inferSelect;

export async function listExercises(
  tx: Tx,
  v: Viewer,
  f: { q?: string; category?: string; pattern?: string; includeInactive?: boolean } = {},
): Promise<Exercise[]> {
  if (!isStaff(v)) throw new AuthzError();
  const conds = [eq(exercises.orgId, v.orgId)];
  if (!f.includeInactive) conds.push(eq(exercises.active, true));
  if (f.q) conds.push(or(ilike(exercises.name, `%${f.q}%`), ilike(sql`coalesce(${exercises.coachingNotes}, '')`, `%${f.q}%`))!);
  if (f.category) conds.push(eq(exercises.category, f.category));
  if (f.pattern) conds.push(eq(exercises.movementPattern, f.pattern));
  return tx.select().from(exercises).where(and(...conds)).orderBy(asc(exercises.name));
}

/** Names only — usable by any signed-in viewer to render their own workouts. */
export async function exerciseNameMap(tx: Tx, orgId: string, ids?: string[]): Promise<Map<string, Exercise>> {
  const rows = await tx
    .select()
    .from(exercises)
    .where(and(eq(exercises.orgId, orgId), ids ? (ids.length ? inArray(exercises.id, ids) : sql`false`) : undefined));
  return new Map(rows.map((r) => [r.id, r]));
}

const optStr = z.preprocess((x) => (typeof x === "string" && x.trim() === "" ? null : typeof x === "string" ? x.trim() : x), z.string().max(2000).nullable().optional());

export const exerciseInput = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  category: z.string().trim().min(1).max(60),
  movementPattern: optStr,
  equipment: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  trackingType: z.enum(TRACKING_TYPES),
  defaultUnit: z.enum(UNITS),
  isUnilateral: z.boolean().default(false),
  bodyweightFactor: z.number().min(0).max(1.5).nullable().optional(),
  videoUrl: z.preprocess(
    (x) => (x === "" ? null : x),
    z.string().url("Must be a full https:// link").refine((u) => u.startsWith("https://"), "Use an https:// link").nullable().optional(),
  ),
  coachingNotes: optStr,
  substitutionIds: z.array(z.string().uuid()).max(20).default([]),
  maxSourceExerciseId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true),
});
export type ExerciseInput = z.input<typeof exerciseInput>;

async function checkRefs(tx: Tx, orgId: string, ids: string[], selfId?: string) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (selfId && uniq.includes(selfId)) throw new TrainingError("An exercise cannot reference itself as a substitution or max source.");
  if (!uniq.length) return;
  const rows = await tx.select({ id: exercises.id }).from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.id, uniq)));
  if (rows.length !== uniq.length) throw new TrainingError("Referenced exercise not found.");
}

async function nameTaken(tx: Tx, orgId: string, name: string, exceptId?: string) {
  const rows = await tx
    .select({ id: exercises.id })
    .from(exercises)
    .where(and(eq(exercises.orgId, orgId), sql`lower(${exercises.name}) = lower(${name})`, exceptId ? ne(exercises.id, exceptId) : undefined));
  return rows.length > 0;
}

export async function createExercise(tx: Tx, v: Viewer, raw: ExerciseInput) {
  assertCan(v, "training.manage");
  const input = exerciseInput.parse(raw);
  await checkRefs(tx, v.orgId, [...input.substitutionIds, ...(input.maxSourceExerciseId ? [input.maxSourceExerciseId] : [])]);
  if (await nameTaken(tx, v.orgId, input.name)) throw new TrainingError(`An exercise named "${input.name}" already exists.`);
  const [row] = await tx.insert(exercises).values({ orgId: v.orgId, ...input }).returning();
  await audit(tx, actor(v), "training.exercise.create", "exercise", row.id, { summary: `Created exercise ${row.name}`, after: input });
  return row;
}

export async function updateExercise(tx: Tx, v: Viewer, id: string, raw: ExerciseInput) {
  assertCan(v, "training.manage");
  const input = exerciseInput.parse(raw);
  const [before] = await tx.select().from(exercises).where(and(eq(exercises.id, id), eq(exercises.orgId, v.orgId)));
  if (!before) throw new TrainingError("Exercise not found.");
  await checkRefs(tx, v.orgId, [...input.substitutionIds, ...(input.maxSourceExerciseId ? [input.maxSourceExerciseId] : [])], id);
  if (await nameTaken(tx, v.orgId, input.name, id)) throw new TrainingError(`An exercise named "${input.name}" already exists.`);
  const [row] = await tx.update(exercises).set(input).where(eq(exercises.id, id)).returning();
  await audit(tx, actor(v), "training.exercise.update", "exercise", id, { summary: `Updated exercise ${row.name}`, before, after: input });
  return row;
}
