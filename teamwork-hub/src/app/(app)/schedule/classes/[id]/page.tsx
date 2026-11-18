import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduleSessions, serviceTypes } from "@/db/schema";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { bookingSettings } from "@/lib/scheduling/common";
import { athleteBookingsIn, familyAthletes, listSessions } from "@/lib/scheduling/queries";
import { fmt, fmtTime, localYmd } from "@/lib/time";
import { ScheduleTabs } from "../../_components/calendar";
import { lateCancelRule, liveBySession, policiesByService, ReserveControl, spotsText } from "../../_components/reserve-control";
import { coachShort } from "../../_components/time-grid";

export const metadata = { title: "Class" };

/** Family class detail: what, when, who is going from this family, and the same one action as the day list. */
export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (isStaff(v)) redirect(`/schedule/sessions/${id}`);
  const [base] = await db
    .select({ startsAt: scheduleSessions.startsAt, description: serviceTypes.description })
    .from(scheduleSessions)
    .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
    .where(and(eq(scheduleSessions.id, id), eq(scheduleSessions.orgId, v.orgId)));
  if (!base) notFound();
  const members = await familyAthletes(db, v);
  const memberIds = members.map((m) => m.id);
  // Same visibility rule as the calendar: open classes, plus anything this family is already in.
  const s = (await listSessions(db, v, { from: base.startsAt, to: new Date(base.startsAt.getTime() + 1), familyAthleteIds: memberIds })).find((x) => x.id === id);
  if (!s) notFound();
  const [rules, policies, bookingRows] = await Promise.all([bookingSettings(db, v.orgId), policiesByService(v.orgId), athleteBookingsIn(db, v.orgId, memberIds, [s.id])]);
  const tz = rules.timezone;
  const bookings = liveBySession(bookingRows).get(s.id);
  const policy = policies.get(s.serviceTypeId);
  const rule = lateCancelRule(policy);
  const minutes = Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / 60_000);
  const cancelled = s.status === "cancelled";
  const going = members.filter((m) => bookings?.has(m.id));
  return (
    <>
      <PageHeader
        kicker={`${s.serviceName} · ${fmt(s.startsAt, "EEEE, MMM d", tz)}`}
        title={s.title}
        actions={
          <ButtonLink href={`/schedule?view=day&date=${localYmd(s.startsAt, tz)}`} variant="outline" className="min-h-11">
            ← Calendar
          </ButtonLink>
        }
      />
      <ScheduleTabs current="calendar" staff={false} manager={false} />
      {cancelled ? (
        <Callout tone="bad" className="mb-4">
          This class was cancelled.
        </Callout>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="Class details" />
          <CardBody className="space-y-4">
            <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2 text-sm">
              <dt className="text-ink-3">When</dt>
              <dd className="font-medium">
                {fmt(s.startsAt, "EEEE, MMMM d, yyyy", tz)}
                <br />
                {fmtTime(s.startsAt, tz)} to {fmtTime(s.endsAt, tz)} ({minutes} min)
              </dd>
              <dt className="text-ink-3">Instructor</dt>
              <dd>
                {coachShort(s.coachName)}
                {s.originalCoachUserId && s.originalCoachUserId !== s.coachUserId ? " (substitute)" : ""}
              </dd>
              <dt className="text-ink-3">Location</dt>
              <dd>{[s.locationName, s.resourceName].filter(Boolean).join(" · ") || "At the facility"}</dd>
              <dt className="text-ink-3">Program</dt>
              <dd>{s.serviceName}</dd>
              {!cancelled ? (
                <>
                  <dt className="text-ink-3">Spots</dt>
                  <dd className="tabular">{spotsText(s)}</dd>
                </>
              ) : null}
            </dl>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Description</h3>
              <p className="text-sm whitespace-pre-line text-ink-2">{base.description?.trim() || "No description has been added for this class yet."}</p>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={going.length ? "Your reservation" : "Reserve"} />
          <CardBody className="space-y-4">
            <div>
              <h3 className="mb-1.5 text-sm font-semibold">Attending from your family</h3>
              {going.length === 0 ? (
                <p className="text-sm text-ink-3">No one from your family is reserved in this class.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {going.map((m) => {
                    const b = bookings!.get(m.id)!;
                    return (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {m.first} {m.last}
                        </span>
                        {b.status === "waitlisted" ? <Badge variant="yellow">Waitlist #{b.waitlistPosition}</Badge> : <Badge variant="green">{b.status === "attended" ? "Attended" : "Reserved"}</Badge>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <ReserveControl s={s} members={members} bookings={bookings} rules={rules} policy={policy} now={new Date()} tz={tz} align="start" />
            {!cancelled ? (
              <p className="border-t border-edge pt-3 text-xs text-ink-3">
                <span className="font-semibold text-ink-2">Cancellation policy.</span> {rule ?? "You can cancel a reservation any time before the class starts."}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
