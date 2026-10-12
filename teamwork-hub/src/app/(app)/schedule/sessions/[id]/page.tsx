import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Stat, StatusBadge, Textarea } from "@/components/ui";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listCoaches } from "@/lib/scheduling/availability";
import { canRunSession } from "@/lib/scheduling/common";
import { searchBookableAthletes, sessionDetail } from "@/lib/scheduling/queries";
import { fmt, fmtTime, localYmd } from "@/lib/time";
import {
  attendanceAction,
  bookAction,
  cancelBookingAction,
  cancelSessionAction,
  promoteWaitlistAction,
  restoreCreditAction,
  substituteCoachAction,
  updateSessionAction,
} from "../../actions";

export const metadata = { title: "Session" };

const PENALTY: Record<string, string> = { none: "no penalty", forfeit_credit: "credit is used", fee: "fee" };

export default async function SessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  const v = await requireStaff();
  const { id } = await params;
  const { q } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await sessionDetail(db, v, id);
  if (!d) notFound();
  const { session: s, service, policy } = d;
  const tz = s.timezone;
  const runner = canRunSession(v, s);
  const manager = can(v, "schedule.manage");
  const now = new Date();
  const started = now >= s.startsAt;
  const cancelled = s.status === "cancelled";
  const active = d.roster.filter((r) => r.booking.status !== "waitlisted" && r.booking.status !== "cancelled" && r.booking.status !== "late_cancelled");
  const waitlist = d.roster.filter((r) => r.booking.status === "waitlisted");
  const gone = d.roster.filter((r) => r.booking.status === "cancelled" || r.booking.status === "late_cancelled");
  const count = (st: string) => d.roster.filter((r) => r.booking.status === st).length;
  const occupying = count("booked") + count("attended") + count("no_show");
  const results = runner && q ? await searchBookableAthletes(db, v, q) : [];
  const coaches = manager ? await listCoaches(db, v.orgId) : [];
  const rosterIds = new Set(d.roster.filter((r) => ["booked", "waitlisted", "attended", "no_show"].includes(r.booking.status)).map((r) => r.booking.athleteId));

  return (
    <>
      <PageHeader
        kicker={`${service.name} · ${fmt(s.startsAt, "EEEE, MMM d", tz)}`}
        title={
          <span className={cancelled ? "line-through opacity-70" : undefined}>
            {s.title}
          </span>
        }
        description={
          <>
            {fmtTime(s.startsAt, tz)} – {fmtTime(s.endsAt, tz)} · {d.coachName ?? "No coach"}
            {d.originalCoachName && s.originalCoachUserId !== s.coachUserId ? ` (substituting for ${d.originalCoachName})` : ""}
            {d.resourceName ? ` · ${d.resourceName}` : ""}
          </>
        }
        actions={
          <ButtonLink href={`/schedule?view=day&date=${localYmd(s.startsAt, tz)}`} variant="outline" className="min-h-11">
            ← Back to day
          </ButtonLink>
        }
      />
      {cancelled ? (
        <Callout tone="bad" title="This session was cancelled" className="mb-4">
          {s.cancelReason ?? "No reason recorded."} All bookings were released.
        </Callout>
      ) : null}
      {!runner ? (
        <Callout tone="info" className="mb-4">
          View only — this is another coach&apos;s session. Ask operations to make changes.
        </Callout>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Booked" value={`${occupying}/${s.capacity}`} hint={occupying >= s.capacity ? "Full" : `${s.capacity - occupying} open`} />
        <Stat label="Waitlist" value={`${waitlist.length}/${s.waitlistCapacity}`} />
        <Stat label="Checked in" value={count("attended")} tone={count("attended") ? "ok" : undefined} />
        <Stat label="No-shows" value={count("no_show")} tone={count("no_show") ? "bad" : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Roster" kicker="Attendance" />
            <CardBody>
              {active.length === 0 ? (
                <EmptyState title="No one is booked yet">{runner && !cancelled ? "Use “Add athlete” to book someone in." : null}</EmptyState>
              ) : (
                <ul className="divide-y divide-edge" aria-label="Roster">
                  {active.map((r) => {
                    const b = r.booking;
                    const restorable = manager && (r.ledger.includes("consume") || r.ledger.includes("forfeit")) && !r.ledger.includes("restore");
                    return (
                      <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                        <div className="min-w-0">
                          <Link href={`/schedule/athletes/${b.athleteId}`} className="inline-flex min-h-11 items-center font-medium hover:underline">
                            {r.first} {r.last}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                            <StatusBadge status={b.status} />
                            {b.entitlementSource ? <Badge>{b.entitlementSource}</Badge> : null}
                            {b.checkedInAt ? <span>in {fmtTime(b.checkedInAt, tz)}{b.checkInMethod ? ` (${b.checkInMethod})` : ""}</span> : null}
                            {r.ledger.includes("restore") ? <Badge variant="blue">credit restored</Badge> : null}
                          </div>
                        </div>
                        {runner && !cancelled ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {b.status !== "attended" ? (
                              <ActionForm action={attendanceAction}>
                                <input type="hidden" name="bookingId" value={b.id} />
                                <input type="hidden" name="outcome" value="attended" />
                                <SubmitButton className="min-h-11" pendingText="…">
                                  Check in
                                </SubmitButton>
                              </ActionForm>
                            ) : null}
                            {b.status !== "no_show" && started ? (
                              <ActionForm action={attendanceAction}>
                                <input type="hidden" name="bookingId" value={b.id} />
                                <input type="hidden" name="outcome" value="no_show" />
                                <SubmitButton variant="outline" className="min-h-11" pendingText="…">
                                  No-show
                                </SubmitButton>
                              </ActionForm>
                            ) : null}
                            {b.status === "booked" ? (
                              <details className="relative">
                                <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-surface-2">Cancel…</summary>
                                <div className="mt-2 w-72 max-w-[calc(100vw-3rem)] space-y-2 rounded-lg border border-edge bg-surface p-3 shadow-lg sm:absolute sm:right-0 sm:z-10">
                                  <ActionForm action={cancelBookingAction}>
                                    <input type="hidden" name="bookingId" value={b.id} />
                                    <input type="hidden" name="mode" value="auto" />
                                    <SubmitButton variant="secondary" className="min-h-11 w-full" pendingText="…">
                                      Cancel (apply policy)
                                    </SubmitButton>
                                  </ActionForm>
                                  <ActionForm action={cancelBookingAction}>
                                    <input type="hidden" name="bookingId" value={b.id} />
                                    <input type="hidden" name="mode" value="late" />
                                    <SubmitButton variant="outline" className="min-h-11 w-full" pendingText="…">
                                      Record late cancel
                                    </SubmitButton>
                                  </ActionForm>
                                  <ActionForm action={cancelBookingAction} className="space-y-2">
                                    <input type="hidden" name="bookingId" value={b.id} />
                                    <input type="hidden" name="mode" value="waive" />
                                    <Field label="Reason to waive policy" htmlFor={`waive-${b.id}`}>
                                      <Input id={`waive-${b.id}`} name="reason" required className="h-11" />
                                    </Field>
                                    <SubmitButton variant="outline" className="min-h-11 w-full" pendingText="…">
                                      Cancel without penalty
                                    </SubmitButton>
                                  </ActionForm>
                                </div>
                              </details>
                            ) : null}
                            {restorable ? (
                              <details>
                                <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-surface-2">Restore credit…</summary>
                                <ActionForm action={restoreCreditAction} className="mt-2 space-y-2">
                                  <input type="hidden" name="bookingId" value={b.id} />
                                  <Field label="Reason" htmlFor={`restore-${b.id}`}>
                                    <Input id={`restore-${b.id}`} name="reason" required className="h-11" />
                                  </Field>
                                  <SubmitButton variant="outline" className="min-h-11" pendingText="…">
                                    Restore credit
                                  </SubmitButton>
                                </ActionForm>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Waitlist"
              kicker={`${waitlist.length} waiting`}
              action={
                runner && !cancelled && waitlist.length && occupying < s.capacity ? (
                  <ActionForm action={promoteWaitlistAction}>
                    <input type="hidden" name="sessionId" value={s.id} />
                    <SubmitButton variant="secondary" className="min-h-11" pendingText="Promoting…">
                      Fill open spots
                    </SubmitButton>
                  </ActionForm>
                ) : null
              }
            />
            <CardBody>
              {waitlist.length === 0 ? (
                <p className="text-sm text-ink-3">No one is waiting. When the session is full, new bookings join the waitlist automatically (up to {s.waitlistCapacity}).</p>
              ) : (
                <ol className="divide-y divide-edge">
                  {waitlist.map((r) => (
                    <li key={r.booking.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <span>
                        <span className="mr-2 font-semibold tabular">#{r.booking.waitlistPosition}</span>
                        {r.first} {r.last}
                      </span>
                      {runner && !cancelled ? (
                        <ActionForm action={cancelBookingAction}>
                          <input type="hidden" name="bookingId" value={r.booking.id} />
                          <SubmitButton variant="ghost" className="min-h-11" pendingText="…">
                            Remove
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-2 text-xs text-ink-3">When a spot opens the next eligible athlete is promoted automatically and their credit reserved; anyone who can&apos;t be charged is skipped (see the audit log).</p>
            </CardBody>
          </Card>

          {gone.length ? (
            <Card>
              <CardHeader title="Cancelled bookings" />
              <CardBody>
                <ul className="divide-y divide-edge text-sm">
                  {gone.map((r) => (
                    <li key={r.booking.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {r.first} {r.last}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        <StatusBadge status={r.booking.status} />
                        {r.booking.cancelledAt ? fmt(r.booking.cancelledAt, "MMM d h:mm a", tz) : null}
                        {r.ledger.includes("forfeit") ? <Badge variant="red">credit used</Badge> : r.ledger.includes("release") ? <Badge>credit returned</Badge> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          {runner && !cancelled ? (
            <Card>
              <CardHeader title="Add athlete" kicker="Staff booking" />
              <CardBody>
                <form method="get" className="flex gap-2" role="search">
                  <label htmlFor="q" className="sr-only">
                    Search athletes
                  </label>
                  <Input id="q" name="q" defaultValue={q ?? ""} placeholder="Search by name" className="h-11" />
                  <button type="submit" className="h-11 rounded-lg border border-edge px-3 text-sm font-medium">
                    Search
                  </button>
                </form>
                {q ? (
                  results.length === 0 ? (
                    <p className="mt-3 text-sm text-ink-3">No athletes match “{q}”{v.role === "coach" ? " among your assigned athletes" : ""}.</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-edge">
                      {results.map((a) => (
                        <li key={a.id} className="py-2.5">
                          <div className="mb-1 font-medium">
                            {a.first} {a.last} {a.sport ? <span className="text-xs font-normal text-ink-3">· {a.sport}</span> : null}
                          </div>
                          {rosterIds.has(a.id) ? (
                            <Badge>Already on this session</Badge>
                          ) : (
                            <ActionForm action={bookAction} className="space-y-2">
                              <input type="hidden" name="sessionId" value={s.id} />
                              <input type="hidden" name="athleteId" value={a.id} />
                              <input type="hidden" name="idem" value={randomUUID()} />
                              <details>
                                <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs font-medium text-ink-3">Comp / override options</summary>
                                <div className="space-y-2 pt-1">
                                  <label className="flex min-h-11 items-center gap-2 text-sm">
                                    <input type="checkbox" name="comp" className="size-5" /> Book as comp (no credit)
                                  </label>
                                  <Field label="Comp reason" htmlFor={`comp-${a.id}`}>
                                    <Input id={`comp-${a.id}`} name="compReason" className="h-11" />
                                  </Field>
                                  <label className="flex min-h-11 items-center gap-2 text-sm">
                                    <input type="checkbox" name="override" className="size-5" /> Override eligibility (forms/age)
                                  </label>
                                  <Field label="Override reason" htmlFor={`ovr-${a.id}`}>
                                    <Input id={`ovr-${a.id}`} name="overrideReason" className="h-11" />
                                  </Field>
                                </div>
                              </details>
                              <SubmitButton className="min-h-11" pendingText="Booking…">
                                Book {a.first}
                              </SubmitButton>
                            </ActionForm>
                          )}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Policy" kicker="Cancellation" />
            <CardBody className="text-sm">
              {policy ? (
                <dl className="space-y-1">
                  <div>
                    <dt className="inline font-medium">{policy.name}</dt>
                  </div>
                  <div>
                    Late-cancel window: {Math.round((policy.lateCancelWindowMinutes / 60) * 10) / 10} h — {PENALTY[policy.lateCancelPenalty]}
                  </div>
                  <div>No-show: {PENALTY[policy.noShowPenalty]}</div>
                  {policy.feeMinor > 0 ? <div>Fee: ${(policy.feeMinor / 100).toFixed(2)} (recorded for billing)</div> : null}
                </dl>
              ) : (
                <p className="text-ink-3">No cancellation policy is set for {service.name}; cancellations always return the credit.</p>
              )}
            </CardBody>
          </Card>

          {manager && !cancelled ? (
            <>
              <Card>
                <CardHeader title="Substitute coach" />
                <CardBody>
                  <ActionForm action={substituteCoachAction} className="space-y-3">
                    <input type="hidden" name="sessionId" value={s.id} />
                    <Field label="New coach" htmlFor="sub-coach">
                      <Select id="sub-coach" name="coachUserId" defaultValue="" required className="h-11">
                        <option value="" disabled>
                          Choose…
                        </option>
                        {coaches
                          .filter((c) => c.id !== s.coachUserId)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field label="Reason (optional)" htmlFor="sub-reason">
                      <Input id="sub-reason" name="reason" className="h-11" />
                    </Field>
                    <SubmitButton className="min-h-11" pendingText="Saving…">
                      Substitute
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Edit session" />
                <CardBody>
                  <ActionForm action={updateSessionAction} className="space-y-3">
                    <input type="hidden" name="sessionId" value={s.id} />
                    <input type="hidden" name="version" value={s.version} />
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Capacity" htmlFor="cap">
                        <Input id="cap" name="capacity" type="number" min={0} defaultValue={s.capacity} className="h-11" />
                      </Field>
                      <Field label="Waitlist size" htmlFor="wl">
                        <Input id="wl" name="waitlistCapacity" type="number" min={0} defaultValue={s.waitlistCapacity} className="h-11" />
                      </Field>
                    </div>
                    <Field label="Who can book online" htmlFor="vis">
                      <Select id="vis" name="visibility" defaultValue={s.visibility} className="h-11">
                        <option value="members">Members (families & athletes)</option>
                        <option value="public">Public</option>
                        <option value="private">Private (staff books)</option>
                      </Select>
                    </Field>
                    <Field label="Notes (staff)" htmlFor="notes">
                      <Textarea id="notes" name="notes" defaultValue={s.notes ?? ""} />
                    </Field>
                    <SubmitButton className="min-h-11" pendingText="Saving…">
                      Save
                    </SubmitButton>
                    <p className="text-xs text-ink-3">Raising capacity doesn&apos;t auto-promote; use “Fill open spots”.</p>
                  </ActionForm>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Cancel session" />
                <CardBody>
                  <ActionForm action={cancelSessionAction} className="space-y-3">
                    <input type="hidden" name="sessionId" value={s.id} />
                    <Field label="Reason (shared with families)" htmlFor="cancel-reason" required>
                      <Input id="cancel-reason" name="reason" required className="h-11" />
                    </Field>
                    <SubmitButton variant="danger" className="min-h-11" pendingText="Cancelling…" confirm="Cancel this session for everyone? All credits are returned and families are notified.">
                      Cancel session
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
