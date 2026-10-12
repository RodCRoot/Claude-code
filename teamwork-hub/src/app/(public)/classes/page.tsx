import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { scheduleSessions, serviceTypes } from "@/db/schema";
import { getPublicSite } from "@/lib/public-site";
import { addDaysYmd, fmt, localDayBounds, todayLocal } from "@/lib/time";
import { ButtonLink, EmptyState } from "@/components/ui";

export const metadata = { title: "Schedule" };
export const dynamic = "force-dynamic";

/** Public schedule: only sessions marked public. Shows no attendee information — just open spots. */
export default async function PublicClasses() {
  const { orgId, timezone } = await getPublicSite();
  const today = todayLocal(timezone);
  const { start } = localDayBounds(today, timezone);
  const { start: end } = localDayBounds(addDaysYmd(today, 14), timezone);
  const rows = orgId
    ? await db
        .select({
          id: scheduleSessions.id,
          title: scheduleSessions.title,
          startsAt: scheduleSessions.startsAt,
          endsAt: scheduleSessions.endsAt,
          capacity: scheduleSessions.capacity,
          kind: serviceTypes.kind,
          booked: sql<number>`(select count(*)::int from bookings b where b.session_id = ${scheduleSessions.id} and b.status in ('booked','attended'))`,
        })
        .from(scheduleSessions)
        .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
        .where(and(eq(scheduleSessions.orgId, orgId), eq(scheduleSessions.visibility, "public"), eq(scheduleSessions.status, "scheduled"), gte(scheduleSessions.startsAt, start), lt(scheduleSessions.startsAt, end)))
        .orderBy(asc(scheduleSessions.startsAt))
    : [];
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = fmt(r.startsAt, "EEEE, MMM d", timezone);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-3xl font-bold">Public schedule</h1>
      <p className="mt-2 text-ink-2">Open sessions for the next two weeks (times in Bloomington, Indiana time). Members book inside the Hub; new athletes start with an assessment.</p>
      {rows.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No public sessions posted right now" action={<ButtonLink href="/inquire">Request an assessment</ButtonLink>}>
            Our coaches post assessment times and open sessions here.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {[...byDay.entries()].map(([day, list]) => (
            <section key={day}>
              <h2 className="kicker mb-2">{day}</h2>
              <ul className="divide-y divide-edge rounded-xl border border-edge bg-surface">
                {list.map((s) => {
                  const open = Math.max(0, s.capacity - s.booked);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <div className="font-medium">{s.title}</div>
                        <div className="text-sm text-ink-3">
                          {fmt(s.startsAt, "h:mm a", timezone)}–{fmt(s.endsAt, "h:mm a", timezone)}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-sm ${open ? "text-ok" : "text-ink-3"}`}>{open ? `${open} spot${open === 1 ? "" : "s"} open` : "Full"}</span>
                        {s.kind === "assessment" && open ? <ButtonLink href={`/inquire?session=${s.id}`} size="sm">Request this time</ButtonLink> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
