import { randomUUID } from "node:crypto";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cancellationPolicies, serviceTypes } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { Viewer } from "@/lib/authz/policy";
import { upcomingBookingsFor } from "@/lib/scheduling/booking";
import type { calendarRange } from "@/lib/scheduling/calendar-range";
import { bookingSettings } from "@/lib/scheduling/common";
import { resolveEntitlement } from "@/lib/scheduling/eligibility";
import { athleteBookingsIn, familyAthletes, listSessions, type SessionListItem } from "@/lib/scheduling/queries";
import { addDaysYmd, fmt, fmtDate, localToUtc } from "@/lib/time";
import { bookAction, cancelBookingAction, rescheduleAction } from "../actions";
import { capacityText, DaysView, MonthView, SessionCard } from "./calendar";
import { CalendarToolbar, hrefWith, type Params } from "./nav";

type Range = ReturnType<typeof calendarRange>;
const ANY_SERVICE = "00000000-0000-0000-0000-000000000000";

export async function FamilySchedule({ viewer, params, range, tz, today }: { viewer: Viewer; params: Params; range: Range; tz: string; today: string }) {
  const athletes = await familyAthletes(db, viewer);
  if (!athletes.length) {
    return (
      <EmptyState title="No athletes linked to your account yet">
        Ask the front desk to link your child (or your own athlete profile) to this login. Nothing can be booked until then.
      </EmptyState>
    );
  }
  const selected = athletes.find((a) => a.id === params.athlete) ?? athletes[0];
  const bookableCount = athletes.filter((a) => a.canBook && a.active).length;
  const now = new Date();
  const settings = await bookingSettings(db, viewer.orgId);
  const [sessions, ent, upcoming, policies] = await Promise.all([
    listSessions(db, viewer, { from: range.from, to: range.to, familyAthleteIds: athletes.map((a) => a.id) }),
    resolveEntitlement(db, { orgId: viewer.orgId, athleteId: selected.id, serviceType: { id: ANY_SERVICE, eligibility: {}, creditCost: 1 }, at: now }),
    upcomingBookingsFor(db, viewer.orgId, [selected.id], now),
    db
      .select({ serviceTypeId: serviceTypes.id, policy: cancellationPolicies })
      .from(serviceTypes)
      .leftJoin(cancellationPolicies, eq(cancellationPolicies.id, serviceTypes.cancellationPolicyId))
      .where(eq(serviceTypes.orgId, viewer.orgId)),
  ]);
  const policyBy = new Map(policies.map((p) => [p.serviceTypeId, p.policy]));
  const mine = await athleteBookingsIn(db, viewer.orgId, [selected.id], sessions.map((s) => s.id));
  const mineBy = new Map(mine.filter((b) => b.status === "booked" || b.status === "waitlisted" || b.status === "attended").map((b) => [b.sessionId, b]));
  const dayHref = (d: string) => hrefWith("/schedule", params, { view: "day", date: d, athlete: selected.id });
  const p = { ...params, athlete: selected.id };

  const cancelNote = (serviceTypeId: string) => {
    const pol = policyBy.get(serviceTypeId);
    if (!pol || pol.lateCancelPenalty === "none") return "Cancel this booking?";
    const hrs = Math.round((pol.lateCancelWindowMinutes / 60) * 10) / 10;
    return `Cancel this booking? Cancelling within ${hrs} hours of the start ${pol.lateCancelPenalty === "fee" ? "may incur a fee" : "uses the session credit"} under the current policy.`;
  };

  const render = (s: SessionListItem) => {
    const b = mineBy.get(s.id);
    const cap = capacityText(s);
    let action: React.ReactNode;
    if (b?.status === "booked" || b?.status === "attended") {
      action = (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="green">{b.status === "attended" ? "Attended" : `Booked: ${selected.first}`}</Badge>
          {b.status === "booked" && s.startsAt > now && selected.canBook ? (
            <ActionForm action={cancelBookingAction}>
              <input type="hidden" name="bookingId" value={b.id} />
              <SubmitButton variant="ghost" className="min-h-11" pendingText="Cancelling…" confirm={cancelNote(s.serviceTypeId)}>
                Cancel
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      );
    } else if (b?.status === "waitlisted") {
      action = (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="yellow">Waitlist #{b.waitlistPosition}</Badge>
          {selected.canBook ? (
            <ActionForm action={cancelBookingAction}>
              <input type="hidden" name="bookingId" value={b.id} />
              <SubmitButton variant="ghost" className="min-h-11" pendingText="Leaving…">
                Leave waitlist
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      );
    } else if (s.status === "cancelled") {
      action = null;
    } else if (!selected.canBook) {
      action = <p className="mt-2 text-xs text-ink-3">Booking for {selected.first} isn&apos;t enabled on your account.</p>;
    } else {
      const cutoffAt = s.startsAt.getTime() - (settings.familyBookingCutoffMinutes ?? 0) * 60_000;
      const opensAt = settings.bookingWindowDays != null ? s.startsAt.getTime() - settings.bookingWindowDays * 86_400_000 : null;
      const waitOpen = s.waitlisted < s.waitlistCapacity;
      if (now >= s.endsAt) action = <p className="mt-2 text-xs text-ink-3">Ended.</p>;
      else if (now.getTime() > cutoffAt) action = <p className="mt-2 text-xs text-ink-3">Online booking closed{now < s.startsAt ? " — call the front desk" : ""}.</p>;
      else if (opensAt && now.getTime() < opensAt) action = <p className="mt-2 text-xs text-ink-3">Booking opens {fmt(new Date(opensAt), "MMM d", tz)}.</p>;
      else if (cap.full && !waitOpen) action = <p className="mt-2 text-xs font-medium text-ink-3">Full</p>;
      else
        action = (
          <ActionForm action={bookAction} className="mt-2">
            <input type="hidden" name="sessionId" value={s.id} />
            <input type="hidden" name="athleteId" value={selected.id} />
            <input type="hidden" name="idem" value={randomUUID()} />
            <SubmitButton variant={cap.full ? "secondary" : "primary"} className="min-h-11 w-full sm:w-auto" pendingText="Booking…">
              {cap.full ? `Join waitlist for ${selected.first}` : `Book ${selected.first}`}
            </SubmitButton>
            {s.creditCost > 0 ? <p className="mt-1 text-xs text-ink-3">Uses {s.creditCost} credit{s.creditCost === 1 ? "" : "s"} unless covered by an unlimited membership.</p> : null}
            {bookableCount > 1 || s.seriesId ? (
              <Link href={`/schedule/family-book?session=${s.id}&athlete=${selected.id}`} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
                {bookableCount > 1 ? "Book several athletes" : "Book several weeks"}
                {bookableCount > 1 && s.seriesId ? " or weeks" : ""} →
              </Link>
            ) : null}
          </ActionForm>
        );
    }
    return (
      <SessionCard s={s} tz={tz}>
        {action}
      </SessionCard>
    );
  };

  return (
    <div className="space-y-6">
      {athletes.length > 1 ? (
        <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
          {athletes.map((a) => (
            <Link
              key={a.id}
              href={hrefWith("/schedule", params, { athlete: a.id })}
              aria-current={a.id === selected.id ? "true" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium",
                a.id === selected.id ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface hover:bg-surface-2",
              )}
            >
              {a.first} {a.last}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader kicker="Booking for" title={`${selected.first} ${selected.last}`} />
          <CardBody className="space-y-2 text-sm">
            {ent.kind === "unlimited" ? (
              <p>
                <Badge variant="green">Unlimited membership</Badge>
              </p>
            ) : null}
            <p>
              <span className="text-2xl font-bold tabular">{selected.credits}</span> session credit{selected.credits === 1 ? "" : "s"} available
            </p>
            {ent.kind !== "unlimited" && selected.credits === 0 ? (
              <Callout tone="warn">No membership or credits yet. Buy a package or membership (or ask the front desk) before booking.</Callout>
            ) : null}
            {!selected.canBook ? <Callout tone="info">You can view {selected.first}&apos;s schedule, but booking is managed by another guardian or the front desk.</Callout> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <ButtonLink href={`/schedule/athletes/${selected.id}`} variant="outline" className="min-h-11">
                Attendance history
              </ButtonLink>
              {selected.canBook ? (
                <ButtonLink href={`/schedule/book?athlete=${selected.id}`} variant="outline" className="min-h-11">
                  Book an assessment
                </ButtonLink>
              ) : null}
              {selected.canBook ? (
                <ButtonLink href={`/schedule/athletes/${selected.id}#checkin-pin`} variant="outline" className="min-h-11">
                  Check-in PIN
                </ButtonLink>
              ) : null}
            </div>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader kicker="Upcoming" title="Upcoming bookings" />
          <CardBody>
            {upcoming.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing booked yet for {selected.first}.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {await Promise.all(
                  upcoming.slice(0, 10).map(async ({ booking, session }) => {
                    const alternatives =
                      booking.status === "booked" && selected.canBook
                        ? (
                            await listSessions(db, viewer, {
                              from: localToUtc(today, "00:00", tz),
                              to: localToUtc(addDaysYmd(today, (settings.bookingWindowDays ?? 21) + 1), "00:00", tz),
                              filters: { serviceTypeId: session.serviceTypeId },
                            })
                          ).filter(
                            (x) =>
                              x.id !== session.id &&
                              x.visibility !== "private" &&
                              x.booked < x.capacity &&
                              x.startsAt.getTime() - (settings.familyBookingCutoffMinutes ?? 0) * 60_000 > now.getTime(),
                          )
                        : [];
                    return (
                      <li key={booking.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <div className="min-w-0">
                          <div className="font-medium">{session.title}</div>
                          <div className="text-xs text-ink-3">{fmt(session.startsAt, "EEE MMM d, h:mm a", tz)}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {booking.status === "waitlisted" ? <Badge variant="yellow">Waitlist #{booking.waitlistPosition}</Badge> : <Badge variant="green">Booked</Badge>}
                          {selected.canBook && session.startsAt > now ? (
                            <ActionForm action={cancelBookingAction}>
                              <input type="hidden" name="bookingId" value={booking.id} />
                              <SubmitButton variant="ghost" className="min-h-11" pendingText="Cancelling…" confirm={cancelNote(session.serviceTypeId)}>
                                {booking.status === "waitlisted" ? "Leave waitlist" : "Cancel"}
                              </SubmitButton>
                            </ActionForm>
                          ) : null}
                          {alternatives.length ? (
                            <details className="w-full sm:w-auto">
                              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-brand">Reschedule</summary>
                              <ActionForm action={rescheduleAction} className="mt-2 flex flex-wrap items-end gap-2">
                                <input type="hidden" name="bookingId" value={booking.id} />
                                <input type="hidden" name="idem" value={randomUUID()} />
                                <label className="text-sm">
                                  <span className="mb-1 block text-xs text-ink-3">Move to</span>
                                  <select name="toSessionId" required className="h-11 max-w-full rounded-lg border border-edge bg-surface px-2 text-sm">
                                    {alternatives.slice(0, 20).map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {fmt(x.startsAt, "EEE MMM d h:mm a", tz)} — {x.title}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <SubmitButton className="min-h-11" pendingText="Moving…" confirm={cancelNote(session.serviceTypeId)}>
                                  Move booking
                                </SubmitButton>
                              </ActionForm>
                            </details>
                          ) : null}
                        </div>
                      </li>
                    );
                  }),
                )}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <section aria-labelledby="family-cal">
        <h2 id="family-cal" className="sr-only">
          Sessions
        </h2>
        <CalendarToolbar params={p} view={range.view} label={range.label} prev={range.prev} next={range.next} today={today} />
        {settings.bookingWindowDays != null ? (
          <p className="mb-3 text-xs text-ink-3">
            Online booking opens {settings.bookingWindowDays} days ahead
            {settings.familyBookingCutoffMinutes ? ` and closes ${settings.familyBookingCutoffMinutes} minutes before start` : ""}. Today is {fmtDate(today)}.
          </p>
        ) : null}
        {sessions.length === 0 ? (
          <EmptyState title="No bookable sessions in this range">Try the next week, or contact the front desk.</EmptyState>
        ) : range.view === "month" ? (
          <MonthView days={range.days} sessions={sessions} tz={tz} today={today} monthPrefix={range.monthPrefix!} dayHref={dayHref} />
        ) : (
          <DaysView days={range.days} sessions={sessions} tz={tz} today={today} dayHref={dayHref} render={render} />
        )}
      </section>
    </div>
  );
}
