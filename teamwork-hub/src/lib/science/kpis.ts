import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { bookings, exercises, groupMembers, kpiTargets, maxes, metricDefinitions, metricValues, scheduleSessions, testSessions, testTypes, trials } from "@/db/schema";
import { assertCan, AuthzError, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { localDayBounds, localToUtc, localYmd } from "@/lib/time";
import { actorOf, scopedAthletes } from "./access";
import { attendanceRate, changePct, classifyChange, convertUnit, isNum, selectTrials, swcBand, unitFamily } from "./formulas";

export type MetricDef = typeof metricDefinitions.$inferSelect;

export const VENDOR_LABEL: Record<string, string> = {
  hawkin: "Hawkin (vendor)",
  teambuildr: "TeamBuildr (vendor)",
  other_vendor: "Vendor",
  wearable: "Wearable",
  teamwork_manual: "Teamwork",
  teamwork_derived: "Teamwork-derived",
};
export const isVendor = (s: string) => s === "hawkin" || s === "teambuildr" || s === "other_vendor";

export const metricInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase_with_underscores"),
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(20),
  higherIsBetter: z.enum(["true", "false", ""]).transform((x) => (x === "" ? null : x === "true")),
  category: z.enum(["sprint", "jump", "strength", "force_plate", "wearable", "attendance", "anthropometric", "other"]),
  definedBy: z.enum(["teamwork_manual", "teamwork_derived", "hawkin", "teambuildr", "other_vendor"]),
  precision: z.coerce.number().int().min(0).max(4),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function createMetric(tx: Tx, v: Viewer, raw: z.input<typeof metricInput>) {
  assertCan(v, "science.manage");
  const input = metricInput.parse(raw);
  const [m] = await tx.insert(metricDefinitions).values({ orgId: v.orgId, ...input, description: input.description || null }).returning();
  await audit(tx, actorOf(v), "science.metric.create", "metric_definition", m.id, { summary: `Metric "${m.name}" (${m.unit})`, after: input });
  return m;
}

export const testTypeInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, "lowercase_with_underscores"),
  name: z.string().trim().min(1).max(80),
  vendor: z.enum(["teamwork", "hawkin", "teambuildr", "other"]),
  protocol: z.string().trim().max(1000).optional().nullable(),
  trialSelection: z.enum(["best", "mean", "latest"]),
});

export async function createTestType(tx: Tx, v: Viewer, raw: z.input<typeof testTypeInput>) {
  assertCan(v, "science.manage");
  const input = testTypeInput.parse(raw);
  const [t] = await tx.insert(testTypes).values({ orgId: v.orgId, ...input, protocol: input.protocol || null }).returning();
  await audit(tx, actorOf(v), "science.test_type.create", "test_type", t.id, { summary: `Test type "${t.name}"`, after: input });
  return t;
}

export async function listMetrics(tx: Tx, v: Viewer) {
  return tx.select().from(metricDefinitions).where(eq(metricDefinitions.orgId, v.orgId)).orderBy(asc(metricDefinitions.category), asc(metricDefinitions.name));
}
export async function listTestTypes(tx: Tx, v: Viewer) {
  return tx.select().from(testTypes).where(eq(testTypes.orgId, v.orgId)).orderBy(asc(testTypes.name));
}

export const testEntryInput = z.object({
  athleteId: z.string().uuid(),
  testTypeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
  notes: z.string().trim().max(500).optional().nullable(),
  /** One entry per metric per trial; value null = not measured (stored as null, never 0). */
  values: z
    .array(z.object({ metricId: z.string().uuid(), trialNumber: z.number().int().min(1).max(20), value: z.number().nullable(), unit: z.string().max(20) }))
    .min(1, "Enter at least one value"),
});

/** Manual test entry: one session, numbered trials, one metric_value per metric per trial (units kept as entered). */
export async function recordTestSession(tx: Tx, v: Viewer, raw: z.input<typeof testEntryInput>) {
  const input = testEntryInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "training.write");
  const [tt] = await tx.select().from(testTypes).where(and(eq(testTypes.id, input.testTypeId), eq(testTypes.orgId, v.orgId)));
  if (!tt) throw new AuthzError();
  const defs = await tx.select().from(metricDefinitions).where(and(eq(metricDefinitions.orgId, v.orgId), inArray(metricDefinitions.id, [...new Set(input.values.map((x) => x.metricId))])));
  for (const x of input.values) {
    const d = defs.find((m) => m.id === x.metricId);
    if (!d) throw new AuthzError();
    x.unit = x.unit.trim() || d.unit;
    if (x.unit !== d.unit && convertUnit(1, x.unit, d.unit) === null) throw new UserError(`"${x.unit}" can't be converted to ${d.name}'s unit (${d.unit}).`);
  }
  if (input.values.every((x) => x.value === null)) throw new UserError("Enter at least one measured value.");
  const testedAt = localToUtc(input.date, input.time);
  const [s] = await tx
    .insert(testSessions)
    .values({ orgId: v.orgId, athleteId: input.athleteId, testTypeId: tt.id, testedAt, sourceTimestamp: `${input.date}T${input.time} America/Indiana/Indianapolis`, source: "teamwork_manual", notes: input.notes || null })
    .returning();
  const trialNumbers = [...new Set(input.values.map((x) => x.trialNumber))].sort((a, b) => a - b);
  const trialIds = new Map<number, string>();
  for (const n of trialNumbers) {
    const [t] = await tx.insert(trials).values({ testSessionId: s.id, trialNumber: n, performedAt: testedAt, sourceTrialId: `manual-${n}` }).returning();
    trialIds.set(n, t.id);
  }
  for (const x of input.values) {
    await tx.insert(metricValues).values({
      orgId: v.orgId,
      athleteId: input.athleteId,
      metricDefinitionId: x.metricId,
      testSessionId: s.id,
      trialId: trialIds.get(x.trialNumber)!,
      value: x.value,
      rawValue: x.value === null ? null : String(x.value),
      unit: x.unit,
      recordedAt: testedAt,
      source: "teamwork_manual",
      aggregation: "trial",
      enteredBy: v.userId,
    });
  }
  await audit(tx, actorOf(v), "science.test.record", "test_session", s.id, { summary: `${tt.name}: ${trialNumbers.length} trial(s), ${input.values.length} value(s)` });
  return s;
}

export async function setTrialExcluded(tx: Tx, v: Viewer, input: { trialId: string; excluded: boolean; reason?: string | null }) {
  const [row] = await tx
    .select({ t: trials, athleteId: testSessions.athleteId })
    .from(trials)
    .innerJoin(testSessions, eq(testSessions.id, trials.testSessionId))
    .where(and(eq(trials.id, input.trialId), eq(testSessions.orgId, v.orgId)));
  if (!row) throw new AuthzError();
  await requireOnAthlete(tx, v, row.athleteId, "training.write");
  if (row.t.isAggregate) throw new UserError("Vendor aggregate rows are never used as trials, so they can't be included/excluded.");
  if (input.excluded && !input.reason) throw new UserError("Give a reason for excluding the trial.", { reason: "Required" });
  await tx.update(trials).set({ excluded: input.excluded, exclusionReason: input.excluded ? input.reason ?? null : null }).where(eq(trials.id, row.t.id));
  await audit(tx, actorOf(v), input.excluded ? "science.trial.exclude" : "science.trial.include", "trial", row.t.id, { summary: input.reason ?? undefined, before: { excluded: row.t.excluded }, after: { excluded: input.excluded } });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const targetInput = z
  .object({
    metricDefinitionId: z.string().uuid(),
    athleteId: z.string().uuid().optional().nullable(),
    groupId: z.string().uuid().optional().nullable(),
    baselineValue: z.coerce.number().optional().nullable(),
    baselineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    targetValue: z.coerce.number(),
    goalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    trialSelection: z.enum(["best", "mean", "latest"]),
  })
  .refine((x) => !!x.athleteId !== !!x.groupId, "Choose an athlete OR a group");

export async function setKpiTarget(tx: Tx, v: Viewer, raw: z.input<typeof targetInput>) {
  assertCan(v, "science.manage");
  const input = targetInput.parse(raw);
  const [m] = await tx.select().from(metricDefinitions).where(and(eq(metricDefinitions.id, input.metricDefinitionId), eq(metricDefinitions.orgId, v.orgId)));
  if (!m) throw new AuthzError();
  if (input.athleteId) await requireOnAthlete(tx, v, input.athleteId, "training.write");
  if (input.groupId) {
    const members = await tx.select().from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
    if (!members.length) throw new UserError("That group has no members.");
    for (const mm of members) await requireOnAthlete(tx, v, mm.athleteId, "training.write");
  }
  const [t] = await tx.insert(kpiTargets).values({ orgId: v.orgId, ...input, athleteId: input.athleteId ?? null, groupId: input.groupId ?? null, baselineValue: input.baselineValue ?? null, baselineDate: input.baselineDate ?? null, goalDate: input.goalDate ?? null, createdBy: v.userId }).returning();
  await audit(tx, actorOf(v), "science.kpi_target.set", "kpi_target", t.id, { summary: `Target ${input.targetValue} ${m.unit} for ${m.name}`, after: input });
  return t;
}

// ---------------------------------------------------------------------------
// Athlete KPI series
// ---------------------------------------------------------------------------

export type TrialRow = {
  trialId: string;
  trialNumber: number | null;
  value: number | null;
  rawValue: string | null;
  enteredUnit: string;
  /** Value converted to the metric's unit, or null if missing/incompatible. */
  converted: number | null;
  isAggregate: boolean;
  aggregateKind: string | null;
  excluded: boolean;
  exclusionReason: string | null;
};

export type SessionPoint = {
  sessionId: string;
  testedAt: Date;
  date: string;
  testTypeName: string;
  source: string;
  device: string | null;
  rule: "best" | "mean" | "latest";
  value: number | null;
  n: number;
  vendorAggregate: number | null;
  reason: string | null;
  trials: TrialRow[];
  convertedFromUnits: string[];
};

export type MetricSeries = {
  metric: MetricDef;
  points: SessionPoint[];
  latest: SessionPoint | null;
  baseline: { value: number; date: string | null; source: "target" | "first_session" } | null;
  target: { value: number; goalDate: string | null; scope: "athlete" | "group" } | null;
  swc: number | null;
  change: number | null;
  changePct: number | null;
  classification: ReturnType<typeof classifyChange>;
};

export async function targetsForAthlete(tx: Tx, orgId: string, athleteId: string) {
  const gids = (await tx.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.athleteId, athleteId))).map((r) => r.g);
  const rows = await tx
    .select()
    .from(kpiTargets)
    .where(and(eq(kpiTargets.orgId, orgId), or(eq(kpiTargets.athleteId, athleteId), gids.length ? inArray(kpiTargets.groupId, gids) : sql`false`)))
    .orderBy(asc(kpiTargets.createdAt));
  // Latest athlete-specific target wins over a group target.
  const out = new Map<string, typeof kpiTargets.$inferSelect & { scope: "athlete" | "group" }>();
  for (const r of rows.filter((x) => x.groupId)) out.set(r.metricDefinitionId, { ...r, scope: "group" });
  for (const r of rows.filter((x) => x.athleteId)) out.set(r.metricDefinitionId, { ...r, scope: "athlete" });
  return out;
}

export async function athleteMetricSeries(tx: Tx, v: Viewer, athleteId: string, opts: { from?: string; to?: string; metricIds?: string[]; category?: string } = {}): Promise<MetricSeries[]> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const fromTs = opts.from ? localDayBounds(opts.from).start : null;
  const toTs = opts.to ? localDayBounds(opts.to).end : null;
  const rows = await tx
    .select({ mv: metricValues, t: trials, s: testSessions, tt: testTypes })
    .from(metricValues)
    .innerJoin(testSessions, eq(testSessions.id, metricValues.testSessionId))
    .innerJoin(testTypes, eq(testTypes.id, testSessions.testTypeId))
    .leftJoin(trials, eq(trials.id, metricValues.trialId))
    .where(
      and(
        eq(metricValues.orgId, v.orgId),
        eq(metricValues.athleteId, athleteId),
        opts.metricIds?.length ? inArray(metricValues.metricDefinitionId, opts.metricIds) : undefined,
        fromTs ? gte(testSessions.testedAt, fromTs) : undefined,
        toTs ? lte(testSessions.testedAt, toTs) : undefined,
      ),
    )
    .orderBy(asc(testSessions.testedAt), asc(trials.trialNumber));
  const defs = await listMetrics(tx, v);
  const targets = await targetsForAthlete(tx, v.orgId, athleteId);
  const out: MetricSeries[] = [];
  for (const metric of defs) {
    if (opts.category && metric.category !== opts.category) continue;
    if (opts.metricIds?.length && !opts.metricIds.includes(metric.id)) continue;
    const mine = rows.filter((r) => r.mv.metricDefinitionId === metric.id);
    if (!mine.length && !targets.has(metric.id)) continue;
    const target = targets.get(metric.id);
    const bySession = new Map<string, typeof mine>();
    for (const r of mine) bySession.set(r.s.id, [...(bySession.get(r.s.id) ?? []), r]);
    const points: SessionPoint[] = [];
    for (const list of bySession.values()) {
      const { s, tt } = list[0];
      const rule = target?.trialSelection ?? tt.trialSelection;
      const trialRows: TrialRow[] = list.map((r) => ({
        trialId: r.t?.id ?? r.mv.id,
        trialNumber: r.t?.trialNumber ?? null,
        value: r.mv.value,
        rawValue: r.mv.rawValue,
        enteredUnit: r.mv.unit,
        converted: convertUnit(r.mv.value, r.mv.unit, metric.unit),
        isAggregate: r.t?.isAggregate ?? (r.mv.aggregation === "vendor_mean" || r.mv.aggregation === "vendor_best"),
        aggregateKind: r.t?.aggregateKind ?? null,
        excluded: r.t?.excluded ?? false,
        exclusionReason: r.t?.exclusionReason ?? null,
      }));
      const sel = selectTrials(
        trialRows.map((t) => ({ trialId: t.trialId, trialNumber: t.trialNumber, value: t.converted, isAggregate: t.isAggregate, excluded: t.excluded })),
        rule,
        metric.higherIsBetter,
      );
      points.push({
        sessionId: s.id,
        testedAt: s.testedAt!,
        date: localYmd(s.testedAt!),
        testTypeName: tt.name,
        source: s.source,
        device: s.device,
        rule,
        value: sel.value,
        n: sel.n,
        vendorAggregate: sel.vendorAggregate,
        reason: sel.reason,
        trials: trialRows,
        convertedFromUnits: [...new Set(trialRows.filter((t) => t.enteredUnit !== metric.unit && t.value !== null).map((t) => t.enteredUnit))],
      });
    }
    const valued = points.filter((p) => isNum(p.value));
    const latest = valued.at(-1) ?? null;
    const baseline = isNum(target?.baselineValue)
      ? { value: target!.baselineValue!, date: target!.baselineDate, source: "target" as const }
      : valued[0]
        ? { value: valued[0].value!, date: valued[0].date, source: "first_session" as const }
        : null;
    const swc = swcBand(points.map((p) => p.value));
    const change = latest && baseline ? latest.value! - baseline.value : null;
    out.push({
      metric,
      points,
      latest,
      baseline,
      target: target ? { value: target.targetValue, goalDate: target.goalDate, scope: target.scope } : null,
      swc,
      change,
      changePct: changePct(latest?.value ?? null, baseline?.value ?? null),
      classification: classifyChange(change, swc, metric.higherIsBetter),
    });
  }
  return out;
}

/** Group dashboard: latest selected value per athlete for one metric (viewer's training.read scope only). */
export async function groupKpiTable(tx: Tx, v: Viewer, input: { metricId: string; groupId?: string | null; leaderboard?: boolean }) {
  const [metric] = await tx.select().from(metricDefinitions).where(and(eq(metricDefinitions.id, input.metricId), eq(metricDefinitions.orgId, v.orgId)));
  if (!metric) return null;
  let athletes = await scopedAthletes(tx, v, "training.read");
  if (input.groupId) {
    const members = new Set((await tx.select().from(groupMembers).where(eq(groupMembers.groupId, input.groupId))).map((m) => m.athleteId));
    athletes = athletes.filter((a) => members.has(a.id));
  }
  const rows = [];
  for (const a of athletes) {
    const [s] = await athleteMetricSeries(tx, v, a.id, { metricIds: [metric.id] });
    rows.push({ athlete: a, series: s ?? null });
  }
  // Leaderboard is opt-in, staff only, and never includes athletes outside the viewer's scope.
  const leaderboard = !!input.leaderboard && isStaff(v) && metric.higherIsBetter !== null;
  if (leaderboard) {
    rows.sort((x, y) => {
      const a = x.series?.latest?.value ?? null;
      const b = y.series?.latest?.value ?? null;
      if (a === null) return 1;
      if (b === null) return -1;
      return metric.higherIsBetter ? b - a : a - b;
    });
  }
  return { metric, rows, leaderboard };
}

// ---------------------------------------------------------------------------
// Attendance KPI (bookings, status "attended") and strength PRs (maxes)
// ---------------------------------------------------------------------------

export async function attendanceKpi(tx: Tx, v: Viewer, athleteId: string, from: string, to: string) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const rows = await tx
    .select({ status: bookings.status, n: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, v.orgId), eq(bookings.athleteId, athleteId), gte(scheduleSessions.startsAt, localDayBounds(from).start), lte(scheduleSessions.startsAt, localDayBounds(to).end)))
    .groupBy(bookings.status);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const attended = get("attended");
  const noShow = get("no_show");
  return { formula: "attendance_rate_v1" as const, from, to, attended, noShow, upcomingOrBooked: get("booked"), cancelled: get("cancelled") + get("late_cancelled"), ratePct: attendanceRate(attended, noShow) };
}

export async function strengthPrs(tx: Tx, v: Viewer, athleteId: string, opts: { from?: string; to?: string } = {}) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const rows = await tx
    .select({ m: maxes, name: exercises.name })
    .from(maxes)
    .innerJoin(exercises, eq(exercises.id, maxes.exerciseId))
    .where(and(eq(maxes.orgId, v.orgId), eq(maxes.athleteId, athleteId), opts.to ? lte(maxes.recordedOn, opts.to) : undefined))
    .orderBy(asc(maxes.recordedOn));
  const byEx = new Map<string, { exercise: string; best: { value: number; unit: string; date: string; kind: string; method: string }; first: { value: number; unit: string; date: string }; inPeriod: boolean }>();
  for (const { m, name } of rows) {
    if (unitFamily(m.unit) !== "mass") continue;
    const val = Number(m.value);
    const prev = byEx.get(m.exerciseId);
    const inPeriod = !opts.from || m.recordedOn >= opts.from;
    if (!prev) {
      byEx.set(m.exerciseId, { exercise: name, best: { value: val, unit: m.unit, date: m.recordedOn, kind: m.kind, method: m.method }, first: { value: val, unit: m.unit, date: m.recordedOn }, inPeriod });
      continue;
    }
    const inBestUnit = convertUnit(val, m.unit, prev.best.unit);
    if (isNum(inBestUnit) && inBestUnit > prev.best.value) prev.best = { value: val, unit: m.unit, date: m.recordedOn, kind: m.kind, method: m.method };
    prev.inPeriod ||= inPeriod;
  }
  return [...byEx.values()].map((x) => ({ ...x, prInPeriod: !opts.from || x.best.date >= opts.from }));
}

