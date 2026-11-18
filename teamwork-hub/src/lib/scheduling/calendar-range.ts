import { addDaysYmd, daysBetween, localToUtc, startOfWeekYmd } from "@/lib/time";

export type CalendarView = "day" | "week" | "month";

export function parseView(v: string | undefined): CalendarView {
  return v === "day" || v === "month" ? v : "week";
}

export function parseYmd(v: string | undefined, fallback: string): string {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : fallback;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthStart(ymd: string) {
  return `${ymd.slice(0, 7)}-01`;
}
function addMonths(ymd: string, n: number) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

/** Local-date range for a calendar view, plus navigation targets. All math in facility-local dates. */
export function calendarRange(view: CalendarView, anchor: string, tz: string) {
  let first: string;
  let last: string;
  let prev: string;
  let next: string;
  let label: string;
  if (view === "day") {
    first = last = anchor;
    prev = addDaysYmd(anchor, -1);
    next = addDaysYmd(anchor, 1);
    label = anchor;
  } else if (view === "week") {
    first = startOfWeekYmd(anchor);
    last = addDaysYmd(first, 6);
    prev = addDaysYmd(first, -7);
    next = addDaysYmd(first, 7);
    label = `${first} – ${last}`;
  } else {
    const ms = monthStart(anchor);
    const nextMs = addMonths(ms, 1);
    first = startOfWeekYmd(ms);
    last = addDaysYmd(startOfWeekYmd(addDaysYmd(nextMs, -1)), 6);
    prev = addMonths(ms, -1);
    next = nextMs;
    label = `${MONTHS[Number(ms.slice(5, 7)) - 1]} ${ms.slice(0, 4)}`;
  }
  const days: string[] = [];
  for (let d = first; d <= last; d = addDaysYmd(d, 1)) days.push(d);
  return {
    view,
    anchor,
    first,
    last,
    days,
    prev,
    next,
    label,
    from: localToUtc(first, "00:00", tz),
    to: localToUtc(addDaysYmd(last, 1), "00:00", tz),
    monthPrefix: view === "month" ? monthStart(anchor).slice(0, 7) : null,
    spanDays: daysBetween(first, last) + 1,
  };
}
