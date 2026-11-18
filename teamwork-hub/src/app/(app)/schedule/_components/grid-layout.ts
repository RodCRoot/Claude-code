/**
 * Pure layout math for the calendar time grid (no React, no DB) so it can be unit-tested.
 * All positions are in facility-local wall-clock minutes from local midnight, which keeps
 * DST weeks correct: a 6:00 PM class sits on the 6 PM row whether the day has 23, 24 or 25 hours.
 */
import { formatInTimeZone } from "date-fns-tz";

export const DAY_MINUTES = 24 * 60;

/** Wall-clock minutes since local midnight for an instant in `tz`. */
export function localMinutes(d: Date, tz: string): number {
  const [h, m] = formatInTimeZone(d, tz, "H:m").split(":").map(Number);
  return h * 60 + m;
}

/**
 * Visible span of a session on local day `ymd`, in minutes from local midnight.
 * Sessions that start before / end after that day are clipped to it. If the wall-clock end
 * is not after the start (a session spanning the fall-back hour), real elapsed time is used.
 */
export function daySpan(startsAt: Date, endsAt: Date, ymd: string, tz: string): { start: number; end: number } {
  const start = formatInTimeZone(startsAt, tz, "yyyy-MM-dd") < ymd ? 0 : localMinutes(startsAt, tz);
  let end = formatInTimeZone(endsAt, tz, "yyyy-MM-dd") > ymd ? DAY_MINUTES : localMinutes(endsAt, tz);
  if (end <= start) end = Math.min(DAY_MINUTES, start + Math.max(0, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)));
  return { start, end: Math.max(end, start) };
}

/** Hour window [startHour, endHour) to draw: the default business window, widened to fit every span. */
export function hourWindow(spans: { start: number; end: number }[], defaults: [number, number] = [6, 21]): [number, number] {
  let lo = defaults[0];
  let hi = defaults[1];
  for (const s of spans) {
    lo = Math.min(lo, Math.floor(s.start / 60));
    hi = Math.max(hi, Math.ceil(s.end / 60));
  }
  return [Math.max(0, lo), Math.min(24, Math.max(hi, lo + 1))];
}

/**
 * Side-by-side packing for overlapping events (the usual calendar layout).
 * Events are grouped into clusters of transitively overlapping events; each event takes the
 * first free column in its cluster, and every event in a cluster shares the cluster's column count.
 * Touching events (one ends exactly when the next starts) do not overlap.
 */
export function packColumns<T extends { id: string; start: number; end: number }>(events: T[]): Map<string, { col: number; cols: number }> {
  const out = new Map<string, { col: number; cols: number }>();
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  let cluster: string[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const id of cluster) out.get(id)!.cols = colEnds.length;
    cluster = [];
    colEnds = [];
  };
  for (const e of sorted) {
    if (e.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    // Zero-length events still occupy their slot for packing purposes.
    const end = Math.max(e.end, e.start + 1);
    let col = colEnds.findIndex((ce) => ce <= e.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(end);
    } else colEnds[col] = end;
    out.set(e.id, { col, cols: 0 });
    cluster.push(e.id);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

/** Percent offsets of a span inside an hour window (for absolutely positioned blocks). */
export function spanToPercent(span: { start: number; end: number }, window: [number, number]): { top: number; height: number } {
  const from = window[0] * 60;
  const total = (window[1] - window[0]) * 60;
  const s = Math.min(Math.max(span.start, from), from + total);
  const e = Math.min(Math.max(span.end, from), from + total);
  return { top: ((s - from) / total) * 100, height: ((e - s) / total) * 100 };
}

/** "6a", "12p", "6:30p" — compact hour labels for blocks and the hour gutter. */
export function shortTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}${m ? `:${String(m).padStart(2, "0")}` : ""}${h24 < 12 ? "a" : "p"}`;
}
