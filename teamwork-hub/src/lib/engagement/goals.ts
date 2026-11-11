import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { BAR_SPEED_SOURCE } from "@/lib/training/vbt";
import { z } from "zod";
import type { Tx } from "@/db";
import { athleteGoals, athletes, exercises, maxes, metricDefinitions, metricValues, type GoalBaselineContext, type GoalDirection } from "@/db/schema";
import { AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError, zEmptyToUndef } from "@/lib/actions";
import { compareContexts } from "@/lib/science/comparability";
import { convertUnit, isNum, unitFamily } from "@/lib/science/formulas";
import { athleteMetricSeries } from "@/lib/science/kpis";
import { daysBetween, todayLocal } from "@/lib/time";
import { engagementAccess, requireEngagement } from "./access";
import { maxBasisOf, type MaxBasis } from "./prs";

export type Goal = typeof athleteGoals.$inferSelect;
export const MAX_ACTIVE_GOALS = 8;

/**
 * Progress toward a target (pure). `pct` is null when it cannot be stated honestly: nothing
 * measured yet, or no comparable starting value. A goal that is met is always 100.
 */
export function goalProgress(input: { baseline: number | null; current: number | null; target: number; direction: GoalDirection }): { pct: number | null; met: boolean } {
  const { baseline, current, target, direction } = input;
  if (!isNum(current)) return { pct: null, met: false };
  const met = direction === "increase" ? current >= target : current <= target;
  if (met) return { pct: 100, met };
  if (!isNum(baseline)) return { pct: null, met };
  const span = target - baseline;
  if ((direction === "increase" && span <= 0) || (direction === "decrease" && span >= 0)) return { pct: null, met };
  return { pct: Math.max(0, Math.min(99, Math.round(((current - baseline) / span) * 100))), met };
}

/**
 * Internal org-scoped reader identity for the derived computations below. Callers have already
 * authorized the real viewer (or are the system refresh); this never widens what a user sees.
 */
const systemViewer = (orgId: string): Viewer => ({ userId: "00000000-0000-0000-0000-000000000000", orgId, role: "admin", personId: null, displayName: "System", mfaVerified: true });

type Measured = {
  /** Latest comparable value in the goal's target unit (null = nothing measured). */
  current: number | null;
  currentDate: string | null;
  /** Starting value, only when it was measured the same way as `current`. */
  baseline: number | null;
  context: GoalBaselineContext | null;
  note: string | null;
};

export const INCOMPARABLE_LATEST = "The latest result was measured a different way than when this goal was set, so it is not counted toward it.";

async function measure(tx: Tx, orgId: string, g: Goal): Promise<Measured> {
  const none: Measured = { current: null, currentDate: null, baseline: null, context: null, note: null };
  if (!g.targetUnit) return none;
  if (g.metricDefinitionId) {
    // athleteMetricSeries applies the comparability rules: `latest` and `context` describe the newest
    // usable session, and sessions measured another way are excluded, never merged.
    const [s] = await athleteMetricSeries(tx, systemViewer(orgId), g.athleteId, { metricIds: [g.metricDefinitionId] });
    if (!s?.latest || !s.context) return { ...none, baseline: null };
    const current = convertUnit(s.latest.value, s.metric.unit, g.targetUnit);
    if (!isNum(current)) return { ...none, note: `Results in ${s.metric.unit} cannot be converted to ${g.targetUnit}.` };
    const context: GoalBaselineContext = { ...s.context, unit: g.targetUnit };
    // A goal is pinned to the way its starting value was measured. A newer result measured another
    // way (different protocol, source, aggregation…) is not counted toward it, and never checks it off.
    if (g.baselineContext && !compareContexts(context, g.baselineContext).comparable) return { ...none, note: INCOMPARABLE_LATEST };
    const note = s.excluded.length ? "Some results were measured a different way and are left out." : null;
    return { current, currentDate: s.latest.date, baseline: isNum(g.baselineValue) && g.baselineContext ? g.baselineValue : null, context, note };
  }
  if (g.exerciseId) {
    const basis: MaxBasis = g.maxBasis ?? "measured";
    const rows = await tx
      .select({ value: maxes.value, unit: maxes.unit, kind: maxes.kind, recordedOn: maxes.recordedOn })
      .from(maxes)
      .where(and(eq(maxes.orgId, orgId), eq(maxes.athleteId, g.athleteId), eq(maxes.exerciseId, g.exerciseId), ne(maxes.source, BAR_SPEED_SOURCE)))
      .orderBy(asc(maxes.recordedOn), asc(maxes.createdAt));
    let best: { value: number; date: string } | null = null;
    let otherBasis = false;
    for (const r of rows) {
      if (maxBasisOf(r.kind) !== basis) {
        otherBasis = true;
        continue;
      }
      const v = convertUnit(Number(r.value), r.unit, g.targetUnit);
      if (!isNum(v)) continue;
      if (!best || v > best.value) best = { value: v, date: r.recordedOn };
    }
    return {
      current: best?.value ?? null,
      currentDate: best?.date ?? null,
      baseline: isNum(g.baselineValue) ? g.baselineValue : null,
      context: null,
      note: otherBasis ? `Only ${basis === "measured" ? "tested" : "estimated"} maxes count toward this goal.` : null,
    };
  }
  return none;
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date");
export const goalInput = z.object({
  athleteId: z.string().uuid(),
  title: z.string().trim().min(2, "Give the goal a short name").max(120),
  /** "" (free text) | "metric:<uuid>" | "exercise:<uuid>" */
  link: z
    .string()
    .regex(/^(|metric:[0-9a-f-]{36}|exercise:[0-9a-f-]{36})$/i)
    .default(""),
  targetValue: zEmptyToUndef(z.coerce.number().finite().optional()),
  targetUnit: zEmptyToUndef(z.string().trim().max(20).optional()),
  direction: zEmptyToUndef(z.enum(["increase", "decrease"]).optional()),
  targetDate: zEmptyToUndef(ymd.optional()),
});

export async function createGoal(tx: Tx, v: Viewer, raw: unknown, today = todayLocal()): Promise<Goal> {
  const input = goalInput.parse(raw);
  const access = await requireEngagement(tx, v, input.athleteId, "writeGoals");
  const [athlete] = await tx.select({ id: athletes.id, isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, input.athleteId), eq(athletes.orgId, v.orgId)));
  if (!athlete) throw new AuthzError();
  if (input.targetDate && input.targetDate < today) throw new UserError("Pick a target date that is still ahead.", { targetDate: "Must be today or later" });
  const [{ n: active }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(athleteGoals)
    .where(and(eq(athleteGoals.orgId, v.orgId), eq(athleteGoals.athleteId, athlete.id), eq(athleteGoals.status, "active")));
  if (active >= MAX_ACTIVE_GOALS) throw new UserError(`There are already ${MAX_ACTIVE_GOALS} active goals. Finish or archive one first.`);

  const values: typeof athleteGoals.$inferInsert = { orgId: v.orgId, athleteId: athlete.id, title: input.title, targetDate: input.targetDate ?? null, createdBy: v.userId, isDemo: athlete.isDemo };
  const [kind, linkId] = input.link ? (input.link.split(":") as ["metric" | "exercise", string]) : [null, null];
  if (kind) {
    if (!access.canLinkMeasuredGoals) throw new AuthzError("Your account cannot link a goal to test results for this athlete.");
    if (!isNum(input.targetValue)) throw new UserError("Enter the target number.", { targetValue: "Required" });
    values.targetValue = input.targetValue;
    if (kind === "metric") {
      const [m] = await tx.select().from(metricDefinitions).where(and(eq(metricDefinitions.id, linkId), eq(metricDefinitions.orgId, v.orgId)));
      if (!m) throw new AuthzError();
      const unit = input.targetUnit || m.unit;
      if (convertUnit(1, unit, m.unit) === null) throw new UserError(`"${unit}" can't be converted to ${m.name}'s unit (${m.unit}).`, { targetUnit: `Use ${m.unit}` });
      const direction = input.direction ?? (m.higherIsBetter === null ? null : m.higherIsBetter ? "increase" : "decrease");
      if (!direction) throw new UserError("Choose whether the number should go up or down.", { direction: "Required" });
      Object.assign(values, { metricDefinitionId: m.id, targetUnit: unit, direction });
    } else {
      const [ex] = await tx.select().from(exercises).where(and(eq(exercises.id, linkId), eq(exercises.orgId, v.orgId)));
      if (!ex) throw new AuthzError();
      const [latest] = await tx
        .select({ unit: maxes.unit, kind: maxes.kind })
        .from(maxes)
        .where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athlete.id), eq(maxes.exerciseId, ex.id), ne(maxes.source, BAR_SPEED_SOURCE)))
        .orderBy(desc(maxes.recordedOn), desc(maxes.createdAt))
        .limit(1);
      const unit = input.targetUnit || latest?.unit || (unitFamily(ex.defaultUnit) === "mass" ? ex.defaultUnit : "lb");
      if (unitFamily(unit) !== "mass") throw new UserError("Max goals use lb or kg.", { targetUnit: "Use lb or kg" });
      Object.assign(values, { exerciseId: ex.id, targetUnit: unit, direction: input.direction ?? "increase", maxBasis: latest ? maxBasisOf(latest.kind) : "measured" });
    }
    const m = await measure(tx, v.orgId, { ...(values as Goal), baselineValue: null, baselineContext: null });
    if (goalProgress({ baseline: null, current: m.current, target: values.targetValue!, direction: values.direction! }).met) {
      throw new UserError("That target is already met. Pick one that stretches a little further.", { targetValue: "Already met" });
    }
    values.baselineValue = m.current;
    values.baselineContext = m.context;
  }
  const [g] = await tx.insert(athleteGoals).values(values).returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "engagement.goal.create", "athlete_goal", g.id, {
    summary: `Goal "${g.title}"${g.targetValue !== null ? ` (target ${g.targetValue} ${g.targetUnit})` : ""}`,
    after: { athleteId: g.athleteId, metricDefinitionId: g.metricDefinitionId, exerciseId: g.exerciseId, targetValue: g.targetValue, targetUnit: g.targetUnit, direction: g.direction, targetDate: g.targetDate },
  });
  return g;
}

export type GoalAction = "achieve" | "archive" | "reopen";

/** Manual check-off, archive, or reopen. The goal id comes from the client, so scope is re-checked here. */
export async function setGoalStatus(tx: Tx, v: Viewer, goalId: string, action: GoalAction): Promise<Goal> {
  if (!/^[0-9a-f-]{36}$/i.test(goalId)) throw new AuthzError();
  const [g] = await tx.select().from(athleteGoals).where(and(eq(athleteGoals.id, goalId), eq(athleteGoals.orgId, v.orgId))).for("update");
  if (!g) throw new AuthzError();
  await requireEngagement(tx, v, g.athleteId, "writeGoals");
  let patch: Partial<typeof athleteGoals.$inferInsert>;
  if (action === "achieve") {
    if (g.status !== "active") throw new UserError("That goal is not active.");
    if (g.metricDefinitionId || g.exerciseId) throw new UserError("This goal is checked off automatically when a new result reaches the target.");
    patch = { status: "achieved", achievedAt: new Date() };
  } else if (action === "archive") {
    if (g.status !== "active") throw new UserError("Only active goals can be archived.");
    patch = { status: "archived" };
  } else {
    if (g.status !== "archived") throw new UserError("Only archived goals can be reopened.");
    patch = { status: "active" };
  }
  const [after] = await tx.update(athleteGoals).set({ ...patch, updatedAt: new Date() }).where(eq(athleteGoals.id, g.id)).returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, `engagement.goal.${action === "achieve" ? "achieved" : action}`, "athlete_goal", g.id, {
    summary: `Goal "${g.title}" ${action === "achieve" ? "checked off" : action === "archive" ? "archived" : "reopened"}`,
    before: { status: g.status },
    after: { status: after.status },
  });
  return after;
}

/**
 * System pass: mark linked goals achieved when the latest comparable value meets the target
 * (audited; XP follows in syncXp), and capture a starting value for goals set before anything
 * was measured. Idempotent and safe to run concurrently.
 */
export async function evaluateGoals(tx: Tx, orgId: string, athleteId: string): Promise<string[]> {
  const active = await tx
    .select()
    .from(athleteGoals)
    .where(and(eq(athleteGoals.orgId, orgId), eq(athleteGoals.athleteId, athleteId), eq(athleteGoals.status, "active"), sql`(${athleteGoals.metricDefinitionId} is not null or ${athleteGoals.exerciseId} is not null)`));
  const achieved: string[] = [];
  for (const g of active) {
    if (!isNum(g.targetValue) || !g.direction) continue;
    const m = await measure(tx, orgId, g);
    if (!isNum(m.current)) continue;
    if (goalProgress({ baseline: m.baseline, current: m.current, target: g.targetValue, direction: g.direction }).met) {
      const rows = await tx
        .update(athleteGoals)
        .set({ status: "achieved", achievedAt: new Date(), achievedValue: m.current, updatedAt: new Date() })
        .where(and(eq(athleteGoals.id, g.id), eq(athleteGoals.status, "active")))
        .returning({ id: athleteGoals.id });
      if (!rows.length) continue; // another request got there first
      achieved.push(g.id);
      await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "engagement.goal.achieved", "athlete_goal", g.id, {
        summary: `Goal "${g.title}" reached automatically: ${m.current} ${g.targetUnit} vs target ${g.targetValue} ${g.targetUnit}${m.currentDate ? ` (result dated ${m.currentDate})` : ""}`,
        before: { status: "active" },
        after: { status: "achieved", achievedValue: m.current },
      });
    } else if (g.baselineValue === null) {
      await tx.update(athleteGoals).set({ baselineValue: m.current, baselineContext: m.context, updatedAt: new Date() }).where(and(eq(athleteGoals.id, g.id), sql`${athleteGoals.baselineValue} is null`));
    }
  }
  return achieved;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type GoalView = {
  id: string;
  title: string;
  status: Goal["status"];
  targetDate: string | null;
  daysLeft: number | null;
  achievedAt: Date | null;
  createdAt: Date;
  /** What the goal is tied to. The target is part of the goal itself, so it shows with the title. */
  link: { type: "metric" | "exercise"; label: string; targetValue: number; targetUnit: string; direction: GoalDirection } | null;
  /** Measured values. Null for free-text goals and for viewers without training access. */
  progress: { current: number | null; currentDate: string | null; baseline: number | null; pct: number | null; note: string | null; achievedValue: number | null } | null;
};

/** Goals for one athlete, newest first within each status. Measured values only with training access. */
export async function listGoals(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string; status?: Goal["status"][] } = {}): Promise<GoalView[]> {
  const access = await requireEngagement(tx, v, athleteId, "goals");
  const today = opts.today ?? todayLocal();
  const rows = await tx
    .select({ g: athleteGoals, metric: metricDefinitions.name, exercise: exercises.name })
    .from(athleteGoals)
    .leftJoin(metricDefinitions, eq(metricDefinitions.id, athleteGoals.metricDefinitionId))
    .leftJoin(exercises, eq(exercises.id, athleteGoals.exerciseId))
    .where(and(eq(athleteGoals.orgId, v.orgId), eq(athleteGoals.athleteId, athleteId), opts.status ? inArray(athleteGoals.status, opts.status) : undefined))
    .orderBy(desc(athleteGoals.createdAt));
  const out: GoalView[] = [];
  for (const { g, metric, exercise } of rows) {
    const linked = (g.metricDefinitionId || g.exerciseId) && isNum(g.targetValue) && g.targetUnit && g.direction;
    let progress: GoalView["progress"] = null;
    if (linked && access.canSeeTraining) {
      if (g.status === "achieved") progress = { current: g.achievedValue, currentDate: null, baseline: g.baselineValue, pct: 100, note: null, achievedValue: g.achievedValue };
      else {
        const m = await measure(tx, v.orgId, g);
        progress = { current: m.current, currentDate: m.currentDate, baseline: m.baseline, pct: goalProgress({ baseline: m.baseline, current: m.current, target: g.targetValue!, direction: g.direction! }).pct, note: m.note, achievedValue: null };
      }
    }
    out.push({
      id: g.id,
      title: g.title,
      status: g.status,
      targetDate: g.targetDate,
      daysLeft: g.targetDate && g.status === "active" ? daysBetween(today, g.targetDate) : null,
      achievedAt: g.achievedAt,
      createdAt: g.createdAt,
      link: linked ? { type: g.metricDefinitionId ? "metric" : "exercise", label: g.metricDefinitionId ? (metric ?? "Test result") : `${exercise ?? "Exercise"} max`, targetValue: g.targetValue!, targetUnit: g.targetUnit!, direction: g.direction! } : null,
      progress,
    });
  }
  const rank = { active: 0, achieved: 1, archived: 2 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

export type GoalOptions = { metrics: { id: string; name: string; unit: string }[]; exercises: { id: string; name: string; unit: string }[] };

/** What a new goal can be tied to: things this athlete already has results for (staff may pick any). */
export async function goalLinkOptions(tx: Tx, v: Viewer, athleteId: string): Promise<GoalOptions> {
  const access = await engagementAccess(tx, v, athleteId);
  if (!access.canLinkMeasuredGoals) return { metrics: [], exercises: [] };
  const withValues = (await tx.selectDistinct({ id: metricValues.metricDefinitionId }).from(metricValues).where(and(eq(metricValues.orgId, v.orgId), eq(metricValues.athleteId, athleteId)))).map((r) => r.id);
  const withMaxes = await tx.selectDistinct({ id: maxes.exerciseId, unit: maxes.unit }).from(maxes).where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athleteId)));
  const staff = isStaff(v);
  const metrics = (await tx.select().from(metricDefinitions).where(eq(metricDefinitions.orgId, v.orgId)).orderBy(asc(metricDefinitions.name))).filter((m) => staff || withValues.includes(m.id));
  const exs = (await tx.select().from(exercises).where(and(eq(exercises.orgId, v.orgId), eq(exercises.active, true))).orderBy(asc(exercises.name))).filter((e) =>
    withMaxes.some((x) => x.id === e.id) || (staff && e.trackingType === "weight_reps"),
  );
  return {
    metrics: metrics.map((m) => ({ id: m.id, name: m.name, unit: m.unit })),
    exercises: exs.map((e) => ({ id: e.id, name: e.name, unit: withMaxes.find((x) => x.id === e.id)?.unit ?? (unitFamily(e.defaultUnit) === "mass" ? e.defaultUnit : "lb") })),
  };
}
