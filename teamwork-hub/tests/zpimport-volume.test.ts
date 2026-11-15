import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import Papa from "papaparse";
import { athletes, bookings, invoices, people, zpBills } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { confirmStrongMatches, reviewGroupPage } from "@/lib/imports/batches";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, tx, uploadAndValidate } from "./imports.helpers";

/**
 * A 20,000-row Attendance file and a 20,000-row Bill file, generated here (nothing large is committed).
 * Every person is fictional: 400 made-up names such as "Niko Madeup017".
 *
 * The time limits are generous ceilings for a shared CI machine, not targets; the measured times are printed.
 */
const PEOPLE = 400;
const ROWS = 20_000;
const FIRST = ["Niko", "Opal", "Pax", "Quill", "Rowan", "Sable", "Tarn", "Umber", "Vesper", "Wren"];
const LAST = ["Madeup", "Pretend", "Invented", "Nonreal", "Imaginary"];
const who = (i: number) => ({ first: FIRST[i % FIRST.length], last: `${LAST[i % LAST.length]}${String(i).padStart(3, "0")}`, dob: `20${String(8 + (i % 8)).padStart(2, "0")}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}` });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Day n of 2026 (0-based) the way Zen Planner writes it: "Nov 14, 2026". */
const zpDate = (n: number) => {
  const d = new Date(Date.UTC(2026, 0, 1 + n));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const bytes = (fields: string[], data: string[][]) => new TextEncoder().encode(Papa.unparse({ fields, data }));

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let rod: Viewer;
const timings: Record<string, number> = {};
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return out;
};

beforeAll(async () => {
  ctx = await seedOrg(undefined, { modules: [] });
  rod = await viewerFor(ctx, "rod");
  const rows = Array.from({ length: PEOPLE }, (_, i) => who(i));
  const inserted = await db()
    .insert(people)
    .values(rows.map((p) => ({ orgId: ctx.orgId, firstName: p.first, lastName: p.last, dateOfBirth: p.dob })))
    .returning({ id: people.id });
  await db().insert(athletes).values(inserted.map((p) => ({ orgId: ctx.orgId, personId: p.id })));
});
const report = () => process.stdout.write(`\n[zp volume] ${ROWS} rows, ${PEOPLE} people, ms: ${JSON.stringify(timings)}\n`);
afterAll(closeTestDb);

// ZP_VOLUME=0 skips these (about a minute and a half) when iterating on something else.
describe.skipIf(process.env.ZP_VOLUME === "0")("20,000-row files", () => {
  it("Attendance: validates, reviews as 400 people and commits", async () => {
    // 50 visits per person: 47 attended, 2 reserved only (blank Att.), 1 with an unreadable Att. value.
    const data: string[][] = [];
    for (let i = 0; i < ROWS; i++) {
      const p = who(i % PEOPLE);
      const visit = Math.floor(i / PEOPLE);
      const hour = 3 + (i % 5);
      const att = visit % 50 === 49 ? "ERROR" : visit % 17 === 16 ? "" : "ON";
      const [y, m, d] = p.dob.split("-").map(Number);
      // Birth Date in the month-name format; the Date column carries the time ("Nov 14, 2026 4:30 PM").
      data.push([p.first, p.last, `${MONTHS[m - 1]} ${d}, ${y}`, `${zpDate(visit * 6 + (i % 5))} ${hour}:30 PM`, att, "ON", "OFF", "Sports Performance", "Nowhere Gym"]);
    }
    const H = ["First Name", "Last Name", "Birth Date", "Date", "Att.", "Rsvp", "Canceled", "Program", "Location"];
    const file = bytes(H, data);
    const { batchId, stats } = await timed("attendance_validate", () => uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-20k-fictional.csv", file));
    expect(stats.fileRows).toBe(ROWS);
    expect(stats.status_invalid).toBe(PEOPLE);
    // The review is one decision per person, not per row, and is paged.
    const page = await timed("attendance_review_page", () => tx((t) => reviewGroupPage(t, rod, batchId, { page: 1, pageSize: 25 })));
    expect(page.total).toBe(PEOPLE);
    expect(page.groups).toHaveLength(25);
    expect(page.byConfidence.strong).toBe(PEOPLE);
    await timed("attendance_confirm", () => tx((t) => confirmStrongMatches(t, rod, batchId)));
    const counts = await timed("attendance_commit", () => confirmAndCommit(rod, batchId));
    const attended = data.filter((r) => r[4] === "ON").length;
    expect(counts).toMatchObject({ create: attended, reject: PEOPLE, skip: ROWS - attended - PEOPLE });
    expect((await db().select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner"))))[0].n).toBe(attended);
    report();
    expect(timings.attendance_validate).toBeLessThan(120_000);
    expect(timings.attendance_commit).toBeLessThan(240_000);
  }, 420_000);

  it("Bills: validates and commits as history, creating nothing payable", async () => {
    const H = ["Number", "First Name", "Last Name", "Birth Date", "Description", "Due Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Paid On Time", "Status"];
    const data: string[][] = [];
    for (let i = 0; i < ROWS; i++) {
      const p = who(i % PEOPLE);
      const [y, m, d] = p.dob.split("-").map(Number);
      const n = Math.floor(i / PEOPLE);
      const refund = i % 97 === 0;
      const unpaid = i % 13 === 0;
      data.push([
        `B-${100000 + i}`,
        p.first,
        p.last,
        `${MONTHS[m - 1]} ${d}, ${y}`,
        "Sports Performance 2x per Week",
        i % 211 === 0 ? "" : zpDate(n * 7),
        refund ? "(45.00)" : "$1,178.99",
        refund ? "-45.00" : unpaid ? "" : "$1,178.99",
        refund ? "0" : unpaid ? "$1,178.99" : "$0.00",
        unpaid ? "OFF" : i % 31 === 0 ? "ERROR" : "ON",
        unpaid ? "UNPAID" : "PAID",
      ]);
    }
    const noDate = data.filter((r) => r[5] === "").length;
    const { batchId, stats } = await timed("bills_validate", () => uploadAndValidate(rod, "zenplanner.bill_grid", "bills-20k-fictional.csv", bytes(H, data)));
    expect(stats.fileRows).toBe(ROWS);
    expect(stats.status_invalid).toBe(noDate);
    await timed("bills_confirm", () => tx((t) => confirmStrongMatches(t, rod, batchId)));
    const counts = await timed("bills_commit", () => confirmAndCommit(rod, batchId));
    expect(counts).toMatchObject({ create: ROWS - noDate, reject: noDate, skip: 0 });
    expect((await db().select({ n: sql<number>`count(*)::int` }).from(zpBills).where(eq(zpBills.orgId, ctx.orgId)))[0].n).toBe(ROWS - noDate);
    expect((await db().select({ n: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.orgId, ctx.orgId)))[0].n).toBe(0);
    report();
    expect(timings.bills_validate).toBeLessThan(120_000);
    expect(timings.bills_commit).toBeLessThan(240_000);
  }, 420_000);
});
