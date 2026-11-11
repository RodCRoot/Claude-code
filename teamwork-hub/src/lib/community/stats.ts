/**
 * Org-wide, read-only activity loaders shared by the leaderboards, challenges and the TV board.
 * Nothing here checks a viewer: callers decide what may be shown and resolve every name through
 * `communityRoster`. No health value is read (wellness answers, body-map, notes).
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { detectPrs, type PrEvent } from "@/lib/engagement/prs";
import { computeStreak, type HoldRange } from "@/lib/engagement/streaks";
import { convertUnit, unitFamily } from "@/lib/science/formulas";
import { DEFAULT_TZ, addDaysYmd, localYmd, startOfWeekYmd } from "@/lib/time";

const rowsOf = async <T>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];
const ymdOf = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

export type ActivityDates = {
  /** Facility-local dates of attended sessions, ascending (one per session). */
  attended: string[];
  /** Facility-local dates of completed logged workouts. */
  workouts: string[];
  /** Facility-local dates of finished On Your Own sessions. */
  onYourOwn: string[];
};

/** Attendance, completed workouts and On Your Own completions per athlete, as facility-local dates. */
export async function loadActivityDates(tx: Tx, orgId: string, tz = DEFAULT_TZ): Promise<Map<string, ActivityDates>> {
  const out = new Map<string, ActivityDates>();
  const of = (id: string) => {
    let a = out.get(id);
    if (!a) out.set(id, (a = { attended: [], workouts: [], onYourOwn: [] }));
    return a;
  };
  const attended = await rowsOf<{ athlete_id: string; starts_at: string | Date }>(
    tx,
    sql`select b.athlete_id, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status = 'attended' and s.status <> 'cancelled' order by s.starts_at`,
  );
  for (const r of attended) of(r.athlete_id).attended.push(localYmd(new Date(r.starts_at), tz));
  const done = await rowsOf<{ athlete_id: string; completed_at: string | Date | null; scheduled_date: string | Date }>(
    tx,
    sql`select athlete_id, completed_at, scheduled_date from workouts where org_id = ${orgId} and status = 'completed'`,
  );
  for (const r of done) of(r.athlete_id).workouts.push(r.completed_at ? localYmd(new Date(r.completed_at), tz) : ymdOf(r.scheduled_date));
  const own = await rowsOf<{ athlete_id: string; local_date: string | Date }>(tx, sql`select athlete_id, local_date from anywhere_completions where org_id = ${orgId}`);
  for (const r of own) of(r.athlete_id).onYourOwn.push(ymdOf(r.local_date));
  return out;
}

export async function loadHolds(tx: Tx, orgId: string): Promise<Map<string, HoldRange[]>> {
  const rows = await rowsOf<{ athlete_id: string; start_date: string | Date; end_date: string | Date }>(
    tx,
    sql`select m.athlete_id, h.start_date, h.end_date from membership_holds h join memberships m on m.id = h.membership_id
        where m.org_id = ${orgId} and h.kind = 'hold'`,
  );
  const out = new Map<string, HoldRange[]>();
  for (const r of rows) out.set(r.athlete_id, [...(out.get(r.athlete_id) ?? []), { start: ymdOf(r.start_date), end: ymdOf(r.end_date) }]);
  return out;
}

/** Current weekly streak, by the same rule Athlete Home uses (src/lib/engagement/streaks.ts). */
export function streakOf(a: ActivityDates | undefined, holds: readonly HoldRange[] | undefined, today: string): number {
  if (!a) return 0;
  return computeStreak({ activeDates: [...a.attended, ...a.workouts, ...a.onYourOwn], holds: holds ?? [], today, recentWeeks: 1 }).current;
}

/** Pure: how many of these facility-local dates fall inside an inclusive window. */
export function countInWindow(dates: readonly string[], startsOn: string, endsOn: string): number {
  let n = 0;
  for (const d of dates) if (d >= startsOn && d <= endsOn) n++;
  return n;
}

/** Pure: distinct facility-local weeks (Monday start) with at least one active date inside the window. */
export function activeWeeksInWindow(dates: readonly string[], startsOn: string, endsOn: string): number {
  const weeks = new Set<string>();
  for (const d of dates) if (d >= startsOn && d <= endsOn) weeks.add(startOfWeekYmd(d));
  return weeks.size;
}

export type MeasuredMax = { id: string; athleteId: string; exerciseId: string; value: number; unit: string; kind: string; recordedOn: string; createdAt: Date | string | null };

/**
 * Tested, coach-entered and imported maxes only. Estimated maxes (calculated from logged sets)
 * are filtered out in SQL so they can never reach a board. Mass units only (lb, kg).
 */
export async function loadMeasuredMaxes(tx: Tx, orgId: string): Promise<{ rows: MeasuredMax[]; exerciseNames: Map<string, string> }> {
  const raw = await rowsOf<{ id: string; athlete_id: string; exercise_id: string; value: string; unit: string; kind: string; recorded_on: string | Date; created_at: string | Date | null; name: string }>(
    tx,
    sql`select m.id, m.athlete_id, m.exercise_id, m.value, m.unit, m.kind, m.recorded_on, m.created_at, e.name
        from maxes m join exercises e on e.id = m.exercise_id
        where m.org_id = ${orgId} and m.kind <> 'estimated' and m.source <> 'vbt_bar_speed' and m.unit in ('lb','kg')`,
  );
  const exerciseNames = new Map<string, string>();
  const rows: MeasuredMax[] = [];
  for (const r of raw) {
    const value = Number(r.value);
    if (!Number.isFinite(value) || value <= 0 || unitFamily(r.unit) !== "mass") continue;
    exerciseNames.set(r.exercise_id, r.name);
    rows.push({ id: r.id, athleteId: r.athlete_id, exerciseId: r.exercise_id, value, unit: r.unit, kind: r.kind, recordedOn: ymdOf(r.recorded_on), createdAt: r.created_at });
  }
  return { rows, exerciseNames };
}

const toLb = (value: number, unit: string) => convertUnit(value, unit, "lb");

export type BestMax = { exerciseId: string; value: number; unit: string; lb: number; recordedOn: string };

/** Best measured max per exercise for one athlete, compared in pounds. Pure. */
export function bestMaxes(rows: readonly MeasuredMax[]): Map<string, BestMax> {
  const best = new Map<string, BestMax>();
  for (const r of rows) {
    if (r.kind === "estimated") continue;
    const lb = toLb(r.value, r.unit);
    if (lb === null) continue;
    const cur = best.get(r.exerciseId);
    if (!cur || lb > cur.lb) best.set(r.exerciseId, { exerciseId: r.exerciseId, value: r.value, unit: r.unit, lb, recordedOn: r.recordedOn });
  }
  return best;
}

export const IMPROVEMENT_WINDOW_DAYS = 90;
/** A baseline and a latest value this close together are one test, not progress. */
export const IMPROVEMENT_MIN_GAP_DAYS = 7;

export type Improvement = { exerciseId: string; pct: number; from: number; to: number };

/**
 * Percent improvement on one athlete's measured maxes over the last 90 days. Pure.
 * Baseline: the most recent measured max on or before the window start, else the first one inside
 * the window. Latest: the most recent measured max inside the window, at least a week after the
 * baseline. Estimated maxes are never used and only exactly convertible units (lb, kg) compare.
 * Returns the athlete's best positive improvement per exercise.
 */
export function improvements(rows: readonly MeasuredMax[], today: string): Improvement[] {
  const windowStart = addDaysYmd(today, -IMPROVEMENT_WINDOW_DAYS);
  const byExercise = new Map<string, MeasuredMax[]>();
  for (const r of rows) {
    if (r.kind === "estimated" || r.recordedOn > today || toLb(r.value, r.unit) === null) continue;
    byExercise.set(r.exerciseId, [...(byExercise.get(r.exerciseId) ?? []), r]);
  }
  const out: Improvement[] = [];
  for (const [exerciseId, list] of byExercise) {
    const sorted = [...list].sort((a, b) => a.recordedOn.localeCompare(b.recordedOn) || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id.localeCompare(b.id));
    const before = sorted.filter((r) => r.recordedOn <= windowStart);
    const inside = sorted.filter((r) => r.recordedOn > windowStart);
    if (!inside.length) continue;
    const baseline = before.length ? before[before.length - 1] : inside[0];
    const latest = inside[inside.length - 1];
    if (latest.id === baseline.id || addDaysYmd(baseline.recordedOn, IMPROVEMENT_MIN_GAP_DAYS) > latest.recordedOn) continue;
    const from = toLb(baseline.value, baseline.unit)!;
    const to = toLb(latest.value, latest.unit)!;
    if (from <= 0 || to <= from) continue;
    out.push({ exerciseId, pct: ((to - from) / from) * 100, from, to });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/** PRs (a measured max that beats every earlier measured max of the same lift) per athlete. */
export function measuredPrs(rows: readonly MeasuredMax[]): PrEvent[] {
  return detectPrs(rows.filter((r) => r.kind !== "estimated")).filter((p) => p.basis === "measured");
}

export const fmtLoad = (value: number, unit: string) => `${Math.round(value * 10) / 10} ${unit}`;
