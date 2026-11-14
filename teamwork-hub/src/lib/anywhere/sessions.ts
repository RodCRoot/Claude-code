import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  ANYWHERE_CATEGORIES,
  ANYWHERE_EQUIPMENT,
  activitySessions,
  anywhereCompletions,
  anywhereSessionSteps,
  anywhereSessions,
  athletes,
  exercises,
  users,
  type AnywhereCategory,
  type AnywhereEquipment,
} from "@/db/schema";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { localYmd } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { actorOf, anywhereAccess, optText, orgAnywhere } from "./common";

export type AnywhereSession = typeof anywhereSessions.$inferSelect;
export type SessionStep = {
  id: string;
  sortOrder: number;
  prescription: string;
  cue: string | null;
  exercise: { id: string; name: string; coachingNotes: string | null; videoUrl: string | null };
};
export type SessionDetail = AnywhereSession & { steps: SessionStep[] };

const bool = z.preprocess((x) => x === true || x === "on" || x === "true", z.boolean());

export const sessionInput = z.object({
  title: z.string().trim().min(2, "Give the session a name").max(80),
  description: optText(400),
  category: z.enum(ANYWHERE_CATEGORIES),
  durationMinutes: z.coerce.number().int("Whole minutes").min(1).max(120),
  equipment: z.preprocess((x) => (x == null ? [] : Array.isArray(x) ? x : [x]), z.array(z.enum(ANYWHERE_EQUIPMENT)).max(4)),
  suitableUnder13: bool,
  status: z.enum(["draft", "published", "archived"]).default("draft"),
});

/** "none" only stands alone: a session that needs a band does not also list "no equipment". */
export function normalizeEquipment(list: readonly AnywhereEquipment[]): AnywhereEquipment[] {
  const real = ANYWHERE_EQUIPMENT.filter((e) => e !== "none" && list.includes(e));
  return real.length ? real : ["none"];
}

async function staffSession(tx: Tx, v: Viewer, id: string): Promise<AnywhereSession> {
  assertCan(v, "training.manage");
  const [s] = await tx.select().from(anywhereSessions).where(and(eq(anywhereSessions.id, id), eq(anywhereSessions.orgId, v.orgId)));
  if (!s) throw new AuthzError("Session not found.");
  return s;
}

async function stepCount(tx: Tx, sessionId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(anywhereSessionSteps).where(eq(anywhereSessionSteps.sessionId, sessionId));
  return r?.n ?? 0;
}

export async function createSession(tx: Tx, v: Viewer, raw: unknown): Promise<AnywhereSession> {
  assertCan(v, "training.manage");
  const input = sessionInput.parse(raw);
  if (input.status === "published") throw new UserError("Add at least one step before publishing.");
  const [s] = await tx
    .insert(anywhereSessions)
    .values({ orgId: v.orgId, ...input, description: input.description ?? null, equipment: normalizeEquipment(input.equipment), createdBy: v.userId })
    .returning();
  await audit(tx, actorOf(v), "anywhere.session.create", "anywhere_session", s.id, { summary: `Created On Your Own session "${s.title}"`, after: input });
  return s;
}

export async function updateSession(tx: Tx, v: Viewer, id: string, raw: unknown): Promise<AnywhereSession> {
  const before = await staffSession(tx, v, id);
  const input = sessionInput.parse(raw);
  if (input.status === "published" && (await stepCount(tx, id)) === 0) throw new UserError("Add at least one step before publishing.");
  const [s] = await tx
    .update(anywhereSessions)
    .set({ ...input, description: input.description ?? null, equipment: normalizeEquipment(input.equipment), updatedAt: new Date() })
    .where(eq(anywhereSessions.id, id))
    .returning();
  await audit(tx, actorOf(v), "anywhere.session.update", "anywhere_session", id, { summary: `Updated On Your Own session "${s.title}"`, before, after: input });
  return s;
}

export const stepInput = z.object({
  exerciseId: z.string().uuid("Choose an exercise"),
  prescription: z.string().trim().min(1, "Say what to do, e.g. 2 x 30 seconds").max(120),
  cue: optText(240),
});

async function renumber(tx: Tx, sessionId: string, orderedIds: string[]) {
  for (const [i, sid] of orderedIds.entries()) await tx.update(anywhereSessionSteps).set({ sortOrder: i + 1 }).where(and(eq(anywhereSessionSteps.id, sid), eq(anywhereSessionSteps.sessionId, sessionId)));
  await tx.update(anywhereSessions).set({ updatedAt: new Date() }).where(eq(anywhereSessions.id, sessionId));
}

const stepIds = async (tx: Tx, sessionId: string) =>
  (await tx.select({ id: anywhereSessionSteps.id }).from(anywhereSessionSteps).where(eq(anywhereSessionSteps.sessionId, sessionId)).orderBy(asc(anywhereSessionSteps.sortOrder))).map((r) => r.id);

/** Steps reuse the organization's existing exercise library: no new content is created here. */
export async function addStep(tx: Tx, v: Viewer, sessionId: string, raw: unknown) {
  const s = await staffSession(tx, v, sessionId);
  const input = stepInput.parse(raw);
  const [ex] = await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(and(eq(exercises.id, input.exerciseId), eq(exercises.orgId, v.orgId), eq(exercises.active, true)));
  if (!ex) throw new UserError("Choose an exercise from the library.");
  const n = await stepCount(tx, sessionId);
  if (n >= 20) throw new UserError("Keep it short: a session can have up to 20 steps.");
  const [step] = await tx.insert(anywhereSessionSteps).values({ sessionId, sortOrder: n + 1, exerciseId: ex.id, prescription: input.prescription, cue: input.cue ?? null }).returning();
  await tx.update(anywhereSessions).set({ updatedAt: new Date() }).where(eq(anywhereSessions.id, sessionId));
  await audit(tx, actorOf(v), "anywhere.session.step_add", "anywhere_session", s.id, { summary: `Added ${ex.name} to "${s.title}"` });
  return step;
}

async function staffStep(tx: Tx, v: Viewer, stepId: string) {
  assertCan(v, "training.manage");
  const [row] = await tx
    .select({ step: anywhereSessionSteps, session: anywhereSessions })
    .from(anywhereSessionSteps)
    .innerJoin(anywhereSessions, eq(anywhereSessions.id, anywhereSessionSteps.sessionId))
    .where(and(eq(anywhereSessionSteps.id, stepId), eq(anywhereSessions.orgId, v.orgId)));
  if (!row) throw new AuthzError("Step not found.");
  return row;
}

export async function removeStep(tx: Tx, v: Viewer, stepId: string) {
  const { step, session } = await staffStep(tx, v, stepId);
  const ids = (await stepIds(tx, session.id)).filter((x) => x !== step.id);
  if (session.status === "published" && ids.length === 0) throw new UserError("A published session needs at least one step. Move it to draft first.");
  await tx.delete(anywhereSessionSteps).where(eq(anywhereSessionSteps.id, step.id));
  await renumber(tx, session.id, ids);
  await audit(tx, actorOf(v), "anywhere.session.step_remove", "anywhere_session", session.id, { summary: `Removed a step from "${session.title}"` });
  return session;
}

/** Move one step up or down (button driven, so the builder works from the keyboard). */
export async function moveStep(tx: Tx, v: Viewer, stepId: string, dir: "up" | "down") {
  const { step, session } = await staffStep(tx, v, stepId);
  const ids = await stepIds(tx, session.id);
  const i = ids.indexOf(step.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return session;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await renumber(tx, session.id, ids);
  return session;
}

async function stepsFor(tx: Tx, sessionIds: string[]): Promise<Map<string, SessionStep[]>> {
  const out = new Map<string, SessionStep[]>();
  if (!sessionIds.length) return out;
  const rows = await tx
    .select({ step: anywhereSessionSteps, ex: { id: exercises.id, name: exercises.name, coachingNotes: exercises.coachingNotes, videoUrl: exercises.videoUrl } })
    .from(anywhereSessionSteps)
    .innerJoin(exercises, eq(exercises.id, anywhereSessionSteps.exerciseId))
    .where(inArray(anywhereSessionSteps.sessionId, sessionIds))
    .orderBy(asc(anywhereSessionSteps.sortOrder));
  for (const r of rows) out.set(r.step.sessionId, [...(out.get(r.step.sessionId) ?? []), { id: r.step.id, sortOrder: r.step.sortOrder, prescription: r.step.prescription, cue: r.step.cue, exercise: r.ex }]);
  return out;
}

/** Coach library: every status. Staff only. */
export async function listSessionsForStaff(tx: Tx, v: Viewer): Promise<(AnywhereSession & { stepCount: number })[]> {
  if (!isStaff(v)) throw new AuthzError();
  const rows = await tx.select().from(anywhereSessions).where(eq(anywhereSessions.orgId, v.orgId)).orderBy(asc(anywhereSessions.category), asc(anywhereSessions.title));
  const steps = await stepsFor(tx, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, stepCount: steps.get(r.id)?.length ?? 0 }));
}

export async function sessionForStaff(tx: Tx, v: Viewer, id: string): Promise<SessionDetail> {
  if (!isStaff(v)) throw new AuthzError();
  const [s] = await tx.select().from(anywhereSessions).where(and(eq(anywhereSessions.id, id), eq(anywhereSessions.orgId, v.orgId)));
  if (!s) throw new AuthzError("Session not found.");
  return { ...s, steps: (await stepsFor(tx, [id])).get(id) ?? [] };
}

export type LibraryFilter = { maxMinutes?: number | null; equipment?: AnywhereEquipment | null; category?: AnywhereCategory | null };

/** Pure: does a session fit the time and equipment the athlete has? */
export function matchesFilter(s: Pick<AnywhereSession, "durationMinutes" | "equipment" | "category">, f: LibraryFilter): boolean {
  if (f.maxMinutes && s.durationMinutes > f.maxMinutes) return false;
  if (f.category && s.category !== f.category) return false;
  if (f.equipment) {
    const needs = s.equipment.filter((e) => e !== "none");
    if (f.equipment === "none" ? needs.length > 0 : needs.some((e) => e !== f.equipment)) return false;
  }
  return true;
}

/**
 * Published sessions this athlete may do. Under-13 athletes (and athletes with no birthday on
 * file) only get sessions marked suitable. Nothing here reads wellness, pain or injury data: the
 * list is the same whatever the athlete reported.
 */
export async function libraryForAthlete(tx: Tx, v: Viewer, athleteId: string, f: LibraryFilter = {}, today?: string): Promise<(AnywhereSession & { stepCount: number })[]> {
  const access = await anywhereAccess(tx, v, athleteId, today);
  if (!access?.canSeeTraining) throw new AuthzError();
  const rows = await tx
    .select()
    .from(anywhereSessions)
    .where(and(eq(anywhereSessions.orgId, v.orgId), eq(anywhereSessions.status, "published"), access.restricted ? eq(anywhereSessions.suitableUnder13, true) : undefined))
    .orderBy(asc(anywhereSessions.durationMinutes), asc(anywhereSessions.title));
  const fit = rows.filter((r) => matchesFilter(r, f));
  const steps = await stepsFor(tx, fit.map((r) => r.id));
  return fit.map((r) => ({ ...r, stepCount: steps.get(r.id)?.length ?? 0 }));
}

/** One published session with its steps, under the same rules as the library. */
export async function sessionForAthlete(tx: Tx, v: Viewer, athleteId: string, sessionId: string, today?: string): Promise<SessionDetail> {
  const access = await anywhereAccess(tx, v, athleteId, today);
  if (!access?.canSeeTraining) throw new AuthzError();
  const [s] = await tx.select().from(anywhereSessions).where(and(eq(anywhereSessions.id, sessionId), eq(anywhereSessions.orgId, v.orgId), eq(anywhereSessions.status, "published")));
  if (!s || (access.restricted && !s.suitableUnder13)) throw new AuthzError("That session is not available.");
  return { ...s, steps: (await stepsFor(tx, [s.id])).get(s.id) ?? [] };
}

export const completionInput = z.object({
  athleteId: z.string().uuid(),
  sessionId: z.string().uuid(),
  /** Made on the device when the athlete taps Finish. Retries reuse it. */
  clientKey: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
  stepsDone: z.coerce.number().int().min(0).max(50),
  durationMinutes: z.preprocess((x) => (x === "" || x == null ? null : x), z.coerce.number().int().min(1).max(240).nullable()),
  rpe: z.preprocess((x) => (x === "" || x == null ? null : x), z.coerce.number().int().min(0).max(10).nullable()),
  /** When the athlete actually finished (the request may arrive much later). */
  completedAt: z.preprocess((x) => (x === "" || x == null ? null : x), z.string().datetime({ offset: true }).nullable()).optional(),
});

export type CompletionResult = { status: "applied" | "duplicate"; completionId: string; loadLogged: boolean };

const MAX_LATE_MS = 7 * 86_400_000;

/**
 * Record a finished session. Idempotent on (org, clientKey): a retry returns "duplicate" and
 * writes nothing. When BOTH duration and RPE are given, one activity_sessions row is written with
 * source "on_your_own" so the load views pick it up; otherwise no load row exists (never 0).
 */
export async function completeSession(tx: Tx, v: Viewer, raw: unknown, now = new Date()): Promise<CompletionResult> {
  const input = completionInput.parse(raw);
  const { tz } = await orgAnywhere(tx, v.orgId);
  const access = await anywhereAccess(tx, v, input.athleteId, localYmd(now, tz));
  // The athlete, a coach or staff member with training.log, or (owner decision 2026-11) a guardian
  // with training and booking access when the athlete is under 13 by the birthday on file.
  if (!access?.canFinishSession) throw new AuthzError();
  const loggedAs = access.finishesAsGuardian ? ("guardian" as const) : isStaff(v) ? ("staff" as const) : ("athlete" as const);
  const [existing] = await tx.select().from(anywhereCompletions).where(and(eq(anywhereCompletions.orgId, v.orgId), eq(anywhereCompletions.clientKey, input.clientKey)));
  if (existing) {
    if (existing.athleteId !== input.athleteId) throw new AuthzError();
    return { status: "duplicate", completionId: existing.id, loadLogged: !!existing.activitySessionId };
  }
  const session = await sessionForAthlete(tx, v, input.athleteId, input.sessionId, localYmd(now, tz));
  let completedAt = now;
  if (input.completedAt) {
    const t = new Date(input.completedAt);
    if (t <= now && now.getTime() - t.getTime() <= MAX_LATE_MS) completedAt = t;
  }
  const localDate = localYmd(completedAt, tz);
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(eq(athletes.id, input.athleteId));
  const stepsTotal = session.steps.length;
  const [row] = await tx
    .insert(anywhereCompletions)
    .values({
      orgId: v.orgId,
      athleteId: input.athleteId,
      sessionId: session.id,
      sessionTitle: session.title,
      category: session.category,
      clientKey: input.clientKey,
      completedAt,
      localDate,
      stepsDone: Math.min(input.stepsDone, stepsTotal),
      stepsTotal,
      durationMinutes: input.durationMinutes,
      rpe: input.rpe,
      loggedBy: v.userId,
      loggedAs,
      isDemo: a?.isDemo ?? false,
    })
    .onConflictDoNothing({ target: [anywhereCompletions.orgId, anywhereCompletions.clientKey] })
    .returning();
  if (!row) {
    const [again] = await tx.select().from(anywhereCompletions).where(and(eq(anywhereCompletions.orgId, v.orgId), eq(anywhereCompletions.clientKey, input.clientKey)));
    return { status: "duplicate", completionId: again.id, loadLogged: !!again.activitySessionId };
  }
  let loadLogged = false;
  if (input.durationMinutes != null && input.rpe != null) {
    const [act] = await tx
      .insert(activitySessions)
      .values({ orgId: v.orgId, athleteId: input.athleteId, activityDate: localDate, kind: "training", durationMinutes: input.durationMinutes, sessionRpe: input.rpe, notes: `On Your Own: ${session.title}`, enteredBy: v.userId, source: "on_your_own", isDemo: a?.isDemo ?? false })
      .returning({ id: activitySessions.id });
    await tx.update(anywhereCompletions).set({ activitySessionId: act.id }).where(eq(anywhereCompletions.id, row.id));
    loadLogged = true;
  }
  await audit(tx, actorOf(v), "anywhere.session.complete", "anywhere_completion", row.id, {
    summary: `${loggedAs === "guardian" ? "Parent logged" : "Finished"} On Your Own session "${session.title}"${loggedAs === "guardian" ? " on behalf of an athlete under 13" : ""}${loadLogged ? " (load logged)" : ""}`,
    after: { athleteId: input.athleteId, loggedAs, loggedBy: v.userId, loadLogged },
  });
  return { status: "applied", completionId: row.id, loadLogged };
}

export type CompletionView = {
  id: string;
  athleteId: string;
  sessionId: string;
  sessionTitle: string;
  category: AnywhereCategory;
  completedAt: Date;
  localDate: string;
  stepsDone: number;
  stepsTotal: number;
  durationMinutes: number | null;
  rpe: number | null;
  reviewedAt: Date | null;
  /** "guardian" = a parent entered it for an athlete under 13. Shown to coaches as "Logged by parent". */
  loggedAs: "athlete" | "guardian" | "staff";
};

const view = (c: typeof anywhereCompletions.$inferSelect): CompletionView => ({
  id: c.id,
  athleteId: c.athleteId,
  sessionId: c.sessionId,
  sessionTitle: c.sessionTitle,
  category: c.category,
  completedAt: c.completedAt,
  localDate: c.localDate,
  stepsDone: c.stepsDone,
  stepsTotal: c.stepsTotal,
  durationMinutes: c.durationMinutes,
  rpe: c.rpe,
  reviewedAt: c.reviewedAt,
  loggedAs: c.loggedAs,
});

/** An athlete's finished sessions, newest first. Needs training.read (same as load data). */
export async function completionsForAthlete(tx: Tx, v: Viewer, athleteId: string, limit = 10): Promise<CompletionView[]> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const rows = await tx
    .select()
    .from(anywhereCompletions)
    .where(and(eq(anywhereCompletions.orgId, v.orgId), eq(anywhereCompletions.athleteId, athleteId)))
    .orderBy(desc(anywhereCompletions.completedAt))
    .limit(limit);
  return rows.map(view);
}

/** Coach review queue: finished sessions for athletes in the viewer's scope. Staff only. */
export async function completionReviewQueue(tx: Tx, v: Viewer, opts: { includeReviewed?: boolean; limit?: number } = {}): Promise<(CompletionView & { athleteName: string; /** The parent's name when a guardian logged it. */ loggedByName: string | null })[]> {
  if (!isStaff(v)) throw new AuthzError();
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const rows = await tx
    .select()
    .from(anywhereCompletions)
    .where(and(eq(anywhereCompletions.orgId, v.orgId), athleteScopeFilter(scope, anywhereCompletions.athleteId), opts.includeReviewed ? undefined : isNull(anywhereCompletions.reviewedAt)))
    .orderBy(desc(anywhereCompletions.completedAt))
    .limit(opts.limit ?? 30);
  const names = await athleteNames(tx, v.orgId, rows.map((r) => r.athleteId));
  const parentIds = [...new Set(rows.filter((r) => r.loggedAs === "guardian" && r.loggedBy).map((r) => r.loggedBy!))];
  const parents = parentIds.length ? await tx.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, v.orgId), inArray(users.id, parentIds))) : [];
  return rows.map((r) => ({ ...view(r), athleteName: names.get(r.athleteId) ?? "Athlete", loggedByName: r.loggedAs === "guardian" ? (parents.find((p) => p.id === r.loggedBy)?.name ?? null) : null }));
}

export async function markCompletionReviewed(tx: Tx, v: Viewer, completionId: string) {
  const [c] = await tx.select().from(anywhereCompletions).where(and(eq(anywhereCompletions.id, completionId), eq(anywhereCompletions.orgId, v.orgId)));
  if (!c) throw new AuthzError();
  await requireOnAthlete(tx, v, c.athleteId, "training.write");
  if (c.reviewedAt) return;
  await tx.update(anywhereCompletions).set({ reviewedAt: new Date(), reviewedBy: v.userId }).where(eq(anywhereCompletions.id, c.id));
  await audit(tx, actorOf(v), "anywhere.completion.review", "anywhere_completion", c.id, { summary: `Reviewed On Your Own session "${c.sessionTitle}"` });
}
