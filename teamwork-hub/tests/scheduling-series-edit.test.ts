import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { auditEvents, bookings, classSeries, jobs, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { creditSummary, verifyLedger } from "@/lib/credits";
import { bookSession, cancelSeriesFrom, editSeriesSessions, generateSeriesSessions, ScheduleConflictError } from "@/lib/scheduling";
import { addDaysYmd, fmt, isoWeekday, localToUtc, localYmd, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { giveCredits } from "./scheduling-helpers";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
  await db().execute(sql`update memberships set status = 'cancelled' where org_id = ${ctx.orgId}`);
  for (const k of ["maya", "eli", "leo", "mason", "zoe", "ethan", "sofia", "liam", "harper"]) await giveCredits(ctx, k, 30);
});
afterAll(closeTestDb);

const avail = async (k: string) => (await creditSummary(db(), ctx.athletes[k])).available;

/** A weekly series whose first session is tomorrow (facility time), with `weeks` generated sessions. */
async function mkSeries(opts: { time?: string; weeks?: number; capacity?: number; waitlist?: number; coach?: string } = {}) {
  const tz = ctx.tz;
  const first = addDaysYmd(todayLocal(tz), 1);
  const erin = await viewerFor(ctx, "erin");
  const [series] = await db()
    .insert(classSeries)
    .values({
      orgId: ctx.orgId,
      serviceTypeId: ctx.extra.scheduling.gpt,
      title: `Series ${randomUUID().slice(0, 6)}`,
      weekdays: [isoWeekday(first)],
      startTimeLocal: opts.time ?? "06:00",
      durationMinutes: 60,
      timezone: tz,
      startsOn: first,
      coachUserId: ctx.users[opts.coach ?? "marcus"],
      resourceId: ctx.extra.scheduling.turf,
      capacity: opts.capacity ?? 4,
      waitlistCapacity: opts.waitlist ?? 2,
    })
    .returning();
  await db().transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: first, weeks: opts.weeks ?? 6 }));
  const sessions = await db().select().from(scheduleSessions).where(eq(scheduleSessions.seriesId, series.id)).orderBy(asc(scheduleSessions.startsAt));
  return { series, sessions, first };
}

const reload = async (ids: string[]) =>
  db().select().from(scheduleSessions).where(inArray(scheduleSessions.id, ids)).orderBy(asc(scheduleSessions.startsAt));
const live = async (sessionId: string) =>
  db().select().from(bookings).where(and(eq(bookings.sessionId, sessionId), sql`${bookings.status} in ('booked','waitlisted','attended','no_show')`));

describe("series edits: this / following / all", () => {
  it("this-and-following changes time + coach, keeps bookings, bumps versions, notifies once per version, updates the template", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { series, sessions } = await mkSeries();
    expect(sessions).toHaveLength(6);
    for (const s of sessions.slice(1)) await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.maya }));
    const anchor = sessions[1];
    const r = await db().transaction((tx) =>
      editSeriesSessions(tx, erin, { sessionId: anchor.id, version: anchor.version, scope: "following", changes: { startTimeLocal: "07:15", coachUserId: ctx.users.tess } }),
    );
    expect(r.applied).toBe(true);
    if (!r.applied) return;
    expect(r.updated).toBe(5);
    expect(r.notified).toBe(5);
    const after = await reload(sessions.map((s) => s.id));
    // First session untouched.
    expect(after[0].version).toBe(1);
    expect(fmt(after[0].startsAt, "HH:mm", ctx.tz)).toBe("06:00");
    expect(after[0].coachUserId).toBe(ctx.users.marcus);
    for (const [i, s] of after.slice(1).entries()) {
      const before = sessions[i + 1];
      expect(s.version).toBe(2);
      expect(fmt(s.startsAt, "HH:mm", ctx.tz)).toBe("07:15"); // DST-safe local time on each date
      expect(localYmd(s.startsAt, ctx.tz)).toBe(localYmd(before.startsAt, ctx.tz));
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(60 * 60_000);
      expect(s.coachUserId).toBe(ctx.users.tess);
      expect(s.originalCoachUserId).toBeNull(); // reassignment, not a one-off substitution
      expect((await live(s.id)).map((b) => b.athleteId)).toEqual([ctx.athletes.maya]);
      const j = await db().select().from(jobs).where(like(jobs.dedupeKey, `notify.session_changed:${s.id}:%`));
      expect(j.map((x) => x.dedupeKey)).toEqual([`notify.session_changed:${s.id}:2`]);
      expect(j[0].payload).toMatchObject({ sessionId: s.id, version: 2 });
    }
    const [tpl] = await db().select().from(classSeries).where(eq(classSeries.id, series.id));
    expect(tpl.startTimeLocal.slice(0, 5)).toBe("07:15");
    expect(tpl.coachUserId).toBe(ctx.users.tess);
    // Re-generating never creates a twin at the old or new time.
    const gen = await db().transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: localYmd(sessions[0].startsAt, ctx.tz), weeks: 6 }));
    expect(gen.created).toBe(0);
    // Stale version is refused.
    await expect(
      db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: anchor.id, version: anchor.version, scope: "all", changes: { capacity: 6 } })),
    ).rejects.toThrow(/Someone else changed/);
  });

  it("'this session only' substitutes the coach (original kept) and leaves the rest of the series alone", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { series, sessions } = await mkSeries();
    const s = sessions[2];
    const r = await db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: s.id, version: 1, scope: "this", changes: { coachUserId: ctx.users.tess } }));
    expect(r.applied && r.updated).toBe(1);
    const after = await reload(sessions.map((x) => x.id));
    expect(after.filter((x) => x.coachUserId === ctx.users.tess).map((x) => x.id)).toEqual([s.id]);
    expect(after[2].originalCoachUserId).toBe(ctx.users.marcus);
    const [tpl] = await db().select().from(classSeries).where(eq(classSeries.id, series.id));
    expect(tpl.coachUserId).toBe(ctx.users.marcus);
  });

  it("capacity decreases never drop athletes: refuse lists conflicts; skip keeps them; keep-over applies and bookings stay", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { sessions } = await mkSeries({ capacity: 4, waitlist: 2 });
    const crowded = sessions[2];
    for (const k of ["maya", "eli", "leo", "mason", "zoe"]) await db().transaction((tx) => bookSession(tx, erin, { sessionId: crowded.id, athleteId: ctx.athletes[k] }));
    // 4 booked + 1 waitlisted
    const edit = (mode: "refuse" | "skip_conflicting" | "keep_bookings_over_capacity", version: number, capacity: number, waitlistCapacity?: number) =>
      db().transaction((tx) =>
        editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version, scope: "all", changes: { capacity, ...(waitlistCapacity !== undefined ? { waitlistCapacity } : {}) }, onCapacityConflict: mode }),
      );

    const refused = await edit("refuse", 1, 2, 0);
    expect(refused.applied).toBe(false);
    expect(refused.conflicts).toHaveLength(1);
    expect(refused.conflicts[0]).toMatchObject({ sessionId: crowded.id, occupying: 4, waitlisted: 1, newCapacity: 2, newWaitlistCapacity: 0 });
    expect((await reload(sessions.map((s) => s.id))).every((s) => s.version === 1 && s.capacity === 4)).toBe(true);

    const skipped = await edit("skip_conflicting", 1, 2, 0);
    expect(skipped.applied).toBe(true);
    let after = await reload(sessions.map((s) => s.id));
    expect(after.find((s) => s.id === crowded.id)).toMatchObject({ capacity: 4, waitlistCapacity: 2, version: 1 });
    expect(after.filter((s) => s.id !== crowded.id).every((s) => s.capacity === 2 && s.waitlistCapacity === 0 && s.version === 2)).toBe(true);
    // Capacity-only edits don't notify families.
    const j = await db().select().from(jobs).where(like(jobs.dedupeKey, `notify.session_changed:${sessions[0].id}:%`));
    expect(j).toHaveLength(0);

    const kept = await edit("keep_bookings_over_capacity", 2, 1);
    expect(kept.applied).toBe(true);
    after = await reload(sessions.map((s) => s.id));
    expect(after.find((s) => s.id === crowded.id)!.capacity).toBe(1);
    expect((await live(crowded.id)).filter((b) => b.status === "booked")).toHaveLength(4);
    expect((await live(crowded.id)).filter((b) => b.status === "waitlisted")).toHaveLength(1);
    // Over capacity: a new booking can only join the waitlist.
    const r = await db().transaction((tx) => bookSession(tx, erin, { sessionId: crowded.id, athleteId: ctx.athletes.ethan }));
    expect(r.status).toBe("waitlisted");
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, crowded.id), eq(auditEvents.action, "session.series_edit")));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("concurrent capacity shrink and bookings never leave a session over its capacity", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { sessions } = await mkSeries({ capacity: 4, waitlist: 0, weeks: 3 });
    const keys = ["maya", "eli", "leo", "mason"];
    const ops: Promise<unknown>[] = [
      db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version: 1, scope: "all", changes: { capacity: 2 } })),
      ...sessions.flatMap((s) => keys.map((k) => db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes[k], allowWaitlist: false })))),
    ];
    const res = await Promise.allSettled(ops);
    for (const r of res) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(UserError);
    for (const s of await reload(sessions.map((x) => x.id))) {
      const occ = (await live(s.id)).filter((b) => b.status === "booked").length;
      expect(occ).toBeLessThanOrEqual(s.capacity);
    }
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
  });

  it("an overlap with an exclusive room rolls the whole edit back with a friendly error", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { sessions } = await mkSeries();
    const target = sessions[4];
    await db().insert(scheduleSessions).values({
      orgId: ctx.orgId,
      serviceTypeId: ctx.extra.scheduling.assessment,
      title: "Blocking assessment",
      startsAt: target.startsAt,
      endsAt: target.endsAt,
      timezone: ctx.tz,
      resourceId: ctx.extra.scheduling.assessmentRoom,
      exclusiveResource: true,
      capacity: 1,
    });
    const err = await db()
      .transaction((tx) => editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version: 1, scope: "all", changes: { resourceId: ctx.extra.scheduling.assessmentRoom } }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ScheduleConflictError);
    expect(err.message).toMatch(/Nothing was changed/);
    expect((await reload(sessions.map((s) => s.id))).every((s) => s.version === 1 && s.resourceId === ctx.extra.scheduling.turf)).toBe(true);
  });

  it("only schedule managers can edit; past sessions are refused", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const erin = await viewerFor(ctx, "erin");
    const { sessions } = await mkSeries({ weeks: 2 });
    await expect(db().transaction((tx) => editSeriesSessions(tx, marcus, { sessionId: sessions[0].id, version: 1, scope: "all", changes: { capacity: 8 } }))).rejects.toBeInstanceOf(AuthzError);
    const later = new Date(sessions[0].startsAt.getTime() + 5 * 60_000);
    await expect(
      db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version: 1, scope: "this", changes: { capacity: 8 }, now: later })),
    ).rejects.toThrow(/already started/);
    await expect(db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version: 1, scope: "all", changes: {} }))).rejects.toThrow(/Nothing to change/);
  });
});

describe("cancel a series from a date", () => {
  it("cancels every session from the date, releases credits, notifies per session, and ends the series", async () => {
    const erin = await viewerFor(ctx, "erin");
    const { series, sessions } = await mkSeries({ capacity: 2, waitlist: 1 });
    for (const s of sessions) {
      await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.sofia }));
      await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.liam }));
      await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes.harper })); // waitlisted
    }
    const before = await avail("sofia");
    const fromYmd = localYmd(sessions[3].startsAt, ctx.tz);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(db().transaction((tx) => cancelSeriesFrom(tx, marcus, { seriesId: series.id, fromYmd, reason: "x" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => cancelSeriesFrom(tx, erin, { seriesId: series.id, fromYmd, reason: " " }))).rejects.toThrow(/reason/);
    const r = await db().transaction((tx) => cancelSeriesFrom(tx, erin, { seriesId: series.id, fromYmd, reason: "Coach leaving; series ends early" }));
    expect(r.cancelled).toBe(3);
    expect(r.released).toBe(9);
    expect(await avail("sofia")).toBe(before + 3);
    const after = await reload(sessions.map((s) => s.id));
    expect(after.map((s) => s.status)).toEqual(["scheduled", "scheduled", "scheduled", "cancelled", "cancelled", "cancelled"]);
    for (const s of after.slice(3)) {
      expect(await live(s.id)).toHaveLength(0);
      expect(await db().select().from(jobs).where(eq(jobs.dedupeKey, `notify.session_cancelled:${s.id}`))).toHaveLength(1);
    }
    for (const s of after.slice(0, 3)) expect(await live(s.id)).toHaveLength(3);
    const [tpl] = await db().select().from(classSeries).where(eq(classSeries.id, series.id));
    expect(tpl.endsOn).toBe(addDaysYmd(fromYmd, -1));
    // Generation no longer extends past the end date.
    const gen = await db().transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: localYmd(sessions[0].startsAt, ctx.tz), weeks: 10 }));
    expect(gen.created).toBe(0);
    expect(await verifyLedger(db(), ctx.orgId)).toEqual([]);
    const audit = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, series.id), eq(auditEvents.action, "series.cancel_from")));
    expect(audit).toHaveLength(1);
  });

  it("time edits are applied in facility local time across a DST change", async () => {
    // Build a series spanning the 2026-11-01 fall-back change explicitly.
    const erin = await viewerFor(ctx, "erin");
    const tz = ctx.tz;
    const [series] = await db()
      .insert(classSeries)
      .values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.gpt, title: "DST series", weekdays: [3], startTimeLocal: "06:00", durationMinutes: 60, timezone: tz, startsOn: "2026-10-21", capacity: 5, waitlistCapacity: 0 })
      .returning();
    await db().transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: "2026-10-21", toYmd: "2026-11-11" }));
    const sessions = await db().select().from(scheduleSessions).where(eq(scheduleSessions.seriesId, series.id)).orderBy(asc(scheduleSessions.startsAt));
    expect(sessions).toHaveLength(4);
    const now = localToUtc("2026-10-20", "12:00", tz);
    await db().transaction((tx) => editSeriesSessions(tx, erin, { sessionId: sessions[0].id, version: 1, scope: "all", changes: { startTimeLocal: "05:30" }, now }));
    const after = await reload(sessions.map((s) => s.id));
    expect(after.map((s) => fmt(s.startsAt, "HH:mm", tz))).toEqual(["05:30", "05:30", "05:30", "05:30"]);
    // UTC offsets differ across the change, local wall time does not.
    expect(new Set(after.map((s) => s.startsAt.getUTCHours())).size).toBe(2);
  });
});
