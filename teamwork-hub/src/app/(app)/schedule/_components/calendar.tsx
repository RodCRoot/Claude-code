import Link from "next/link";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { SessionListItem } from "@/lib/scheduling/queries";
import { fmt, localYmd } from "@/lib/time";
import { CapacityFlags, coachShort, sessionLabel, svcStyle, svcTint } from "./time-grid";

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Label for a local calendar date (YYYY-MM-DD); formatted at UTC noon so it never shifts a day. */
export function dayLabel(ymd: string, pattern = "EEE MMM d") {
  return fmt(new Date(`${ymd}T12:00:00Z`), pattern, "UTC");
}

export function capacityText(s: Pick<SessionListItem, "booked" | "capacity" | "waitlisted" | "waitlistCapacity">) {
  const spots = Math.max(0, s.capacity - s.booked);
  return {
    main: `${s.booked}/${s.capacity} booked`,
    spots,
    wait: s.waitlisted > 0 ? `${s.waitlisted} waitlisted` : null,
    full: spots === 0,
  };
}

/** Group sessions by facility-local date. */
export function byDay(sessions: SessionListItem[], tz: string) {
  const m = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const d = localYmd(s.startsAt, tz);
    m.set(d, [...(m.get(d) ?? []), s]);
  }
  return m;
}

/** Decorative initials avatar (neutral colors so it never fails contrast on tinted headers). */
export function Initials({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold text-ink-2 ring-1 ring-edge", className)}>
      {initials}
    </span>
  );
}

/** Thin fill bar for booked/capacity (decorative; the numbers are always in text). */
export function CapacityBar({ s, className }: { s: Pick<SessionListItem, "booked" | "capacity" | "color">; className?: string }) {
  const pct = s.capacity > 0 ? Math.min(100, Math.round((s.booked / s.capacity) * 100)) : 100;
  return (
    <span aria-hidden className={cn("inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 ring-1 ring-edge ring-inset", className)}>
      <span className="block h-full rounded-full bg-[var(--svc)]" style={{ ...svcStyle(s.color), width: `${pct}%` }} />
    </span>
  );
}

/**
 * One session as an agenda row: time column, details, and an optional action slot (family booking).
 * With `href` the whole row is a link to the roster.
 */
export function SessionRow({ s, tz, href, children }: { s: SessionListItem; tz: string; href?: string; children?: React.ReactNode }) {
  const cap = capacityText(s);
  const cancelled = s.status === "cancelled";
  const details = (
    <>
      <div className="w-[4.75rem] shrink-0 pt-px text-xs tabular">
        <div className="font-semibold text-ink">{fmt(s.startsAt, "h:mm a", tz)}</div>
        <div className="text-ink-3">{fmt(s.endsAt, "h:mm a", tz)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("font-semibold leading-snug break-words", cancelled && "text-ink-3 line-through")}>{s.title}</span>
          {cancelled ? <Badge variant="red">Cancelled</Badge> : <CapacityFlags s={s} />}
          {s.visibility === "private" && !cancelled ? <Badge>Private</Badge> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-ink-3">
          <span>{s.serviceName}</span>
          <span aria-hidden>·</span>
          <span>
            {coachShort(s.coachName)}
            {s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (sub)" : ""}
          </span>
          {s.resourceName ? (
            <>
              <span aria-hidden>·</span>
              <span>{s.resourceName}</span>
            </>
          ) : null}
          {s.locationName ? (
            <>
              <span aria-hidden>·</span>
              <span>{s.locationName}</span>
            </>
          ) : null}
        </div>
        {!cancelled ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs whitespace-nowrap">
            <CapacityBar s={s} />
            <span className="font-semibold tabular text-ink-2">{cap.main}</span>
            {cap.wait ? <span className="text-ink-3">· {cap.wait}</span> : null}
          </div>
        ) : null}
      </div>
    </>
  );
  const rowCls = "flex gap-3 border-l-[3px] border-l-[var(--svc)] px-3 py-2.5 text-sm";
  if (href) {
    return (
      <Link href={href} className={cn(rowCls, "hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand")} style={svcStyle(s.color)} aria-label={sessionLabel(s, tz)}>
        {details}
      </Link>
    );
  }
  return (
    <div className={cn(rowCls, "flex-col sm:flex-row sm:items-start")} style={svcStyle(s.color)}>
      <div className="flex min-w-0 flex-1 gap-3">{details}</div>
      {children ? <div className="sm:w-56 sm:shrink-0 sm:text-right [&_form]:sm:flex [&_form]:sm:flex-col [&_form]:sm:items-end">{children}</div> : null}
    </div>
  );
}

/** Agenda: one titled panel per day, sessions as rows. Used on phones (staff) and for family booking. */
export function DaysView({
  days,
  sessions,
  tz,
  today,
  render,
  dayHref,
  className,
}: {
  days: string[];
  sessions: SessionListItem[];
  tz: string;
  today: string;
  render: (s: SessionListItem) => React.ReactNode;
  dayHref: (d: string) => string;
  className?: string;
}) {
  const grouped = byDay(sessions, tz);
  const multi = days.length > 1;
  return (
    <div className={cn("space-y-3", className)}>
      {days.map((d) => {
        const list = grouped.get(d) ?? [];
        const live = list.filter((s) => s.status !== "cancelled").length;
        return (
          <section key={d} aria-labelledby={`day-${d}`} className={cn("overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]", multi && !list.length && "hidden sm:block")}>
            <div className={cn("flex items-center justify-between gap-2 border-b border-edge bg-th px-3", d === today && "border-b-brand/40 bg-brand/10")}>
              <h3 id={`day-${d}`} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-ink-2">
                {multi ? (
                  <Link href={dayHref(d)} className="inline-flex min-h-10 items-center hover:text-ink hover:underline">
                    {dayLabel(d, "EEEE, MMM d")}
                  </Link>
                ) : (
                  <span className="inline-flex min-h-10 items-center">{dayLabel(d, "EEEE, MMMM d")}</span>
                )}
                {d === today ? <Badge variant="brand">Today</Badge> : null}
              </h3>
              <span className="text-xs text-ink-3 tabular">
                {live} session{live === 1 ? "" : "s"}
              </span>
            </div>
            {list.length ? (
              <ul className="divide-y divide-edge">
                {list.map((s) => (
                  <li key={s.id}>{render(s)}</li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2.5 text-xs text-ink-3">No sessions</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Month grid (md+) with session chips and "+N more"; a day list on phones. */
export function MonthView({
  days,
  sessions,
  tz,
  today,
  monthPrefix,
  dayHref,
  sessionHref,
}: {
  days: string[];
  sessions: SessionListItem[];
  tz: string;
  today: string;
  monthPrefix: string;
  dayHref: (d: string) => string;
  sessionHref?: (s: SessionListItem) => string;
}) {
  const grouped = byDay(sessions, tz);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const MAX = 4;
  return (
    <>
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Sessions by day</caption>
          <thead>
            <tr>
              {WD.map((w) => (
                <th key={w} scope="col" className="border-b border-edge bg-th px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((wk) => (
              <tr key={wk[0]}>
                {wk.map((d) => {
                  const list = (grouped.get(d) ?? []).filter((s) => s.status !== "cancelled");
                  const inMonth = d.startsWith(monthPrefix);
                  return (
                    <td key={d} className={cn("h-32 border-r border-b border-edge p-1 align-top last:border-r-0", inMonth ? "bg-surface" : "bg-surface-2", d === today && "bg-brand/5")}>
                      <Link
                        href={dayHref(d)}
                        aria-label={`${dayLabel(d, "EEEE MMMM d")}: ${list.length} session${list.length === 1 ? "" : "s"}`}
                        className={cn(
                          "mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular hover:bg-surface-2 hover:underline",
                          d === today ? "bg-brand text-brand-ink hover:bg-brand" : inMonth ? "text-ink" : "text-ink-3",
                        )}
                      >
                        {Number(d.slice(8))}
                      </Link>
                      <ul className="space-y-0.5">
                        {list.slice(0, MAX).map((s) => {
                          const chip = (
                            <>
                              <span className="tabular font-semibold text-ink-2">{fmt(s.startsAt, "h:mma", tz).toLowerCase().replace(":00", "")}</span> {s.title}
                            </>
                          );
                          const cls = cn("block truncate rounded-[3px] px-1 py-px text-[11px] leading-4", svcTint);
                          return (
                            <li key={s.id}>
                              {sessionHref ? (
                                <Link href={sessionHref(s)} aria-label={sessionLabel(s, tz)} className={cn(cls, "hover:shadow-sm focus-visible:outline-2 focus-visible:outline-brand")} style={svcStyle(s.color)}>
                                  {chip}
                                </Link>
                              ) : (
                                <span className={cls} style={svcStyle(s.color)}>
                                  {chip}
                                </span>
                              )}
                            </li>
                          );
                        })}
                        {list.length > MAX ? (
                          <li>
                            <Link href={dayHref(d)} className="block px-1 text-[11px] font-semibold text-brand hover:underline">
                              +{list.length - MAX} more<span className="sr-only"> on {dayLabel(d, "MMMM d")}</span>
                            </Link>
                          </li>
                        ) : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-edge md:hidden">
        {days
          .filter((d) => d.startsWith(monthPrefix) && (grouped.get(d) ?? []).some((s) => s.status !== "cancelled"))
          .map((d) => {
            const list = (grouped.get(d) ?? []).filter((s) => s.status !== "cancelled");
            return (
              <li key={d}>
                <Link href={dayHref(d)} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-2">
                  <span className={cn("font-semibold", d === today && "text-brand")}>{dayLabel(d, "EEE, MMM d")}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-3">
                    <span aria-hidden className="flex gap-0.5">
                      {list.slice(0, 6).map((s) => (
                        <span key={s.id} className="inline-block size-2 rounded-full bg-[var(--svc)]" style={svcStyle(s.color)} />
                      ))}
                    </span>
                    {list.length} session{list.length === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            );
          })}
      </ul>
    </>
  );
}

export function ScheduleTabs({ current, staff, manager }: { current: "calendar" | "book" | "settings"; staff: boolean; manager: boolean }) {
  const tabs = [
    { key: "calendar", href: "/schedule", label: "Calendar" },
    { key: "book", href: "/schedule/book", label: staff ? "Private sessions" : "Book a private / assessment" },
    ...(staff ? [{ key: "settings", href: manager ? "/schedule/settings" : "/schedule/settings?tab=availability", label: manager ? "Schedule settings" : "My availability" }] : []),
  ];
  return (
    <nav aria-label="Schedule sections" className="mb-4 flex gap-1 overflow-x-auto rounded-t-md border-b border-edge">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-[3px] px-3 text-sm font-semibold",
            t.key === current ? "border-brand text-ink" : "border-transparent text-ink-3 hover:border-edge hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

