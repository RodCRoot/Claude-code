import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, people, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, athleteCapabilities, type Viewer } from "@/lib/authz/policy";
import { isoWeekday, localYmd } from "@/lib/time";
import { bookSession } from "./booking";
import { actorOf, getSession } from "./common";
import { lockSessionsInOrder } from "./series-edit";

/**
 * Family multi-booking in one action: several authorized athletes into one session, and/or one
 * athlete into the next N weekly sessions of a series.
 *
 * - Every item goes through `bookSession` (authorization, window/cutoff, eligibility, capacity,
 *   entitlement) inside its own savepoint, so one refusal never leaves partial rows behind.
 * - All sessions involved are locked FOR UPDATE in id order before any item runs (no deadlocks
 *   between concurrent batches; capacity decisions stay serialized per session).
 * - Items run in session start order, so with limited credits the earliest sessions are booked first.
 * - mode "all_or_nothing": any failure rolls the whole batch back (results still list why).
 *   mode "partial": successes are kept; failures are listed per athlete/session.
 * - Idempotency: each item uses `<batchKey>:<sessionId>:<athleteId>`, so a retried submit returns
 *   the same bookings (reused) and never double-books or double-reserves.
 */

export const MAX_BATCH_ITEMS = 24;
export const MAX_SERIES_WEEKS = 12;

export type BatchMode = "all_or_nothing" | "partial";
export type BatchItem = { sessionId: string; athleteId: string };
export type BatchItemResult = {
  sessionId: string;
  athleteId: string;
  athleteLabel: string;
  sessionTitle: string;
  startsAt: Date | null;
  outcome: "booked" | "waitlisted" | "failed" | "rolled_back";
  reused: boolean;
  waitlistPosition: number | null;
  bookingId: string | null;
  error: string | null;
};
export type BatchResult = { committed: boolean; mode: BatchMode; results: BatchItemResult[]; booked: number; waitlisted: number; failed: number };

class RollbackBatch extends Error {}

export async function bookBatch(
  tx: Tx,
  v: Viewer,
  input: { items: BatchItem[]; mode: BatchMode; idempotencyKey: string; allowWaitlist?: boolean; now?: Date },
): Promise<BatchResult> {
  if (v.role === "kiosk") throw new AuthzError();
  const key = input.idempotencyKey?.trim();
  if (!key || key.length > 80) throw new UserError("Missing request key. Reload the page and try again.");
  const seen = new Set<string>();
  const items = input.items.filter((i) => {
    const k = `${i.sessionId}:${i.athleteId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!items.length) throw new UserError("Choose at least one athlete and session.");
  if (items.length > MAX_BATCH_ITEMS) throw new UserError(`Book at most ${MAX_BATCH_ITEMS} sessions at once.`);

  // Labels: only for athletes the viewer can see; never echo another family's names.
  const athleteIds = [...new Set(items.map((i) => i.athleteId))];
  const labels = new Map<string, string>();
  const visible = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, athleteIds)));
  for (const a of visible) if ((await athleteCapabilities(tx, v, a.id)).has("profile.read")) labels.set(a.id, `${a.first} ${a.last}`);

  const sessionIds = [...new Set(items.map((i) => i.sessionId))];
  const locked = await lockSessionsInOrder(tx, v.orgId, sessionIds);
  const sessions = new Map(locked.map((s) => [s.id, s]));
  const order = (i: BatchItem) => sessions.get(i.sessionId)?.startsAt.getTime() ?? 0;
  const run = [...items].sort((a, b) => order(a) - order(b) || a.athleteId.localeCompare(b.athleteId));

  const results = new Map<string, BatchItemResult>();
  const runAll = async (btx: Tx) => {
    for (const it of run) {
      const s = sessions.get(it.sessionId);
      const base = {
        sessionId: it.sessionId,
        athleteId: it.athleteId,
        athleteLabel: labels.get(it.athleteId) ?? "Athlete",
        sessionTitle: s?.title ?? "Session",
        startsAt: s?.startsAt ?? null,
      };
      const id = `${it.sessionId}:${it.athleteId}`;
      if (!s) {
        results.set(id, { ...base, outcome: "failed", reused: false, waitlistPosition: null, bookingId: null, error: "That session was not found." });
        continue;
      }
      try {
        const r = await btx.transaction((sp) =>
          bookSession(sp, v, {
            sessionId: it.sessionId,
            athleteId: it.athleteId,
            idempotencyKey: `${key}:${it.sessionId}:${it.athleteId}`,
            allowWaitlist: input.allowWaitlist ?? false,
            now: input.now,
          }),
        );
        results.set(id, { ...base, outcome: r.status, reused: r.reused, waitlistPosition: r.booking.waitlistPosition, bookingId: r.booking.id, error: null });
      } catch (e) {
        if (!(e instanceof UserError) && !(e instanceof AuthzError)) throw e;
        const msg = e instanceof AuthzError ? "You don't have permission to book for this athlete." : e.message;
        results.set(id, { ...base, outcome: "failed", reused: false, waitlistPosition: null, bookingId: null, error: msg });
      }
    }
    if (input.mode === "all_or_nothing" && [...results.values()].some((r) => r.outcome === "failed")) throw new RollbackBatch();
  };

  let committed = true;
  try {
    await tx.transaction(runAll);
  } catch (e) {
    if (!(e instanceof RollbackBatch)) throw e;
    committed = false;
  }

  const list = items.map((i) => {
    const r = results.get(`${i.sessionId}:${i.athleteId}`)!;
    return !committed && r.outcome !== "failed" ? { ...r, outcome: "rolled_back" as const, bookingId: null, waitlistPosition: null } : r;
  });
  const booked = list.filter((r) => r.outcome === "booked").length;
  const waitlisted = list.filter((r) => r.outcome === "waitlisted").length;
  const failed = list.filter((r) => r.outcome === "failed").length;
  if (committed && booked + waitlisted > 0) {
    await audit(tx, actorOf(v), "booking.batch", "booking", null, {
      summary: `Multi-booking (${input.mode === "all_or_nothing" ? "all or nothing" : "partial"}): ${booked} booked, ${waitlisted} waitlisted, ${failed} not booked`,
      after: { items: list.map((r) => ({ sessionId: r.sessionId, athleteId: r.athleteId, outcome: r.outcome, reused: r.reused })) },
    });
  }
  return { committed, mode: input.mode, results: list, booked, waitlisted, failed };
}

/**
 * "Book the next N weeks": the anchor session plus the following sessions of the same series on
 * the same local weekday (scheduled, not private, not started), at most `weeks` sessions in total.
 */
export async function nextSeriesSessions(tx: Tx, v: Viewer, input: { sessionId: string; weeks: number; now?: Date }) {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > MAX_SERIES_WEEKS) throw new UserError(`Choose 1–${MAX_SERIES_WEEKS} weeks.`, { weeks: `1–${MAX_SERIES_WEEKS}` });
  const anchor = await getSession(tx, v.orgId, input.sessionId);
  if (!anchor.seriesId || input.weeks === 1) return [anchor];
  const weekday = isoWeekday(localYmd(anchor.startsAt, anchor.timezone));
  const rows = await tx
    .select()
    .from(scheduleSessions)
    .where(
      and(
        eq(scheduleSessions.orgId, v.orgId),
        eq(scheduleSessions.seriesId, anchor.seriesId),
        eq(scheduleSessions.status, "scheduled"),
        ne(scheduleSessions.visibility, "private"),
        gte(scheduleSessions.startsAt, anchor.startsAt),
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt))
    .limit(input.weeks * 7);
  return rows.filter((s) => s.startsAt > now && isoWeekday(localYmd(s.startsAt, s.timezone)) === weekday).slice(0, input.weeks);
}
