/**
 * Training-module presentation kit (strength & conditioning look): progress bars, the coach week
 * strip, rank/PR/trend markers and big-number tiles. Presentational only — no data access.
 * Server-component friendly (no hooks), so client components can import it too.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";

/** Percent 0–100 (null when there is nothing to do). */
export function pctOf(done: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
}

/**
 * Horizontal completion bar. Decorative: callers always print the numbers next to it as text,
 * so the bar itself is hidden from assistive tech.
 */
export function ProgressBar({ done, total, complete, size = "md", className }: { done: number; total: number; complete?: boolean; size?: "sm" | "md" | "lg"; className?: string }) {
  const p = pctOf(done, total) ?? 0;
  const full = complete || (total > 0 && done >= total);
  return (
    <span aria-hidden className={cn("block overflow-hidden rounded-full bg-ink-3/20", size === "sm" ? "h-1.5" : size === "lg" ? "h-3" : "h-2", className)}>
      <span className={cn("block h-full rounded-full transition-[width]", full ? "bg-ok" : "bg-brand")} style={{ width: `${p}%` }} />
    </span>
  );
}

/** Pill showing "done/total" with a status word, used beside progress bars. */
export function ProgressText({ done, total, unit = "sets", className }: { done: number; total: number; unit?: string; className?: string }) {
  const p = pctOf(done, total);
  return (
    <span className={cn("tabular text-xs font-semibold text-ink-2", className)}>
      {done}/{total} {unit}
      {p !== null ? <span className="font-normal text-ink-3"> · {p}%</span> : null}
    </span>
  );
}

/** Rank number in a medal-style disc (1–3 highlighted; the number is always text). */
export function RankBadge({ rank }: { rank: number }) {
  const tone =
    rank === 1 ? "bg-[#f5c542] text-[#3d2c00]" : rank === 2 ? "bg-[#d5dbe3] text-[#1f2a37]" : rank === 3 ? "bg-[#e3a26f] text-[#3b1d06]" : "bg-surface-2 text-ink-2 border border-edge";
  return <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-extrabold tabular", tone)}>{rank}</span>;
}

/** "PR" marker — text, not color alone. */
export function PrBadge({ label = "PR", className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-md bg-[#fde68a] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#5a3a00]", className)}>
      <span aria-hidden>★</span>
      {label}
    </span>
  );
}

/** Up/down/flat arrow with the signed delta in text. `good` decides the color only. */
export function TrendArrow({ delta, unit, good, digits = 0 }: { delta: number | null; unit?: string; good?: boolean | null; digits?: number }) {
  if (delta === null || !Number.isFinite(delta)) return <span className="text-xs text-ink-3">—</span>;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const color = good === true ? "text-ok" : good === false ? "text-bad" : "text-ink-2";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-bold tabular", color)}>
      <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "▬"}</span>
      <span className="sr-only">{dir === "up" ? "up" : dir === "down" ? "down" : "no change"}</span>
      {delta > 0 ? "+" : ""}
      {delta.toFixed(digits)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

/** Dark KPI tile for the module hero band. */
export function HeroStat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-white/[0.07] px-3 py-2.5 ring-1 ring-white/10">
      <div className="text-[11px] font-bold uppercase tracking-wider text-[#b9c6da]">{label}</div>
      <div className="mt-0.5 text-2xl leading-tight font-extrabold tabular text-white">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-[#c9d4e5] [&_a]:text-white [&_a]:underline">{hint}</div> : null}
    </div>
  );
}

/**
 * Dark navy hero band used at the top of the training and AMS pages. Colors are fixed (not
 * themed) so contrast holds in light and dark mode: white/#c9d4e5 text on #13203a.
 */
export function ModuleHero({
  kicker,
  title,
  description,
  actions,
  children,
  className,
}: {
  kicker: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-5 overflow-hidden rounded-lg bg-[#13203a] bg-[linear-gradient(120deg,#13203a_0%,#1a2d52_60%,#123a5c_100%)] px-4 py-4 text-white shadow-sm sm:px-5", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7fd3f7]">{kicker}</div>
          <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight sm:text-[26px]">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-[#c9d4e5]">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </header>
  );
}

/** Light-on-dark action link for the hero band. */
export function HeroLink({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-md px-4 text-sm font-bold whitespace-nowrap",
        primary ? "bg-[#4fc3f7] text-[#0b1a2e] hover:bg-[#7fd3f7]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * Weight-room board: re-points the theme tokens to a fixed high-contrast dark palette for
 * everything inside it (the kit reads colors from CSS variables), so only this page is dark.
 * Brand is swapped for a light cyan with dark ink so brand-colored text and buttons stay ≥ 4.5:1.
 */
export const BOARD_THEME =
  "[--bg:#070c16] [--surface:#111a2b] [--surface-2:#1a2539] [--edge:#2d3b55] [--th-bg:#172033] [--zebra:#141b2a] [--ink:#f3f6fb] [--ink-2:#cfd8e6] [--ink-3:#a3b1c6] [--ok:#4ade80] [--warn:#fbbf24] [--bad:#fca5a5] [--info:#7dd3fc] [--brand:#4fc3f7] [--brand-ink:#08121f] [color-scheme:dark] bg-bg text-ink";

export type WeekDay = {
  date: string;
  dow: string;
  dayNum: string;
  isToday: boolean;
  total: number;
  completed: number;
  /** Workout titles (sessions) scheduled that day with athlete counts. */
  sessions: { title: string; athletes: number; completed: number }[];
};

/** Mon–Sun programming strip: which sessions run each day and how many athletes finished. */
export function WeekStrip({ days, hrefFor }: { days: WeekDay[]; hrefFor: (date: string) => string }) {
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-7" aria-label="This week">
      {days.map((d) => (
        <li key={d.date} className="min-w-0">
          <Link
            href={hrefFor(d.date)}
            aria-current={d.isToday ? "date" : undefined}
            className={cn(
              "flex h-full min-h-11 flex-row gap-3 rounded-lg border bg-surface p-2.5 hover:border-brand sm:min-h-36 sm:flex-col sm:gap-1.5",
              d.isToday ? "border-brand ring-2 ring-brand/25" : "border-edge",
            )}
          >
            <span className="flex w-14 shrink-0 items-baseline gap-1.5 sm:w-auto sm:justify-between">
              <span className={cn("text-[11px] font-bold uppercase tracking-wider", d.isToday ? "text-brand" : "text-ink-3")}>{d.dow}</span>
              <span className="text-lg leading-none font-extrabold tabular">{d.dayNum}</span>
            </span>
            <span className="min-w-0 flex-1 space-y-1">
              {d.sessions.length === 0 ? (
                <span className="block text-xs text-ink-3">Rest / none</span>
              ) : (
                d.sessions.slice(0, 3).map((s) => (
                  <span key={s.title} className="line-clamp-2 block rounded border-l-[3px] border-brand bg-brand/[0.07] px-1.5 py-0.5 text-xs leading-snug font-medium text-ink" title={`${s.title}: ${s.athletes} athletes`}>
                    {s.title} <span className="text-ink-2">· {s.athletes}</span>
                  </span>
                ))
              )}
              {d.sessions.length > 3 ? <span className="block text-[11px] text-ink-3">+{d.sessions.length - 3} more</span> : null}
            </span>
            {d.total ? (
              <span className="hidden sm:mt-auto sm:block">
                <ProgressBar done={d.completed} total={d.total} size="sm" />
                <span className="mt-1 block text-[11px] tabular text-ink-2">
                  {d.completed}/{d.total} done
                </span>
              </span>
            ) : null}
            {d.total ? <span className="shrink-0 self-center text-xs tabular text-ink-2 sm:hidden">{d.completed}/{d.total} done</span> : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}
