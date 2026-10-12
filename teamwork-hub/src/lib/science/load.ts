import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { activitySessions, workouts } from "@/db/schema";
import { requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { addDaysYmd, DEFAULT_TZ, localDayBounds, localYmd, todayLocal } from "@/lib/time";
import { actorOf, scienceSettings, scopedAthletes } from "./access";
import { acwrRolling, dailyLoadSeries, monotonyStrain, srpeLoad, weeklyTotals, type AcwrResult, type DailyLoad, type LoadEntry } from "./formulas";
import { readinessByDate } from "./wellness";

export const activityInput = z
  .object({
    athleteId: z.string().uuid(),
    activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(["practice", "game", "conditioning", "training", "other", "rest"]),
    durationMinutes: z.coerce.number().int().min(0).max(600).optional().nullable(),
    sessionRpe: z.coerce.number().int().min(0).max(10).optional().nullable(),
    notes: z.string().trim().max(300).optional().nullable(),
  })
  .refine((x) => x.kind === "rest" || (x.durationMinutes != null && x.sessionRpe != null), { message: "Duration and session RPE are required (or choose 'Rest day')", path: ["sessionRpe"] });

export async function logActivity(tx: Tx, v: Viewer, raw: z.input<typeof activityInput>, now = new Date()) {
  const input = activityInput.parse(raw);
  await requireOnAthlete(tx, v, input.athleteId, "training.log");
  const today = todayLocal(undefined, now);
  if (input.activityDate > today) throw new UserError("Can't log activity in the future.");
  if (input.activityDate < addDaysYmd(today, -30)) throw new UserError("Activity can be back-filled for up to 30 days.");
  if (input.kind === "rest") {
    const existing = await tx.select().from(activitySessions).where(and(eq(activitySessions.athleteId, input.athleteId), eq(activitySessions.activityDate, input.activityDate)));
    if (existing.some((e) => e.kind !== "rest")) throw new UserError("That day already has logged activity, so it can't be marked as a rest day.");
    if (existing.some((e) => e.kind === "rest")) return existing[0];
  }
  const [row] = await tx
    .insert(activitySessions)
    .values({
      orgId: v.orgId,
      athleteId: input.athleteId,
      activityDate: input.activityDate,
      kind: input.kind,
      durationMinutes: input.kind === "rest" ? null : input.durationMinutes ?? null,
      sessionRpe: input.kind === "rest" ? null : input.sessionRpe ?? null,
      notes: input.notes || null,
      enteredBy: v.userId,
    })
    .returning();
  await audit(tx, actorOf(v), "science.activity.log", "activity_session", row.id, {
    summary: input.kind === "rest" ? `Rest day ${input.activityDate}` : `${input.kind} ${input.durationMinutes} min @ sRPE ${input.sessionRpe} = ${srpeLoad(input.durationMinutes, input.sessionRpe)} AU`,
  });
  return row;
}

export async function deleteActivity(tx: Tx, v: Viewer, id: string) {
  const [row] = await tx.select().from(activitySessions).where(and(eq(activitySessions.id, id), eq(activitySessions.orgId, v.orgId)));
  if (!row) throw new UserError("Not found.");
  await requireOnAthlete(tx, v, row.athleteId, "training.write");
  if (row.workoutId) throw new UserError("Workout-derived sessions are managed from the workout.");
  await tx.delete(activitySessions).where(eq(activitySessions.id, id));
  await audit(tx, actorOf(v), "science.activity.delete", "activity_session", id, { before: row });
}

/**
 * Local calendar date a completed workout's load belongs to. Uses the completion instant in the
 * facility timezone (DST-correct), falling back to the scheduled date.
 */
export function workoutLoadDate(completedAt: Date | null, scheduledDate: string, tz = DEFAULT_TZ): string {
  return completedAt ? localYmd(completedAt, tz) : scheduledDate;
}

export type LoadRow = LoadEntry & { id: string; source: "activity" | "workout"; label: string; load: number | null; notes: string | null };

/** All load entries (manual activity sessions + completed workouts not already linked) for one athlete. */
export async function loadEntries(tx: Tx, orgId: string, athleteId: string, from: string, to: string): Promise<LoadRow[]> {
  const acts = await tx
    .select()
    .from(activitySessions)
    .where(and(eq(activitySessions.orgId, orgId), eq(activitySessions.athleteId, athleteId), gte(activitySessions.activityDate, from), lte(activitySessions.activityDate, to)))
    .orderBy(asc(activitySessions.activityDate));
  const linked = new Set(acts.map((a) => a.workoutId).filter(Boolean));
  const { start } = localDayBounds(addDaysYmd(from, -1));
  const { end } = localDayBounds(addDaysYmd(to, 1));
  const wos = await tx
    .select()
    .from(workouts)
    .where(
      and(
        eq(workouts.orgId, orgId),
        eq(workouts.athleteId, athleteId),
        eq(workouts.status, "completed"),
        gte(workouts.scheduledDate, addDaysYmd(from, -1)),
        lte(workouts.scheduledDate, addDaysYmd(to, 1)),
      ),
    );
  const out: LoadRow[] = acts.map((a) => ({
    id: a.id,
    source: "activity",
    date: a.activityDate,
    kind: a.kind,
    durationMin: a.durationMinutes,
    rpe: a.sessionRpe,
    load: srpeLoad(a.durationMinutes, a.sessionRpe),
    label: a.kind,
    notes: a.notes,
  }));
  for (const w of wos) {
    if (linked.has(w.id)) continue;
    if (w.completedAt && (w.completedAt < start || w.completedAt > end)) continue;
    const date = workoutLoadDate(w.completedAt, w.scheduledDate);
    if (date < from || date > to) continue;
    out.push({ id: w.id, source: "workout", date, kind: "training", durationMin: w.durationMinutes, rpe: w.sessionRpe, load: srpeLoad(w.durationMinutes, w.sessionRpe), label: `Workout: ${w.title}`, notes: null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export type AthleteLoad = {
  athleteId: string;
  from: string;
  to: string;
  entries: LoadRow[];
  series: DailyLoad[];
  /** Derived metrics are anchored to today if today's load is known, else yesterday (the day isn't over). */
  metricsAsOf: string;
  weeks: ReturnType<typeof weeklyTotals>;
  acwr: AcwrResult;
  monotony: number | null;
  strain: number | null;
  weeklyLoad: number | null;
  readiness: Map<string, number | null> | null;
  minCoverage: number;
};

/** Daily/weekly load, ACWR, monotony/strain for one athlete as of a date (56-day view). */
export async function athleteLoad(tx: Tx, v: Viewer, athleteId: string, asOf = todayLocal(), days = 56): Promise<AthleteLoad> {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const settings = await scienceSettings(tx, v.orgId);
  const from = addDaysYmd(asOf, -(days - 1));
  const entries = await loadEntries(tx, v.orgId, athleteId, from, asOf);
  const series = dailyLoadSeries(entries, from, asOf);
  const metricsAsOf = metricsAnchor(series, asOf);
  const acwr = acwrRolling(series, metricsAsOf, { minCoverage: settings.acwrMinCoverage });
  const ms = monotonyStrain(series, metricsAsOf);
  return {
    athleteId,
    from,
    to: asOf,
    entries,
    series,
    weeks: weeklyTotals(series),
    metricsAsOf,
    acwr,
    monotony: ms.monotony,
    strain: ms.strain,
    weeklyLoad: ms.weeklyLoad,
    readiness: await readinessByDate(tx, v, athleteId, from, asOf),
    minCoverage: settings.acwrMinCoverage,
  };
}

/** Today if its load is already known; otherwise the last completed day. */
export function metricsAnchor(series: readonly DailyLoad[], today: string): string {
  const t = series.find((d) => d.date === today);
  return t && t.load !== null ? today : addDaysYmd(today, -1);
}

export type LoadAlert = { athleteId: string; name: string; kind: "acwr_high" | "acwr_low" | "insufficient_data"; acwr: AcwrResult };

/** Exported for dashboards: ACWR alerts across the viewer's training scope. */
export async function loadAlerts(tx: Tx, v: Viewer, asOf = todayLocal()): Promise<LoadAlert[]> {
  const settings = await scienceSettings(tx, v.orgId);
  const athletes = await scopedAthletes(tx, v, "training.read");
  if (!athletes.length) return [];
  const from = addDaysYmd(asOf, -27);
  const out: LoadAlert[] = [];
  const anyData = new Set(
    (await tx.select({ a: activitySessions.athleteId }).from(activitySessions).where(and(eq(activitySessions.orgId, v.orgId), inArray(activitySessions.athleteId, athletes.map((a) => a.id)), gte(activitySessions.activityDate, from))))
      .map((r) => r.a)
      .concat((await tx.select({ a: workouts.athleteId }).from(workouts).where(and(eq(workouts.orgId, v.orgId), isNotNull(workouts.completedAt), inArray(workouts.athleteId, athletes.map((a) => a.id)), gte(workouts.scheduledDate, from)))).map((r) => r.a)),
  );
  for (const a of athletes) {
    if (!anyData.has(a.id)) continue; // athletes not using load monitoring at all aren't alerted on
    const entries = await loadEntries(tx, v.orgId, a.id, addDaysYmd(from, -1), asOf);
    const series = dailyLoadSeries(entries, addDaysYmd(from, -1), asOf);
    const acwr = acwrRolling(series, metricsAnchor(series, asOf), { minCoverage: settings.acwrMinCoverage });
    if (acwr.ratio === null) out.push({ athleteId: a.id, name: a.name, kind: "insufficient_data", acwr });
    else if (acwr.ratio > settings.acwrAlertHigh) out.push({ athleteId: a.id, name: a.name, kind: "acwr_high", acwr });
    else if (acwr.ratio < settings.acwrAlertLow) out.push({ athleteId: a.id, name: a.name, kind: "acwr_low", acwr });
  }
  return out;
}
