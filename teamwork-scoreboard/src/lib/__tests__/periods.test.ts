import { describe, it, expect } from "vitest";
import {
  resolvePeriod,
  previousPeriod,
  weekStartOf,
  scaleGoal,
  lastNWeekStarts,
} from "../periods";

const WED = new Date("2026-07-15T12:00:00"); // a Wednesday

describe("resolvePeriod", () => {
  it("weekly is Monday..Sunday", () => {
    const p = resolvePeriod("weekly", WED);
    expect(p.start).toBe("2026-07-13");
    expect(p.end).toBe("2026-07-19");
  });
  it("monthly covers the calendar month", () => {
    const p = resolvePeriod("monthly", WED);
    expect(p.start).toBe("2026-07-01");
    expect(p.end).toBe("2026-07-31");
  });
  it("quarterly and ytd", () => {
    expect(resolvePeriod("quarterly", WED).start).toBe("2026-07-01");
    expect(resolvePeriod("ytd", WED).start).toBe("2026-01-01");
  });
  it("custom passes through", () => {
    const p = resolvePeriod("custom", WED, { start: "2026-06-01", end: "2026-06-10" });
    expect(p.start).toBe("2026-06-01");
    expect(p.end).toBe("2026-06-10");
  });
});

describe("previousPeriod", () => {
  it("weekly steps back one week", () => {
    const p = previousPeriod(resolvePeriod("weekly", WED), WED);
    expect(p.start).toBe("2026-07-06");
  });
  it("custom steps back by its own length", () => {
    const p = previousPeriod(
      { kind: "custom", start: "2026-07-11", end: "2026-07-20", label: "" },
      WED
    );
    expect(p.start).toBe("2026-07-01");
    expect(p.end).toBe("2026-07-10");
  });
});

describe("weekStartOf", () => {
  it("returns the Monday of the week", () => {
    expect(weekStartOf("2026-07-15")).toBe("2026-07-13");
    expect(weekStartOf("2026-07-13")).toBe("2026-07-13");
    expect(weekStartOf("2026-07-19")).toBe("2026-07-13");
  });
});

describe("scaleGoal — weekly goals scale to longer periods", () => {
  const july = resolvePeriod("monthly", WED); // 31 days
  it("weekly goal scales to a month (~4.43x)", () => {
    const scaled = scaleGoal(10, "weekly", "flow", july);
    expect(scaled).toBeGreaterThan(42);
    expect(scaled).toBeLessThan(46);
  });
  it("weekly goal on a weekly view stays exact", () => {
    const week = resolvePeriod("weekly", WED);
    expect(scaleGoal(10, "weekly", "flow", week)).toBe(10);
  });
  it("monthly goal on a monthly view stays exact", () => {
    expect(scaleGoal(25000, "monthly", "flow", july)).toBe(25000);
  });
  it("stock metrics never scale", () => {
    expect(scaleGoal(120, "weekly", "stock", july)).toBe(120);
  });
  it("null goal passes through", () => {
    expect(scaleGoal(null, "weekly", "flow", july)).toBeNull();
  });
});

describe("lastNWeekStarts", () => {
  it("returns N Mondays, most recent last", () => {
    const weeks = lastNWeekStarts(3, WED);
    expect(weeks).toEqual(["2026-06-29", "2026-07-06", "2026-07-13"]);
  });
});
