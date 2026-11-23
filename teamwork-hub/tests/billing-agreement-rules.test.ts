/**
 * Two rules of Teamwork's member agreement, proven for memberships the hub bills itself:
 *  1. A fixed-term commitment (6 months, 12 months) rolls to month-to-month at the committed rate when the
 *     term ends. It never renews into another fixed term.
 *  2. The family rate is applied to every active member of a household when a second one enrols and removed
 *     when one leaves (the household tier itself is proven in `billing-family-rate.test.ts`).
 * Plus what the hub can only point at for memberships Zen Planner bills: a fixed term set to renew into another
 * fixed term. All people and data are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { discounts, householdMembers, households, invoices, jobs, membershipEvents, memberships, payerAccounts, payerBeneficiaries, zpMembershipDetails } from "@/db/schema";
import { createProduct, createProductVersion } from "@/lib/billing/catalog";
import { cancellationPreview, cancelMembership, createMembership } from "@/lib/billing/memberships";
import { generateRenewals } from "@/lib/billing/renewals";
import { batchRows, confirmStrongMatches } from "@/lib/imports/batches";
import { discountReview, discountReviewCsv } from "@/lib/zenplanner/discounts";
import { RENEWS_INTO_FIXED_TERM_FLAG, zpRenewalOutcome } from "@/lib/zenplanner/renewal";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { confirmAndCommit, tx, uploadAndValidate } from "./imports.helpers";

const T = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let B: Record<string, string>;
const db = () => testDb();
const rod = () => viewerFor(ctx, "rod");

beforeAll(async () => {
  ctx = await seedOrg(T);
  B = ctx.extra.billing;
});
afterAll(closeTestDb);

const start = async (athlete: string, versionId: string, startDate: string, opts: { payer?: string; today?: string } = {}) =>
  db().transaction(async (t) => createMembership(t, await rod(), { athleteId: ctx.athletes[athlete], payerAccountId: opts.payer ?? ctx.payers[athlete], productVersionId: versionId, startDate, today: opts.today ?? startDate, billingProvider: "manual" }));
const discountOf = async (membershipId: string) => {
  const [row] = await db().select({ d: discounts }).from(memberships).leftJoin(discounts, eq(discounts.id, memberships.discountId)).where(eq(memberships.id, membershipId));
  return row.d?.name ?? null;
};
const eventsOf = (membershipId: string, type: string) =>
  db()
    .select()
    .from(membershipEvents)
    .where(and(eq(membershipEvents.membershipId, membershipId), eq(membershipEvents.type, type as "commitment_ended")));

describe("term end: a fixed term rolls to month-to-month at the committed rate", () => {
  it("6-month and 12-month terms keep billing monthly at the same rate long after the term, and never start a new term", async () => {
    const v = await rod();
    const twelve = await db().transaction((t) =>
      createProduct(t, v, { name: "Test 2x per Week (12 Months)", kind: "recurring_membership", version: { priceMinor: 20000, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2020-01-01" } }),
    );
    const six = await start("harper", B.ref_perf_3x_6mo, "2025-01-01");
    const year = await start("jackson", twelve.version.id, "2025-01-01");
    expect(six.membership).toMatchObject({ commitmentStartsOn: "2025-01-01", commitmentEndsOn: "2025-06-30" });
    expect(year.membership).toMatchObject({ commitmentStartsOn: "2025-01-01", commitmentEndsOn: "2025-12-31" });

    // The plans get dearer later; a member past their term stays on the rate they committed to.
    await db().transaction((t) => createProductVersion(t, v, twelve.product.id, { priceMinor: 25000, interval: "month", classesPerWeek: 2, commitmentMonths: 12, effectiveFrom: "2026-01-01" }));

    // Run the renewal job well past both terms: the 6-month term has been over for more than 8 months (longer than
    // a second term would last), the 12-month term for more than 2. Twice, to show it is idempotent.
    for (const day of ["2026-03-15", "2026-03-15"]) await db().transaction((t) => generateRenewals(t, ctx.orgId, day));

    for (const [m, ends, rate] of [
      [six.membership, "2025-06-30", null],
      [year.membership, "2025-12-31", 20000],
    ] as const) {
      const invs = await db().select().from(invoices).where(eq(invoices.membershipId, m.id));
      // One invoice a month from Jan 2025 to Mar 2026, with no gap and no change at the end of the term.
      expect(invs.map((i) => i.periodStart).sort()).toEqual([
        "2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01",
        "2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01",
      ]);
      const totals = new Set(invs.map((i) => i.totalMinor));
      expect(totals.size).toBe(1);
      if (rate != null) expect([...totals][0]).toBe(rate);

      const [after] = await db().select().from(memberships).where(eq(memberships.id, m.id));
      // Same plan version (the committed rate), the original term dates untouched, no end set. Still a live
      // membership (past due here only because nobody paid these test invoices).
      expect(after).toMatchObject({ productVersionId: m.productVersionId, commitmentStartsOn: "2025-01-01", commitmentEndsOn: ends, cancelAt: null, endDate: null });
      expect(["active", "past_due"]).toContain(after.status);
      // Recorded once: the term ended and the membership continues month-to-month at the committed rate.
      const ended = await eventsOf(m.id, "commitment_ended");
      expect(ended).toHaveLength(1);
      expect(ended[0].details).toMatchObject({ commitmentEndsOn: ends, continues: "month_to_month_at_committed_rate", productVersionId: m.productVersionId });
      // Month-to-month means only the notice period applies: no remaining term holds the member.
      const preview = await cancellationPreview(db(), ctx.orgId, m.id, "2026-03-10");
      expect(preview.effectiveOn).toBe("2026-04-09");
    }
    // No membership for these athletes other than the two created here: nothing was "renewed" into a new record.
    const all = await db().select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, ctx.orgId), inArray(memberships.athleteId, [ctx.athletes.harper, ctx.athletes.jackson])));
    expect(all.map((m) => m.id).sort()).toEqual([six.membership.id, year.membership.id].sort());
  });
});

describe("family discount: applied when a second sibling enrols, removed when one leaves", () => {
  it("both directions, on the same day, with the next invoice following the change", async () => {
    const v = await rod();
    const [fam] = await db().insert(payerAccounts).values({ orgId: ctx.orgId, name: "Synthetic Madeup family" }).returning();
    await db().insert(payerBeneficiaries).values([{ payerAccountId: fam.id, athleteId: ctx.athletes.ethan }, { payerAccountId: fam.id, athleteId: ctx.athletes.liam }]);
    // The family rate follows the household, so the two are put in one.
    const [hh] = await db().insert(households).values({ orgId: ctx.orgId, name: "Synthetic Madeup household" }).returning();
    await db().insert(householdMembers).values([
      { householdId: hh.id, personId: await personOf("ethan"), role: "child" },
      { householdId: hh.id, personId: await personOf("liam"), role: "child" },
    ]);

    // One athlete enrolled: no discount.
    const first = await start("ethan", B.ref_perf_1x_m2m, "2026-11-01", { payer: fam.id, today: T });
    expect(await discountOf(first.membership.id)).toBeNull();

    // The second sibling enrols: both memberships carry the discount at once, with an event on each.
    const second = await start("liam", B.ref_perf_2x_m2m, "2026-11-01", { payer: fam.id, today: T });
    expect(await discountOf(first.membership.id)).toBe("Family discount 10%");
    expect(await discountOf(second.membership.id)).toBe("Family discount 10%");
    expect(await eventsOf(first.membership.id, "family_discount_applied")).toHaveLength(1);
    expect(await eventsOf(second.membership.id, "family_discount_applied")).toHaveLength(1);

    // The sibling leaves at once (staff override of the notice, with a reason): the discount comes off the other.
    const c = await db().transaction((t) =>
      cancelMembership(t, v, { membershipId: second.membership.id, requestedOn: T, requestChannel: "email", reason: "Moved away", today: T, overrideCancelAt: T, overrideReason: "Owner waived the notice period" }),
    );
    expect(c.immediate).toBe(true);
    expect(await discountOf(first.membership.id)).toBeNull();
    expect(await eventsOf(first.membership.id, "family_discount_removed")).toHaveLength(1);

    // The remaining athlete's next invoice is at the full rate.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-11-01"));
    const [nov] = await db().select().from(invoices).where(and(eq(invoices.membershipId, first.membership.id), eq(invoices.periodStart, "2026-11-01")));
    expect(nov.totalMinor).toBe(12900);

    // The sibling comes back: applied again to both.
    const back = await start("liam", B.ref_perf_2x_m2m, "2026-12-01", { payer: fam.id, today: "2026-11-02" });
    expect(await discountOf(first.membership.id)).toBe("Family discount 10%");
    expect(await discountOf(back.membership.id)).toBe("Family discount 10%");
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2026-12-01"));
    const [dec] = await db().select().from(invoices).where(and(eq(invoices.membershipId, first.membership.id), eq(invoices.periodStart, "2026-12-01")));
    // December is at 10%, less the sibling credit (owner's decision 2026-11-23): November was billed at 0% and the
    // rate rose on 2 November, 29 of 30 days left: 12900 × 10% × 29 ÷ 30 = 1247.
    expect(dec.totalMinor).toBe(12900 - 1290 - 1247);
  });

  it("eligibility follows the household, not the billing account: siblings billed to two accounts both get the family rate", async () => {
    // Two athletes in one household, each billed to a different account (for example separated co-parents).
    const [h] = await db().insert(households).values({ orgId: ctx.orgId, name: "Synthetic Pretend household" }).returning();
    await db().insert(householdMembers).values([
      { householdId: h.id, personId: ctx.people.owen_brooks ?? (await personOf("owen")), role: "child" },
      { householdId: h.id, personId: await personOf("ella"), role: "child" },
    ]);
    const a = await start("owen", B.ref_perf_1x_m2m, "2027-01-01", { today: T });
    const b = await start("ella", B.ref_perf_1x_m2m, "2027-01-01", { today: T });
    expect(a.membership.payerAccountId).not.toBe(b.membership.payerAccountId);
    expect(await discountOf(a.membership.id)).toBe("Family discount 10%");
    expect(await discountOf(b.membership.id)).toBe("Family discount 10%");
  });
});

async function personOf(athlete: string): Promise<string> {
  const { athletes } = await import("@/db/schema");
  const [a] = await db().select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, ctx.athletes[athlete]));
  return a.personId;
}

describe("imported Zen Planner memberships set to renew into another fixed term", () => {
  it("reads Months, Auto Renew and Renewal Type", () => {
    expect(zpRenewalOutcome({ months: 6, autoRenew: true, renewalType: "6 Months" })).toBe("fixed_term");
    expect(zpRenewalOutcome({ months: 12, autoRenew: true, renewalType: "Same Term" })).toBe("fixed_term");
    for (const type of ["Month to Month", "MONTH-TO-MONTH", "month to month ", "Month2Month", "Monthly", "M2M"]) expect(zpRenewalOutcome({ months: 6, autoRenew: true, renewalType: type }), type).toBe("month_to_month");
    expect(zpRenewalOutcome({ months: 6, autoRenew: true, renewalType: null })).toBe("unknown");
    expect(zpRenewalOutcome({ months: 6, autoRenew: false, renewalType: "6 Months" })).toBe("none");
    expect(zpRenewalOutcome({ months: 6, autoRenew: null, renewalType: "6 Months" })).toBe("none");
    expect(zpRenewalOutcome({ months: 1, autoRenew: true, renewalType: "6 Months" })).toBe("none");
    expect(zpRenewalOutcome({ months: null, autoRenew: true, renewalType: "6 Months" })).toBe("none");
  });

  it("flags them at import, lists and counts them in the review, and creates no charge or schedule", async () => {
    const v = await rod();
    const people = ["First Name,Last Name,Bar Code,Birth Date,Status", 'Ivo,Invented,20001,"Mar 2, 2011",Student', 'Juno,Invented,20002,"Apr 3, 2012",Student', 'Kit,Nonreal,20003,"May 4, 2010",Student', 'Lux,Nonreal,20004,"Jun 5, 2009",Student', 'Moss,Nonreal,20005,"Jul 6, 2008",Alumni'].join("\r\n");
    const p = await uploadAndValidate(v, "zenplanner.person_grid", "renewal-people-fictional.csv", new TextEncoder().encode(people));
    await confirmAndCommit(v, p.batchId);

    const jobsBefore = (await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.orgId, ctx.orgId))).length;
    const file = [
      "Number,First Name,Last Name,Bar Code,Membership Label,Mbr. Status,Mbr. Begin Date,Mbr. End Date,Months,Auto Renew,Renewal Type,Payment Amount",
      // Wrong: a current 6-month term that Zen Planner will renew into another 6 months.
      '9001,Ivo,Invented,20001,Fictional 2x (6 Months),CURRENT,"Aug 1, 2026","Jan 31, 2027",6,ON,6 Months,$197.99',
      // Right: rolls to month-to-month.
      '9002,Juno,Invented,20002,Fictional 2x (6 Months),CURRENT,"Aug 1, 2026","Jan 31, 2027",6,ON,Month to Month,$197.99',
      // Auto Renew off: ends at the end of the term, nothing renews.
      '9003,Kit,Nonreal,20003,Fictional 2x (6 Months),CURRENT,"Aug 1, 2026","Jan 31, 2027",6,OFF,6 Months,$197.99',
      // Auto Renew on but no Renewal Type in the export: cannot tell.
      '9004,Lux,Nonreal,20004,Fictional 2x (12 Months),CURRENT,"Aug 1, 2026","Jul 31, 2027",12,ON,,$178.99',
      // Wrongly set, but the membership is over: not part of the current picture.
      '9005,Moss,Nonreal,20005,Fictional 2x (6 Months),COMPLETED,"Jan 1, 2025","Jun 30, 2025",6,ON,6 Months,$197.99',
    ].join("\r\n");
    const m = await uploadAndValidate(v, "zenplanner.membership_grid", "renewal-memberships-fictional.csv", new TextEncoder().encode(file));
    const rows = await tx((t) => batchRows(t, v, m.batchId));
    const row = (n: number) => rows.find((r) => r.rowNumber === n)!;
    expect(rows.flatMap((r) => r.errors)).toEqual([]);
    expect((row(2).normalized as { flags: string[] }).flags).toContain(RENEWS_INTO_FIXED_TERM_FLAG);
    expect(row(2).warnings.join(" ")).toMatch(/renew this 6-month membership into another fixed term/);
    for (const n of [3, 4, 5]) expect((row(n).normalized as { flags: string[] }).flags, `row ${n}`).not.toContain(RENEWS_INTO_FIXED_TERM_FLAG);
    await tx((t) => confirmStrongMatches(t, v, m.batchId));
    expect(await confirmAndCommit(v, m.batchId)).toMatchObject({ create: 5, reject: 0 });

    const details = await db().select().from(zpMembershipDetails).where(eq(zpMembershipDetails.importBatchId, m.batchId));
    expect(details.filter((d) => d.flags.includes(RENEWS_INTO_FIXED_TERM_FLAG)).map((d) => d.months)).toEqual([6, 6]);

    const review = await tx((t) => discountReview(t, v, { batchId: m.batchId }));
    expect(review.renewsIntoFixedTerm).toHaveLength(1);
    expect(review.renewsIntoFixedTerm[0]).toMatchObject({ name: "Ivo Invented", plan: "Fictional 2x (6 Months)", months: 6, renewalType: "6 Months", endDate: "2027-01-31", status: "active" });
    expect(review.renewalTypeUnknown).toBe(1);
    expect(discountReviewCsv(review)).toContain("Set to renew into another fixed term,,Ivo Invented,,Fictional 2x (6 Months),active");

    // Imported memberships stay billed by Zen Planner: no invoice, no job, no next bill date, hub autopay off.
    const imported = await db().select().from(memberships).where(inArray(memberships.id, details.map((d) => d.membershipId)));
    expect(imported.every((x) => x.billingProvider === "external_zenplanner" && x.nextBillDate === null && x.autopay === false)).toBe(true);
    // The import itself queued nothing.
    expect((await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.orgId, ctx.orgId))).length).toBe(jobsBefore);
    // Even after the 6-month terms have ended, the renewal job bills none of them and leaves their terms alone.
    await db().transaction((t) => generateRenewals(t, ctx.orgId, "2027-03-15"));
    expect((await db().select({ id: invoices.id }).from(invoices).where(inArray(invoices.membershipId, details.map((d) => d.membershipId)))).length).toBe(0);
    const afterRun = await db().select().from(memberships).where(inArray(memberships.id, details.map((d) => d.membershipId)));
    expect(afterRun.map((x) => [x.id, x.commitmentEndsOn, x.nextBillDate]).sort()).toEqual(imported.map((x) => [x.id, x.commitmentEndsOn, x.nextBillDate]).sort());
  });
});
