import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, EmptyState, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { upcomingBookingsFor } from "@/lib/scheduling/booking";
import { bookingSettings } from "@/lib/scheduling/common";
import { resolveEntitlement } from "@/lib/scheduling/eligibility";
import { familyAthletes, listSessions } from "@/lib/scheduling/queries";
import { addDaysYmd, fmt, localToUtc, todayLocal } from "@/lib/time";
import { cancelBookingAction, rescheduleAction } from "../actions";
import { ScheduleTabs } from "../_components/calendar";
import { cancelConfirm, lateCancelRule, policiesByService } from "../_components/reserve-control";

export const metadata = { title: "My Reservations" };

const ANY_SERVICE = "00000000-0000-0000-0000-000000000000";
const MAX = 30;

/** Upcoming reservations for everyone in the family, each with Cancel reservation and (when another time is open) Reschedule. */
export default async function ReservationsPage() {
  const v = await requireViewer();
  if (isStaff(v)) redirect("/schedule");
  const members = await familyAthletes(db, v);
  const now = new Date();
  const rules = await bookingSettings(db, v.orgId);
  const tz = rules.timezone;
  const today = todayLocal(tz);
  const [upcoming, policies, ents] = await Promise.all([
    upcomingBookingsFor(db, v.orgId, members.map((m) => m.id), now),
    policiesByService(v.orgId),
    Promise.all(members.map((m) => resolveEntitlement(db, { orgId: v.orgId, athleteId: m.id, serviceType: { id: ANY_SERVICE, eligibility: {}, creditCost: 1 }, at: now }))),
  ]);
  const byId = new Map(members.map((m) => [m.id, m]));
  const several = members.length > 1;
  const shown = upcoming.slice(0, MAX);
  // Other open times of the same program, for Reschedule (one lookup per program, not per reservation).
  const altByService = new Map<string, Awaited<ReturnType<typeof listSessions>>>();
  for (const { booking, session } of shown) {
    if (booking.status !== "booked" || !byId.get(booking.athleteId)?.canBook || altByService.has(session.serviceTypeId)) continue;
    const list = await listSessions(db, v, {
      from: localToUtc(today, "00:00", tz),
      to: localToUtc(addDaysYmd(today, (rules.bookingWindowDays ?? 21) + 1), "00:00", tz),
      filters: { serviceTypeId: session.serviceTypeId },
    });
    altByService.set(
      session.serviceTypeId,
      list.filter((x) => x.visibility !== "private" && x.booked < x.capacity && x.startsAt.getTime() - (rules.familyBookingCutoffMinutes ?? 0) * 60_000 > now.getTime()),
    );
  }

  return (
    <>
      <PageHeader kicker="Schedule" title="My Reservations" description="Upcoming reservations and waitlist spots for your family." actions={<ButtonLink href="/schedule" className="min-h-11">Reserve a class</ButtonLink>} />
      <ScheduleTabs current="reservations" staff={false} manager={false} />

      {members.length === 0 ? (
        <EmptyState title="No family members linked to your account yet">Ask the front desk to link your child (or your own athlete profile) to this login.</EmptyState>
      ) : (
        <div className="space-y-5">
          <section aria-labelledby="upcoming-h" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
            <h2 id="upcoming-h" className="border-b border-edge bg-th px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-ink-2">
              Upcoming reservations <span className="tabular text-ink-3">({upcoming.length})</span>
            </h2>
            {shown.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No upcoming reservations" action={<ButtonLink href="/schedule" variant="secondary" className="min-h-11">Open the calendar</ButtonLink>}>
                  Reserve a class from the calendar and it will show up here.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-edge">
                {shown.map(({ booking, session }) => {
                  const m = byId.get(booking.athleteId);
                  const policy = policies.get(session.serviceTypeId);
                  const rule = lateCancelRule(policy);
                  const waitlisted = booking.status === "waitlisted";
                  const canChange = !!m?.canBook && session.startsAt > now;
                  const alternatives = waitlisted ? [] : (altByService.get(session.serviceTypeId) ?? []).filter((x) => x.id !== session.id);
                  const label = `${session.title}, ${fmt(session.startsAt, "EEE MMM d h:mm a", tz)}`;
                  return (
                    <li key={booking.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3">
                        <div className="w-[4.75rem] shrink-0 text-xs tabular">
                          <div className="font-bold text-ink">{fmt(session.startsAt, "EEE MMM d", tz)}</div>
                          <div className="text-ink-3">{fmt(session.startsAt, "h:mm a", tz)}</div>
                        </div>
                        <div className="min-w-0 text-sm">
                          <Link href={`/schedule/classes/${session.id}`} className="font-semibold hover:underline">
                            {session.title}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                            {m && several ? (
                              <span className="font-medium">
                                {m.first} {m.last}
                              </span>
                            ) : null}
                            {waitlisted ? <Badge variant="yellow">Waitlist #{booking.waitlistPosition}</Badge> : <Badge variant="green">Reserved</Badge>}
                          </div>
                          {canChange && !waitlisted && rule ? <p className="mt-1 text-xs text-ink-3">{rule}</p> : null}
                        </div>
                      </div>
                      {canChange ? (
                        <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                          <ActionForm action={cancelBookingAction}>
                            <input type="hidden" name="bookingId" value={booking.id} />
                            <SubmitButton variant="outline" className="min-h-11" pendingText={waitlisted ? "Leaving…" : "Cancelling…"} confirm={waitlisted ? undefined : cancelConfirm(policy)}>
                              {waitlisted ? "Leave waitlist" : "Cancel reservation"}
                              <span className="sr-only">
                                {" "}
                                {m ? `for ${m.first}: ` : ""}
                                {label}
                              </span>
                            </SubmitButton>
                          </ActionForm>
                          {alternatives.length ? (
                            <details className="w-full sm:w-auto">
                              <summary className="inline-flex min-h-11 cursor-pointer items-center px-1 text-sm font-medium text-brand">
                                Reschedule<span className="sr-only">: {label}</span>
                              </summary>
                              <ActionForm action={rescheduleAction} className="mt-2 flex flex-wrap items-end gap-2">
                                <input type="hidden" name="bookingId" value={booking.id} />
                                <input type="hidden" name="idem" value={randomUUID()} />
                                <label className="min-w-0 text-sm">
                                  <span className="mb-1 block text-xs text-ink-3">Move to</span>
                                  <select name="toSessionId" required className="h-11 max-w-full rounded-lg border border-edge bg-surface px-2 text-sm">
                                    {alternatives.slice(0, 20).map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {fmt(x.startsAt, "EEE MMM d h:mm a", tz)}, {x.title}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <SubmitButton className="min-h-11" pendingText="Moving…" confirm={cancelConfirm(policy).replace("Cancel this reservation?", "Move this reservation?")}>
                                  Move reservation
                                </SubmitButton>
                              </ActionForm>
                            </details>
                          ) : null}
                        </div>
                      ) : !m?.canBook ? (
                        <p className="text-xs text-ink-3 sm:max-w-56 sm:text-right">Changes are managed by another guardian or the front desk.</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {upcoming.length > MAX ? <p className="border-t border-edge px-3 py-2 text-xs text-ink-3">Showing the next {MAX} of {upcoming.length}.</p> : null}
          </section>

          <section aria-labelledby="family-h">
            <h2 id="family-h" className="mb-2 text-sm font-semibold">
              Family members
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {members.map((m, i) => {
                const ent = ents[i];
                return (
                  <li key={m.id} className="rounded-md border border-edge bg-surface p-3 text-sm shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">
                        {m.first} {m.last}
                      </span>
                      {ent.kind === "unlimited" ? <Badge variant="green">Unlimited membership</Badge> : null}
                      {ent.kind === "weekly" ? <Badge variant="green">{ent.classesPerWeek}x per week membership</Badge> : null}
                    </div>
                    <p className="mt-1 text-ink-2">
                      <span className="text-lg font-bold tabular text-ink">{m.credits}</span> session credit{m.credits === 1 ? "" : "s"} available
                    </p>
                    {ent.kind !== "unlimited" && ent.kind !== "weekly" && m.credits === 0 ? (
                      <Callout tone="warn" className="mt-2">
                        No membership or credits yet. Buy a package or membership (or ask the front desk) before reserving.
                      </Callout>
                    ) : null}
                    {!m.canBook ? (
                      <Callout tone="info" className="mt-2">
                        You can view {m.first}&apos;s schedule, but reservations are managed by another guardian or the front desk.
                      </Callout>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <ButtonLink href={`/schedule/attendance?athlete=${m.id}`} variant="outline" className="min-h-11">
                        Attendance<span className="sr-only"> for {m.first}</span>
                      </ButtonLink>
                      {m.canBook ? (
                        <ButtonLink href={`/schedule/athletes/${m.id}#checkin-pin`} variant="outline" className="min-h-11">
                          Check-in PIN<span className="sr-only"> for {m.first}</span>
                        </ButtonLink>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
