import Link from "next/link";
import { cn } from "@/lib/cn";
import type { SessionListItem } from "@/lib/scheduling/queries";
import { fmt } from "@/lib/time";
import { daySpan, hourWindow, packColumns, shortTime, spanToPercent } from "./grid-layout";

/** Pixel height of one hour row in the time grid. */
const HOUR_PX = 64;

export type GridColumn = {
  key: string;
  /** Visible header content. */
  header: React.ReactNode;
  /** Local date the column draws (YYYY-MM-DD). */
  ymd: string;
  sessions: SessionListItem[];
  today?: boolean;
};

/** "6:00–7:00 PM" or "11:30 AM–12:30 PM", in facility time. */
export function timeRange(s: Pick<SessionListItem, "startsAt" | "endsAt">, tz: string) {
  const a = fmt(s.startsAt, "a", tz);
  const b = fmt(s.endsAt, "a", tz);
  return a === b ? `${fmt(s.startsAt, "h:mm", tz)}–${fmt(s.endsAt, "h:mm a", tz)}` : `${fmt(s.startsAt, "h:mm a", tz)}–${fmt(s.endsAt, "h:mm a", tz)}`;
}

export function coachShort(name: string | null) {
  return name ? name.replace(/^Coach /, "") : "No coach";
}

/** Accessible name for a session link: everything the block shows, in words. */
export function sessionLabel(s: SessionListItem, tz: string) {
  const cancelled = s.status === "cancelled";
  const full = s.booked >= s.capacity;
  return [
    s.title,
    `${fmt(s.startsAt, "EEEE MMM d", tz)}, ${timeRange(s, tz)}`,
    s.serviceName,
    coachShort(s.coachName) + (s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (substitute)" : ""),
    s.resourceName,
    cancelled ? "cancelled" : `${s.booked} of ${s.capacity} booked${full ? ", full" : ""}`,
    !cancelled && s.waitlisted > 0 ? `${s.waitlisted} waitlisted` : null,
    s.visibility === "private" ? "private" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Small FULL / waitlist flags. Solid token colors with surface text pass contrast in light and dark themes. */
export function CapacityFlags({ s, className }: { s: SessionListItem; className?: string }) {
  if (s.status === "cancelled") return null;
  const full = s.booked >= s.capacity;
  if (!full && s.waitlisted === 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 gap-0.5", className)}>
      {full ? <span className="rounded-[3px] bg-bad px-1 text-[9px] leading-[14px] font-bold tracking-wide text-surface">FULL</span> : null}
      {s.waitlisted > 0 ? <span className="rounded-[3px] bg-warn px-1 text-[9px] leading-[14px] font-bold tracking-wide text-surface">WL {s.waitlisted}</span> : null}
    </span>
  );
}

/** Service-color styling: light tint of the service color behind dark ink (dark tint + light ink in dark mode). */
export const svcTint =
  "border border-[color-mix(in_srgb,var(--svc)_40%,transparent)] border-l-[3px] border-l-[var(--svc)] bg-[color-mix(in_srgb,var(--svc)_13%,var(--surface))] text-ink";
export const svcStyle = (color: string) => ({ ["--svc" as string]: color }) as React.CSSProperties;

function blockParts({ s, tz, href, start, minutes }: { s: SessionListItem; tz: string; href?: string; start: number; minutes: number }) {
  const cancelled = s.status === "cancelled";
  const compact = minutes < 40;
  const roomy = minutes >= 75;
  const body = (
    <>
      <span className="flex items-start justify-between gap-1">
        <span className="min-w-0 truncate whitespace-nowrap tabular font-semibold text-ink-2">
          {compact ? `${shortTime(start)} ${s.title}` : timeRange(s, tz)}
        </span>
        <CapacityFlags s={s} />
      </span>
      {!compact ? <span className={cn("block truncate font-semibold", cancelled && "line-through")}>{s.title}</span> : null}
      {!compact ? (
        <span className="block truncate text-ink-2">
          {coachShort(s.coachName)}
          {s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (sub)" : ""}
          {roomy && s.resourceName ? ` · ${s.resourceName}` : ""}
        </span>
      ) : null}
      {!compact && minutes >= 55 ? (
        <span className="block truncate tabular font-semibold text-ink-2">
          {cancelled ? "Cancelled" : `${s.booked}/${s.capacity}`}
          {!cancelled && s.visibility === "private" ? <span className="font-normal"> · Private</span> : null}
        </span>
      ) : null}
    </>
  );
  const cls = cn(
    "absolute block overflow-hidden rounded-[4px] px-1.5 py-0.5 text-[11px] leading-[14px] shadow-[0_1px_2px_rgb(16_24_40/0.08)]",
    cancelled ? "border border-dashed border-edge bg-surface-2 text-ink-3" : svcTint,
  );
  return { body, cls, href };
}

/** Time-grid calendar: hour rows down the left, one column per day (week) or per coach (day). */
export function TimeGrid({
  columns,
  tz,
  sessionHref,
  nowMinutes,
  label,
  minColPx = 0,
}: {
  columns: GridColumn[];
  tz: string;
  sessionHref?: (s: SessionListItem) => string;
  /** Minutes since local midnight right now, drawn as a line on `today` columns. */
  nowMinutes?: number | null;
  label: string;
  minColPx?: number;
}) {
  const laid = columns.map((c) => {
    const spans = c.sessions.map((s) => ({ id: s.id, ...daySpan(s.startsAt, s.endsAt, c.ymd, tz) }));
    return { c, spans, packed: packColumns(spans) };
  });
  const win = hourWindow(laid.flatMap((l) => l.spans));
  const hours = Array.from({ length: win[1] - win[0] }, (_, i) => win[0] + i);
  const height = hours.length * HOUR_PX;
  const template = { gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(${minColPx ? `${minColPx}px` : "0"}, 1fr))` } as React.CSSProperties;
  const showNow = nowMinutes != null && nowMinutes >= win[0] * 60 && nowMinutes < win[1] * 60;

  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={minColPx ? 0 : undefined}>
      <div className="min-w-0">
        <div className="sticky top-0 z-10 grid border-b border-edge bg-th" style={template}>
          <div className="border-r border-edge px-1 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-ink-3">
            <span className="sr-only">Time</span>
          </div>
          {columns.map((c) => (
            <div key={c.key} className={cn("min-w-0 border-r border-edge last:border-r-0", c.today && "bg-brand/5")}>
              {c.header}
            </div>
          ))}
        </div>
        <div className="grid" style={template}>
          <div className="relative border-r border-edge bg-surface" style={{ height }} aria-hidden>
            {hours.map((h, i) => (
              <span key={h} className={cn("absolute right-1.5 text-[10px] font-semibold whitespace-nowrap tabular text-ink-3", i === 0 ? "translate-y-0.5" : "-translate-y-1/2")} style={{ top: i * HOUR_PX }}>
                {h % 12 === 0 ? 12 : h % 12} {h < 12 ? "AM" : "PM"}
              </span>
            ))}
          </div>
          {laid.map(({ c, spans, packed }) => (
            <div key={c.key} className={cn("relative min-w-0 border-r border-edge last:border-r-0", c.today ? "bg-brand/[0.03]" : "bg-surface")} style={{ height }}>
              {hours.map((h, i) => (
                <div key={h} aria-hidden className="pointer-events-none absolute inset-x-0" style={{ top: i * HOUR_PX, height: HOUR_PX }}>
                  <div className={cn("border-t border-edge/80", i === 0 && "border-t-0")} />
                  <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-edge/50" />
                </div>
              ))}
              {c.today && showNow ? (
                <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-bad" style={{ top: `${((nowMinutes! - win[0] * 60) / ((win[1] - win[0]) * 60)) * 100}%` }}>
                  <span className="absolute -top-[5px] -left-[4px] size-2 rounded-full bg-bad" />
                </div>
              ) : null}
              <ul aria-label={typeof c.header === "string" ? c.header : undefined}>
                {c.sessions.map((s, i) => {
                  const span = spans[i];
                  const p = packed.get(s.id) ?? { col: 0, cols: 1 };
                  const pct = spanToPercent(span, win);
                  const b = blockParts({ s, tz, href: sessionHref?.(s), start: span.start, minutes: span.end - span.start });
                  const style = {
                    ...svcStyle(s.color),
                    top: `calc(${pct.top}% + 1px)`,
                    height: `max(calc(${pct.height}% - 2px), 18px)`,
                    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                    width: `calc(${100 / p.cols}% - 4px)`,
                  } as React.CSSProperties;
                  return (
                    <li key={s.id}>
                      {b.href ? (
                        <Link
                          href={b.href}
                          style={style}
                          aria-label={sessionLabel(s, tz)}
                          className={cn(b.cls, "hover:z-20 hover:shadow-md focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand")}
                        >
                          {b.body}
                        </Link>
                      ) : (
                        <div style={style} className={b.cls} aria-label={sessionLabel(s, tz)} role="group">
                          {b.body}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Color key for the service types visible in the current range. */
export function ServiceLegend({ sessions }: { sessions: SessionListItem[] }) {
  const seen = new Map<string, { name: string; color: string }>();
  for (const s of sessions) if (!seen.has(s.serviceTypeId)) seen.set(s.serviceTypeId, { name: s.serviceName, color: s.color });
  if (!seen.size) return null;
  return (
    <ul aria-label="Service colors" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
      {[...seen.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([id, v]) => (
          <li key={id} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("inline-block h-3 w-4 rounded-[3px]", svcTint)} style={svcStyle(v.color)} />
            {v.name}
          </li>
        ))}
    </ul>
  );
}
