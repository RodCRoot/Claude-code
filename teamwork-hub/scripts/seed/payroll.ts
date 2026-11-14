import { staffClockPins, staffPayRates, timeEntries } from "../../src/db/schema";
import { hashCheckInPin } from "../../src/lib/scheduling/pin-hash";
import { addDaysYmd, isoWeekday, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/** Demo time-clock PIN for Coach Marcus (synthetic). */
export const DEMO_STAFF_CLOCK_PIN = "3719";

/**
 * Synthetic staff time clock: SAMPLE pay rates (not anyone's real pay) and five weeks of shifts for
 * the demo staff logins, with one of each abnormality the payroll page detects:
 * runaway shift + its stray clock-out (orphan), a tiny shift, a missing usual day, an off-pattern
 * start, and a missed clock-out.
 */
export async function seedPayroll(ctx: SeedCtx) {
  const { tx, orgId, tz, today } = ctx;
  const start = addDaysYmd(today, -35);
  await tx.insert(staffPayRates).values([
    { orgId, userId: ctx.users.marcus, label: "Coach (sample rate)", rateMinor: 1650, effectiveFrom: addDaysYmd(today, -120), isDemo: true },
    { orgId, userId: ctx.users.tess, label: "Coach (sample rate)", rateMinor: 1575, effectiveFrom: addDaysYmd(today, -120), isDemo: true },
    { orgId, userId: ctx.users.erin, label: "Front desk (sample rate)", rateMinor: 1425, effectiveFrom: addDaysYmd(today, -120), isDemo: true },
    // A raise mid-history shows rate history in action.
    { orgId, userId: ctx.users.erin, label: "Front desk (sample rate)", rateMinor: 1500, effectiveFrom: addDaysYmd(today, -14), isDemo: true },
  ]);
  await tx.insert(staffClockPins).values({ userId: ctx.users.marcus, orgId, pinHash: hashCheckInPin(orgId, `staff:${DEMO_STAFF_CLOCK_PIN}`), setByUserId: ctx.users.rod });

  type Row = typeof timeEntries.$inferInsert;
  const rows: Row[] = [];
  const shift = (userKey: string, date: string, tin: string, tout: string | null, outDayOffset = 0, source: Row["source"] = "kiosk") => {
    const clockIn = localToUtc(date, tin, tz);
    const clockOut = tout ? localToUtc(addDaysYmd(date, outDayOffset), tout, tz) : null;
    rows.push({ orgId, userId: ctx.users[userKey], clockIn, clockOut, originalClockIn: clockIn, originalClockOut: clockOut, source, isDemo: true, createdBy: ctx.users.kiosk });
  };
  const mm = (n: number) => String(n).padStart(2, "0");

  const lastWed = (() => {
    for (let d = addDaysYmd(today, -1); ; d = addDaysYmd(d, -1)) if (isoWeekday(d) === 3 && d < addDaysYmd(today, -1)) return d;
  })();
  const lastTue = addDaysYmd(lastWed, -1);
  const lastThu = addDaysYmd(lastWed, 1);
  let w = 0;
  for (let d = start; d < today; d = addDaysYmd(d, 1), w++) {
    const wd = isoWeekday(d);
    const jitter = (w * 7) % 11;
    // Coach Marcus: Mon/Wed/Fri afternoons.
    if (wd === 1 || wd === 3 || wd === 5) {
      if (d === lastWed) {
        shift("marcus", d, "15:32", "06:14", 1); // runaway: forgot to clock out, closed next morning
      } else shift("marcus", d, `15:${mm(25 + jitter)}`, `19:${mm(40 + jitter)}`);
    }
    if (d === lastThu) shift("marcus", d, "06:14", "06:19"); // the stray clock-out (orphan)
    // Coach Tess: Tue/Thu evenings, Sat mornings.
    if (wd === 2 || wd === 4) {
      if (d === lastThu) {
        // missing usual day: no entry
      } else if (d === lastTue) shift("tess", d, "16:02", "16:14"); // tiny shift
      else shift("tess", d, `16:${mm(jitter)}`, `20:${mm(5 + jitter)}`);
    }
    if (wd === 6) shift("tess", d, `09:${mm(jitter)}`, `12:${mm(10 + jitter)}`);
    // Erin: weekday mornings at the front desk.
    if (wd <= 5) {
      if (d === lastTue) shift("erin", d, "13:30", "18:02"); // off-pattern start
      else if (d === lastThu) shift("erin", d, "09:01", null); // missed clock-out (never closed)
      else shift("erin", d, `09:${mm(jitter)}`, `14:${mm(jitter + 3)}`);
    }
  }
  await tx.insert(timeEntries).values(rows);
}
