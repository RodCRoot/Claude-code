import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import Papa from "papaparse";
import { athletes, bookings, externalIds, importRows, invoices, jobs, memberships, people, scheduleSessions, serviceTypes, zpBills } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { batchRows, confirmStrongMatches, getBatch, revertBatch } from "@/lib/imports/batches";
import { autoMap, missingRequired, normalizeRow } from "@/lib/imports/mapping";
import { parseDate, parseDateAndTime, parseDateTime, parseMoneyMinor, parseTime, parseTimeRange } from "@/lib/imports/normalize";
import { parseCsvText } from "@/lib/imports/parse";
import { rejectedRowsCsv } from "@/lib/imports/reconcile";
import { RowCache, rowRejectionReason } from "@/lib/imports/row-errors";
import { zpAttendanceGrid, zpBillGrid } from "@/lib/imports/schemas/zenplanner-grid";
import type { ImportSchemaDef } from "@/lib/imports/types";
import { UserError } from "@/lib/actions";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, tx, uploadAndValidate } from "./imports.helpers";

// Every person in this file is fictional (surnames Madeup, Pretend, Invented, Nonreal, Imaginary).

const TZ = "America/Indiana/Indianapolis";
const TODAY = "2026-11-15";
const csv = (headers: string[], rows: (string | null)[][]) => new TextEncoder().encode(Papa.unparse({ fields: headers, data: rows.map((r) => r.map((c) => c ?? "")) }));

/** Run one row through the preset exactly as an upload would: auto-mapped headers, then the schema's normalizer. */
function row(schema: ImportSchemaDef, cells: Record<string, string | null>) {
  const headers = Object.keys(cells);
  const mapping = autoMap(schema, headers);
  return normalizeRow(schema, cells, mapping, { orgId: "00000000-0000-0000-0000-000000000000", tz: TZ, options: {}, today: TODAY }, []);
}

describe("formats the real grids use", () => {
  it("reads money with dollar signs, thousands, parentheses and minus signs, and never turns junk into 0", () => {
    const cases: [string, number | undefined][] = [
      ["$1,234.56", 123456],
      ["1234.5", 123450],
      ["178.99", 17899],
      ["(45.00)", -4500],
      ["-45.00", -4500],
      ["-$45.00", -4500],
      ["$-45.00", -4500],
      ["($1,234.56)", -123456],
      ["45.00-", -4500],
      ["−45.00", -4500],
      ["$ 45", 4500],
      ["USD 45.00", 4500],
      ["0.00", 0],
      ["(0.00)", 0],
      [".5", 50],
      ["1,000,000.00", 100000000],
      ["12,34.00", undefined],
      ["ERROR", undefined],
      ["45.00 CR", undefined],
      ["$", undefined],
      ["99999999999999999999", undefined],
      ["1.2.3", undefined],
    ];
    for (const [text, cents] of cases) expect(parseMoneyMinor(text), text).toBe(cents);
  });

  it("reads month-name dates and date-times, weekday prefixes and time ranges", () => {
    expect(parseDate("Nov 14, 2026")).toBe("2026-11-14");
    expect(parseDate("Nov 14, 2026 4:30 PM")).toBe("2026-11-14");
    expect(parseDate("Sat, Nov 14, 2026")).toBe("2026-11-14");
    expect(parseDate("Saturday, November 14, 2026 at 4:30 PM")).toBe("2026-11-14");
    expect(parseDate("14 Nov 2026")).toBe("2026-11-14");
    expect(parseDate("Sept 3rd, 2026")).toBe("2026-09-03");
    expect(parseDate("11/14/2026 16:30")).toBe("2026-11-14");
    expect(parseDate("2026-11-14T16:30:00-05:00")).toBe("2026-11-14");
    expect(parseDate("Nov 31, 2026")).toBeNull();
    expect(parseDate("Novembrr 14, 2026")).toBeNull();
    expect(parseDate("soon")).toBeNull();

    expect(parseDateAndTime("Nov 14, 2026 4:30 PM")).toEqual({ date: "2026-11-14", time: "16:30:00", endTime: null });
    expect(parseDateAndTime("Nov 14, 2026 4:30PM")).toEqual({ date: "2026-11-14", time: "16:30:00", endTime: null });
    expect(parseDateAndTime("Sat, Nov 14, 2026 at 9:00 AM EST")).toEqual({ date: "2026-11-14", time: "09:00:00", endTime: null });
    expect(parseDateAndTime("11/14/2026 4:30 PM - 5:15 PM")).toEqual({ date: "2026-11-14", time: "16:30:00", endTime: "17:15:00" });
    expect(parseDateAndTime("Nov 14, 2026")).toEqual({ date: "2026-11-14", time: null, endTime: null });
    expect(parseDateAndTime("Dec 1, 2026 12:00 AM")).toEqual({ date: "2026-12-01", time: "00:00:00", endTime: null });

    expect(parseTime("4:30 PM")).toBe("16:30:00");
    expect(parseTime("4:30PM")).toBe("16:30:00");
    expect(parseTime("4pm")).toBe("16:00:00");
    expect(parseTime("4:30 p.m.")).toBe("16:30:00");
    expect(parseTime("16:30")).toBe("16:30:00");
    expect(parseTime("4:30 PM EST")).toBe("16:30:00");
    expect(parseTime("4")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("All day")).toBeNull();
    expect(parseTimeRange("4:30 PM - 5:30 PM")).toEqual({ start: "16:30:00", end: "17:30:00" });
    expect(parseTimeRange("4:30 - 5:30 PM")).toEqual({ start: "16:30:00", end: "17:30:00" });
    expect(parseTimeRange("11:30 - 12:30 PM")).toEqual({ start: "11:30:00", end: "12:30:00" });
    expect(parseTimeRange("6:00 AM to 7:00 AM")).toEqual({ start: "06:00:00", end: "07:00:00" });
    expect(parseTimeRange("TBD")).toBeNull();

    // The generic date-time type (used by other presets) reads the same shapes, in the facility timezone.
    expect(parseDateTime("Nov 14, 2026 4:30 PM", TZ).value?.iso).toBe("2026-11-14T21:30:00.000Z");
    expect(parseDateTime("Sat, Nov 14, 2026 at 4:30 PM", TZ).value?.iso).toBe("2026-11-14T21:30:00.000Z");
    expect(parseDateTime("3/9/2026 1:30 PM", TZ).value?.iso).toBe("2026-03-09T17:30:00.000Z");
    expect(parseDateTime("2026-03-08T01:30:00-05:00", TZ).value?.iso).toBe("2026-03-08T06:30:00.000Z");
    expect(parseDateTime("Nov 14, 2026", TZ).warning).toMatch(/start of day/);
  });

  it("removes NUL bytes from cells instead of failing the file", () => {
    const parsed = parseCsvText("First Name,Last Name\nNi\u0000ko,Madeup\n\u0000,Pretend\n");
    expect(parsed.rows[0]["First Name"]).toBe("Niko");
    expect(parsed.rows[1]["First Name"]).toBeNull();
  });
});

describe("Bill grid rows", () => {
  const base = { "First Name": "Niko", "Last Name": "Madeup", Description: "Sports Performance 2x per Week", "Due Date": "Nov 14, 2026", "Amount Due": "$178.99", "Amount Paid": "$178.99", "Amount Unpaid": "$0.00", "Paid On Time": "Yes", Status: "PAID" };

  it("maps the real header spellings, including a Number column as the bill number", () => {
    const m = autoMap(zpBillGrid, ["Number", "First Name", "Last Name", "Birth Date", "Email", "Membership Label", "Due Date", "Bill Date", "Payment Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Discount Total", "Paid On Time", "Status"]);
    expect(m).toMatchObject({ bill_id: "Number", description: "Membership Label", due_date: "Due Date", bill_date: "Bill Date", paid_date: "Payment Date", amount_unpaid: "Amount Unpaid", status: "Status" });
    expect(missingRequired(zpBillGrid, m)).toEqual([]);
    // A file with no date column at all is stopped at mapping, with the reason, not row by row.
    expect(missingRequired(zpBillGrid, autoMap(zpBillGrid, ["First Name", "Last Name", "Amount Due"]))).toEqual(["A date: Due Date, Bill Date or Payment Date"]);
    // An account-name column identifies the person when there are no first and last name columns.
    expect(autoMap(zpBillGrid, ["Acct Name", "Due Date"]).full_name).toBe("Acct Name");
  });

  it("reads month-name dates, capital status words and ON/OFF", () => {
    const r = row(zpBillGrid, { ...base, Number: "B-1001", "Paid On Time": "ON" });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ dueDate: "2026-11-14", amountDueMinor: 17899, amountPaidMinor: 17899, amountUnpaidMinor: 0, paidOnTime: true, zpStatus: "PAID" });
    expect(r.sourceRecordId).toBe("B-1001");
    expect(row(zpBillGrid, { ...base, "Paid On Time": "OFF" }).data.paidOnTime).toBe(false);
    expect(row(zpBillGrid, { ...base, "Due Date": "Nov 14, 2026 4:30 PM" }).data.dueDate).toBe("2026-11-14");
  });

  it("keeps credits and refunds negative and flags them", () => {
    for (const text of ["(45.00)", "-45.00", "-$45.00"]) {
      const r = row(zpBillGrid, { ...base, "Amount Due": text, "Amount Paid": null, "Amount Unpaid": null });
      expect(r.errors).toEqual([]);
      expect(r.data.amountDueMinor).toBe(-4500);
      expect(r.warnings.join(" ")).toMatch(/Negative amount/);
    }
  });

  it("leaves an unreadable amount or yes/no empty with a warning instead of rejecting the row", () => {
    const r = row(zpBillGrid, { ...base, "Amount Paid": "ERROR", "Paid On Time": "ERROR" });
    expect(r.errors).toEqual([]);
    expect(r.data.amountPaidMinor).toBeNull();
    expect(r.data.paidOnTime).toBeNull();
    expect(r.warnings).toEqual(expect.arrayContaining(['Amount Paid: "ERROR" is not an amount; left empty.', 'Paid On Time: "ERROR" is not Yes/No; left empty.']));
  });

  it("blank cells: amounts stay empty (never 0), a blank Due Date falls back to another date, no date at all rejects only that row", () => {
    const blankAmounts = row(zpBillGrid, { ...base, "Amount Due": null, "Amount Paid": "", "Amount Unpaid": "N/A", "Paid On Time": null, Status: null });
    expect(blankAmounts.errors).toEqual([]);
    expect(blankAmounts.data).toMatchObject({ amountDueMinor: null, amountPaidMinor: null, amountUnpaidMinor: null, paidOnTime: null, zpStatus: null });

    const fromBillDate = row(zpBillGrid, { ...base, "Due Date": null, "Bill Date": "Nov 1, 2026", "Payment Date": "Nov 3, 2026" });
    expect(fromBillDate.errors).toEqual([]);
    expect(fromBillDate.data.dueDate).toBe("2026-11-01");
    expect(fromBillDate.warnings).toContain("No Due Date; filed under its Bill Date.");
    const fromPaid = row(zpBillGrid, { ...base, "Due Date": "pending", "Bill Date": null, "Payment Date": "11/03/2026" });
    expect(fromPaid.data.dueDate).toBe("2026-11-03");
    expect(fromPaid.warnings).toEqual(expect.arrayContaining(['Due Date: unrecognized date "pending"; ignored.', "No Due Date; filed under its Payment Date."]));

    const none = row(zpBillGrid, { ...base, "Due Date": null, "Bill Date": null });
    expect(none.errors).toEqual(["No usable Due Date, Bill Date or Payment Date: a bill needs a date to be kept as history."]);
    expect(row(zpBillGrid, { ...base, "Due Date": "01/05/1900" }).errors[0]).toMatch(/outside the years a bill can belong to/);
  });

  it("flags amounts that do not add up, and identifies people with no birth date", () => {
    const r = row(zpBillGrid, { ...base, "Amount Paid": "$100.00", "Amount Unpaid": "$0.00" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/does not equal Amount Unpaid/);
    expect(r.identity).toMatchObject({ firstName: "Niko", lastName: "Madeup", dob: null, needsAthlete: false });
    expect(row(zpBillGrid, { ...base, "First Name": null, "Last Name": null }).errors[0]).toMatch(/Person not identifiable/);
  });
});

describe("Attendance grid rows", () => {
  const base = { "First Name": "Niko", "Last Name": "Madeup", Date: "Nov 14, 2026", Time: "4:30 PM", "Att.": "Yes", Program: "Sports Performance" };

  it("maps the real header spellings; a Status column can stand in for Att.", () => {
    const m = autoMap(zpAttendanceGrid, ["Number", "First Name", "Last Name", "Date", "Time", "Att.", "Rsvp", "Canceled", "Session Type", "Program", "Location", "Staff Member", "Status"]);
    expect(m).toMatchObject({ attendance_id: "Number", date: "Date", time: "Time", att: "Att.", att_status: "Status", staff: "Staff Member" });
    expect(missingRequired(zpAttendanceGrid, m)).toEqual([]);
    expect(missingRequired(zpAttendanceGrid, autoMap(zpAttendanceGrid, ["First Name", "Last Name", "Date", "Status"]))).toEqual([]);
    expect(missingRequired(zpAttendanceGrid, autoMap(zpAttendanceGrid, ["First Name", "Last Name", "Date"]))).toEqual(["Att. (or a Status column that says who attended)"]);
  });

  it("reads a date-time in the Date column, with or without a Time column", () => {
    const a = row(zpAttendanceGrid, { ...base, Date: "Nov 14, 2026 4:30 PM", Time: null });
    expect(a.errors).toEqual([]);
    expect(a.data).toMatchObject({ date: "2026-11-14", time: "16:30:00", startsAt: "2026-11-14T21:30:00.000Z", status: "attended" });
    const noTimeColumn = row(zpAttendanceGrid, { "First Name": "Niko", "Last Name": "Madeup", Date: "Sat, Nov 14, 2026 at 4:30 PM", "Att.": "Yes" });
    expect(noTimeColumn.data.startsAt).toBe("2026-11-14T21:30:00.000Z");
    // The Time column wins when both carry a time; a range sets the session length.
    const range = row(zpAttendanceGrid, { ...base, Date: "Nov 14, 2026 9:00 AM", Time: "4:30 PM - 5:15 PM" });
    expect(range.data).toMatchObject({ time: "16:30:00", durationMinutes: 45 });
    expect(row(zpAttendanceGrid, base).data.durationMinutes).toBe(60);
  });

  it("accepts ON / OFF, capitals and other yes or no words in Att.", () => {
    for (const yes of ["Yes", "YES", "ON", "on", "TRUE", "Y", "1", "X", "Attended"]) expect(row(zpAttendanceGrid, { ...base, "Att.": yes }).data.status, yes).toBe("attended");
    for (const no of ["No", "NO", "OFF", "off", "FALSE", "N", "0"]) {
      const r = row(zpAttendanceGrid, { ...base, "Att.": no });
      expect(r.errors, no).toEqual([]);
      expect(r.data, no).toMatchObject({ status: "not_checkin", skipReason: "Att. is not Yes: not a visit" });
    }
  });

  it("a blank Att. cell is not a visit and is skipped, never rejected", () => {
    const r = row(zpAttendanceGrid, { ...base, "Att.": null, Rsvp: "ON" });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ status: "not_checkin", skipReason: "Rsvp only, Att. is blank: not a visit", rsvp: true });
    expect(row(zpAttendanceGrid, { ...base, "Att.": "" }).data.skipReason).toBe("Att. is blank: not a visit");
  });

  it("an Att. value that is neither yes nor no rejects that row with a readable reason", () => {
    const r = row(zpAttendanceGrid, { ...base, "Att.": "ERROR" });
    expect(r.errors).toEqual(['Att. "ERROR" is neither yes nor no: this row cannot be counted or skipped safely.']);
  });

  it("status words in capitals decide only when Att. is blank or missing", () => {
    const noAtt = { "First Name": "Niko", "Last Name": "Madeup", Date: "Nov 14, 2026", Time: "4:30 PM" };
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "ATTENDED" }).data.status).toBe("attended");
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "Checked In" }).data.status).toBe("attended");
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "NO SHOW" }).data).toMatchObject({ status: "not_checkin", skipReason: "No show: not a visit" });
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "LATE CANCEL" }).data.skipReason).toBe("Canceled: not a visit");
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "RESERVED" }).data.skipReason).toBe("Reserved only: not a visit");
    expect(row(zpAttendanceGrid, { ...noAtt, Status: "Maybe" }).errors[0]).toMatch(/Status "Maybe" is not a word this import knows/);
    // Att. still decides when both are present.
    const both = row(zpAttendanceGrid, { ...base, "Att.": "ON", Status: "CANCELLED" });
    expect(both.data.status).toBe("attended");
    expect(both.warnings.join(" ")).toMatch(/counted as a visit because Att. decides/);
  });

  it("an unreadable time keeps the visit at the start of the day; an unreadable or implausible date rejects only that row", () => {
    const odd = row(zpAttendanceGrid, { ...base, Time: "All day" });
    expect(odd.errors).toEqual([]);
    expect(odd.data).toMatchObject({ status: "attended", time: null, startsAt: "2026-11-14T05:00:00.000Z" });
    expect(odd.warnings).toContain('Time "All day" is not a time; the visit is placed at the start of the day.');
    expect(row(zpAttendanceGrid, { ...base, Date: "last Tuesday" }).errors).toEqual(['Date: unrecognized date "last Tuesday".']);
    expect(row(zpAttendanceGrid, { ...base, Date: null }).errors).toEqual(["Date is empty."]);
    expect(row(zpAttendanceGrid, { ...base, Date: "11/14/2126" }).errors[0]).toMatch(/outside the years a visit can belong to/);
    expect(row(zpAttendanceGrid, { ...base, Date: "Nov 20, 2026" }).warnings.join(" ")).toMatch(/date in the future/);
  });

  it("a Number column never collapses a person's visits into one, whatever the column really is", () => {
    const a = row(zpAttendanceGrid, { ...base, Number: "7001" });
    const b = row(zpAttendanceGrid, { ...base, Number: "7001", Date: "Nov 15, 2026" });
    const c = row(zpAttendanceGrid, { ...base, Number: "7002" });
    expect(new Set([a.sourceRecordId, b.sourceRecordId, c.sourceRecordId]).size).toBe(3);
    // Without the column the id is what it always was, so earlier imports still de-duplicate.
    expect(row(zpAttendanceGrid, base).sourceRecordId).toBe(row(zpAttendanceGrid, { ...base, Rsvp: "Yes" }).sourceRecordId);
    expect(row(zpAttendanceGrid, base).sourceRecordId).not.toBe(a.sourceRecordId);
  });
});

describe("row-level rejection at commit", () => {
  it("explains database refusals in plain words and lets transaction-level failures through", () => {
    const pg = (code: string, extra: Record<string, string> = {}) => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error(`pg ${code}`), { code, severity: "ERROR", ...extra }) });
    expect(rowRejectionReason(pg("23514", { constraint: "memberships_in_season_fixed_term_ck", table: "memberships" }))).toBe("An In Season membership needs both an end date and a cancel date.");
    expect(rowRejectionReason(pg("23514", { constraint: "some_new_ck", table: "zp_bills" }))).toBe('The hub\'s rule "some_new_ck" on zp bills does not allow this row\'s values.');
    expect(rowRejectionReason(pg("23502", { column: "due_date", table: "zp_bills" }))).toBe("A required value is missing: due date on zp bills.");
    expect(rowRejectionReason(pg("23503", { constraint: "zp_bills_person_id_people_id_fk", table: "zp_bills" }))).toMatch(/points at a record that does not exist/);
    expect(rowRejectionReason(pg("23P01", { constraint: "sessions_coach_no_overlap" }))).toBe("The coach already has a session at that time.");
    expect(rowRejectionReason(pg("22007"))).toMatch(/date or time in this row cannot be stored/);
    expect(rowRejectionReason(pg("22003"))).toBe("A number in this row is too large to store.");
    expect(rowRejectionReason(new UserError("Not enough credits."))).toBe("Not enough credits.");
    expect(rowRejectionReason(new Error("Row 9: no person resolved"))).toBe("Could not be imported: Row 9: no person resolved");
    // Not about the row: the whole commit must fail so it can be retried.
    for (const code of ["40001", "40P01", "08006", "53300", "57014", "42703", "25P02"]) expect(rowRejectionReason(pg(code)), code).toBeNull();
  });

  it("the id cache forgets what a rolled-back row cached and keeps what a committed row cached", () => {
    const c = new RowCache();
    c.set("service_type", "s1");
    c.beginRow();
    c.set("session:a", "x");
    c.set("service_type", "s1");
    c.undoRow();
    expect([...c.keys()]).toEqual(["service_type"]);
    c.beginRow();
    c.set("session:b", "y");
    c.keepRow();
    c.set("session:c", "z");
    expect([...c.keys()]).toEqual(["service_type", "session:b", "session:c"]);
  });
});

// ---------------------------------------------------------------------------
// End to end against the database
// ---------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
let ctx: Ctx;
let rod: Viewer;
const ids: Record<string, string> = {};

const person = async (key: string, first: string, last: string, extra: { dob?: string; email?: string; athlete?: boolean } = {}) => {
  const [p] = await db().insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: last, dateOfBirth: extra.dob ?? null, email: extra.email ?? null }).returning({ id: people.id });
  ids[key] = p.id;
  if (extra.athlete !== false) await db().insert(athletes).values({ orgId: ctx.orgId, personId: p.id });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const count = async (table: any, where: any): Promise<number> => (await db().select({ n: sql<number>`count(*)::int` }).from(table).where(where))[0].n;
const rowsOf = (batchId: string) => tx((t) => batchRows(t, rod, batchId, undefined, 1000));
/** A CHECK that only ever bites one made-up value inside this test's own organization. */
async function withCheck<T>(table: string, name: string, predicate: string, fn: () => Promise<T>): Promise<T> {
  await db().execute(sql.raw(`alter table ${table} add constraint ${name} check (org_id <> '${ctx.orgId}' or (${predicate})) not valid`));
  try {
    return await fn();
  } finally {
    await db().execute(sql.raw(`alter table ${table} drop constraint if exists ${name}`));
  }
}

beforeAll(async () => {
  ctx = await seedOrg(undefined, { modules: [] });
  rod = await viewerFor(ctx, "rod");
  // A family sharing one email: the parent and two children, one of them with no birth date on file.
  await person("quill", "Quill", "Madeup", { dob: "1984-02-11", email: "family.madeup@example.test", athlete: false });
  await person("niko", "Niko", "Madeup", { dob: "2011-04-02", email: "family.madeup@example.test" });
  await person("opal", "Opal", "Madeup", { email: "family.madeup@example.test" });
  // Someone with neither a birth date nor an email, and two unrelated people with one name.
  await person("pax", "Pax", "Pretend");
  await person("rowan1", "Rowan", "Invented", { dob: "2010-01-01" });
  await person("rowan2", "Rowan", "Invented", { dob: "2012-02-02" });
});
afterAll(closeTestDb);

describe("Bill grid import", () => {
  let batchId: string;
  const H = ["Number", "First Name", "Last Name", "Birth Date", "Email", "Description", "Due Date", "Bill Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Discount Total", "Paid On Time", "Status"];
  const file = () =>
    csv(H, [
      ["B-1", "Niko", "Madeup", "Apr 2, 2011", "family.madeup@example.test", "Sports Performance 2x per Week", "Nov 1, 2026", null, "$178.99", "$178.99", "$0.00", "$17.90", "ON", "PAID"],
      ["B-2", "Opal", "Madeup", null, "family.madeup@example.test", "Sports Performance 2x per Week", "Nov 1, 2026", null, "$1,234.56", null, "$1,234.56", null, "OFF", "UNPAID"],
      ["B-3", "Quill", "Madeup", null, "family.madeup@example.test", "Refund", null, "Oct 20, 2026", "(45.00)", "-45.00", "0", null, "ERROR", "REFUNDED"],
      ["B-4", "Pax", "Pretend", null, null, "Drop-in", "Nov 5, 2026", null, "$25.00", "ERROR", null, null, null, "Past Due"],
      ["B-5", "Niko", "Madeup", "Apr 2, 2011", null, "No date anywhere", null, null, "$10.00", null, null, null, null, null],
      ["B-6", null, null, null, null, "Nobody", "Nov 6, 2026", null, "$10.00", null, null, null, null, null],
      ["B-7", "Rowan", "Invented", null, null, "Two people share this name", "Nov 7, 2026", null, "$10.00", null, null, null, null, null],
      ["B-1", "Niko", "Madeup", "Apr 2, 2011", null, "Same number again", "Nov 8, 2026", null, "$1.00", null, null, null, null, null],
      ["B-8", "Niko", "Madeup", "Apr 2, 2011", null, "Tripwire", "Nov 9, 2026", null, "$666.00", null, null, null, null, null],
      ["B-9", "Niko", "Madeup", "Apr 2, 2011", null, "After the bad row", "Nov 10, 2026", null, "$20.00", "$20.00", "$0.00", null, "Yes", "Paid"],
    ]);

  it("validates odd rows one by one: nothing rejects the file", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.bill_grid", "bills-fictional.csv", file());
    batchId = r.batchId;
    const rows = await rowsOf(batchId);
    const byRow = (n: number) => rows.find((x) => x.rowNumber === n)!;
    expect(rows).toHaveLength(10);
    // Rows 6 and 7 are rejected with reasons; row 9 is the duplicate bill number; everything else goes on.
    expect(byRow(6)).toMatchObject({ status: "invalid", errors: ["No usable Due Date, Bill Date or Payment Date: a bill needs a date to be kept as history."] });
    expect(byRow(7).status).toBe("invalid");
    expect(byRow(7).errors[0]).toMatch(/Person not identifiable/);
    expect(byRow(9)).toMatchObject({ status: "duplicate" });
    // Matching: a child sharing the family email (with or without a birth date) and the parent are each a single
    // suggestion; a name with nothing else, and a name two people share, wait for a person-by-person decision.
    expect(byRow(2)).toMatchObject({ status: "needs_review", matchConfidence: "strong", matchPersonId: ids.niko });
    expect(byRow(3)).toMatchObject({ status: "needs_review", matchConfidence: "strong", matchPersonId: ids.opal });
    expect(byRow(4)).toMatchObject({ status: "needs_review", matchConfidence: "strong", matchPersonId: ids.quill });
    expect(byRow(5)).toMatchObject({ status: "needs_review", matchConfidence: "name_only", matchPersonId: ids.pax });
    expect(byRow(8)).toMatchObject({ status: "needs_review", matchConfidence: "ambiguous", matchPersonId: null });
    expect(byRow(4).warnings).toEqual(expect.arrayContaining(["No Due Date; filed under its Bill Date.", 'Paid On Time: "ERROR" is not Yes/No; left empty.', "Negative amount (a credit or refund in Zen Planner); kept as written."]));
    expect(byRow(5).warnings).toContain('Amount Paid: "ERROR" is not an amount; left empty.');
  });

  it("a row the database refuses is rejected with its reason and the rest of the file commits", async () => {
    await tx((t) => confirmStrongMatches(t, rod, batchId));
    const { confirmNameOnlyMatches, resolveIdentity } = await import("@/lib/imports/batches");
    expect(await tx((t) => confirmNameOnlyMatches(t, rod, batchId))).toBe(1);
    await tx((t) => resolveIdentity(t, rod, batchId, "name:rowan|invented||", { resolution: "link", personId: ids.rowan2 }));
    const counts = await withCheck("zp_bills", "zp_bills_test_tripwire_ck", "amount_due_minor is distinct from 66600", () => confirmAndCommit(rod, batchId));
    expect(counts).toMatchObject({ create: 6, reject: 3, skip: 1 });

    const rows = await rowsOf(batchId);
    const tripwire = rows.find((x) => x.rowNumber === 10)!;
    expect(tripwire.status).toBe("invalid");
    expect(tripwire.errors).toEqual(['Rejected at commit: The hub\'s rule "zp_bills_test_tripwire_ck" on zp bills does not allow this row\'s values.']);
    expect(tripwire.createdEntities).toEqual([]);
    expect(rows.find((x) => x.rowNumber === 11)!.status).toBe("committed");

    const bills = await db().select().from(zpBills).where(eq(zpBills.orgId, ctx.orgId));
    expect(bills.map((b) => b.sourceRecordId).sort()).toEqual(["B-1", "B-2", "B-3", "B-4", "B-7", "B-9"]);
    const bill = (id: string) => bills.find((b) => b.sourceRecordId === id)!;
    expect(bill("B-1")).toMatchObject({ personId: ids.niko, dueDate: "2026-11-01", amountDueMinor: 17899, amountPaidMinor: 17899, amountUnpaidMinor: 0, discountTotalMinor: 1790, paidOnTime: true, zpStatus: "PAID" });
    expect(bill("B-2")).toMatchObject({ personId: ids.opal, amountDueMinor: 123456, amountPaidMinor: null, paidOnTime: false, zpStatus: "UNPAID" });
    expect(bill("B-3")).toMatchObject({ personId: ids.quill, athleteId: null, dueDate: "2026-10-20", amountDueMinor: -4500, amountPaidMinor: -4500, paidOnTime: null });
    expect(bill("B-4")).toMatchObject({ personId: ids.pax, amountDueMinor: 2500, amountPaidMinor: null });
    expect(bill("B-7").personId).toBe(ids.rowan2);

    // The stats, the reconciliation counts and the downloadable CSV all carry the commit-time rejection.
    const b = await tx((t) => getBatch(t, rod, batchId));
    expect(b.status).toBe("committed");
    expect(b.stats).toMatchObject({ committed_create: 6, committed_reject: 3, status_invalid: 3 });
    const rejected = await tx((t) => rejectedRowsCsv(t, rod, batchId));
    expect(rejected).toContain("Rejected at commit");
    expect(rejected).toContain("Tripwire");
  });

  it("stays history only: no invoice, no membership, no job, no athlete record for a payer", async () => {
    expect(await count(invoices, eq(invoices.orgId, ctx.orgId))).toBe(0);
    expect(await count(memberships, eq(memberships.orgId, ctx.orgId))).toBe(0);
    expect(await count(jobs, eq(jobs.orgId, ctx.orgId))).toBe(0);
    expect(await count(athletes, eq(athletes.personId, ids.quill))).toBe(0);
  });

  it("uploading the same file again adds nothing, and the rejected row can be imported once the cause is gone", async () => {
    const again = await uploadAndValidate(rod, "zenplanner.bill_grid", "bills-fictional.csv", file());
    await tx((t) => confirmStrongMatches(t, rod, again.batchId));
    const rows = await rowsOf(again.batchId);
    // B-8 was rolled back completely (no source id left behind), so it is the one row still to import.
    expect(rows.filter((x) => (x.normalized as Record<string, unknown>)._existingLocalId).length).toBe(6);
    expect(rows.find((x) => x.rowNumber === 10)).toMatchObject({ status: "ready", matchPersonId: ids.niko });
    const counts = await confirmAndCommit(rod, again.batchId);
    expect(counts).toMatchObject({ create: 1, reject: 2 });
    expect(await count(zpBills, eq(zpBills.orgId, ctx.orgId))).toBe(7);
  });

  it("reverting removes the bills it created", async () => {
    const r = await tx((t) => revertBatch(t, rod, batchId));
    expect(r.deleted).toBe(6);
    expect(await count(zpBills, eq(zpBills.orgId, ctx.orgId))).toBe(1);
  });
});

describe("Attendance grid import", () => {
  let batchId: string;
  const H = ["First Name", "Last Name", "Birth Date", "Email", "Date", "Time", "Att.", "Rsvp", "Canceled", "Program", "Location", "Staff Member"];
  const file = () =>
    csv(H, [
      ["Niko", "Madeup", "Apr 2, 2011", "family.madeup@example.test", "Nov 9, 2026 4:30 PM", null, "ON", "ON", "OFF", "Sports Performance", "Nowhere Gym", "Coach Fictional"],
      ["Opal", "Madeup", null, "family.madeup@example.test", "Nov 9, 2026 4:30 PM", null, "ON", "ON", "OFF", "Sports Performance", "Nowhere Gym", "Coach Fictional"],
      ["Pax", "Pretend", null, null, "Nov 9, 2026", "4:30 PM - 5:15 PM", "YES", null, null, "Sports Performance", "Nowhere Gym", null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "Nov 10, 2026", "All day", "Yes", null, null, "Open Gym", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "Nov 11, 2026 4:30 PM", null, null, "ON", null, "Sports Performance", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "Nov 12, 2026 4:30 PM", null, "OFF", "ON", "ON", "Sports Performance", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "Nov 13, 2026 4:30 PM", null, "ERROR", null, null, "Sports Performance", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "someday", null, "Yes", null, null, "Sports Performance", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, null, null, "Yes", null, null, "Sports Performance", null, null],
      ["Niko", "Madeup", "Apr 2, 2011", null, "Nov 14, 2026 9:00 AM", null, "Yes", null, null, "Saturday Speed", null, null],
    ]);

  it("validates a date-time column, ON/OFF, blanks and junk row by row", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-fictional.csv", file());
    batchId = r.batchId;
    const rows = await rowsOf(batchId);
    const byRow = (n: number) => rows.find((x) => x.rowNumber === n)!;
    const data = (n: number) => byRow(n).normalized as Record<string, unknown>;
    expect(data(2)).toMatchObject({ date: "2026-11-09", time: "16:30:00", status: "attended", rsvp: true, canceled: false });
    expect(byRow(2)).toMatchObject({ status: "needs_review", matchConfidence: "strong", matchPersonId: ids.niko });
    expect(byRow(3)).toMatchObject({ matchConfidence: "strong", matchPersonId: ids.opal });
    expect(byRow(4)).toMatchObject({ matchConfidence: "name_only", matchPersonId: ids.pax });
    expect(data(4)).toMatchObject({ time: "16:30:00", durationMinutes: 45 });
    expect(byRow(5).warnings).toContain('Time "All day" is not a time; the visit is placed at the start of the day.');
    expect(data(6)).toMatchObject({ _action: "skip", _skipReason: "Rsvp only, Att. is blank: not a visit" });
    expect(data(7)).toMatchObject({ _action: "skip", _skipReason: "Canceled, Att. is not Yes: not a visit" });
    expect(byRow(8)).toMatchObject({ status: "invalid", errors: ['Att. "ERROR" is neither yes nor no: this row cannot be counted or skipped safely.'] });
    expect(byRow(9)).toMatchObject({ status: "invalid", errors: ['Date: unrecognized date "someday".'] });
    expect(byRow(10)).toMatchObject({ status: "invalid", errors: ["Date is empty."] });
    expect(r.stats).toMatchObject({ status_invalid: 3, action_skip: 2 });
  });

  it("a visit the database refuses is rejected alone; what its savepoint created is not left half-cached", async () => {
    await tx((t) => confirmStrongMatches(t, rod, batchId));
    const { confirmNameOnlyMatches } = await import("@/lib/imports/batches");
    await tx((t) => confirmNameOnlyMatches(t, rod, batchId));
    // Refuse the very first visit: its savepoint also created the imported service and the 4:30 session.
    const first = (await rowsOf(batchId)).find((x) => x.rowNumber === 2)!;
    const counts = await withCheck("bookings", "bookings_test_tripwire_ck", `idempotency_key is distinct from 'import:${first.sourceRecordId}'`, () => confirmAndCommit(rod, batchId));
    expect(counts).toMatchObject({ create: 4, reject: 4, skip: 2 });

    const rows = await rowsOf(batchId);
    expect(rows.find((x) => x.rowNumber === 2)).toMatchObject({ status: "invalid", createdEntities: [] });
    expect(rows.find((x) => x.rowNumber === 2)!.errors[0]).toMatch(/^Rejected at commit: The hub's rule "bookings_test_tripwire_ck" on bookings/);
    // Opal's row re-created the service and the session the rolled-back row had made, and owns them for revert.
    const opal = rows.find((x) => x.rowNumber === 3)!;
    expect(opal.status).toBe("committed");
    expect(opal.createdEntities.map((c) => c.type).sort()).toEqual(["booking", "schedule_session", "service_type"]);
    expect(await count(serviceTypes, and(eq(serviceTypes.orgId, ctx.orgId), eq(serviceTypes.name, "Imported (Zen Planner)")))).toBe(1);

    const sessions = await db().select().from(scheduleSessions).where(and(eq(scheduleSessions.orgId, ctx.orgId), eq(scheduleSessions.status, "completed")));
    // Nov 9 4:30 PM (shared by Opal and Pax: same class, time and location), Nov 10 start of day, Nov 14 9:00 AM.
    expect(sessions.map((s) => s.startsAt.toISOString()).sort()).toEqual(["2026-11-09T21:30:00.000Z", "2026-11-10T05:00:00.000Z", "2026-11-14T14:00:00.000Z"]);
    const nov9 = sessions.find((s) => s.startsAt.toISOString() === "2026-11-09T21:30:00.000Z")!;
    expect(nov9.capacity).toBe(2);
    const booked = await db().select().from(bookings).where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner")));
    expect(booked).toHaveLength(4);
    expect(booked.every((b) => b.status === "attended" && b.creditBucketId === null)).toBe(true);
    // No source id is left pointing at anything the rolled-back row made.
    expect(await count(externalIds, and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.sourceId, first.sourceRecordId!)))).toBe(0);
  });

  it("uploading the same file again imports only the visit that was refused before", async () => {
    const again = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-fictional.csv", file());
    await tx((t) => confirmStrongMatches(t, rod, again.batchId));
    const counts = await confirmAndCommit(rod, again.batchId);
    expect(counts).toMatchObject({ create: 1, reject: 3 });
    expect(await count(bookings, and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner")))).toBe(5);
    const [row2] = await db().select().from(importRows).where(and(eq(importRows.batchId, again.batchId), eq(importRows.rowNumber, 2)));
    expect(row2.status).toBe("committed");
  });
});
