import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { groupMembers, groups, habitAssignments, habitCheckins, habits } from "@/db/schema";
import { assertCan, AuthzError, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { actorOf } from "./access";
import { expectedHabitDates, habitAdherence, habitStreak, resolveHabitStatuses, type AdherenceResult, type HabitStatus } from "./formulas";

export const habitInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  targetValue: z.coerce.number().positive().optional().nullable(),
  targetUnit: z.string().trim().max(20).optional().nullable(),
  frequency: z.enum(["daily", "weekdays", "weekly"]),
});

export async function createHabit(tx: Tx, v: Viewer, raw: z.input<typeof habitInput>) {
  assertCan(v, "science.manage");
  const input = habitInput.parse(raw);
  if (input.targetValue != null && !input.targetUnit) throw new UserError("A target value needs a unit.", { targetUnit: "Required with a target" });
  const [h] = await tx.insert(habits).values({ orgId: v.orgId, name: input.name, description: input.description || null, targetValue: input.targetValue ?? null, targetUnit: input.targetUnit || null, frequency: input.frequency, createdBy: v.userId }).returning();
  await audit(tx, actorOf(v), "science.habit.create", "habit", h.id, { summary: `Created habit "${h.name}"`, after: input });
  return h;
}

export const assignInput = z
  .object({
    habitId: z.string().uuid(),
    athleteId: z.string().uuid().optional().nullable(),
    groupId: z.string().uuid().optional().nullable(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  })
  .refine((x) => !!x.athleteId !== !!x.groupId, "Choose an athlete OR a group")
  .refine((x) => !x.endDate || x.endDate >= x.startDate, "End date must be after start date");

export async function assignHabit(tx: Tx, v: Viewer, raw: z.input<typeof assignInput>) {
  assertCan(v, "science.manage");
  const input = assignInput.parse(raw);
  const [h] = await tx.select().from(habits).where(and(eq(habits.id, input.habitId), eq(habits.orgId, v.orgId)));
  if (!h) throw new AuthzError();
  if (input.athleteId) await requireOnAthlete(tx, v, input.athleteId, "training.write");
  if (input.groupId) {
    const [g] = await tx.select().from(groups).where(and(eq(groups.id, input.groupId), eq(groups.orgId, v.orgId)));
    if (!g) throw new AuthzError();
    // Coaches may only assign to groups whose members are all in their scope.
    const members = await tx.select().from(groupMembers).where(eq(groupMembers.groupId, g.id));
    for (const m of members) await requireOnAthlete(tx, v, m.athleteId, "training.write");
  }
  const [a] = await tx.insert(habitAssignments).values({ habitId: h.id, athleteId: input.athleteId ?? null, groupId: input.groupId ?? null, startDate: input.startDate, endDate: input.endDate ?? null }).returning();
  await audit(tx, actorOf(v), "science.habit.assign", "habit_assignment", a.id, { summary: `Assigned "${h.name}"`, after: input });
  return a;
}

export type AthleteHabit = { habit: typeof habits.$inferSelect; startDate: string; endDate: string | null };

/** Active habit assignments for an athlete (direct or via group) overlapping [from, to]. */
export async function habitsForAthlete(tx: Tx, v: Viewer, athleteId: string, from: string, to: string): Promise<AthleteHabit[]> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const gids = (await tx.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.athleteId, athleteId))).map((r) => r.g);
  const rows = await tx
    .select({ habit: habits, a: habitAssignments })
    .from(habitAssignments)
    .innerJoin(habits, eq(habits.id, habitAssignments.habitId))
    .where(
      and(
        eq(habits.orgId, v.orgId),
        eq(habits.active, true),
        or(eq(habitAssignments.athleteId, athleteId), gids.length ? inArray(habitAssignments.groupId, gids) : undefined),
        lte(habitAssignments.startDate, to),
        or(isNull(habitAssignments.endDate), gte(habitAssignments.endDate, from)),
      ),
    )
    .orderBy(asc(habits.name));
  // Merge multiple assignments of the same habit into the widest window.
  const byHabit = new Map<string, AthleteHabit>();
  for (const r of rows) {
    const prev = byHabit.get(r.habit.id);
    if (!prev) byHabit.set(r.habit.id, { habit: r.habit, startDate: r.a.startDate, endDate: r.a.endDate });
    else {
      prev.startDate = prev.startDate < r.a.startDate ? prev.startDate : r.a.startDate;
      prev.endDate = prev.endDate === null || r.a.endDate === null ? null : prev.endDate > r.a.endDate ? prev.endDate : r.a.endDate;
    }
  }
  return [...byHabit.values()];
}

export const checkinInput = z.object({
  habitId: z.string().uuid(),
  athleteId: z.string().uuid(),
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["done", "partial", "missed"]),
  value: z.coerce.number().min(0).max(100000).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

export async function checkinHabit(tx: Tx, v: Viewer, raw: z.input<typeof checkinInput>, now = new Date()) {
  const input = checkinInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "training.log");
  const today = todayLocal(undefined, now);
  if (input.forDate > today) throw new UserError("Can't check in for a future date.");
  if (input.forDate < addDaysYmd(today, -7)) throw new UserError("Check-ins can be back-filled for up to 7 days.");
  const assigned = await habitsForAthlete(tx, v, input.athleteId, input.forDate, input.forDate);
  const ah = assigned.find((h) => h.habit.id === input.habitId);
  if (!ah || ah.startDate > input.forDate || (ah.endDate && ah.endDate < input.forDate)) throw new UserError("That habit isn't assigned for this date.");
  const values = { status: input.status, value: input.value ?? null, note: input.note || null };
  const [row] = await tx
    .insert(habitCheckins)
    .values({ orgId: v.orgId, habitId: input.habitId, athleteId: input.athleteId, forDate: input.forDate, ...values })
    .onConflictDoUpdate({ target: [habitCheckins.habitId, habitCheckins.athleteId, habitCheckins.forDate], set: values })
    .returning();
  await audit(tx, actorOf(v), "science.habit.checkin", "habit_checkin", row.id, { summary: `Habit "${ah.habit.name}" ${input.status} for ${input.forDate}` });
  return row;
}

export type HabitSummary = {
  habit: typeof habits.$inferSelect;
  window: { from: string; to: string };
  adherence: AdherenceResult;
  streak: number;
  /** Expected period → status (null = no check-in). */
  calendar: { date: string; status: HabitStatus | null; value: number | null }[];
  todayStatus: HabitStatus | null;
};

/** Adherence, streak, and calendar for each habit assigned to the athlete over [from, to]. */
export async function habitSummaries(tx: Tx, v: Viewer, athleteId: string, from: string, to: string): Promise<HabitSummary[]> {
  const assigned = await habitsForAthlete(tx, v, athleteId, from, to);
  if (!assigned.length) return [];
  const rows = await tx
    .select()
    .from(habitCheckins)
    .where(and(eq(habitCheckins.athleteId, athleteId), inArray(habitCheckins.habitId, assigned.map((a) => a.habit.id)), gte(habitCheckins.forDate, addDaysYmd(from, -6)), lte(habitCheckins.forDate, to)));
  return assigned.map(({ habit, startDate, endDate }) => {
    const s = startDate > from ? startDate : from;
    const e = endDate && endDate < to ? endDate : to;
    const expected = expectedHabitDates(habit.frequency, s, e);
    const mine = rows.filter((r) => r.habitId === habit.id);
    const map = new Map(mine.map((r) => [r.forDate, r.status as HabitStatus]));
    const values = new Map(mine.map((r) => [r.forDate, r.value]));
    const resolved = resolveHabitStatuses(habit.frequency, expected, map);
    return {
      habit,
      window: { from: s, to: e },
      adherence: habitAdherence(habit.frequency, expected, map),
      streak: habitStreak(habit.frequency, expected, map, to),
      calendar: expected.map((d) => ({ date: d, status: resolved.get(d) ?? null, value: values.get(d) ?? null })),
      todayStatus: map.get(to) ?? null,
    };
  });
}

export async function listHabits(tx: Tx, v: Viewer) {
  const hs = await tx.select().from(habits).where(eq(habits.orgId, v.orgId)).orderBy(asc(habits.name));
  const as = hs.length ? await tx.select().from(habitAssignments).where(inArray(habitAssignments.habitId, hs.map((h) => h.id))) : [];
  return hs.map((h) => ({ ...h, assignments: as.filter((a) => a.habitId === h.id) }));
}
