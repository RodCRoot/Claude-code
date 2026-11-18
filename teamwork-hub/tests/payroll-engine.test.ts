import { describe, expect, it } from "vitest";
import { applyDeduction, divRoundHalfUp, percentToBps, shiftHundredths, shiftPayMinor, sumTotals, totalsOf } from "@/lib/payroll/calc";
import { computePayroll, type EngineEntry, type EngineInput, type EmployeeResult } from "@/lib/payroll/engine";
import { DEFAULT_IMPORT_MAPPING, DEFAULT_PAYROLL_CONFIG } from "@/lib/payroll/settings";
import { parseZenPlannerPayroll, parseZpDate, parseZpTime } from "@/lib/payroll/zp-import";
import { addDaysYmd, DEFAULT_TZ, localToUtc } from "@/lib/time";

const TZ = DEFAULT_TZ;
const U = "user-a";
let n = 0;
function e(date: string, tin: string, tout: string | null, outDays = 0, ack: string[] = []): EngineEntry {
  return {
    id: `e${++n}`,
    userId: U,
    clockIn: localToUtc(date, tin, TZ),
    clockOut: tout ? localToUtc(addDaysYmd(date, outDays), tout, TZ) : null,
    source: "kiosk",
    ackCodes: ack,
  };
}
function run(entries: EngineEntry[], opts: Partial<EngineInput> & { from: string; to: string; nowLocal: [string, string] }): EmployeeResult {
  const res = computePayroll({
    from: opts.from,
    to: opts.to,
    now: localToUtc(opts.nowLocal[0], opts.nowLocal[1], TZ),
    tz: TZ,
    config: opts.config ?? DEFAULT_PAYROLL_CONFIG,
    staff: [{ userId: U, name: "Sample Staff A" }],
    rates: opts.rates ?? [{ userId: U, effectiveFrom: "2025-01-01", rateMinor: 1500, label: "Sample" }],
    entries,
  });
  return res.employees[0];
}
const flagsOf = (emp: EmployeeResult, date: string) => emp.rows.filter((r) => r.date === date).flatMap((r) => r.flags.map((f) => f.code));
/** Four weeks of Mon/Wed/Fri 15:30–19:30 (4 h) shifts ending before `before`. */
function regularHistory(before: string, weeks = 4): EngineEntry[] {
  const out: EngineEntry[] = [];
  for (let d = addDaysYmd(before, -7 * weeks); d < before; d = addDaysYmd(d, 1)) {
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    if (wd === 1 || wd === 3 || wd === 5) out.push(e(d, "15:30", "19:30"));
  }
  return out;
}

describe("rounding & money (integer cents)", () => {
  it("half-up integer division", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 2)).toBe(2);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(divRoundHalfUp(838_950, 1000)).toBe(839);
  });
  it("truncate_2dp matches Zen Planner; exact uses the real duration", () => {
    const ms = (3 * 3600 + 17 * 60 + 59) * 1000; // 3.2997 h
    expect(shiftHundredths(ms, "truncate_2dp")).toBe(329);
    expect(shiftHundredths(ms, "exact")).toBe(330);
    expect(shiftPayMinor(ms, 1500, "truncate_2dp")).toBe(4935); // 3.29 × $15.00
    expect(shiftPayMinor(ms, 1500, "exact")).toBe(4950); // 3.29972… × $15.00 = 49.4958 → 49.50
    expect(shiftPayMinor(ms, 1650, "truncate_2dp")).toBe(5429); // 3.29 × 16.50 = 54.285 → 54.29 (half-up)
    expect(shiftHundredths(0, "exact")).toBe(0);
  });
  it("deduction is a configurable basis-point percentage; deduction + net = gross exactly", () => {
    expect(applyDeduction(4935, 1700)).toEqual({ deductionMinor: 839, netMinor: 4096 });
    expect(applyDeduction(0, 1700)).toEqual({ deductionMinor: 0, netMinor: 0 });
    const t = totalsOf(1234, 123_457, 1750);
    expect(t.deductionMinor + t.netMinor).toBe(t.grossMinor);
    expect(t.deductionMinor).toBe(21_605); // 1234.57 × 17.5% = 216.05
    // Combined deduction is the sum of per-employee deductions (each rounded to the cent).
    const a = totalsOf(100, 1003, 1700);
    const b = totalsOf(100, 1003, 1700);
    expect(a.deductionMinor).toBe(171);
    expect(sumTotals([a, b])).toEqual({ hoursHundredths: 200, grossMinor: 2006, deductionMinor: 342, netMinor: 1664 });
  });
  it("percent input → basis points", () => {
    expect(percentToBps("17")).toBe(1700);
    expect(percentToBps("17.5%")).toBe(1750);
    expect(percentToBps("0")).toBe(0);
    expect(percentToBps("101")).toBeNull();
    expect(percentToBps("abc")).toBeNull();
  });
});

describe("abnormality detectors", () => {
  const from = "2026-02-23";
  const to = "2026-03-01";
  const now: [string, string] = ["2026-03-05", "12:00"];

  it("runaway: clock-out '+1 day' is excluded from totals and blocks approval until fixed or confirmed", () => {
    const hist = regularHistory(from);
    const runaway = e("2026-02-25", "15:32", "06:14", 1);
    const emp = run([...hist, e("2026-02-23", "15:30", "19:30"), runaway], { from, to, nowLocal: now });
    const row = emp.rows.find((r) => r.entryId === runaway.id)!;
    expect(row.plusDays).toBe(1);
    expect(row.flags.map((f) => f.code)).toContain("runaway");
    expect(row.flags[0].message).toMatch(/\+1 day/);
    expect(row.included).toBe(false);
    expect(emp.actual.hoursHundredths).toBe(400);
    expect(emp.actual.grossMinor).toBe(6000);
    expect(emp.blockingOpen).toBe(1);
    // Confirmed real → counted.
    const acked = run([...hist, e("2026-02-23", "15:30", "19:30"), { ...runaway, ackCodes: ["runaway"] }], { from, to, nowLocal: now });
    expect(acked.blockingOpen).toBe(0);
    expect(acked.rows.find((r) => r.entryId === runaway.id)!.included).toBe(true);
  });

  it("runaway: over the max hours, or far above the person's norm", () => {
    const hist = regularHistory(from);
    const long = e("2026-02-24", "07:00", "20:30"); // 13.5 h > 12
    const aboveNorm = e("2026-02-26", "08:00", "18:30"); // 10.5 h vs usual 4 h
    const ok = e("2026-02-27", "15:30", "21:00"); // 5.5 h — longer but not runaway
    const emp = run([...hist, long, aboveNorm, ok], { from, to, nowLocal: now });
    expect(flagsOf(emp, "2026-02-24")).toContain("runaway");
    expect(flagsOf(emp, "2026-02-26")).toContain("runaway");
    expect(flagsOf(emp, "2026-02-27")).not.toContain("runaway");
    expect(emp.norm.medianHundredths).toBe(400);
  });

  it("missed clock-out: an open entry from a past day blocks; an open entry today is 'on shift'", () => {
    const past = e("2026-02-26", "15:30", null);
    const emp = run([...regularHistory(from), past], { from, to, nowLocal: now });
    const row = emp.rows.find((r) => r.entryId === past.id)!;
    expect(row.flags.map((f) => f.code)).toEqual(["missed_clock_out"]);
    expect(row.included).toBe(false);
    expect(emp.blockingOpen).toBe(1);

    const today = e("2026-03-05", "09:00", null);
    const emp2 = run([...regularHistory(from), today], { from: "2026-03-02", to: "2026-03-08", nowLocal: ["2026-03-05", "10:00"] });
    const r2 = emp2.rows.find((r) => r.entryId === today.id)!;
    expect(r2.flags.map((f) => f.code)).toEqual(["on_shift"]);
    expect(emp2.blockingOpen).toBe(0);
  });

  it("tiny shift: included but flagged when the norm is several hours; not flagged when short shifts are normal", () => {
    const tiny = e("2026-02-25", "15:31", "15:43"); // 12 min
    const emp = run([...regularHistory(from), tiny], { from, to, nowLocal: now });
    const row = emp.rows.find((r) => r.entryId === tiny.id)!;
    expect(row.flags.map((f) => f.code)).toEqual(["tiny"]);
    expect(row.included).toBe(true);
    expect(row.hoursHundredths).toBe(20);
    expect(emp.actual.grossMinor).toBe(300); // 0.20 × $15
    expect(emp.blockingOpen).toBe(0);

    // Someone whose usual shift is 40 min: a 20-min shift is not "tiny".
    const shortHist: EngineEntry[] = [];
    for (let i = 1; i <= 8; i++) shortHist.push(e(addDaysYmd(from, -i), "07:00", "07:40"));
    const tiny2 = e("2026-02-25", "07:00", "07:20");
    const emp2 = run([...shortHist, tiny2], { from, to, nowLocal: now });
    expect(emp2.rows.find((r) => r.entryId === tiny2.id)!.flags).toEqual([]);
  });

  it("missing expected weekday: usually works that weekday but no entry; never-worked weekdays are not flagged", () => {
    // Mon/Wed/Fri history; in range only Mon and Fri worked.
    const emp = run([...regularHistory(from, 6), e("2026-02-23", "15:30", "19:30"), e("2026-02-27", "15:30", "19:30")], { from, to, nowLocal: now });
    const wed = emp.rows.find((r) => r.date === "2026-02-25")!;
    expect(wed.kind).toBe("missing");
    expect(wed.flags.map((f) => f.code)).toEqual(["missing_expected_day"]);
    expect(emp.rows.find((r) => r.date === "2026-02-26")!.kind).toBe("none"); // Thursday: never works
    expect(emp.blockingOpen).toBe(0);
  });

  it("off-pattern start time", () => {
    const odd = e("2026-02-25", "10:00", "14:00");
    const emp = run([...regularHistory(from), odd], { from, to, nowLocal: now });
    expect(flagsOf(emp, "2026-02-25")).toEqual(["off_pattern_start"]);
    expect(emp.rows.find((r) => r.entryId === odd.id)!.included).toBe(true);
  });

  it("orphan: a short odd-time entry the day after a runaway is excluded until confirmed or voided", () => {
    const runaway = e("2026-02-25", "15:32", "06:14", 1);
    const orphan = e("2026-02-26", "06:14", "06:19");
    const emp = run([...regularHistory(from), runaway, orphan], { from, to, nowLocal: now });
    const o = emp.rows.find((r) => r.entryId === orphan.id)!;
    expect(o.flags.map((f) => f.code)).toContain("orphan");
    expect(o.included).toBe(false);
    const rf = emp.rows.find((r) => r.entryId === runaway.id)!.flags.find((f) => f.code === "runaway")!;
    expect(rf.relatedEntryId).toBe(orphan.id);
    expect(rf.message).toMatch(/stray clock-out/);
    expect(emp.blockingOpen).toBe(2);
    const acked = run([...regularHistory(from), runaway, { ...orphan, ackCodes: ["orphan"] }], { from, to, nowLocal: now });
    expect(acked.rows.find((r) => r.entryId === orphan.id)!.included).toBe(true);
  });

  it("no pay rate: hours counted, pay unknown (null, not 0), approval blocked", () => {
    const emp = run([e("2026-02-23", "15:30", "19:30")], { from, to, nowLocal: now, rates: [] });
    const r = emp.rows.find((x) => x.kind === "entry")!;
    expect(r.payMinor).toBeNull();
    expect(r.flags.map((f) => f.code)).toEqual(["no_rate"]);
    expect(emp.incomplete).toBe(true);
    expect(emp.actual.hoursHundredths).toBe(400);
    expect(emp.blockingOpen).toBe(1);
  });

  it("rate history: each shift uses the rate effective on its local date", () => {
    const rates = [
      { userId: U, effectiveFrom: "2025-01-01", rateMinor: 1500, label: "Old" },
      { userId: U, effectiveFrom: "2026-02-25", rateMinor: 2000, label: "New" },
    ];
    const emp = run([e("2026-02-23", "15:30", "19:30"), e("2026-02-25", "15:30", "19:30")], { from, to, nowLocal: now, rates });
    expect(emp.rows.filter((r) => r.kind === "entry").map((r) => r.payMinor)).toEqual([6000, 8000]);
    expect(emp.actual.grossMinor).toBe(14_000);
    expect(emp.actual.deductionMinor).toBe(2380);
    expect(emp.actual.netMinor).toBe(11_620);
  });
});

describe("DST days (America/Indiana/Indianapolis)", () => {
  it("durations use real elapsed time across spring-forward and fall-back", () => {
    const spring = e("2026-03-08", "01:00", "05:00"); // clocks skip 2→3 AM: 3 real hours
    const fall = e("2026-11-01", "00:30", "02:30"); // 1–2 AM repeats: 3 real hours
    const s = run([spring], { from: "2026-03-08", to: "2026-03-08", nowLocal: ["2026-03-10", "12:00"] });
    expect(s.rows[0].durationMs).toBe(3 * 3_600_000);
    expect(s.actual.hoursHundredths).toBe(300);
    expect(s.actual.grossMinor).toBe(4500);
    const f = run([fall], { from: "2026-11-01", to: "2026-11-01", nowLocal: ["2026-11-03", "12:00"] });
    expect(f.actual.hoursHundredths).toBe(300);
  });

  it("an overnight shift across spring-forward is 7 real hours, so the 8-hour '+1 day' runaway rule doesn't fire", () => {
    const overnight = e("2026-03-07", "22:00", "06:00", 1);
    const emp = run([overnight], { from: "2026-03-07", to: "2026-03-08", nowLocal: ["2026-03-10", "12:00"] });
    const r = emp.rows.find((x) => x.entryId === overnight.id)!;
    expect(r.durationMs).toBe(7 * 3_600_000);
    expect(r.plusDays).toBe(1);
    expect(r.flags.map((f) => f.code)).not.toContain("runaway");
    // …while the same wall-clock span on a normal night (8 h) is a runaway.
    const normal = e("2026-02-07", "22:00", "06:00", 1);
    const emp2 = run([normal], { from: "2026-02-07", to: "2026-02-08", nowLocal: ["2026-02-10", "12:00"] });
    expect(emp2.rows.find((x) => x.entryId === normal.id)!.flags.map((f) => f.code)).toContain("runaway");
  });

  it("local start times stay on pattern across the DST change (no false off-pattern flag)", () => {
    // Wednesdays at 15:30 local before and after 2026-03-08.
    const weds = ["2026-02-18", "2026-02-25", "2026-03-04", "2026-03-11", "2026-03-18"].map((d) => e(d, "15:30", "19:30"));
    const emp = run(weds, { from: "2026-03-09", to: "2026-03-22", nowLocal: ["2026-03-25", "12:00"] });
    expect(emp.rows.flatMap((r) => r.flags.map((f) => f.code))).not.toContain("off_pattern_start");
    // Missing-day logic uses local dates too: Wed 2026-03-25 isn't past yet, the two in range were worked.
    expect(emp.rows.filter((r) => r.kind === "missing")).toHaveLength(0);
  });
});

describe("weekday estimates", () => {
  it("future/unclocked days are estimated from the same weekday's recent shifts, marked, and kept out of actual totals", () => {
    // Today = Wed 2026-03-11 at 10:00, range Mon 03-09 .. Sun 03-15.
    const hist = [
      e("2026-02-18", "15:30", "19:30"), // Wed 4 h
      e("2026-02-25", "15:30", "19:30"), // Wed 4 h
      e("2026-03-04", "15:30", "20:30"), // Wed 5 h
      e("2026-02-27", "15:30", "18:30"), // Fri 3 h
      e("2026-03-09", "15:30", "19:30"), // Mon (in range, actual) 4 h
    ];
    const emp = run(hist, { from: "2026-03-09", to: "2026-03-15", nowLocal: ["2026-03-11", "10:00"] });
    const wed = emp.rows.find((r) => r.date === "2026-03-11")!;
    expect(wed.kind).toBe("estimate");
    expect(wed.hoursHundredths).toBe(433); // mean of 4, 4, 5 h
    expect(wed.basisDates).toEqual(["2026-03-04", "2026-02-25", "2026-02-18"]);
    expect(wed.payMinor).toBe(6495); // 4.33 × $15
    expect(wed.note).toMatch(/Estimate/);
    const thu = emp.rows.find((r) => r.date === "2026-03-12")!;
    expect(thu.kind).toBe("estimate");
    expect(thu.hoursHundredths).toBe(0);
    expect(thu.note).toMatch(/no Thu shifts/);
    const sat = emp.rows.find((r) => r.date === "2026-03-14")!;
    expect(sat.hoursHundredths).toBe(0); // weekends never worked → 0
    const fri = emp.rows.find((r) => r.date === "2026-03-13")!;
    expect(fri.hoursHundredths).toBe(300);
    // Tuesday is past and never worked: no estimate, not missing.
    expect(emp.rows.find((r) => r.date === "2026-03-10")!.kind).toBe("none");

    expect(emp.actual.hoursHundredths).toBe(400);
    expect(emp.actual.grossMinor).toBe(6000);
    expect(emp.estimated.hoursHundredths).toBe(733);
    expect(emp.estimated.grossMinor).toBe(6495 + 4500);
    expect(emp.projected.grossMinor).toBe(6000 + 6495 + 4500);
    expect(emp.projected.deductionMinor + emp.projected.netMinor).toBe(emp.projected.grossMinor);
  });
});

describe("Zen Planner paste parser (unverified mapping)", () => {
  it("parses dates, times, '+N days', 'Add' rows and checks listed hours/amounts", () => {
    expect(parseZpDate("Mon, 05 Oct 2026")).toBe("2026-10-05");
    expect(parseZpDate("Sat, 31 Feb 2026")).toBeNull();
    expect(parseZpTime("3:58 PM")).toEqual({ hm: "15:58", plusDays: 0 });
    expect(parseZpTime("12:05 AM")).toEqual({ hm: "00:05", plusDays: 0 });
    expect(parseZpTime("6:14 AM (+1 day)")).toEqual({ hm: "06:14", plusDays: 1 });
    expect(parseZpTime("+2 days 9:00 AM")).toEqual({ hm: "09:00", plusDays: 2 });
    const text = [
      "Date | Pay Rate | Rate | Time In | Time Out | Hours | Amount",
      "Mon, 05 Oct 2026 | Coach (sample) | $15.00 / hour | 3:30 PM | 7:47 PM | 4.28 hours | $64.20",
      "Tue, 06 Oct 2026 | Add",
      "Wed, 07 Oct 2026\tCoach (sample)\t$15.00 / hour\t3:32 PM\t6:14 AM +1 day\t14.70 hours\t$220.50",
      "Thu, 08 Oct 2026 | Coach (sample) | $15.00 / hour | 3:30 PM | 7:30 PM | 9.00 hours | $135.00",
    ].join("\n");
    const rows = parseZenPlannerPayroll(text, DEFAULT_IMPORT_MAPPING, TZ);
    expect(rows.map((r) => r.status)).toEqual(["skipped", "entry", "no_entry", "entry", "entry"]);
    expect(rows[1].recomputedHundredths).toBe(428);
    expect(rows[1].rateMinor).toBe(1500);
    expect(rows[1].warnings).toEqual([]);
    expect(rows[3].plusDays).toBe(1);
    expect(rows[3].recomputedHundredths).toBe(1470);
    expect(rows[3].warnings.join(" ")).toMatch(/runaway/);
    expect(rows[4].warnings.join(" ")).toMatch(/Listed 9.00 h/);
  });
});
