import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bodyRegionReports, guardianships, notes, people } from "@/db/schema";
import { searchPeople, getPersonDetail } from "@/lib/people/queries";
import { athleteTimeline } from "@/lib/people/timeline";
import { addGuardian, addNote, createAthleteFamily, revokeGuardianship, updateGuardianship } from "@/lib/people/mutations";
import { athleteCapabilities } from "@/lib/authz/policy";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

describe("directory scope", () => {
  it("coach search returns only assigned athletes and their guardians, with guardian contacts redacted", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const res = await searchPeople(testDb(), marcus, { kind: "all" });
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(ctx.people.maya_parker);
    expect(ids).not.toContain(ctx.people.eli_parker);
    expect(ids).not.toContain(ctx.people.ava_parker);
    const alexRow = res.rows.find((r) => r.id === ctx.people.alex_parker);
    expect(alexRow).toBeDefined();
    expect(alexRow!.email).toBeNull();
  });

  it("families cannot use the staff directory", async () => {
    const alex = await viewerFor(ctx, "alex");
    await expect(searchPeople(testDb(), alex, {})).rejects.toThrow();
  });

  it("guardian may open their child's page but not an unrelated same-surname child", async () => {
    const alex = await viewerFor(ctx, "alex");
    expect(await getPersonDetail(testDb(), alex, ctx.people.maya_parker)).not.toBeNull();
    await expect(getPersonDetail(testDb(), alex, ctx.people.ava_parker)).rejects.toThrow();
  });

  it("coach never receives sensitive notes", async () => {
    const db = testDb();
    const marcus = await viewerFor(ctx, "marcus");
    const rod = await viewerFor(ctx, "rod");
    await db.transaction((tx) => addNote(tx, rod, ctx.people.maya_parker, { body: "Sensitive family context", visibility: "sensitive", category: "family" }));
    const asCoach = await getPersonDetail(db, marcus, ctx.people.maya_parker);
    expect(asCoach!.notes.some((n) => n.visibility === "sensitive")).toBe(false);
    const asOwner = await getPersonDetail(db, rod, ctx.people.maya_parker);
    expect(asOwner!.notes.some((n) => n.visibility === "sensitive")).toBe(true);
    await expect(db.transaction((tx) => addNote(tx, marcus, ctx.people.maya_parker, { body: "x", visibility: "sensitive" }))).rejects.toThrow();
    // Coach cannot annotate an athlete outside scope.
    await expect(db.transaction((tx) => addNote(tx, marcus, ctx.people.eli_parker, { body: "x", visibility: "staff" }))).rejects.toThrow();
    const count = await db.select().from(notes).where(eq(notes.subjectPersonId, ctx.people.eli_parker));
    expect(count).toHaveLength(0);
  });
});

describe("registration never merges", () => {
  it("flags a duplicate email and refuses until staff confirm; then creates separate records", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const input = {
      athlete: { firstName: "Nora", lastName: "Parker", dateOfBirth: "2014-05-01" },
      guardianMode: "new",
      guardian: { firstName: "Chris", lastName: "Parker", email: "chris.parker@example.test" },
    };
    await expect(db.transaction((tx) => createAthleteFamily(tx, erin, input))).rejects.toThrow(/Possible existing record/);
    const res = await db.transaction((tx) => createAthleteFamily(tx, erin, { ...input, confirmDuplicates: true }));
    const chrisRows = await db.select().from(people).where(eq(people.email, "chris.parker@example.test"));
    expect(chrisRows.filter((p) => p.orgId === ctx.orgId)).toHaveLength(2);
    // The original Chris still has no access to the new athlete.
    const chris = await viewerFor(ctx, "chris");
    expect((await athleteCapabilities(db, chris, res.athleteId)).size).toBe(0);
  });

  it("coach cannot register athletes", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    await expect(testDb().transaction((tx) => createAthleteFamily(tx, marcus, { athlete: { firstName: "A", lastName: "B" }, guardianMode: "none" }))).rejects.toThrow();
  });
});

describe("guardian management", () => {
  it("operations can add an independent second guardian; coaches and guardians cannot", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const flags = { relationship: "stepparent", canViewTraining: true, canViewHealth: false, canBook: false, canSignForms: false, canMessageStaff: true, isEmergencyContact: false };
    const g = await db.transaction((tx) => addGuardian(tx, erin, ctx.athletes.ava, { mode: "new", guardian: { firstName: "Robin", lastName: "Parker" }, ...flags }));
    expect(g.canBook).toBe(false);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(db.transaction((tx) => updateGuardianship(tx, marcus, g.id, { ...flags, canViewHealth: true }))).rejects.toThrow();
    const alex = await viewerFor(ctx, "alex");
    const [alexLink] = await db.select().from(guardianships).where(eq(guardianships.guardianPersonId, ctx.people.alex_parker));
    await expect(db.transaction((tx) => updateGuardianship(tx, alex, alexLink.id, { ...flags, canViewHealth: true }))).rejects.toThrow();
    await expect(db.transaction((tx) => revokeGuardianship(tx, erin, g.id, ""))).rejects.toThrow(/reason/);
    await db.transaction((tx) => revokeGuardianship(tx, erin, g.id, "Added in error"));
    const [after] = await db.select().from(guardianships).where(eq(guardianships.id, g.id));
    expect(after.status).toBe("revoked");
  });
});

describe("unified timeline gating", () => {
  it("includes body-map events for Alex (health) but not for Jordan (no health)", async () => {
    const db = testDb();
    await db.insert(bodyRegionReports).values({ orgId: ctx.orgId, athleteId: ctx.athletes.maya, region: "knee", side: "left", view: "front", kind: "soreness", severity: 4 });
    const alex = await viewerFor(ctx, "alex");
    const jordan = await viewerFor(ctx, "jordan");
    const a = await athleteTimeline(db, alex, ctx.athletes.maya);
    const j = await athleteTimeline(db, jordan, ctx.athletes.maya);
    expect(a.some((e) => e.kind === "body")).toBe(true);
    expect(j.some((e) => e.kind === "body")).toBe(false);
    const erin = await viewerFor(ctx, "erin");
    expect((await athleteTimeline(db, erin, ctx.athletes.maya)).some((e) => e.kind === "body")).toBe(false);
    const chris = await viewerFor(ctx, "chris");
    await expect(athleteTimeline(db, chris, ctx.athletes.maya)).rejects.toThrow();
  });
});
