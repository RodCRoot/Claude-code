import { describe, expect, it } from "vitest";
import { orderPanels } from "@/lib/community/board";
import { challengeProgress, challengeValue } from "@/lib/community/challenges";
import { ageBandOf, isMinor, publicName, type RosterEntry } from "@/lib/community/display-name";
import { rankBoard, type RankEntry } from "@/lib/community/leaderboards";
import { communitySettingsOf, DEFAULT_COMMUNITY_SETTINGS } from "@/lib/community/settings";
import { ordinal, type BoardPanel } from "@/lib/community/shared";
import { cleanNote } from "@/lib/community/shoutouts";
import { activeWeeksInWindow, bestMaxes, countInWindow, improvements, measuredPrs, type MeasuredMax } from "@/lib/community/stats";

const maya = { firstName: "Maya", preferredName: null, lastName: "Parker" };

describe("publicName (the one display-name resolver)", () => {
  it("first name and last initial by default mode", () => {
    expect(publicName(maya, "first_last_initial")).toBe("Maya P.");
  });
  it("first name only", () => {
    expect(publicName(maya, "first_name_only")).toBe("Maya");
  });
  it("hidden resolves to null so callers drop the athlete", () => {
    expect(publicName(maya, "hidden")).toBeNull();
  });
  it("uses the preferred name, and only its first word", () => {
    expect(publicName({ firstName: "Margaret", preferredName: "Maggie Mae", lastName: "o'neil" }, "first_last_initial")).toBe("Maggie O.");
  });
  it("never returns the full last name in any mode", () => {
    for (const mode of ["first_last_initial", "first_name_only", "hidden"] as const) expect(publicName(maya, mode) ?? "").not.toContain("Parker");
  });
  it("an empty last name gives the first name alone", () => {
    expect(publicName({ firstName: "Sam", lastName: " " }, "first_last_initial")).toBe("Sam");
  });
});

describe("age bands", () => {
  const today = "2026-03-02";
  it("derives the band from the date of birth", () => {
    expect(ageBandOf("2015-01-01", today)).toBe("U12"); // 11
    expect(ageBandOf("2014-03-02", today)).toBe("U14"); // 12 today
    expect(ageBandOf("2014-03-03", today)).toBe("U12"); // 12 tomorrow
    expect(ageBandOf("2012-03-03", today)).toBe("U14"); // 13
    expect(ageBandOf("2011-06-01", today)).toBe("U16"); // 14
    expect(ageBandOf("2009-01-01", today)).toBe("U18"); // 17
    expect(ageBandOf("2008-03-02", today)).toBe("Adult"); // 18 today
    expect(ageBandOf("1980-01-01", today)).toBe("Adult");
  });
  it("no birthday on file means no band (never guessed) and is treated as a minor", () => {
    expect(ageBandOf(null, today)).toBeNull();
    expect(isMinor(null, today)).toBe(true);
    expect(isMinor("2008-03-03", today)).toBe(true);
    expect(isMinor("2008-03-02", today)).toBe(false);
  });
});

const e = (id: string, score: number, name: string | null): RankEntry => ({ athleteId: id, score, name, firstName: id.toUpperCase(), value: String(score) });

describe("rankBoard", () => {
  it("hidden athletes are never in the rows, on any board size", () => {
    const r = rankBoard([e("a", 9, "A"), e("h", 8, null), e("b", 7, "B"), e("c", 6, "C"), e("d", 5, "D"), e("f", 4, "F")], new Set());
    expect(r.rows.map((x) => x.name)).toEqual(["A", "B", "C", "D", "F"]);
    expect(JSON.stringify(r)).not.toContain('"H"');
  });
  it("five or more visible: true ranks (a hidden athlete leaves a gap) and the full count", () => {
    const r = rankBoard([e("a", 9, "A"), e("h", 8, null), e("b", 7, "B"), e("c", 6, "C"), e("d", 5, "D"), e("f", 4, "F")], new Set(["h", "c"]));
    expect(r.small).toBe(false);
    expect(r.total).toBe(6);
    expect(r.rows.map((x) => x.rank)).toEqual([1, 3, 4, 5, 6]);
    expect(r.you).toEqual([
      { athleteId: "h", firstName: "H", rank: 2, of: 6, hidden: true, value: "8" },
      { athleteId: "c", firstName: "C", rank: 4, of: 6, hidden: false, value: "6" },
    ]);
    expect(r.rows.find((x) => x.name === "C")?.you).toBe(true);
  });
  it("fewer than five visible: ranks count visible athletes only and totals are withheld", () => {
    const r = rankBoard([e("h1", 10, null), e("a", 9, "A"), e("h2", 8, null), e("b", 7, "B"), e("c", 6, "C")], new Set(["b"]));
    expect(r.small).toBe(true);
    expect(r.total).toBeNull();
    expect(r.rows.map((x) => [x.rank, x.name])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
    // The visible viewer's own line agrees with the board and gives no total.
    expect(r.you).toEqual([{ athleteId: "b", firstName: "B", rank: 2, of: null, hidden: false, value: "7" }]);
  });
  it("a hidden viewer on a small board sees a rank among visible athletes plus themselves, never other hidden athletes", () => {
    const r = rankBoard([e("h1", 10, null), e("a", 9, "A"), e("me", 8, null), e("b", 7, "B")], new Set(["me"]));
    expect(r.you).toEqual([{ athleteId: "me", firstName: "ME", rank: 2, of: null, hidden: true, value: "8" }]);
  });
  it("ties share a rank", () => {
    const r = rankBoard([e("a", 5, "A"), e("b", 5, "B"), e("c", 4, "C"), e("d", 3, "D"), e("f", 3, "F")], new Set());
    expect(r.rows.map((x) => x.rank)).toEqual([1, 1, 3, 4, 4]);
  });
  it("a value marked not public is withheld from rows but kept for the viewer's own line", () => {
    const r = rankBoard([{ ...e("a", 2, "A"), value: "1.8x", publicValue: false }], new Set(["a"]));
    expect(r.rows[0].value).toBeNull();
    expect(r.you[0].value).toBe("1.8x");
  });
  it("respects the row limit without changing the count", () => {
    const many = Array.from({ length: 14 }, (_, i) => e(`a${i}`, 100 - i, `N${i}`));
    const r = rankBoard(many, new Set(), { limit: 5 });
    expect(r.rows).toHaveLength(5);
    expect(r.total).toBe(14);
  });
});

const max = (id: string, exerciseId: string, value: number, recordedOn: string, kind = "tested", unit = "lb"): MeasuredMax => ({ id, athleteId: "a1", exerciseId, value, unit, kind, recordedOn, createdAt: null });

describe("maxes: measured only, comparable only", () => {
  it("bestMaxes ignores estimated maxes and compares kg with lb exactly", () => {
    const best = bestMaxes([max("1", "squat", 200, "2026-01-01"), max("2", "squat", 500, "2026-02-01", "estimated"), max("3", "squat", 100, "2026-02-10", "manual", "kg")]);
    expect(best.get("squat")).toMatchObject({ value: 100, unit: "kg" }); // 100 kg = 220.5 lb > 200 lb
    expect(best.size).toBe(1);
  });
  it("measuredPrs never reports an estimated max", () => {
    const prs = measuredPrs([max("1", "squat", 200, "2026-01-01"), max("2", "squat", 500, "2026-02-01", "estimated"), max("3", "squat", 210, "2026-02-10")]);
    expect(prs.map((p) => p.maxId)).toEqual(["3"]);
    expect(prs[0].previous).toBe(200);
  });
  it("improvement: baseline before the 90-day window, latest inside it", () => {
    const out = improvements([max("1", "squat", 200, "2025-10-01"), max("2", "squat", 230, "2026-02-20")], "2026-03-02");
    expect(out).toHaveLength(1);
    expect(Math.round(out[0].pct)).toBe(15);
  });
  it("improvement: both inside the window uses the first as the baseline", () => {
    const out = improvements([max("1", "bench", 100, "2026-01-05"), max("2", "bench", 105, "2026-01-20"), max("3", "bench", 120, "2026-02-25")], "2026-03-02");
    expect(Math.round(out[0].pct)).toBe(20);
  });
  it("no improvement entry: a single max, a same-week retest, a drop, an old latest, or estimates only", () => {
    const today = "2026-03-02";
    expect(improvements([max("1", "squat", 200, "2026-02-01")], today)).toEqual([]);
    expect(improvements([max("1", "squat", 200, "2026-02-20"), max("2", "squat", 220, "2026-02-22")], today)).toEqual([]);
    expect(improvements([max("1", "squat", 220, "2026-01-01"), max("2", "squat", 200, "2026-02-22")], today)).toEqual([]);
    expect(improvements([max("1", "squat", 100, "2025-01-01"), max("2", "squat", 200, "2025-06-01")], today)).toEqual([]);
    expect(improvements([max("1", "squat", 100, "2026-01-01", "estimated"), max("2", "squat", 200, "2026-02-22", "estimated")], today)).toEqual([]);
  });
  it("improvement mixes lb and kg only by exact conversion", () => {
    const out = improvements([max("1", "squat", 220.462, "2026-01-01", "tested", "lb"), max("2", "squat", 110, "2026-02-22", "tested", "kg")], "2026-03-02");
    expect(Math.round(out[0].pct)).toBe(10);
  });
});

describe("challenge counting (facility-local dates, inclusive window)", () => {
  it("counts dates on both edges and nothing outside", () => {
    expect(countInWindow(["2026-10-31", "2026-11-01", "2026-11-15", "2026-11-30", "2026-12-01"], "2026-11-01", "2026-11-30")).toBe(3);
  });
  it("active weeks are distinct Monday-start weeks", () => {
    // Nov 2 2026 is a Monday.
    expect(activeWeeksInWindow(["2026-11-02", "2026-11-08", "2026-11-09", "2026-11-25", "2026-12-01"], "2026-11-01", "2026-11-30")).toBe(3);
  });
  it("metric picks the right source", () => {
    const a = { attended: ["2026-11-03", "2026-11-04"], workouts: ["2026-11-10"], onYourOwn: ["2026-11-20"] };
    expect(challengeValue("attendance", a, "2026-11-01", "2026-11-30")).toBe(2);
    expect(challengeValue("workouts", a, "2026-11-01", "2026-11-30")).toBe(1);
    expect(challengeValue("streak_weeks", a, "2026-11-01", "2026-11-30")).toBe(3);
    expect(challengeValue("attendance", undefined, "2026-11-01", "2026-11-30")).toBe(0);
  });
  it("individual: finishers reached the target; team total: contributors finish once the total is met", () => {
    const r = (id: string, groupIds: string[] = []): RosterEntry => ({ athleteId: id, displayName: id, firstName: id, mode: "first_last_initial", band: "U16", groupIds, bodyMassKg: null });
    const roster = new Map([r("a", ["g"]), r("b", ["g"]), r("c", [])].map((x) => [x.athleteId, x]));
    const activity = new Map([
      ["a", { attended: ["2026-11-03", "2026-11-04", "2026-11-05"], workouts: [], onYourOwn: [] }],
      ["b", { attended: ["2026-11-03"], workouts: [], onYourOwn: [] }],
      ["c", { attended: ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"], workouts: [], onYourOwn: [] }],
    ]);
    const base = { metric: "attendance" as const, startsOn: "2026-11-01", endsOn: "2026-11-30" };
    const ind = challengeProgress({ ...base, mode: "individual", target: 3, groupId: null }, roster, activity);
    expect(ind.finishers.sort()).toEqual(["a", "c"]);
    expect(ind.total).toBe(8);
    const team = challengeProgress({ ...base, mode: "group_total", target: 4, groupId: "g" }, roster, activity);
    expect(team.total).toBe(4); // c is not in the group
    expect(team.met).toBe(true);
    expect(team.finishers.sort()).toEqual(["a", "b"]);
    const notYet = challengeProgress({ ...base, mode: "group_total", target: 5, groupId: "g" }, roster, activity);
    expect(notYet.finishers).toEqual([]);
  });
});

describe("settings and small helpers", () => {
  it("defaults when nothing is stored; bad values fall back", () => {
    expect(communitySettingsOf(null)).toEqual(DEFAULT_COMMUNITY_SETTINGS);
    const s = communitySettingsOf({ community: { enabled: false, defaultDisplayMode: "full_name", rotationSeconds: 1, shoutoutDailyLimit: 9999, panels: { pr_bell: false, bogus: false }, orgMessage: "  " } });
    expect(s.enabled).toBe(false);
    expect(s.defaultDisplayMode).toBe("first_last_initial");
    expect(s.rotationSeconds).toBe(DEFAULT_COMMUNITY_SETTINGS.rotationSeconds);
    expect(s.shoutoutDailyLimit).toBe(DEFAULT_COMMUNITY_SETTINGS.shoutoutDailyLimit);
    expect(s.panels.pr_bell).toBe(false);
    expect(s.panels.streaks).toBe(true);
    expect(s.orgMessage).toBeNull();
  });
  it("cleanNote flattens to one plain line", () => {
    expect(cleanNote("  Great\n\twork \u0007today  ")).toBe("Great work today");
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote(42)).toBeNull();
  });
  it("ordinal", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "103rd"]);
  });
  it("orderPanels spreads leaderboards between the other panels and keeps every panel", () => {
    const lb = (n: number): BoardPanel => ({ key: "leaderboards", title: `L${n}`, board: { title: `L${n}`, label: "", cohort: "U16", rows: [] } });
    const msg: BoardPanel = { key: "message", title: "m", text: "hi" };
    const streaks: BoardPanel = { key: "streaks", title: "s", items: [] };
    const out = orderPanels([msg, streaks, lb(1), lb(2), lb(3), lb(4), lb(5)]);
    expect(out).toHaveLength(7);
    expect(out.map((p) => p.key)).toEqual(["message", "leaderboards", "leaderboards", "leaderboards", "streaks", "leaderboards", "leaderboards"]);
  });
});
