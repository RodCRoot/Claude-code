import { describe, it, expect } from "vitest";
import {
  safeDiv,
  safePct,
  goalAttainment,
  statusFor,
  goalDiff,
  pctChange,
  average,
  formatValue,
} from "../calc";

describe("safeDiv / safePct — division-by-zero safety", () => {
  it("divides normally", () => {
    expect(safeDiv(10, 4)).toBe(2.5);
    expect(safePct(3, 4)).toBe(75);
  });
  it("returns null on zero denominator instead of Infinity/NaN", () => {
    expect(safeDiv(5, 0)).toBeNull();
    expect(safePct(0, 0)).toBeNull();
  });
  it("returns null on non-finite input", () => {
    expect(safeDiv(NaN, 2)).toBeNull();
    expect(safeDiv(2, Infinity)).toBeNull();
  });
});

describe("goalAttainment", () => {
  it("higher-is-better: actual/goal", () => {
    expect(goalAttainment(8, 10, "up")).toBe(80);
    expect(goalAttainment(12, 10, "up")).toBe(120);
  });
  it("zero goal handled safely", () => {
    expect(goalAttainment(0, 0, "up")).toBe(100);
    expect(goalAttainment(5, 0, "up")).toBeNull();
  });
  it("lower-is-better inverts: goal/actual", () => {
    // goal 60 min response time, actual 30 min → 200% (capped)
    expect(goalAttainment(30, 60, "down")).toBe(200);
    // actual 120 min vs goal 60 → 50%
    expect(goalAttainment(120, 60, "down")).toBe(50);
    // perfect zero on lower-is-better is a full win
    expect(goalAttainment(0, 2, "down")).toBe(200);
  });
  it("null actual or goal → null", () => {
    expect(goalAttainment(null, 10)).toBeNull();
    expect(goalAttainment(5, null)).toBeNull();
  });
});

describe("statusFor — red/yellow/green thresholds", () => {
  it("uses default thresholds 70/90", () => {
    expect(statusFor(95)).toBe("green");
    expect(statusFor(90)).toBe("green");
    expect(statusFor(89.9)).toBe("yellow");
    expect(statusFor(70)).toBe("yellow");
    expect(statusFor(69.9)).toBe("red");
  });
  it("respects configurable thresholds", () => {
    expect(statusFor(50, 40, 60)).toBe("yellow");
    expect(statusFor(39, 40, 60)).toBe("red");
    expect(statusFor(60, 40, 60)).toBe("green");
  });
  it("no data → none", () => {
    expect(statusFor(null)).toBe("none");
  });
});

describe("goalDiff", () => {
  it("positive = ahead for higher-is-better", () => {
    expect(goalDiff(12, 10, "up")).toBe(2);
    expect(goalDiff(8, 10, "up")).toBe(-2);
  });
  it("inverts for lower-is-better", () => {
    expect(goalDiff(4, 6, "down")).toBe(2); // 4 no-shows vs 6 allowed → ahead by 2
  });
});

describe("pctChange", () => {
  it("computes % change vs previous", () => {
    expect(pctChange(110, 100)).toBe(10);
    expect(pctChange(90, 100)).toBe(-10);
  });
  it("null-safe", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(100, 0)).toBeNull();
  });
});

describe("average", () => {
  it("averages values", () => {
    expect(average([2, 4, 6])).toBe(4);
  });
  it("empty → null (not NaN)", () => {
    expect(average([])).toBeNull();
  });
});

describe("formatValue", () => {
  it("formats units", () => {
    expect(formatValue(72.35, "percent")).toBe("72.4%");
    expect(formatValue(1234.5, "currency")).toBe("$1,234.50");
    expect(formatValue(45, "minutes")).toBe("45m");
    expect(formatValue(150, "minutes")).toBe("2.5h");
    expect(formatValue(null, "count")).toBe("—");
  });
});
