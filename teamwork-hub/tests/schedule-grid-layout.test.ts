import { describe, expect, it } from "vitest";
import { daySpan, hourWindow, localMinutes, packColumns, shortTime, spanToPercent } from "@/app/(app)/schedule/_components/grid-layout";
import { localToUtc } from "@/lib/time";

const TZ = "America/Indiana/Indianapolis";

describe("calendar grid layout", () => {
  it("positions by facility wall-clock time, including DST transition days", () => {
    // Spring forward (2026-03-08) and fall back (2026-11-01): a 6 PM class is still on the 6 PM row.
    for (const ymd of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-10-31", "2026-11-01", "2026-11-02"]) {
      const s = localToUtc(ymd, "18:00", TZ);
      const e = localToUtc(ymd, "19:30", TZ);
      expect(localMinutes(s, TZ)).toBe(18 * 60);
      expect(daySpan(s, e, ymd, TZ)).toEqual({ start: 1080, end: 1170 });
    }
    // A morning class right after the spring-forward gap.
    const s = localToUtc("2026-03-08", "06:00", TZ);
    expect(daySpan(s, new Date(s.getTime() + 3600_000), "2026-03-08", TZ)).toEqual({ start: 360, end: 420 });
  });

  it("uses elapsed time when the wall-clock end is not after the start (fall-back hour)", () => {
    // 1:30 AM EDT + 60 min = 1:30 AM EST on 2026-11-01.
    const s = new Date("2026-11-01T05:30:00Z");
    const e = new Date("2026-11-01T06:30:00Z");
    expect(localMinutes(s, TZ)).toBe(90);
    expect(localMinutes(e, TZ)).toBe(90);
    expect(daySpan(s, e, "2026-11-01", TZ)).toEqual({ start: 90, end: 150 });
  });

  it("clips sessions that cross midnight to the day being drawn", () => {
    const s = localToUtc("2026-10-12", "23:00", TZ);
    const e = localToUtc("2026-10-13", "01:00", TZ);
    expect(daySpan(s, e, "2026-10-12", TZ)).toEqual({ start: 1380, end: 1440 });
    expect(daySpan(s, e, "2026-10-13", TZ)).toEqual({ start: 0, end: 60 });
  });

  it("widens the default hour window to fit every session", () => {
    expect(hourWindow([])).toEqual([6, 21]);
    expect(hourWindow([{ start: 330, end: 400 }, { start: 1260, end: 1335 }])).toEqual([5, 23]);
    expect(hourWindow([{ start: 1380, end: 1440 }])).toEqual([6, 24]);
  });

  it("packs overlapping sessions side by side and leaves touching ones full width", () => {
    const m = packColumns([
      { id: "a", start: 360, end: 420 },
      { id: "b", start: 390, end: 450 },
      { id: "c", start: 420, end: 480 }, // starts when a ends: reuses column 0
      { id: "d", start: 480, end: 540 }, // touches c only: new cluster
    ]);
    expect(m.get("a")).toEqual({ col: 0, cols: 2 });
    expect(m.get("b")).toEqual({ col: 1, cols: 2 });
    expect(m.get("c")).toEqual({ col: 0, cols: 2 });
    expect(m.get("d")).toEqual({ col: 0, cols: 1 });
  });

  it("handles three-way overlaps and identical times deterministically", () => {
    const m = packColumns([
      { id: "z", start: 600, end: 660 },
      { id: "y", start: 600, end: 660 },
      { id: "x", start: 630, end: 700 },
    ]);
    expect([m.get("y")!.col, m.get("z")!.col, m.get("x")!.col]).toEqual([0, 1, 2]);
    expect(new Set([...m.values()].map((v) => v.cols))).toEqual(new Set([3]));
  });

  it("converts spans to percentages and formats short times", () => {
    expect(spanToPercent({ start: 360, end: 420 }, [6, 10])).toEqual({ top: 0, height: 25 });
    expect(spanToPercent({ start: 300, end: 420 }, [6, 10])).toEqual({ top: 0, height: 25 });
    expect(shortTime(360)).toBe("6a");
    expect(shortTime(750)).toBe("12:30p");
    expect(shortTime(0)).toBe("12a");
    expect(shortTime(1110)).toBe("6:30p");
  });
});
