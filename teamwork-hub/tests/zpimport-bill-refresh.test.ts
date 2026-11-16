import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import Papa from "papaparse";
import { athletes, auditEvents, invoices, jobs, memberships, people, zpBills } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { batchRows, confirmStrongMatches, getBatch, revertBatch } from "@/lib/imports/batches";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, tx, uploadAndValidate } from "./imports.helpers";

// Re-importing the Bill grid refreshes bills that are already in the history. Every person here is fictional.

const csv = (headers: string[], rows: (string | null)[][]) => new TextEncoder().encode(Papa.unparse({ fields: headers, data: rows.map((r) => r.map((c) => c ?? "")) }));
const H = ["Bill #", "First Name", "Last Name", "Birth Date", "Description", "Due Date", "Payment Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Paid On Time", "Status"];
const NIKO = ["Niko", "Madeup", "Apr 2, 2011"];
const OPAL = ["Opal", "Pretend", "May 3, 2012"];

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
let ctx: Ctx;
let rod: Viewer;
const ids: Record<string, string> = {};

const rowsOf = (batchId: string) => tx((t) => batchRows(t, rod, batchId, undefined, 1000));
const bill = async (number: string) => (await db().select().from(zpBills).where(and(eq(zpBills.orgId, ctx.orgId), eq(zpBills.sourceRecordId, number))))[0];
const billCount = async () => (await db().select({ n: sql<number>`count(*)::int` }).from(zpBills).where(eq(zpBills.orgId, ctx.orgId)))[0].n;
const importFile = async (name: string, headers: string[], rows: (string | null)[][]) => {
  const r = await uploadAndValidate(rod, "zenplanner.bill_grid", name, csv(headers, rows));
  await tx((t) => confirmStrongMatches(t, rod, r.batchId));
  return { batchId: r.batchId, stats: r.stats, counts: await confirmAndCommit(rod, r.batchId) };
};

beforeAll(async () => {
  ctx = await seedOrg(undefined, { modules: [] });
  rod = await viewerFor(ctx, "rod");
  for (const [key, first, last, dob] of [["niko", "Niko", "Madeup", "2011-04-02"], ["opal", "Opal", "Pretend", "2012-05-03"]] as const) {
    const [p] = await db().insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: last, dateOfBirth: dob }).returning({ id: people.id });
    ids[key] = p.id;
    await db().insert(athletes).values({ orgId: ctx.orgId, personId: p.id });
  }
});
afterAll(closeTestDb);

describe("re-importing a Bill grid", () => {
  let firstBatch: string;
  let secondBatch: string;

  it("the first import stores the bills, with the Payment Date kept on its own", async () => {
    const r = await importFile("bills-october-fictional.csv", H, [
      ["B-1", ...NIKO, "Sports Performance", "Nov 1, 2026", null, "$100.00", "$0.00", "$100.00", null, "UNPAID"],
      ["B-2", ...NIKO, "Sports Performance", "Oct 1, 2026", "Oct 1, 2026", "$100.00", "$100.00", "$0.00", "On-Time", "PAID"],
      ["B-3", ...OPAL, "Speed Class", "Nov 1, 2026", null, "$60.00", "$0.00", "$60.00", null, "UNPAID"],
    ]);
    firstBatch = r.batchId;
    expect(r.counts).toMatchObject({ create: 3, update: 0, reject: 0 });
    expect(await bill("B-1")).toMatchObject({ personId: ids.niko, dueDate: "2026-11-01", paidDate: null, amountPaidMinor: 0, amountUnpaidMinor: 10000, zpStatus: "UNPAID", paidOnTime: null });
    expect(await bill("B-2")).toMatchObject({ paidDate: "2026-10-01", amountPaidMinor: 10000, zpStatus: "PAID", paidOnTime: true });
  });

  it("a later export shows the paid bill as an update in the preview, without asking who it belongs to again", async () => {
    const r = await uploadAndValidate(
      rod,
      "zenplanner.bill_grid",
      "bills-november-fictional.csv",
      csv(H, [
        // Paid since the first export.
        ["B-1", ...NIKO, "Sports Performance", "Nov 1, 2026", "Nov 12, 2026", "$100.00", "$100.00", "$0.00", "Late", "PAID"],
        // Unchanged.
        ["B-2", ...NIKO, "Sports Performance", "Oct 1, 2026", "Oct 1, 2026", "$100.00", "$100.00", "$0.00", "On-Time", "PAID"],
        // Partly paid, and its due date was moved in Zen Planner.
        ["B-3", ...OPAL, "Speed Class", "Nov 15, 2026", "Nov 10, 2026", "$60.00", "$20.00", "$40.00", null, "PARTIAL"],
        // New.
        ["B-4", ...OPAL, "Speed Class", "Dec 1, 2026", null, "$60.00", "$0.00", "$60.00", null, "UNPAID"],
      ]),
    );
    secondBatch = r.batchId;
    const rows = await rowsOf(secondBatch);
    const n = (row: number) => rows.find((x) => x.rowNumber === row)!.normalized as Record<string, unknown>;
    expect(n(2)).toMatchObject({ _action: "update", _billPatch: { paidDate: "2026-11-12", amountPaidMinor: 10000, amountUnpaidMinor: 0, paidOnTime: false, zpStatus: "PAID" } });
    expect(n(3)._action).toBe("skip");
    expect(n(4)).toMatchObject({ _action: "update", _billPatch: { dueDate: "2026-11-15", paidDate: "2026-11-10", amountPaidMinor: 2000, amountUnpaidMinor: 4000, zpStatus: "PARTIAL" } });
    // Bills already matched to a person are not sent back to identity review; only the new bill is.
    expect(rows.filter((x) => x.status === "needs_review").map((x) => x.rowNumber)).toEqual([5]);
    expect(r.stats).toMatchObject({ action_update: 2, action_skip: 1 });
    // Nothing is written before the commit.
    expect(await bill("B-1")).toMatchObject({ amountPaidMinor: 0, zpStatus: "UNPAID" });
  });

  it("the commit refreshes the existing rows, counts them as updates and audits each one", async () => {
    await tx((t) => confirmStrongMatches(t, rod, secondBatch));
    const counts = await confirmAndCommit(rod, secondBatch);
    expect(counts).toMatchObject({ create: 1, update: 2, skip: 1, reject: 0 });
    const b = await tx((t) => getBatch(t, rod, secondBatch));
    expect(b.stats).toMatchObject({ committed_update: 2, committed_create: 1 });

    const b1 = await bill("B-1");
    expect(b1).toMatchObject({ personId: ids.niko, dueDate: "2026-11-01", paidDate: "2026-11-12", amountDueMinor: 10000, amountPaidMinor: 10000, amountUnpaidMinor: 0, paidOnTime: false, zpStatus: "PAID" });
    // Still the row the first import created.
    expect(b1.importBatchId).toBe(firstBatch);
    expect(await bill("B-3")).toMatchObject({ dueDate: "2026-11-15", paidDate: "2026-11-10", amountPaidMinor: 2000, amountUnpaidMinor: 4000, zpStatus: "PARTIAL" });
    expect(await billCount()).toBe(4);

    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "import.zp_bill.update")));
    expect(audits).toHaveLength(2);
    const a1 = audits.find((a) => a.entityId === b1.id)!;
    expect(a1.before).toMatchObject({ amountPaidMinor: 0, amountUnpaidMinor: 10000, zpStatus: "UNPAID", paidDate: null });
    expect(a1.after).toMatchObject({ amountPaidMinor: 10000, amountUnpaidMinor: 0, zpStatus: "PAID", paidDate: "2026-11-12" });
    expect(a1.actorUserId).toBe(rod.userId);
  });

  it("stays history only: no invoice, no membership, no job", async () => {
    const count = async (table: typeof invoices | typeof memberships | typeof jobs) => (await db().select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.orgId, ctx.orgId)))[0].n;
    expect(await count(invoices)).toBe(0);
    expect(await count(memberships)).toBe(0);
    expect(await count(jobs)).toBe(0);
  });

  it("a file without a column leaves that field alone, and an unreadable cell never replaces a stored value", async () => {
    // No Payment Date, Amount Unpaid or Paid On Time columns; Amount Paid cannot be read on B-1.
    const fewer = ["Bill #", "First Name", "Last Name", "Birth Date", "Description", "Due Date", "Amount Due", "Amount Paid", "Status"];
    const r = await importFile("bills-fewer-columns-fictional.csv", fewer, [
      ["B-1", ...NIKO, "Sports Performance", "Nov 1, 2026", "$100.00", "ERROR", "PAID"],
      ["B-2", ...NIKO, "Sports Performance", "Oct 1, 2026", "$100.00", "$100.00", "PAID"],
    ]);
    expect(r.counts).toMatchObject({ create: 0, update: 0, skip: 2 });
    expect(await bill("B-1")).toMatchObject({ paidDate: "2026-11-12", amountPaidMinor: 10000, amountUnpaidMinor: 0, paidOnTime: false });
    expect(await bill("B-2")).toMatchObject({ paidDate: "2026-10-01", amountUnpaidMinor: 0, paidOnTime: true });
  });

  it("a blank cell in a column the file has does clear the value: a payment taken back", async () => {
    const r = await importFile("bills-reversal-fictional.csv", H, [["B-2", ...NIKO, "Sports Performance", "Oct 1, 2026", null, "$100.00", "$0.00", "$100.00", null, "UNPAID"]]);
    expect(r.counts).toMatchObject({ update: 1 });
    expect(await bill("B-2")).toMatchObject({ paidDate: null, amountPaidMinor: 0, amountUnpaidMinor: 10000, paidOnTime: null, zpStatus: "UNPAID" });
    // Put it back the way the reversal found it, so the next test starts from the November state.
    await tx((t) => revertBatch(t, rod, r.batchId));
    expect(await bill("B-2")).toMatchObject({ paidDate: "2026-10-01", amountPaidMinor: 10000, amountUnpaidMinor: 0, paidOnTime: true, zpStatus: "PAID" });
  });

  it("reverting the later import restores the earlier values and removes only the bill it created", async () => {
    const r = await tx((t) => revertBatch(t, rod, secondBatch));
    expect(r.deleted).toBe(1);
    expect(await billCount()).toBe(3);
    expect(await bill("B-4")).toBeUndefined();
    expect(await bill("B-1")).toMatchObject({ dueDate: "2026-11-01", paidDate: null, amountPaidMinor: 0, amountUnpaidMinor: 10000, paidOnTime: null, zpStatus: "UNPAID" });
    expect(await bill("B-3")).toMatchObject({ dueDate: "2026-11-01", paidDate: null, amountPaidMinor: 0, amountUnpaidMinor: 6000, zpStatus: "UNPAID" });
    const b = await tx((t) => getBatch(t, rod, secondBatch));
    expect(b.stats).toMatchObject({ reverted_restored: 2, reverted_deleted: 1 });
  });

  it("reverting an update does not undo a field that a still later import changed again", async () => {
    const paid = await importFile("bills-a-fictional.csv", H, [["B-1", ...NIKO, "Sports Performance", "Nov 1, 2026", "Nov 12, 2026", "$100.00", "$100.00", "$0.00", "Late", "PAID"]]);
    expect(paid.counts).toMatchObject({ update: 1 });
    const refunded = await importFile("bills-b-fictional.csv", H, [["B-1", ...NIKO, "Sports Performance", "Nov 1, 2026", "Nov 12, 2026", "$100.00", "$100.00", "$0.00", "Late", "REFUNDED"]]);
    expect(refunded.counts).toMatchObject({ update: 1 });
    await tx((t) => revertBatch(t, rod, paid.batchId));
    // Status was changed again after the reverted batch, so it keeps the newer value; the fields that still hold
    // what the reverted batch wrote go back to what they were before it.
    expect(await bill("B-1")).toMatchObject({ zpStatus: "REFUNDED", paidDate: null, amountPaidMinor: 0, amountUnpaidMinor: 10000, paidOnTime: null });
  });

  it("reverting the first import removes its bills even though a later import updated one", async () => {
    const r = await tx((t) => revertBatch(t, rod, firstBatch));
    expect(r.deleted).toBe(3);
    expect(await billCount()).toBe(0);
  });
});
