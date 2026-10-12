import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { exercises, programAssignments, programDays, programItems, programPhases, programs, type SetPrescription } from "@/db/schema";
import { assertCan, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actor, TrainingError } from "./common";
import { groupsFromLabels, normalizeDay } from "./program-layout";

export type Program = typeof programs.$inferSelect;
export type ProgramPhase = typeof programPhases.$inferSelect;
export type ProgramDay = typeof programDays.$inferSelect;
export type ProgramItem = typeof programItems.$inferSelect;

export async function listPrograms(tx: Tx, v: Viewer) {
  if (!isStaff(v)) throw new AuthzError();
  const rows = await tx.select().from(programs).where(eq(programs.orgId, v.orgId)).orderBy(asc(programs.status), desc(programs.updatedAt));
  const counts = rows.length
    ? await tx
        .select({ programId: programAssignments.programId, n: sql<number>`count(*)::int` })
        .from(programAssignments)
        .where(and(inArray(programAssignments.programId, rows.map((r) => r.id)), eq(programAssignments.status, "active")))
        .groupBy(programAssignments.programId)
    : [];
  const byId = new Map(counts.map((c) => [c.programId, c.n]));
  return rows.map((r) => ({ ...r, activeAssignments: byId.get(r.id) ?? 0 }));
}

async function programFor(tx: Tx, v: Viewer, programId: string, manage = true): Promise<Program> {
  if (manage) assertCan(v, "training.manage");
  else if (!isStaff(v)) throw new AuthzError();
  const [p] = await tx.select().from(programs).where(and(eq(programs.id, programId), eq(programs.orgId, v.orgId)));
  if (!p) throw new TrainingError("Program not found.");
  return p;
}

/** Structural edits bump the version; existing workouts are frozen snapshots and are not touched. */
async function bump(tx: Tx, programId: string) {
  const [p] = await tx
    .update(programs)
    .set({ currentVersion: sql`${programs.currentVersion} + 1`, updatedAt: new Date() })
    .where(eq(programs.id, programId))
    .returning({ v: programs.currentVersion });
  return p.v;
}

/** 1-based program week at which each phase begins (phases run back-to-back in sort order). */
export function phaseStartWeeks(phases: Pick<ProgramPhase, "id" | "weeks" | "sortOrder">[]): Map<string, number> {
  const m = new Map<string, number>();
  let w = 1;
  for (const p of [...phases].sort((a, b) => a.sortOrder - b.sortOrder)) {
    m.set(p.id, w);
    w += p.weeks;
  }
  return m;
}

export async function programTree(tx: Tx, v: Viewer, programId: string) {
  const program = await programFor(tx, v, programId, false);
  const phases = await tx.select().from(programPhases).where(eq(programPhases.programId, programId)).orderBy(asc(programPhases.sortOrder));
  const days = await tx.select().from(programDays).where(eq(programDays.programId, programId)).orderBy(asc(programDays.week), asc(programDays.dayIndex));
  const items = days.length
    ? await tx.select().from(programItems).where(inArray(programItems.dayId, days.map((d) => d.id))).orderBy(asc(programItems.sortOrder))
    : [];
  const exIds = [...new Set(items.map((i) => i.exerciseId))];
  const exRows = exIds.length ? await tx.select().from(exercises).where(inArray(exercises.id, exIds)) : [];
  const exMap = new Map(exRows.map((e) => [e.id, e]));
  return {
    program,
    phases,
    phaseStart: phaseStartWeeks(phases),
    days: days.map((d) => ({ ...d, items: items.filter((i) => i.dayId === d.id).map((i) => ({ ...i, exercise: exMap.get(i.exerciseId)! })) })),
  };
}

const meta = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  sport: z.string().trim().max(60).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
});

export async function createProgram(tx: Tx, v: Viewer, raw: z.input<typeof meta>) {
  assertCan(v, "training.manage");
  const input = meta.parse(raw);
  const [p] = await tx.insert(programs).values({ orgId: v.orgId, ...input, createdBy: v.userId }).returning();
  await audit(tx, actor(v), "training.program.create", "program", p.id, { summary: `Created program ${p.name}` });
  return p;
}

export async function updateProgramMeta(tx: Tx, v: Viewer, programId: string, raw: z.input<typeof meta>) {
  const before = await programFor(tx, v, programId);
  const input = meta.parse(raw);
  await tx.update(programs).set({ ...input, updatedAt: new Date() }).where(eq(programs.id, programId));
  await audit(tx, actor(v), "training.program.update", "program", programId, { summary: `Updated program details`, before: { name: before.name, status: before.status }, after: input });
}

const phaseInput = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(300).nullable().optional(),
  weeks: z.number().int().min(1).max(52),
});

export async function addPhase(tx: Tx, v: Viewer, programId: string, raw: z.input<typeof phaseInput>) {
  await programFor(tx, v, programId);
  const input = phaseInput.parse(raw);
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${programPhases.sortOrder}), -1)::int + 1` }).from(programPhases).where(eq(programPhases.programId, programId));
  const [ph] = await tx.insert(programPhases).values({ programId, ...input, sortOrder: n }).returning();
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.phase_add", "program", programId, { summary: `Added phase ${ph.name} (v${ver})`, after: input });
  return ph;
}

export async function updatePhase(tx: Tx, v: Viewer, programId: string, phaseId: string, raw: z.input<typeof phaseInput>) {
  await programFor(tx, v, programId);
  const input = phaseInput.parse(raw);
  const r = await tx.update(programPhases).set(input).where(and(eq(programPhases.id, phaseId), eq(programPhases.programId, programId))).returning();
  if (!r.length) throw new TrainingError("Phase not found.");
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.phase_update", "program", programId, { summary: `Updated phase ${input.name} (v${ver})`, after: input });
}

export async function deletePhase(tx: Tx, v: Viewer, programId: string, phaseId: string) {
  await programFor(tx, v, programId);
  const r = await tx.delete(programPhases).where(and(eq(programPhases.id, phaseId), eq(programPhases.programId, programId))).returning();
  if (!r.length) throw new TrainingError("Phase not found.");
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.phase_delete", "program", programId, { summary: `Deleted phase ${r[0].name} (v${ver}); its days were kept unassigned` });
}

const dayInput = z.object({
  week: z.number().int().min(1).max(104),
  dayIndex: z.number().int().min(1).max(7),
  title: z.string().trim().min(1).max(80),
  phaseId: z.string().uuid().nullable().optional(),
});

export async function addDay(tx: Tx, v: Viewer, programId: string, raw: z.input<typeof dayInput>) {
  await programFor(tx, v, programId);
  const input = dayInput.parse(raw);
  if (input.phaseId) {
    const [ph] = await tx.select().from(programPhases).where(and(eq(programPhases.id, input.phaseId), eq(programPhases.programId, programId)));
    if (!ph) throw new TrainingError("Phase not found.");
  }
  const dup = await tx.select({ id: programDays.id }).from(programDays).where(and(eq(programDays.programId, programId), eq(programDays.week, input.week), eq(programDays.dayIndex, input.dayIndex)));
  if (dup.length) throw new TrainingError(`Week ${input.week} already has a day ${input.dayIndex}.`);
  const [d] = await tx.insert(programDays).values({ programId, ...input, phaseId: input.phaseId ?? null }).returning();
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.day_add", "program", programId, { summary: `Added W${d.week}D${d.dayIndex} ${d.title} (v${ver})` });
  return d;
}

export async function deleteDay(tx: Tx, v: Viewer, programId: string, dayId: string) {
  await programFor(tx, v, programId);
  const r = await tx.delete(programDays).where(and(eq(programDays.id, dayId), eq(programDays.programId, programId))).returning();
  if (!r.length) throw new TrainingError("Day not found.");
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.day_delete", "program", programId, { summary: `Deleted W${r[0].week}D${r[0].dayIndex} (v${ver})` });
}

/** Copy every day (and its items) of one week into other weeks that are still empty. */
export async function copyWeek(tx: Tx, v: Viewer, programId: string, fromWeek: number, toWeeks: number[]) {
  await programFor(tx, v, programId);
  const src = await tx.select().from(programDays).where(and(eq(programDays.programId, programId), eq(programDays.week, fromWeek)));
  if (!src.length) throw new TrainingError(`Week ${fromWeek} has no days to copy.`);
  const srcItems = await tx.select().from(programItems).where(inArray(programItems.dayId, src.map((d) => d.id)));
  const existing = await tx.select({ week: programDays.week }).from(programDays).where(eq(programDays.programId, programId));
  const taken = new Set(existing.map((e) => e.week));
  const phases = await tx.select().from(programPhases).where(eq(programPhases.programId, programId));
  const starts = phaseStartWeeks(phases);
  const phaseOfWeek = (w: number) => {
    for (const p of phases) {
      const s = starts.get(p.id)!;
      if (w >= s && w < s + p.weeks) return p.id;
    }
    return null;
  };
  const copied: number[] = [];
  for (const w of [...new Set(toWeeks)].filter((w) => w !== fromWeek && w >= 1 && w <= 104)) {
    if (taken.has(w)) continue;
    for (const d of src) {
      const [nd] = await tx.insert(programDays).values({ programId, week: w, dayIndex: d.dayIndex, title: d.title, phaseId: phaseOfWeek(w) ?? d.phaseId }).returning();
      const its = srcItems.filter((i) => i.dayId === d.id);
      if (its.length) {
        await tx.insert(programItems).values(its.map((i) => ({ dayId: nd.id, sortOrder: i.sortOrder, exerciseId: i.exerciseId, blockLabel: i.blockLabel, blockType: i.blockType, prescription: i.prescription, progression: i.progression, notes: i.notes })));
      }
    }
    copied.push(w);
  }
  if (!copied.length) throw new TrainingError("All target weeks already have days; nothing copied.");
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.copy_week", "program", programId, { summary: `Copied week ${fromWeek} to weeks ${copied.join(", ")} (v${ver})` });
  return copied;
}

const loadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("absolute"), value: z.number().positive().max(2000), unit: z.enum(["lb", "kg"]) }),
  z.object({ type: z.literal("percent_max"), percent: z.number().positive().max(150), maxExerciseId: z.string().uuid().optional() }),
  z.object({ type: z.literal("rpe"), rpe: z.number().min(1).max(10) }),
  z.object({ type: z.literal("rir"), rir: z.number().int().min(0).max(10) }),
  z.object({ type: z.literal("bodyweight") }),
  z.object({ type: z.literal("none") }),
]);

export const setPrescriptionSchema = z
  .object({
    sets: z.number().int().min(1).max(20),
    reps: z.number().int().min(1).max(200).optional(),
    repsText: z.string().trim().max(40).optional(),
    load: loadSchema.optional(),
    durationS: z.number().positive().max(36000).optional(),
    distanceM: z.number().positive().max(100000).optional(),
    tempo: z.string().trim().max(20).optional(),
    restS: z.number().int().min(0).max(3600).optional(),
    isWarmup: z.boolean().optional(),
  })
  .refine((p) => p.reps != null || !!p.repsText || p.durationS != null || p.distanceM != null, "Each set group needs reps, rep text, duration or distance");

export const itemInput = z.object({
  exerciseId: z.string().uuid(),
  blockLabel: z.string().trim().regex(/^[A-Z][0-9]{0,2}$/, "Use a block label like A, A1, B2, C3"),
  blockType: z.enum(["straight", "superset", "circuit"]).default("straight"),
  prescription: z.array(setPrescriptionSchema).min(1).max(8),
  progression: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("linear_load"), perWeek: z.number().min(-50).max(50), unit: z.enum(["lb", "kg", "percent"]) }),
    ])
    .default({ kind: "none" }),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type ItemInput = z.input<typeof itemInput>;

async function dayOf(tx: Tx, programId: string, dayId: string) {
  const [d] = await tx.select().from(programDays).where(and(eq(programDays.id, dayId), eq(programDays.programId, programId)));
  if (!d) throw new TrainingError("Day not found.");
  return d;
}

async function checkExercise(tx: Tx, orgId: string, ids: string[]) {
  const uniq = [...new Set(ids)];
  const rows = await tx.select({ id: exercises.id }).from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.id, uniq)));
  if (rows.length !== uniq.length) throw new TrainingError("Exercise not found.");
}

function maxRefs(p: SetPrescription[]) {
  return p.flatMap((s) => (s.load?.type === "percent_max" && s.load.maxExerciseId ? [s.load.maxExerciseId] : []));
}

export async function addItem(tx: Tx, v: Viewer, programId: string, dayId: string, raw: ItemInput) {
  await programFor(tx, v, programId);
  await dayOf(tx, programId, dayId);
  const input = itemInput.parse(raw);
  await checkExercise(tx, v.orgId, [input.exerciseId, ...maxRefs(input.prescription)]);
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${programItems.sortOrder}), -1)::int + 1` }).from(programItems).where(eq(programItems.dayId, dayId));
  const [it] = await tx.insert(programItems).values({ dayId, sortOrder: n, ...input, notes: input.notes ?? null }).returning();
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.item_add", "program", programId, { summary: `Added item ${it.blockLabel} (v${ver})`, after: input });
  return it;
}

export async function updateItem(tx: Tx, v: Viewer, programId: string, itemId: string, raw: ItemInput) {
  await programFor(tx, v, programId);
  const input = itemInput.parse(raw);
  const [cur] = await tx
    .select({ item: programItems })
    .from(programItems)
    .innerJoin(programDays, eq(programDays.id, programItems.dayId))
    .where(and(eq(programItems.id, itemId), eq(programDays.programId, programId)));
  if (!cur) throw new TrainingError("Item not found.");
  await checkExercise(tx, v.orgId, [input.exerciseId, ...maxRefs(input.prescription)]);
  await tx.update(programItems).set({ ...input, notes: input.notes ?? null }).where(eq(programItems.id, itemId));
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.item_update", "program", programId, { summary: `Updated item ${input.blockLabel} (v${ver})`, before: cur.item, after: input });
}

export async function deleteItem(tx: Tx, v: Viewer, programId: string, itemId: string) {
  await programFor(tx, v, programId);
  const [cur] = await tx
    .select({ id: programItems.id, label: programItems.blockLabel })
    .from(programItems)
    .innerJoin(programDays, eq(programDays.id, programItems.dayId))
    .where(and(eq(programItems.id, itemId), eq(programDays.programId, programId)));
  if (!cur) throw new TrainingError("Item not found.");
  await tx.delete(programItems).where(eq(programItems.id, itemId));
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.item_delete", "program", programId, { summary: `Deleted item ${cur.label} (v${ver})` });
}

/** Deep copy of a program (phases, days, items) as a new draft at version 1. */
export async function duplicateProgram(tx: Tx, v: Viewer, programId: string, name?: string) {
  const src = await programFor(tx, v, programId);
  const [p] = await tx
    .insert(programs)
    .values({ orgId: v.orgId, name: name?.trim() || `${src.name} (copy)`, description: src.description, sport: src.sport, status: "draft", createdBy: v.userId })
    .returning();
  const phases = await tx.select().from(programPhases).where(eq(programPhases.programId, programId));
  const phaseMap = new Map<string, string>();
  for (const ph of phases) {
    const [n] = await tx.insert(programPhases).values({ programId: p.id, name: ph.name, goal: ph.goal, sortOrder: ph.sortOrder, weeks: ph.weeks }).returning();
    phaseMap.set(ph.id, n.id);
  }
  const days = await tx.select().from(programDays).where(eq(programDays.programId, programId));
  const items = days.length ? await tx.select().from(programItems).where(inArray(programItems.dayId, days.map((d) => d.id))) : [];
  for (const d of days) {
    const [nd] = await tx.insert(programDays).values({ programId: p.id, week: d.week, dayIndex: d.dayIndex, title: d.title, phaseId: d.phaseId ? phaseMap.get(d.phaseId) ?? null : null }).returning();
    const its = items.filter((i) => i.dayId === d.id);
    if (its.length) await tx.insert(programItems).values(its.map((i) => ({ dayId: nd.id, sortOrder: i.sortOrder, exerciseId: i.exerciseId, blockLabel: i.blockLabel, blockType: i.blockType, prescription: i.prescription, progression: i.progression, notes: i.notes })));
  }
  await audit(tx, actor(v), "training.program.duplicate", "program", p.id, { summary: `Duplicated from ${src.name}`, after: { sourceProgramId: programId } });
  return p;
}

// --- Builder: layout (drag-and-drop / keyboard reorder), copy day, bulk set-scheme edit ----------

/** Lock the program row and check the client's version (optimistic concurrency for the builder). */
async function lockProgramVersion(tx: Tx, programId: string, expectedVersion: number | undefined) {
  const [row] = await tx.select({ v: programs.currentVersion }).from(programs).where(eq(programs.id, programId)).for("update");
  const current = row?.v ?? 0;
  if (expectedVersion != null && current !== expectedVersion) {
    throw new TrainingError(`This program changed since you loaded it (now v${current}). Reload to see the latest version, then try again.`);
  }
  return current;
}

const layoutInput = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  days: z
    .array(
      z.object({
        dayId: z.string().uuid(),
        items: z.array(z.object({ id: z.string().uuid(), group: z.string().min(1).max(100) })).max(60),
      }),
    )
    .min(1)
    .max(14),
});
export type LayoutInput = z.input<typeof layoutInput>;

/**
 * Persist item order / day / block membership for one or more days atomically.
 * - The listed days must belong to the program, and together list exactly the items they hold now
 *   (an item may move between listed days; nothing may be dropped, duplicated or pulled in from
 *   elsewhere).
 * - Labels and block types are recomputed server-side (`normalizeDay`); client labels are ignored.
 * - The program row is locked and the version checked; one successful save bumps the version once.
 * Assigned workouts are frozen snapshots and are never touched.
 */
export async function saveProgramLayout(tx: Tx, v: Viewer, programId: string, raw: LayoutInput) {
  await programFor(tx, v, programId);
  const input = layoutInput.parse(raw);
  const current = await lockProgramVersion(tx, programId, input.expectedVersion);
  const dayIds = input.days.map((d) => d.dayId);
  if (new Set(dayIds).size !== dayIds.length) throw new TrainingError("A day is listed twice.");
  const days = await tx.select().from(programDays).where(and(eq(programDays.programId, programId), inArray(programDays.id, dayIds)));
  if (days.length !== dayIds.length) throw new TrainingError("Day not found.");
  const existing = await tx.select().from(programItems).where(inArray(programItems.dayId, dayIds));
  const byId = new Map(existing.map((i) => [i.id, i]));
  const sent = input.days.flatMap((d) => d.items.map((i) => i.id));
  if (new Set(sent).size !== sent.length) throw new TrainingError("An exercise is listed twice.");
  if (sent.length !== existing.length || sent.some((id) => !byId.has(id))) {
    throw new TrainingError("The days changed since you loaded them (an exercise was added or removed). Reload and try again.");
  }

  const updates: { id: string; dayId: string; sortOrder: number; blockLabel: string; blockType: "straight" | "superset" | "circuit" }[] = [];
  for (const d of input.days) {
    for (const n of normalizeOrFail(d.items.map((i) => ({ id: i.id, group: i.group, blockType: byId.get(i.id)!.blockType })))) {
      const cur = byId.get(n.id)!;
      if (cur.dayId !== d.dayId || cur.sortOrder !== n.sortOrder || cur.blockLabel !== n.blockLabel || cur.blockType !== n.blockType) {
        updates.push({ ...n, dayId: d.dayId });
      }
    }
  }
  if (!updates.length) return { version: current, changed: 0 };
  for (const u of updates) {
    await tx.update(programItems).set({ dayId: u.dayId, sortOrder: u.sortOrder, blockLabel: u.blockLabel, blockType: u.blockType }).where(eq(programItems.id, u.id));
  }
  const ver = await bump(tx, programId);
  const dayName = (id: string) => {
    const d = days.find((x) => x.id === id)!;
    return `W${d.week}D${d.dayIndex}`;
  };
  const moved = updates.filter((u) => byId.get(u.id)!.dayId !== u.dayId).length;
  await audit(tx, actor(v), "training.program.layout", "program", programId, {
    summary: `Reordered ${dayIds.map(dayName).join(", ")}${moved ? ` (${moved} moved between days)` : ""} (v${ver})`,
    before: { items: updates.map((u) => ({ id: u.id, dayId: byId.get(u.id)!.dayId, sortOrder: byId.get(u.id)!.sortOrder, blockLabel: byId.get(u.id)!.blockLabel })) },
    after: { items: updates.map((u) => ({ id: u.id, dayId: u.dayId, sortOrder: u.sortOrder, blockLabel: u.blockLabel })) },
  });
  return { version: ver, changed: updates.length };
}

function normalizeOrFail(items: Parameters<typeof normalizeDay>[0]) {
  try {
    return normalizeDay(items);
  } catch (e) {
    throw new TrainingError((e as Error).message);
  }
}

const copyDayInput = z.object({
  week: z.number().int().min(1).max(104),
  dayIndex: z.number().int().min(1).max(7),
  title: z.string().trim().max(80).nullable().optional(),
});

/**
 * Copy one day's items into another slot. An empty slot gets a new day (phase follows the target
 * week); an existing day gets the copies appended as new blocks after its own.
 */
export async function copyDay(tx: Tx, v: Viewer, programId: string, dayId: string, raw: z.input<typeof copyDayInput>) {
  await programFor(tx, v, programId);
  const input = copyDayInput.parse(raw);
  await lockProgramVersion(tx, programId, undefined);
  const src = await dayOf(tx, programId, dayId);
  if (src.week === input.week && src.dayIndex === input.dayIndex) throw new TrainingError("Pick a different week or day to copy into.");
  const srcItems = await tx.select().from(programItems).where(eq(programItems.dayId, src.id)).orderBy(asc(programItems.sortOrder));
  if (!srcItems.length) throw new TrainingError("That day has no exercises to copy.");
  let [targetDay] = await tx.select().from(programDays).where(and(eq(programDays.programId, programId), eq(programDays.week, input.week), eq(programDays.dayIndex, input.dayIndex)));
  const created = !targetDay;
  if (!targetDay) {
    const phases = await tx.select().from(programPhases).where(eq(programPhases.programId, programId));
    const starts = phaseStartWeeks(phases);
    const phase = phases.find((p) => input.week >= starts.get(p.id)! && input.week < starts.get(p.id)! + p.weeks);
    [targetDay] = await tx
      .insert(programDays)
      .values({ programId, week: input.week, dayIndex: input.dayIndex, title: input.title || src.title, phaseId: phase?.id ?? src.phaseId })
      .returning();
  }
  const existing = created ? [] : await tx.select().from(programItems).where(eq(programItems.dayId, targetDay.id)).orderBy(asc(programItems.sortOrder));
  const inserted = await tx
    .insert(programItems)
    .values(srcItems.map((i, k) => ({ dayId: targetDay.id, sortOrder: existing.length + k, exerciseId: i.exerciseId, blockLabel: i.blockLabel, blockType: i.blockType, prescription: i.prescription, progression: i.progression, notes: i.notes })))
    .returning();
  // Re-letter the target day: its own blocks first, then the copied blocks.
  for (const n of normalizeOrFail([...groupsFromLabels("existing", existing), ...groupsFromLabels("copied", inserted)])) {
    await tx.update(programItems).set({ sortOrder: n.sortOrder, blockLabel: n.blockLabel, blockType: n.blockType }).where(eq(programItems.id, n.id));
  }
  const ver = await bump(tx, programId);
  await audit(tx, actor(v), "training.program.copy_day", "program", programId, {
    summary: `Copied W${src.week}D${src.dayIndex} ${created ? "to new day" : "into"} W${input.week}D${input.dayIndex} (${srcItems.length} exercises, v${ver})`,
  });
  return { dayId: targetDay.id, created, copied: srcItems.length, version: ver };
}

const schemePatch = z
  .object({
    sets: z.number().int().min(1).max(20).optional(),
    reps: z.number().int().min(1).max(200).optional(),
    repsText: z.string().trim().max(40).optional(),
    load: loadSchema.optional(),
    restS: z.number().int().min(0).max(3600).optional(),
    tempo: z.string().trim().max(20).optional(),
    /** "working" leaves warm-up set groups untouched. */
    applyTo: z.enum(["working", "all"]).default("working"),
  })
  .refine((p) => p.sets != null || p.reps != null || !!p.repsText || p.load != null || p.restS != null || !!p.tempo, "Enter at least one value to change.");
export type SchemePatch = z.input<typeof schemePatch>;

/** Apply one set-scheme change (sets / reps / load / rest / tempo) to many items at once; one version bump. */
export async function bulkEditScheme(tx: Tx, v: Viewer, programId: string, itemIds: string[], raw: SchemePatch) {
  await programFor(tx, v, programId);
  const patch = schemePatch.parse(raw);
  const ids = [...new Set(itemIds)];
  if (!ids.length) throw new TrainingError("Select at least one exercise.");
  if (ids.length > 200) throw new TrainingError("Too many exercises selected.");
  if (ids.some((id) => !z.string().uuid().safeParse(id).success)) throw new TrainingError("Exercise not found.");
  await lockProgramVersion(tx, programId, undefined);
  const rows = await tx
    .select({ item: programItems })
    .from(programItems)
    .innerJoin(programDays, eq(programDays.id, programItems.dayId))
    .where(and(eq(programDays.programId, programId), inArray(programItems.id, ids)));
  if (rows.length !== ids.length) throw new TrainingError("Exercise not found.");
  if (patch.load?.type === "percent_max" && patch.load.maxExerciseId) await checkExercise(tx, v.orgId, [patch.load.maxExerciseId]);
  for (const { item } of rows) {
    const prescription = item.prescription.map((g) => {
      if (patch.applyTo === "working" && g.isWarmup) return g;
      const n: SetPrescription = { ...g };
      if (patch.sets != null) n.sets = patch.sets;
      if (patch.reps != null) {
        n.reps = patch.reps;
        if (!patch.repsText) delete n.repsText;
      }
      if (patch.repsText) n.repsText = patch.repsText;
      if (patch.load) n.load = patch.load;
      if (patch.restS != null) n.restS = patch.restS;
      if (patch.tempo) n.tempo = patch.tempo;
      return n;
    });
    const checked = z.array(setPrescriptionSchema).min(1).max(8).safeParse(prescription);
    if (!checked.success) throw new TrainingError(`${item.blockLabel}: ${checked.error.issues[0]?.message ?? "invalid set scheme"}`);
    await tx.update(programItems).set({ prescription: checked.data as SetPrescription[] }).where(eq(programItems.id, item.id));
  }
  const ver = await bump(tx, programId);
  const { applyTo, ...changes } = patch;
  await audit(tx, actor(v), "training.program.bulk_scheme", "program", programId, {
    summary: `Bulk-edited set scheme on ${rows.length} exercises (${applyTo === "all" ? "all" : "working"} sets, v${ver})`,
    before: { items: rows.map((r) => ({ id: r.item.id, prescription: r.item.prescription })) },
    after: { itemIds: ids, changes },
  });
  return { updated: rows.length, version: ver };
}
