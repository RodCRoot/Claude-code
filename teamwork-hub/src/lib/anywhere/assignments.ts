import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { ANYWHERE_CATEGORIES, anywhereAssignments, anywhereCompletions, anywhereSessions, athletes, groupMembers, groups, people, type AnywhereCategory } from "@/db/schema";
import { accessibleAthleteIds, assertCan, AuthzError, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { addDaysYmd, daysBetween, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { actorOf, ageOn, anywhereAccess, CATEGORY_LABEL, optText, UNDER_13_AGE, ymd } from "./common";

const optUuid = z.preprocess((x) => (x === "" || x == null ? null : x), z.string().uuid().nullable());

export const assignInput = z
  .object({
    /** "session:<uuid>" or "category:<key>" from one select. */
    what: z.string().min(1, "Choose what to assign"),
    athleteId: optUuid.optional(),
    groupId: optUuid.optional(),
    startDate: ymd,
    endDate: ymd,
    targetCount: z.coerce.number().int().min(1).max(14).default(1),
    note: optText(200),
  })
  .refine((x) => !!x.athleteId !== !!x.groupId, { message: "Choose an athlete or a group, not both", path: ["athleteId"] })
  .refine((x) => x.endDate >= x.startDate, { message: "The end date must be on or after the start date", path: ["endDate"] })
  .refine((x) => daysBetween(x.startDate, x.endDate) <= 60, { message: "Keep the window to 60 days or less", path: ["endDate"] });

/** Assign one session, or "any session from a category", N times inside a date window. */
export async function assignSession(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "training.manage");
  const input = assignInput.parse(raw);
  let sessionId: string | null = null;
  let category: AnywhereCategory | null = null;
  let label: string;
  if (input.what.startsWith("session:")) {
    const [s] = await tx.select().from(anywhereSessions).where(and(eq(anywhereSessions.id, input.what.slice(8)), eq(anywhereSessions.orgId, v.orgId)));
    if (!s) throw new AuthzError("Session not found.");
    if (s.status !== "published") throw new UserError("Publish the session before assigning it.");
    sessionId = s.id;
    label = s.title;
  } else {
    const c = z.enum(ANYWHERE_CATEGORIES).safeParse(input.what.replace(/^category:/, ""));
    if (!c.success) throw new UserError("Choose what to assign.");
    category = c.data;
    label = `any ${CATEGORY_LABEL[c.data].toLowerCase()} session`;
  }
  if (input.athleteId) await requireOnAthlete(tx, v, input.athleteId, "training.write");
  if (input.groupId) {
    const [g] = await tx.select().from(groups).where(and(eq(groups.id, input.groupId), eq(groups.orgId, v.orgId)));
    if (!g) throw new AuthzError();
    // Same rule as habits: a coach may only assign to a group whose members are all in scope.
    for (const m of await tx.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))) await requireOnAthlete(tx, v, m.athleteId, "training.write");
  }
  const [a] = await tx
    .insert(anywhereAssignments)
    .values({ orgId: v.orgId, sessionId, category, athleteId: input.athleteId ?? null, groupId: input.groupId ?? null, startDate: input.startDate, endDate: input.endDate, targetCount: input.targetCount, note: input.note ?? null, assignedBy: v.userId })
    .returning();
  await audit(tx, actorOf(v), "anywhere.assign", "anywhere_assignment", a.id, { summary: `Assigned ${label} x${a.targetCount}, ${a.startDate} to ${a.endDate}`, after: input });
  return a;
}

export async function cancelAssignment(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "training.manage");
  const [a] = await tx.select().from(anywhereAssignments).where(and(eq(anywhereAssignments.id, id), eq(anywhereAssignments.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  if (a.athleteId) await requireOnAthlete(tx, v, a.athleteId, "training.write");
  if (a.cancelledAt) return;
  await tx.update(anywhereAssignments).set({ cancelledAt: new Date() }).where(eq(anywhereAssignments.id, id));
  await audit(tx, actorOf(v), "anywhere.assign.cancel", "anywhere_assignment", id, { summary: "Cancelled an On Your Own assignment" });
}

type Assignment = typeof anywhereAssignments.$inferSelect;
type Completion = Pick<typeof anywhereCompletions.$inferSelect, "athleteId" | "sessionId" | "category" | "localDate">;

/** Pure: completions that count toward an assignment for one athlete. */
export function assignmentProgress(a: Pick<Assignment, "sessionId" | "category" | "startDate" | "endDate" | "targetCount">, athleteId: string, completions: readonly Completion[]): { done: number; target: number; complete: boolean } {
  const done = completions.filter((c) => c.athleteId === athleteId && c.localDate >= a.startDate && c.localDate <= a.endDate && (a.sessionId ? c.sessionId === a.sessionId : c.category === a.category)).length;
  return { done: Math.min(done, a.targetCount), target: a.targetCount, complete: done >= a.targetCount };
}

export type AthleteAssignment = {
  id: string;
  /** The session to open, when one specific session was assigned. */
  sessionId: string | null;
  category: AnywhereCategory | null;
  title: string;
  startDate: string;
  endDate: string;
  note: string | null;
  done: number;
  target: number;
  complete: boolean;
};

/**
 * Assignments for one athlete (direct or through a group) that are current or start within a
 * week. A specific session an under-13 athlete may not see is left out for that athlete.
 */
export async function assignmentsForAthlete(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()): Promise<AthleteAssignment[]> {
  const access = await anywhereAccess(tx, v, athleteId, today);
  if (!access?.canSeeTraining) throw new AuthzError();
  const gids = (await tx.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.athleteId, athleteId))).map((r) => r.g);
  const rows = await tx
    .select({ a: anywhereAssignments, s: anywhereSessions })
    .from(anywhereAssignments)
    .leftJoin(anywhereSessions, eq(anywhereSessions.id, anywhereAssignments.sessionId))
    .where(
      and(
        eq(anywhereAssignments.orgId, v.orgId),
        isNull(anywhereAssignments.cancelledAt),
        or(eq(anywhereAssignments.athleteId, athleteId), gids.length ? inArray(anywhereAssignments.groupId, gids) : undefined),
        lte(anywhereAssignments.startDate, addDaysYmd(today, 7)),
        gte(anywhereAssignments.endDate, today),
      ),
    )
    .orderBy(anywhereAssignments.endDate);
  const visible = rows.filter((r) => !r.s || (r.s.status === "published" && (!access.restricted || r.s.suitableUnder13)));
  if (!visible.length) return [];
  const completions = await tx
    .select({ athleteId: anywhereCompletions.athleteId, sessionId: anywhereCompletions.sessionId, category: anywhereCompletions.category, localDate: anywhereCompletions.localDate })
    .from(anywhereCompletions)
    .where(and(eq(anywhereCompletions.orgId, v.orgId), eq(anywhereCompletions.athleteId, athleteId), gte(anywhereCompletions.localDate, visible.map((r) => r.a.startDate).sort()[0])));
  return visible.map(({ a, s }) => ({
    id: a.id,
    sessionId: a.sessionId,
    category: a.category,
    title: s ? s.title : `Any ${CATEGORY_LABEL[a.category!].toLowerCase()} session`,
    startDate: a.startDate,
    endDate: a.endDate,
    note: a.note,
    ...assignmentProgress(a, athleteId, completions),
  }));
}

export type AssignmentBoardRow = {
  id: string;
  title: string;
  target: string;
  startDate: string;
  endDate: string;
  targetCount: number;
  note: string | null;
  athletes: { athleteId: string; name: string; done: number; complete: boolean }[];
};

/**
 * Coach view: assignments from the last two weeks onward with completion status per athlete.
 * Only athletes in the viewer's training scope are listed (a coach never sees another coach's).
 */
export async function assignmentBoard(tx: Tx, v: Viewer, today = todayLocal()): Promise<AssignmentBoardRow[]> {
  if (!isStaff(v)) throw new AuthzError();
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const rows = await tx
    .select({ a: anywhereAssignments, s: anywhereSessions, g: groups })
    .from(anywhereAssignments)
    .leftJoin(anywhereSessions, eq(anywhereSessions.id, anywhereAssignments.sessionId))
    .leftJoin(groups, eq(groups.id, anywhereAssignments.groupId))
    .where(and(eq(anywhereAssignments.orgId, v.orgId), isNull(anywhereAssignments.cancelledAt), gte(anywhereAssignments.endDate, addDaysYmd(today, -14))))
    .orderBy(desc(anywhereAssignments.endDate))
    .limit(40);
  if (!rows.length) return [];
  const groupIds = [...new Set(rows.map((r) => r.a.groupId).filter((x): x is string => !!x))];
  const members = groupIds.length ? await tx.select().from(groupMembers).where(inArray(groupMembers.groupId, groupIds)) : [];
  const inScope = (id: string) => scope === "all" || scope.includes(id);
  const perRow = rows.map((r) => ({ r, ids: (r.a.athleteId ? [r.a.athleteId] : members.filter((m) => m.groupId === r.a.groupId).map((m) => m.athleteId)).filter(inScope) }));
  const allIds = [...new Set(perRow.flatMap((p) => p.ids))];
  if (!allIds.length) return [];
  const names = await athleteNames(tx, v.orgId, allIds);
  const dobs = new Map((await tx.select({ id: athletes.id, dob: people.dateOfBirth }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, allIds)))).map((r) => [r.id, r.dob]));
  const completions = await tx
    .select({ athleteId: anywhereCompletions.athleteId, sessionId: anywhereCompletions.sessionId, category: anywhereCompletions.category, localDate: anywhereCompletions.localDate })
    .from(anywhereCompletions)
    .where(and(eq(anywhereCompletions.orgId, v.orgId), inArray(anywhereCompletions.athleteId, allIds), gte(anywhereCompletions.localDate, rows.map((r) => r.a.startDate).sort()[0])));
  return perRow
    .filter((p) => p.ids.length)
    .map(({ r, ids }) => ({
      id: r.a.id,
      title: r.s ? r.s.title : `Any ${CATEGORY_LABEL[r.a.category!].toLowerCase()} session`,
      target: r.g ? r.g.name : names.get(r.a.athleteId!) ?? "Athlete",
      startDate: r.a.startDate,
      endDate: r.a.endDate,
      targetCount: r.a.targetCount,
      note: r.a.note,
      athletes: ids
        // The athlete never sees a session that is not marked suitable for under 13s, so do not chase them for it.
        .filter((id) => !r.s || r.s.suitableUnder13 || (ageOn(dobs.get(id) ?? null, today) ?? 0) >= UNDER_13_AGE)
        .map((id) => ({ athleteId: id, name: names.get(id) ?? "Athlete", ...assignmentProgress(r.a, id, completions) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
