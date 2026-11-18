import { formatInTimeZone } from "date-fns-tz";
import { addDaysYmd, DEFAULT_TZ, localToUtc } from "@/lib/time";

export type QuietHours = { start: string; end: string };

const HM = /^([01]\d|2[0-3]):([0-5]\d)(:\d{2})?$/;

export function parseQuietHours(v: unknown): QuietHours | null {
  if (!v || typeof v !== "object") return null;
  const { start, end } = v as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!HM.test(start) || !HM.test(end)) return null;
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  if (s === e) return null;
  return { start: s, end: e };
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/**
 * If `now` falls inside the quiet window (local wall-clock time in `tz`), returns the
 * UTC instant at which the window ends; otherwise null. Windows may wrap midnight
 * (e.g. 21:00–07:30). The end instant is computed from the local calendar date and
 * wall-clock time, so DST transitions inside the window are handled correctly.
 */
export function quietHoursEnd(now: Date, qh: QuietHours | null, tz = DEFAULT_TZ): Date | null {
  if (!qh) return null;
  const localYmd = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const localHm = formatInTimeZone(now, tz, "HH:mm");
  const t = minutes(localHm);
  const s = minutes(qh.start);
  const e = minutes(qh.end);
  if (s < e) {
    // Same-day window, e.g. 12:00–13:00.
    if (t >= s && t < e) return localToUtc(localYmd, qh.end, tz);
    return null;
  }
  // Wrapping window, e.g. 21:00–07:30.
  if (t >= s) return localToUtc(addDaysYmd(localYmd, 1), qh.end, tz);
  if (t < e) return localToUtc(localYmd, qh.end, tz);
  return null;
}
