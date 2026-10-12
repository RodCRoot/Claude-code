import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { busyBlocks, calendarConnections, calendarEventLinks, classSeries, coachAvailability, jobs, scheduleSessions } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { runJobs } from "@/lib/jobs";
import {
  bookPrivateSlot,
  createSession,
  findAvailableSlots,
  generateSeriesSessions,
  ScheduleConflictError,
  seriesOccurrences,
  substituteCoach,
  cancelSession,
  updateSession,
} from "@/lib/scheduling";
import { GoogleCalendarProvider, toGoogleEvent } from "@/lib/calendar/google";
import { calendarJobHandlers, importFreeBusy, syncFreeBusy } from "@/lib/calendar/sync";
import { CalendarConflictError, type CalendarProvider } from "@/lib/calendar/types";
import { addDaysYmd, isoWeekday, localToUtc, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const TZ = "America/Indiana/Indianapolis";

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

describe("series recurrence (DST-correct)", () => {
  it("keeps a 6:00 AM class at 6:00 AM local across 2026-03-08 and 2026-11-01", () => {
    const shape = { weekdays: [1, 2, 3, 4, 5, 6, 7], startTimeLocal: "06:00:00", durationMinutes: 60, timezone: TZ, startsOn: "2026-01-01", endsOn: null };
    const spring = seriesOccurrences(shape, "2026-03-06", "2026-03-10");
    const fall = seriesOccurrences(shape, "2026-10-30", "2026-11-03");
    for (const o of [...spring, ...fall]) expect(formatInTimeZone(o.startsAt, TZ, "HH:mm")).toBe("06:00");
    // UTC offset shifts by an hour across each change.
    expect(spring.find((o) => o.date === "2026-03-07")!.startsAt.toISOString()).toBe("2026-03-07T11:00:00.000Z");
    expect(spring.find((o) => o.date === "2026-03-08")!.startsAt.toISOString()).toBe("2026-03-08T10:00:00.000Z");
    expect(fall.find((o) => o.date === "2026-10-31")!.startsAt.toISOString()).toBe("2026-10-31T10:00:00.000Z");
    expect(fall.find((o) => o.date === "2026-11-01")!.startsAt.toISOString()).toBe("2026-11-01T11:00:00.000Z");
    // Durations stay 60 real minutes.
    for (const o of [...spring, ...fall]) expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(3_600_000);
  });

  it("respects weekdays and the series date range", () => {
    const occ = seriesOccurrences({ weekdays: [1, 3, 5], startTimeLocal: "16:30", durationMinutes: 45, timezone: TZ, startsOn: "2026-03-04", endsOn: "2026-03-13" }, "2026-03-01", "2026-03-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11", "2026-03-13"]);
  });

  it("generates sessions idempotently (unique series_id + starts_at)", async () => {
    const erin = await viewerFor(ctx, "erin");
    const d = db();
    const [series] = await d
      .insert(classSeries)
      .values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.gpt, title: "DST Class", weekdays: [7], startTimeLocal: "06:00", durationMinutes: 60, timezone: TZ, startsOn: "2026-10-01", capacity: 8, coachUserId: ctx.users.marcus })
      .returning();
    const a = await d.transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: "2026-10-18", weeks: 4 }));
    const b = await d.transaction((tx) => generateSeriesSessions(tx, erin, { seriesId: series.id, fromYmd: "2026-10-18", weeks: 4 }));
    expect(a.created).toBe(4);
    expect(b).toEqual({ created: 0, skipped: 4 });
    const rows = await d.select().from(scheduleSessions).where(eq(scheduleSessions.seriesId, series.id));
    expect(rows.map((r) => formatInTimeZone(r.startsAt, TZ, "yyyy-MM-dd HH:mm")).sort()).toEqual(["2026-10-18 06:00", "2026-10-25 06:00", "2026-11-01 06:00", "2026-11-08 06:00"]);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(d.transaction((tx) => generateSeriesSessions(tx, marcus, { seriesId: series.id }))).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("exclusive coach/resource overlap", () => {
  it("rejects an overlapping private session for the same coach with 23P01 (buffers included)", async () => {
    const erin = await viewerFor(ctx, "erin");
    const d = db();
    const day = addDaysYmd(todayLocal(TZ), 9);
    const start = localToUtc(day, "11:00", TZ);
    await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: start, coachUserId: ctx.users.tess }));
    // Starts right when the first ends, but the 10-minute buffers overlap.
    const err = await d
      .transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: new Date(start.getTime() + 60 * 60_000), coachUserId: ctx.users.tess }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ScheduleConflictError);
    expect(err.code).toBe("23P01");
    // Raw insert proves the DB itself enforces it.
    const raw = await d
      .insert(scheduleSessions)
      .values({ orgId: ctx.orgId, serviceTypeId: ctx.extra.scheduling.private, title: "raw", startsAt: new Date(start.getTime() + 15 * 60_000), endsAt: new Date(start.getTime() + 75 * 60_000), timezone: TZ, coachUserId: ctx.users.tess, capacity: 1, exclusiveCoach: true })
      .catch((e) => e);
    expect(raw?.cause?.code ?? raw?.code).toBe("23P01");
    // A different coach at the same time is fine; buffers clear after 20 minutes.
    await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: start, coachUserId: ctx.users.marcus }));
    await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: new Date(start.getTime() + 80 * 60_000), coachUserId: ctx.users.tess }));
    // The exclusive Assessment Room can't be double-booked even with different coaches.
    await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: localToUtc(day, "15:00", TZ), coachUserId: ctx.users.tess, resourceId: ctx.extra.scheduling.assessmentRoom }));
    await expect(
      d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, startsAt: localToUtc(day, "15:30", TZ), coachUserId: ctx.users.marcus, resourceId: ctx.extra.scheduling.assessmentRoom })),
    ).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  it("substituting in a coach who is busy with an exclusive session is rejected", async () => {
    const erin = await viewerFor(ctx, "erin");
    const day = addDaysYmd(todayLocal(TZ), 10);
    const a = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(day, "09:00", TZ), coachUserId: ctx.users.marcus }));
    const b = await db().transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(day, "09:00", TZ), coachUserId: ctx.users.tess }));
    await expect(db().transaction((tx) => substituteCoach(tx, erin, { sessionId: b.id, coachUserId: ctx.users.marcus }))).rejects.toBeInstanceOf(ScheduleConflictError);
    expect(a.id).toBeTruthy();
  });
});

describe("slot finder & private booking", () => {
  it("availability minus sessions minus busy blocks; families can book only offered slots", async () => {
    const d = db();
    const erin = await viewerFor(ctx, "erin");
    // Rod (owner) has no seeded sessions or availability, so this coach calendar is isolated.
    const day = addDaysYmd(todayLocal(TZ), 6);
    const wd = isoWeekday(day);
    await d.insert(coachAvailability).values({ orgId: ctx.orgId, coachUserId: ctx.users.rod, weekday: wd, startLocal: "09:00", endLocal: "12:00" });
    const assessment = ctx.extra.scheduling.assessment; // 60 min, 0 before / 15 after buffer
    const slots = async () =>
      (await d.transaction((tx) => findAvailableSlots(tx, erin, { serviceTypeId: assessment, fromYmd: day, days: 1, coachUserId: ctx.users.rod }))).map((s) =>
        formatInTimeZone(s.startsAt, TZ, "HH:mm"),
      );
    expect(await slots()).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    // An existing 10:00–11:00 private (10/10 buffers) blocks overlapping starts (with the assessment's 15-minute after-buffer).
    await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(day, "10:00", TZ), coachUserId: ctx.users.rod }));
    expect(await slots()).toEqual([]);
    expect(
      (await d.transaction((tx) => findAvailableSlots(tx, erin, { serviceTypeId: assessment, fromYmd: day, days: 1, coachUserId: ctx.users.rod, stepMinutes: 5 }))).length,
    ).toBe(0);
    // Time off removes the rest of the window for a different day.
    const day2 = addDaysYmd(day, 7);
    await d.insert(busyBlocks).values({ orgId: ctx.orgId, coachUserId: ctx.users.rod, startsAt: localToUtc(day2, "09:00", TZ), endsAt: localToUtc(day2, "10:30", TZ), source: "time_off" });
    const s2 = (await d.transaction((tx) => findAvailableSlots(tx, erin, { serviceTypeId: assessment, fromYmd: day2, days: 1, coachUserId: ctx.users.rod }))).map((s) => formatInTimeZone(s.startsAt, TZ, "HH:mm"));
    expect(s2).toEqual(["10:30", "11:00"]);

    // Family books an offered assessment slot (public bookable); an unoffered time is refused.
    const alex = await viewerFor(ctx, "alex");
    const famSlots = await d.transaction((tx) => findAvailableSlots(tx, alex, { serviceTypeId: assessment, fromYmd: day2, days: 1, coachUserId: ctx.users.rod }));
    expect(famSlots.length).toBe(2);
    await expect(
      d.transaction((tx) => bookPrivateSlot(tx, alex, { serviceTypeId: assessment, coachUserId: ctx.users.rod, startsAt: localToUtc(day2, "09:00", TZ), athleteId: ctx.athletes.maya })),
    ).rejects.toBeInstanceOf(ScheduleConflictError);
    const r = await d.transaction((tx) => bookPrivateSlot(tx, alex, { serviceTypeId: assessment, coachUserId: ctx.users.rod, startsAt: famSlots[0].startsAt, athleteId: ctx.athletes.maya, idempotencyKey: "slot-1" }));
    expect(r.booking.status).toBe("booked");
    const again = await d.transaction((tx) => bookPrivateSlot(tx, alex, { serviceTypeId: assessment, coachUserId: ctx.users.rod, startsAt: famSlots[0].startsAt, athleteId: ctx.athletes.maya, idempotencyKey: "slot-1" }));
    expect(again.reused).toBe(true);
    // Families can't use the staff-only Private Session service.
    await expect(d.transaction((tx) => findAvailableSlots(tx, alex, { serviceTypeId: ctx.extra.scheduling.private, fromYmd: day2 }))).rejects.toBeInstanceOf(AuthzError);
    // Wrong service kind is a business error.
    await expect(
      d.transaction((tx) => bookPrivateSlot(tx, erin, { serviceTypeId: ctx.extra.scheduling.gpt, coachUserId: ctx.users.rod, startsAt: famSlots[1].startsAt, athleteId: ctx.athletes.maya })),
    ).rejects.toBeInstanceOf(UserError);
  });
});

/** In-memory fake provider (no network). */
function fakeProvider() {
  const events = new Map<string, { etag: string; summary: string }>();
  let n = 0;
  const calls: string[] = [];
  let conflictOnce = false;
  const p: CalendarProvider & { calls: string[]; events: typeof events; failNextConflict: () => void } = {
    name: "fake",
    calls,
    events,
    failNextConflict: () => (conflictOnce = true),
    async pushEvent(_cal, e) {
      calls.push("push");
      const id = `ev${++n}`;
      events.set(id, { etag: `"e${n}"`, summary: e.summary });
      return { externalEventId: id, etag: `"e${n}"` };
    },
    async updateEvent(_cal, id, e, ifMatch) {
      calls.push(ifMatch ? "update-ifmatch" : "update-force");
      if (ifMatch && conflictOnce) {
        conflictOnce = false;
        throw new CalendarConflictError();
      }
      const etag = `"u${++n}"`;
      events.set(id, { etag, summary: e.summary });
      return { externalEventId: id, etag };
    },
    async deleteEvent(_cal, id) {
      calls.push("delete");
      events.delete(id);
    },
    async freeBusy() {
      calls.push("freebusy");
      return [{ start: new Date("2030-01-07T15:00:00Z"), end: new Date("2030-01-07T16:00:00Z") }];
    },
  };
  return p;
}

describe("Google Calendar adapter (no network)", () => {
  it("calls the official REST endpoints with bearer auth, If-Match, and parses free/busy", async () => {
    const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string });
      if (url.endsWith("/freeBusy")) return new Response(JSON.stringify({ calendars: { "coach@example.test": { busy: [{ start: "2030-01-01T10:00:00Z", end: "2030-01-01T11:00:00Z" }] } } }), { status: 200 });
      if (init.method === "DELETE") return new Response(null, { status: 410 });
      if (init.method === "PUT" && (init.headers as Record<string, string>)["If-Match"] === '"stale"') return new Response("precondition", { status: 412 });
      return new Response(JSON.stringify({ id: "abc", etag: '"1"' }), { status: 200 });
    }) as unknown as typeof fetch;
    const g = new GoogleCalendarProvider({ getAccessToken: async () => "tok", fetchImpl });
    const ev = { teamworkSessionId: "s1", summary: "Private Session", start: new Date("2030-01-01T15:00:00Z"), end: new Date("2030-01-01T16:00:00Z"), timezone: TZ };
    expect(await g.pushEvent("coach@example.test", ev)).toEqual({ externalEventId: "abc", etag: '"1"' });
    expect(seen[0].url).toBe("https://www.googleapis.com/calendar/v3/calendars/coach%40example.test/events");
    expect(seen[0].headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(seen[0].body!).extendedProperties.private.teamworkSessionId).toBe("s1");
    await expect(g.updateEvent("coach@example.test", "abc", ev, '"stale"')).rejects.toBeInstanceOf(CalendarConflictError);
    await g.deleteEvent("coach@example.test", "abc"); // 410 Gone counts as deleted
    const busy = await g.freeBusy("coach@example.test", new Date("2030-01-01T00:00:00Z"), new Date("2030-01-02T00:00:00Z"));
    expect(busy).toEqual([{ start: new Date("2030-01-01T10:00:00Z"), end: new Date("2030-01-01T11:00:00Z") }]);
    expect(toGoogleEvent(ev).start).toEqual({ dateTime: "2030-01-01T15:00:00.000Z", timeZone: TZ });
  });

  it("pushes session copies through the job queue, overwrites external edits, deletes on cancel, and imports free/busy", async () => {
    const d = db();
    const erin = await viewerFor(ctx, "erin");
    const [conn] = await d.insert(calendarConnections).values({ orgId: ctx.orgId, userId: ctx.users.tess, externalCalendarId: "tess@example.test", status: "connected", syncDirection: "both" }).returning();
    const fake = fakeProvider();
    const run = () => d.transaction((tx) => runJobs(tx, calendarJobHandlers(tx, async () => fake), "test-worker", 50));

    const s = await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(addDaysYmd(todayLocal(TZ), 12), "13:00", TZ), coachUserId: ctx.users.tess }));
    await run();
    let [link] = await d.select().from(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, conn.id), eq(calendarEventLinks.sessionId, s.id)));
    expect(link.status).toBe("synced");
    expect(link.externalEventId).toBeTruthy();

    // External edit → conflict → Teamwork overwrites (source of truth).
    fake.failNextConflict();
    await d.transaction((tx) => updateSession(tx, erin, { sessionId: s.id, version: s.version, title: "Renamed" }));
    await run();
    [link] = await d.select().from(calendarEventLinks).where(eq(calendarEventLinks.id, link.id));
    expect(link.status).toBe("synced");
    expect(fake.calls).toContain("update-force");
    expect(fake.events.get(link.externalEventId!)?.summary).toBe("Renamed");

    // Cancelled → deleted from Google.
    await d.transaction((tx) => cancelSession(tx, erin, { sessionId: s.id, reason: "Test" }));
    await run();
    [link] = await d.select().from(calendarEventLinks).where(eq(calendarEventLinks.id, link.id));
    expect(link.status).toBe("deleted");
    expect(fake.events.size).toBe(0);

    // Free/busy import replaces imported blocks idempotently.
    await d.transaction((tx) => syncFreeBusy(tx, fake, { connectionId: conn.id, from: new Date("2030-01-07T00:00:00Z"), to: new Date("2030-01-08T00:00:00Z") }));
    await d.transaction((tx) => syncFreeBusy(tx, fake, { connectionId: conn.id, from: new Date("2030-01-07T00:00:00Z"), to: new Date("2030-01-08T00:00:00Z") }));
    const blocks = await d.select().from(busyBlocks).where(and(eq(busyBlocks.coachUserId, ctx.users.tess), eq(busyBlocks.source, "google_freebusy")));
    expect(blocks).toHaveLength(1);
    await d.transaction((tx) => importFreeBusy(tx, { orgId: ctx.orgId, coachUserId: ctx.users.tess, from: new Date("2030-01-07T00:00:00Z"), to: new Date("2030-01-08T00:00:00Z"), busy: [] }));
    expect(await d.select().from(busyBlocks).where(and(eq(busyBlocks.coachUserId, ctx.users.tess), eq(busyBlocks.source, "google_freebusy")))).toHaveLength(0);
  });

  it("without credentials the job records an honest not-configured error and does not retry forever", async () => {
    const d = db();
    const erin = await viewerFor(ctx, "erin");
    const [conn] = await d.insert(calendarConnections).values({ orgId: ctx.orgId, userId: ctx.users.marcus, externalCalendarId: "marcus@example.test", status: "connected" }).returning();
    const s = await d.transaction((tx) => createSession(tx, erin, { serviceTypeId: ctx.extra.scheduling.private, startsAt: localToUtc(addDaysYmd(todayLocal(TZ), 13), "13:00", TZ), coachUserId: ctx.users.marcus }));
    const res = await d.transaction((tx) => runJobs(tx, calendarJobHandlers(tx), "test-worker", 50));
    expect(res.find((r) => r.type === "calendar.sync_session")?.status).toBe("done");
    const [link] = await d.select().from(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, conn.id), eq(calendarEventLinks.sessionId, s.id)));
    expect(link.status).toBe("error");
    expect(link.lastError).toMatch(/not configured/);
    const pending = await d.select().from(jobs).where(and(eq(jobs.type, "calendar.sync_session"), eq(jobs.status, "pending")));
    expect(pending).toHaveLength(0);
  });
});
