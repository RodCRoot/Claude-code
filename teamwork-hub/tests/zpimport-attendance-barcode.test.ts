import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { athletes, bookings, externalIds, people, scheduleSessions } from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { batchRows, confirmStrongMatches, skipUnresolved } from "@/lib/imports/batches";
import { autoMap, missingRequired, normalizeRow } from "@/lib/imports/mapping";
import { zpAttendanceGrid } from "@/lib/imports/schemas/zenplanner-grid";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, tx, uploadAndValidate } from "./imports.helpers";

// The confirmed shape of the real Attendance export: 51 columns, keyed by Barcode (the person's number, the same
// value as Bar Code on the Person and Membership grids), with Person as a display name. CRLF, every field quoted,
// month-name dates. Every person in this file is fictional (surnames Madeup, Pretend, Invented, Nonreal).

/** A file the way Zen Planner writes it: CRLF line ends and every field in quotes. */
const zpCsv = (headers: string[], rows: (string | null)[][]) =>
  new TextEncoder().encode([headers, ...rows].map((r) => r.map((c) => `"${(c ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n");

// A selection of the 51 columns: the ones this import reads, plus some it must leave alone.
const ATT_HEADERS = ["Barcode", "Person", "Membership", "Membership Label", "Email", "Phone", "Date", "Time", "Att.", "Rsvp", "Canceled", "Program", "Location", "Staff Member", "Status"];
const att = (barcode: string | null, person: string, date: string, time: string, extra: Partial<Record<"email" | "att" | "status" | "label", string | null>> = {}) => [
  barcode,
  person,
  "Sports Performance 2x per Week",
  extra.label ?? null,
  extra.email ?? null,
  "(555) 010-0000",
  date,
  time,
  extra.att === undefined ? "ON" : extra.att,
  "ON",
  "OFF",
  "Sports Performance",
  "Nowhere Gym",
  "Coach Fictional",
  extra.status ?? null,
];

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
let ctx: Ctx;
let rod: Viewer;

const rowsOf = (batchId: string) => tx((t) => batchRows(t, rod, batchId, undefined, 1000));
const personByBarcode = async (barcode: string) => {
  const [x] = await db()
    .select({ id: externalIds.localId })
    .from(externalIds)
    .where(and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.source, "zenplanner"), eq(externalIds.sourceEntityType, "member"), eq(externalIds.sourceId, barcode), eq(externalIds.localEntityType, "person")));
  return x?.id ?? null;
};
/** Start times of the imported visits of the person with this barcode. */
const visitsOf = async (barcode: string) => {
  const personId = await personByBarcode(barcode);
  if (!personId) return [];
  const rows = await db()
    .select({ startsAt: scheduleSessions.startsAt })
    .from(bookings)
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner"), eq(athletes.personId, personId)));
  return rows.map((r) => r.startsAt.toISOString()).sort();
};
const visitCount = async () => (await db().select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner"))))[0].n;
const sessionCount = async () => (await db().select({ n: sql<number>`count(*)::int` }).from(scheduleSessions).where(and(eq(scheduleSessions.orgId, ctx.orgId), eq(scheduleSessions.status, "completed"), sql`${scheduleSessions.notes} like 'Imported from Zen Planner%'`)))[0].n;

beforeAll(async () => {
  ctx = await seedOrg(undefined, { modules: [] });
  rod = await viewerFor(ctx, "rod");
  // The Person grid first, keyed by Bar Code. Two unrelated people share one name; one address has unescaped quotes.
  const H = ["First Name", "Last Name", "Bar Code", "Birth Date", "Email", "Status", "Address"];
  const text =
    [
      H.map((h) => `"${h}"`).join(","),
      '"Tessa","Madeup","10001","Apr 2, 2011","family.madeup@example.test","Student","1 Pretend St"',
      '"Tobias","Madeup","10002","","family.madeup@example.test","Student","1 Pretend St"," IN"," 47000"""""',
      '"Uma","Pretend","10003","","uma.pretend@example.test","Student",""',
      '"Rowan","Invented","10004","","","Student",""',
      '"Rowan","Invented","10005","","","Alumni",""',
    ].join("\r\n") + "\r\n";
  const r = await uploadAndValidate(rod, "zenplanner.person_grid", "people-fictional.csv", new TextEncoder().encode(text));
  const counts = await confirmAndCommit(rod, r.batchId);
  expect(counts).toMatchObject({ create: 5, reject: 0 });
});
afterAll(closeTestDb);

describe("Attendance grid keyed by Barcode", () => {
  it("auto-maps Barcode to the person key and Person to the full name; Membership, Membership Label and Phone are left alone", () => {
    const m = autoMap(zpAttendanceGrid, ATT_HEADERS);
    expect(m).toMatchObject({ source_person_id: "Barcode", full_name: "Person", email: "Email", date: "Date", time: "Time", att: "Att.", rsvp: "Rsvp", canceled: "Canceled", program: "Program", location: "Location", staff: "Staff Member" });
    expect(Object.values(m)).not.toContain("Membership");
    expect(Object.values(m)).not.toContain("Membership Label");
    expect(Object.values(m)).not.toContain("Phone");
    expect(m.attendance_id).toBeUndefined();
    expect(missingRequired(zpAttendanceGrid, m)).toEqual([]);
    // The Person and Membership grids spell it "Bar Code"; both spellings are the same key.
    expect(autoMap(zpAttendanceGrid, ["Bar Code", "Person", "Date", "Att."]).source_person_id).toBe("Bar Code");
  });

  it("a mistyped email or birth date on the row does not reject the visit", () => {
    const headers = [...ATT_HEADERS, "Birth Date"];
    const mapping = autoMap(zpAttendanceGrid, headers);
    const cells = Object.fromEntries(headers.map((h, i) => [h, [...att("10002", "Tobias Madeup", "Nov 3, 2025", "4:30 PM", { email: "not an email" }), "sometime in spring"][i]]));
    const r = normalizeRow(zpAttendanceGrid, cells, mapping, { orgId: ctx.orgId, tz: "America/Indiana/Indianapolis", options: {}, today: "2026-11-16", mapped: Object.keys(mapping) }, []);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(expect.arrayContaining(['Email "not an email" is not an email address; ignored.', 'Birth Date "sometime in spring" is not a date; ignored.']));
    expect(r.identity).toMatchObject({ sourceId: "10002", firstName: "Tobias", lastName: "Madeup", email: null, dob: null });
    expect(r.data.status).toBe("attended");
  });

  let first: string;
  const year2025 = () =>
    zpCsv(ATT_HEADERS, [
      // The display name is spelled differently from the Person grid on purpose: the Barcode decides.
      att("10001", "Tess Maddup", "Nov 3, 2025", "4:30 PM"),
      att("10001", "Tess Maddup", "Nov 5, 2025", "4:30 PM"),
      att("10002", "Toby Madeup", "Nov 3, 2025", "4:30 PM", { email: "not an email" }),
      // Two people share this name; with a Barcode each visit belongs to exactly one of them.
      att("10004", "Rowan Invented", "Nov 3, 2025", "4:30 PM"),
      att("10005", "Rowan Invented", "Nov 4, 2025", "4:30 PM"),
      // No Barcode on the row: the Person name and the email are the fallback, confirmed by staff.
      att(null, "Uma Pretend", "Nov 4, 2025", "4:30 PM", { email: "uma.pretend@example.test" }),
      // A Barcode nobody has (a person deleted from Zen Planner, or not in the Person export).
      att("99999", "Nobody Nonreal", "Nov 4, 2025", "4:30 PM"),
      att("99999", "Nobody Nonreal", "Nov 6, 2025", "4:30 PM"),
      // Att. blank and a Status that is about the person, not the visit: not a visit, not a rejection.
      att("10001", "Tess Maddup", "Nov 6, 2025", "4:30 PM", { att: null, status: "Student" }),
      att("10001", "Tess Maddup", "Dec 29, 2025", "4:30 PM"),
    ]);

  it("matches every visit to its person by Barcode exactly, whatever the name says", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-2025-fictional.csv", year2025());
    first = r.batchId;
    const rows = await rowsOf(first);
    const byRow = (n: number) => rows.find((x) => x.rowNumber === n)!;
    const tessa = await personByBarcode("10001");
    expect(tessa).not.toBeNull();
    const [p] = await db().select().from(people).where(eq(people.id, tessa!));
    expect(p).toMatchObject({ firstName: "Tessa", lastName: "Madeup" });

    // Rows 2 and 3 say "Tess Maddup": no person has that name, and the row still lands on Tessa with nothing to review.
    for (const n of [2, 3, 11]) expect(byRow(n), `row ${n}`).toMatchObject({ status: "ready", matchConfidence: "exact_source_id", matchPersonId: tessa });
    expect(byRow(4)).toMatchObject({ status: "ready", matchConfidence: "exact_source_id", matchPersonId: await personByBarcode("10002") });
    expect(byRow(4).warnings).toContain('Email "not an email" is not an email address; ignored.');
    expect(byRow(5)).toMatchObject({ status: "ready", matchConfidence: "exact_source_id", matchPersonId: await personByBarcode("10004") });
    expect(byRow(6)).toMatchObject({ status: "ready", matchConfidence: "exact_source_id", matchPersonId: await personByBarcode("10005") });
    expect(byRow(5).matchPersonId).not.toBe(byRow(6).matchPersonId);
    // No Barcode: the name plus email is a suggestion that staff confirm.
    expect(byRow(7)).toMatchObject({ status: "needs_review", matchConfidence: "strong", matchPersonId: await personByBarcode("10003") });
    // Unknown Barcode: only those rows wait for a decision.
    for (const n of [8, 9]) {
      expect(byRow(n), `row ${n}`).toMatchObject({ status: "needs_review", matchConfidence: "none", matchPersonId: null });
      expect(byRow(n).warnings.join(" ")).toMatch(/No matching person in Teamwork/);
    }
    expect((byRow(10).normalized as Record<string, unknown>)._skipReason).toBe("Rsvp only, Att. is blank: not a visit");
    expect(byRow(10).status).toBe("ready");
    expect(r.stats).toMatchObject({ status_needs_review: 3 });
    expect(r.stats.status_invalid ?? 0).toBe(0);
  });

  it("commits the matched visits; the rows whose Barcode matches nobody are skipped one by one", async () => {
    expect(await tx((t) => confirmStrongMatches(t, rod, first))).toBe(1);
    expect(await tx((t) => skipUnresolved(t, rod, first))).toBe(2);
    const counts = await confirmAndCommit(rod, first);
    expect(counts).toMatchObject({ create: 7, skip: 3, reject: 0 });

    // 4:30 PM in Indianapolis is 21:30 UTC in November and December.
    expect(await visitsOf("10001")).toEqual(["2025-11-03T21:30:00.000Z", "2025-11-05T21:30:00.000Z", "2025-12-29T21:30:00.000Z"]);
    expect(await visitsOf("10002")).toEqual(["2025-11-03T21:30:00.000Z"]);
    expect(await visitsOf("10004")).toEqual(["2025-11-03T21:30:00.000Z"]);
    expect(await visitsOf("10005")).toEqual(["2025-11-04T21:30:00.000Z"]);
    expect(await visitsOf("10003")).toEqual(["2025-11-04T21:30:00.000Z"]);
    expect(await visitCount()).toBe(7);
    // Nobody was created for the misspelled name or for the unknown Barcode.
    expect((await db().select({ id: people.id }).from(people).where(and(eq(people.orgId, ctx.orgId), sql`${people.lastName} in ('Maddup', 'Nonreal')`))).length).toBe(0);
    expect(await personByBarcode("99999")).toBeNull();
  });

  it("an overlapping yearly file adds only the visits that are new", async () => {
    const before = { visits: await visitCount(), sessions: await sessionCount() };
    const year2026 = zpCsv(ATT_HEADERS, [
      // Already in the 2025 file (an export range that overlaps by a week), in a different row order and name spelling.
      att("10001", "Tessa Madeup", "Dec 29, 2025", "4:30 PM"),
      att("10005", "Rowan Invented", "Nov 4, 2025", "4:30 PM"),
      // New.
      att("10001", "Tessa Madeup", "Jan 5, 2026", "4:30 PM"),
      att("10002", "Tobias Madeup", "Jan 5, 2026", "4:30 PM"),
    ]);
    const r = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-2026-fictional.csv", year2026);
    const rows = await rowsOf(r.batchId);
    expect(rows.filter((x) => (x.normalized as Record<string, unknown>)._existingLocalId).map((x) => x.rowNumber).sort()).toEqual([2, 3]);
    const counts = await confirmAndCommit(rod, r.batchId);
    expect(counts).toMatchObject({ create: 2, skip: 2, reject: 0 });
    expect(await visitCount()).toBe(before.visits + 2);
    // Tessa and Tobias share the Jan 5 session: one new session, not two.
    expect(await sessionCount()).toBe(before.sessions + 1);
    expect(await visitsOf("10001")).toEqual(["2025-11-03T21:30:00.000Z", "2025-11-05T21:30:00.000Z", "2025-12-29T21:30:00.000Z", "2026-01-05T21:30:00.000Z"]);
  });

  it("uploading a yearly file a second time creates nothing", async () => {
    const before = { visits: await visitCount(), sessions: await sessionCount(), athletes: (await db().select({ id: athletes.id }).from(athletes).where(eq(athletes.orgId, ctx.orgId))).length };
    const r = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-2025-fictional.csv", year2025());
    await tx((t) => skipUnresolved(t, rod, r.batchId));
    const counts = await confirmAndCommit(rod, r.batchId);
    expect(counts).toMatchObject({ create: 0, link: 0, update: 0, reject: 0 });
    expect(await visitCount()).toBe(before.visits);
    expect(await sessionCount()).toBe(before.sessions);
    expect((await db().select({ id: athletes.id }).from(athletes).where(eq(athletes.orgId, ctx.orgId))).length).toBe(before.athletes);
    const rows = await rowsOf(r.batchId);
    expect(rows.every((x) => x.createdEntities.length === 0)).toBe(true);
  });

  it("the visits of an unknown Barcode import once that person exists", async () => {
    const text = '"First Name","Last Name","Bar Code","Status"\r\n"Nell","Nonreal","99999","Alumni"\r\n';
    const p = await uploadAndValidate(rod, "zenplanner.person_grid", "people-late-fictional.csv", new TextEncoder().encode(text));
    expect(await confirmAndCommit(rod, p.batchId)).toMatchObject({ create: 1 });
    const r = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance-2025-fictional.csv", year2025());
    const rows = await rowsOf(r.batchId);
    for (const n of [8, 9]) expect(rows.find((x) => x.rowNumber === n), `row ${n}`).toMatchObject({ status: "ready", matchConfidence: "exact_source_id", matchPersonId: await personByBarcode("99999") });
    expect(await confirmAndCommit(rod, r.batchId)).toMatchObject({ create: 2, reject: 0 });
    // The row says "Nobody Nonreal"; the person is Nell Nonreal.
    expect(await visitsOf("99999")).toEqual(["2025-11-04T21:30:00.000Z", "2025-11-06T21:30:00.000Z"]);
  });
});
