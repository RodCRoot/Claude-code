import { describe, it, expect } from "vitest";
import { normalizeAttendanceStatus } from "../importer";

/**
 * Teamwork's Zen Planner attendance report includes RSVP'd, attended AND
 * cancelled rows in one export. Only real check-ins may become attendance —
 * counting reservations would inflate session utilization and mask at-risk
 * athletes (the whole point of the retention half of the scoreboard).
 */
describe("normalizeAttendanceStatus", () => {
  it("counts real check-ins as attended", () => {
    expect(normalizeAttendanceStatus("Attended")).toBe("attended");
    expect(normalizeAttendanceStatus("attended")).toBe("attended");
    expect(normalizeAttendanceStatus("Checked In")).toBe("attended");
    expect(normalizeAttendanceStatus("checked-in")).toBe("attended");
    expect(normalizeAttendanceStatus("Present")).toBe("attended");
  });

  it("counts absences as no-shows", () => {
    expect(normalizeAttendanceStatus("No Show")).toBe("no_show");
    expect(normalizeAttendanceStatus("no_show")).toBe("no_show");
    expect(normalizeAttendanceStatus("noshow")).toBe("no_show");
    expect(normalizeAttendanceStatus("Absent")).toBe("no_show");
  });

  it("SKIPS reservations and cancellations — they are not attendance", () => {
    expect(normalizeAttendanceStatus("RSVP")).toBeNull();
    expect(normalizeAttendanceStatus("RSVP'd")).toBeNull();
    expect(normalizeAttendanceStatus("Reserved")).toBeNull();
    expect(normalizeAttendanceStatus("Registered")).toBeNull();
    expect(normalizeAttendanceStatus("Cancelled")).toBeNull();
    expect(normalizeAttendanceStatus("Canceled")).toBeNull();
    expect(normalizeAttendanceStatus("Late Cancel")).toBeNull();
    expect(normalizeAttendanceStatus("Waitlist")).toBeNull();
  });

  it("treats a blank status as attendance (report with no status column)", () => {
    expect(normalizeAttendanceStatus("")).toBe("attended");
    expect(normalizeAttendanceStatus("   ")).toBe("attended");
  });

  it("skips anything unrecognized rather than guessing it was attendance", () => {
    // Better to under-count than to invent check-ins that never happened.
    expect(normalizeAttendanceStatus("Some New ZP Status")).toBeNull();
  });
});
