import { randomUUID } from "node:crypto";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cancellationPolicies, serviceTypes } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { athleteBookingsIn, familyAthletes, SessionListItem } from "@/lib/scheduling/queries";
import { fmt } from "@/lib/time";
import { bookAction, cancelBookingAction } from "../actions";
import { ReservePicker } from "./reserve-picker";

export type FamilyMember = Awaited<ReturnType<typeof familyAthletes>>[number];
export type FamilyBooking = Awaited<ReturnType<typeof athleteBookingsIn>>[number];
type Policy = typeof cancellationPolicies.$inferSelect;
export type BookingRules = { familyBookingCutoffMinutes: number | null; bookingWindowDays: number | null };

const LIVE = ["booked", "waitlisted", "attended"];

/** Live reservations (reserved, waitlisted, attended) of the family in the given sessions, by session then athlete. */
export function liveBySession(rows: FamilyBooking[]) {
  const m = new Map<string, Map<string, FamilyBooking>>();
  for (const b of rows) {
    if (!LIVE.includes(b.status)) continue;
    const inner = m.get(b.sessionId) ?? new Map<string, FamilyBooking>();
    inner.set(b.athleteId, b);
    m.set(b.sessionId, inner);
  }
  return m;
}

/** Cancellation policy per service type, for stating the late-cancel rule where a family cancels. */
export async function policiesByService(orgId: string) {
  const rows = await db
    .select({ serviceTypeId: serviceTypes.id, policy: cancellationPolicies })
    .from(serviceTypes)
    .leftJoin(cancellationPolicies, eq(cancellationPolicies.id, serviceTypes.cancellationPolicyId))
    .where(eq(serviceTypes.orgId, orgId));
  return new Map(rows.map((p) => [p.serviceTypeId, p.policy]));
}

/** The late-cancel rule in one sentence, or null when cancelling is never penalised. Wording follows the configured policy. */
export function lateCancelRule(pol: Policy | null | undefined) {
  if (!pol || pol.lateCancelPenalty === "none") return null;
  const hrs = Math.round((pol.lateCancelWindowMinutes / 60) * 10) / 10;
  return `Cancelling within ${hrs} hour${hrs === 1 ? "" : "s"} of the start ${pol.lateCancelPenalty === "fee" ? "may incur a fee" : "uses the session credit"} under the current policy.`;
}

export function cancelConfirm(pol: Policy | null | undefined) {
  const rule = lateCancelRule(pol);
  return rule ? `Cancel this reservation? ${rule}` : "Cancel this reservation?";
}

/** "5 of 12 spots open", or the waitlist state when full. */
export function spotsText(s: Pick<SessionListItem, "booked" | "capacity" | "waitlisted" | "waitlistCapacity">) {
  const open = Math.max(0, s.capacity - s.booked);
  if (open > 0) return `${open} of ${s.capacity} spots open`;
  return s.waitlisted > 0 ? `Full · ${s.waitlisted} on the waitlist` : "Full";
}

/**
 * The one action for a class, for the whole family: Reserve (with a family-member checklist when there
 * is more than one child), Join waitlist when full, or the Reserved state with Cancel reservation.
 * Authorization is unchanged: the server actions re-check `booking.create` on each athlete.
 */
export function ReserveControl({
  s,
  members,
  bookings,
  rules,
  policy,
  now,
  tz,
  align = "end",
}: {
  s: SessionListItem;
  members: FamilyMember[];
  bookings: Map<string, FamilyBooking> | undefined;
  rules: BookingRules;
  policy: Policy | null | undefined;
  now: Date;
  tz: string;
  align?: "end" | "start";
}) {
  const several = members.length > 1;
  const held = members.filter((m) => bookings?.has(m.id));
  const candidates = members.filter((m) => m.canBook && m.active && !bookings?.has(m.id));
  const locked = members.filter((m) => !m.canBook && !bookings?.has(m.id));
  const full = s.booked >= s.capacity;
  const waitOpen = s.waitlisted < s.waitlistCapacity;
  const cutoffAt = s.startsAt.getTime() - (rules.familyBookingCutoffMinutes ?? 0) * 60_000;
  const opensAt = rules.bookingWindowDays != null ? s.startsAt.getTime() - rules.bookingWindowDays * 86_400_000 : null;
  const note = cn("text-xs text-ink-3", align === "end" && "sm:text-right");

  let closed: string | null = null;
  if (s.status === "cancelled") closed = "";
  else if (now >= s.endsAt) closed = "Ended";
  else if (now.getTime() > cutoffAt) closed = `Online reservations closed${now < s.startsAt ? ". Please call the front desk" : ""}.`;
  else if (opensAt && now.getTime() < opensAt) closed = `Reservations open ${fmt(new Date(opensAt), "MMM d", tz)}.`;
  else if (full && !waitOpen) closed = "Full";

  const label = `${s.title}, ${fmt(s.startsAt, "EEE MMM d h:mm a", tz)}`;
  let reserve: React.ReactNode = null;
  if (closed === null && candidates.length === 1) {
    const m = candidates[0];
    reserve = (
      <ActionForm action={bookAction}>
        <input type="hidden" name="sessionId" value={s.id} />
        <input type="hidden" name="athleteId" value={m.id} />
        <input type="hidden" name="idem" value={randomUUID()} />
        <SubmitButton variant={full ? "secondary" : "primary"} className="min-h-11 w-full sm:w-auto sm:min-w-32" pendingText={full ? "Joining…" : "Reserving…"}>
          {full ? "Join waitlist" : "Reserve"}
          {several ? ` for ${m.first}` : ""}
          <span className="sr-only">: {label}</span>
        </SubmitButton>
      </ActionForm>
    );
  } else if (closed === null && candidates.length > 1) {
    reserve = (
      <details className="group w-full">
        <summary
          className={cn(
            buttonClass(full ? "secondary" : "primary", "md", "min-h-11 w-full cursor-pointer list-none sm:ml-auto sm:flex sm:w-fit sm:min-w-32 [&::-webkit-details-marker]:hidden"),
            align === "start" && "sm:ml-0",
          )}
        >
          {full ? "Join waitlist" : "Reserve"}
          <span className="sr-only">: {label}</span>
        </summary>
        <div className="mt-2 rounded-md border border-edge bg-surface-2 p-3">
          <ReservePicker sessionId={s.id} members={candidates.map((m) => ({ id: m.id, name: `${m.first} ${m.last}` }))} waitlist={full} idem={randomUUID()} classLabel={label} />
        </div>
      </details>
    );
  }

  if (!held.length && !reserve && !closed && !locked.length) return null;
  return (
    <div className={cn("flex flex-col gap-2", align === "end" ? "sm:items-end" : "items-stretch sm:items-start")}>
      {held.map((m) => {
        const b = bookings!.get(m.id)!;
        const canCancel = m.canBook && s.startsAt > now && b.status !== "attended";
        return (
          <div key={m.id} className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", align === "end" && "sm:justify-end")}>
            {b.status === "waitlisted" ? (
              <Badge variant="yellow">
                Waitlist #{b.waitlistPosition}
                {several ? ` · ${m.first}` : ""}
              </Badge>
            ) : (
              <Badge variant="green">
                {b.status === "attended" ? "Attended" : "Reserved"}
                {several ? ` · ${m.first}` : ""}
              </Badge>
            )}
            {canCancel ? (
              <ActionForm action={cancelBookingAction}>
                <input type="hidden" name="bookingId" value={b.id} />
                <SubmitButton
                  variant="outline"
                  className="min-h-11"
                  pendingText={b.status === "waitlisted" ? "Leaving…" : "Cancelling…"}
                  confirm={b.status === "waitlisted" ? undefined : cancelConfirm(policy)}
                >
                  {b.status === "waitlisted" ? "Leave waitlist" : "Cancel reservation"}
                  <span className="sr-only">
                    {" "}
                    for {m.first}: {label}
                  </span>
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        );
      })}
      {reserve}
      {closed && !(held.length && closed === "Ended") ? <p className={cn(note, closed === "Full" && "font-semibold")}>{closed}</p> : null}
      {closed === null && reserve && s.creditCost > 0 ? (
        <p className={note}>
          Uses {s.creditCost} credit{s.creditCost === 1 ? "" : "s"} unless covered by a membership.
        </p>
      ) : null}
      {closed === null && reserve && s.seriesId ? (
        <Link href={`/schedule/family-book?session=${s.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline sm:min-h-0">
          Reserve several weeks<span className="sr-only">: {label}</span>
        </Link>
      ) : null}
      {closed === null && locked.length ? (
        <p className={note}>
          Reserving for {locked.map((m) => m.first).join(" and ")} isn&apos;t enabled on your account.
        </p>
      ) : null}
    </div>
  );
}
