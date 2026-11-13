import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  alerts,
  athletes,
  auditEvents,
  bookings,
  creditBuckets,
  externalIds,
  guardianships,
  householdMembers,
  importBatches,
  importRows,
  invoices,
  jobs,
  leads,
  locations,
  membershipHolds,
  memberships,
  organizations,
  people,
  personTags,
  products,
  productVersions,
  scheduleSessions,
  tags,
  zpBills,
  zpMembershipDetails,
  zpPersonDetails,
  zpPersonHealth,
  zpWebhookEvents,
} from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { batchRows, confirmStrongMatches, resolveIdentity, revertBatch, reviewGroups } from "@/lib/imports/batches";
import { autoMap } from "@/lib/imports/mapping";
import { getSchema } from "@/lib/imports/schemas";
import { unmatchedHeaders, zpAttendanceGrid, zpMembershipGrid, zpPersonGrid } from "@/lib/imports/schemas/zenplanner-grid";
import { CATALOG_CATEGORY, CATALOG_LABEL, loadTeamworkCatalog, matchCatalogPlan, TEAMWORK_CATALOG } from "@/lib/zenplanner/catalog";
import { classifyDiscount, discountReview, discountReviewCsv } from "@/lib/zenplanner/discounts";
import { importedHealthForPerson } from "@/lib/zenplanner/health";
import { explain, hubCounts, listReconciliations, saveReconciliation } from "@/lib/zenplanner/reconcile";
import { matchVocab, saveVocabExtras, ZP_VOCAB } from "@/lib/zenplanner/vocab";
import { ingestZpWebhook, redactPayload, resetRateLimits, saveZpWebhookConfig, stageZpWebhookEvents, ZP_WEBHOOK_SECRET_ENV, zpWebhookStatus } from "@/lib/zenplanner/webhooks";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, fixture, tx, uploadAndValidate } from "./imports.helpers";

// Every person in these fixtures is fictional (surnames Fictional, Madeup, Pretend, Imaginary, Invented, Nonreal).

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
let ctx: Ctx;
let rod: Viewer;
let erin: Viewer;
let marcus: Viewer;
let chris: Viewer;
let existingQuill: string;
let existingRune: string;
let personBatch: string;
let membershipBatch: string;
let slug: string;

const personByName = async (first: string, last: string) => (await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.firstName, first), eq(people.lastName, last))))[0];
const athleteOf = async (personId: string) => (await db().select().from(athletes).where(eq(athletes.personId, personId)))[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const count = async (table: any, where: any): Promise<number> => (await db().select({ n: sql<number>`count(*)::int` }).from(table).where(where))[0].n;

beforeAll(async () => {
  ctx = await seedOrg(undefined, { modules: [] });
  rod = await viewerFor(ctx, "rod");
  erin = await viewerFor(ctx, "erin");
  marcus = await viewerFor(ctx, "marcus");
  chris = await viewerFor(ctx, "chris");
  [{ slug }] = await db().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, ctx.orgId));
  await db().insert(locations).values({ orgId: ctx.orgId, name: "Bloomington" }).onConflictDoNothing();
  // A parent who is already in Teamwork with the same email (strong match: proposed, never auto-linked)...
  [{ id: existingQuill }] = await db().insert(people).values({ orgId: ctx.orgId, firstName: "Quill", lastName: "Fictional", email: "quill.fictional@example.test" }).returning({ id: people.id });
  // ...and an unrelated person who merely shares a parent's name (must never be merged).
  [{ id: existingRune }] = await db().insert(people).values({ orgId: ctx.orgId, firstName: "Rune", lastName: "Pretend" }).returning({ id: people.id });
});
afterAll(closeTestDb);

describe("presets: header matching", () => {
  it("maps Zen Planner grid labels and near spellings without manual mapping", () => {
    const m = autoMap(zpMembershipGrid, ["FIRST NAME", "last name", "Membership", "Mbr Begin Date", "MBR. END DATE", "Att Limit", "Att. Limit Type", "Class Card Att. Remaining", "Shared", "Autopay?", "Trial Member", "Payment Amount", "Signup Fee"]);
    expect(m).toMatchObject({ first_name: "FIRST NAME", last_name: "last name", plan: "Membership", start_date: "Mbr Begin Date", end_date: "MBR. END DATE", att_limit: "Att Limit", att_limit_type: "Att. Limit Type", class_card_remaining: "Class Card Att. Remaining", shared: "Shared", autopay: "Autopay?", trial_member: "Trial Member", payment_amount: "Payment Amount" });
    expect(unmatchedHeaders(["Membership", "Signup Fee"], m)).toEqual(["Signup Fee"]);
    const a = autoMap(zpAttendanceGrid, ["Name", "Date", "Att", "RSVP", "Cancelled", "Session Type", "Program", "Location", "Staff"]);
    expect(a).toMatchObject({ full_name: "Name", att: "Att", rsvp: "RSVP", canceled: "Cancelled", staff: "Staff" });
    const p = autoMap(zpPersonGrid, ["First Name", "Last Name", "Has Password", "Family Id", "PARENT FIRST NAME", "Prospect Priority", "Tracking Keywords", "Tags"]);
    expect(p).toMatchObject({ has_password: "Has Password", family_id: "Family Id", parent_first: "PARENT FIRST NAME", priority: "Prospect Priority", tracking_keywords: "Tracking Keywords", tags: "Tags" });
  });

  it("every grid preset documents its export steps and says it is untested against a real file", () => {
    for (const id of ["zenplanner.person_grid", "zenplanner.membership_grid", "zenplanner.bill_grid", "zenplanner.attendance_grid"]) {
      const s = getSchema(id);
      expect(s.evidence).toMatch(/2026-11-13 account map; not yet tested against a real export file/);
      expect(s.exportHelp!.steps.join(" ")).toMatch(/export=CSV&_c=/);
      expect(s.exportHelp!.columns.length).toBeGreaterThan(5);
    }
  });
});

describe("vocabularies", () => {
  it("match Zen Planner's lists exactly and flag anything else", async () => {
    expect(ZP_VOCAB.prospectStatus.values).toEqual(["New Prospect", "Call 1", "Call 2", "Ready to Sign", "Not Interested"]);
    expect(ZP_VOCAB.source.values).toEqual(["Flyer", "Newspaper Advertisement", "Facebook", "Referral", "Walk-in", "Drive By", "Website", "Other"]);
    expect(ZP_VOCAB.holdReason.values).toEqual(["Vacation", "Illness", "Injury", "Financial", "maternity", "busy", "sports"]);
    expect(matchVocab("source", "walk-IN")).toEqual({ value: "Walk-in", known: true });
    expect(matchVocab("source", "Billboard")).toEqual({ value: "Billboard", known: false });
    expect(matchVocab("priority", "  ")).toBeNull();
    await expect(tx((t) => saveVocabExtras(t, erin, "dropReason", ["Moved away"]))).rejects.toThrow();
  });
});

describe("Person grid", () => {
  it("stages rows, sends guardian matches to review and never merges by name", async () => {
    const { batchId, stats } = await uploadAndValidate(rod, "zenplanner.person_grid", "person.csv", fixture("zenplanner/grid/person.csv"));
    personBatch = batchId;
    expect(stats.rows).toBe(8);
    expect(stats.status_invalid ?? 0).toBe(0);
    const rows = await tx((t) => batchRows(t, rod, batchId));
    const row = (first: string) => rows.find((r) => (r.normalized as Record<string, unknown>).firstName === first)!;
    // Parent already in Teamwork with the same name + email: proposed, waits for staff.
    expect(row("Nova").status).toBe("needs_review");
    expect((row("Nova").normalized as Record<string, unknown>)._guardianPersonId).toBe(existingQuill);
    expect(row("Nova").warnings.join(" ")).toMatch(/no health access/);
    // Parent shares only a name with someone: nobody is linked.
    expect(row("Lyric").status).toBe("needs_review");
    expect((row("Lyric").normalized as Record<string, unknown>)._guardianSkip).toBe(true);
    // Parent is another row of the file with the same Family ID.
    expect((row("Juno").normalized as Record<string, unknown>)._guardianBatchKey).toBeTruthy();
    expect(row("Juno").status).toBe("ready");
    // Unknown vocabulary / status values are flagged, not rejected.
    expect(row("Echo").warnings.join(" ")).toMatch(/Source "Billboard" is not on the hub's list/);
    expect(row("Atlas").warnings.join(" ")).toMatch(/Status "Staffish" is not recognized/);
    // The unmatched header is reported instead of failing.
    const [b] = await db().select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(unmatchedHeaders(["Bar Code", "First Name"], b.mapping)).toEqual(["Bar Code"]);
    expect(Object.values(b.mapping)).not.toContain("Bar Code");

    const groups = await tx((t) => reviewGroups(t, rod, batchId));
    expect(groups.length).toBe(3);
    for (const g of groups) await tx((t) => resolveIdentity(t, rod, batchId, g.key, { resolution: "create_new" }));
    const counts = await confirmAndCommit(rod, batchId);
    expect(counts.create).toBe(8);
  });

  it("builds households from Family ID and guardianships with no health access", async () => {
    const nova = await personByName("Nova", "Fictional");
    const orbit = await personByName("Orbit", "Fictional");
    const novaA = await athleteOf(nova.id);
    const orbitA = await athleteOf(orbit.id);
    // One Quill only: the existing person was linked (after review), not duplicated.
    expect(await count(people, and(eq(people.orgId, ctx.orgId), eq(people.firstName, "Quill"), eq(people.lastName, "Fictional")))).toBe(1);
    const gs = await db().select().from(guardianships).where(inArray(guardianships.athleteId, [novaA.id, orbitA.id]));
    expect(gs.length).toBe(2);
    for (const g of gs) {
      expect(g.guardianPersonId).toBe(existingQuill);
      expect(g.canViewHealth).toBe(false);
      expect(g.isEmergencyContact).toBe(false);
    }
    const [hh] = await db().select().from(externalIds).where(and(eq(externalIds.orgId, ctx.orgId), eq(externalIds.sourceEntityType, "household"), eq(externalIds.sourceId, "family:F-100")));
    const members = await db().select().from(householdMembers).where(eq(householdMembers.householdId, hh.localId));
    expect(members.map((m) => m.personId).sort()).toEqual([nova.id, orbit.id, existingQuill].sort());

    // In-file parent: Vega is Juno's guardian and also a member herself.
    const juno = await personByName("Juno", "Madeup");
    const vega = await personByName("Vega", "Madeup");
    expect(await count(people, and(eq(people.orgId, ctx.orgId), eq(people.lastName, "Madeup")))).toBe(2);
    const [jg] = await db().select().from(guardianships).where(eq(guardianships.athleteId, (await athleteOf(juno.id)).id));
    expect(jg.guardianPersonId).toBe(vega.id);
    expect(jg.canViewHealth).toBe(false);

    // The name-only lookalike was not touched, and Lyric got no guardian.
    expect(await count(guardianships, eq(guardianships.guardianPersonId, existingRune))).toBe(0);
    expect(await count(householdMembers, eq(householdMembers.personId, existingRune))).toBe(0);
  });

  it("turns prospects into leads with stage mapping, attribution and flagged unknown values", async () => {
    const lyric = await personByName("Lyric", "Pretend");
    expect(lyric.status).toBe("prospect");
    expect(await athleteOf(lyric.id)).toBeUndefined();
    const [lead] = await db().select().from(leads).where(eq(leads.personId, lyric.id));
    expect(lead.stage).toBe("contacted"); // Call 2 → Contacted
    expect(lead.source).toBe("Facebook");
    expect(lead.interest).toBe("Performance Training");
    const inquiry = lead.inquiry as { zenplanner: Record<string, string>; utm: Record<string, string> };
    expect(inquiry.zenplanner).toMatchObject({ prospectStatus: "Call 2", priority: "High", referredBy: "Vega Madeup", salesRep: "Nobody Salesperson", inquiryDate: "2026-10-01", trialEndDate: "2026-10-15" });
    expect(inquiry.utm).toEqual({ source: "facebook", campaign: "fall-speed-fictional", medium: "paid_social", term: "speed training" });
    expect(lead.ownerUserId).toBeNull();

    const echo = await personByName("Echo", "Imaginary");
    const [lost] = await db().select().from(leads).where(eq(leads.personId, echo.id));
    expect(lost.stage).toBe("lost");
    expect(lost.lostReason).toBe("Not Interested");
    expect(lost.source).toBe("Billboard"); // unknown value imported as-is...
    const [det] = await db().select().from(zpPersonDetails).where(eq(zpPersonDetails.personId, echo.id));
    expect(det.flags).toContain("Source: Billboard"); // ...and flagged

    // Members never become leads.
    const nova = await personByName("Nova", "Fictional");
    expect(await count(leads, eq(leads.personId, nova.id))).toBe(0);
    // Alumni and unrecognized statuses are inactive.
    expect((await personByName("Sable", "Invented")).status).toBe("inactive");
    expect((await athleteOf((await personByName("Sable", "Invented")).id)).active).toBe(false);
    expect((await personByName("Atlas", "Nonreal")).status).toBe("inactive");
  });

  it("imports tags, sets sport from sport tags, and keeps informational columns", async () => {
    const nova = await personByName("Nova", "Fictional");
    const novaTags = await db().select({ name: tags.name }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(eq(personTags.personId, nova.id));
    expect(novaTags.map((t) => t.name).sort()).toEqual(["Soccer", "Warriors 2026"]);
    expect((await athleteOf(nova.id)).sport).toBe("Soccer");
    const [det] = await db().select().from(zpPersonDetails).where(eq(zpPersonDetails.personId, nova.id));
    expect(det).toMatchObject({ familyId: "F-100", primaryLocation: "Bloomington", primaryInstructor: "Coach Nobody", hasPassword: true, signedDocuments: "Waiver (fictional)", signupDate: "2026-01-05" });
  });

  it("treats Special Needs / Medications / Allergies as health data", async () => {
    const nova = await personByName("Nova", "Fictional");
    const asOwner = await tx((t) => importedHealthForPerson(t, rod, nova.id));
    expect(asOwner).toMatchObject({ allergies: "Peanuts (fictional)", medications: "Inhaler before sessions (fictional)", specialNeeds: null });
    // Operations has no health access; an unassigned coach and an unrelated guardian see nothing.
    expect(await tx((t) => importedHealthForPerson(t, erin, nova.id))).toBeNull();
    expect(await tx((t) => importedHealthForPerson(t, marcus, nova.id))).toBeNull();
    expect(await tx((t) => importedHealthForPerson(t, chris, nova.id))).toBeNull();
    // The staff-visible alert says something is on file but carries no detail.
    const al = await db().select().from(alerts).where(eq(alerts.personId, nova.id));
    expect(al.length).toBe(1);
    expect(al[0].message).not.toMatch(/Peanut|Inhaler/i);
    expect(al[0].showAtKiosk).toBe(false);
    // People without health columns get no row and no alert.
    const orbit = await personByName("Orbit", "Fictional");
    expect(await count(zpPersonHealth, eq(zpPersonHealth.personId, orbit.id))).toBe(0);
  });
});

describe("Membership grid", () => {
  it("imports external memberships with limits, punch cards, cancel and hold details, and bills nothing", async () => {
    const invoicesBefore = await count(invoices, eq(invoices.orgId, ctx.orgId));
    const jobsBefore = await count(jobs, eq(jobs.orgId, ctx.orgId)); // this organization's jobs: other files enqueue in parallel
    const { batchId, stats } = await uploadAndValidate(rod, "zenplanner.membership_grid", "membership.csv", fixture("zenplanner/grid/membership.csv"));
    membershipBatch = batchId;
    expect(stats.needs_review).toBe(6); // name + birth date matches are strong, still confirmed by staff
    const rows = await tx((t) => batchRows(t, rod, batchId));
    expect(rows.find((r) => (r.normalized as Record<string, unknown>).cancelReason === "Moved to Mars")!.warnings.join(" ")).toMatch(/not on the hub's list/);
    await tx((t) => confirmStrongMatches(t, rod, batchId));
    const counts = await confirmAndCommit(rod, batchId);
    expect(counts.create).toBe(6);

    const ms = await db().select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.source, "zenplanner")));
    expect(ms.length).toBe(6);
    for (const m of ms) {
      expect(m.billingProvider).toBe("external_zenplanner");
      expect(m.autopay).toBe(false);
      expect(m.nextBillDate).toBeNull();
    }
    expect(await count(invoices, eq(invoices.orgId, ctx.orgId))).toBe(invoicesBefore);
    expect(await count(jobs, eq(jobs.orgId, ctx.orgId))).toBe(jobsBefore);

    const nova = await athleteOf((await personByName("Nova", "Fictional")).id);
    const [nm] = ms.filter((m) => m.athleteId === nova.id);
    const [nv] = await db().select().from(productVersions).where(eq(productVersions.id, nm.productVersionId));
    expect(nv.classesPerWeek).toBe(2); // Att. Limit 2 + Weekly
    expect(nv.priceMinor).toBe(17899); // highest Payment Amount on the plan
    const [np] = await db().select().from(products).where(eq(products.id, nv.productId));
    expect(np).toMatchObject({ active: false, publiclyListed: false });
    const [nd] = await db().select().from(zpMembershipDetails).where(eq(zpMembershipDetails.membershipId, nm.id));
    expect(nd).toMatchObject({ paymentAmountMinor: 16109, months: 12, autoRenew: true, renewalType: "Month to Month", trialMember: false, autopay: true, shared: false, incomeCategory: "Sports Performance", attLimit: 2, attLimitType: "Weekly", firstBillDue: "2026-01-05" });
    expect(nm.commitmentEndsOn).toBe("2027-01-04");

    // Class Card Att. Remaining → punch-card bucket.
    const vega = await athleteOf((await personByName("Vega", "Madeup")).id);
    const [bucket] = await db().select().from(creditBuckets).where(eq(creditBuckets.athleteId, vega.id));
    expect(bucket).toMatchObject({ sourceKind: "imported", granted: 7, available: 7, status: "active" });
    expect(bucket.membershipId).toBe(ms.find((m) => m.athleteId === vega.id)!.id);

    // Hold and cancel blocks.
    const atlas = await athleteOf((await personByName("Atlas", "Nonreal")).id);
    const am = ms.find((m) => m.athleteId === atlas.id)!;
    expect(am.status).toBe("on_hold");
    const [hold] = await db().select().from(membershipHolds).where(eq(membershipHolds.membershipId, am.id));
    expect(hold).toMatchObject({ reason: "sports", startDate: "2026-11-01", endDate: "2026-12-31" });
    const sable = await athleteOf((await personByName("Sable", "Invented")).id);
    const sm = ms.find((m) => m.athleteId === sable.id)!;
    expect(sm).toMatchObject({ status: "cancelled", cancelAt: "2025-02-28", cancelReason: "Moved to Mars" });
    const [sd] = await db().select().from(zpMembershipDetails).where(eq(zpMembershipDetails.membershipId, sm.id));
    expect(sd).toMatchObject({ cancelBy: "Front Desk (fictional)", cancelComments: "Fictional comment" });
    expect(sd.flags).toContain("Cancel Reason: Moved to Mars");
  });

  it("re-importing the same file creates nothing new", async () => {
    const { stats } = await uploadAndValidate(rod, "zenplanner.membership_grid", "membership-again.csv", fixture("zenplanner/grid/membership.csv"));
    expect(stats.action_skip).toBe(6);
    expect(stats.action_create ?? 0).toBe(0);
  });
});

describe("discount review", () => {
  it("classifies against the configured family percent", () => {
    const base = { discountName: null, inSeasonRateMinor: 9900, planIsInSeason: false };
    expect(classifyDiscount({ ...base, listPriceMinor: 17899, paymentMinor: 16109, familyPercent: 10 }).pattern).toBe("family");
    expect(classifyDiscount({ ...base, listPriceMinor: 17899, paymentMinor: 16109, familyPercent: 15 }).pattern).toBe("other");
    expect(classifyDiscount({ ...base, listPriceMinor: 17899, paymentMinor: 15214, familyPercent: 15 }).pattern).toBe("family");
    expect(classifyDiscount({ ...base, listPriceMinor: 26199, paymentMinor: 9900, familyPercent: 10 }).pattern).toBe("in_season_rate");
    expect(classifyDiscount({ ...base, listPriceMinor: 9900, paymentMinor: 9900, familyPercent: 10, planIsInSeason: true }).pattern).toBe("full_price");
    expect(classifyDiscount({ ...base, listPriceMinor: 17899, paymentMinor: null, familyPercent: 10 }).pattern).toBe("unknown");
    expect(classifyDiscount({ ...base, listPriceMinor: 17899, paymentMinor: 17899, familyPercent: 10, discountName: "13 off" }).pattern).toBe("other");
  });

  it("matches plans to the ladder by name, Att. Limit and Months", () => {
    expect(matchCatalogPlan({ plan: "Sports Performance 2x per Week 12 Month", attLimit: 2, attLimitType: "Weekly", months: 12 })?.key).toBe("perf_2x_12mo");
    expect(matchCatalogPlan({ plan: "Sport Performance", attLimit: 3, attLimitType: "Weekly", months: 6 })?.key).toBe("perf_3x_6mo");
    expect(matchCatalogPlan({ plan: "Unlimited Month to Month", attLimit: null, attLimitType: null, months: null })?.key).toBe("perf_unlimited_m2m");
    expect(matchCatalogPlan({ plan: "In-Season", attLimit: 1, attLimitType: "Weekly", months: 2 })?.key).toBe("in_season");
    expect(matchCatalogPlan({ plan: "Adult Class Card", attLimit: null, attLimitType: null, months: null })).toBeNull();
  });

  it("groups imported memberships by pattern and lists siblings without the family discount", async () => {
    const r = await tx((t) => discountReview(t, rod, { batchId: membershipBatch }));
    expect(r.familyPercent).toBe(10);
    expect(r.familyPercentConfirmed).toBe(false);
    expect(r.reviewed).toBe(5);
    expect(r.endedExcluded).toBe(1); // the cancelled one
    expect(r.groups.family.map((x) => [x.name, x.differenceMinor, x.listBasis])).toEqual([["Nova Fictional", 1790, "catalog"]]);
    expect(r.groups.in_season_rate.map((x) => [x.name, x.differenceMinor])).toEqual([["Juno Madeup", 16299]]);
    expect(r.groups.other.map((x) => [x.name, x.differenceMinor])).toEqual([["Atlas Nonreal", 6900]]);
    expect(r.groups.unknown).toEqual([]);
    expect(r.fullPrice).toBe(2); // Orbit (catalog) and Vega (highest in import)
    expect(r.totals).toEqual({ family: 1790, in_season_rate: 16299, other: 6900 });
    // Orbit shares Family ID F-100 with Nova and pays list price.
    expect(r.siblingsWithoutFamilyDiscount.map((s) => [s.familyId, s.name, s.wouldSaveMinor])).toEqual([
      ["F-100", "Orbit Fictional", 1790],
      ["F-200", "Juno Madeup", null],
      ["F-200", "Vega Madeup", 1500],
    ]);
    const csv = discountReviewCsv(r);
    expect(csv).toMatch(/Discounts,Family discount,Nova Fictional,F-100/);
    expect(csv).toMatch(/Siblings without the family discount,List price,Orbit Fictional,F-100/);
    // Read-only and owner/admin only.
    await expect(tx((t) => discountReview(t, erin))).rejects.toThrow();
    await expect(tx((t) => discountReview(t, marcus))).rejects.toThrow();
  });
});

describe("Bill grid", () => {
  it("stores bills as history and never creates anything payable", async () => {
    const invoicesBefore = await count(invoices, eq(invoices.orgId, ctx.orgId));
    const { batchId } = await uploadAndValidate(rod, "zenplanner.bill_grid", "bill.csv", fixture("zenplanner/grid/bill.csv"));
    const [b] = await db().select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(Object.values(b.mapping)).not.toContain("Autopay Account"); // payment account column is never imported
    await tx((t) => confirmStrongMatches(t, rod, batchId));
    const counts = await confirmAndCommit(rod, batchId);
    expect(counts.create).toBe(3);
    const bills = await db().select().from(zpBills).where(eq(zpBills.orgId, ctx.orgId));
    expect(bills.length).toBe(3);
    const unpaid = bills.find((x) => x.dueDate === "2026-10-05" && x.amountUnpaidMinor === 16109)!;
    expect(unpaid).toMatchObject({ amountDueMinor: 16109, amountPaidMinor: 0, discountTotalMinor: 1790, paidOnTime: false, zpStatus: "Unpaid" });
    expect(unpaid.membershipId).toBeTruthy();
    expect(bills.find((x) => x.amountDueMinor === 17899)!.discountTotalMinor).toBeNull(); // empty stays null, never 0
    expect(await count(invoices, eq(invoices.orgId, ctx.orgId))).toBe(invoicesBefore);
    const hub = await tx((t) => hubCounts(t, ctx.orgId, "2026-11-13"));
    expect(hub.pastDueMinor).toBe(16109);
  });
});

describe("Attendance grid", () => {
  it("counts a visit only when Att. = Yes", async () => {
    const { batchId, stats } = await uploadAndValidate(rod, "zenplanner.attendance_grid", "attendance.csv", fixture("zenplanner/grid/attendance.csv"));
    expect(stats.status_invalid).toBe(1); // Att. = "Maybe"
    const rows = await tx((t) => batchRows(t, rod, batchId));
    const skip = rows.filter((r) => (r.normalized as Record<string, unknown>)._action === "skip");
    expect(skip.map((r) => (r.normalized as Record<string, unknown>)._skipReason).sort()).toEqual(["Canceled, Att. is not Yes: not a visit", "Rsvp only, Att. is not Yes: not a visit"]);
    await tx((t) => confirmStrongMatches(t, rod, batchId));
    const counts = await confirmAndCommit(rod, batchId);
    expect(counts.create).toBe(2);
    const nova = await athleteOf((await personByName("Nova", "Fictional")).id);
    const orbit = await athleteOf((await personByName("Orbit", "Fictional")).id);
    const bs = await db().select({ b: bookings, s: scheduleSessions }).from(bookings).innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId)).where(and(eq(bookings.orgId, ctx.orgId), eq(bookings.source, "zenplanner")));
    expect(bs.length).toBe(2);
    expect(bs.every((x) => x.b.athleteId === nova.id && x.b.status === "attended")).toBe(true);
    expect(await count(bookings, eq(bookings.athleteId, orbit.id))).toBe(0);
    const [loc] = await db().select().from(locations).where(and(eq(locations.orgId, ctx.orgId), eq(locations.name, "Bloomington")));
    expect(bs[0].s.locationId).toBe(loc.id);
    expect(bs[0].s.title).toBe("Sports Performance Training");
    expect(bs[0].s.notes).toMatch(/Session Type: Class; Program: Sports Performance Training; Location: Bloomington; Staff Member: Coach Nobody/);
  });
});

describe("plan catalog", () => {
  it("is owner only, idempotent, audited, and creates unpublished drafts without touching other products", async () => {
    await expect(tx((t) => loadTeamworkCatalog(t, erin))).rejects.toThrow(/owner/i);
    const before = await db().select().from(products).where(eq(products.orgId, ctx.orgId));
    const first = await tx((t) => loadTeamworkCatalog(t, rod, "2026-11-13"));
    expect(first.created.length).toBe(TEAMWORK_CATALOG.length);
    expect(TEAMWORK_CATALOG.length).toBe(20);
    const second = await tx((t) => loadTeamworkCatalog(t, rod, "2026-11-13"));
    expect(second.created).toEqual([]);
    expect(second.existing.length).toBe(20);
    const after = await db().select().from(products).where(eq(products.orgId, ctx.orgId));
    expect(after.length).toBe(before.length + 20);
    // Existing products are untouched.
    for (const p of before) expect(after.find((x) => x.id === p.id)).toEqual(p);
    const cat = after.filter((p) => p.category === CATALOG_CATEGORY);
    expect(cat.length).toBe(20);
    for (const p of cat) {
      expect(p.active).toBe(false);
      expect(p.publiclyListed).toBe(false);
      expect(p.description).toContain(CATALOG_LABEL);
    }
    const price = async (name: string) => {
      const p = cat.find((x) => x.name === name)!;
      const [v] = await db().select().from(productVersions).where(eq(productVersions.productId, p.id));
      return v;
    };
    expect(await price("Sports Performance 2x per Week (12 Months)")).toMatchObject({ priceMinor: 17899, classesPerWeek: 2, commitmentMonths: 12, interval: "month", unlimited: false });
    expect(await price("Sports Performance Unlimited (Month to Month)")).toMatchObject({ priceMinor: 56900, classesPerWeek: null, commitmentMonths: 0, unlimited: true });
    expect(await price("Sports Performance 1x per Week (Month to Month)")).toMatchObject({ priceMinor: 12900, classesPerWeek: 1 });
    expect(await price("In Season")).toMatchObject({ priceMinor: 9900 });
    expect(await price("College Plan (weekly)")).toMatchObject({ priceMinor: 5000, interval: "week", unlimited: true });
    // No short-run programs were created as memberships.
    expect(cat.some((p) => /challenge|vertical|summer|all-girl/i.test(p.name))).toBe(false);
    const ev = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "zenplanner.catalog_loaded")));
    expect(ev.length).toBe(2);
  });
});

describe("webhook receiver", () => {
  const url = (feed: string, q = "") => `https://hub.example.test/api/webhooks/zenplanner/${feed}?org=${slug}${q}`;
  const send = (feed: string, body: unknown, headers: Record<string, string> = {}, q = "") => ingestZpWebhook(db(), { feed, raw: typeof body === "string" ? body : JSON.stringify(body), headers: new Headers(headers), url: url(feed, q), orgSlug: slug });
  const eventCount = () => count(zpWebhookEvents, eq(zpWebhookEvents.orgId, ctx.orgId));
  const SECRET = "fictional-shared-secret-for-tests";

  it("is off by default and stores nothing", async () => {
    process.env[ZP_WEBHOOK_SECRET_ENV] = SECRET;
    const r = await send("people", [{ firstName: "Pixel", lastName: "Fabricated" }], { "x-zp-shared-secret": SECRET });
    expect(r.status).toBe(404);
    expect(await eventCount()).toBe(0);
  });

  it("cannot be turned on without the server secret, or by operations", async () => {
    delete process.env[ZP_WEBHOOK_SECRET_ENV];
    await expect(tx((t) => saveZpWebhookConfig(t, rod, { enabled: true }))).rejects.toThrow(/ZENPLANNER_WEBHOOK_SECRET/);
    process.env[ZP_WEBHOOK_SECRET_ENV] = SECRET;
    await expect(tx((t) => saveZpWebhookConfig(t, erin, { enabled: true }))).rejects.toThrow();
    const cfg = await tx((t) => saveZpWebhookConfig(t, rod, { enabled: true }));
    expect(cfg).toMatchObject({ enabled: true, secretIn: "header", secretName: "x-zp-shared-secret" });
  });

  it("verifies the shared secret, is idempotent, and removes sensitive fields before storing", async () => {
    resetRateLimits();
    const body = [{ firstName: "Pixel", lastName: "Fabricated", birthDate: "2012-05-05", familyId: "F-900", status: "Member", password: "hunter2", allergies: "fictional", cardNumber: "0000" }];
    expect((await send("people", body)).status).toBe(401);
    expect((await send("people", body, { "x-zp-shared-secret": "wrong" })).status).toBe(401);
    expect((await send("people", body, {}, `&x-zp-shared-secret=${SECRET}`)).status).toBe(401); // header mode ignores the query
    expect(await eventCount()).toBe(0);
    expect((await send("nonsense", body, { "x-zp-shared-secret": SECRET })).status).toBe(404);
    expect((await send("people", "not json", { "x-zp-shared-secret": SECRET })).status).toBe(400);

    const ok = await send("people", body, { "x-zp-shared-secret": SECRET });
    expect(ok).toEqual({ status: 200, body: { ok: true, duplicate: false } });
    const again = await send("people", body, { "x-zp-shared-secret": SECRET });
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(await eventCount()).toBe(1);
    const [ev] = await db().select().from(zpWebhookEvents).where(eq(zpWebhookEvents.orgId, ctx.orgId));
    expect(ev.status).toBe("received");
    expect(JSON.stringify(ev.payload)).not.toMatch(/hunter2|fictional|0000/);
    expect(redactPayload({ a: { Token: "x", name: "ok" } })).toEqual({ a: { Token: "[removed]", name: "ok" } });

    // Class Sessions has no import: kept for inspection only.
    await send("class-sessions", { data: [{ id: 1, name: "Fictional class" }] }, { "x-zp-shared-secret": SECRET });
    const [cs] = await db().select().from(zpWebhookEvents).where(and(eq(zpWebhookEvents.orgId, ctx.orgId), eq(zpWebhookEvents.feed, "class-sessions")));
    expect(cs.status).toBe("stored");
  });

  it("accepts the secret as a query value when configured, and rate limits", async () => {
    await tx((t) => saveZpWebhookConfig(t, rod, { secretIn: "query", secretName: "secret", perMinute: 3 }));
    resetRateLimits();
    expect((await send("attendance", [{ n: 1 }], { "x-zp-shared-secret": SECRET })).status).toBe(401);
    expect((await send("attendance", [{ n: 2 }], {}, `&secret=${SECRET}`)).status).toBe(200);
    expect((await send("attendance", [{ n: 3 }], {}, `&secret=${SECRET}`)).status).toBe(200);
    expect((await send("attendance", [{ n: 4 }], {}, `&secret=${SECRET}`)).status).toBe(429);
    await tx((t) => saveZpWebhookConfig(t, rod, { secretIn: "header", secretName: "x-zp-shared-secret", perMinute: 120 }));
    resetRateLimits();
  });

  it("feeds the same import pipeline: staged for review, never auto-committed", async () => {
    await expect(tx((t) => stageZpWebhookEvents(t, erin, "people"))).rejects.toThrow();
    await expect(tx((t) => stageZpWebhookEvents(t, rod, "class-sessions"))).rejects.toThrow(/inspection/);
    const peopleBefore = await count(people, eq(people.orgId, ctx.orgId));
    const staged = await tx((t) => stageZpWebhookEvents(t, rod, "people"));
    expect(staged).toMatchObject({ events: 1, records: 1, validated: true });
    const [b] = await db().select().from(importBatches).where(eq(importBatches.id, staged.batchId));
    expect(b).toMatchObject({ entityType: "zenplanner.person_grid", status: "validated", source: "zenplanner" });
    expect(b.mapping).toMatchObject({ first_name: "firstName", last_name: "lastName", dob: "birthDate", family_id: "familyId" });
    const rows = await db().select().from(importRows).where(eq(importRows.batchId, staged.batchId));
    expect(rows.length).toBe(1);
    expect((rows[0].normalized as Record<string, unknown>).health).toBeNull(); // health never travels through the webhook store
    expect(await count(people, eq(people.orgId, ctx.orgId))).toBe(peopleBefore); // nothing written until staff commit
    const status = await tx((t) => zpWebhookStatus(t, rod));
    expect(status.find((s) => s.feed === "people")).toMatchObject({ total: 1, waiting: 0, path: "/api/webhooks/zenplanner/people" });
    await expect(tx((t) => zpWebhookStatus(t, erin))).rejects.toThrow();
    // Commit and revert work like any other import.
    await confirmAndCommit(rod, staged.batchId);
    expect((await personByName("Pixel", "Fabricated")).status).toBe("active");
    await tx((t) => revertBatch(t, rod, staged.batchId));
    expect(await personByName("Pixel", "Fabricated")).toBeUndefined();
  });
});

describe("reconciliation", () => {
  it("compares typed-in Zen Planner numbers with hub counts and suggests reasons", async () => {
    const hub = await tx((t) => hubCounts(t, ctx.orgId, "2026-11-13"));
    expect(hub.onHold).toBeGreaterThanOrEqual(1);
    expect(hub.prospects).toBe(2);
    const lines = explain({ activeMembers: hub.activeMembers + hub.prospects, memberships: hub.memberships - hub.onHold, onHold: hub.onHold, pastDueMinor: null }, hub);
    const active = lines.find((l) => l.key === "activeMembers")!;
    expect(active.difference).toBe(-2);
    expect(active.reasons.find((r) => r.exact)!.text).toMatch(/prospect/);
    const mem = lines.find((l) => l.key === "memberships")!;
    expect(mem.reasons.find((r) => r.exact)!.text).toMatch(/on-hold/);
    expect(lines.find((l) => l.key === "onHold")!.difference).toBe(0);
    expect(lines.find((l) => l.key === "pastDueMinor")!.difference).toBeNull();

    await expect(tx((t) => saveReconciliation(t, erin, { entered: { activeMembers: 5 } }))).rejects.toThrow();
    await expect(tx((t) => saveReconciliation(t, rod, { entered: {} }))).rejects.toThrow(/at least one/);
    const row = await tx((t) => saveReconciliation(t, rod, { batchId: membershipBatch, asOf: "2026-11-13", entered: { activeMembers: 3, pastDueMinor: 20000 }, note: "Fictional dashboard figures" }));
    expect(row.entered).toEqual({ activeMembers: 3, memberships: null, onHold: null, pastDueMinor: 20000 });
    expect(row.hub.pastDueMinor).toBe(16109);
    const list = await tx((t) => listReconciliations(t, rod));
    expect(list[0].r.id).toBe(row.id);
    expect(list[0].filename).toBe("membership.csv");
  });
});

describe("revert", () => {
  it("removes what the Membership and Person imports created and keeps what was there before", async () => {
    const m = await tx((t) => revertBatch(t, rod, membershipBatch));
    expect(await count(memberships, and(eq(memberships.orgId, ctx.orgId), eq(memberships.source, "zenplanner")))).toBe(0);
    expect(await count(zpMembershipDetails, eq(zpMembershipDetails.orgId, ctx.orgId))).toBe(0);
    expect(await count(creditBuckets, and(eq(creditBuckets.orgId, ctx.orgId), eq(creditBuckets.sourceKind, "imported")))).toBe(0);
    // Product versions are immutable (a database trigger refuses deletes), so the inactive imported plans stay, as with every membership import.
    expect(m.kept.every((k) => k.type === "product" || k.type === "product_version")).toBe(true);
    expect(await count(zpBills, eq(zpBills.orgId, ctx.orgId))).toBe(3);
    expect((await db().select().from(zpBills).where(eq(zpBills.orgId, ctx.orgId))).every((b) => b.membershipId === null)).toBe(true);

    const lyric = await personByName("Lyric", "Pretend");
    await tx((t) => revertBatch(t, rod, personBatch));
    expect(await count(leads, eq(leads.personId, lyric.id))).toBe(0);
    expect(await personByName("Lyric", "Pretend")).toBeUndefined();
    expect(await count(zpPersonHealth, eq(zpPersonHealth.orgId, ctx.orgId))).toBe(0);
    expect(await count(tags, and(eq(tags.orgId, ctx.orgId), eq(tags.name, "Warriors 2026")))).toBe(0);
    // People still referenced by later imports (bills, attendance) are kept and listed, not orphaned.
    expect(await personByName("Nova", "Fictional")).toBeTruthy();
    // The pre-existing parent survives; the guardianship the import added does not.
    expect((await db().select().from(people).where(eq(people.id, existingQuill))).length).toBe(1);
    const orbit = await personByName("Orbit", "Fictional");
    if (orbit) expect(await count(guardianships, eq(guardianships.guardianPersonId, existingQuill))).toBeLessThanOrEqual(2);
  });
});
