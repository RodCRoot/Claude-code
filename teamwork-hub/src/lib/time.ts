import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addDays } from "date-fns";

export const DEFAULT_TZ = "America/Indiana/Indianapolis";

/** "2026-03-08" + "06:00" in a timezone → UTC instant. DST-correct. */
export function localToUtc(dateYmd: string, timeHm: string, tz = DEFAULT_TZ): Date {
  return fromZonedTime(`${dateYmd}T${timeHm.length === 5 ? timeHm + ":00" : timeHm}`, tz);
}

export function fmt(d: Date | string | null | undefined, pattern = "MMM d, yyyy h:mm a", tz = DEFAULT_TZ): string {
  if (!d) return "—";
  return formatInTimeZone(typeof d === "string" ? new Date(d) : d, tz, pattern);
}

export function fmtDate(d: Date | string | null | undefined, tz = DEFAULT_TZ) {
  if (!d) return "—";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  return fmt(d, "MMM d, yyyy", tz);
}

export function fmtTime(d: Date | string, tz = DEFAULT_TZ) {
  return fmt(d, "h:mm a", tz);
}

/** Today's local calendar date (YYYY-MM-DD) in the facility timezone. */
export function todayLocal(tz = DEFAULT_TZ, now = new Date()): string {
  return formatInTimeZone(now, tz, "yyyy-MM-dd");
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = addDays(new Date(Date.UTC(y, m - 1, d, 12)), n);
  return dt.toISOString().slice(0, 10);
}

/** ISO weekday (1=Mon..7=Sun) of a YYYY-MM-DD date. */
export function isoWeekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** UTC bounds of a local day. */
export function localDayBounds(ymd: string, tz = DEFAULT_TZ): { start: Date; end: Date } {
  return { start: localToUtc(ymd, "00:00", tz), end: localToUtc(addDaysYmd(ymd, 1), "00:00", tz) };
}

export function localYmd(d: Date, tz = DEFAULT_TZ) {
  return formatInTimeZone(d, tz, "yyyy-MM-dd");
}

export function zoned(d: Date, tz = DEFAULT_TZ) {
  return toZonedTime(d, tz);
}

export function startOfWeekYmd(ymd: string): string {
  return addDaysYmd(ymd, -(isoWeekday(ymd) - 1));
}

export function daysBetween(a: string, b: string): number {
  const pa = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const pb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((pb - pa) / 86_400_000);
}
