/**
 * Parser for a pasted / CSV Zen Planner payroll time-clock report. The column layout is UNVERIFIED
 * (built from a description of the screen, not a real export), so every column index lives in
 * `ImportMapping` and can be changed in Payroll → Settings.
 *
 * Expected row: `Ddd, DD Mon YYYY | PayRateLabel | $XX.XX / hour | Time In | Time Out | X.XX hours | $XX.XX`
 * - cells separated by "|", TAB, or commas (CSV with quotes)
 * - Time Out may carry "+N day(s)" when the clock-out landed on a later day
 * - a row whose last cell is "Add" has no entry for that day
 */
import Papa from "papaparse";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { shiftHundredths } from "./calc";
import type { ImportMapping } from "./settings";

export type ParsedRow = {
  line: number;
  raw: string;
  status: "entry" | "no_entry" | "skipped" | "error";
  date?: string;
  clockIn?: Date;
  clockOut?: Date;
  plusDays?: number;
  rateLabel?: string;
  rateMinor?: number | null;
  listedHundredths?: number | null;
  listedAmountMinor?: number | null;
  recomputedHundredths?: number;
  warnings: string[];
  error?: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function splitCells(line: string): string[] {
  let cells: string[];
  if (line.includes("|")) {
    cells = line.split("|");
    if (cells.length && cells[0].trim() === "") cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  } else if (line.includes("\t")) {
    cells = line.split("\t");
  } else {
    cells = (Papa.parse<string[]>(line, { delimiter: "," }).data[0] as string[] | undefined) ?? [line];
  }
  return cells.map((c) => c.trim());
}

/** "Mon, 05 Oct 2026" / "Mon 5 Oct 2026" → "2026-10-05". */
export function parseZpDate(s: string): string | null {
  const m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  const day = Number(m[1]);
  if (mi < 0 || day < 1 || day > 31) return null;
  const ymd = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Reject impossible dates like 31 Feb.
  return addDaysYmd(ymd, 0) === ymd ? ymd : null;
}

/** "3:58 PM", "03:58:12 pm", "15:58" → "15:58" / "15:58:12"; plus "+N day(s)" anywhere in the cell. */
export function parseZpTime(s: string): { hm: string; plusDays: number } | null {
  const plus = /\+\s*(\d+)\s*days?/i.exec(s);
  const plusDays = plus ? Number(plus[1]) : 0;
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?/.exec(s.replace(/\+\s*\d+\s*days?/i, ""));
  if (!t) return null;
  let h = Number(t[1]);
  const min = Number(t[2]);
  const sec = t[3] ? Number(t[3]) : 0;
  const ap = t[4]?.replace(/\./g, "").toLowerCase();
  if (min > 59 || sec > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "am" && h === 12) h = 0;
    if (ap === "pm" && h !== 12) h += 12;
  } else if (h > 23) return null;
  const hm = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}${t[3] ? `:${String(sec).padStart(2, "0")}` : ""}`;
  return { hm, plusDays };
}

/** "$15.00 / hour" or "$49.05" → cents. */
export function parseZpMoney(s: string | undefined): number | null {
  if (!s) return null;
  const m = /\$?\s*(-?[\d,]+)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(whole)) return null;
  return whole * 100 + Number(((m[2] ?? "") + "00").slice(0, 2)) * (whole < 0 ? -1 : 1);
}

/** "3.27 hours" → 327. */
export function parseZpHours(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(\d+)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(((m[2] ?? "") + "00").slice(0, 2));
}

export function parseZenPlannerPayroll(text: string, mapping: ImportMapping, tz: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const cells = splitCells(raw);
    const date = parseZpDate(cells[mapping.dateCol] ?? "");
    if (!date) {
      out.push({ line, raw, status: "skipped", warnings: [], error: "No date in the date column (header or summary line)." });
      return;
    }
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty[nonEmpty.length - 1]?.toLowerCase() === mapping.noEntryMarker.toLowerCase()) {
      out.push({ line, raw, status: "no_entry", date, warnings: [] });
      return;
    }
    const tin = parseZpTime(cells[mapping.timeInCol] ?? "");
    const tout = parseZpTime(cells[mapping.timeOutCol] ?? "");
    if (!tin) {
      out.push({ line, raw, status: "error", date, warnings: [], error: "Couldn't read the Time In." });
      return;
    }
    if (!tout) {
      out.push({ line, raw, status: "error", date, warnings: [], error: "No Time Out — add this shift by hand with the real clock-out." });
      return;
    }
    const clockIn = localToUtc(addDaysYmd(date, tin.plusDays), tin.hm, tz);
    const plusDays = tout.plusDays;
    const clockOut = localToUtc(addDaysYmd(date, plusDays), tout.hm, tz);
    if (clockOut <= clockIn) {
      out.push({ line, raw, status: "error", date, warnings: [], error: "Time Out is not after Time In (missing a “+1 day”?)." });
      return;
    }
    const rateMinor = parseZpMoney(cells[mapping.rateCol]);
    const listedHundredths = parseZpHours(cells[mapping.hoursCol]);
    const listedAmountMinor = parseZpMoney(cells[mapping.amountCol]);
    const recomputed = shiftHundredths(clockOut.getTime() - clockIn.getTime(), "truncate_2dp");
    const warnings: string[] = [];
    // Times are shown to the minute, so allow 1 hundredth of drift from hidden seconds.
    if (listedHundredths != null && Math.abs(listedHundredths - recomputed) > 1) warnings.push(`Listed ${(listedHundredths / 100).toFixed(2)} h but the times give ${(recomputed / 100).toFixed(2)} h.`);
    if (listedHundredths != null && rateMinor != null && listedAmountMinor != null) {
      const expect = Math.round((listedHundredths * rateMinor) / 100);
      if (Math.abs(expect - listedAmountMinor) > 1) warnings.push(`Listed amount differs from hours × rate by ${((listedAmountMinor - expect) / 100).toFixed(2)}.`);
    }
    if (plusDays > 0) warnings.push(`Clock-out is +${plusDays} day${plusDays > 1 ? "s" : ""} — will be flagged as a runaway shift.`);
    out.push({
      line,
      raw,
      status: "entry",
      date,
      clockIn,
      clockOut,
      plusDays,
      rateLabel: cells[mapping.rateLabelCol] || undefined,
      rateMinor,
      listedHundredths,
      listedAmountMinor,
      recomputedHundredths: recomputed,
      warnings,
    });
  });
  return out;
}
