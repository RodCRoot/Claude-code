import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bookings,
  discounts,
  formRequests,
  formTemplates,
  formTemplateVersions,
  invoices,
  memberRequestAthletes,
  memberRequests,
  membershipHolds,
  memberships,
  paymentAttempts,
  products,
  productVersions,
  scheduleSessions,
  serviceTypes,
  type MemberRequestStatus,
  type MemberRequestType,
  type MembershipStatus,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { reportByKey, toCsv } from "@/lib/reports";
import { localToUtc } from "@/lib/time";
import { billDatesBetween, matchRequestKeyword, monthsBetween, weeklyCap } from "@/lib/member-ops/common";
import { membershipAuditSweep, type ExceptionType, type MembershipException } from "@/lib/member-ops/membership-audit";
import { membershipStatusReport } from "@/lib/member-ops/status";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * Synthetic fixtures, one membership exception per athlete (all names are the seed's synthetic
 * people). "Today" is Monday 2026-10-12, so the last 8 complete weeks run 2026-08-17 … 2026-10-11.
 */
const TODAY = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let result: Awaited<ReturnType<typeof membershipAuditSweep>>;
const db = () => testDb();
let invoiceNo = 0;
let serviceTypeId = "";

async function plan(name: string, priceMinor: number, opts: Partial<typeof productVersions.$inferInsert> = {}) {
  const [p] = await db().insert(products).values({ orgId: ctx.orgId, name, kind: "recurring_membership", isDemo: true }).returning();
  const [v] = await db()
    .insert(productVersions)
    .values({ productId: p.id, version: 1, priceMinor, interval: "month", effectiveFrom: "2025-01-01", ...opts })
    .returning();
  return v.id;
}

async function member(athlete: string, versionId: string, o: { status?: MembershipStatus; start: string; end?: string; cancelAt?: string; payer?: string; provider?: "manual" | "external_zenplanner"; discountId?: string }) {
  const [m] = await db()
    .insert(memberships)
    .values({
      orgId: ctx.orgId,
      athleteId: ctx.athletes[athlete],
      payerAccountId: ctx.payers[o.payer ?? athlete],
      productVersionId: versionId,
      status: o.status ?? "active",
      startDate: o.start,
      endDate: o.end ?? null,
      cancelAt: o.cancelAt ?? null,
      billingAnchorDay: 1,
      billingProvider: o.provider ?? "manual",
      discountId: o.discountId ?? null,
      isDemo: true,
    })
    .returning();
  return m.id;
}

async function bill(membershipId: string, payer: string, periodStart: string, totalMinor: number, status: "open" | "paid" = "paid") {
  const [i] = await db()
    .insert(invoices)
    .values({ orgId: ctx.orgId, payerAccountId: ctx.payers[payer], number: `T-${++invoiceNo}`, status, subtotalMinor: totalMinor, totalMinor, membershipId, periodStart, dueDate: periodStart, source: "membership_renewal", isDemo: true })
    .returning();
  return i.id;
}

async function visit(athlete: string, day: string, status: "attended" | "cancelled" | "no_show" = "attended") {
  const [s] = await db()
    .insert(scheduleSessions)
    .values({ orgId: ctx.orgId, serviceTypeId, title: "Group training", startsAt: localToUtc(day, "17:00"), endsAt: localToUtc(day, "18:00"), timezone: ctx.tz, capacity: 12 })
    .returning();
  await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes[athlete], status, isDemo: true });
}

async function request(type: MemberRequestType, athletes: string[], sentOn: string, status: MemberRequestStatus = "new", resolvedAt?: Date) {
  const [r] = await db()
    .insert(memberRequests)
    .values({ orgId: ctx.orgId, type, channel: "email_forwarded", sentOn, status, resolvedAt: resolvedAt ?? null, resolutionNotes: resolvedAt ? "done" : null, summary: "synthetic" })
    .returning();
  await db().insert(memberRequestAthletes).values(athletes.map((a) => ({ requestId: r.id, athleteId: ctx.athletes[a] })));
  return r.id;
}

const forAthlete = (first: string) => result.exceptions.filter((e) => e.athleteNames.split(", ").some((n) => n.startsWith(`${first} `)));
const types = (first: string) => forAthlete(first).map((e) => e.type).sort();
const one = (first: string, type: ExceptionType): MembershipException => {
  const hits = forAthlete(first).filter((e) => e.type === type);
  expect(hits, `${first}: ${type}`).toHaveLength(1);
  return hits[0];
};

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  const [st] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Group training", kind: "class" }).returning();
  serviceTypeId = st.id;

  const unlimited = await plan("Sample Unlimited Monthly", 19900, { unlimited: true, familyDiscount: { siblingPercentOff: 10 } });
  const oneX = await plan("Sample Performance 1x per Week (Month to Month)", 12900, { creditsPerPeriod: 4 });
  const twoX = await plan("Sample Performance 2x per Week (Month to Month)", 14900, { creditsPerPeriod: 8 });
  const twoXRegular = await plan("Sample Regular 2x per Week", 23299, { creditsPerPeriod: 8 });
  const inSeason = await plan("Sample In Season 1x per Week", 11900, { creditsPerPeriod: 4 });
  const threeX6 = await plan("Sample Performance 3x per Week (6 Months)", 26199, { creditsPerPeriod: 12, commitmentMonths: 6 });
  const recent = "2026-10-06";

  // Dormant but billed: Dana's only October bookings were cancelled / no-show (not visits).
  const dana = await member("dana", twoX, { start: "2026-03-01" });
  await visit("dana", "2026-08-15");
  await visit("dana", "2026-10-06", "cancelled");
  await visit("dana", "2026-10-07", "no_show");
  await bill(dana, "dana", "2026-09-01", 14900);
  await bill(dana, "dana", "2026-10-01", 14900);
  // Dormant: Ethan never attended.
  const ethan = await member("ethan", twoX, { start: "2026-06-01" });
  await bill(ethan, "ethan", "2026-09-01", 14900);
  await bill(ethan, "ethan", "2026-10-01", 14900);

  // Over the weekly cap: Sofia (1x/week) came twice a week for 8 weeks.
  await member("sofia", oneX, { start: "2026-01-01" });
  for (let w = 0; w < 8; w++) {
    const monday = new Date(Date.UTC(2026, 7, 17 + 7 * w, 12)).toISOString().slice(0, 10);
    const d = (n: number) => new Date(Date.UTC(+monday.slice(0, 4), +monday.slice(5, 7) - 1, +monday.slice(8, 10) + n, 12)).toISOString().slice(0, 10);
    await visit("sofia", d(1));
    await visit("sofia", d(3));
  }

  // Hold over the 2-month yearly cap: Liam.
  const liam = await member("liam", twoX, { start: "2026-01-15" });
  await db().insert(membershipHolds).values({ membershipId: liam, startDate: "2026-02-01", endDate: "2026-04-30", reason: "synthetic" });
  await visit("liam", recent);

  // On hold with no end date: Harper.
  await member("harper", twoX, { start: "2026-03-01", status: "on_hold" });

  // In-season with no end date and over the 365-day cap: Mason.
  await member("mason", twoXRegular, { start: "2026-01-01", end: "2026-06-30", status: "cancelled" });
  await member("mason", inSeason, { start: "2026-07-01" });
  await visit("mason", recent);

  // Commitment ended and rolled into a new commitment: Zoe.
  await member("zoe", threeX6, { start: "2026-01-01", end: "2026-06-30", status: "expired" });
  await member("zoe", threeX6, { start: "2026-07-01" });
  await visit("zoe", recent);

  // Commitment ended; cancellation asked Aug 3 but held to Dec 31: Jackson.
  await member("jackson", threeX6, { start: "2026-01-01", cancelAt: "2026-12-31" });
  await request("cancel", ["jackson"], "2026-08-03", "resolved", new Date("2026-08-05T15:00:00Z"));
  await visit("jackson", recent);

  // Two athletes on one payer, no family discount: Maya + Eli (Parker family).
  await member("maya", unlimited, { start: "2026-01-01", payer: "parker" });
  await member("eli", unlimited, { start: "2026-02-01", payer: "parker" });
  await visit("maya", recent);
  await visit("eli", recent);

  // Billed while a required waiver is unsigned: Ella.
  await member("ella", twoX, { start: "2026-02-01" });
  await visit("ella", recent);

  // Failing card: Owen.
  const owen = await member("owen", twoX, { start: "2026-01-01", status: "past_due" });
  const inv = await bill(owen, "owen", "2026-10-01", 14900, "open");
  await db().insert(paymentAttempts).values({ orgId: ctx.orgId, invoiceId: inv, provider: "stripe", amountMinor: 14900, currency: "USD", status: "failed", failureMessage: "card_declined (synthetic)", idempotencyKey: `t-${inv}`, createdAt: new Date("2026-10-02T14:00:00Z") });
  await visit("owen", recent);

  // Hold asked twice (unprocessed) and billed anyway by Zen Planner: Aria.
  await member("aria", twoX, { start: "2026-01-01", provider: "external_zenplanner" });
  await request("hold", ["aria"], "2026-09-20");
  await request("pause", ["aria"], "2026-09-28");
  await visit("aria", recent);

  // Hold asked Sep 15, billed Oct 1 anyway, resolved Oct 5: Leo.
  const leo = await member("leo", twoX, { start: "2026-01-01", payer: "rivera" });
  await bill(leo, "rivera", "2026-10-01", 14900);
  await request("hold", ["leo"], "2026-09-15", "resolved", new Date("2026-10-05T15:00:00Z"));
  await visit("leo", recent);

  // Control: Ava, unlimited, attends weekly — no exceptions.
  await member("ava", unlimited, { start: "2026-01-01", payer: "chris_parker" });
  for (const d of ["2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"]) await visit("ava", d);

  // Required waiver: completed for everyone except Ella.
  const [ft] = await db().insert(formTemplates).values({ orgId: ctx.orgId, name: "Sample Waiver", kind: "waiver", requiredForBooking: true }).returning();
  const [fv] = await db().insert(formTemplateVersions).values({ templateId: ft.id, version: 1, title: "Sample Waiver", bodyMarkdown: "SAMPLE", signers: [], contentHash: "x", status: "published" }).returning();
  for (const [key, athleteId] of Object.entries(ctx.athletes)) {
    if (key === "ella") continue;
    const personId = ctx.people[Object.keys(ctx.people).find((k) => k.startsWith(`${key}_`) && !k.endsWith("_guardian")) ?? ""];
    if (!personId) continue;
    await db().insert(formRequests).values({ orgId: ctx.orgId, templateVersionId: fv.id, subjectPersonId: personId, athleteId, status: "completed" });
  }

  result = await membershipAuditSweep(db(), ctx.orgId, { today: TODAY });
});
afterAll(closeTestDb);

describe("member-ops helpers", () => {
  it("weekly cap comes from the plan name, then credits; unlimited has none", () => {
    expect(weeklyCap({ productName: "Athlete/Adult Performance 2x per Week (Month to Month)", creditsPerPeriod: null, unlimited: false, interval: "month", intervalCount: 1 })).toBe(2);
    expect(weeklyCap({ productName: "Sample — 2x/Week Monthly", creditsPerPeriod: 8, unlimited: false, interval: "month", intervalCount: 1 })).toBe(2);
    expect(weeklyCap({ productName: "Ten pack", creditsPerPeriod: 12, unlimited: false, interval: "month", intervalCount: 1 })).toBe(3);
    expect(weeklyCap({ productName: "Unlimited", creditsPerPeriod: null, unlimited: true, interval: "month", intervalCount: 1 })).toBeNull();
  });
  it("bill dates and months", () => {
    expect(billDatesBetween("2026-09-20", "2026-10-12", 1)).toEqual(["2026-10-01"]);
    expect(billDatesBetween("2026-01-31", "2026-03-31", 31)).toEqual(["2026-02-28", "2026-03-31"]);
    expect(monthsBetween("2026-10-12", "2027-01-01")).toBe(2);
  });
  it("keyword screen picks the most consequential ask and never matches unrelated words", () => {
    expect(matchRequestKeyword("Can we put Maya on hold for volleyball season?")?.type).toBe("hold");
    expect(matchRequestKeyword("She's in-season now, can we switch?")?.type).toBe("in_season");
    expect(matchRequestKeyword("Please cancel, and also my card changed")?.type).toBe("cancel");
    expect(matchRequestKeyword("We'd like to pause through June")?.type).toBe("pause");
    expect(matchRequestKeyword("I have a new credit card")?.type).toBe("card_update");
    expect(matchRequestKeyword("Our household threshold question about schedule")).toBeNull();
  });
});

describe("membership audit sweep (synthetic fixture per exception type)", () => {
  it("dormant but billed — cancelled and no-show reservations are not visits", () => {
    const d = one("Dana", "dormant_billed");
    expect(d.detail).toContain("2026-08-15");
    expect(d.impactMinor).toBe(29800);
    const e = one("Ethan", "dormant_billed");
    expect(e.detail).toContain("since the membership started");
    expect(e.impactMinor).toBe(29800);
  });

  it("consistent use above the plan's weekly cap", () => {
    const s = one("Sofia", "over_cap_usage");
    expect(s.detail).toContain("2.0/week");
    expect(s.impactMinor).toBe(12900);
  });

  it("hold over the yearly cap, and on hold with no end date", () => {
    expect(one("Liam", "hold_over_cap").impactMinor).toBeGreaterThan(0);
    const h = one("Harper", "hold_no_end");
    expect(h.impactMinor).toBe(14900);
    expect(types("Harper")).toEqual(["hold_no_end"]);
  });

  it("in-season with no end date and over the 365-day cap, priced against the regular plan", () => {
    expect(one("Mason", "in_season_no_end").impactMinor).toBe(23299 - 11900);
    expect(one("Mason", "in_season_over_cap").impactMinor).toBeGreaterThan(0);
  });

  it("commitment ended but renewed into a new commitment / cancellation held past notice", () => {
    const z = one("Zoe", "commitment_renewed");
    expect(z.impactMinor).toBe(2 * 26199);
    const j = one("Jackson", "commitment_locked");
    expect(j.detail).toContain("2026-09-02");
    expect(j.impactMinor).toBe(3 * 26199);
  });

  it("family with 2+ active athletes missing the family discount", () => {
    const fam = result.exceptions.filter((e) => e.type === "family_discount_missing");
    expect(fam).toHaveLength(1);
    expect(["Maya Parker", "Eli Parker"]).toContain(fam[0].athleteNames);
    expect(fam[0].impactMinor).toBe(1990);
  });

  it("unsigned required documents blocking attendance while billed", () => {
    const e = one("Ella", "unsigned_docs_billed");
    expect(e.detail).toContain("Sample Waiver");
    expect(result.exceptions.filter((x) => x.type === "unsigned_docs_billed")).toHaveLength(1);
  });

  it("failing card", () => {
    const c = one("Owen", "failing_card");
    expect(c.impactMinor).toBe(14900);
    expect(c.detail).toContain("card_declined");
  });

  it("unprocessed requests fold repeat asks into the first, with the request date", () => {
    const u = one("Aria", "request_unprocessed");
    expect(u.detail).toContain("2026-09-20");
    expect(u.detail).toContain("asked 2 times");
    expect(u.impactMinor).toBe(14900);
  });

  it("requests sent before a bill date that billed anyway (Hub invoice and Zen Planner estimate, never double counted)", () => {
    const l = one("Leo", "request_billed_anyway");
    expect(l.impactMinor).toBe(14900);
    expect(l.impactBasis).toContain("1 bill");
    const a = one("Aria", "request_billed_anyway");
    expect(a.impactMinor).toBe(14900);
    expect(a.impactBasis).toContain("estimate");
  });

  it("controls stay clean; results sorted most expensive first; skipped items stated", () => {
    expect(types("Ava")).toEqual([]);
    const amounts = result.exceptions.map((e) => e.impactMinor ?? -1);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(result.skipped.join(" ")).toContain("Zen Planner-billed");
    expect(result.skipped.join(" ")).toContain("AI Call Recap");
    expect(result.skipped.join(" ")).toContain("Read-only");
  });

  it("is read-only: nothing about memberships or invoices changes", async () => {
    const before = await db().select().from(memberships).where(eq(memberships.orgId, ctx.orgId));
    await membershipAuditSweep(db(), ctx.orgId, { today: TODAY });
    const after = await db().select().from(memberships).where(eq(memberships.orgId, ctx.orgId));
    expect(after).toEqual(before);
  });

  it("runs as the Membership audit report with CSV export", async () => {
    const def = reportByKey("membership-audit")!;
    expect(def.cap).toBe("reports.financial");
    const res = await def.run(db(), ctx.orgId, { from: TODAY, to: TODAY, tz: ctx.tz });
    expect(res.rows.length).toBe(result.exceptions.length);
    expect(res.notes?.length).toBeGreaterThan(2);
    const csv = toCsv(def.columns, res.rows);
    expect(csv.split("\n")[0]).toContain("$ impact (USD)");
    expect(csv).toContain("Billed while not attending");
  });
});

describe("membership status page", () => {
  it("one report per athlete: who, correspondence, attendance, membership, flags", async () => {
    const rod = await viewerFor(ctx, "rod");
    const r = (await membershipStatusReport(db(), rod, ctx.people.maya_parker, TODAY))!;
    expect(r.who.guardians.map((g) => g.name).sort()).toEqual(["Alex Parker", "Jordan Parker"]);
    expect(r.who.siblings.map((s) => s.name)).toContain("Eli Parker");
    expect(r.who.payers[0].name).toBeTruthy();
    expect(r.attendance.lastVisit).toBe("2026-10-06");
    expect(r.current?.product).toBe("Sample Unlimited Monthly");
    expect(r.attendance.perMonth).toHaveLength(12);
  });

  it("dormant athlete: paying while not attending, cancelled bookings shown separately", async () => {
    const erin = await viewerFor(ctx, "erin");
    const r = (await membershipStatusReport(db(), erin, ctx.people.dana_brooks, TODAY))!;
    expect(r.attendance.lastVisit).toBe("2026-08-15");
    expect(r.attendance.visits60).toBe(1);
    expect(r.attendance.notVisits60.cancelled).toBe(1);
    expect(r.attendance.notVisits60.no_show).toBe(1);
    expect(r.attendance.gaps.some((g) => g.ongoing)).toBe(true);
    expect(r.rateVsUsage?.payingNotAttending).toBe(true);
    expect(r.flags[0].type).toBe("dormant_billed");
    expect(r.recommended.length).toBeGreaterThan(0);
    expect(r.current?.invoices.length).toBe(2);
  });

  it("commitment months served/remaining and remaining contract value", async () => {
    const rod = await viewerFor(ctx, "rod");
    const r = (await membershipStatusReport(db(), rod, ctx.people.zoe_whitaker, TODAY))!;
    expect(r.current?.commitmentMonths).toBe(6);
    expect(r.current?.monthsServed).toBe(3);
    expect(r.current?.monthsRemaining).toBe(2);
    expect(r.current?.remainingContractMinor).toBe(2 * 26199);
  });

  it("open requests show whether a bill date passed since the family asked", async () => {
    const rod = await viewerFor(ctx, "rod");
    const r = (await membershipStatusReport(db(), rod, ctx.people.aria_castellanos, TODAY))!;
    expect(r.correspondence.openRequests[0].billDatesPassed).toEqual(["2026-10-01"]);
  });

  it("requires billing.view_all", async () => {
    const coach = await viewerFor(ctx, "marcus");
    await expect(membershipStatusReport(db(), coach, ctx.people.maya_parker, TODAY)).rejects.toBeInstanceOf(AuthzError);
    const alex = await viewerFor(ctx, "alex");
    await expect(membershipStatusReport(db(), alex, ctx.people.maya_parker, TODAY)).rejects.toBeInstanceOf(AuthzError);
  });

  it("discount on one sibling clears the family flag", async () => {
    const [d] = await db().insert(discounts).values({ orgId: ctx.orgId, name: "Sibling discount 10%", kind: "percent", value: 10 }).returning();
    const fam = result.exceptions.find((e) => e.type === "family_discount_missing")!;
    await db().update(memberships).set({ discountId: d.id }).where(eq(memberships.id, fam.membershipId!));
    const again = await membershipAuditSweep(db(), ctx.orgId, { today: TODAY });
    expect(again.exceptions.filter((e) => e.type === "family_discount_missing")).toHaveLength(0);
  });
});
