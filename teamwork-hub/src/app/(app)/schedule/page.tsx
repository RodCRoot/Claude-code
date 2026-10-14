import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { resources, serviceTypes } from "@/db/schema";
import { Callout, EmptyState, PageHeader, ButtonLink } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { cn } from "@/lib/cn";
import { listCoaches } from "@/lib/scheduling/availability";
import { calendarRange, parseView, parseYmd } from "@/lib/scheduling/calendar-range";
import { listSessions, type SessionListItem } from "@/lib/scheduling/queries";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";
import { listLocations, parseLocationParam } from "@/lib/locations";
import { byDay, dayLabel, DaysView, Initials, MonthView, ScheduleTabs, SessionRow } from "./_components/calendar";
import { localMinutes } from "./_components/grid-layout";
import { CalendarToolbar, flatParams, hrefWith, rangeLabel } from "./_components/nav";
import { ServiceLegend, TimeGrid, type GridColumn } from "./_components/time-grid";
import { FamilySchedule } from "./_components/family-schedule";

export const metadata = { title: "Schedule" };

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireViewer();
  const params = flatParams(await searchParams);
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? DEFAULT_TZ;
  const today = todayLocal(tz);
  const view = parseView(params.view);
  const range = calendarRange(view, parseYmd(params.date, today), tz);
  const staff = isStaff(v);
  const manager = can(v, "schedule.manage");

  if (!staff) {
    return (
      <>
        <PageHeader kicker="Schedule" title="Book sessions" description="Pick an athlete, then book classes, camps, and assessments. Times are shown in the facility's local time." />
        <ScheduleTabs current="calendar" staff={false} manager={false} />
        <FamilySchedule viewer={v} params={params} range={range} tz={tz} today={today} />
      </>
    );
  }

  // Coaches default to their own sessions; "all" shows everyone's.
  const coachParam = params.coach ?? (v.role === "coach" ? v.userId : undefined);
  const filters = {
    coachUserId: coachParam && coachParam !== "all" ? coachParam : null,
    serviceTypeId: params.service || null,
    resourceId: params.resource || null,
    locationId: parseLocationParam(params.location),
  };
  const [sessions, coaches, services, rooms, locs] = await Promise.all([
    listSessions(db, v, { from: range.from, to: range.to, filters }),
    listCoaches(db, v.orgId),
    db.select({ id: serviceTypes.id, name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.orgId, v.orgId)).orderBy(asc(serviceTypes.name)),
    db.select({ id: resources.id, name: resources.name }).from(resources).where(eq(resources.orgId, v.orgId)).orderBy(asc(resources.name)),
    listLocations(db, v.orgId),
  ]);
  const dayHref = (d: string) => hrefWith("/schedule", params, { view: "day", date: d });
  const sessionHref = (s: SessionListItem) => `/schedule/sessions/${s.id}`;
  const live = sessions.filter((s) => s.status !== "cancelled");
  const label = rangeLabel(view, range.first, range.last, range.label);
  const nowMinutes = range.days.includes(today) ? localMinutes(new Date(), tz) : null;
  const grouped = byDay(sessions, tz);

  // Week: one column per day. Day: one column per coach working that day.
  let columns: GridColumn[] = [];
  if (view === "week") {
    columns = range.days.map((d) => ({
      key: d,
      ymd: d,
      today: d === today,
      sessions: grouped.get(d) ?? [],
      header: (
        <Link href={dayHref(d)} aria-label={`${dayLabel(d, "EEEE, MMMM d")}, open day view`} className="flex items-center justify-center gap-1.5 py-1.5 hover:bg-surface-2">
          <span className={cn("text-[11px] font-bold uppercase tracking-wide", d === today ? "text-brand" : "text-ink-3")}>{dayLabel(d, "EEE")}</span>
          <span className={cn("inline-flex size-7 items-center justify-center rounded-full text-base font-bold tabular", d === today ? "bg-brand text-brand-ink" : "text-ink")}>{Number(d.slice(8))}</span>
        </Link>
      ),
    }));
  } else if (view === "day") {
    const d = range.days[0];
    const byCoach = new Map<string, { name: string; list: SessionListItem[] }>();
    for (const s of grouped.get(d) ?? []) {
      const k = s.coachUserId ?? "none";
      const e = byCoach.get(k) ?? { name: s.coachName ?? "No coach", list: [] };
      e.list.push(s);
      byCoach.set(k, e);
    }
    const entries: [string, { name: string; list: SessionListItem[] }][] = [...byCoach.entries()].sort((a, b) =>
      a[0] === "none" ? 1 : b[0] === "none" ? -1 : a[1].name.localeCompare(b[1].name),
    );
    if (!entries.length) entries.push(["all", { name: "All sessions", list: [] }]);
    columns = entries.map(([k, e]) => ({
      key: k,
      ymd: d,
      today: d === today,
      sessions: e.list,
      header: (
        <div className="flex min-w-0 items-center justify-center gap-2 px-2 py-1.5">
          {k !== "all" && k !== "none" ? <Initials name={e.name.replace(/^Coach /, "")} /> : null}
          <span className="truncate text-sm font-semibold">{e.name}</span>
          <span className="text-xs text-ink-3 tabular">
            {e.list.filter((s) => s.status !== "cancelled").length}
            <span className="sr-only"> sessions</span>
          </span>
        </div>
      ),
    }));
  }

  const selectCls = "h-9 w-full rounded-md border border-edge bg-surface px-2.5 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand sm:w-auto sm:min-w-40";

  return (
    <>
      <PageHeader
        kicker="Schedule"
        title="Calendar"
        description="Classes, private sessions, assessments and camps. Select a session to open its roster and attendance."
        actions={
          <ButtonLink href="/kiosk" variant="secondary" className="min-h-10">
            Open kiosk
          </ButtonLink>
        }
      />
      <ScheduleTabs current="calendar" staff manager={manager} />

      <section aria-label="Calendar" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        <CalendarToolbar
          className="border-b border-edge px-3 py-2.5"
          params={params}
          view={view}
          label={label}
          prev={range.prev}
          next={range.next}
          today={today}
          actions={
            manager ? (
              <ButtonLink href="/schedule/settings?tab=session" size="sm" className="h-9">
                <span aria-hidden>+</span> New session
              </ButtonLink>
            ) : null
          }
        />

        <form method="get" className="grid grid-cols-2 items-center gap-2 border-b border-edge bg-th px-3 py-2 sm:flex sm:flex-wrap" aria-label="Filter sessions">
          <span className="col-span-2 text-[11px] font-bold uppercase tracking-wide text-ink-2 sm:mr-1">Filter</span>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={range.anchor} />
          {locs.length ? (
            <label className="min-w-0">
              <span className="sr-only">Location</span>
              <select name="location" defaultValue={filters.locationId ?? ""} className={selectCls}>
                <option value="">All locations</option>
                {locs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="min-w-0">
            <span className="sr-only">Coach</span>
            <select name="coach" defaultValue={coachParam ?? "all"} className={selectCls}>
              <option value="all">All coaches</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Service</span>
            <select name="service" defaultValue={params.service ?? ""} className={selectCls}>
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Room / area</span>
            <select name="resource" defaultValue={params.resource ?? ""} className={selectCls}>
              <option value="">All rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 flex items-center gap-1">
            <button type="submit" className="h-9 rounded-md border border-edge bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2">
              Apply
            </button>
            <a href={`/schedule?view=${view}&date=${range.anchor}&coach=all`} className="inline-flex h-9 items-center rounded-md px-2.5 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
              Clear
            </a>
          </div>
        </form>

        {live.length ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-3 py-2">
            <ServiceLegend sessions={live} />
            <p className="text-xs text-ink-3 tabular" aria-live="polite">
              {live.length} session{live.length === 1 ? "" : "s"} in view
            </p>
          </div>
        ) : (
          <p className="sr-only" aria-live="polite">
            0 sessions in view
          </p>
        )}

        {sessions.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No sessions in this range">
              {manager ? (
                <>
                  Add class series and generate sessions in <a className="underline" href="/schedule/settings?tab=series">Schedule settings</a>, or create a one-off session.
                </>
              ) : (
                "Try another date or clear the filters."
              )}
            </EmptyState>
          </div>
        ) : view === "month" ? (
          <MonthView days={range.days} sessions={sessions} tz={tz} today={today} monthPrefix={range.monthPrefix!} dayHref={dayHref} sessionHref={sessionHref} />
        ) : (
          <>
            <div className={view === "week" ? "hidden lg:block" : "hidden md:block"}>
              <TimeGrid
                columns={columns}
                tz={tz}
                sessionHref={sessionHref}
                nowMinutes={nowMinutes}
                label={view === "week" ? `Week of ${label}` : `${label} by coach`}
                minColPx={view === "day" && columns.length > 4 ? 160 : 0}
              />
            </div>
            <DaysView
              className={cn("bg-bg p-3", view === "week" ? "lg:hidden" : "md:hidden")}
              days={range.days}
              sessions={sessions}
              tz={tz}
              today={today}
              dayHref={dayHref}
              render={(s) => <SessionRow s={s} tz={tz} href={sessionHref(s)} />}
            />
          </>
        )}
      </section>
      {v.role === "coach" ? (
        <Callout className="mt-6" tone="info">
          You can take attendance and manage rosters for your own sessions. Schedule changes (series, cancellations, substitutions) are made by operations.
        </Callout>
      ) : null}
    </>
  );
}
