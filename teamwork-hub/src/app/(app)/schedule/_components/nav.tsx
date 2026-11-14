import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/time";
import type { CalendarView } from "@/lib/scheduling/calendar-range";

export type Params = Record<string, string | undefined>;

/** Build /schedule URLs that keep the current filters. */
export function hrefWith(base: string, params: Params, patch: Params) {
  const merged: Params = { ...params, ...patch };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export function flatParams(sp: Record<string, string | string[] | undefined>): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(sp)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Human range label: "Oct 12 – 18, 2026", "Sep 28 – Oct 4, 2026", "Monday, Oct 12, 2026", "October 2026". */
export function rangeLabel(view: CalendarView, first: string, last: string, fallback: string) {
  const d = (ymd: string, p: string) => fmt(new Date(`${ymd}T12:00:00Z`), p, "UTC");
  if (view === "day") return d(first, "EEEE, MMM d, yyyy");
  if (view === "month") return fallback;
  if (first.slice(0, 7) === last.slice(0, 7)) return `${d(first, "MMM d")} – ${d(last, "d, yyyy")}`;
  if (first.slice(0, 4) === last.slice(0, 4)) return `${d(first, "MMM d")} – ${d(last, "MMM d, yyyy")}`;
  return `${d(first, "MMM d, yyyy")} – ${d(last, "MMM d, yyyy")}`;
}

/** Compact calendar toolbar: ‹ Today › range label, Day/Week/Month segmented control, optional actions. */
export function CalendarToolbar({
  params,
  view,
  label,
  prev,
  next,
  today,
  actions,
  className,
}: {
  params: Params;
  view: CalendarView;
  label: string;
  prev: string;
  next: string;
  today: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  const navBtn = "inline-flex size-9 items-center justify-center rounded-md border border-edge bg-surface text-lg leading-none text-ink-2 hover:bg-surface-2 hover:text-ink";
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Link href={hrefWith("/schedule", params, { date: prev })} className={navBtn} aria-label={`Previous ${view}`}>
          <span aria-hidden>‹</span>
        </Link>
        <Link href={hrefWith("/schedule", params, { date: today })} className={buttonClass("secondary", "sm", "h-9")}>
          Today
        </Link>
        <Link href={hrefWith("/schedule", params, { date: next })} className={navBtn} aria-label={`Next ${view}`}>
          <span aria-hidden>›</span>
        </Link>
        <h2 className="ml-1.5 truncate text-base font-bold tracking-tight tabular sm:text-lg" aria-live="polite">
          {label}
        </h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Calendar view" className="inline-flex overflow-hidden rounded-md border border-edge bg-surface">
          {(["day", "week", "month"] as const).map((v, i) => (
            <Link
              key={v}
              href={hrefWith("/schedule", params, { view: v })}
              aria-current={v === view ? "page" : undefined}
              className={cn(
                "inline-flex h-9 items-center px-3.5 text-sm font-semibold capitalize",
                i > 0 && "border-l border-edge",
                v === view ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              {v}
            </Link>
          ))}
        </div>
        {actions}
      </div>
    </div>
  );
}
