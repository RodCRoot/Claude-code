import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  coachAssignments,
  exercises,
  groupMembers,
  groups,
  programAssignments,
  programDays,
  programItems,
  programPhases,
  programs,
  setLogs,
  workoutItems,
  workouts,
} from "@/db/schema";
import { AuthzError, assertCan, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { isoWeekday, addDaysYmd, todayLocal } from "@/lib/time";
import { actor, athleteNames, trainingSettings, TrainingError } from "./common";
import { applyPercentLoad, MaxIndex, resolveSetGroups } from "./loads";
import { phaseStartWeeks } from "./programs";
import type { ResolvedSetGroup } from "./formulas";

/** Group ids a coach is assigned to (owner/admin: all groups in org). */
export async function manageableGroupIds(tx: Tx, v: Viewer): Promise<string[] | "all"> {
  if (v.role === "owner" || v.role === "admin" || v.role === "operations") return "all";
  if (v.role !== "coach") return [];
  const d = todayLocal();
  const rows = await tx
    .select({ id: coachAssignments.groupId })
    .from(coachAssignments)
    .where(
      and(
        eq(coachAssignments.coachUserId, v.userId),
        eq(coachAssignments.orgId, v.orgId),
        isNotNull(coachAssignments.groupId),
        sql`(${coachAssignments.startsOn} is null or ${coachAssignments.startsOn} <= ${d})`,
        sql`(${coachAssignments.endsOn} is null or ${coachAssignments.endsOn} >= ${d})`,
      ),
    );
  return [...new Set(rows.map((r) => r.id!))];
}

export async function groupsForViewer(tx: Tx, v: Viewer) {
  const ids = await manageableGroupIds(tx, v);
  if (ids !== "all" && !ids.length) return [];
  return tx
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.orgId, v.orgId), eq(groups.active, true), ids === "all" ? undefined : inArray(groups.id, ids)))
    .orderBy(asc(groups.name));
}

/**
 * Map program days (ordered by week, day) onto calendar dates: each program week starts on
 * the Monday of (start week + n); its k-th day lands on the k-th selected weekday of that
 * week that is on/after the start date. Days that don't fit the selected weekdays spill to
 * the next selected weekday (never earlier than the previous day's date).
 */
export function scheduleDates(startDate: string, daysOfWeek: number[], days: { id: string; week: number; dayIndex: number }[]): Map<string, string> {
  const dow = [...new Set(daysOfWeek)].filter((d) => d >= 1 && d <= 7).sort();
  if (!dow.length) throw new TrainingError("Pick at least one training day of the week.");
  const monday0 = addDaysYmd(startDate, -(isoWeekday(startDate) - 1));
  const out = new Map<string, string>();
  const sorted = [...days].sort((a, b) => a.week - b.week || a.dayIndex - b.dayIndex);
  let last = addDaysYmd(startDate, -1);
  const byWeek = new Map<number, typeof sorted>();
  for (const d of sorted) byWeek.set(d.week, [...(byWeek.get(d.week) ?? []), d]);
  for (const [week, list] of byWeek) {
    const monday = addDaysYmd(monday0, (week - 1) * 7);
    let cursor = monday > last ? addDaysYmd(monday, -1) : last;
    for (const d of list) {
      // next selected weekday strictly after cursor and on/after startDate
      let date = addDaysYmd(cursor, 1);
      while (!dow.includes(isoWeekday(date)) || date < startDate) date = addDaysYmd(date, 1);
      out.set(d.id, date);
      cursor = date;
      last = date;
    }
  }
  return out;
}

/**
 * Instantiate frozen workouts for an assignment. Idempotent: the unique key
 * (assignment, athlete, program_day) makes re-runs insert only what's missing.
 * Internal (no authorization) — callers authorize first. Used by the seed too.
 */
export async function instantiateAssignment(
  tx: Tx,
  orgId: string,
  assignmentId: string,
  opts: { fromDate?: string; athleteIds?: string[]; isDemo?: boolean } = {},
): Promise<{ created: number }> {
  const [a] = await tx.select().from(programAssignments).where(and(eq(programAssignments.id, assignmentId), eq(programAssignments.orgId, orgId)));
  if (!a) throw new TrainingError("Assignment not found.");
  if (a.status !== "active") return { created: 0 };
  let athleteIds: string[] = a.athleteId ? [a.athleteId] : [];
  if (a.groupId) {
    const m = await tx.select({ id: groupMembers.athleteId }).from(groupMembers).where(eq(groupMembers.groupId, a.groupId));
    athleteIds = m.map((r) => r.id);
  }
  if (opts.athleteIds) athleteIds = athleteIds.filter((id) => opts.athleteIds!.includes(id));
  if (!athleteIds.length) return { created: 0 };

  const phases = await tx.select().from(programPhases).where(eq(programPhases.programId, a.programId));
  const starts = phaseStartWeeks(phases);
  const days = await tx.select().from(programDays).where(eq(programDays.programId, a.programId));
  if (!days.length) return { created: 0 };
  const items = await tx.select().from(programItems).where(inArray(programItems.dayId, days.map((d) => d.id))).orderBy(asc(programItems.sortOrder));
  const exRows = await tx.select().from(exercises).where(eq(exercises.orgId, orgId));
  const exMap = new Map(exRows.map((e) => [e.id, e]));
  const dates = scheduleDates(a.startDate, a.daysOfWeek, days);
  const settings = await trainingSettings(tx, orgId);
  const maxIndex = await MaxIndex.load(tx, orgId, athleteIds);

  let created = 0;
  for (const day of days) {
    const date = dates.get(day.id)!;
    if (opts.fromDate && date < opts.fromDate) continue;
    const weekOffset = day.phaseId && starts.has(day.phaseId) ? Math.max(0, day.week - starts.get(day.phaseId)!) : day.week - 1;
    const dayItems = items.filter((i) => i.dayId === day.id);
    const rows = athleteIds.map((athleteId) => ({
      orgId,
      athleteId,
      assignmentId,
      programDayId: day.id,
      scheduledDate: date,
      title: day.title,
      isDemo: !!opts.isDemo,
    }));
    const inserted = await tx.insert(workouts).values(rows).onConflictDoNothing().returning({ id: workouts.id, athleteId: workouts.athleteId });
    if (!inserted.length || !dayItems.length) {
      created += inserted.length;
      continue;
    }
    const itemRows = inserted.flatMap((w) =>
      dayItems.map((it) => ({
        workoutId: w.id,
        sortOrder: it.sortOrder,
        exerciseId: it.exerciseId,
        blockLabel: it.blockLabel,
        notes: it.notes,
        prescription: resolveSetGroups({
          athleteId: w.athleteId,
          exercise: exMap.get(it.exerciseId)!,
          maxExerciseName: (id) => exMap.get(id)?.name,
          prescription: it.prescription,
          progression: it.progression,
          weekOffset,
          date,
          settings,
          maxIndex,
        }) as unknown as Record<string, unknown>[],
      })),
    );
    await tx.insert(workoutItems).values(itemRows);
    created += inserted.length;
  }
  return { created };
}

const assignInput = z
  .object({
    programId: z.string().uuid(),
    athleteId: z.string().uuid().nullable().optional(),
    groupId: z.string().uuid().nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one weekday"),
  })
  .refine((x) => !!x.athleteId !== !!x.groupId, "Assign to exactly one athlete or one group");

async function authorizeTarget(tx: Tx, v: Viewer, athleteId?: string | null, groupId?: string | null) {
  assertCan(v, "training.manage");
  if (athleteId) await requireOnAthlete(tx, v, athleteId, "training.write");
  if (groupId) {
    const [g] = await tx.select().from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, v.orgId)));
    if (!g) throw new TrainingError("Group not found.");
    const ok = await manageableGroupIds(tx, v);
    if (ok !== "all" && !ok.includes(groupId)) throw new AuthzError("You can only assign programs to groups you coach.");
  }
}

export async function assignProgram(tx: Tx, v: Viewer, raw: z.input<typeof assignInput>) {
  const input = assignInput.parse(raw);
  await authorizeTarget(tx, v, input.athleteId, input.groupId);
  const [p] = await tx.select().from(programs).where(and(eq(programs.id, input.programId), eq(programs.orgId, v.orgId)));
  if (!p) throw new TrainingError("Program not found.");
  if (p.status === "archived") throw new TrainingError("Archived programs can't be assigned. Set it back to active first.");
  const [a] = await tx
    .insert(programAssignments)
    .values({
      orgId: v.orgId,
      programId: p.id,
      programVersion: p.currentVersion,
      athleteId: input.athleteId ?? null,
      groupId: input.groupId ?? null,
      startDate: input.startDate,
      daysOfWeek: [...new Set(input.daysOfWeek)].sort(),
      assignedBy: v.userId,
    })
    .returning();
  const { created } = await instantiateAssignment(tx, v.orgId, a.id);
  await audit(tx, actor(v), "training.assignment.create", "program_assignment", a.id, {
    summary: `Assigned ${p.name} v${p.currentVersion} (${created} workouts)`,
    after: { ...input, programVersion: p.currentVersion },
  });
  return { assignment: a, created };
}

async function assignmentFor(tx: Tx, v: Viewer, assignmentId: string) {
  const [a] = await tx.select().from(programAssignments).where(and(eq(programAssignments.id, assignmentId), eq(programAssignments.orgId, v.orgId)));
  if (!a) throw new TrainingError("Assignment not found.");
  await authorizeTarget(tx, v, a.athleteId, a.groupId);
  return a;
}

/** Re-run instantiation (e.g. after new group members join). Never changes existing workouts. */
export async function syncAssignment(tx: Tx, v: Viewer, assignmentId: string) {
  const a = await assignmentFor(tx, v, assignmentId);
  const { created } = await instantiateAssignment(tx, v.orgId, a.id, { fromDate: todayLocal() });
  await audit(tx, actor(v), "training.assignment.sync", "program_assignment", a.id, { summary: `Synced assignment (${created} new workouts)` });
  return created;
}

/**
 * Coach-chosen: rebuild workouts that are still unstarted (scheduled, no set logs, dated today or later)
 * from the current template version. Started/completed/past workouts stay frozen.
 */
export async function applyTemplateToUnstarted(tx: Tx, v: Viewer, assignmentId: string, today = todayLocal()) {
  const a = await assignmentFor(tx, v, assignmentId);
  const [p] = await tx.select().from(programs).where(eq(programs.id, a.programId));
  const candidates = await tx
    .select({ id: workouts.id })
    .from(workouts)
    .where(
      and(
        eq(workouts.assignmentId, a.id),
        eq(workouts.status, "scheduled"),
        gte(workouts.scheduledDate, today),
        sql`not exists (select 1 from ${workoutItems} wi join ${setLogs} sl on sl.workout_item_id = wi.id where wi.workout_id = ${workouts.id})`,
      ),
    );
  if (candidates.length) await tx.delete(workouts).where(inArray(workouts.id, candidates.map((c) => c.id)));
  await tx.update(programAssignments).set({ programVersion: p.currentVersion }).where(eq(programAssignments.id, a.id));
  const { created } = await instantiateAssignment(tx, v.orgId, a.id, { fromDate: today });
  await audit(tx, actor(v), "training.assignment.apply_template", "program_assignment", a.id, {
    summary: `Rebuilt ${candidates.length} unstarted workouts from v${p.currentVersion} (${created} created)`,
    before: { programVersion: a.programVersion },
    after: { programVersion: p.currentVersion },
  });
  return { removed: candidates.length, created };
}

export async function cancelAssignment(tx: Tx, v: Viewer, assignmentId: string, today = todayLocal()) {
  const a = await assignmentFor(tx, v, assignmentId);
  const removed = await tx
    .delete(workouts)
    .where(
      and(
        eq(workouts.assignmentId, a.id),
        eq(workouts.status, "scheduled"),
        gte(workouts.scheduledDate, today),
        sql`not exists (select 1 from ${workoutItems} wi join ${setLogs} sl on sl.workout_item_id = wi.id where wi.workout_id = ${workouts.id})`,
      ),
    )
    .returning({ id: workouts.id });
  await tx.update(programAssignments).set({ status: "cancelled" }).where(eq(programAssignments.id, a.id));
  await audit(tx, actor(v), "training.assignment.cancel", "program_assignment", a.id, { summary: `Cancelled assignment; removed ${removed.length} unstarted future workouts` });
  return removed.length;
}

export async function listAssignments(tx: Tx, v: Viewer, programId?: string) {
  assertCan(v, "training.manage");
  const rows = await tx
    .select({ a: programAssignments, programName: programs.name, currentVersion: programs.currentVersion, groupName: groups.name })
    .from(programAssignments)
    .innerJoin(programs, eq(programs.id, programAssignments.programId))
    .leftJoin(groups, eq(groups.id, programAssignments.groupId))
    .where(and(eq(programAssignments.orgId, v.orgId), programId ? eq(programAssignments.programId, programId) : undefined))
    .orderBy(desc(programAssignments.createdAt));
  const names = await athleteNames(tx, v.orgId, rows.flatMap((r) => (r.a.athleteId ? [r.a.athleteId] : [])));
  const groupsOk = await manageableGroupIds(tx, v);
  const visible: typeof rows = [];
  for (const r of rows) {
    if (r.a.groupId && (groupsOk === "all" || groupsOk.includes(r.a.groupId))) visible.push(r);
    else if (r.a.athleteId && names.has(r.a.athleteId)) {
      try {
        await requireOnAthlete(tx, v, r.a.athleteId, "training.read");
        visible.push(r);
      } catch {
        /* out of scope */
      }
    }
  }
  return visible.map((r) => ({ ...r.a, programName: r.programName, currentVersion: r.currentVersion, target: r.groupName ?? names.get(r.a.athleteId!) ?? "—" }));
}

/**
 * After a new max is recorded, recompute %-based loads on that athlete's unstarted workouts
 * dated on/after the max date, so each uses the latest max as of its own date.
 */
export async function refreshUnstartedLoads(tx: Tx, orgId: string, athleteId: string, fromDate: string, auditActor?: AuditActor) {
  const ws = await tx
    .select({ id: workouts.id, date: workouts.scheduledDate })
    .from(workouts)
    .where(
      and(
        eq(workouts.orgId, orgId),
        eq(workouts.athleteId, athleteId),
        eq(workouts.status, "scheduled"),
        gte(workouts.scheduledDate, fromDate),
        sql`not exists (select 1 from ${workoutItems} wi join ${setLogs} sl on sl.workout_item_id = wi.id where wi.workout_id = ${workouts.id})`,
      ),
    );
  if (!ws.length) return 0;
  const dateOf = new Map(ws.map((w) => [w.id, w.date]));
  const items = await tx.select().from(workoutItems).where(inArray(workoutItems.workoutId, ws.map((w) => w.id)));
  const settings = await trainingSettings(tx, orgId);
  const idx = await MaxIndex.load(tx, orgId, [athleteId]);
  let changed = 0;
  for (const it of items) {
    const groupsArr = it.prescription as unknown as ResolvedSetGroup[];
    if (!groupsArr.some((g) => g.loadType === "percent_max" && g.maxExerciseId)) continue;
    const date = dateOf.get(it.workoutId)!;
    const before = JSON.stringify(groupsArr);
    for (const g of groupsArr) if (g.loadType === "percent_max" && g.maxExerciseId) applyPercentLoad(g, idx.asOf(athleteId, g.maxExerciseId, date), date, settings);
    if (JSON.stringify(groupsArr) !== before) {
      await tx.update(workoutItems).set({ prescription: groupsArr as unknown as Record<string, unknown>[] }).where(eq(workoutItems.id, it.id));
      changed++;
    }
  }
  if (changed && auditActor) await audit(tx, auditActor, "training.workout.loads_refreshed", "athlete", athleteId, { summary: `Recomputed % loads on ${changed} unstarted workout items from ${fromDate}` });
  return changed;
}
