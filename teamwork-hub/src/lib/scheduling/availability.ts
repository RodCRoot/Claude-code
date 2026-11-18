import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings, busyBlocks, coachAvailability, resources, scheduleSessions, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, isoWeekday, localToUtc } from "@/lib/time";
import { bookingSettings, canRunSession, getServiceType, ScheduleConflictError, withConflictMessage } from "./common";
import { bookInternal } from "./booking";
import { createSession } from "./sessions";

export type Slot = { coachUserId: string; coachName: string; startsAt: Date; endsAt: Date };

const PRIVATE_KINDS = ["private", "semi_private", "assessment"];

type Interval = { s: number; e: number };
const overlaps = (a: Interval, b: Interval) => a.s < b.e && b.s < a.e;

/**
 * Available start times for a private/assessment service:
 * coach_availability (weekly local windows, effective dates) minus the coach's non-cancelled
 * sessions (with both sides' buffers) minus busy_blocks (time off + imported Google busy),
 * minus an exclusive resource's sessions when a resource is chosen.
 * Families additionally only see slots inside the booking window and after the cutoff.
 */
export async function findAvailableSlots(
  tx: Tx,
  v: Viewer,
  input: { serviceTypeId: string; fromYmd: string; days?: number; coachUserId?: string | null; resourceId?: string | null; stepMinutes?: number; now?: Date },
): Promise<Slot[]> {
  const now = input.now ?? new Date();
  const st = await getServiceType(tx, v.orgId, input.serviceTypeId);
  const staff = can(v, "schedule.manage") || v.role === "coach";
  if (!st.active) throw new UserError("This service isn't available.");
  if (!staff && !st.publicBookable) throw new AuthzError("This service can only be booked by staff.");
  const settings = await bookingSettings(tx, v.orgId);
  const tz = settings.timezone;
  const days = Math.min(Math.max(input.days ?? 7, 1), 42);
  const step = input.stepMinutes ?? 30;
  const toYmd = addDaysYmd(input.fromYmd, days - 1);
  const rangeStart = localToUtc(input.fromYmd, "00:00", tz);
  const rangeEnd = localToUtc(addDaysYmd(toYmd, 1), "00:00", tz);
  const dur = st.defaultDurationMinutes * 60_000;
  const bb = st.bufferBeforeMinutes * 60_000;
  const ba = st.bufferAfterMinutes * 60_000;

  const avail = await tx
    .select({ a: coachAvailability, name: users.displayName })
    .from(coachAvailability)
    .innerJoin(users, eq(users.id, coachAvailability.coachUserId))
    .where(and(eq(coachAvailability.orgId, v.orgId), input.coachUserId ? eq(coachAvailability.coachUserId, input.coachUserId) : sql`true`, sql`${users.disabledAt} is null`));
  if (!avail.length) return [];
  const coachIds = [...new Set(avail.map((r) => r.a.coachUserId))];

  const sess = await tx
    .select({ coach: scheduleSessions.coachUserId, s: scheduleSessions.startsAt, e: scheduleSessions.endsAt, b: scheduleSessions.bufferBeforeMinutes, a: scheduleSessions.bufferAfterMinutes })
    .from(scheduleSessions)
    .where(
      and(
        eq(scheduleSessions.orgId, v.orgId),
        ne(scheduleSessions.status, "cancelled"),
        inArray(scheduleSessions.coachUserId, coachIds),
        lt(scheduleSessions.startsAt, new Date(rangeEnd.getTime() + 86_400_000)),
        gt(scheduleSessions.endsAt, new Date(rangeStart.getTime() - 86_400_000)),
      ),
    );
  const busy = await tx
    .select()
    .from(busyBlocks)
    .where(and(eq(busyBlocks.orgId, v.orgId), inArray(busyBlocks.coachUserId, coachIds), lt(busyBlocks.startsAt, rangeEnd), gt(busyBlocks.endsAt, rangeStart)));
  let resourceBusy: Interval[] = [];
  if (input.resourceId) {
    const [r] = await tx.select().from(resources).where(and(eq(resources.id, input.resourceId), eq(resources.orgId, v.orgId)));
    if (!r) throw new UserError("Resource not found.");
    if (r.exclusive) {
      const rs = await tx
        .select({ s: scheduleSessions.startsAt, e: scheduleSessions.endsAt, b: scheduleSessions.bufferBeforeMinutes, a: scheduleSessions.bufferAfterMinutes })
        .from(scheduleSessions)
        .where(and(eq(scheduleSessions.resourceId, r.id), ne(scheduleSessions.status, "cancelled"), lt(scheduleSessions.startsAt, rangeEnd), gt(scheduleSessions.endsAt, rangeStart)));
      resourceBusy = rs.map((x) => ({ s: x.s.getTime() - x.b * 60_000, e: x.e.getTime() + x.a * 60_000 }));
    }
  }

  const blockedBy = new Map<string, Interval[]>();
  for (const c of coachIds) blockedBy.set(c, []);
  for (const x of sess) blockedBy.get(x.coach!)?.push({ s: x.s.getTime() - x.b * 60_000, e: x.e.getTime() + x.a * 60_000 });
  for (const x of busy) blockedBy.get(x.coachUserId)?.push({ s: x.startsAt.getTime(), e: x.endsAt.getTime() });

  let earliest = now.getTime();
  let latest = Number.POSITIVE_INFINITY;
  if (!staff) {
    earliest += (settings.familyBookingCutoffMinutes ?? 0) * 60_000;
    if (settings.bookingWindowDays != null) latest = now.getTime() + settings.bookingWindowDays * 86_400_000;
  }

  const out: Slot[] = [];
  for (let d = input.fromYmd; d <= toYmd; d = addDaysYmd(d, 1)) {
    const wd = isoWeekday(d);
    for (const { a, name } of avail) {
      if (a.weekday !== wd) continue;
      if (a.effectiveFrom && d < a.effectiveFrom) continue;
      if (a.effectiveTo && d > a.effectiveTo) continue;
      const winStart = localToUtc(d, a.startLocal.slice(0, 5), tz).getTime();
      const winEnd = localToUtc(d, a.endLocal.slice(0, 5), tz).getTime();
      for (let t = winStart; t + dur <= winEnd; t += step * 60_000) {
        if (t < earliest || t > latest) continue;
        const slot = { s: t - bb, e: t + dur + ba };
        if (blockedBy.get(a.coachUserId)!.some((b) => overlaps(slot, b))) continue;
        if (resourceBusy.some((b) => overlaps(slot, b))) continue;
        out.push({ coachUserId: a.coachUserId, coachName: name, startsAt: new Date(t), endsAt: new Date(t + dur) });
      }
    }
  }
  out.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.coachName.localeCompare(y.coachName));
  // De-duplicate overlapping availability rows for the same coach/time.
  return out.filter((s, i) => i === 0 || !(s.coachUserId === out[i - 1].coachUserId && s.startsAt.getTime() === out[i - 1].startsAt.getTime()));
}

/**
 * Book a private session / assessment slot: creates the session (exclusive coach/resource are enforced
 * by the DB exclusion constraints) and books the athlete in the same transaction.
 * Families may only book slots returned by findAvailableSlots; staff may place any time (overlaps still rejected).
 */
export async function bookPrivateSlot(
  tx: Tx,
  v: Viewer,
  input: { serviceTypeId: string; coachUserId: string; startsAt: Date; athleteId: string; resourceId?: string | null; idempotencyKey?: string | null; comp?: { reason: string } | null; now?: Date },
) {
  const st = await getServiceType(tx, v.orgId, input.serviceTypeId);
  if (!PRIVATE_KINDS.includes(st.kind)) throw new UserError("Choose a private session or assessment service.");
  if (input.idempotencyKey) {
    const [prior] = await tx.select().from(bookings).where(and(eq(bookings.orgId, v.orgId), eq(bookings.idempotencyKey, input.idempotencyKey)));
    if (prior) return { booking: prior, sessionId: prior.sessionId, reused: true };
  }
  const staff = can(v, "schedule.manage") || (v.role === "coach" && input.coachUserId === v.userId);
  if (!staff) {
    const tz = (await bookingSettings(tx, v.orgId)).timezone;
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(input.startsAt);
    const slots = await findAvailableSlots(tx, v, { serviceTypeId: st.id, fromYmd: ymd, days: 1, coachUserId: input.coachUserId, resourceId: input.resourceId, now: input.now });
    if (!slots.some((s) => s.startsAt.getTime() === input.startsAt.getTime())) throw new ScheduleConflictError("That time is no longer available. Please pick another slot.");
  } else if (v.role === "coach" && !can(v, "schedule.manage") && input.coachUserId !== v.userId) {
    throw new AuthzError("Coaches can only schedule their own private sessions.");
  }
  // Serialize concurrent attempts on the same coach (advisory lock scoped to this transaction).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`private-slot:${input.coachUserId}`}))`);
  const session = await withConflictMessage(
    () => createSession(tx, v, { serviceTypeId: st.id, startsAt: input.startsAt, coachUserId: input.coachUserId, resourceId: input.resourceId ?? null, capacity: st.defaultCapacity, visibility: "private" }, { asSystem: true }),
    "That coach or room is already booked at that time.",
  );
  const r = await bookInternal(
    tx,
    v,
    { sessionId: session.id, athleteId: input.athleteId, idempotencyKey: input.idempotencyKey, comp: input.comp, allowWaitlist: false, now: input.now },
    { allowPrivate: true },
  );
  return { booking: r.booking, sessionId: session.id, reused: false };
}

/** Coaches who can be scheduled (staff users), for selects. */
export async function listCoaches(tx: Tx, orgId: string) {
  return tx
    .select({ id: users.id, name: users.displayName, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]), sql`${users.disabledAt} is null`))
    .orderBy(sql`case when ${users.role} = 'coach' then 0 else 1 end`, users.displayName);
}

export function canScheduleFor(v: Viewer, coachUserId: string) {
  return canRunSession(v, { coachUserId });
}

