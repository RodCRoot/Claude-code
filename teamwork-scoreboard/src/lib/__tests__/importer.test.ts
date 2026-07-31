import { describe, it, expect } from "vitest";
import { parseCsv, normalizeDate } from "../importer";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const { headers, rows } = parseCsv("Name,Date\nAvery Cole,2026-07-01\nBlake Reed,2026-07-02");
    expect(headers).toEqual(["Name", "Date"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe("Avery Cole");
  });
  it("handles quoted fields and skips empty lines", () => {
    const { rows } = parseCsv('Name,Note\n"Cole, Avery","said ""hi"""\n\n');
    expect(rows[0].Name).toBe("Cole, Avery");
    expect(rows[0].Note).toBe('said "hi"');
  });
});

describe("normalizeDate — import date tolerance", () => {
  it("passes ISO through", () => {
    expect(normalizeDate("2026-07-04")).toBe("2026-07-04");
    expect(normalizeDate("2026-07-04T10:30:00Z")).toBe("2026-07-04");
  });
  it("converts US m/d/y formats", () => {
    expect(normalizeDate("7/4/2026")).toBe("2026-07-04");
    expect(normalizeDate("07/04/26")).toBe("2026-07-04");
    expect(normalizeDate("7-4-2026")).toBe("2026-07-04");
  });
  it("rejects garbage", () => {
    expect(normalizeDate("not a date")).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});
