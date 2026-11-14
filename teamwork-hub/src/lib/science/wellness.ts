import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { bookings, questionnaireResponses, questionnaires, questionnaireVersions, scheduleSessions, type QuestionDef } from "@/db/schema";
import { assertCan, AuthzError, canOnAthlete, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { addDaysYmd, localDayBounds, todayLocal } from "@/lib/time";
import { actorOf, groupsByAthlete, scienceSettings, scopedAthletes } from "./access";
import { completionStatus, isScheduledOn, readinessV1, wellnessFlags, type CompletionStatus, type FlagRule, type ReadinessResult, type WellnessFlag } from "./formulas";

export type Frequency = "daily" | "weekdays" | "pre_session";
export type QuestionnaireSchedule = { frequency: Frequency; groupIds: string[]; flagRules: Record<string, FlagRule> };

export function parseSchedule(raw: Record<string, unknown> | null | undefined): QuestionnaireSchedule {
  const r = raw ?? {};
  const f = r.frequency;
  return {
    frequency: f === "weekdays" || f === "pre_session" ? f : "daily",
    groupIds: Array.isArray(r.groupIds) ? (r.groupIds as string[]) : [],
    flagRules: (r.flagRules as Record<string, FlagRule>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Builder + versioning
// ---------------------------------------------------------------------------

const keyRe = /^[a-z][a-z0-9_]{0,39}$/;
export const questionSchema = z
  .object({
    key: z.string().regex(keyRe, "Use lowercase letters, digits, underscores"),
    label: z.string().trim().min(1).max(160),
    kind: z.enum(["scale", "number", "text", "boolean"]),
    min: z.number().optional(),
    max: z.number().optional(),
    polarity: z.enum(["higher_better", "lower_better", "neutral"]).optional(),
    unit: z.string().trim().max(20).optional(),
    anchors: z.record(z.string(), z.string().max(60)).optional(),
    required: z.boolean().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.kind === "scale") {
      if (q.min === undefined || q.max === undefined) ctx.addIssue({ code: "custom", message: `"${q.label}": scale needs min and max` });
      else if (q.max <= q.min) ctx.addIssue({ code: "custom", message: `"${q.label}": max must be greater than min` });
      else if (q.max - q.min > 100) ctx.addIssue({ code: "custom", message: `"${q.label}": scale range too large` });
    }
  });

export const questionnaireInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  frequency: z.enum(["daily", "weekdays", "pre_session"]),
  groupIds: z.array(z.string().uuid()).default([]),
  questions: z.array(questionSchema).min(1, "Add at least one question").max(30),
  flagRules: z.record(z.string(), z.object({ below: z.number().nullable().optional(), above: z.number().nullable().optional() })).default({}),
  active: z.boolean().default(true),
});

/** Structural equality of question lists (key order independent). */
function sameQuestions(a: QuestionDef[], b: QuestionDef[]): boolean {
  const norm = (q: QuestionDef) => JSON.stringify(Object.keys(q).sort().reduce<Record<string, unknown>>((o, k) => ((o[k] = (q as Record<string, unknown>)[k]), o), {}));
  return a.length === b.length && a.every((q, i) => norm(q) === norm(b[i]));
}

/**
 * Create or edit a questionnaire. Editing questions creates a NEW version; existing
 * responses keep pointing at the version they answered. Schedule/flags are not versioned.
 */
export async function saveQuestionnaire(tx: Tx, v: Viewer, raw: z.input<typeof questionnaireInput>) {
  assertCan(v, "science.manage");
  const input = questionnaireInput.parse(raw);
  const keys = input.questions.map((q) => q.key);
  if (new Set(keys).size !== keys.length) throw new UserError("Each question needs a unique key.");
  const questions = input.questions.map((q) => ({ ...q, required: q.required ?? false })) as QuestionDef[];
  const schedule: QuestionnaireSchedule = { frequency: input.frequency, groupIds: input.groupIds, flagRules: input.flagRules };

  if (!input.id) {
    const [q] = await tx.insert(questionnaires).values({ orgId: v.orgId, name: input.name, schedule, active: input.active }).returning();
    const [ver] = await tx.insert(questionnaireVersions).values({ questionnaireId: q.id, version: 1, questions }).returning();
    await tx.update(questionnaires).set({ currentVersionId: ver.id }).where(eq(questionnaires.id, q.id));
    await audit(tx, actorOf(v), "science.questionnaire.create", "questionnaire", q.id, { summary: `Created questionnaire "${input.name}" v1`, after: { questions: keys, schedule } });
    return { id: q.id, versionId: ver.id, version: 1, newVersion: true };
  }

  const [existing] = await tx.select().from(questionnaires).where(and(eq(questionnaires.id, input.id), eq(questionnaires.orgId, v.orgId))).for("update");
  if (!existing) throw new AuthzError();
  const [cur] = existing.currentVersionId ? await tx.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, existing.currentVersionId)) : [];
  let versionId = cur?.id;
  let version = cur?.version ?? 0;
  let newVersion = false;
  if (!cur || !sameQuestions(cur.questions, questions)) {
    const [maxRow] = await tx.select({ m: sql<number>`coalesce(max(${questionnaireVersions.version}), 0)` }).from(questionnaireVersions).where(eq(questionnaireVersions.questionnaireId, existing.id));
    version = Number(maxRow.m) + 1;
    const [ver] = await tx.insert(questionnaireVersions).values({ questionnaireId: existing.id, version, questions }).returning();
    versionId = ver.id;
    newVersion = true;
  }
  await tx.update(questionnaires).set({ name: input.name, schedule, active: input.active, currentVersionId: versionId }).where(eq(questionnaires.id, existing.id));
  await audit(tx, actorOf(v), "science.questionnaire.update", "questionnaire", existing.id, {
    summary: newVersion ? `Edited "${input.name}" → new version v${version}` : `Updated schedule/flags for "${input.name}"`,
    before: { name: existing.name, schedule: existing.schedule, versionId: existing.currentVersionId },
    after: { name: input.name, schedule, versionId },
  });
  return { id: existing.id, versionId: versionId!, version, newVersion };
}

export type QuestionnaireFull = {
  id: string;
  name: string;
  active: boolean;
  schedule: QuestionnaireSchedule;
  versionId: string;
  version: number;
  questions: QuestionDef[];
  versionCount: number;
};

export async function listQuestionnaires(tx: Tx, v: Viewer, opts: { activeOnly?: boolean } = {}): Promise<QuestionnaireFull[]> {
  const qs = await tx
    .select()
    .from(questionnaires)
    .where(and(eq(questionnaires.orgId, v.orgId), opts.activeOnly ? eq(questionnaires.active, true) : undefined))
    .orderBy(asc(questionnaires.name));
  if (!qs.length) return [];
  const vers = await tx.select().from(questionnaireVersions).where(inArray(questionnaireVersions.questionnaireId, qs.map((q) => q.id)));
  return qs
    .map((q) => {
      const cur = vers.find((x) => x.id === q.currentVersionId);
      if (!cur) return null;
      return {
        id: q.id,
        name: q.name,
        active: q.active,
        schedule: parseSchedule(q.schedule),
        versionId: cur.id,
        version: cur.version,
        questions: cur.questions,
        versionCount: vers.filter((x) => x.questionnaireId === q.id).length,
      };
    })
    .filter((x): x is QuestionnaireFull => !!x);
}

export async function getQuestionnaire(tx: Tx, v: Viewer, id: string) {
  return (await listQuestionnaires(tx, v)).find((q) => q.id === id) ?? null;
}

export async function versionHistory(tx: Tx, v: Viewer, questionnaireId: string) {
  const [q] = await tx.select().from(questionnaires).where(and(eq(questionnaires.id, questionnaireId), eq(questionnaires.orgId, v.orgId)));
  if (!q) return [];
  const vers = await tx.select().from(questionnaireVersions).where(eq(questionnaireVersions.questionnaireId, q.id)).orderBy(desc(questionnaireVersions.version));
  const counts = await tx
    .select({ versionId: questionnaireResponses.versionId, n: sql<number>`count(*)::int` })
    .from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.orgId, v.orgId), inArray(questionnaireResponses.versionId, vers.map((x) => x.id))))
    .groupBy(questionnaireResponses.versionId);
  return vers.map((x) => ({ ...x, responses: counts.find((c) => c.versionId === x.id)?.n ?? 0 }));
}

// ---------------------------------------------------------------------------
// Athlete check-in
// ---------------------------------------------------------------------------

async function hasSessionOn(tx: Tx, athleteId: string, ymd: string): Promise<boolean> {
  const { start, end } = localDayBounds(ymd);
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.athleteId, athleteId), inArray(bookings.status, ["booked", "attended"]), gte(scheduleSessions.startsAt, start), lte(scheduleSessions.startsAt, end)));
  return (r?.n ?? 0) > 0;
}

function targets(q: QuestionnaireFull, athleteGroups: string[]): boolean {
  return q.schedule.groupIds.length === 0 || q.schedule.groupIds.some((g) => athleteGroups.includes(g));
}

export type DueQuestionnaire = QuestionnaireFull & { due: boolean; response: typeof questionnaireResponses.$inferSelect | null };

/** Questionnaires targeted at this athlete, with whether they're due on `date` and any existing response. */
export async function questionnairesForAthlete(tx: Tx, v: Viewer, athleteId: string, date: string): Promise<DueQuestionnaire[]> {
  await requireOnAthlete(tx, v, athleteId, "health.read");
  const all = await listQuestionnaires(tx, v, { activeOnly: true });
  const groups = (await groupsByAthlete(tx, [athleteId])).get(athleteId) ?? [];
  const mine = all.filter((q) => targets(q, groups));
  if (!mine.length) return [];
  const session = mine.some((q) => q.schedule.frequency === "pre_session") ? await hasSessionOn(tx, athleteId, date) : false;
  const allVersionIds = (await tx.select({ id: questionnaireVersions.id, q: questionnaireVersions.questionnaireId }).from(questionnaireVersions).where(inArray(questionnaireVersions.questionnaireId, mine.map((q) => q.id))));
  const responses = await tx
    .select()
    .from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.athleteId, athleteId), eq(questionnaireResponses.forDate, date), inArray(questionnaireResponses.versionId, allVersionIds.map((x) => x.id))));
  return mine.map((q) => {
    const ids = allVersionIds.filter((x) => x.q === q.id).map((x) => x.id);
    return { ...q, due: isScheduledOn(q.schedule.frequency, date, session), response: responses.find((r) => ids.includes(r.versionId)) ?? null };
  });
}

/** Validate answers against a version's questions. Unanswered optional items become null. */
export function validateAnswers(questions: QuestionDef[], raw: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const out: Record<string, number | string | boolean | null> = {};
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const v = raw[q.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (q.required) errors[q.key] = "Required";
      out[q.key] = null;
      continue;
    }
    if (q.kind === "scale" || q.kind === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) errors[q.key] = "Must be a number";
      else if (q.kind === "scale" && (n < (q.min ?? -Infinity) || n > (q.max ?? Infinity))) errors[q.key] = `Must be between ${q.min} and ${q.max}`;
      else if (q.kind === "number" && (n < 0 || n > 100000)) errors[q.key] = "Out of range";
      else out[q.key] = n;
    } else if (q.kind === "boolean") {
      out[q.key] = v === true || v === "true" || v === "yes";
    } else {
      out[q.key] = String(v).slice(0, 500);
    }
  }
  if (Object.keys(errors).length) throw new UserError("Please answer the required questions.", errors);
  return out;
}

/**
 * Submit (or correct) a check-in. Athletes may submit for today only; staff with
 * health.write may enter for up to 7 days back (e.g. paper check-ins).
 */
export async function submitResponse(
  tx: Tx,
  v: Viewer,
  input: { athleteId: string; questionnaireId: string; forDate?: string; answers: Record<string, unknown>; note?: string | null },
  now = new Date(),
) {
  await requireOnAthlete(tx, v, input.athleteId, "health.write");
  const today = todayLocal(undefined, now);
  const forDate = input.forDate ?? today;
  if (forDate > today) throw new UserError("Check-ins can't be submitted for future dates.");
  if (v.role === "athlete" || v.role === "guardian") {
    if (forDate !== today) throw new UserError("Check-ins can only be submitted for today.");
  } else if (forDate < addDaysYmd(today, -7)) throw new UserError("Staff can back-enter check-ins for up to 7 days.");
  const q = await getQuestionnaire(tx, v, input.questionnaireId);
  if (!q || !q.active) throw new UserError("That questionnaire is not available.");
  const answers = validateAnswers(q.questions, input.answers);
  const [row] = await tx
    .insert(questionnaireResponses)
    .values({ orgId: v.orgId, athleteId: input.athleteId, versionId: q.versionId, forDate, answers, note: input.note?.slice(0, 500) || null, submittedBy: v.userId, submittedAt: now })
    .onConflictDoUpdate({
      target: [questionnaireResponses.athleteId, questionnaireResponses.versionId, questionnaireResponses.forDate],
      set: { answers, note: input.note?.slice(0, 500) || null, submittedBy: v.userId, submittedAt: now },
    })
    .returning();
  // Audit records the fact of submission, not the health answers themselves.
  await audit(tx, actorOf(v), "science.wellness.submit", "questionnaire_response", row.id, { summary: `Wellness check-in for ${forDate} (${q.name} v${q.version})` });
  return { id: row.id, readiness: readinessV1(q.questions, answers) };
}

// ---------------------------------------------------------------------------
// Coach views
// ---------------------------------------------------------------------------

export type GridRow = {
  athleteId: string;
  name: string;
  status: CompletionStatus;
  readiness: ReadinessResult;
  flags: WellnessFlag[];
  answers: Record<string, unknown> | null;
  submittedAt: Date | null;
  version: number | null;
};

/** Today's completion grid for one questionnaire, over athletes the viewer holds health.read on. */
export async function completionGrid(tx: Tx, v: Viewer, questionnaireId: string, date: string): Promise<{ q: QuestionnaireFull; rows: GridRow[] } | null> {
  const q = await getQuestionnaire(tx, v, questionnaireId);
  if (!q) return null;
  const settings = await scienceSettings(tx, v.orgId);
  const athletesInScope = await scopedAthletes(tx, v, "health.read");
  const groups = await groupsByAthlete(tx, athletesInScope.map((a) => a.id));
  const targeted = athletesInScope.filter((a) => targets(q, groups.get(a.id) ?? []));
  if (!targeted.length) return { q, rows: [] };
  const versions = await tx.select().from(questionnaireVersions).where(eq(questionnaireVersions.questionnaireId, q.id));
  const responses = await tx
    .select()
    .from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.orgId, v.orgId), eq(questionnaireResponses.forDate, date), inArray(questionnaireResponses.athleteId, targeted.map((a) => a.id)), inArray(questionnaireResponses.versionId, versions.map((x) => x.id))));
  const rows: GridRow[] = [];
  for (const a of targeted) {
    const r = responses.find((x) => x.athleteId === a.id) ?? null;
    const ver = r ? versions.find((x) => x.id === r.versionId)! : null;
    const questions = ver?.questions ?? q.questions;
    const due = q.schedule.frequency === "pre_session" ? await hasSessionOn(tx, a.id, date) : isScheduledOn(q.schedule.frequency, date);
    const readiness = readinessV1(questions, r?.answers ?? null);
    const flags = wellnessFlags(questions, r?.answers ?? null, q.schedule.flagRules);
    if (readiness.score !== null && readiness.score < settings.readinessFlagBelow) {
      flags.push({ key: "tw_readiness_v1", label: "Teamwork readiness", value: Math.round(readiness.score), rule: `< ${settings.readinessFlagBelow}` });
    }
    rows.push({
      athleteId: a.id,
      name: a.name,
      status: completionStatus(questions, r?.answers ?? null, due || !!r),
      readiness,
      flags,
      answers: r?.answers ?? null,
      submittedAt: r?.submittedAt ?? null,
      version: ver?.version ?? null,
    });
  }
  return { q, rows };
}

export type WellnessSummary = { date: string; expected: number; answered: number; partial: number; noResponse: number; flagged: number };

/** Exported for dashboards: today's wellness completion across all active questionnaires in the viewer's scope. */
export async function wellnessCompletionSummary(tx: Tx, v: Viewer, date = todayLocal()): Promise<WellnessSummary> {
  const out: WellnessSummary = { date, expected: 0, answered: 0, partial: 0, noResponse: 0, flagged: 0 };
  for (const q of await listQuestionnaires(tx, v, { activeOnly: true })) {
    const grid = await completionGrid(tx, v, q.id, date);
    for (const r of grid?.rows ?? []) {
      if (r.status === "not_scheduled") continue;
      out.expected++;
      if (r.status === "answered") out.answered++;
      else if (r.status === "partial") out.partial++;
      else out.noResponse++;
      if (r.flags.length) out.flagged++;
    }
  }
  return out;
}

export type TrendPoint = { date: string; responded: boolean; readiness: number | null; values: Record<string, number | null>; version: number | null };

/** Per-item trend (numeric items only) plus tw_readiness_v1 for one athlete. Missing days are explicit. */
export async function wellnessTrend(tx: Tx, v: Viewer, input: { athleteId: string; questionnaireId: string; from: string; to: string }) {
  await requireOnAthlete(tx, v, input.athleteId, "health.read");
  const q = await getQuestionnaire(tx, v, input.questionnaireId);
  if (!q) return null;
  const versions = await tx.select().from(questionnaireVersions).where(eq(questionnaireVersions.questionnaireId, q.id));
  const rows = await tx
    .select()
    .from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.athleteId, input.athleteId), inArray(questionnaireResponses.versionId, versions.map((x) => x.id)), gte(questionnaireResponses.forDate, input.from), lte(questionnaireResponses.forDate, input.to)));
  const byDate = new Map(rows.map((r) => [r.forDate, r]));
  const points: TrendPoint[] = [];
  const numericKeys = q.questions.filter((x) => x.kind === "scale" || x.kind === "number").map((x) => x.key);
  for (let d = input.from; d <= input.to; d = addDaysYmd(d, 1)) {
    const r = byDate.get(d);
    const ver = r ? versions.find((x) => x.id === r.versionId) : null;
    const values: Record<string, number | null> = {};
    for (const k of numericKeys) {
      const val = r?.answers[k];
      values[k] = typeof val === "number" ? val : null;
    }
    points.push({ date: d, responded: !!r, readiness: r && ver ? readinessV1(ver.questions, r.answers).score : null, values, version: ver?.version ?? null });
  }
  return { q, points, numericKeys };
}

/** Daily readiness for overlays (load monitoring); only returned when the viewer has health.read. */
export async function readinessByDate(tx: Tx, v: Viewer, athleteId: string, from: string, to: string): Promise<Map<string, number | null> | null> {
  if (!(await canOnAthlete(tx, v, athleteId, "health.read"))) return null;
  const rows = await tx
    .select({ forDate: questionnaireResponses.forDate, answers: questionnaireResponses.answers, questions: questionnaireVersions.questions })
    .from(questionnaireResponses)
    .innerJoin(questionnaireVersions, eq(questionnaireVersions.id, questionnaireResponses.versionId))
    .where(and(eq(questionnaireResponses.athleteId, athleteId), eq(questionnaireResponses.orgId, v.orgId), gte(questionnaireResponses.forDate, from), lte(questionnaireResponses.forDate, to)));
  const out = new Map<string, number | null>();
  for (const r of rows) {
    const s = readinessV1(r.questions, r.answers).score;
    if (s !== null || !out.has(r.forDate)) out.set(r.forDate, s);
  }
  return out;
}
