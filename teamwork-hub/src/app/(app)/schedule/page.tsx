import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { resources, serviceTypes } from "@/db/schema";
import { Callout, EmptyState, PageHeader, ButtonLink } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { listCoaches } from "@/lib/scheduling/availability";
import { calendarRange, parseView, parseYmd } from "@/lib/scheduling/calendar-range";
import { listSessions } from "@/lib/scheduling/queries";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";
import { listLocations, parseLocationParam } from "@/lib/locations";
import { DaysView, MonthView, ScheduleTabs, SessionCard } from "./_components/calendar";
import { CalendarToolbar, flatParams, hrefWith } from "./_components/nav";
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
  const live = sessions.filter((s) => s.status !== "cancelled");

  return (
    <>
      <PageHeader
        kicker="Schedule"
        title="Schedule"
        description="Classes, private sessions, assessments and camps. Select a session to manage its roster and attendance."
        actions={
          manager ? (
            <>
              <ButtonLink href="/schedule/settings?tab=session" variant="secondary" className="min-h-11">
                New session
              </ButtonLink>
              <ButtonLink href="/kiosk" variant="outline" className="min-h-11">
                Open kiosk
              </ButtonLink>
            </>
          ) : (
            <ButtonLink href="/kiosk" variant="outline" className="min-h-11">
              Open kiosk
            </ButtonLink>
          )
        }
      />
      <ScheduleTabs current="calendar" staff manager={manager} />

      <form method="get" className="mb-4 grid gap-3 rounded-xl border border-edge bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]" aria-label="Filter sessions">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="date" value={range.anchor} />
        {locs.length ? (
          <label className="text-sm">
            <span className="mb-1 block font-medium text-ink-2">Location</span>
            <select name="location" defaultValue={filters.locationId ?? ""} className="h-11 w-full rounded-lg border border-edge bg-surface px-3 text-sm">
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
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink-2">Coach</span>
          <select name="coach" defaultValue={coachParam ?? "all"} className="h-11 w-full rounded-lg border border-edge bg-surface px-3 text-sm">
            <option value="all">All coaches</option>
            {coaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink-2">Service</span>
          <select name="service" defaultValue={params.service ?? ""} className="h-11 w-full rounded-lg border border-edge bg-surface px-3 text-sm">
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink-2">Room / area</span>
          <select name="resource" defaultValue={params.resource ?? ""} className="h-11 w-full rounded-lg border border-edge bg-surface px-3 text-sm">
            <option value="">All rooms</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-11 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
            Apply
          </button>
          <a href={`/schedule?view=${view}&date=${range.anchor}&coach=all`} className="inline-flex h-11 items-center rounded-lg px-3 text-sm text-ink-3 hover:text-ink">
            Clear
          </a>
        </div>
      </form>

      <CalendarToolbar params={params} view={view} label={range.label} prev={range.prev} next={range.next} today={today} />

      <p className="sr-only" aria-live="polite">
        {live.length} session{live.length === 1 ? "" : "s"} in view
      </p>

      {sessions.length === 0 ? (
        <EmptyState title="No sessions in this range">
          {manager ? (
            <>
              Add class series and generate sessions in <a className="underline" href="/schedule/settings?tab=series">Schedule settings</a>, or create a one-off session.
            </>
          ) : (
            "Try another date or clear the filters."
          )}
        </EmptyState>
      ) : view === "month" ? (
        <MonthView days={range.days} sessions={sessions} tz={tz} today={today} monthPrefix={range.monthPrefix!} dayHref={dayHref} />
      ) : (
        <DaysView days={range.days} sessions={sessions} tz={tz} today={today} dayHref={dayHref} render={(s) => <SessionCard s={s} tz={tz} href={`/schedule/sessions/${s.id}`} />} />
      )}
      {v.role === "coach" ? (
        <Callout className="mt-6" tone="info">
          You can take attendance and manage rosters for your own sessions. Schedule changes (series, cancellations, substitutions) are made by operations.
        </Callout>
      ) : null}
    </>
  );
}
