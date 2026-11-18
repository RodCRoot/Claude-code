import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, bookings, people, scheduleSessions, sessionFeedback, tasks, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, AuthzError, can, canOnAthlete, coachAthleteIds, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { retentionContext } from "./common";

/**
 * Session feedback (athlete experience): a 1–5 rating, optional comment, optional "tell my coach".
 *
 * Who may leave it: the athlete for their own bookings, or a guardian for an athlete they may
 * book for (`booking.create`). One response per booking; the person who left it may edit it for
 * 24 hours. Nothing here sends a message: a low rating only creates an internal staff task.
 */
export const EDIT_WINDOW_MS = 24 * 3_600_000;
export const RATING_LABELS: Record<number, string> = { 1: "Poor", 2: "Not great", 3: "OK", 4: "Good", 5: "Great" };
export const FOLLOW_UP_TITLE = "Follow up on session feedback";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export const feedbackSchema = z.object({
  bookingId: z.string().uuid(),
  rating: z.coerce.number().int().min(1, "Choose a rating").max(5),
  comment: z.string().trim().max(1000, "Keep it under 1000 characters").optional(),
  tellCoach: z.boolean().default(false),
});

async function loadBooking(tx: Tx, v: Viewer, bookingId: string) {
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError("Session feedback is left by the athlete or their parent / guardian.");
  const [row] = await tx
    .select({ booking: bookings, session: scheduleSessions, first: people.firstName, last: people.lastName, personId: athletes.personId, coach: users.displayName })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(users, eq(users.id, scheduleSessions.coachUserId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, v.orgId)));
  // Same error whether the booking does not exist or belongs to someone else.
  if (!row || !(await canOnAthlete(tx, v, row.booking.athleteId, "booking.create"))) throw new AuthzError();
  return row;
}

export type FeedbackState = "open" | "editable" | "locked" | "not_attended" | "not_ended" | "closed";

/** What the viewer may do with feedback for a booking right now (page + action share this). */
export async function feedbackTarget(tx: Tx, v: Viewer, bookingId: string, now = new Date()) {
  const row = await loadBooking(tx, v, bookingId);
  const { settings, tz } = await retentionContext(tx, v.orgId);
  const [existing] = await tx.select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, bookingId));
  let state: FeedbackState;
  if (existing) state = existing.submittedByUserId === v.userId && now.getTime() - existing.createdAt.getTime() <= EDIT_WINDOW_MS ? "editable" : "locked";
  else if (row.booking.status !== "attended") state = "not_attended";
  else if (now < row.session.endsAt) state = "not_ended";
  else if (now.getTime() - row.session.endsAt.getTime() > settings.feedbackEntryDays * 86_400_000) state = "closed";
  else state = "open";
  return { ...row, athleteName: `${row.first} ${row.last}`, existing: existing ?? null, state, settings, tz, editableUntil: existing ? new Date(existing.createdAt.getTime() + EDIT_WINDOW_MS) : null };
}

const STATE_ERRORS: Record<Exclude<FeedbackState, "open" | "editable">, string> = {
  locked: "Feedback was already left for this session and can no longer be changed.",
  not_attended: "Feedback can be left after an attended session.",
  not_ended: "Feedback opens when the session ends.",
  closed: "The feedback window for this session has closed.",
};

/** Org owner who receives low-rating follow-ups that are not shared with the coach. */
async function defaultFollowUpAssignee(tx: Tx, orgId: string): Promise<string | null> {
  const [o] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, "owner"), sql`${users.disabledAt} is null`))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return o?.id ?? null;
}

/**
 * Create or (within 24h, by the same person) update the response for a booking. A rating at or
 * below the configured threshold creates ONE staff task. The task never contains the comment or
 * the rating; without "tell my coach" it is not linked to the athlete either, so it cannot reveal
 * who said what on a profile a coach can open.
 */
export async function submitFeedback(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  const input = feedbackSchema.parse(raw);
  const t = await feedbackTarget(tx, v, input.bookingId, now);
  if (t.state !== "open" && t.state !== "editable") throw new UserError(STATE_ERRORS[t.state]);
  const comment = input.comment ? input.comment : null;
  let row: typeof sessionFeedback.$inferSelect;
  if (t.existing) {
    [row] = await tx.update(sessionFeedback).set({ rating: input.rating, comment, tellCoach: input.tellCoach, updatedAt: now }).where(eq(sessionFeedback.id, t.existing.id)).returning();
    await audit(tx, actor(v), "feedback.update", "session_feedback", row.id, { summary: `rating ${t.existing.rating} → ${row.rating}; tell coach: ${row.tellCoach ? "yes" : "no"}` });
  } else {
    const inserted = await tx
      .insert(sessionFeedback)
      .values({
        orgId: v.orgId,
        bookingId: t.booking.id,
        sessionId: t.session.id,
        athleteId: t.booking.athleteId,
        rating: input.rating,
        comment,
        tellCoach: input.tellCoach,
        submittedByUserId: v.userId,
        submittedByRole: v.role === "guardian" ? "guardian" : "athlete",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: sessionFeedback.bookingId })
      .returning();
    // Lost a race with the other parent / the athlete: one response per booking.
    if (!inserted.length) throw new UserError(STATE_ERRORS.locked);
    row = inserted[0];
    await audit(tx, actor(v), "feedback.submit", "session_feedback", row.id, { summary: `rating ${row.rating}; tell coach: ${row.tellCoach ? "yes" : "no"}` });
  }
  if (row.rating <= t.settings.lowRatingThreshold && !row.followUpTaskId) {
    const shared = row.tellCoach && !!t.session.coachUserId;
    const [task] = await tx
      .insert(tasks)
      .values({
        orgId: v.orgId,
        title: FOLLOW_UP_TITLE,
        description: `A session rating at or below the follow-up threshold was left. Open /people/retention/feedback/${row.id} to read it (visible to roles allowed). Nothing was sent to the family.`,
        dueAt: new Date(now.getTime() + 2 * 86_400_000),
        assigneeUserId: shared ? t.session.coachUserId : await defaultFollowUpAssignee(tx, v.orgId),
        relatedPersonId: shared ? t.personId : null,
        relatedType: "session_feedback",
        relatedId: row.id,
        priority: "high",
        source: "session_feedback",
        dedupeKey: `feedback:${row.id}`,
      })
      .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
      .returning();
    if (task) {
      [row] = await tx.update(sessionFeedback).set({ followUpTaskId: task.id }).where(eq(sessionFeedback.id, row.id)).returning();
      await audit(tx, { orgId: v.orgId, actorUserId: null, actorRole: "system" }, "task.create", "task", task.id, { summary: FOLLOW_UP_TITLE });
    }
  }
  return row;
}

/** Recent attended sessions the viewer can rate (or has just rated), newest first. Family roles only. */
export async function pendingFeedback(tx: Tx, v: Viewer, now = new Date(), limit = 6) {
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  const ids = await accessibleAthleteIds(tx, v, "booking.create");
  if (ids === "all" || !ids.length) return [];
  const { settings } = await retentionContext(tx, v.orgId);
  const since = new Date(now.getTime() - settings.feedbackEntryDays * 86_400_000);
  const rows = await tx
    .select({
      bookingId: bookings.id,
      athleteId: bookings.athleteId,
      first: people.firstName,
      title: scheduleSessions.title,
      startsAt: scheduleSessions.startsAt,
      timezone: scheduleSessions.timezone,
      feedbackId: sessionFeedback.id,
      rating: sessionFeedback.rating,
      submittedBy: sessionFeedback.submittedByUserId,
      submittedAt: sessionFeedback.createdAt,
    })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(sessionFeedback, eq(sessionFeedback.bookingId, bookings.id))
    .where(and(eq(bookings.orgId, v.orgId), inArray(bookings.athleteId, ids), eq(bookings.status, "attended"), lte(scheduleSessions.endsAt, now), gte(scheduleSessions.endsAt, since)))
    .orderBy(desc(scheduleSessions.startsAt))
    .limit(limit);
  return rows.map((r) => ({
    bookingId: r.bookingId,
    athleteId: r.athleteId,
    athleteFirst: r.first,
    title: r.title,
    startsAt: r.startsAt,
    timezone: r.timezone,
    rating: r.rating,
    state: (!r.feedbackId ? "open" : r.submittedBy === v.userId && now.getTime() - r.submittedAt!.getTime() <= EDIT_WINDOW_MS ? "editable" : "locked") as "open" | "editable" | "locked",
  }));
}

export type SessionFeedbackSummary = {
  count: number;
  /** Null when hidden by the anonymity floor (coach) or there are no responses. */
  average: number | null;
  hiddenForAnonymity: boolean;
  minResponses: number;
  /** Individual responses the viewer may read: all for reviewers, only "tell my coach" ones for the session's coach. */
  responses: { id: string; athleteName: string; personId: string; rating: number; comment: string | null; tellCoach: boolean }[];
};

/**
 * Staff view for one session. Owner/admin/operations: average + every response. The session's own
 * coach: the average only from `anonymityMinResponses` responses, plus responses where the family
 * ticked "tell my coach". Any other coach (and non-staff): nothing.
 */
export async function sessionFeedbackSummary(tx: Tx, v: Viewer, sessionId: string): Promise<SessionFeedbackSummary | null> {
  if (!isStaff(v)) return null;
  const [s] = await tx.select({ coachUserId: scheduleSessions.coachUserId }).from(scheduleSessions).where(and(eq(scheduleSessions.id, sessionId), eq(scheduleSessions.orgId, v.orgId)));
  if (!s) return null;
  const reviewer = can(v, "feedback.review");
  if (!reviewer && !(v.role === "coach" && s.coachUserId === v.userId)) return null;
  const { settings } = await retentionContext(tx, v.orgId);
  const rows = await tx
    .select({ id: sessionFeedback.id, rating: sessionFeedback.rating, comment: sessionFeedback.comment, tellCoach: sessionFeedback.tellCoach, first: people.firstName, last: people.lastName, personId: athletes.personId })
    .from(sessionFeedback)
    .innerJoin(athletes, eq(athletes.id, sessionFeedback.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(sessionFeedback.sessionId, sessionId), eq(sessionFeedback.orgId, v.orgId)))
    .orderBy(asc(people.lastName));
  const hidden = !reviewer && rows.length < settings.anonymityMinResponses;
  return {
    count: rows.length,
    average: rows.length && !hidden ? Math.round((rows.reduce((a, r) => a + r.rating, 0) / rows.length) * 10) / 10 : null,
    hiddenForAnonymity: hidden && rows.length > 0,
    minResponses: settings.anonymityMinResponses,
    responses: rows.filter((r) => reviewer || r.tellCoach).map((r) => ({ id: r.id, athleteName: `${r.first} ${r.last}`, personId: r.personId, rating: r.rating, comment: r.comment, tellCoach: r.tellCoach })),
  };
}

/**
 * One response with its comment, for the follow-up task. Owner/admin/operations always; a coach
 * only when the family ticked "tell my coach" AND it is their session or their assigned athlete.
 */
export async function feedbackDetail(tx: Tx, v: Viewer, feedbackId: string) {
  if (!isStaff(v)) throw new AuthzError();
  const [r] = await tx
    .select({ fb: sessionFeedback, session: scheduleSessions, first: people.firstName, last: people.lastName, personId: athletes.personId, coach: users.displayName })
    .from(sessionFeedback)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, sessionFeedback.sessionId))
    .innerJoin(athletes, eq(athletes.id, sessionFeedback.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(users, eq(users.id, scheduleSessions.coachUserId))
    .where(and(eq(sessionFeedback.id, feedbackId), eq(sessionFeedback.orgId, v.orgId)));
  if (!r) throw new AuthzError();
  if (!can(v, "feedback.review")) {
    const mine = r.session.coachUserId === v.userId || (await coachAthleteIds(tx, v)).includes(r.fb.athleteId);
    if (!(v.role === "coach" && r.fb.tellCoach && mine)) throw new AuthzError();
  }
  return { ...r.fb, athleteName: `${r.first} ${r.last}`, personId: r.personId, sessionTitle: r.session.title, sessionStartsAt: r.session.startsAt, timezone: r.session.timezone, coachName: r.coach };
}
