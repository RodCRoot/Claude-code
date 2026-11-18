/**
 * Pure payroll engine: turns clock entries + pay-rate history into per-employee daily rows,
 * abnormality flags, weekday estimates and totals. No DB access, so every rule is unit-testable.
 *
 * Time handling: durations come from UTC instants (DST-safe: a 01:00–05:00 shift on spring-forward
 * night is 3 h); calendar rules (which day, weekday, start time of day) use the facility timezone.
 */
import { formatInTimeZone } from "date-fns-tz";
import type { PayrollRounding, TimeEntrySource } from "@/db/schema";
import { addDaysYmd, daysBetween, isoWeekday, localYmd, todayLocal } from "@/lib/time";
import { MS_PER_HOUR, MS_PER_HUNDREDTH, divRoundHalfUp, hundredthsPayMinor, shiftHundredths, shiftPayMinor, sumTotals, totalsOf, type Totals } from "./calc";
import type { PayrollConfig, PayrollThresholds } from "./settings";

export type EngineEntry = {
  id: string;
  userId: string;
  clockIn: Date;
  clockOut: Date | null;
  source: TimeEntrySource;
  /** Flag codes a manager has acknowledged on this entry. */
  ackCodes: string[];
  edited?: boolean;
};
export type EngineRate = { userId: string; effectiveFrom: string; rateMinor: number; label: string };
export type EngineStaff = { userId: string; name: string };
export type EngineInput = {
  from: string;
  to: string;
  now: Date;
  tz: string;
  config: Pick<PayrollConfig, "deductionBps" | "rounding" | "thresholds">;
  staff: EngineStaff[];
  rates: EngineRate[];
  /** Non-voided entries covering at least [from − lookback, to + 1 day] (see historyStart). */
  entries: EngineEntry[];
};

export type FlagCode = "runaway" | "missed_clock_out" | "on_shift" | "tiny" | "missing_expected_day" | "off_pattern_start" | "orphan" | "no_rate";
export type FlagSeverity = "block" | "warn" | "info";
export type Flag = { code: FlagCode; severity: FlagSeverity; message: string; acknowledged: boolean; relatedEntryId?: string };

/** Flags that must be resolved (fixed, voided, or acknowledged) before a run can be approved. */
export const BLOCKING: FlagCode[] = ["runaway", "missed_clock_out", "orphan", "no_rate"];
/** Flags that can be resolved by acknowledging (vs. fixing the data). */
export const ACKABLE: FlagCode[] = ["runaway", "orphan", "tiny", "off_pattern_start"];

export const FLAG_LABEL: Record<FlagCode, string> = {
  runaway: "Runaway shift",
  missed_clock_out: "Missed clock-out",
  on_shift: "On shift now",
  tiny: "Tiny shift",
  missing_expected_day: "Missing usual day",
  off_pattern_start: "Off-pattern start",
  orphan: "Possible stray clock-out",
  no_rate: "No pay rate",
};

export type DayRow = {
  date: string;
  weekday: number;
  kind: "entry" | "estimate" | "missing" | "none";
  entryId?: string;
  source?: TimeEntrySource;
  edited?: boolean;
  clockIn?: string;
  clockOut?: string | null;
  /** Days between clock-in and clock-out local dates (Zen Planner's "+N days"). */
  plusDays?: number;
  durationMs?: number;
  hoursHundredths: number;
  rateMinor: number | null;
  rateLabel: string | null;
  payMinor: number | null;
  included: boolean;
  flags: Flag[];
  /** For estimates: the dates averaged. */
  basisDates?: string[];
  note?: string;
};

export type EmployeeResult = {
  userId: string;
  name: string;
  rows: DayRow[];
  actual: Totals;
  estimated: Totals;
  projected: Totals;
  /** True when some included hours have no pay rate (gross is incomplete). */
  incomplete: boolean;
  blockingOpen: number;
  norm: { medianHundredths: number | null; samples: number; usualWeekdays: number[] };
};

export type PayrollResult = {
  from: string;
  to: string;
  today: string;
  tz: string;
  deductionBps: number;
  rounding: PayrollRounding;
  employees: EmployeeResult[];
  combined: { actual: Totals; estimated: Totals; projected: Totals };
  blockingOpen: number;
  generatedAt: string;
};

const WD = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const weekdayName = (n: number) => WD[n];

/** Earliest local date the engine needs entries from. */
export function historyStart(from: string, now: Date, tz: string, t: PayrollThresholds): string {
  const today = todayLocal(tz, now);
  const anchor = from < today ? from : today;
  return addDaysYmd(anchor, -7 * Math.max(t.lookbackWeeks, 1) - 1);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function localMinutes(d: Date, tz: string): number {
  const [h, m] = formatInTimeZone(d, tz, "H:mm").split(":").map(Number);
  return h * 60 + m;
}

const hm = (d: Date, tz: string) => formatInTimeZone(d, tz, "h:mm a");
const hrs = (ms: number) => (ms / MS_PER_HOUR).toFixed(2);

type Classified = EngineEntry & {
  date: string;
  weekday: number;
  durationMs: number | null;
  plusDays: number;
  startMin: number;
  flags: Flag[];
  included: boolean;
};

function rateAt(rates: EngineRate[], date: string): EngineRate | null {
  let best: EngineRate | null = null;
  for (const r of rates) if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best;
}

/** Classify every entry of one person. Exposed for tests. */
export function classifyEntries(entries: EngineEntry[], opts: { tz: string; today: string; t: PayrollThresholds }): { list: Classified[]; normMs: number | null; samples: number } {
  const { tz, today, t } = opts;
  const list: Classified[] = [...entries]
    .sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime())
    .map((e) => {
      const date = localYmd(e.clockIn, tz);
      return {
        ...e,
        date,
        weekday: isoWeekday(date),
        durationMs: e.clockOut ? e.clockOut.getTime() - e.clockIn.getTime() : null,
        plusDays: e.clockOut ? daysBetween(date, localYmd(e.clockOut, tz)) : 0,
        startMin: localMinutes(e.clockIn, tz),
        flags: [],
        included: false,
      };
    });

  const extreme = (c: Classified) => c.durationMs != null && (c.durationMs > t.runawayMaxHours * MS_PER_HOUR || (c.plusDays >= 1 && c.durationMs >= t.runawayCrossDayMinHours * MS_PER_HOUR));
  const normSamples = list.filter((c) => c.durationMs != null && !extreme(c)).map((c) => c.durationMs!);
  const normMs = normSamples.length >= t.minSamplesForNorm ? median(normSamples) : null;
  const acked = (c: Classified, code: FlagCode) => c.ackCodes.includes(code);
  const add = (c: Classified, code: FlagCode, severity: FlagSeverity, message: string, relatedEntryId?: string) =>
    c.flags.push({ code, severity, message, acknowledged: acked(c, code), relatedEntryId });

  for (const c of list) {
    if (c.durationMs == null) {
      if (c.date < today) add(c, "missed_clock_out", "block", `Clocked in ${hm(c.clockIn, tz)} and never clocked out. Enter the real clock-out time.`);
      else add(c, "on_shift", "info", `On shift since ${hm(c.clockIn, tz)}. Not counted until they clock out.`);
      continue;
    }
    const d = c.durationMs;
    const plus = c.plusDays >= 1 ? ` (clock-out +${c.plusDays} day${c.plusDays > 1 ? "s" : ""})` : "";
    if (d > t.runawayMaxHours * MS_PER_HOUR) {
      add(c, "runaway", "block", `${hrs(d)} h shift${plus} — longer than ${t.runawayMaxHours} h. Likely a missed clock-out; enter the real clock-out.`);
    } else if (c.plusDays >= 1 && d >= t.runawayCrossDayMinHours * MS_PER_HOUR) {
      add(c, "runaway", "block", `${hrs(d)} h shift${plus}. Likely a missed clock-out; enter the real clock-out.`);
    } else if (normMs != null && d > t.runawayNormFactor * normMs && d - normMs >= 2 * MS_PER_HOUR) {
      add(c, "runaway", "block", `${hrs(d)} h shift${plus} vs. a usual ${hrs(normMs)} h. Likely a missed clock-out; enter the real clock-out or confirm it.`);
    }
    if (d < t.tinyHours * MS_PER_HOUR && (normMs == null || normMs >= t.tinyNormMinHours * MS_PER_HOUR)) {
      add(c, "tiny", "warn", `Only ${hrs(d)} h${normMs != null ? ` (usual ${hrs(normMs)} h)` : ""}. Counted; check it was a real shift.`);
    }
  }

  // Off-pattern start: compare with the median start of the person's other shifts on that weekday.
  for (const c of list) {
    const others = list.filter((o) => o !== c && o.weekday === c.weekday && !o.flags.some((f) => f.code === "runaway")).map((o) => o.startMin);
    if (others.length < 3) continue;
    const usual = median(others)!;
    if (Math.abs(c.startMin - usual) > t.offPatternMinutes) {
      const u = `${Math.floor(usual / 60) % 12 || 12}:${String(Math.round(usual % 60)).padStart(2, "0")} ${usual >= 720 ? "PM" : "AM"}`;
      add(c, "off_pattern_start", "info", `Started ${hm(c.clockIn, tz)}; usually around ${u} on ${weekdayName(c.weekday)}.`);
    }
  }

  // Orphans: a short shift on the day(s) right after a runaway is likely the stray clock-out.
  for (const r of list.filter((c) => c.flags.some((f) => f.code === "runaway"))) {
    const last = addDaysYmd(r.date, Math.max(1, r.plusDays + 1));
    for (const c of list) {
      if (c === r || c.durationMs == null || c.flags.some((f) => f.code === "runaway")) continue;
      if (c.date > r.date && c.date <= last && c.durationMs < t.orphanMaxHours * MS_PER_HOUR) {
        add(c, "orphan", "block", `Short ${hrs(c.durationMs)} h entry at ${hm(c.clockIn, tz)} right after the runaway shift of ${r.date}. Likely the stray clock-out: void it, or confirm it was a real shift.`, r.id);
        const rf = r.flags.find((f) => f.code === "runaway")!;
        if (!rf.relatedEntryId) {
          rf.relatedEntryId = c.id;
          rf.message += ` The ${hm(c.clockIn, tz)} entry on ${c.date} may be the stray clock-out.`;
        }
      }
    }
  }

  for (const c of list) {
    if (c.durationMs == null) continue;
    const blocked = c.flags.some((f) => (f.code === "runaway" || f.code === "orphan") && !f.acknowledged);
    c.included = !blocked;
  }
  return { list, normMs, samples: normSamples.length };
}

/** Run the whole payroll calculation. */
export function computePayroll(input: EngineInput): PayrollResult {
  const { from, to, tz, config } = input;
  const t = config.thresholds;
  const rounding = config.rounding;
  const today = todayLocal(tz, input.now);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) dates.push(d);

  const employees: EmployeeResult[] = [];
  for (const s of [...input.staff].sort((a, b) => a.name.localeCompare(b.name))) {
    const rates = input.rates.filter((r) => r.userId === s.userId);
    const { list, normMs, samples } = classifyEntries(
      input.entries.filter((e) => e.userId === s.userId),
      { tz, today, t },
    );

    // Per-date included hundredths (history for estimates) and "worked at all" dates (for usual weekdays).
    const workedDates = new Set(list.map((c) => c.date));
    const includedByDate = new Map<string, number>();
    for (const c of list) if (c.included && c.durationMs != null) includedByDate.set(c.date, (includedByDate.get(c.date) ?? 0) + c.durationMs);

    const anchor = addDaysYmd(to < today ? addDaysYmd(to, 1) : today, -1);
    const windowStart = addDaysYmd(anchor, -7 * t.lookbackWeeks + 1);
    const weekdayCounts = new Map<number, number>();
    for (const d of workedDates) if (d >= windowStart && d <= anchor) weekdayCounts.set(isoWeekday(d), (weekdayCounts.get(isoWeekday(d)) ?? 0) + 1);
    const usualWeekdays = [...weekdayCounts.entries()].filter(([, n]) => n >= t.expectedWeekdayMinWeeks).map(([w]) => w).sort();

    const rows: DayRow[] = [];
    let actualMs = 0;
    let actualHundredths = 0;
    let actualGross = 0;
    let incomplete = false;
    let estHundredths = 0;
    let estGross = 0;

    for (const date of dates) {
      const weekday = isoWeekday(date);
      const dayEntries = list.filter((c) => c.date === date);
      for (const c of dayEntries) {
        const rate = rateAt(rates, date);
        const flags = [...c.flags];
        let payMinor: number | null = null;
        const hundredths = c.durationMs != null ? shiftHundredths(c.durationMs, rounding) : 0;
        if (c.durationMs != null) {
          if (rate) payMinor = shiftPayMinor(c.durationMs, rate.rateMinor, rounding);
          else flags.push({ code: "no_rate", severity: "block", message: `No pay rate effective on ${date}. Add one in Payroll → Staff & rates.`, acknowledged: false });
        }
        if (c.included && c.durationMs != null) {
          actualMs += c.durationMs;
          actualHundredths += hundredths;
          if (payMinor == null) incomplete = true;
          else actualGross += payMinor;
        }
        rows.push({
          date,
          weekday,
          kind: "entry",
          entryId: c.id,
          source: c.source,
          edited: c.edited,
          clockIn: c.clockIn.toISOString(),
          clockOut: c.clockOut ? c.clockOut.toISOString() : null,
          plusDays: c.plusDays,
          durationMs: c.durationMs ?? undefined,
          hoursHundredths: hundredths,
          rateMinor: rate?.rateMinor ?? null,
          rateLabel: rate?.label ?? null,
          payMinor,
          included: c.included && c.durationMs != null,
          flags,
        });
      }
      const hasClosed = dayEntries.some((c) => c.durationMs != null);
      if (date >= today && !hasClosed) {
        // Estimate from the most recent worked same-weekday days before today.
        const basis: string[] = [];
        for (let d = addDaysYmd(today, -1), i = 0; i < t.lookbackWeeks * 7 && basis.length < t.estimateSampleDays; d = addDaysYmd(d, -1), i++) {
          if (isoWeekday(d) === weekday && includedByDate.has(d)) basis.push(d);
        }
        const rate = rateAt(rates, date);
        const meanMs = basis.length ? basis.reduce((a, d) => a + includedByDate.get(d)!, 0) / basis.length : 0;
        const h = basis.length ? divRoundHalfUp(meanMs, MS_PER_HUNDREDTH) : 0;
        const payMinor = h === 0 ? 0 : rate ? hundredthsPayMinor(h, rate.rateMinor) : null;
        if (h > 0) {
          estHundredths += h;
          if (payMinor == null) incomplete = true;
          else estGross += payMinor;
        }
        rows.push({
          date,
          weekday,
          kind: "estimate",
          hoursHundredths: h,
          rateMinor: rate?.rateMinor ?? null,
          rateLabel: rate?.label ?? null,
          payMinor,
          included: false,
          flags: h > 0 && !rate ? [{ code: "no_rate", severity: "block", message: `No pay rate effective on ${date}.`, acknowledged: false }] : [],
          basisDates: basis,
          note: basis.length
            ? `Estimate: average of ${basis.length} recent ${weekdayName(weekday)} shift${basis.length > 1 ? "s" : ""}`
            : `Estimate: 0 — no ${weekdayName(weekday)} shifts in the last ${t.lookbackWeeks} weeks`,
        });
      } else if (!dayEntries.length) {
        if (date < today && usualWeekdays.includes(weekday)) {
          rows.push({
            date,
            weekday,
            kind: "missing",
            hoursHundredths: 0,
            rateMinor: null,
            rateLabel: null,
            payMinor: null,
            included: false,
            flags: [{ code: "missing_expected_day", severity: "warn", message: `Usually works ${weekdayName(weekday)} (${weekdayCounts.get(weekday)} of the last ${t.lookbackWeeks} weeks) but has no entry. Add one if they worked.`, acknowledged: false }],
          });
        } else {
          rows.push({ date, weekday, kind: "none", hoursHundredths: 0, rateMinor: null, rateLabel: null, payMinor: null, included: false, flags: [] });
        }
      }
    }

    const hasAnything = rows.some((r) => r.kind === "entry" || r.kind === "missing" || (r.kind === "estimate" && r.hoursHundredths > 0));
    if (!hasAnything) continue;
    const hoursActual = rounding === "exact" ? divRoundHalfUp(actualMs, MS_PER_HUNDREDTH) : actualHundredths;
    const actual = totalsOf(hoursActual, actualGross, config.deductionBps);
    const estimated = totalsOf(estHundredths, estGross, config.deductionBps);
    const projected = totalsOf(hoursActual + estHundredths, actualGross + estGross, config.deductionBps);
    const blockingOpen = rows.reduce((n, r) => n + r.flags.filter((f) => BLOCKING.includes(f.code) && !f.acknowledged).length, 0);
    employees.push({
      userId: s.userId,
      name: s.name,
      rows,
      actual,
      estimated,
      projected,
      incomplete,
      blockingOpen,
      norm: { medianHundredths: normMs != null ? divRoundHalfUp(normMs, MS_PER_HUNDREDTH) : null, samples, usualWeekdays },
    });
  }

  return {
    from,
    to,
    today,
    tz,
    deductionBps: config.deductionBps,
    rounding,
    employees,
    combined: {
      actual: sumTotals(employees.map((e) => e.actual)),
      estimated: sumTotals(employees.map((e) => e.estimated)),
      projected: sumTotals(employees.map((e) => e.projected)),
    },
    blockingOpen: employees.reduce((n, e) => n + e.blockingOpen, 0),
    generatedAt: input.now.toISOString(),
  };
}
