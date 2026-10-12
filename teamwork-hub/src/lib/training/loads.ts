import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Tx } from "@/db";
import { maxes, type LoadPrescription, type ProgressionRule, type SetPrescription } from "@/db/schema";
import { convertLoad, KG_PER_LB, percentLoad, roundToIncrement, type LoadUnit, type ResolvedSetGroup } from "./formulas";
import type { TrainingSettings } from "./common";

export type MaxRow = typeof maxes.$inferSelect;
type MaxLite = { id: string; athleteId: string; exerciseId: string; value: number; unit: string; kind: string; method: string; recordedOn: string; createdAt: Date };

/**
 * In-memory index of an athlete set's max history, so instantiating many workouts
 * does one query. `asOf` returns the latest load max recorded on/before a date.
 */
export class MaxIndex {
  private byKey = new Map<string, MaxLite[]>();
  static async load(tx: Tx, orgId: string, athleteIds: string[], upTo?: string): Promise<MaxIndex> {
    const idx = new MaxIndex();
    if (!athleteIds.length) return idx;
    const rows = await tx
      .select()
      .from(maxes)
      .where(and(eq(maxes.orgId, orgId), inArray(maxes.athleteId, athleteIds), upTo ? lte(maxes.recordedOn, upTo) : undefined))
      .orderBy(asc(maxes.recordedOn), asc(maxes.createdAt));
    for (const r of rows) idx.add({ ...r, value: Number(r.value) });
    return idx;
  }
  add(m: MaxLite) {
    const k = `${m.athleteId}:${m.exerciseId}`;
    const list = this.byKey.get(k) ?? [];
    list.push(m);
    list.sort((a, b) => (a.recordedOn === b.recordedOn ? a.createdAt.getTime() - b.createdAt.getTime() : a.recordedOn < b.recordedOn ? -1 : 1));
    this.byKey.set(k, list);
  }
  /** Latest lb/kg max on or before `date` (ties broken by entry time). */
  asOf(athleteId: string, exerciseId: string, date: string): MaxLite | null {
    const list = this.byKey.get(`${athleteId}:${exerciseId}`) ?? [];
    let best: MaxLite | null = null;
    for (const m of list) {
      if (m.recordedOn > date) break;
      if (m.unit === "lb" || m.unit === "kg") best = m;
    }
    return best;
  }
}

/** Single lookup convenience (used by UI and tests). */
export async function maxAsOf(tx: Tx, orgId: string, athleteId: string, exerciseId: string, date: string) {
  const idx = await MaxIndex.load(tx, orgId, [athleteId], date);
  return idx.asOf(athleteId, exerciseId, date);
}

export type ExerciseLite = { id: string; name: string; maxSourceExerciseId: string | null; defaultUnit: string };

/** Which exercise's max drives % loading for this exercise (e.g. Front Squat → Back Squat). */
export function maxExerciseFor(ex: ExerciseLite, load?: LoadPrescription): string {
  if (load?.type === "percent_max" && load.maxExerciseId) return load.maxExerciseId;
  return ex.maxSourceExerciseId ?? ex.id;
}

/**
 * Resolve template set groups into a frozen snapshot with concrete loads.
 * - % of max uses the athlete's latest max on/before `date`, rounded to the plate increment of the max's unit.
 * - Linear progression adds `perWeek × weekOffset`; a lb/kg mismatch is converted explicitly and noted.
 * - Never converts the max's unit silently: the load is expressed in the unit the max was recorded in.
 */
export function resolveSetGroups(args: {
  athleteId: string;
  exercise: ExerciseLite;
  maxExerciseName?: (id: string) => string | undefined;
  prescription: SetPrescription[];
  progression: ProgressionRule;
  weekOffset: number;
  date: string;
  settings: TrainingSettings;
  maxIndex: MaxIndex;
}): ResolvedSetGroup[] {
  const { athleteId, exercise, prescription, progression, weekOffset, date, settings, maxIndex } = args;
  const baseProg = progression.kind === "linear_load" && weekOffset > 0 ? progression : null;
  return prescription.map((p) => {
    // Warm-up groups stay as written; progression applies to working sets only.
    const prog = p.isWarmup ? null : baseProg;
    const load = p.load ?? { type: "none" as const };
    const g: ResolvedSetGroup = {
      sets: p.sets,
      reps: p.reps ?? null,
      repsText: p.repsText ?? null,
      isWarmup: !!p.isWarmup,
      durationS: p.durationS ?? null,
      distanceM: p.distanceM ?? null,
      tempo: p.tempo ?? null,
      restS: p.restS ?? null,
      loadType: load.type,
      targetLoad: null,
      targetUnit: null,
      loadMethod: null,
      maxUsed: null,
      loadWarning: null,
      progressionApplied: null,
    };
    if (load.type === "absolute") {
      let value = load.value;
      const unit = load.unit;
      if (prog && prog.unit !== "percent") {
        const step = convertLoad(prog.perWeek, prog.unit, unit) * weekOffset;
        value += step;
        g.progressionApplied = `+${prog.perWeek * weekOffset} ${prog.unit}${prog.unit !== unit ? ` (converted at ${KG_PER_LB} kg/lb)` : ""} for week offset ${weekOffset}`;
      } else if (prog && prog.unit === "percent") {
        value *= 1 + (prog.perWeek * weekOffset) / 100;
        g.progressionApplied = `+${prog.perWeek * weekOffset}% for week offset ${weekOffset}`;
      }
      g.targetLoad = roundToIncrement(value, settings.increment[unit]);
      g.targetUnit = unit;
      g.loadMethod = `Prescribed ${load.value} ${unit}${g.progressionApplied ? `, ${g.progressionApplied}` : ""}, rounded to ${settings.increment[unit]} ${unit}`;
    } else if (load.type === "percent_max") {
      let percent = load.percent;
      if (prog && prog.unit === "percent") {
        percent += prog.perWeek * weekOffset;
        g.progressionApplied = `+${prog.perWeek * weekOffset} percentage points for week offset ${weekOffset}`;
      } else if (prog) {
        g.addLoad = { value: prog.perWeek * weekOffset, unit: prog.unit as LoadUnit };
        g.progressionApplied = `+${prog.perWeek * weekOffset} ${prog.unit} for week offset ${weekOffset}`;
      }
      g.percent = percent;
      g.maxExerciseId = maxExerciseFor(exercise, load);
      g.maxExerciseName = g.maxExerciseId === exercise.id ? exercise.name : args.maxExerciseName?.(g.maxExerciseId) ?? null;
      applyPercentLoad(g, maxIndex.asOf(athleteId, g.maxExerciseId, date), date, settings);
    } else if (load.type === "rpe") {
      g.rpe = load.rpe;
      g.loadMethod = `Autoregulated: RPE ${load.rpe}`;
    } else if (load.type === "rir") {
      g.rir = load.rir;
      g.loadMethod = `Autoregulated: ${load.rir} reps in reserve`;
    } else if (load.type === "bodyweight") {
      g.loadMethod = "Bodyweight";
    }
    return g;
  });
}

/**
 * (Re)compute a %-of-max set group from a max. Used at instantiation and when a newer
 * max is recorded before an unstarted workout's date. Load is expressed in the max's unit.
 */
export function applyPercentLoad(g: ResolvedSetGroup, m: Pick<MaxLite, "id" | "exerciseId" | "value" | "unit" | "method" | "kind" | "recordedOn"> | null, date: string, settings: TrainingSettings) {
  if (g.loadType !== "percent_max" || g.percent == null) return g;
  if (!m) {
    g.targetLoad = null;
    g.targetUnit = null;
    g.maxUsed = null;
    g.loadMethod = null;
    g.loadWarning = `No ${g.maxExerciseName ?? "max"} recorded on or before ${date}; load not computed.`;
    return g;
  }
  const unit = m.unit as LoadUnit;
  const inc = settings.increment[unit];
  let note = "";
  let value = (m.value * g.percent) / 100;
  if (g.addLoad && g.addLoad.value) {
    value += convertLoad(g.addLoad.value, g.addLoad.unit, unit);
    note = `, ${g.addLoad.value >= 0 ? "+" : ""}${g.addLoad.value} ${g.addLoad.unit} progression${g.addLoad.unit !== unit ? ` (converted at ${KG_PER_LB} kg/lb)` : ""}`;
  } else if (g.progressionApplied) {
    note = `, ${g.progressionApplied}`;
  }
  g.targetLoad = g.addLoad?.value ? roundToIncrement(value, inc) : percentLoad(m.value, g.percent, inc);
  g.targetUnit = unit;
  g.loadWarning = null;
  g.maxUsed = { maxId: m.id, exerciseId: m.exerciseId, value: m.value, unit, method: m.method, kind: m.kind, recordedOn: m.recordedOn };
  g.loadMethod = `${g.percent}% of${g.maxExerciseName ? ` ${g.maxExerciseName}` : ""} max ${m.value} ${unit} (${m.kind}${m.method !== m.kind ? ` ${m.method}` : ""}, ${m.recordedOn})${note}, rounded to ${inc} ${unit}`;
  return g;
}
