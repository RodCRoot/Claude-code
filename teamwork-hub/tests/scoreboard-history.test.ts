import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { locations, products } from "@/db/schema";
import { scheduledBills } from "@/lib/billing/queries";
import { toCsv } from "@/lib/reports";
import { retentionRadar } from "@/lib/retention/radar";
import { scoreboardContext } from "@/lib/scoreboard/core";
import { DAILY_METRICS, dailyScoreboard, metricRows } from "@/lib/scoreboard/daily";
import { slotUtilisation } from "@/lib/scoreboard/efficiency";
import { marginView, moneyView } from "@/lib/scoreboard/money";
import { monthlyScoreboard } from "@/lib/scoreboard/monthly";
import { EXPORT_TABLES, exportTable } from "@/lib/scoreboard/tables";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { moduleSeeds } from "../scripts/seed/modules";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * The scoreboard over the full synthetic demo data INCLUDING the opt-in history seed
 * (scripts/seed/scoreboard.ts): reconciliation between numbers, lists and other modules, the
 * filter on a realistic data set, exports, and a load-time budget.
 */
const TODAY = "2026-11-12";
const NOW = localToUtc(TODAY, "13:00", "America/Indiana/Indianapolis");
const db = () => testDb();
let org: Awaited<ReturnType<typeof seedOrg>>;
let emptyLocation = "";
let emptyProduct = "";
const ctxFor = async (filter: { locationId?: string; productId?: string } = {}) => scoreboardContext(db(), await viewerFor(org, "rod"), { ...filter, today: TODAY, now: NOW });

beforeAll(async () => {
  org = await seedOrg(TODAY, { modules: moduleSeeds.map(([name]) => name) });
  const [l] = await db().insert(locations).values({ orgId: org.orgId, name: "Nowhere (test)", sortOrder: 9 }).returning();
  const [p] = await db().insert(products).values({ orgId: org.orgId, name: "Nobody plan (test)", kind: "recurring_membership", locationIds: [l.id] }).returning();
  emptyLocation = l.id;
  emptyProduct = p.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("scoreboard on the synthetic history", () => {
  it("the history seed is opt-in: the default test seed does not include it", async () => {
    const plain = await seedOrg(TODAY, { modules: ["scheduling", "billing"] });
    const rows = await db().select({ id: products.id }).from(products).where(eq(products.orgId, plain.orgId));
    const seeded = await db().select({ name: products.name }).from(products).where(eq(products.orgId, org.orgId));
    expect(seeded.some((p) => p.name.includes("Linton Youth Development"))).toBe(true);
    expect(rows.length).toBeLessThan(seeded.length);
    expect(plain.extra.scoreboard).toBeUndefined();
    expect((await seedOrg(TODAY, { modules: [] })).extra.scoreboard).toBeUndefined();
  });

  it("loads the daily page inside its budget and every number equals the count of its list", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor();
    const d = await dailyScoreboard(db(), rod, c);
    // Budget: a shared CI box is slow, so this is generous; locally it is a few hundred ms.
    expect(d.tookMs).toBeLessThan(8000);
    for (const def of DAILY_METRICS) {
      const m = d.metrics[def.key];
      const list = await metricRows(db(), rod, c, def.key, 5000);
      expect(list!.rows.length, def.key).toBe(m.rowCount);
      if (def.kind === "money") expect(list!.rows.reduce((s, r) => s + (r.amount_minor ?? 0), 0), def.key).toBe(m.value);
    }
    // The seed is shaped so the page has something in every section.
    for (const key of ["active_members", "open_pipeline", "sold_mtd", "attendance_yesterday", "past_due", "bills_due_14", "holds_active", "at_risk", "slipping_cohort", "collected_mtd", "collected_last_month", "projected_next_month", "under_half", "over_limit", "decisions", "assessments_today"]) {
      expect(d.metrics[key].value, key).toBeGreaterThan(0);
    }
    const pd = d.metrics.past_due;
    expect(pd.breakdown.reduce((s, b) => s + (b.amountMinor ?? 0), 0)).toBe(pd.value);
    expect(pd.breakdown.every((b) => (b.amountMinor ?? 0) > 0)).toBe(true); // an unpaid invoice in every aging bucket
    expect(d.metrics.assessments_today.breakdown.some((b) => b.label === "Lead with NO matching booking")).toBe(true);
    expect(d.metrics.active_members.change).not.toBeNull();
  });

  it("at-risk is the retention radar's own count, and the classes table matches bookings today", async () => {
    const rod = await viewerFor(org, "rod");
    const d = await dailyScoreboard(db(), rod, await ctxFor());
    const radar = await retentionRadar(db(), rod, { today: TODAY });
    expect(d.metrics.at_risk.value).toBe(radar.summary.atRisk);
    expect(d.metrics.at_risk.amountMinor).toBe(radar.summary.revenueAtRiskMinor);
    expect(d.classes.reduce((s, x) => s + x.booked, 0)).toBe(d.metrics.bookings_today.value);
    expect(d.byLocation.reduce((s, l) => s + l.memberships, 0)).toBe(d.metrics.active_members.rowCount);
  });

  it("scheduled bills agree with the billing module's own bill preview", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor();
    const mine = (await metricRows(db(), rod, c, "bills_due_14", 5000))!.rows.filter((r) => r.grp === "Scheduled membership bill");
    const theirs = await scheduledBills(db(), rod);
    expect(mine.length).toBeGreaterThan(5);
    for (const r of mine) {
      const t = theirs.find((x) => x.membershipId === r.ref_id);
      expect(t, r.name).toBeTruthy();
      expect(t!.dueDate).toBe(r.day);
      expect(t!.amountMinor, r.name).toBe(r.amount_minor);
      expect(r.day! >= TODAY && r.day! <= addDaysYmd(TODAY, 14)).toBe(true);
    }
  });

  it("applies the filter everywhere: an empty location and program leave nothing, on every tab", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor({ locationId: emptyLocation, productId: emptyProduct });
    expect(c.filtered).toBe(true);
    const d = await dailyScoreboard(db(), rod, c);
    for (const def of DAILY_METRICS) {
      const m = d.metrics[def.key];
      if (m.na) expect(m.value, def.key).toBeNull();
      else expect(m.value, def.key).toBe(0);
    }
    expect(d.classes).toEqual([]);
    expect(d.byLocation).toEqual([]);
    const mo = await monthlyScoreboard(db(), rod, c);
    for (const m of mo.months) for (const r of mo.rows) expect(m.values[r.key] ?? 0, `${m.month} ${r.key}`).toBe(0);
    expect((await slotUtilisation(db(), c, { weeks: 26 })).rows).toEqual([]);
    const mv = await moneyView(db(), c);
    expect(mv.outstandingNowMinor).toBe(0);
    for (const m of mv.months) expect([m.collectedMinor, m.billedMinor, m.refundsMinor, m.outstandingMinor]).toEqual([0, 0, 0, 0]);
    expect((await marginView(db(), rod, c)).access).toBe("filtered");
    // One real location: strictly fewer members than the whole gym, and the Linton-only plan is all there.
    const linton = (await db().select().from(locations).where(eq(locations.orgId, org.orgId))).find((l) => l.name === "Linton")!;
    const all = await dailyScoreboard(db(), rod, await ctxFor());
    const lin = await dailyScoreboard(db(), rod, await ctxFor({ locationId: linton.id }));
    expect(lin.metrics.active_members.value).toBeGreaterThan(0);
    expect(lin.metrics.active_members.value).toBeLessThan(all.metrics.active_members.value!);
    expect(lin.metrics.collected_last_month.value).toBeLessThan(all.metrics.collected_last_month.value!);
    expect(lin.metrics.attendance_yesterday.value).toBeLessThanOrEqual(all.metrics.attendance_yesterday.value!);
  });

  it("monthly table, slot flags, payroll gaps and the money view have meaningful history", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor();
    const mo = await monthlyScoreboard(db(), rod, c, { months: 6 });
    expect(mo.months).toHaveLength(6);
    for (const m of mo.months) {
      expect(m.values.active, m.month).toBeGreaterThan(20);
      expect(m.values.visits, m.month).toBeGreaterThan(50);
      expect(m.values.net_growth, m.month).toBe((m.values.sold ?? 0) - (m.values.lost ?? 0));
    }
    expect(mo.months.reduce((s, m) => s + (m.values.plan_changes ?? 0), 0)).toBeGreaterThanOrEqual(4);
    expect(mo.months.reduce((s, m) => s + (m.values.lost ?? 0), 0)).toBeGreaterThanOrEqual(3);
    expect(mo.bottleneck.rule).toMatch(/^Rule: /);
    const slots = await slotUtilisation(db(), c, { weeks: 8 });
    expect(slots.rows.find((r) => r.title === "High School Strength (sample)")!.flag).toBe("full");
    expect(slots.rows.find((r) => r.title === "Friday Mobility (sample)")!.flag).toBe("under");
    const mg = await marginView(db(), rod, c, { months: 6 });
    expect(mg.months.map((m) => m.payrollSource)).toContain("entered by hand"); // the month before the time clock was in use
    expect(mg.months.filter((m) => m.payrollSource === "payroll module").length).toBeGreaterThanOrEqual(3);
    const mv = await moneyView(db(), c, { months: 6 });
    for (const p of [mv.byOption, mv.byLocation]) for (const m of mv.months) expect(p.groups.reduce((s, g) => s + (p.byMonth[m.month]?.[g] ?? 0), 0), m.month).toBe(m.collectedMinor);
    expect(mv.byLocation.groups).toEqual(expect.arrayContaining(["Bloomington", "Linton", "Multiple / all locations"]));
    expect(mv.months.some((m) => m.refundsMinor > 0)).toBe(true);
  });

  it("every table exports as CSV with a header row", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor();
    for (const name of [...EXPORT_TABLES, "list-past_due", "list-decisions"]) {
      const t = await exportTable(db(), rod, c, name, { months: 6, weeks: 8 });
      expect(t, name).not.toBeNull();
      const csv = toCsv(t!.columns, t!.rows);
      const lines = csv.trim().split("\n");
      expect(lines.length, name).toBe(t!.rows.length + 1);
      expect(lines[0].split(",").length, name).toBeGreaterThanOrEqual(2);
    }
    expect(await exportTable(db(), rod, c, "list-nope")).toBeNull();
    expect(await exportTable(db(), rod, c, "nope")).toBeNull();
    // Payroll and margin exports are refused for staff without payroll access.
    const erin = await viewerFor(org, "erin");
    const ce = await scoreboardContext(db(), erin, { today: TODAY, now: NOW });
    expect(await exportTable(db(), erin, ce, "payroll")).toBeNull();
    expect(await exportTable(db(), erin, ce, "margin")).toBeNull();
    expect(await exportTable(db(), erin, ce, "monthly")).not.toBeNull();
  });
});
