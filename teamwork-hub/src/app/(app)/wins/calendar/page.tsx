import Link from "next/link";
import { db } from "@/db";
import { CompetitionLine, WinsStaffTabs } from "@/components/wins/staff";
import { Badge, Card, CardBody, Field, Select, buttonClass } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { communityOrg } from "@/lib/community/settings";
import { addDaysYmd, fmt, startOfWeekYmd, todayLocal } from "@/lib/time";
import { staffCalendar } from "@/lib/wins/calendar";
import { ModuleHero } from "../../training/_components/tb";

export const metadata = { title: "Competition calendar" };

type SP = { view?: string; start?: string; sport?: string; team?: string; group?: string; location?: string };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const noon = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const label = (ymd: string, pattern: string) => fmt(noon(ymd), pattern, "UTC");

export default async function CompetitionCalendarPage({ searchParams }: { searchParams: Promise<SP> }) {
  const v = await requireCap("wins.review");
  const sp = await searchParams;
  const org = await communityOrg(db, v.orgId);
  const today = todayLocal(org.tz);
  const view = sp.view === "month" ? "month" : "week";
  const anchor = sp.start && YMD.test(sp.start) && !Number.isNaN(noon(sp.start).getTime()) ? sp.start : today;
  let from: string;
  let to: string;
  let prev: string;
  let next: string;
  let title: string;
  if (view === "week") {
    from = startOfWeekYmd(anchor);
    to = addDaysYmd(from, 6);
    prev = addDaysYmd(from, -7);
    next = addDaysYmd(from, 7);
    title = `${label(from, "MMM d")} to ${label(to, "MMM d, yyyy")}`;
  } else {
    const first = `${anchor.slice(0, 7)}-01`;
    const nextFirst = `${addDaysYmd(first, 32).slice(0, 7)}-01`;
    from = startOfWeekYmd(first);
    to = addDaysYmd(startOfWeekYmd(addDaysYmd(nextFirst, -1)), 6);
    prev = `${addDaysYmd(first, -1).slice(0, 7)}-01`;
    next = nextFirst;
    title = label(first, "MMMM yyyy");
  }
  const filter = { sport: sp.sport || null, team: sp.team || null, groupId: sp.group || null, locationId: sp.location || null };
  const cal = await staffCalendar(db, v, { from, to }, filter, { today });
  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) days.push(d);
  const month = view === "month" ? anchor.slice(0, 7) : null;
  const tomorrow = addDaysYmd(today, 1);
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const all: Record<string, string | null | undefined> = { view, start: anchor, sport: sp.sport, team: sp.team, group: sp.group, location: sp.location, ...patch };
    for (const [k, val] of Object.entries(all)) if (val) p.set(k, val);
    return `/wins/calendar?${p.toString()}`;
  };
  const filtered = !!(filter.sport || filter.team || filter.groupId || filter.locationId);

  return (
    <div className="mx-auto max-w-7xl">
      <ModuleHero kicker="Wins" title="Competition calendar" description="Games, meets and tournaments from the seasons families enter under My Season, plus the team schedules staff keep. Coaches see their own athletes." />
      <WinsStaffTabs v={v} current="calendar" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs({ start: prev })} className={buttonClass("secondary", "md")}>
            Previous<span className="sr-only"> {view}</span>
          </Link>
          <Link href={qs({ start: today })} className={buttonClass("secondary", "md")}>
            Today
          </Link>
          <Link href={qs({ start: next })} className={buttonClass("secondary", "md")}>
            Next<span className="sr-only"> {view}</span>
          </Link>
          <h2 className="ml-1 text-lg font-bold">{title}</h2>
        </div>
        <nav aria-label="Calendar view" className="flex gap-2">
          {(["week", "month"] as const).map((k) => (
            <Link key={k} href={qs({ view: k })} aria-current={view === k ? "true" : undefined} className={buttonClass(view === k ? "primary" : "secondary", "md")}>
              {k === "week" ? "Week" : "Month"}
            </Link>
          ))}
        </nav>
      </div>

      <Card className="mb-4">
        <CardBody>
          <form method="get" action="/wins/calendar" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input type="hidden" name="view" value={view} />
            <input type="hidden" name="start" value={anchor} />
            <Field label="Sport" htmlFor="f-sport">
              <Select id="f-sport" name="sport" defaultValue={sp.sport ?? ""}>
                <option value="">All sports</option>
                {cal.sports.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team" htmlFor="f-team">
              <Select id="f-team" name="team" defaultValue={sp.team ?? ""}>
                <option value="">All teams</option>
                {cal.teams.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Training group" htmlFor="f-group">
              <Select id="f-group" name="group" defaultValue={sp.group ?? ""}>
                <option value="">All groups</option>
                {cal.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Trains at" htmlFor="f-location" hint="Booked or attended there in the last 90 days.">
              <Select id="f-location" name="location" defaultValue={sp.location ?? ""}>
                <option value="">All locations</option>
                {cal.locations.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <button type="submit" className={buttonClass("primary", "md")}>
                Apply filters
              </button>
              {filtered ? (
                <Link href={`/wins/calendar?view=${view}&start=${anchor}`} className={buttonClass("ghost", "md")}>
                  Clear
                </Link>
              ) : null}
            </div>
          </form>
        </CardBody>
      </Card>

      <p className="mb-2 text-sm text-ink-2" role="status">
        {cal.entries.length} competition day{cal.entries.length === 1 ? "" : "s"} in this {view}
        {filtered ? " with these filters" : ""}.
      </p>

      <ol className="grid gap-2 md:grid-cols-7" aria-label={`Competitions, ${title}`}>
        {days.map((d) => {
          const entries = cal.entries.filter((e) => e.date === d);
          const outside = month !== null && d.slice(0, 7) !== month;
          return (
            <li key={d} className={`min-w-0 rounded-md border p-2 ${d === today ? "border-brand bg-brand/5" : "border-edge bg-surface"} ${entries.length === 0 ? "hidden md:block" : ""} ${outside && d !== today ? "md:bg-surface-2" : ""} ${view === "week" ? "md:min-h-40" : "md:min-h-28"}`}>
              <h3 className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-ink-2">
                <span className="md:hidden">{label(d, "EEEE, MMM d")}</span>
                <span className="hidden md:inline">{label(d, view === "week" ? "EEE MMM d" : "EEE d")}</span>
                {d === today ? <Badge variant="green">Today</Badge> : d === tomorrow ? <Badge variant="yellow">Tomorrow</Badge> : null}
              </h3>
              {entries.length ? (
                <ul className="mt-1 divide-y divide-edge">
                  {entries.map((e) => (
                    <CompetitionLine key={`${e.athleteId}-${e.date}`} e={e} tz={org.tz} />
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-ink-3">None</p>
              )}
            </li>
          );
        })}
      </ol>
      {cal.entries.length === 0 ? <p className="mt-3 text-sm text-ink-3 md:hidden">Nothing on the calendar for this {view}.</p> : null}
    </div>
  );
}
