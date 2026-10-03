import { describe, it, expect } from "vitest";
import {
  chooseReportTable,
  cleanReportRows,
  rowsToCsv,
  scoreTable,
  tablesToCsv,
} from "./zp-table";

/**
 * Shaped after the real thing: a Zen Planner report page nests the grid inside
 * layout tables, so the page yields several tables and only one is the report.
 */
const LAYOUT_SHELL: string[][] = [["Reports"], ["Attendance Detail"]];
const NAV_TABLE: string[][] = [["People", "Calendar", "Reports", "Financial"]];

const ATTENDANCE_GRID: string[][] = [
  ["Name", "Date", "Time", "Class", "Status"],
  ["Miller, Madde", "Sep 2, 2026", "4:00 PM", "HS Performance", "Attended"],
  ["King, Orien", "Sep 2, 2026", "4:00 PM", "HS Performance", "Reserved"],
  ["Hogue, Mary", "Sep 3, 2026", "5:00 PM", "Adult Training", "Attended"],
];

describe("scoreTable", () => {
  it("rejects single-column layout tables", () => {
    expect(scoreTable(LAYOUT_SHELL)).toBe(0);
  });

  it("scores a single-row table low but not zero, so an empty report is still a grid", () => {
    // Can't be zero: a report with a header and no rows looks exactly like
    // this, and that needs to read as "empty", not "wrong URL".
    expect(scoreTable(NAV_TABLE)).toBe(4);
    expect(scoreTable(NAV_TABLE)).toBeLessThan(scoreTable(ATTENDANCE_GRID));
  });

  it("scores a real grid by rows times columns", () => {
    expect(scoreTable(ATTENDANCE_GRID)).toBe(4 * 5);
  });

  it("rejects a grid whose rows are all blank", () => {
    expect(scoreTable([["", ""], ["", ""], ["", ""]])).toBe(0);
  });
});

describe("chooseReportTable", () => {
  it("picks the grid out of a page of layout tables", () => {
    const chosen = chooseReportTable([LAYOUT_SHELL, NAV_TABLE, ATTENDANCE_GRID]);
    expect(chosen).toEqual(ATTENDANCE_GRID);
  });

  it("prefers the larger of two candidate grids", () => {
    const small = [
      ["Plan", "Count"],
      ["In Season", "12"],
    ];
    expect(chooseReportTable([small, ATTENDANCE_GRID])).toEqual(ATTENDANCE_GRID);
  });

  it("returns null when nothing is tabular", () => {
    expect(chooseReportTable([LAYOUT_SHELL, [["just one cell"]]])).toBeNull();
  });

  it("returns null for a page with no tables at all", () => {
    expect(chooseReportTable([])).toBeNull();
  });
});

describe("cleanReportRows", () => {
  it("drops the full-width action and pager rows Zen Planner appends", () => {
    const withFurniture: string[][] = [
      ...ATTENDANCE_GRID,
      ["Add"], // single-cell action row
      ["Showing 1-3 of 3"], // pager
    ];
    expect(cleanReportRows(withFurniture)).toEqual(ATTENDANCE_GRID);
  });

  it("drops a header reprinted on a later page", () => {
    const paginated: string[][] = [
      ATTENDANCE_GRID[0],
      ATTENDANCE_GRID[1],
      ATTENDANCE_GRID[0], // grid reprints the header when it paginates
      ATTENDANCE_GRID[2],
    ];
    expect(cleanReportRows(paginated)).toEqual([
      ATTENDANCE_GRID[0],
      ATTENDANCE_GRID[1],
      ATTENDANCE_GRID[2],
    ]);
  });

  it("keeps a data row that merely repeats values, unlike a repeated header", () => {
    const twins: string[][] = [
      ["Name", "Date"],
      ["Miller, Madde", "Sep 2, 2026"],
      ["Miller, Madde", "Sep 2, 2026"],
    ];
    // Two identical check-ins are a dedupe question for the importer, not
    // something to silently drop here.
    expect(cleanReportRows(twins)).toHaveLength(3);
  });

  it("skips entirely blank rows", () => {
    const spaced: string[][] = [
      ["Name", "Date"],
      ["", ""],
      ["Hogue, Mary", "Sep 3, 2026"],
    ];
    expect(cleanReportRows(spaced)).toEqual([
      ["Name", "Date"],
      ["Hogue, Mary", "Sep 3, 2026"],
    ]);
  });
});

describe("rowsToCsv", () => {
  it("quotes only fields that need it", () => {
    const csv = rowsToCsv([
      ["Name", "Note"],
      ["Miller, Madde", "plain"],
      ['He said "hi"', "line\nbreak"],
    ]);
    expect(csv).toBe(
      'Name,Note\n"Miller, Madde",plain\n"He said ""hi""","line\nbreak"'
    );
  });
});

describe("tablesToCsv", () => {
  it("turns a scraped page into importable CSV", () => {
    const result = tablesToCsv([LAYOUT_SHELL, NAV_TABLE, ATTENDANCE_GRID]);
    expect(result.headers).toEqual(["Name", "Date", "Time", "Class", "Status"]);
    expect(result.dataRows).toBe(3);
    expect(result.csv.split("\n")).toHaveLength(4);
    expect(result.csv).toContain('"Miller, Madde"');
  });

  it("explains itself when the page has no grid", () => {
    expect(() => tablesToCsv([LAYOUT_SHELL])).toThrow(/no report grid found/);
  });

  it("treats an empty report as empty, not as an error", () => {
    // "No cancellations this week" is a normal answer. Throwing here would put
    // a FAILED next to a healthy sync.
    const headerOnly = [
      ["Name", "Date", "Status"],
      ["Add"],
    ];
    const result = tablesToCsv([headerOnly]);
    expect(result.dataRows).toBe(0);
    expect(result.csv).toBe("");
    expect(result.headers).toEqual(["Name", "Date", "Status"]);
  });
});
