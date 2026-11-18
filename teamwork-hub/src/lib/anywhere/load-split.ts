import type { LoadOrigin } from "@/lib/science/load";
import { addDaysYmd, startOfWeekYmd } from "@/lib/time";

/**
 * load_origin_v1 (pure): weekly srpe_load_v1 totals split by where the session happened.
 *
 * This is a display split of loads the existing formulas already count. It never changes a
 * total: gym + sport + onYourOwn + other of a week equals the sum of that week's known session
 * loads. Sessions whose load cannot be calculated (missing minutes or RPE) are counted in
 * `unknownSessions` and add nothing, and a week with no sessions has `total: null` (unknown,
 * not zero).
 */
export type OriginWeek = {
  weekStart: string;
  gym: number;
  sport: number;
  onYourOwn: number;
  other: number;
  /** Null when the week has no session with a known load. */
  total: number | null;
  sessions: number;
  unknownSessions: number;
};

export const ORIGIN_LABEL: Record<LoadOrigin, string> = { gym: "Gym", sport: "Sport", on_your_own: "On your own", other: "Other" };

export function weeklyLoadByOrigin(entries: readonly { date: string; origin: LoadOrigin; load: number | null; kind?: string }[], fromYmd: string, toYmd: string): OriginWeek[] {
  const weeks = new Map<string, OriginWeek>();
  for (let w = startOfWeekYmd(fromYmd); w <= toYmd; w = addDaysYmd(w, 7)) weeks.set(w, { weekStart: w, gym: 0, sport: 0, onYourOwn: 0, other: 0, total: null, sessions: 0, unknownSessions: 0 });
  for (const e of entries) {
    if (e.kind === "rest" || e.date < fromYmd || e.date > toYmd) continue;
    const w = weeks.get(startOfWeekYmd(e.date));
    if (!w) continue;
    w.sessions++;
    if (e.load === null) {
      w.unknownSessions++;
      continue;
    }
    if (e.origin === "gym") w.gym += e.load;
    else if (e.origin === "sport") w.sport += e.load;
    else if (e.origin === "on_your_own") w.onYourOwn += e.load;
    else w.other += e.load;
    w.total = (w.total ?? 0) + e.load;
  }
  return [...weeks.values()];
}
