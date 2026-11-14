import { addDaysYmd, isoWeekday, localToUtc } from "@/lib/time";

/** Pure recurrence math (no DB, no server-only imports) so seeds and tests can use it directly. */
export type SeriesShape = {
  weekdays: number[];
  startTimeLocal: string;
  durationMinutes: number;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
};

/**
 * Occurrences of a weekly series between two local dates (inclusive), computed in the
 * series' timezone. A 6:00 AM class stays 6:00 AM local across DST changes because each
 * occurrence is converted from (local date, local time) → UTC independently.
 * Nonexistent local times (inside a spring-forward gap) resolve forward per date-fns-tz.
 */
export function seriesOccurrences(s: SeriesShape, fromYmd: string, toYmd: string): { date: string; startsAt: Date; endsAt: Date }[] {
  const start = s.startsOn > fromYmd ? s.startsOn : fromYmd;
  const end = s.endsOn && s.endsOn < toYmd ? s.endsOn : toYmd;
  const out: { date: string; startsAt: Date; endsAt: Date }[] = [];
  const days = new Set(s.weekdays);
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) {
    if (!days.has(isoWeekday(d))) continue;
    const startsAt = localToUtc(d, s.startTimeLocal.slice(0, 5), s.timezone);
    out.push({ date: d, startsAt, endsAt: new Date(startsAt.getTime() + s.durationMinutes * 60_000) });
  }
  return out;
}
