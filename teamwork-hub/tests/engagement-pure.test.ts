import { describe, expect, it } from "vitest";
import { ageOn } from "@/lib/engagement/access";
import { BADGES, badgeDef, evaluateBadges, type BadgeStats } from "@/lib/engagement/badges";
import { goalProgress } from "@/lib/engagement/goals";
import { countdown } from "@/lib/engagement/home";
import { levelFor, levelThreshold } from "@/lib/engagement/levels";
import { detectPrs } from "@/lib/engagement/prs";
import { DEFAULT_XP, engagementSettingsOf } from "@/lib/engagement/settings";
import { computeStreak, isHoldWeek, weekStartOf } from "@/lib/engagement/streaks";
import { addDaysYmd } from "@/lib/time";

const TZ = "America/Indiana/Indianapolis";
/** Mondays counted back from 2026-06-01 (a Monday). */
const wk = (n: number) => addDaysYmd("2026-06-01", -7 * n);

describe("weekStartOf (facility-local ISO weeks)", () => {
  it("uses Monday as the first day and Sunday as the last", () => {
    expect(weekStartOf("2026-06-01")).toBe("2026-06-01"); // Monday
    expect(weekStartOf("2026-06-07")).toBe("2026-06-01"); // Sunday
    expect(weekStartOf("2026-06-08")).toBe("2026-06-08");
  });

  it("assigns instants by facility-local date, not UTC date", () => {
    // Sunday 11:30 PM local is already Monday in UTC; it still belongs to the week that is ending.
    expect(weekStartOf(new Date("2026-06-08T03:30:00Z"), TZ)).toBe("2026-06-01");
    // Monday 12:15 AM local.
    expect(weekStartOf(new Date("2026-06-08T04:15:00Z"), TZ)).toBe("2026-06-08");
  });

  it("is correct across the spring-forward week (2026-03-08, UTC-5 → UTC-4)", () => {
    expect(weekStartOf(new Date("2026-03-08T04:30:00Z"), TZ)).toBe("2026-03-02"); // Sat Mar 7, 11:30 PM EST
    expect(weekStartOf(new Date("2026-03-09T03:30:00Z"), TZ)).toBe("2026-03-02"); // Sun 11:30 PM EDT
    expect(weekStartOf(new Date("2026-03-09T04:15:00Z"), TZ)).toBe("2026-03-09"); // Mon 12:15 AM EDT
  });

  it("is correct across the fall-back week (2026-11-01, UTC-4 → UTC-5)", () => {
    expect(weekStartOf(new Date("2026-11-02T04:30:00Z"), TZ)).toBe("2026-10-26"); // Sun 11:30 PM EST
    expect(weekStartOf(new Date("2026-11-02T05:30:00Z"), TZ)).toBe("2026-11-02"); // Mon 12:30 AM EST
    // The repeated 1 AM hour on the Sunday stays in the same week both times.
    expect(weekStartOf(new Date("2026-11-01T05:30:00Z"), TZ)).toBe("2026-10-26");
    expect(weekStartOf(new Date("2026-11-01T06:30:00Z"), TZ)).toBe("2026-10-26");
  });

  it("keeps a week together across a year boundary", () => {
    expect(weekStartOf("2026-12-31")).toBe("2026-12-28");
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28");
    expect(weekStartOf("2027-01-04")).toBe("2027-01-04");
  });
});

describe("computeStreak", () => {
  const today = "2026-06-03"; // Wednesday of week wk(0)

  it("is zero with no activity", () => {
    expect(computeStreak({ activeDates: [], today })).toMatchObject({ current: 0, best: 0, thisWeekActive: false });
  });

  it("counts consecutive active weeks, one or many activities per week", () => {
    const r = computeStreak({ activeDates: [wk(2), addDaysYmd(wk(2), 3), addDaysYmd(wk(1), 6), wk(0)], today });
    expect(r).toMatchObject({ current: 3, best: 3, thisWeekActive: true });
  });

  it("the week in progress never breaks the streak", () => {
    const r = computeStreak({ activeDates: [wk(3), wk(2), wk(1)], today });
    expect(r).toMatchObject({ current: 3, best: 3, thisWeekActive: false });
    expect(r.recent.at(-1)).toEqual({ weekStart: wk(0), state: "open" });
  });

  it("a missed week resets the current streak but keeps the best", () => {
    const r = computeStreak({ activeDates: [wk(8), wk(7), wk(6), wk(5), /* wk(4) missed */ wk(3), wk(2), wk(1)], today });
    expect(r).toMatchObject({ current: 3, best: 4 });
    expect(computeStreak({ activeDates: [wk(5), wk(4)], today })).toMatchObject({ current: 0, best: 2 });
  });

  it("hold weeks are skipped: they neither add to nor break the streak", () => {
    const holds = [{ start: addDaysYmd(wk(4), 2), end: addDaysYmd(wk(3), 4) }]; // touches weeks 4 and 3
    const r = computeStreak({ activeDates: [wk(6), wk(5), wk(2), wk(1)], holds, today });
    expect(r).toMatchObject({ current: 4, best: 4 });
    expect(r.recent.map((w) => w.state)).toEqual(["active", "hold", "hold", "active", "active", "open"]);
    // Without the hold the same history is a broken streak.
    expect(computeStreak({ activeDates: [wk(6), wk(5), wk(2), wk(1)], today })).toMatchObject({ current: 2, best: 2 });
  });

  it("training during a hold week still counts", () => {
    const holds = [{ start: wk(3), end: addDaysYmd(wk(3), 6) }];
    expect(computeStreak({ activeDates: [wk(4), wk(3), wk(2), wk(1)], holds, today })).toMatchObject({ current: 4, best: 4 });
  });

  it("a hold only covers the weeks it touches", () => {
    const holds = [{ start: wk(3), end: addDaysYmd(wk(3), 6) }];
    expect(isHoldWeek(wk(3), holds)).toBe(true);
    expect(isHoldWeek(wk(4), holds)).toBe(false);
    expect(isHoldWeek(wk(2), holds)).toBe(false);
    // Week 4 is a plain miss, so the streak restarts after the hold.
    expect(computeStreak({ activeDates: [wk(5), wk(2), wk(1)], holds, today })).toMatchObject({ current: 2, best: 2 });
  });

  it("a long hold right up to today keeps the streak alive", () => {
    const holds = [{ start: wk(3), end: addDaysYmd(wk(0), 6) }];
    expect(computeStreak({ activeDates: [wk(5), wk(4)], holds, today })).toMatchObject({ current: 2, best: 2 });
  });

  it("ignores activity dated after today's week and reports milestone weeks", () => {
    const r = computeStreak({ activeDates: [wk(4), wk(3), wk(2), wk(1), wk(0), wk(-1)], today, milestones: [4, 12] });
    expect(r.current).toBe(5);
    expect(r.reached).toEqual({ 4: wk(1) });
  });

  it("streaks run straight through both DST changes", () => {
    // Sessions late Sunday night local time in consecutive weeks around spring-forward.
    const instants = ["2026-03-02T04:30:00Z" /* Sun Mar 1, 11:30 PM EST */, "2026-03-09T03:30:00Z" /* Sun Mar 8, 11:30 PM EDT */, "2026-03-16T03:30:00Z" /* Sun Mar 15 */];
    const local = instants.map((i) => weekStartOf(new Date(i), TZ));
    expect(local).toEqual(["2026-02-23", "2026-03-02", "2026-03-09"]);
    expect(computeStreak({ activeDates: local, today: "2026-03-15" })).toMatchObject({ current: 3, best: 3 });
  });
});

describe("levels (tw_levels_v1)", () => {
  it("threshold(n) = 50·n·(n−1)", () => {
    expect([1, 2, 3, 4, 5, 6].map(levelThreshold)).toEqual([0, 100, 300, 600, 1000, 1500]);
  });
  it("levelFor reports level, progress and XP to the next level", () => {
    expect(levelFor(0)).toMatchObject({ level: 1, title: "Rookie", into: 0, span: 100, toNext: 100, pct: 0 });
    expect(levelFor(99)).toMatchObject({ level: 1, toNext: 1, pct: 99 });
    expect(levelFor(100)).toMatchObject({ level: 2, into: 0, span: 200, toNext: 200 });
    expect(levelFor(690)).toMatchObject({ level: 4, into: 90, span: 400, toNext: 310, pct: 22 });
    expect(levelFor(-5).level).toBe(1);
    expect(levelFor(1_000_000).title).toBe("Legend");
  });
});

describe("detectPrs", () => {
  const row = (id: string, value: number, recordedOn: string, extra: Partial<{ unit: string; kind: string; exerciseId: string }> = {}) => ({ id, exerciseId: "squat", value, unit: "lb", kind: "tested", recordedOn, ...extra });
  it("the first max is the starting point; only improvements are PRs", () => {
    const prs = detectPrs([row("a", 200, "2026-01-01"), row("b", 195, "2026-02-01"), row("c", 210, "2026-03-01"), row("d", 210, "2026-04-01"), row("e", 215, "2026-05-01")]);
    expect(prs.map((p) => p.maxId)).toEqual(["c", "e"]);
    expect(prs[0]).toMatchObject({ previous: 200, value: 210 });
  });
  it("compares lb and kg exactly and never mixes tested with estimated maxes", () => {
    // 100 kg = 220.46 lb: a PR over 200 lb. 90 kg = 198.4 lb: not a PR.
    expect(detectPrs([row("a", 200, "2026-01-01"), row("b", 90, "2026-02-01", { unit: "kg" }), row("c", 100, "2026-03-01", { unit: "kg" })]).map((p) => p.maxId)).toEqual(["c"]);
    // A high estimate neither is a PR over a tested max nor raises the bar for tested maxes.
    const prs = detectPrs([row("a", 200, "2026-01-01"), row("est", 260, "2026-02-01", { kind: "estimated" }), row("b", 205, "2026-03-01")]);
    expect(prs.map((p) => p.maxId)).toEqual(["b"]);
  });
  it("ignores non-mass units and keeps exercises separate", () => {
    expect(detectPrs([row("a", 10, "2026-01-01", { unit: "reps" }), row("b", 12, "2026-02-01", { unit: "reps" })])).toEqual([]);
    expect(detectPrs([row("a", 200, "2026-01-01"), row("b", 300, "2026-02-01", { exerciseId: "deadlift" })])).toEqual([]);
  });
});

describe("evaluateBadges", () => {
  const d = (n: number) => new Date(Date.UTC(2026, 0, n, 12));
  const empty: BadgeStats = { sessionTimes: [], earlyBirdTimes: [], streakReached: {}, prTimes: [], goalTimes: [], formsCompleteAt: null, anniversaryAt: null };
  it("awards nothing for an empty history", () => {
    expect(evaluateBadges(empty)).toEqual([]);
  });
  it("dates each badge to the moment its rule was first met", () => {
    const sessions = Array.from({ length: 26 }, (_, i) => d(i + 1));
    const got = evaluateBadges({ ...empty, sessionTimes: sessions, earlyBirdTimes: sessions.slice(0, 5), streakReached: { 4: d(28) }, prTimes: [d(3)], goalTimes: [d(9)], formsCompleteAt: d(2), anniversaryAt: d(30) });
    const at = Object.fromEntries(got.map((b) => [b.key, b.earnedAt.toISOString().slice(0, 10)]));
    expect(at).toEqual({
      first_session_v1: "2026-01-01",
      sessions_10_v1: "2026-01-10",
      sessions_25_v1: "2026-01-25",
      streak_4_v1: "2026-01-28",
      first_pr_v1: "2026-01-03",
      goal_first_v1: "2026-01-09",
      early_bird_v1: "2026-01-05",
      all_forms_signed_v1: "2026-01-02",
      one_year_member_v1: "2026-01-30",
    });
  });
  it("needs five early sessions and five PRs for those badges", () => {
    const keys = evaluateBadges({ ...empty, earlyBirdTimes: [d(1), d(2), d(3), d(4)], prTimes: [d(1), d(2), d(3), d(4)] }).map((b) => b.key);
    expect(keys).toEqual(["first_pr_v1"]);
  });
  it("the catalog has unique, versioned keys with a name and description", () => {
    expect(new Set(BADGES.map((b) => b.key)).size).toBe(BADGES.length);
    for (const b of BADGES) {
      expect(b.key).toMatch(/_v\d+$/);
      expect(b.name.length).toBeGreaterThan(2);
      expect(b.description).not.toMatch(/—/);
    }
    for (const k of ["first_session_v1", "sessions_10_v1", "sessions_25_v1", "sessions_50_v1", "sessions_100_v1", "streak_4_v1", "streak_12_v1", "streak_26_v1", "streak_52_v1", "first_pr_v1", "pr_5_v1", "goal_first_v1", "early_bird_v1", "all_forms_signed_v1", "one_year_member_v1"]) {
      expect(badgeDef(k), k).not.toBeNull();
    }
  });
});

describe("goalProgress", () => {
  it("measures the share of the way from the starting value to the target", () => {
    expect(goalProgress({ baseline: 200, current: 215, target: 230, direction: "increase" })).toEqual({ pct: 50, met: false });
    expect(goalProgress({ baseline: 2.0, current: 1.95, target: 1.9, direction: "decrease" })).toEqual({ pct: 50, met: false });
  });
  it("is met at or past the target, in the right direction only", () => {
    expect(goalProgress({ baseline: 200, current: 230, target: 230, direction: "increase" })).toEqual({ pct: 100, met: true });
    expect(goalProgress({ baseline: null, current: 1.85, target: 1.9, direction: "decrease" })).toEqual({ pct: 100, met: true });
    expect(goalProgress({ baseline: 2.0, current: 2.1, target: 1.9, direction: "decrease" })).toEqual({ pct: 0, met: false });
  });
  it("gives no percentage when it cannot be stated honestly", () => {
    expect(goalProgress({ baseline: 200, current: null, target: 230, direction: "increase" })).toEqual({ pct: null, met: false });
    expect(goalProgress({ baseline: null, current: 210, target: 230, direction: "increase" })).toEqual({ pct: null, met: false });
    expect(goalProgress({ baseline: 240, current: 210, target: 230, direction: "increase" })).toEqual({ pct: null, met: false });
    // Never shows 100 before the target is actually met.
    expect(goalProgress({ baseline: 200, current: 229.9, target: 230, direction: "increase" }).pct).toBe(99);
  });
});

describe("small helpers", () => {
  it("countdown reads naturally", () => {
    const now = new Date("2026-06-03T14:00:00Z");
    expect(countdown(new Date("2026-06-03T14:20:00Z"), now, "2026-06-03", "2026-06-03")).toBe("in 20 minutes");
    expect(countdown(new Date("2026-06-03T17:10:00Z"), now, "2026-06-03", "2026-06-03")).toBe("in 3 hours");
    expect(countdown(new Date("2026-06-04T10:00:00Z"), now, "2026-06-04", "2026-06-03")).toBe("tomorrow");
    expect(countdown(new Date("2026-06-08T10:00:00Z"), now, "2026-06-08", "2026-06-03")).toBe("in 5 days");
    expect(countdown(new Date("2026-06-03T13:50:00Z"), now, "2026-06-03", "2026-06-03")).toBe("happening now");
  });
  it("ageOn handles birthdays not yet reached this year", () => {
    expect(ageOn("2013-06-04", "2026-06-03")).toBe(12);
    expect(ageOn("2013-06-03", "2026-06-03")).toBe(13);
    expect(ageOn(null, "2026-06-03")).toBeNull();
  });
  it("engagement settings fall back to defaults and ignore bad values", () => {
    expect(engagementSettingsOf(null)).toEqual({ levelsEnabled: true, badgesEnabled: true, xp: DEFAULT_XP });
    const s = engagementSettingsOf({ engagement: { badgesEnabled: false, xp: { session_attended: 30, pr_set: -4, form_signed: "9" } } });
    expect(s.badgesEnabled).toBe(false);
    expect(s.levelsEnabled).toBe(true);
    expect(s.xp).toEqual({ ...DEFAULT_XP, session_attended: 30 });
  });
});
