import { describe, it, expect } from "vitest";
import { templateDueOn } from "../tasks";

const mon = new Date("2026-07-06T10:00:00"); // Monday
const wed = new Date("2026-07-08T10:00:00");
const first = new Date("2026-07-01T10:00:00"); // July 1 (Q3 start month)
const feb28 = new Date("2026-02-28T10:00:00");

describe("templateDueOn — recurring checklist generation", () => {
  it("daily is due every day", () => {
    expect(templateDueOn({ recurrence: "daily", dayOfWeek: null, dayOfMonth: null }, mon)).toBe(true);
    expect(templateDueOn({ recurrence: "daily", dayOfWeek: null, dayOfMonth: null }, wed)).toBe(true);
  });
  it("weekly matches its ISO day (default Monday)", () => {
    expect(templateDueOn({ recurrence: "weekly", dayOfWeek: 1, dayOfMonth: null }, mon)).toBe(true);
    expect(templateDueOn({ recurrence: "weekly", dayOfWeek: 1, dayOfMonth: null }, wed)).toBe(false);
    expect(templateDueOn({ recurrence: "weekly", dayOfWeek: null, dayOfMonth: null }, mon)).toBe(true);
    expect(templateDueOn({ recurrence: "weekly", dayOfWeek: 3, dayOfMonth: null }, wed)).toBe(true);
  });
  it("monthly matches day of month (default 1st)", () => {
    expect(templateDueOn({ recurrence: "monthly", dayOfWeek: null, dayOfMonth: 1 }, first)).toBe(true);
    expect(templateDueOn({ recurrence: "monthly", dayOfWeek: null, dayOfMonth: 8 }, wed)).toBe(true);
    expect(templateDueOn({ recurrence: "monthly", dayOfWeek: null, dayOfMonth: 9 }, wed)).toBe(false);
  });
  it("clamps day-of-month to short months (Feb 28 covers day 30)", () => {
    expect(templateDueOn({ recurrence: "monthly", dayOfWeek: null, dayOfMonth: 30 }, feb28)).toBe(true);
  });
  it("quarterly fires only in Jan/Apr/Jul/Oct", () => {
    expect(templateDueOn({ recurrence: "quarterly", dayOfWeek: null, dayOfMonth: 1 }, first)).toBe(true);
    const aug1 = new Date("2026-08-01T10:00:00");
    expect(templateDueOn({ recurrence: "quarterly", dayOfWeek: null, dayOfMonth: 1 }, aug1)).toBe(false);
  });
  it("once/unknown never auto-generates", () => {
    expect(templateDueOn({ recurrence: "once", dayOfWeek: null, dayOfMonth: null }, mon)).toBe(false);
  });
});
