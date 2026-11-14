/**
 * Weekly training streak (pure functions, no database).
 *
 * A week is the facility-local ISO week (Monday to Sunday). A week is ACTIVE when the athlete
 * attended at least one session or completed at least one logged workout in it. The streak is the
 * number of consecutive active weeks, where:
 *   - a week touched by a membership hold is SKIPPED (it neither adds to nor breaks the streak),
 *     unless the athlete trained anyway, in which case it counts;
 *   - the current week never breaks the streak while it is still in progress.
 */
import { addDaysYmd, DEFAULT_TZ, localYmd, startOfWeekYmd } from "@/lib/time";

/** Inclusive facility-local dates. */
export type HoldRange = { start: string; end: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Monday (YYYY-MM-DD) of the facility-local ISO week containing an instant or local date. DST-safe. */
export function weekStartOf(d: Date | string, tz = DEFAULT_TZ): string {
  const ymd = typeof d === "string" && YMD.test(d) ? d : localYmd(typeof d === "string" ? new Date(d) : d, tz);
  return startOfWeekYmd(ymd);
}

/** Does any day of the week starting `weekStart` fall inside a hold? */
export function isHoldWeek(weekStart: string, holds: readonly HoldRange[]): boolean {
  const weekEnd = addDaysYmd(weekStart, 6);
  return holds.some((h) => h.start <= weekEnd && h.end >= weekStart);
}

export type WeekState = "active" | "hold" | "open" | "rest";
export type StreakResult = {
  current: number;
  best: number;
  thisWeekActive: boolean;
  /** Most recent weeks, oldest first, ending with the current week. */
  recent: { weekStart: string; state: WeekState }[];
  /** Week (Monday) in which the running streak first reached each requested milestone. */
  reached: Record<number, string>;
};

export function computeStreak(input: {
  /** Facility-local dates (or week starts) with qualifying activity. Duplicates are fine. */
  activeDates: readonly string[];
  holds?: readonly HoldRange[];
  /** Facility-local today. */
  today: string;
  milestones?: readonly number[];
  recentWeeks?: number;
}): StreakResult {
  const holds = input.holds ?? [];
  const thisWeek = startOfWeekYmd(input.today);
  const active = new Set(input.activeDates.map((d) => startOfWeekYmd(d)).filter((w) => w <= thisWeek));
  const reached: Record<number, string> = {};
  let run = 0;
  let best = 0;
  if (active.size) {
    const first = [...active].sort()[0];
    for (let w = first; w <= thisWeek; w = addDaysYmd(w, 7)) {
      if (active.has(w)) {
        run++;
        if (run > best) best = run;
        for (const m of input.milestones ?? []) if (run >= m && !(m in reached)) reached[m] = w;
      } else if (w === thisWeek || isHoldWeek(w, holds)) {
        // In progress, or on hold: neither adds nor breaks.
      } else {
        run = 0;
      }
    }
  }
  const n = input.recentWeeks ?? 6;
  const recent: StreakResult["recent"] = [];
  for (let i = n - 1; i >= 0; i--) {
    const w = addDaysYmd(thisWeek, -7 * i);
    recent.push({ weekStart: w, state: active.has(w) ? "active" : isHoldWeek(w, holds) ? "hold" : w === thisWeek ? "open" : "rest" });
  }
  return { current: run, best, thisWeekActive: active.has(thisWeek), recent, reached };
}
