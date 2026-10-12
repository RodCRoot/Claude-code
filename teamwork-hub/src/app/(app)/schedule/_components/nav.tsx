import Link from "next/link";
import { buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
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

export function CalendarToolbar({ params, view, label, prev, next, today }: { params: Params; view: CalendarView; label: string; prev: string; next: string; today: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1">
        <Link href={hrefWith("/schedule", params, { date: prev })} className={buttonClass("outline", "md", "min-h-11 min-w-11")} aria-label={`Previous ${view}`}>
          ‹
        </Link>
        <Link href={hrefWith("/schedule", params, { date: today })} className={buttonClass("outline", "md", "min-h-11")}>
          Today
        </Link>
        <Link href={hrefWith("/schedule", params, { date: next })} className={buttonClass("outline", "md", "min-h-11 min-w-11")} aria-label={`Next ${view}`}>
          ›
        </Link>
        <h2 className="ml-2 text-base font-semibold tabular" aria-live="polite">
          {label}
        </h2>
      </div>
      <div role="group" aria-label="Calendar view" className="inline-flex rounded-lg border border-edge bg-surface p-0.5">
        {(["day", "week", "month"] as const).map((v) => (
          <Link
            key={v}
            href={hrefWith("/schedule", params, { view: v })}
            aria-current={v === view ? "page" : undefined}
            className={cn("inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium capitalize", v === view ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2")}
          >
            {v}
          </Link>
        ))}
      </div>
    </div>
  );
}
