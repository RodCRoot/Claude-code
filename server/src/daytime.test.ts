// Day-math tests. The crux: a "day" is the client's calendar day, so an
// instant near UTC midnight must land on different days for different offsets.
import assert from "assert";
import { dayOf, today, dayStartUtc, dayRangeUtc, pureDate, addDays, mondayOf, dayLabel, isDayString } from "./daytime";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("daytime.ts");

// 2026-06-23T01:30Z. Chicago (offset +300 → UTC-5) is still Jun 22, 20:30.
const nearMidnightUtc = new Date("2026-06-23T01:30:00Z");

test("dayOf: UTC viewer sees Jun 23", () => {
  assert.equal(dayOf(nearMidnightUtc, 0), "2026-06-23");
});
test("dayOf: Chicago (offset 300) still sees Jun 22", () => {
  assert.equal(dayOf(nearMidnightUtc, 300), "2026-06-22");
});
test("dayOf: Sydney (offset -600) already sees Jun 23", () => {
  assert.equal(dayOf(nearMidnightUtc, -600), "2026-06-23");
});
test("today matches dayOf at a fixed instant", () => {
  assert.equal(today(300, nearMidnightUtc.getTime()), "2026-06-22");
});

test("dayStartUtc: Chicago Jun 22 begins 05:00Z", () => {
  assert.equal(dayStartUtc("2026-06-22", 300).toISOString(), "2026-06-22T05:00:00.000Z");
});
test("dayStartUtc: UTC Jun 22 begins 00:00Z", () => {
  assert.equal(dayStartUtc("2026-06-22", 0).toISOString(), "2026-06-22T00:00:00.000Z");
});
test("dayRangeUtc spans exactly 24h and contains the local evening", () => {
  const [start, end] = dayRangeUtc("2026-06-22", 300);
  assert.equal(end.getTime() - start.getTime(), 864e5);
  // 20:30 Chicago on Jun 22 = 01:30Z Jun 23 — inside Chicago's Jun 22.
  assert.ok(nearMidnightUtc >= start && nearMidnightUtc < end);
});
test("round-trip: instant → dayOf → dayRangeUtc contains instant", () => {
  for (const off of [-840, -600, 0, 300, 840]) {
    const day = dayOf(nearMidnightUtc, off);
    const [s, e] = dayRangeUtc(day, off);
    assert.ok(nearMidnightUtc >= s && nearMidnightUtc < e, `offset ${off}`);
  }
});

test("pureDate stores UTC midnight regardless of viewer", () => {
  assert.equal(pureDate("2026-06-22").toISOString(), "2026-06-22T00:00:00.000Z");
});
test("addDays crosses month/year boundaries", () => {
  assert.equal(addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // leap year
});
test("mondayOf: Monday is itself; Sunday belongs to the prior Monday", () => {
  assert.equal(mondayOf("2026-06-22"), "2026-06-22"); // a Monday
  assert.equal(mondayOf("2026-06-28"), "2026-06-22"); // that week's Sunday
  assert.equal(mondayOf("2026-06-27"), "2026-06-22"); // Saturday
});
test("dayLabel", () => {
  assert.equal(dayLabel("2026-06-05"), "Jun 5");
  assert.equal(dayLabel("2026-12-31"), "Dec 31");
});
test("isDayString accepts valid, rejects junk", () => {
  assert.ok(isDayString("2026-06-22"));
  assert.ok(!isDayString("06/22/2026"));
  assert.ok(!isDayString("2026-13-99"));
  assert.ok(!isDayString(20260622));
});

console.log(`${passed} tests passed.\n`);
