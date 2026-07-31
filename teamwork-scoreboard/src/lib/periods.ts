/**
 * Date-period helpers. All dates are handled as local-date strings
 * (YYYY-MM-DD) to avoid timezone drift for a single-location business.
 */
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  subWeeks,
  subMonths,
  subQuarters,
  subYears,
  addDays,
  format,
  parseISO,
  differenceInCalendarDays,
} from "date-fns";

export type PeriodKind = "weekly" | "monthly" | "quarterly" | "ytd" | "custom";

export interface Period {
  kind: PeriodKind;
  start: string; // inclusive YYYY-MM-DD
  end: string; // inclusive YYYY-MM-DD
  label: string;
}

export function toDateStr(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function todayStr(now: Date = new Date()): string {
  return toDateStr(now);
}

/** Monday-based week start for a date string. */
export function weekStartOf(dateStr: string): string {
  return toDateStr(startOfWeek(parseISO(dateStr), { weekStartsOn: 1 }));
}

export function resolvePeriod(
  kind: PeriodKind,
  now: Date = new Date(),
  custom?: { start: string; end: string }
): Period {
  switch (kind) {
    case "weekly": {
      const s = startOfWeek(now, { weekStartsOn: 1 });
      const e = endOfWeek(now, { weekStartsOn: 1 });
      return { kind, start: toDateStr(s), end: toDateStr(e), label: `Week of ${format(s, "MMM d")}` };
    }
    case "monthly": {
      const s = startOfMonth(now);
      return { kind, start: toDateStr(s), end: toDateStr(endOfMonth(now)), label: format(now, "MMMM yyyy") };
    }
    case "quarterly": {
      const s = startOfQuarter(now);
      return { kind, start: toDateStr(s), end: toDateStr(endOfQuarter(now)), label: `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}` };
    }
    case "ytd":
      return {
        kind,
        start: toDateStr(startOfYear(now)),
        end: toDateStr(now),
        label: `${now.getFullYear()} YTD`,
      };
    case "custom": {
      const start = custom?.start ?? toDateStr(startOfMonth(now));
      const end = custom?.end ?? toDateStr(now);
      return { kind, start, end, label: `${start} → ${end}` };
    }
  }
}

/** The equivalent previous period, for trend comparison. */
export function previousPeriod(period: Period, now: Date = new Date()): Period {
  switch (period.kind) {
    case "weekly": {
      const prev = subWeeks(now, 1);
      return resolvePeriod("weekly", prev);
    }
    case "monthly":
      return resolvePeriod("monthly", subMonths(now, 1));
    case "quarterly":
      return resolvePeriod("quarterly", subQuarters(now, 1));
    case "ytd": {
      const prevYear = subYears(now, 1);
      return {
        kind: "ytd",
        start: toDateStr(startOfYear(prevYear)),
        end: toDateStr(prevYear),
        label: `${prevYear.getFullYear()} YTD`,
      };
    }
    case "custom": {
      const s = parseISO(period.start);
      const e = parseISO(period.end);
      const days = differenceInCalendarDays(e, s) + 1;
      return {
        kind: "custom",
        start: toDateStr(addDays(s, -days)),
        end: toDateStr(addDays(e, -days)),
        label: "Previous period",
      };
    }
  }
}

/** Number of weeks a period's goal should be scaled by (weekly goals scale up). */
export function periodWeeks(period: Period): number {
  const days =
    differenceInCalendarDays(parseISO(period.end), parseISO(period.start)) + 1;
  return Math.max(days / 7, 1 / 7);
}

/**
 * Scale a goal defined per `goalPeriod` (weekly|monthly) to the given period.
 * Stock metrics (point-in-time) are never scaled.
 */
export function scaleGoal(
  goal: number | null | undefined,
  goalPeriod: string,
  kind: string,
  period: Period
): number | null {
  if (goal === null || goal === undefined) return null;
  if (kind === "stock") return goal;
  const days =
    differenceInCalendarDays(parseISO(period.end), parseISO(period.start)) + 1;
  const unitDays = goalPeriod === "monthly" ? 30.44 : 7;
  const factor = days / unitDays;
  // Keep single-period views exact (a weekly view of a weekly goal = the goal).
  if (Math.abs(factor - 1) < 0.15) return goal;
  return Math.round(goal * factor * 100) / 100;
}

/** Last N week-start strings (Mondays), most recent last. */
export function lastNWeekStarts(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(toDateStr(startOfWeek(subWeeks(now, i), { weekStartsOn: 1 })));
  }
  return out;
}
