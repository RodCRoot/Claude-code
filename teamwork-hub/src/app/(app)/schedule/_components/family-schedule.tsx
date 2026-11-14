import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { serviceTypes } from "@/db/schema";
import { Badge, buttonClass, Callout, EmptyState } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { Viewer } from "@/lib/authz/policy";
import { listCoaches } from "@/lib/scheduling/availability";
import type { calendarRange } from "@/lib/scheduling/calendar-range";
import { bookingSettings } from "@/lib/scheduling/common";
import { athleteBookingsIn, familyAthletes, listSessions, type SessionListItem } from "@/lib/scheduling/queries";
import { addDaysYmd, fmt, startOfWeekYmd } from "@/lib/time";
import { listLocations, parseLocationParam } from "@/lib/locations";
import { byDay, dayLabel, MonthView } from "./calendar";
import { hrefWith, rangeLabel, type Params } from "./nav";
import { coachShort, svcStyle } from "./time-grid";
import { liveBySession, policiesByService, ReserveControl, spotsText, type BookingRules, type FamilyBooking, type FamilyMember } from "./reserve-control";
import { SessionCheckinCard } from "@/components/checkins/home-card";

type Range = ReturnType<typeof calendarRange>;
type Policies = Awaited<ReturnType<typeof policiesByService>>;

const selectCls = "h-11 w-full rounded-md border border-edge bg-surface px-2.5 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-brand";
const navBtn = "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-xl leading-none text-ink-2 hover:bg-surface-2 hover:text-ink";

/** Class detail URL that remembers the day the family came from. */
export function classHref(s: Pick<SessionListItem, "id">) {
  return `/schedule/classes/${s.id}`;
}

/** One class in the family day list: time and length, name, instructor, location, spots, and the one action. */
export function ClassRow({
  s,
  tz,
  members,
  bookings,
  rules,
  policies,
  now,
}: {
  s: SessionListItem;
  tz: string;
  members: FamilyMember[];
  bookings: Map<string, FamilyBooking> | undefined;
  rules: BookingRules;
  policies: Policies;
  now: Date;
}) {
  const cancelled = s.status === "cancelled";
  const minutes = Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000);
  const where = [s.locationName, s.resourceName].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-3 border-l-[3px] border-l-[var(--svc)] px-3 py-3 text-sm sm:flex-row sm:items-start" style={svcStyle(s.color)}>
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="w-[4.75rem] shrink-0 tabular">
          <div className="font-bold text-ink">{fmt(s.startsAt, "h:mm a", tz)}</div>
          <div className="text-xs text-ink-3">{minutes} min</div>
        </div>
        <div className="min-w-0 flex-1">
          <Link href={classHref(s)} className={cn("font-semibold leading-snug break-words hover:underline", cancelled && "text-ink-3 line-through")}>
            {s.title}
          </Link>
          {cancelled ? (
            <Badge variant="red" className="ml-2">
              Cancelled
            </Badge>
          ) : null}
          <div className="mt-0.5 text-xs text-ink-2">
            {coachShort(s.coachName)}
            {s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (sub)" : ""}
          </div>
          {where ? <div className="text-xs text-ink-3">{where}</div> : null}
          {!cancelled ? <div className={cn("mt-1 text-xs font-semibold tabular", s.booked >= s.capacity ? "text-bad" : "text-ink-2")}>{spotsText(s)}</div> : null}
        </div>
      </div>
      <div className="sm:w-60 sm:shrink-0">
        <ReserveControl s={s} members={members} bookings={bookings} rules={rules} policy={policies.get(s.serviceTypeId)} now={now} tz={tz} />
      </div>
    </div>
  );
}

/**
 * Family calendar: a single day by default (date header with arrows, jump to a date, the week's days),
 * optional program / location / instructor filters, then the day's classes in time order.
 */
export async function FamilySchedule({ viewer, params, range, tz, today }: { viewer: Viewer; params: Params; range: Range; tz: string; today: string }) {
  const members = await familyAthletes(db, viewer);
  if (!members.length) {
    return (
      <EmptyState title="No family members linked to your account yet">
        Ask the front desk to link your child (or your own athlete profile) to this login. Nothing can be reserved until then.
      </EmptyState>
    );
  }
  const now = new Date();
  const locationId = parseLocationParam(params.location);
  const [rules, locs, staffList, programs, policies] = await Promise.all([
    bookingSettings(db, viewer.orgId),
    listLocations(db, viewer.orgId, { activeOnly: true }),
    listCoaches(db, viewer.orgId),
    db
      .select({ id: serviceTypes.id, name: serviceTypes.name })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.orgId, viewer.orgId), eq(serviceTypes.active, true)))
      .orderBy(asc(serviceTypes.name)),
    policiesByService(viewer.orgId),
  ]);
  const coaches = staffList.filter((c) => c.role === "coach");
  const programId = programs.find((p) => p.id === params.program)?.id ?? null;
  const instructorId = coaches.find((c) => c.id === params.instructor)?.id ?? null;
  const sessions = await listSessions(db, viewer, {
    from: range.from,
    to: range.to,
    familyAthleteIds: members.map((a) => a.id),
    filters: { locationId, serviceTypeId: programId, coachUserId: instructorId },
  });
  const live = liveBySession(await athleteBookingsIn(db, viewer.orgId, members.map((a) => a.id), sessions.map((s) => s.id)));
  const view = range.view;
  const filtered = !!(locationId || programId || instructorId);
  const dayHref = (d: string) => hrefWith("/schedule", params, { view: "day", date: d });
  const weekStart = startOfWeekYmd(range.anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStart, i));
  const label = rangeLabel(view, range.first, range.last, range.label);
  const grouped = byDay(sessions, tz);
  const row = (s: SessionListItem) => <ClassRow s={s} tz={tz} members={members} bookings={live.get(s.id)} rules={rules} policies={policies} now={now} />;
  const noneCanReserve = members.every((m) => !m.canBook);

  return (
    <div className="space-y-4">
      {noneCanReserve ? (
        <Callout tone="info">
          You can view {members.map((m) => m.first).join(" and ")}&apos;s schedule, but reservations are managed by another guardian or the front desk.
        </Callout>
      ) : null}

      <section aria-labelledby="family-cal" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
          <Link href={hrefWith("/schedule", params, { date: range.prev })} className={navBtn} aria-label={`Previous ${view}`}>
            <span aria-hidden>‹</span>
          </Link>
          <h2 id="family-cal" className="min-w-0 flex-1 text-center text-base font-bold tracking-tight tabular sm:text-lg" aria-live="polite">
            {label}
            {view === "day" && range.anchor === today ? (
              <Badge variant="brand" className="ml-2 align-middle">
                Today
              </Badge>
            ) : null}
          </h2>
          <Link href={hrefWith("/schedule", params, { date: range.next })} className={navBtn} aria-label={`Next ${view}`}>
            <span aria-hidden>›</span>
          </Link>
        </div>

        {view === "day" ? (
          <nav aria-label="Days this week" className="grid grid-cols-7 border-b border-edge bg-th">
            {weekDays.map((d) => {
              const current = d === range.anchor;
              return (
                <Link
                  key={d}
                  href={dayHref(d)}
                  aria-current={current ? "date" : undefined}
                  aria-label={dayLabel(d, "EEEE, MMMM d")}
                  className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 border-b-[3px] text-xs", current ? "border-brand bg-surface" : "border-transparent hover:bg-surface-2")}
                >
                  <span className={cn("font-bold uppercase tracking-wide", current ? "text-brand" : "text-ink-2")}>{dayLabel(d, "EEE")}</span>
                  <span className={cn("inline-flex size-7 items-center justify-center rounded-full text-sm font-bold tabular", d === today ? "bg-brand text-brand-ink" : "text-ink")}>{Number(d.slice(8))}</span>
                </Link>
              );
            })}
          </nav>
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-b border-edge px-3 py-2.5">
          <form method="get" action="/schedule" className="flex items-end gap-2" aria-label="Jump to a date">
            <input type="hidden" name="view" value={view} />
            {params.program ? <input type="hidden" name="program" value={params.program} /> : null}
            {params.location ? <input type="hidden" name="location" value={params.location} /> : null}
            {params.instructor ? <input type="hidden" name="instructor" value={params.instructor} /> : null}
            <label className="text-xs font-semibold text-ink-2">
              <span className="mb-1 block">Go to date</span>
              <input type="date" name="date" defaultValue={range.anchor} required className="h-11 rounded-md border border-edge bg-surface px-2 text-sm text-ink" />
            </label>
            <button type="submit" className={buttonClass("secondary", "md", "h-11 lg:h-11")}>
              Go
            </button>
            <Link href={hrefWith("/schedule", params, { date: today })} className={buttonClass("secondary", "md", "h-11 lg:h-11")}>
              Today
            </Link>
          </form>
          <div role="group" aria-label="Calendar view" className="inline-flex overflow-hidden rounded-md border border-edge bg-surface">
            {(["day", "week", "month"] as const).map((v, i) => (
              <Link
                key={v}
                href={hrefWith("/schedule", params, { view: v })}
                aria-current={v === view ? "page" : undefined}
                className={cn("inline-flex h-11 items-center px-3.5 text-sm font-semibold capitalize", i > 0 && "border-l border-edge", v === view ? "bg-brand text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
              >
                {v}
              </Link>
            ))}
          </div>
        </div>

        <details className="border-b border-edge bg-th" open={filtered}>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-bold uppercase tracking-wide text-ink-2">
            Filters
            {filtered ? <Badge variant="brand">On</Badge> : <span className="font-medium normal-case tracking-normal text-ink-3">Program, location, instructor</span>}
          </summary>
          <form method="get" action="/schedule" className="grid gap-2 px-3 pb-3 sm:grid-cols-4" aria-label="Filter classes">
            <input type="hidden" name="view" value={view} />
            <input type="hidden" name="date" value={range.anchor} />
            <label className="min-w-0 text-xs font-semibold text-ink-2">
              <span className="mb-1 block">Program</span>
              <select name="program" defaultValue={programId ?? ""} className={selectCls}>
                <option value="">All programs</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {locs.length > 1 ? (
              <label className="min-w-0 text-xs font-semibold text-ink-2">
                <span className="mb-1 block">Location</span>
                <select name="location" defaultValue={locationId ?? ""} className={selectCls}>
                  <option value="">All locations</option>
                  {locs.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="min-w-0 text-xs font-semibold text-ink-2">
              <span className="mb-1 block">Instructor</span>
              <select name="instructor" defaultValue={instructorId ?? ""} className={selectCls}>
                <option value="">All instructors</option>
                {coaches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {coachShort(c.name)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button type="submit" className={buttonClass("secondary", "md", "h-11 flex-1 lg:h-11")}>
                Apply
              </button>
              {filtered ? (
                <Link href={hrefWith("/schedule", {}, { view, date: range.anchor })} className={buttonClass("ghost", "md", "h-11 lg:h-11")}>
                  Clear
                </Link>
              ) : null}
            </div>
          </form>
        </details>

        {rules.bookingWindowDays != null ? (
          <p className="border-b border-edge px-3 py-2 text-xs text-ink-2">
            Reservations open {rules.bookingWindowDays} days ahead
            {rules.familyBookingCutoffMinutes ? ` and close ${rules.familyBookingCutoffMinutes} minutes before the start` : ""}. Times are the facility&apos;s local time.
          </p>
        ) : null}

        {view === "month" ? (
          sessions.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No classes this month">{filtered ? "Try clearing the filters." : "Try another month, or contact the front desk."}</EmptyState>
            </div>
          ) : (
            <MonthView days={range.days} sessions={sessions} tz={tz} today={today} monthPrefix={range.monthPrefix!} dayHref={dayHref} sessionHref={classHref} />
          )
        ) : view === "day" ? (
          sessions.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No classes on this day">{filtered ? "Try clearing the filters, or pick another day." : "Pick another day above, or contact the front desk."}</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-edge" aria-label={`Classes on ${label}`}>
              {sessions.map((s) => (
                <li key={s.id}>{row(s)}</li>
              ))}
            </ul>
          )
        ) : sessions.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No classes this week">{filtered ? "Try clearing the filters." : "Try the next week, or contact the front desk."}</EmptyState>
          </div>
        ) : (
          <div>
            {range.days
              .filter((d) => (grouped.get(d) ?? []).length)
              .map((d) => (
                <section key={d} aria-labelledby={`day-${d}`}>
                  <h3 id={`day-${d}`} className={cn("flex items-center gap-2 border-y border-edge bg-th px-3 text-xs font-bold uppercase tracking-wide text-ink-2", d === today && "bg-brand/10")}>
                    <Link href={dayHref(d)} className="inline-flex min-h-10 items-center hover:text-ink hover:underline">
                      {dayLabel(d, "EEEE, MMM d")}
                    </Link>
                    {d === today ? <Badge variant="brand">Today</Badge> : null}
                  </h3>
                  <ul className="divide-y divide-edge">
                    {(grouped.get(d) ?? []).map((s) => (
                      <li key={s.id}>{row(s)}</li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </section>
      <SessionCheckinCard viewer={viewer} />
    </div>
  );
}
