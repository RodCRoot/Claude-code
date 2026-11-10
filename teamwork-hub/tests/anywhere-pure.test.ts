import { describe, expect, it } from "vitest";
import { assignmentProgress } from "@/lib/anywhere/assignments";
import { ageOn, anywhereSettingsOf } from "@/lib/anywhere/common";
import { ICS_MAX_BYTES, ICS_MAX_EVENTS, IcsError, cleanText, guessKind, parseIcs } from "@/lib/anywhere/ics";
import { weeklyLoadByOrigin } from "@/lib/anywhere/load-split";
import { eventOccurrences } from "@/lib/anywhere/season";
import { matchesFilter, normalizeEquipment } from "@/lib/anywhere/sessions";
import { xpCandidates, streakFromActivity, type Activity } from "@/lib/engagement/sync";
import { DEFAULT_XP, engagementSettingsOf } from "@/lib/engagement/settings";
import { loadOrigin } from "@/lib/science/load";
import { fmt } from "@/lib/time";

const TZ = "America/Indiana/Indianapolis";
const season = { tz: TZ, seasonStart: "2026-08-01", seasonEnd: "2026-11-30" };
const cal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const ev = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("ics parser", () => {
  it("reads one-off and weekly events, converts UTC and TZID times to facility time, clips to the season", () => {
    const r = parseIcs(
      cal(
        ev("UID:a1", "SUMMARY:Game vs Sample Opponent", "DTSTART:20260905T230000Z", "DTEND:20260906T003000Z", "LOCATION:Sample Field\\, north lot"),
        ev("UID:a2", "SUMMARY:Team practice", "DTSTART;TZID=America/Chicago:20260901T153000", "DURATION:PT1H30M", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261015T000000Z"),
        ev("UID:a3", "SUMMARY:Fall tournament", "DTSTART;VALUE=DATE:20261010"),
        ev("UID:a4", "SUMMARY:Next year", "DTSTART:20270301T100000"),
      ),
      season,
    );
    expect(r.events.map((e) => e.uid)).toEqual(["a2", "a1", "a3"]);
    const [practice, game, tourney] = r.events;
    // 23:00Z on Sep 5 is 7:00 PM Eastern (EDT).
    expect(game).toMatchObject({ kind: "game", startsOn: "2026-09-05", startTimeLocal: "19:00", durationMinutes: 90, location: "Sample Field, north lot", weekdays: null });
    // 3:30 PM Central is 4:30 PM in Indianapolis.
    expect(practice).toMatchObject({ kind: "practice", weekdays: [2, 4], startsOn: "2026-09-01", endsOn: "2026-10-14", startTimeLocal: "16:30", durationMinutes: 90 });
    expect(tourney).toMatchObject({ kind: "tournament", startTimeLocal: null, durationMinutes: null });
    expect(r.skipped).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/outside the season/);
  });

  it("handles folded lines, COUNT, cancelled events, duplicate UIDs and missing UIDs", () => {
    const r = parseIcs(
      cal(
        ev("UID:f1", "SUMMARY:Practice at the", "  sample gym", "DTSTART:20260907T160000", "RRULE:FREQ=WEEKLY;COUNT=3"),
        ev("UID:f1", "SUMMARY:Duplicate", "DTSTART:20260908T160000"),
        ev("UID:c1", "SUMMARY:Cancelled game", "DTSTART:20260909T160000", "STATUS:CANCELLED"),
        ev("SUMMARY:No uid game", "DTSTART:20260910T160000"),
        ev("UID:m1", "SUMMARY:Monthly", "DTSTART:20260911T160000", "RRULE:FREQ=MONTHLY"),
      ),
      season,
    );
    const f1 = r.events.find((e) => e.uid === "f1")!;
    expect(f1.title).toBe("Practice at the sample gym");
    expect(f1).toMatchObject({ weekdays: [1], startsOn: "2026-09-07", endsOn: "2026-09-21" });
    expect(r.events.filter((e) => e.uid === "f1")).toHaveLength(1);
    expect(r.events.some((e) => e.uid === "c1")).toBe(false);
    const noUid = r.events.find((e) => e.title === "No uid game")!;
    expect(noUid.uid).toMatch(/^no-uid-/);
    // Same content gives the same synthetic UID, so re-importing stays idempotent.
    expect(parseIcs(cal(ev("SUMMARY:No uid game", "DTSTART:20260910T160000")), season).events[0].uid).toBe(noUid.uid);
    expect(r.events.find((e) => e.uid === "m1")).toMatchObject({ weekdays: null, startsOn: "2026-09-11", endsOn: "2026-09-11" });
    expect(r.warnings.join(" ")).toMatch(/only weekly/);
  });

  it("ignores alarms, attachments, URLs and descriptions, and cuts text to a safe length", () => {
    const r = parseIcs(
      cal(
        ev(
          "UID:x1",
          `SUMMARY:${"A".repeat(500)}`,
          "DTSTART:20260912T100000",
          "URL:https://example.test/remote.ics",
          "ATTACH:https://example.test/payload",
          "DESCRIPTION:<script>alert(1)</script>",
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "SUMMARY:alarm text must not replace the title",
          "DTSTART:20260101T000000",
          "END:VALARM",
        ),
      ),
      season,
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0].title).toHaveLength(120);
    expect(r.events[0].startsOn).toBe("2026-09-12");
    expect(JSON.stringify(r.events)).not.toMatch(/example\.test|script|alarm/);
    expect(cleanText("a\\nb\\, c\u0007 \t d")).toBe("a b, c d");
  });

  it("rejects input that is not a calendar, is truncated, is too large or has too many events", () => {
    expect(() => parseIcs("<html>not a calendar</html>", season)).toThrow(IcsError);
    expect(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260901T100000", season)).toThrow(/cut off/);
    expect(() => parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VTODO\r\nEND:VCALENDAR", season)).toThrow(/damaged/);
    expect(() => parseIcs(cal("X-PAD:" + "x".repeat(ICS_MAX_BYTES)), season)).toThrow(/too large/);
    const many = Array.from({ length: ICS_MAX_EVENTS + 1 }, (_, i) => ev(`UID:n${i}`, "DTSTART:20260901T100000"));
    expect(() => parseIcs(cal(...many), season)).toThrow(/more than 200 events/);
    // Bad dates are skipped with a warning, not imported as something else.
    const bad = parseIcs(cal(ev("UID:b1", "DTSTART:20261340T990000"), ev("UID:b2", "DTSTART:garbage")), season);
    expect(bad.events).toEqual([]);
    expect(bad.skipped).toBe(2);
  });

  it("an unknown TZID falls back to facility time with a warning", () => {
    const r = parseIcs(cal(ev("UID:t1", "SUMMARY:Practice", "DTSTART;TZID=Custom Zone:20260915T160000")), season);
    expect(r.events[0].startTimeLocal).toBe("16:00");
    expect(r.warnings.join(" ")).toMatch(/not recognized/);
  });

  it("guesses the kind from the title only", () => {
    expect(guessKind("Varsity practice")).toBe("practice");
    expect(guessKind("Sample Invitational Tournament")).toBe("tournament");
    expect(guessKind("vs Sample Opponent")).toBe("game");
    expect(guessKind(null)).toBe("game");
  });
});

describe("season occurrences", () => {
  const base = { id: "e", seasonId: "s", kind: "practice" as const, title: null, opponent: null, location: null, timezone: TZ, skipDates: [] as string[] };

  it("a weekly 4:00 PM practice stays 4:00 PM local across both DST changes", () => {
    const fall = eventOccurrences({ ...base, weekdays: [7], startsOn: "2026-10-25", endsOn: "2026-11-08", startTimeLocal: "16:00", durationMinutes: 90 }, "2026-10-01", "2026-11-30");
    expect(fall.map((o) => o.date)).toEqual(["2026-10-25", "2026-11-01", "2026-11-08"]);
    expect(fall.map((o) => fmt(o.startsAt, "HH:mm", TZ))).toEqual(["16:00", "16:00", "16:00"]);
    // UTC offset moves from -4 to -5 on Nov 1, 2026.
    expect(fall.map((o) => o.startsAt!.toISOString().slice(11, 16))).toEqual(["20:00", "21:00", "21:00"]);
    const spring = eventOccurrences({ ...base, weekdays: [7], startsOn: "2026-03-01", endsOn: "2026-03-15", startTimeLocal: "16:00", durationMinutes: 60 }, "2026-03-01", "2026-03-31");
    expect(spring.map((o) => o.startsAt!.toISOString().slice(11, 16))).toEqual(["21:00", "20:00", "20:00"]);
    expect(spring[1].endsAt!.getTime() - spring[1].startsAt!.getTime()).toBe(3_600_000);
  });

  it("one-off, all-day and skipped days", () => {
    const one = eventOccurrences({ ...base, kind: "game", weekdays: null, startsOn: "2026-09-12", endsOn: "2026-09-12", startTimeLocal: null, durationMinutes: null }, "2026-09-01", "2026-09-30");
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ date: "2026-09-12", startsAt: null, endsAt: null, weekly: false });
    const weekly = eventOccurrences({ ...base, weekdays: [2, 4], startsOn: "2026-09-01", endsOn: "2026-09-30", startTimeLocal: null, durationMinutes: null, skipDates: ["2026-09-08"] }, "2026-09-07", "2026-09-13");
    expect(weekly.map((o) => o.date)).toEqual(["2026-09-10"]);
    expect(eventOccurrences({ ...base, weekdays: null, startsOn: "2026-09-12", endsOn: "2026-09-12", startTimeLocal: "10:00", durationMinutes: null }, "2026-09-13", "2026-09-30")).toEqual([]);
  });
});

describe("library filter, equipment, age, settings", () => {
  const s = (durationMinutes: number, equipment: ("none" | "band" | "ball" | "field")[]) => ({ durationMinutes, equipment, category: "mobility" as const });
  it("filters by time available and by what the athlete has", () => {
    expect(matchesFilter(s(10, ["none"]), { maxMinutes: 10 })).toBe(true);
    expect(matchesFilter(s(15, ["none"]), { maxMinutes: 10 })).toBe(false);
    expect(matchesFilter(s(10, ["band"]), { equipment: "none" })).toBe(false);
    expect(matchesFilter(s(10, ["none"]), { equipment: "band" })).toBe(true);
    expect(matchesFilter(s(10, ["band"]), { equipment: "band" })).toBe(true);
    expect(matchesFilter(s(10, ["band", "field"]), { equipment: "band" })).toBe(false);
    expect(matchesFilter(s(10, ["none"]), { category: "core" })).toBe(false);
  });
  it("normalizes equipment, computes age, and defaults the In Season link to off", () => {
    expect(normalizeEquipment([])).toEqual(["none"]);
    expect(normalizeEquipment(["none", "field", "band"])).toEqual(["band", "field"]);
    expect(ageOn("2013-11-11", "2026-11-10")).toBe(12);
    expect(ageOn("2013-11-10", "2026-11-10")).toBe(13);
    expect(ageOn(null, "2026-11-10")).toBeNull();
    expect(anywhereSettingsOf({})).toEqual({ showInSeasonOption: false });
    expect(anywhereSettingsOf({ anywhere: { showInSeasonOption: "yes" } })).toEqual({ showInSeasonOption: false });
    expect(anywhereSettingsOf({ anywhere: { showInSeasonOption: true } })).toEqual({ showInSeasonOption: true });
  });
  it("assignment progress counts only matching completions inside the window", () => {
    const a = { sessionId: null, category: "mobility" as const, startDate: "2026-11-09", endDate: "2026-11-15", targetCount: 2 };
    const c = (athleteId: string, category: "mobility" | "core", localDate: string, sessionId = "s1") => ({ athleteId, category, localDate, sessionId });
    expect(assignmentProgress(a, "m", [c("m", "mobility", "2026-11-09"), c("m", "core", "2026-11-10"), c("m", "mobility", "2026-11-08"), c("x", "mobility", "2026-11-10")])).toEqual({ done: 1, target: 2, complete: false });
    expect(assignmentProgress(a, "m", [c("m", "mobility", "2026-11-09"), c("m", "mobility", "2026-11-15"), c("m", "mobility", "2026-11-12")])).toEqual({ done: 2, target: 2, complete: true });
    expect(assignmentProgress({ ...a, sessionId: "s2", category: null, targetCount: 1 }, "m", [c("m", "mobility", "2026-11-09", "s1")])).toMatchObject({ done: 0, complete: false });
  });
});

describe("load origin split (load_origin_v1)", () => {
  it("classifies sources without touching the load math", () => {
    expect(loadOrigin({ source: "workout" })).toBe("gym");
    expect(loadOrigin({ source: "activity", kind: "training", activitySource: "teamwork" })).toBe("gym");
    expect(loadOrigin({ source: "activity", kind: "training", activitySource: "on_your_own" })).toBe("on_your_own");
    expect(loadOrigin({ source: "activity", kind: "practice", activitySource: "sport" })).toBe("sport");
    expect(loadOrigin({ source: "activity", kind: "game", activitySource: "teamwork" })).toBe("sport");
    expect(loadOrigin({ source: "activity", kind: "conditioning", activitySource: "teamwork" })).toBe("other");
  });
  it("weekly totals by origin add up; unknown loads and empty weeks are never zero-filled", () => {
    const weeks = weeklyLoadByOrigin(
      [
        { date: "2026-11-02", origin: "gym", load: 300 },
        { date: "2026-11-03", origin: "sport", load: 450 },
        { date: "2026-11-04", origin: "on_your_own", load: 40 },
        { date: "2026-11-05", origin: "sport", load: null },
        { date: "2026-11-06", origin: "other", load: 0, kind: "rest" },
        { date: "2026-11-17", origin: "other", load: 100 },
      ],
      "2026-11-02",
      "2026-11-22",
    );
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(weeks[0]).toMatchObject({ gym: 300, sport: 450, onYourOwn: 40, other: 0, total: 790, sessions: 4, unknownSessions: 1 });
    expect(weeks[1]).toMatchObject({ total: null, sessions: 0 });
    expect(weeks[2]).toMatchObject({ other: 100, total: 100 });
  });
});

describe("engagement: On Your Own as a streak and XP source", () => {
  const empty: Activity = { attended: [], workouts: [], onYourOwn: [], checkinDays: [], prs: [], holds: [], goalsAchieved: [], formsSigned: [] };
  it("a finished session makes the week active and earns its own, lower, XP kind", () => {
    const a: Activity = { ...empty, onYourOwn: [{ id: "c1", completedAt: new Date("2026-11-04T23:00:00Z"), localDate: "2026-11-04" }] };
    expect(streakFromActivity(empty, "2026-11-10").current).toBe(0);
    expect(streakFromActivity(a, "2026-11-10")).toMatchObject({ current: 1, thisWeekActive: false });
    expect(streakFromActivity({ ...a, onYourOwn: [...a.onYourOwn, { id: "c2", completedAt: new Date("2026-11-09T23:00:00Z"), localDate: "2026-11-09" }] }, "2026-11-10")).toMatchObject({ current: 2, thisWeekActive: true });
    expect(xpCandidates(a, "ath")).toEqual([{ kind: "on_your_own_completed", sourceType: "anywhere_completion", sourceId: "c1", key: "own:c1", occurredAt: a.onYourOwn[0].completedAt }]);
    expect(DEFAULT_XP.on_your_own_completed).toBeLessThan(DEFAULT_XP.session_attended);
    expect(DEFAULT_XP.on_your_own_completed).toBeLessThan(DEFAULT_XP.workout_completed);
    expect(engagementSettingsOf({ engagement: { xp: { on_your_own_completed: 7 } } }).xp.on_your_own_completed).toBe(7);
    expect(engagementSettingsOf({}).xp.on_your_own_completed).toBe(10);
  });
});
