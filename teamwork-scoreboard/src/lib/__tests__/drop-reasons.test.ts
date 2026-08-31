import { describe, it, expect } from "vitest";
import { classifyDropReason } from "../importer";

const CATEGORIES = {
  expected: ["distance too far", "moved", "relocat", "college", "graduat", "season ended", "military", "injur"],
  controllable: ["administrative drop", "no contact", "stopped attending", "not attending", "dissatisf", "too expensive", "cost", "schedule"],
};

describe("classifyDropReason — Teamwork's drop-reason rules", () => {
  it('treats "Distance Too Far" as expected (moved away or left for college)', () => {
    expect(classifyDropReason("Distance Too Far", "", CATEGORIES)).toBe("expected");
    expect(classifyDropReason("distance too far", "Moved out of state", CATEGORIES)).toBe("expected");
  });

  it('treats "Administrative Drop" as controllable (they ghosted us)', () => {
    expect(classifyDropReason("Administrative Drop", "", CATEGORIES)).toBe("controllable");
    expect(classifyDropReason("ADMINISTRATIVE DROP", "No contact", CATEGORIES)).toBe("controllable");
  });

  it("matches on the sub-reason too, not just the main reason", () => {
    expect(classifyDropReason("Other", "Going to college", CATEGORIES)).toBe("expected");
    expect(classifyDropReason("Other", "Stopped attending", CATEGORIES)).toBe("controllable");
  });

  it("is case-insensitive and tolerates partial words", () => {
    expect(classifyDropReason("Graduated high school", "", CATEGORIES)).toBe("expected");
    expect(classifyDropReason("Relocating for work", "", CATEGORIES)).toBe("expected");
    expect(classifyDropReason("Dissatisfied with coaching", "", CATEGORIES)).toBe("controllable");
  });

  it("puts controllable ahead of expected when both could match", () => {
    // A reason mentioning both should count against us, not excuse us.
    expect(classifyDropReason("Moved", "Too expensive anyway", CATEGORIES)).toBe("controllable");
  });

  it("files anything unrecognized as 'other' rather than guessing", () => {
    expect(classifyDropReason("Deceased", "", CATEGORIES)).toBe("other");
    expect(classifyDropReason("", "", CATEGORIES)).toBe("other");
  });
});
