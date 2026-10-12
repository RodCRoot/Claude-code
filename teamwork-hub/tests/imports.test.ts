import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  archivedDocuments,
  bookings,
  externalIds,
  guardianships,
  householdMembers,
  importRows,
  invoices,
  jobs,
  maxes,
  memberships,
  metricValues,
  people,
  products,
  scheduleSessions,
  setLogs,
  testSessions,
  trials,
  questionnaireResponses,
  wearableObservations,
} from "@/db/schema";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, fixture, tx, uploadAndValidate, zipFolder } from "./imports.helpers";
import {
  batchRows,
  commitBatch,
  confirmStrongMatches,
  createBatch,
  resolveIdentity,
  reviewGroups,
  revertBatch,
  skipUnresolved,
} from "@/lib/imports/batches";
import { reconcile, rejectedRowsCsv } from "@/lib/imports/reconcile";
import { parseDateTime } from "@/lib/imports/normalize";
import type { Viewer } from "@/lib/authz/policy";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
let ctx: Ctx;
let rod: Viewer;

const peopleCount = async (orgId: string) => (await db().select({ n: sql<number>`count(*)::int` }).from(people).where(eq(people.orgId, orgId)))[0].n;
const rowByNumber = async (batchId: string, n: number) => (await db().select().from(importRows).where(and(eq(importRows.batchId, batchId), eq(importRows.rowNumber, n))))[0];

beforeAll(async () => {
  ctx = await seedOrg();
  rod = await viewerFor(ctx, "rod");
});
afterAll(closeTestDb);

describe("normalization", () => {
  it("keeps offsets verbatim and resolves DST overlaps/gaps explicitly", () => {
    const a = parseDateTime("2026-11-01T01:30:00-04:00", "America/Indiana/Indianapolis").value!;
    const b = parseDateTime("2026-11-01T01:30:00-05:00", "America/Indiana/Indianapolis").value!;
    expect(a.raw).toBe("2026-11-01T01:30:00-04:00");
    expect(a.iso).toBe("2026-11-01T05:30:00.000Z");
    expect(b.iso).toBe("2026-11-01T06:30:00.000Z");
    const overlap = parseDateTime("11/1/2026 1:30 AM", "America/Indiana/Indianapolis");
    expect(overlap.value!.iso).toBe("2026-11-01T05:30:00.000Z");
    expect(overlap.warning).toMatch(/occurs twice/);
    const gap = parseDateTime("2026-03-08 02:30", "America/Indiana/Indianapolis");
    expect(gap.warning).toMatch(/does not exist/);
  });
});

describe("Zen Planner members: identity matching", () => {
  let batchId: string;

  it("never auto-matches by name alone and never merges shared surname/email", async () => {
    const before = await peopleCount(ctx.orgId);
    const r = await uploadAndValidate(rod, "zenplanner.members", "members.csv", fixture("zenplanner/members.csv"));
    batchId = r.batchId;
    // Maya: exact name + DOB, single candidate → strong, still awaiting confirmation.
    const maya = await rowByNumber(batchId, 2);
    expect(maya.status).toBe("needs_review");
    expect(maya.matchConfidence).toBe("strong");
    expect(maya.matchPersonId).toBe(ctx.people.maya_parker);
    // Eli: name only (no DOB in file) → ambiguous review, no person chosen.
    const eli = await rowByNumber(batchId, 3);
    expect(eli.status).toBe("needs_review");
    expect(eli.matchConfidence).toBe("ambiguous");
    expect(eli.matchPersonId).toBeNull();
    // Chris Parker with Alex's email: two candidates, never merged.
    const chris = await rowByNumber(batchId, 6);
    expect(chris.matchConfidence).toBe("ambiguous");
    const ids = chris.matchCandidates!.map((c) => c.personId).sort();
    expect(ids).toEqual([ctx.people.alex_parker, ctx.people.chris_parker].sort());
    // Riley shares the Parker surname only → new person.
    const riley = await rowByNumber(batchId, 8);
    expect(riley.status).toBe("ready");
    expect((riley.normalized as Record<string, unknown>)._action).toBe("create");
    // Duplicate row and invalid row.
    expect((await rowByNumber(batchId, 14)).status).toBe("duplicate");
    const bad = await rowByNumber(batchId, 15);
    expect(bad.status).toBe("invalid");
    expect(bad.errors.join(" ")).toMatch(/date|email/i);
    // Nothing written yet.
    expect(await peopleCount(ctx.orgId)).toBe(before);
  });

  it("blocks commit until review rows are resolved and coverage is confirmed", async () => {
    await expect(tx((t) => commitBatch(t, rod, batchId))).rejects.toThrow(/need review/);
    const strong = await tx((t) => confirmStrongMatches(t, rod, batchId));
    expect(strong).toBeGreaterThanOrEqual(5); // Maya, Alex, Jordan, Ava, Noah
    const groups = await tx((t) => reviewGroups(t, rod, batchId));
    const eliGroup = groups.find((g) => g.identity.firstName === "Eli")!;
    await tx((t) => resolveIdentity(t, rod, batchId, eliGroup.key, { resolution: "link", personId: ctx.people.eli_parker }));
    await tx((t) => skipUnresolved(t, rod, batchId)); // Chris: skipped, not merged
    await expect(tx((t) => commitBatch(t, rod, batchId))).rejects.toThrow(/coverage/i);
  });

  it("commits: creates only new people, links existing, fills blanks without overwriting", async () => {
    const before = await peopleCount(ctx.orgId);
    const counts = await confirmAndCommit(rod, batchId);
    // Riley, Morgan, Jesse, Sky, Quinn
    expect(counts.create).toBe(5);
    expect(await peopleCount(ctx.orgId)).toBe(before + 5);
    const [chris] = await db().select().from(people).where(eq(people.id, ctx.people.chris_parker));
    expect(chris.email).toBe("chris.parker@example.test");
    const [ext] = await db()
      .select()
      .from(externalIds)
      .where(and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.source, "zenplanner"), eq(externalIds.sourceId, "ZP1001")));
    expect(ext.localId).toBe(ctx.people.maya_parker);
    const rec = await tx((t) => reconcile(t, rod, batchId));
    expect(rec.balanced).toBe(true);
    expect(rec.byStatus.invalid).toBe(1);
    const csv = await tx((t) => rejectedRowsCsv(t, rod, batchId));
    expect(csv).toMatch(/ZP1050/);
    expect(csv).toMatch(/duplicate/);
  });

  it("re-importing the same file warns and creates zero new records", async () => {
    const before = await peopleCount(ctx.orgId);
    const r = await uploadAndValidate(rod, "zenplanner.members", "members.csv", fixture("zenplanner/members.csv"));
    expect(r.duplicates.length).toBe(1);
    await tx((t) => skipUnresolved(t, rod, r.batchId)); // Chris remains a staff decision
    const counts = await confirmAndCommit(rod, r.batchId);
    expect(counts.create).toBe(0);
    expect(await peopleCount(ctx.orgId)).toBe(before);
  });
});

describe("Zen Planner family links, memberships, attendance, documents", () => {
  it("creates one household with two guardians and two children; unknown guardian rejected", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.family_links", "family_links.csv", fixture("zenplanner/family_links.csv"));
    expect(r.stats.status_invalid).toBe(1);
    expect(r.stats.needs_review ?? 0).toBe(0);
    await confirmAndCommit(rod, r.batchId);
    const rows = await tx((t) => batchRows(t, rod, r.batchId, ["committed"]));
    const hhId = rows[0].createdEntities.find((c) => c.type === "household")!.id;
    const members = await db().select().from(householdMembers).where(eq(householdMembers.householdId, hhId));
    expect(members).toHaveLength(4);
    const gIds = rows.flatMap((x) => x.createdEntities).filter((c) => c.type === "guardianship").map((c) => c.id);
    const gs = await db().select().from(guardianships).where(inArray(guardianships.id, gIds));
    expect(gs).toHaveLength(4);
    expect(gs.every((g) => g.canViewHealth === false)).toBe(true);
  });

  it("memberships are external_zenplanner with no invoices, subscriptions or jobs", async () => {
    const jobsBefore = (await db().select({ n: sql<number>`count(*)::int` }).from(jobs))[0].n;
    const r = await uploadAndValidate(rod, "zenplanner.memberships", "memberships.csv", fixture("zenplanner/memberships.csv"));
    expect(r.stats.status_invalid).toBe(1); // "Frozen-ish"
    await confirmAndCommit(rod, r.batchId);
    const ms = await db().select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.source, "zenplanner")));
    expect(ms).toHaveLength(3);
    expect(ms.every((m) => m.billingProvider === "external_zenplanner" && m.providerSubscriptionId === null)).toBe(true);
    expect(ms.map((m) => m.status).sort()).toEqual(["active", "cancelled", "on_hold"]);
    const inv = await db().select().from(invoices).where(inArray(invoices.membershipId, ms.map((m) => m.id)));
    expect(inv).toHaveLength(0);
    const prods = await db().select().from(products).where(and(eq(products.orgId, ctx.orgId), eq(products.category, "imported")));
    expect(prods.every((p) => !p.active && !p.publiclyListed)).toBe(true);
    const jobsAfter = (await db().select({ n: sql<number>`count(*)::int` }).from(jobs))[0].n;
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("attendance: private imported sessions, zenplanner bookings, RSVP skipped, DST handled", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.attendance", "attendance.csv", fixture("zenplanner/attendance.csv"));
    expect(r.stats.status_duplicate).toBe(1);
    const gap = await rowByNumber(r.batchId, 4);
    expect(gap.warnings.join(" ")).toMatch(/does not exist/);
    const overlap = await rowByNumber(r.batchId, 7);
    expect(overlap.warnings.join(" ")).toMatch(/occurs twice/);
    await confirmAndCommit(rod, r.batchId);
    const bs = await db().select().from(bookings).where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner")));
    expect(bs).toHaveLength(5); // 7 rows − 1 RSVP − 1 duplicate
    expect(bs.filter((b) => b.status === "no_show")).toHaveLength(1);
    const sessions = await db().select().from(scheduleSessions).where(inArray(scheduleSessions.id, [...new Set(bs.map((b) => b.sessionId))]));
    expect(sessions).toHaveLength(4); // Riley + Sky share the 3/7 5 PM class
    expect(sessions.every((s) => s.visibility === "private" && s.status === "completed" && /Imported from Zen Planner/.test(s.notes ?? ""))).toBe(true);
    const nov = sessions.find((s) => s.title.includes("overlap"))!;
    expect(nov.startsAt.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("documents archive: original files stored with checksum; missing file rejected", async () => {
    const r = await uploadAndValidate(rod, "zenplanner.documents_index", "documents.zip", zipFolder("zenplanner/documents"));
    expect(r.stats.status_invalid).toBe(1);
    await confirmAndCommit(rod, r.batchId);
    const docs = await db().select().from(archivedDocuments).where(eq(archivedDocuments.importBatchId, r.batchId));
    expect(docs).toHaveLength(2);
    expect(docs[0].originalSystem).toBe("zenplanner");
    expect((docs[0].originalEvidence as Record<string, unknown>).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Hawkin Cloud CSV export", () => {
  let first: string;

  it("stores trials and vendor averages separately, keeps nulls, precision, units and DST offsets", async () => {
    const r = await uploadAndValidate(rod, "hawkin.tests_csv", "tests_export.csv", fixture("hawkin/tests_export.csv"));
    first = r.batchId;
    expect(r.stats.status_duplicate).toBe(1);
    // CSV has names only → every athlete needs one confirmation.
    const groups = await tx((t) => reviewGroups(t, rod, first));
    expect(groups.map((g) => g.identity.firstName).sort()).toEqual(["Maya", "Noah"]);
    for (const g of groups) {
      const personId = g.identity.firstName === "Maya" ? ctx.people.maya_parker : ctx.people.noah_kim;
      await tx((t) => resolveIdentity(t, rod, first, g.key, { resolution: "link", personId }));
    }
    await confirmAndCommit(rod, first);

    const sessions = await db().select().from(testSessions).where(eq(testSessions.importBatchId, first));
    expect(sessions).toHaveLength(6);
    const allTrials = await db().select().from(trials).where(inArray(trials.testSessionId, sessions.map((s) => s.id)));
    expect(allTrials.filter((t) => t.isAggregate)).toHaveLength(1);
    expect(allTrials.filter((t) => !t.isAggregate)).toHaveLength(5);
    expect(allTrials.find((t) => t.isAggregate)!.aggregateKind).toBe("vendor_mean");

    const mv = await db().select().from(metricValues).where(eq(metricValues.importBatchId, first));
    const aggVals = mv.filter((m) => m.aggregation === "vendor_mean");
    expect(aggVals.length).toBeGreaterThan(0);
    // Null stays null (N/A and blank), never 0.
    const rfd2 = mv.find((m) => m.sourceRecordId === "hkcsv-0002" && m.unit === "N/s")!;
    expect(rfd2.value).toBeNull();
    expect(mv.some((m) => m.rawValue === null && m.value === 0)).toBe(false);
    // Raw precision preserved.
    const jh2 = mv.find((m) => m.sourceRecordId === "hkcsv-0002" && m.unit === "m" && m.rawValue?.startsWith("0.42"))!;
    expect(jh2.rawValue).toBe("0.4290");
    // Units from headers kept as exported (no conversion).
    expect(mv.some((m) => m.unit === "in")).toBe(true);
    expect(mv.some((m) => m.unit === "lb" && m.rawValue === "119.7")).toBe(true);
    // DST: two different instants at the same local 1:30 AM, source text preserved.
    const s4 = sessions.find((s) => s.sourceRecordId === "hkcsv-0004")!;
    const s5 = sessions.find((s) => s.sourceRecordId === "hkcsv-0005")!;
    expect(s4.sourceTimestamp).toBe("2026-11-01T01:30:00-04:00");
    expect(s4.testedAt.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(s5.testedAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // Inactive athlete kept but flagged.
    const noahTrial = allTrials.find((t) => t.testSessionId === s4.id)!;
    expect(noahTrial.sourceActive).toBe(false);

    const rec = await tx((t) => reconcile(t, rod, first));
    expect(rec.checks.nullCoercedToZero).toBe(0);
    expect(rec.checks.precisionMismatches).toBe(0);
    expect(rec.checks.unitMismatches).toBe(0);
  });

  it("overlapping re-export is idempotent: skip unchanged, update changed, create new; revert restores", async () => {
    const r = await uploadAndValidate(rod, "hawkin.tests_csv", "tests_export_overlap.csv", fixture("hawkin/tests_export_overlap.csv"));
    // Names were confirmed once → remembered as Hawkin aliases, no review now.
    expect(r.stats.needs_review ?? 0).toBe(0);
    const counts = await confirmAndCommit(rod, r.batchId);
    expect(counts).toMatchObject({ create: 1, update: 1, skip: 1 });
    const updated = await db().select().from(metricValues).where(and(eq(metricValues.sourceRecordId, "hkcsv-0004"), eq(metricValues.unit, "m")));
    expect(updated[0].rawValue).toBe("0.3810");

    const rev = await tx((t) => revertBatch(t, rod, r.batchId));
    expect(rev.alreadyReverted).toBe(false);
    const restored = await db().select().from(metricValues).where(and(eq(metricValues.sourceRecordId, "hkcsv-0004"), eq(metricValues.unit, "m")));
    expect(restored[0].rawValue).toBe("0.3800");
    expect(await db().select().from(testSessions).where(eq(testSessions.sourceRecordId, "hkcsv-0006"))).toHaveLength(0);
    // Idempotent.
    const again = await tx((t) => revertBatch(t, rod, r.batchId));
    expect(again.alreadyReverted).toBe(true);
  });

  it("revert removes only entities the batch created", async () => {
    const before = await peopleCount(ctx.orgId);
    await tx((t) => revertBatch(t, rod, first));
    expect(await db().select().from(testSessions).where(eq(testSessions.importBatchId, first))).toHaveLength(0);
    // Linked, pre-existing athletes untouched.
    expect(await peopleCount(ctx.orgId)).toBe(before);
    expect((await db().select().from(people).where(eq(people.id, ctx.people.maya_parker))).length).toBe(1);
  });
});

describe("TeamBuildr, generic and wearable files", () => {
  it("maxes keep mixed units and flag precision; invalid units/values rejected", async () => {
    const r = await uploadAndValidate(rod, "teambuildr.maxes", "maxes.csv", fixture("teambuildr/maxes.csv"));
    expect(r.stats.status_invalid).toBe(2); // blank max, "stone"
    const prec = await rowByNumber(r.batchId, 4);
    expect(prec.warnings.join(" ")).toMatch(/more than 2 decimals/);
    // Riley (name only in TeamBuildr) must be confirmed; Quinn matches by name + email? Quinn is a minor → review too.
    for (const g of await tx((t) => reviewGroups(t, rod, r.batchId))) {
      const [p] = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.firstName, g.identity.firstName!), eq(people.lastName, g.identity.lastName!)));
      await tx((t) => resolveIdentity(t, rod, r.batchId, g.key, { resolution: "link", personId: p.id }));
    }
    await confirmAndCommit(rod, r.batchId);
    const ms = await db().select().from(maxes).where(eq(maxes.importBatchId, r.batchId));
    expect(ms.map((m) => `${m.value} ${m.unit}`).sort()).toEqual(["102.25 kg", "225.00 lb", "225.13 lb", "60.50 kg"]);
  });

  it("workout log creates completed workouts with set logs; nulls preserved", async () => {
    const r = await uploadAndValidate(rod, "teambuildr.workout_log", "workout_log.csv", fixture("teambuildr/workout_log.csv"));
    expect(r.stats.status_duplicate).toBe(1);
    for (const g of await tx((t) => reviewGroups(t, rod, r.batchId))) {
      const [p] = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.firstName, g.identity.firstName!), eq(people.lastName, g.identity.lastName!)));
      await tx((t) => resolveIdentity(t, rod, r.batchId, g.key, { resolution: "link", personId: p.id }));
    }
    await confirmAndCommit(rod, r.batchId);
    const rows = await tx((t) => batchRows(t, rod, r.batchId, ["committed"]));
    const setIds = rows.flatMap((x) => x.createdEntities).filter((c) => c.type === "set_log").map((c) => c.id);
    const sets = await db().select().from(setLogs).where(inArray(setLogs.id, setIds));
    expect(sets).toHaveLength(5);
    const blank = sets.find((s) => s.load === null)!;
    expect(blank.loadUnit).toBeNull();
    expect(sets.some((s) => s.loadUnit === "kg" && s.load === "60.00")).toBe(true);
  });

  it("questionnaire answers combine per athlete/day with nulls kept", async () => {
    const r = await uploadAndValidate(rod, "teambuildr.questionnaire", "questionnaire.csv", fixture("teambuildr/questionnaire.csv"));
    for (const g of await tx((t) => reviewGroups(t, rod, r.batchId))) {
      const [p] = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.firstName, g.identity.firstName!), eq(people.lastName, g.identity.lastName!)));
      await tx((t) => resolveIdentity(t, rod, r.batchId, g.key, { resolution: "link", personId: p.id }));
    }
    await confirmAndCommit(rod, r.batchId);
    const rs = await db().select().from(questionnaireResponses).where(and(eq(questionnaireResponses.orgId, ctx.orgId), eq(questionnaireResponses.source, "teambuildr")));
    expect(rs).toHaveLength(2);
    const d2 = rs.find((x) => x.forDate === "2026-03-08")!;
    expect(d2.answers.soreness_1_5).toBeNull();
    expect(d2.answers.sleep_quality_1_5).toBe(3);
  });

  it("generic people: strong match linked, new people created; revert deletes only those", async () => {
    const r = await uploadAndValidate(rod, "generic.people", "people.json", fixture("generic/people.json"));
    const groups = await tx((t) => reviewGroups(t, rod, r.batchId));
    // Dana: exact name + DOB → strong; Sam Rivera: name only → ambiguous.
    expect(groups.find((g) => g.identity.firstName === "Dana")!.confidence).toBe("strong");
    expect(groups.find((g) => g.identity.firstName === "Sam")!.confidence).toBe("ambiguous");
    await tx((t) => confirmStrongMatches(t, rod, r.batchId));
    await tx((t) => skipUnresolved(t, rod, r.batchId));
    const before = await peopleCount(ctx.orgId);
    await confirmAndCommit(rod, r.batchId);
    expect(await peopleCount(ctx.orgId)).toBe(before + 2);

    // Metric values and wearable data for the new person (Rowan, GEN-1).
    const m = await uploadAndValidate(rod, "generic.metric_values", "metric_values.csv", fixture("generic/metric_values.csv"));
    expect(m.stats.needs_review ?? 0).toBe(0);
    await confirmAndCommit(rod, m.batchId);
    const mv = await db().select().from(metricValues).where(eq(metricValues.importBatchId, m.batchId));
    expect(mv.map((x) => x.unit).sort()).toEqual(["cm", "in", "in", "s", "s"]);
    expect(mv.find((x) => x.sourceRecordId === "R-3")!.value).toBeNull();
    expect(mv.find((x) => x.sourceRecordId === "R-4")!.recordedAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(mv.find((x) => x.sourceRecordId === "R-1")!.rawValue).toBe("231.5");

    const w = await uploadAndValidate(rod, "wearable.daily_csv", "daily.csv", fixture("wearable/daily.csv"));
    await confirmAndCommit(rod, w.batchId);
    const obs = await db().select().from(wearableObservations).where(eq(wearableObservations.importBatchId, w.batchId));
    expect(obs).toHaveLength(4);
    const missing = obs.find((o) => o.value === null)!;
    expect(missing.quality).toBe("missing");

    // Revert the wearable + metric batches, then the people batch: Dana (linked) survives.
    await tx((t) => revertBatch(t, rod, w.batchId));
    await tx((t) => revertBatch(t, rod, m.batchId));
    const rv = await tx((t) => revertBatch(t, rod, r.batchId));
    expect(rv.kept).toEqual([]);
    expect(await peopleCount(ctx.orgId)).toBe(before);
    expect((await db().select().from(people).where(eq(people.id, ctx.people.dana_brooks))).length).toBe(1);
    const ext = await db().select().from(externalIds).where(and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.source, "generic")));
    expect(ext).toHaveLength(0);
  });
});

describe("authorization", () => {
  it("only owner/admin can import", async () => {
    for (const k of ["erin", "marcus", "alex", "maya"]) {
      const v = await viewerFor(ctx, k);
      await expect(tx((t) => createBatch(t, v, { filename: "m.csv", bytes: fixture("zenplanner/members.csv"), schemaId: "zenplanner.members" }))).rejects.toThrow(/permission/);
    }
  });
});
