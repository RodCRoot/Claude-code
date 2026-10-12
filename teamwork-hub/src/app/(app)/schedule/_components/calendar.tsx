import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { SessionListItem } from "@/lib/scheduling/queries";
import { fmt, fmtTime, isoWeekday, localYmd } from "@/lib/time";

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

/** Compact staff session card (links to the roster). */
export function SessionCard({ s, tz, href, children }: { s: SessionListItem; tz: string; href?: string; children?: React.ReactNode }) {
  const cap = capacityText(s);
  const cancelled = s.status === "cancelled";
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold tabular text-ink-3">
            {fmtTime(s.startsAt, tz)} – {fmtTime(s.endsAt, tz)}
          </div>
          <div className={cn("line-clamp-2 break-words font-semibold leading-snug", cancelled && "line-through opacity-70")}>{s.title}</div>
        </div>
        {cancelled ? <StatusBadge status="cancelled" /> : cap.full ? <Badge variant="yellow">Full</Badge> : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-ink-3">
        {s.coachName ? (
          <span>
            {s.coachName.replace(/^Coach /, "")}
            {s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (sub)" : ""}
          </span>
        ) : (
          <span>No coach</span>
        )}
        {s.resourceName ? <span>· {s.resourceName}</span> : null}
      </div>
      {!cancelled ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="tabular font-medium">{cap.main}</span>
          {cap.wait ? <Badge variant="yellow">{cap.wait}</Badge> : null}
          {s.visibility === "private" ? <Badge>Private</Badge> : null}
        </div>
      ) : null}
      {children}
    </>
  );
  const cls = "block rounded-lg border border-edge bg-surface p-3 text-sm shadow-[inset_4px_0_0_var(--svc)]";
  const style = { ["--svc" as string]: s.color } as React.CSSProperties;
  return href ? (
    <Link href={href} className={cn(cls, "min-h-11 hover:border-brand focus-visible:outline-2 focus-visible:outline-brand")} style={style} aria-label={`${s.title}, ${fmt(s.startsAt, "EEEE MMM d h:mm a", tz)}, ${cap.main}${cap.wait ? `, ${cap.wait}` : ""}${cancelled ? ", cancelled" : ""}`}>
      {body}
    </Link>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}

/** Week / day columns. On small screens days stack vertically. */
export function DaysView({
  days,
  sessions,
  tz,
  today,
  render,
  dayHref,
}: {
  days: string[];
  sessions: SessionListItem[];
  tz: string;
  today: string;
  render: (s: SessionListItem) => React.ReactNode;
  dayHref: (d: string) => string;
}) {
  const grouped = byDay(sessions, tz);
  const multi = days.length > 1;
  return (
    <div className={cn("grid gap-3", multi && "lg:grid-cols-7")}>
      {days.map((d) => {
        const list = grouped.get(d) ?? [];
        return (
          <section key={d} aria-labelledby={`day-${d}`} className={cn("min-w-0", multi && "lg:rounded-xl lg:border lg:border-edge lg:bg-surface-2/40 lg:p-2")}>
            <h3 id={`day-${d}`} className={cn("mb-2 flex items-baseline gap-2 text-sm font-semibold", d === today && "text-brand")}>
              {multi ? (
                <Link href={dayHref(d)} className="inline-flex min-h-11 items-center hover:underline">
                  {WD[isoWeekday(d) - 1]} <span className="ml-1 tabular">{d.slice(5).replace("-", "/")}</span>
                </Link>
              ) : (
                <span>{dayLabel(d, "EEEE, MMMM d")}</span>
              )}
              {d === today ? <Badge variant="brand">Today</Badge> : null}
            </h3>
            {list.length ? (
              <ul className="space-y-2">
                {list.map((s) => (
                  <li key={s.id}>{render(s)}</li>
                ))}
              </ul>
            ) : (
              <p className={cn("text-xs text-ink-3", multi && "hidden lg:block")}>No sessions</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Month grid (md+) with a day list fallback on phones. Each day cell is one large link to the day view. */
export function MonthView({ days, sessions, tz, today, monthPrefix, dayHref }: { days: string[]; sessions: SessionListItem[]; tz: string; today: string; monthPrefix: string; dayHref: (d: string) => string }) {
  const grouped = byDay(sessions, tz);
  return (
    <>
      <div className="hidden md:block">
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-edge bg-edge" role="grid" aria-label="Month">
          {WD.map((w) => (
            <div key={w} role="columnheader" className="bg-surface-2 px-2 py-1 text-xs font-semibold text-ink-3">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const list = (grouped.get(d) ?? []).filter((s) => s.status !== "cancelled");
            const inMonth = d.startsWith(monthPrefix);
            return (
              <Link
                key={d}
                role="gridcell"
                href={dayHref(d)}
                aria-label={`${dayLabel(d, "EEEE MMMM d")}: ${list.length} session${list.length === 1 ? "" : "s"}`}
                className={cn("min-h-24 bg-surface p-1.5 text-xs hover:bg-surface-2", !inMonth && "bg-surface-2/60 text-ink-3")}
              >
                <div className={cn("mb-1 font-semibold tabular", d === today && "inline-flex size-6 items-center justify-center rounded-full bg-brand text-brand-ink")}>{Number(d.slice(8))}</div>
                <ul className="space-y-0.5">
                  {list.slice(0, 3).map((s) => (
                    <li key={s.id} className="truncate">
                      <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: s.color }} aria-hidden />
                      <span className="tabular">{fmt(s.startsAt, "h:mma", tz).toLowerCase()}</span> {s.title}
                    </li>
                  ))}
                  {list.length > 3 ? <li className="font-medium text-brand">+{list.length - 3} more</li> : null}
                </ul>
              </Link>
            );
          })}
        </div>
      </div>
      <ul className="space-y-2 md:hidden">
        {days
          .filter((d) => d.startsWith(monthPrefix) && (grouped.get(d) ?? []).some((s) => s.status !== "cancelled"))
          .map((d) => {
            const n = (grouped.get(d) ?? []).filter((s) => s.status !== "cancelled").length;
            return (
              <li key={d}>
                <Link href={dayHref(d)} className="flex min-h-11 items-center justify-between rounded-lg border border-edge bg-surface px-3 text-sm">
                  <span className={cn("font-medium", d === today && "text-brand")}>{dayLabel(d, "EEE, MMM d")}</span>
                  <span className="text-ink-3">
                    {n} session{n === 1 ? "" : "s"}
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
    <nav aria-label="Schedule sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-edge">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn("-mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium", t.key === current ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
