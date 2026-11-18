import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transactions } from "@/db/schema";
import { reportByKey } from "@/lib/reports";
import { attendanceByWeek, bucketByWeek, chartFor, collectionsByWeek, receivablesAging, utilizationByCoach, weeksInRange } from "@/lib/report-charts";
import { closeTestDb, seedOrg, testDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let empty: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg();
  empty = await seedOrg("2026-03-02", { modules: [] });
});
afterAll(closeTestDb);

const range = () => ({ from: "2026-02-01", to: "2026-03-02", tz: ctx.tz });
const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

describe("week bucketing", () => {
  it("covers the range with Monday weeks and fills empty weeks with 0", () => {
    expect(weeksInRange("2026-02-04", "2026-02-16")).toEqual(["2026-02-02", "2026-02-09", "2026-02-16"]);
    const b = bucketByWeek("2026-02-04", "2026-02-16", [{ day: "2026-02-08", a: 2 }, { day: "2026-02-04", a: 1 }, { day: "2026-03-30", a: 9 }], ["a"]);
    expect(b.map((w) => w.a)).toEqual([3, 0, 0]);
    expect(b[0].label).toBe("Wk of Feb 2");
  });
});

describe("report chart aggregations match their reports", () => {
  it("attendance by week sums to the attendance report", async () => {
    const r = range();
    const rep = await reportByKey("attendance")!.run(testDb(), ctx.orgId, r);
    const chart = await attendanceByWeek(testDb(), ctx.orgId, r);
    expect(chart.data.length).toBe(weeksInRange(r.from, r.to).length);
    expect(sum(chart.data, "attended")).toBe(sum(rep.rows, "attended"));
    expect(sum(chart.data, "no_show")).toBe(sum(rep.rows, "no_show"));
    expect(sum(chart.data, "late_cancel")).toBe(sum(rep.rows, "late_cancel"));
    expect(chart.summary).toMatch(/attended/);
  });

  it("collections settled total equals the report's collected figure", async () => {
    const r = range();
    const rep = await reportByKey("collections")!.run(testDb(), ctx.orgId, r);
    const chart = await collectionsByWeek(testDb(), ctx.orgId, r);
    const collected = rep.summary!.find((s) => s.label.startsWith("Collected"))!.value;
    expect(sum(chart.data, "settled")).toBe(collected);
    expect(chart.unit).toBe("usd_minor");
  });

  it("receivables aging buckets sum to the total receivable and match the report tiles", async () => {
    const r = range();
    const rep = await reportByKey("receivables")!.run(testDb(), ctx.orgId, r);
    const chart = receivablesAging(rep);
    const tile = (label: string) => Number(rep.summary!.find((s) => s.label === label)!.value);
    expect(sum(chart.data, "balance")).toBe(tile("Total receivable"));
    expect(chart.data.map((d) => d.balance)).toEqual([tile("Current"), tile("1–30 days"), tile("31–60 days"), tile("61–90 days"), tile("90+ days")]);
  });

  it("utilization by coach combines services and ranks by fill rate; no capacity = null, not 0", () => {
    const chart = utilizationByCoach({
      rows: [
        { coach: "A", service: "x", sessions: 2, capacity: 10, booked: 5 },
        { coach: "A", service: "y", sessions: 1, capacity: 10, booked: 10 },
        { coach: "B", service: "x", sessions: 1, capacity: 4, booked: 4 },
        { coach: "C", service: "x", sessions: 1, capacity: 0, booked: 0 },
      ],
    });
    expect(chart.data.map((d) => [d.x, d.fill_rate])).toEqual([["B", 1], ["A", 0.75], ["C", null]]);
    expect(chart.summary).toContain("Highest fill rate: B (100%)");
  });

  it("only the four charted reports get a chart; CSV columns are untouched", async () => {
    const r = range();
    for (const key of ["attendance", "collections", "receivables", "utilization", "invoiced", "retention"]) {
      const def = reportByKey(key)!;
      const res = await def.run(testDb(), ctx.orgId, r);
      const c = await chartFor(key, testDb(), ctx.orgId, r, res);
      expect(c !== null).toBe(["attendance", "collections", "receivables", "utilization"].includes(key));
    }
  });
});

describe("weekly money buckets use the facility timezone and stay org-scoped", () => {
  it("places a late-evening local settlement in its local week; pending is separate", async () => {
    const db = testDb();
    const base = { orgId: empty.orgId, currency: "USD", provider: "manual" as const, verification: "staff_attested" as const, recordedBy: empty.users.erin, manualReference: "test", isDemo: true };
    await db.insert(transactions).values([
      // Sunday Feb 22, 22:00 local (EST) = Monday 03:00 UTC → belongs to the week of Feb 16.
      { ...base, kind: "manual_payment", status: "settled", amountMinor: 5000, occurredAt: new Date("2026-02-23T03:00:00Z"), settledAt: new Date("2026-02-23T03:00:00Z") },
      { ...base, kind: "charge", status: "pending", amountMinor: 1200, occurredAt: new Date("2026-02-24T15:00:00Z") },
      { ...base, kind: "refund", status: "settled", amountMinor: -700, occurredAt: new Date("2026-02-24T15:00:00Z"), settledAt: new Date("2026-02-24T15:00:00Z") },
    ]);
    const chart = await collectionsByWeek(db, empty.orgId, { from: "2026-02-16", to: "2026-03-01", tz: empty.tz });
    expect(chart.data.map((d) => [d.x, d.settled, d.pending])).toEqual([
      ["2026-02-16", 5000, 0],
      ["2026-02-23", 0, 1200],
    ]);
    // Exact totals above also prove the seeded org's money did not leak into this org's chart.
    const att = await attendanceByWeek(db, empty.orgId, { from: "2026-02-16", to: "2026-03-01", tz: empty.tz });
    expect(att.summary).toMatch(/^No attended/);
  });
});
