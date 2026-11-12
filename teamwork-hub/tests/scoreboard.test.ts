import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, membershipEvents, staffPayRates, timeEntries } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can } from "@/lib/authz/policy";
import { calculatePayroll } from "@/lib/payroll/service";
import { saveTargets, saveThresholds, scoreboardContext, scoreboardSettingsFrom, type Ctx } from "@/lib/scoreboard/core";
import { AGING_ORDER, activeByLocation, classesToday, DAILY_METRICS, dailyScoreboard, metricRows } from "@/lib/scoreboard/daily";
import { definitionsFor } from "@/lib/scoreboard/definitions";
import { payrollByMonth, slotUtilisation } from "@/lib/scoreboard/efficiency";
import { deleteSpend, marketingEconomics, saveSpend } from "@/lib/scoreboard/marketing";
import { marginView, moneyView, saveExpense } from "@/lib/scoreboard/money";
import { bottleneck, monthlyScoreboard, TARGET_KEYS } from "@/lib/scoreboard/monthly";
import { localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { scoreboardWorld } from "./scoreboard-helpers";

/**
 * Each describe block builds its own core-only organization and inserts rows by hand, so every
 * expected number below can be counted from the fixture comments. "Today" is Wednesday
 * 2026-03-18 at noon, facility time; next month is April (30 days).
 */
const TODAY = "2026-03-18";
const NOW = localToUtc(TODAY, "12:00", "America/Indiana/Indianapolis");
const db = () => testDb();
type Org = Awaited<ReturnType<typeof seedOrg>>;
const ctxFor = async (org: Org, filter: { locationId?: string; productId?: string } = {}, user = "rod") => scoreboardContext(db(), await viewerFor(org, user), { ...filter, today: TODAY, now: NOW });
const daily = async (org: Org, filter: { locationId?: string; productId?: string } = {}) => {
  const c = await ctxFor(org, filter);
  return dailyScoreboard(db(), await viewerFor(org, "rod"), c);
};
const thisMonth = (mo: Awaited<ReturnType<typeof monthlyScoreboard>>) => mo.months[mo.months.length - 1].values;
const month = (mo: Awaited<ReturnType<typeof monthlyScoreboard>>, m: string) => mo.months.find((x) => x.month === m)!.values;

afterAll(async () => {
  await closeTestDb();
});

describe("active members and the location / program filter", () => {
  let org: Org;
  let w: Awaited<ReturnType<typeof scoreboardWorld>>;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
    w = await scoreboardWorld(org, TODAY);
    const [a1, a2, a3, a4, a5, a6, a7, a8] = await Promise.all(Array.from({ length: 8 }, () => w.athlete()));
    await w.membership(a1, w.planA, { start: -100 }); // North
    await w.membership(a1, w.planAll, { start: -20 }); // a1's second membership: a possible duplicate
    await w.membership(a2, w.planB, { start: -50 }); // South
    await w.membership(a3, w.planAll, { start: -30 }); // everywhere
    await w.membership(a4, w.planA, { start: -200, end: -1 }); // ended yesterday: was a member the day before
    await w.membership(a5, w.planA, { start: 0 }); // starts today: the one sale this month
    await w.membership(a6, w.planA, { start: -5, status: "pending" }); // pending: never counted
    await w.membership(a7, w.trial, { start: -2, end: 5, billingProvider: "none" }); // trial: counted separately
    await w.membership(a8, w.planB, { start: -60, end: 10 }); // South, ends in 10 days
  });

  it("counts people and memberships, excludes pending, ended and trial, and reports yesterday's change", async () => {
    const d = await daily(org);
    const m = d.metrics.active_members;
    expect(m.value).toBe(5); // a1 a2 a3 a5 a8
    expect(m.people).toBe(5);
    expect(m.rowCount).toBe(6); // a1 holds two
    // End of yesterday: a1 a2 a3 a8 (4). End of the day before: those plus a4 (5).
    expect(m.change).toBe(-1);
    expect(d.metrics.active_trials.value).toBe(1);
    expect(d.metrics.duplicates.value).toBe(1);
    expect(d.metrics.sold_mtd.value).toBe(1);
    expect(d.metrics.expiring_30.value).toBe(1);
    expect(d.metrics.autopay_off.value).toBe(6);
  });

  it("partitions active memberships by where they are valid, adding up to the total", async () => {
    const rows = await activeByLocation(db(), await ctxFor(org));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.memberships]))).toEqual({ "North (test)": 2, "South (test)": 2, "Multiple / all locations": 2 });
    expect(rows.reduce((s, r) => s + r.memberships, 0)).toBe(6);
  });

  it("narrows by location (a plan valid everywhere matches every location) and by program", async () => {
    const north = await daily(org, { locationId: w.locA.id });
    expect(north.metrics.active_members.value).toBe(3); // a1 a3 a5
    expect(north.metrics.active_members.rowCount).toBe(4);
    expect(north.metrics.expiring_30.value).toBe(0);
    const south = await daily(org, { locationId: w.locB.id });
    expect(south.metrics.active_members.value).toBe(4); // a2 a8, plus a3 and a1 on the everywhere plan
    expect(south.metrics.expiring_30.value).toBe(1);
    const planA = await daily(org, { productId: w.planA.product.id });
    expect(planA.metrics.active_members.value).toBe(2); // a1 a5
    expect(planA.metrics.sold_mtd.value).toBe(1);
    const planB = await daily(org, { productId: w.planB.product.id });
    expect(planB.metrics.duplicates.value).toBe(0); // a1 holds no South plan
    const both = await daily(org, { locationId: w.locA.id, productId: w.planB.product.id });
    expect(both.metrics.active_members.value).toBe(0);
  });

  it("applies the filter to every number: nothing attributable to an empty location, and nothing shown unfiltered", async () => {
    const d = await daily(org, { locationId: w.locEmpty.id, productId: w.planNobody.product.id });
    for (const def of DAILY_METRICS) {
      const m = d.metrics[def.key];
      if (m.na) {
        expect(m.value, def.key).toBeNull();
        expect(def.dims.location && def.dims.program, def.key).toBe(false);
      } else {
        expect(m.value, def.key).toBe(0);
        expect(m.rowCount, def.key).toBe(0);
      }
    }
    expect(d.decisions).toEqual([]);
    expect(d.classes).toEqual([]);
    // Lead numbers carry no location or program: withheld under either filter.
    expect((await daily(org, { locationId: w.locA.id })).metrics.new_leads_24h.na).toMatch(/location filter/);
    expect((await daily(org, { productId: w.planA.product.id })).metrics.open_pipeline.na).toMatch(/program filter/);
  });

  it("ignores a filter id from another organization", async () => {
    const other = await seedOrg(TODAY, { modules: [] });
    const ow = await scoreboardWorld(other, TODAY);
    const c = await ctxFor(org, { locationId: ow.locA.id, productId: ow.planA.product.id });
    expect(c.filter).toEqual({ locationId: null, productId: null });
    // And the other organization's rows never leak in.
    await ow.membership(await ow.athlete(), ow.planA, { start: -10 });
    expect((await daily(org)).metrics.active_members.value).toBe(5);
    expect((await daily(other)).metrics.active_members.value).toBe(1);
  });

  it("each list is the rows the number was counted from", async () => {
    const v = await viewerFor(org, "rod");
    const c = await ctxFor(org);
    const d = await dailyScoreboard(db(), v, c);
    for (const def of DAILY_METRICS) {
      const list = await metricRows(db(), v, c, def.key, 5000);
      expect(list!.rows.length, def.key).toBe(d.metrics[def.key].rowCount);
    }
    expect(await metricRows(db(), v, c, "no_such_metric")).toBeNull();
  });
});

describe("money owed and revenue", () => {
  let org: Org;
  let w: Awaited<ReturnType<typeof scoreboardWorld>>;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
    w = await scoreboardWorld(org, TODAY);
    const p = await w.athlete();
    const north = await w.athlete();
    const m = await w.membership(north, w.planA, { start: -100 });
    await w.invoice(p.payerId, { total: 10000, due: -5 }); // 1 to 30
    await w.invoice(p.payerId, { total: 20000, due: -35, paid: 5000, paidDaysAgo: 10 }); // 31 to 60, balance 15000
    await w.invoice(p.payerId, { total: 7000, due: -65 }); // 61 to 90
    await w.invoice(p.payerId, { total: 3000, due: -120 }); // over 90
    await w.invoice(p.payerId, { total: 9000, due: 0 }); // due today: not past due, but due in the next 14 days
    await w.invoice(p.payerId, { total: 4000, due: -3, status: "paid", paid: 4000, paidDaysAgo: 2 }); // paid in full
    await w.invoice(p.payerId, { total: 6000, due: -10, pending: 6000 }); // a pending payment does not reduce the balance
    await w.invoice(p.payerId, { total: 5000, due: -20, status: "void" }); // void: ignored
    await w.invoice(p.payerId, { total: 8000, due: -4, status: "draft" }); // draft: ignored
    await w.invoice(p.payerId, { total: 2500, due: -2 }); // became past due during yesterday
    await w.invoice(north.payerId, { total: 10000, due: -7, membershipId: m.id }); // the only invoice tied to a membership (North)
    await w.invoice(p.payerId, { total: 12000, due: -36, status: "paid", paid: 12000, paidDaysAgo: 36 }); // last month (Feb 10)
    await w.payment(p.payerId, null, 1500, 30, "refund"); // refund on Feb 16
  });

  it("past due buckets add up to the total, exactly", async () => {
    const m = (await daily(org)).metrics.past_due;
    expect(m.breakdown.map((b) => b.label)).toEqual(AGING_ORDER);
    expect(Object.fromEntries(m.breakdown.map((b) => [b.label, b.amountMinor]))).toEqual({ "1 to 30 days": 28500, "31 to 60 days": 15000, "61 to 90 days": 7000, "Over 90 days": 3000 });
    expect(m.value).toBe(53500);
    expect(m.breakdown.reduce((s, b) => s + (b.amountMinor ?? 0), 0)).toBe(m.value);
    expect(m.rowCount).toBe(7);
    // During yesterday one invoice (2500) crossed its due date.
    expect(m.change).toBe(2500);
  });

  it("bills due, collected and billed follow their one definition", async () => {
    const d = await daily(org);
    expect(d.metrics.bills_due_14.value).toBe(9000);
    expect(d.metrics.collected_mtd.value).toBe(9000); // 5000 on Mar 8 + 4000 on Mar 16; pending not counted
    expect(d.metrics.collected_last_month.value).toBe(12000);
    expect(d.metrics.billed_mtd.value).toBe(41500); // issued in March, excluding the void and the draft
  });

  it("with a filter only invoices tied to a membership in the filtered set are counted", async () => {
    const north = await daily(org, { locationId: w.locA.id });
    expect(north.metrics.past_due.value).toBe(10000);
    expect(north.metrics.past_due.breakdown.reduce((s, b) => s + (b.amountMinor ?? 0), 0)).toBe(10000);
    expect(north.metrics.collected_mtd.value).toBe(0);
    const south = await daily(org, { locationId: w.locB.id });
    expect(south.metrics.past_due.value).toBe(0);
    expect(south.metrics.billed_mtd.value).toBe(0);
  });

  it("money view: collected, refunds and billed by month, and the groups add up to collected", async () => {
    const mv = await moneyView(db(), await ctxFor(org));
    const mar = mv.months.find((m) => m.month === "2026-03-01")!;
    const feb = mv.months.find((m) => m.month === "2026-02-01")!;
    expect(mar.collectedMinor).toBe(9000);
    expect(mar.billedMinor).toBe(41500);
    expect(feb.collectedMinor).toBe(12000);
    expect(feb.refundsMinor).toBe(1500);
    expect(feb.netMinor).toBe(10500);
    expect(mv.outstandingNowMinor).toBe(62500); // past due 53500 + 9000 due today
    for (const p of [mv.byOption, mv.byLocation]) {
      for (const m of mv.months) expect(p.groups.reduce((s, g) => s + (p.byMonth[m.month]?.[g] ?? 0), 0), m.month).toBe(m.collectedMinor);
    }
    expect(mv.byOption.groups).toEqual(["Other sales"]);
  });

  it("operating margin is not available without payroll, and uses hand-entered payroll when there is no time-clock data", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor(org);
    let mg = await marginView(db(), rod, c);
    const feb = () => mg.months.find((m) => m.month === "2026-02-01")!;
    expect(feb().payrollMinor).toBeNull();
    expect(feb().payrollSource).toBe("not available");
    expect(feb().marginMinor).toBeNull(); // never computed as if payroll were 0
    expect(feb().beforePayrollMinor).toBe(10500);
    await db().transaction(async (tx) => {
      await saveExpense(tx, rod, { month: "2026-02", category: "rent", label: "", amount: "40.00" });
      await saveExpense(tx, rod, { month: "2026-02", category: "payroll_manual", label: "", amount: "50" });
      await saveSpend(tx, rod, { month: "2026-02", channel: "flyers", amount: "5.00" });
    });
    mg = await marginView(db(), rod, c);
    expect(feb().rentMinor).toBe(4000);
    expect(feb().marketingMinor).toBe(500);
    expect(feb().payrollSource).toBe("entered by hand");
    expect(feb().marginMinor).toBe(10500 - 4000 - 500 - 5000);
    // Saving the same month + category again replaces the amount (no double counting).
    await db().transaction((tx) => saveExpense(tx, rod, { month: "2026-02", category: "rent", label: "", amount: "45.00" }));
    mg = await marginView(db(), rod, c);
    expect(feb().rentMinor).toBe(4500);
    await expect(db().transaction((tx) => saveExpense(tx, rod, { month: "2026-02", category: "bribes", amount: "1" }))).rejects.toBeInstanceOf(UserError);
    await expect(db().transaction((tx) => saveExpense(tx, rod, { month: "2026-02", category: "rent", amount: "-1" }))).rejects.toBeInstanceOf(UserError);
  });
});

describe("the funnel: sales, losses and plan changes", () => {
  let org: Org;
  let w: Awaited<ReturnType<typeof scoreboardWorld>>;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
    w = await scoreboardWorld(org, TODAY);
    const [X, Y, Z, W, V, U, U2] = await Promise.all(Array.from({ length: 7 }, () => w.athlete()));
    // X rebuilt: North plan ended Mar 8, South plan started Mar 9. Not a loss, not a sale.
    await w.membership(X, w.planA, { start: -100, end: -10 });
    await w.membership(X, w.planB, { start: -9 });
    // Y left on Mar 6 and has nothing after: the one real loss in March.
    await w.membership(Y, w.planA, { start: -100, end: -12 });
    // Z changed plan in place on Mar 13 (same membership) and is on a family hold keyed on Mar 14.
    const z = await w.membership(Z, w.planA, { start: -100 });
    await db().insert(membershipEvents).values({ membershipId: z.id, type: "plan_changed", createdAt: w.at(w.day(-5)) });
    await w.hold(z.id, -3, 10, 4);
    // W joined on Mar 13: a sale.
    await w.membership(W, w.planA, { start: -5 });
    // V left on Jan 17 (a loss in January) and came back 45 days later on Mar 3 (a sale in March).
    await w.membership(V, w.planA, { start: -200, end: -60 });
    await w.membership(V, w.planA, { start: -15 });
    // U's trial ended Mar 5 and a regular plan started Mar 6: a converted trial and a sale. U2's trial (ended Feb 28) did not convert.
    await w.membership(U, w.trial, { start: -20, end: -13, billingProvider: "none" });
    await w.membership(U, w.planA, { start: -12 });
    await w.membership(U2, w.trial, { start: -25, end: -18, billingProvider: "none" });
    // Leads: four in March, one in February.
    await w.lead({ createdDaysAgo: 2, source: "instagram" });
    const consult = await w.session(-8, { assessment: true, capacity: 1, time: "10:00" });
    await w.lead({ createdDaysAgo: 6, source: "google", stage: "assessment_done", sessionId: consult.id, contacted: true }); // showed (lead record)
    const noShow = await w.session(-4, { assessment: true, capacity: 1, time: "11:00" });
    await w.lead({ createdDaysAgo: 10, source: "google", stage: "lost", sessionId: noShow.id, contacted: true }); // marked lost: not counted as showed
    await w.lead({ createdDaysAgo: 30, source: "referral" });
    await w.lead({ createdDaysAgo: 7, source: "instagram", stage: "won", convertedAthlete: W, contacted: true });
    const wConsult = await w.session(-6, { assessment: true, capacity: 1, time: "12:00" });
    await w.book(wConsult.id, W.athleteId, "attended"); // showed (checked-in booking)
    // One group class on Mar 11: two attended, one no-show.
    const cls = await w.session(-7);
    await w.book(cls.id, Z.athleteId, "attended");
    await w.book(cls.id, W.athleteId, "attended");
    await w.book(cls.id, V.athleteId, "no_show");
    // 300.00 collected in March on Z's membership invoice.
    await w.invoice(Z.payerId, { total: 30000, due: -10, membershipId: z.id, status: "paid", paid: 30000, paidDaysAgo: 9 });
  });

  it("a plan change or rebuild is never a loss and never a sale", async () => {
    const mo = await monthlyScoreboard(db(), await viewerFor(org, "rod"), await ctxFor(org));
    const mar = thisMonth(mo);
    expect(mar.sold).toBe(3); // W, V (returned after 45 days), U (after a trial)
    expect(mar.lost).toBe(1); // Y only; X's ended plan was continued
    expect(mar.plan_changes).toBe(2); // X's rebuild + Z's in-place change
    expect(mar.net_growth).toBe(2);
    expect(month(mo, "2026-01-01").lost).toBe(1); // V
    expect(month(mo, "2026-01-01").plan_changes).toBe(0);
    // The daily page uses the same rule for month to date.
    expect((await daily(org)).metrics.sold_mtd.value).toBe(3);
  });

  it("fills the rest of the monthly rows from the same fixtures", async () => {
    const mo = await monthlyScoreboard(db(), await viewerFor(org, "rod"), await ctxFor(org));
    const mar = thisMonth(mo);
    const feb = month(mo, "2026-02-01");
    expect(mar.leads).toBe(4);
    expect(feb.leads).toBe(1);
    expect(mar.showed).toBe(2);
    expect(mar.close_rate).toBe(1.5);
    expect(feb.close_rate).toBeNull(); // nobody showed: blank, not 0
    expect(feb.trials_sold).toBe(2);
    expect(mar.trial_conversion).toBe(1);
    expect(feb.trial_conversion).toBe(0);
    expect(month(mo, "2026-01-01").trial_conversion).toBeNull();
    expect(mar.active).toBe(5); // X Z W V U
    expect(feb.active).toBe(3); // X Y Z on Feb 28
    expect(mar.holds_processed).toBe(1);
    expect(mar.on_hold).toBe(1);
    expect(feb.on_hold).toBe(0);
    expect(mar.visits).toBe(3);
    expect(mar.avg_attendance).toBe(2); // the consults (capacity 1) are not group sessions
    expect(mar.arpm).toBe(6000); // 30000 / 5 active
    expect(mar.loe).toBeGreaterThan(0);
    expect(feb.at_risk).toBeNull(); // the radar keeps no history
    expect(mar.at_risk).not.toBeNull();
    expect(mo.months[mo.months.length - 1].partial).toBe(true);
  });

  it("applies the program filter to the funnel and withholds what cannot be attributed", async () => {
    const v = await viewerFor(org, "rod");
    const south = thisMonth(await monthlyScoreboard(db(), v, await ctxFor(org, { productId: w.planB.product.id })));
    expect(south.sold).toBe(0); // X's South plan continues the North one
    expect(south.lost).toBe(0);
    expect(south.active).toBe(1);
    expect(south.leads).toBeNull();
    expect(south.showed).toBeNull();
    const north = thisMonth(await monthlyScoreboard(db(), v, await ctxFor(org, { productId: w.planA.product.id })));
    expect(north.lost).toBe(1);
    expect(north.plan_changes).toBe(2);
    expect(north.sold).toBe(3);
    const empty = await monthlyScoreboard(db(), v, await ctxFor(org, { locationId: w.locEmpty.id, productId: w.planNobody.product.id }));
    for (const m of empty.months) {
      for (const r of empty.rows) if (!["leads", "showed", "close_rate"].includes(r.key)) expect(m.values[r.key] ?? 0, `${m.month} ${r.key}`).toBe(0);
    }
  });

  it("marketing: cost per lead and per new member from entered spend and stored lead sources", async () => {
    const rod = await viewerFor(org, "rod");
    const id = await db().transaction((tx) => saveSpend(tx, rod, { month: "2026-03", channel: "Instagram", amount: "$100.00", note: "test" }));
    const mk = await marketingEconomics(db(), rod, await ctxFor(org));
    const ch = (name: string) => mk.channels.find((c) => c.channel.toLowerCase() === name)!;
    expect(ch("instagram")).toMatchObject({ spendMinor: 10000, leads: 2, newMembers: 1, costPerLeadMinor: 5000, costPerMemberMinor: 10000 });
    // Leads but no spend entered: no cost, never $0.
    expect(ch("google")).toMatchObject({ spendMinor: null, leads: 2, costPerLeadMinor: null, costPerMemberMinor: null });
    expect(mk.totals).toMatchObject({ spendMinor: 10000, leads: 5, newMembers: 6, costPerLeadMinor: 2000, costPerMemberMinor: 1667 });
    expect(mk.ltvMinor).toBe(mk.arpmMinor == null || mk.loeMonths == null ? null : Math.round(mk.arpmMinor * mk.loeMonths));
    // Marketing is organization-wide: a page filter does not change it.
    const filtered = await marketingEconomics(db(), rod, await ctxFor(org, { locationId: w.locEmpty.id }));
    expect(filtered.totals).toEqual(mk.totals);
    await db().transaction((tx) => deleteSpend(tx, rod, id));
    expect((await marketingEconomics(db(), rod, await ctxFor(org))).totals.costPerLeadMinor).toBeNull();
    await expect(db().transaction((tx) => saveSpend(tx, rod, { month: "2026-13", channel: "", amount: "x" }))).rejects.toBeInstanceOf(UserError);
  });
});

describe("projected recurring revenue, net of holds", () => {
  let org: Org;
  let w: Awaited<ReturnType<typeof scoreboardWorld>>;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
    w = await scoreboardWorld(org, TODAY);
    const p = await Promise.all(Array.from({ length: 7 }, () => w.athlete()));
    await w.membership(p[0], w.planA, { start: -100 }); // 100.00, all of April
    const m2 = await w.membership(p[1], w.planB, { start: -100 });
    await w.hold(m2.id, 14, 43); // on hold Apr 1 to Apr 30: adds nothing
    const m3 = await w.membership(p[2], w.planAll, { start: -100 });
    await w.hold(m3.id, 14, 28); // on hold Apr 1 to Apr 15: half of 150.00
    await w.membership(p[3], w.planA, { start: -100, cancelAt: w.day(29) }); // cancels Apr 16: 15 of 30 days
    await w.membership(p[4], w.planB, { start: -100, discountId: (await w.discount(10)).id }); // 200.00 less 10%
    await w.membership(p[5], w.planA, { start: -100, billingProvider: "external_zenplanner" }); // billed elsewhere: excluded
    const m7 = await w.membership(p[6], w.planA, { start: -100 });
    await w.hold(m7.id, -5, 5); // on hold now, back before April: all of April
  });

  it("excludes held days, cancelled days and memberships billed elsewhere", async () => {
    const d = await daily(org);
    expect(d.metrics.projected_next_month.value).toBe(10000 + 7500 + 5000 + 18000 + 10000);
    expect(d.metrics.projected_next_month.rowCount).toBe(5); // the fully held membership has no row
    expect(d.metrics.holds_active.value).toBe(1);
    expect(d.metrics.holds_ending_7.value).toBe(1);
  });

  it("is narrowed by the location filter like everything else", async () => {
    expect((await daily(org, { locationId: w.locA.id })).metrics.projected_next_month.value).toBe(10000 + 7500 + 5000 + 10000);
    expect((await daily(org, { locationId: w.locB.id })).metrics.projected_next_month.value).toBe(7500 + 18000);
  });
});

describe("schedule and payroll efficiency", () => {
  let org: Org;
  let w: Awaited<ReturnType<typeof scoreboardWorld>>;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
    w = await scoreboardWorld(org, TODAY);
    const four = await Promise.all(Array.from({ length: 4 }, () => w.athlete()));
    for (const wk of [0, 1, 2, 3]) {
      const full = await w.session(-2 - wk * 7, { title: "Full Class", capacity: 4 }); // Mondays
      for (const a of four) await w.book(full.id, a.athleteId, "attended");
      const thin = await w.session(-1 - wk * 7, { title: "Thin Class", capacity: 10, locationId: w.locB.id }); // Tuesdays
      await w.book(thin.id, four[0].athleteId, "attended");
    }
    const once = await w.session(-6, { title: "One-off", capacity: 4 }); // a single Thursday
    for (const a of four) await w.book(once.id, a.athleteId, "attended");
    await w.session(-9, { title: "Full Class", capacity: 4, status: "cancelled" }); // cancelled: not a session run
    const today = await w.session(0, { title: "Today Class", capacity: 6, time: "18:00" });
    await w.book(today.id, four[0].athleteId, "booked");
    await w.book(today.id, four[1].athleteId, "waitlisted");
  });

  it("flags consistently full and consistently under-used slots, and nothing with too few sessions", async () => {
    const s = await slotUtilisation(db(), await ctxFor(org), { weeks: 8 });
    const slot = (title: string) => s.rows.find((r) => r.title === title)!;
    expect(slot("Full Class")).toMatchObject({ weekday: 1, startTime: "17:00", sessions: 4, avgAttendance: 4, utilisation: 1, flag: "full" });
    expect(slot("Full Class").flagText).toMatch(/Consider adding capacity/);
    expect(slot("Thin Class")).toMatchObject({ weekday: 2, sessions: 4, avgAttendance: 1, utilisation: 0.1, flag: "under" });
    expect(slot("Thin Class").flagText).toMatch(/Consider combining/);
    expect(slot("One-off").flag).toBeNull();
    expect(s.rows.find((r) => r.title === "Today Class")).toBeUndefined(); // only sessions already in the past
    // The under-used threshold is configurable.
    const rod = await viewerFor(org, "rod");
    await db().transaction((tx) => saveThresholds(tx, rod, { slotUnderPercent: "8" }));
    expect((await slotUtilisation(db(), await ctxFor(org), { weeks: 8 })).rows.find((r) => r.title === "Thin Class")!.flag).toBeNull();
    await expect(db().transaction((tx) => saveThresholds(tx, rod, { slotUnderPercent: "99" }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => saveThresholds(tx, rod, { slotUnderPercent: "40" }));
    // Location filter: only that location's sessions.
    const south = await slotUtilisation(db(), await ctxFor(org, { locationId: w.locB.id }), { weeks: 8 });
    expect(south.rows.map((r) => r.title)).toEqual(["Thin Class"]);
  });

  it("today's class table reconciles with the bookings-today number", async () => {
    const c = await ctxFor(org);
    const classes = await classesToday(db(), c);
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ title: "Today Class", capacity: 6, booked: 1, waitlisted: 1 });
    expect((await daily(org)).metrics.bookings_today.value).toBe(classes.reduce((s, x) => s + x.booked, 0));
  });

  it("payroll is 'not available' when there is no time-clock data, never 0, and matches the payroll module when there is", async () => {
    const rod = await viewerFor(org, "rod");
    const c = await ctxFor(org);
    let pay = await payrollByMonth(db(), rod, c);
    expect(pay.access).toBe("ok");
    expect(pay.months).toHaveLength(6);
    for (const m of pay.months) expect(m).toMatchObject({ status: "none", grossMinor: null, totalHours: null, coachingHours: null, percent: null });

    await db().insert(staffPayRates).values({ orgId: org.orgId, userId: org.users.marcus, label: "Coach (test)", rateMinor: 2000, effectiveFrom: "2026-01-01" });
    const shift = (user: string, ymd: string, a: string, b: string) => {
      const clockIn = localToUtc(ymd, a, org.tz);
      const clockOut = localToUtc(ymd, b, org.tz);
      return db().insert(timeEntries).values({ orgId: org.orgId, userId: org.users[user], clockIn, clockOut, originalClockIn: clockIn, originalClockOut: clockOut, source: "manual" });
    };
    await shift("marcus", "2026-02-10", "15:00", "19:00"); // 4 h x 20.00
    await shift("marcus", "2026-03-03", "15:00", "18:00"); // 3 h
    await shift("erin", "2026-03-04", "09:00", "11:00"); // 2 h with no pay rate on file
    pay = await payrollByMonth(db(), rod, c);
    const feb = pay.months.find((m) => m.month === "2026-02-01")!;
    const mar = pay.months.find((m) => m.month === "2026-03-01")!;
    expect(feb).toMatchObject({ status: "ok", coachingHours: 4, totalHours: 4, grossMinor: 8000 });
    expect(feb.grossMinor).toBe((await calculatePayroll(db(), rod, { from: "2026-02-01", to: "2026-02-28", now: NOW })).combined.actual.grossMinor);
    expect(feb.percent).toBeNull(); // nothing collected: no percent rather than a division by zero
    expect(mar.status).toBe("incomplete"); // Erin's hours have no rate, so the cost is understated and says so
    expect(mar.coachingHours).toBe(3);
    expect(mar.totalHours).toBe(5);
    expect(pay.months.find((m) => m.month === "2026-01-01")!.status).toBe("none");
    // The margin refuses to use an incomplete payroll figure.
    const mg = await marginView(db(), rod, c);
    expect(mg.months.find((m) => m.month === "2026-03-01")!.marginMinor).toBeNull();
    expect(mg.months.find((m) => m.month === "2026-02-01")!.marginMinor).toBe(-8000);
    // Payroll is not split by location.
    expect((await payrollByMonth(db(), rod, await ctxFor(org, { locationId: w.locA.id }))).access).toBe("filtered");
  });
});

describe("permissions", () => {
  let org: Org;
  beforeAll(async () => {
    org = await seedOrg(TODAY, { modules: [] });
  });

  it("owner, admin and operations may view; coaches, families and the kiosk may not", async () => {
    for (const key of ["marcus", "tess", "alex", "maya", "kiosk"]) {
      const v = await viewerFor(org, key);
      expect(can(v, "scoreboard.view"), key).toBe(false);
      await expect(scoreboardContext(db(), v, {}), key).rejects.toBeInstanceOf(AuthzError);
    }
    for (const key of ["rod", "erin"]) expect(can(await viewerFor(org, key), "scoreboard.view"), key).toBe(true);
    expect(can(await viewerFor(org, "erin"), "scoreboard.manage")).toBe(false);
  });

  it("operations sees the scoreboard but not payroll cost or the margin, and cannot edit", async () => {
    const erin = await viewerFor(org, "erin");
    const c = await scoreboardContext(db(), erin, { today: TODAY, now: NOW });
    expect((await dailyScoreboard(db(), erin, c)).metrics.active_members.value).toBe(0);
    expect(await payrollByMonth(db(), erin, c)).toEqual({ access: "restricted", months: [] });
    expect((await marginView(db(), erin, c)).access).toBe("restricted");
    await expect(db().transaction((tx) => saveTargets(tx, erin, { target_leads: "10" }, TARGET_KEYS))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => saveThresholds(tx, erin, { slotFullPercent: "80" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => saveSpend(tx, erin, { month: "2026-03", channel: "x", amount: "1" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => saveExpense(tx, erin, { month: "2026-03", category: "rent", amount: "1" }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("the owner saves ideals (audited); unknown rows are ignored and bad numbers rejected", async () => {
    const rod = await viewerFor(org, "rod");
    await db().transaction((tx) => saveTargets(tx, rod, { target_leads: "14", target_close_rate: "60%", target_net_growth: "5", target_nonsense: "1", other: "2" }, TARGET_KEYS));
    let c = await scoreboardContext(db(), rod, {});
    expect(c.settings.targets).toEqual({ leads: 14, close_rate: 60 }); // net_growth takes no ideal
    await db().transaction((tx) => saveTargets(tx, rod, { target_leads: "" }, TARGET_KEYS));
    c = await scoreboardContext(db(), rod, {});
    expect(c.settings.targets).toEqual({ close_rate: 60 });
    await expect(db().transaction((tx) => saveTargets(tx, rod, { target_leads: "-3" }, TARGET_KEYS))).rejects.toBeInstanceOf(UserError);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.action, "scoreboard.targets_update")));
    expect(audits).toHaveLength(2);
    expect(scoreboardSettingsFrom({ scoreboard: { thresholds: { slotFullPercent: 5000, cohortMinDays: 12 }, targets: { leads: -1, sold: 4 } } })).toMatchObject({ thresholds: { slotFullPercent: 90, cohortMinDays: 12 }, targets: { sold: 4 } });
  });
});

describe("where is the bottleneck? (rule of thumb)", () => {
  const targets = { leads: 10, showed: 6, sold: 4, active: 50 };
  const at = (v: Partial<Record<string, number | null>>) => bottleneck({ leads: 10, showed: 6, sold: 4, active: 50, net_growth: 1, ...v }, targets);

  it("reports the first step under its ideal and says which rule fired", () => {
    expect(at({ leads: 9 })).toMatchObject({ stage: "leads" });
    expect(at({ leads: 9 }).rule).toMatch(/^Rule: leads under the ideal \(9 against an ideal of 10\)/);
    expect(at({ showed: 3 })).toMatchObject({ stage: "consults" }); // leads at target, consults under: follow-up / show rate
    expect(at({ showed: 3 }).headline).toMatch(/Follow-up and show rate/);
    expect(at({ sold: 1 })).toMatchObject({ stage: "sales" });
    expect(at({ active: 40 })).toMatchObject({ stage: "retention" });
    expect(at({ net_growth: -2 })).toMatchObject({ stage: "retention" });
    expect(at({ net_growth: -2 }).rule).toMatch(/net growth -2/);
    expect(at({})).toMatchObject({ stage: "none" });
    // Leads short AND sales short: the earlier step wins.
    expect(at({ leads: 2, sold: 0 }).stage).toBe("leads");
  });

  it("skips steps with no ideal or no value instead of guessing", () => {
    expect(bottleneck({ leads: 1, showed: 1, sold: 1, active: 1 }, {})).toMatchObject({ stage: null });
    const noLeadIdeal = bottleneck({ leads: 0, showed: 2, sold: 4, active: 50, net_growth: 0 }, { showed: 6, sold: 4, active: 50 });
    expect(noLeadIdeal.stage).toBe("consults");
    expect(noLeadIdeal.steps.find((s) => s.key === "leads")!.status).toBe("no_target");
    const filtered = bottleneck({ leads: null, showed: null, sold: 1, active: 50 }, targets, { leads: "n/a", showed: "n/a" });
    expect(filtered.stage).toBe("sales");
    expect(filtered.steps.find((s) => s.key === "leads")!.status).toBe("no_data");
  });
});

describe("definitions", () => {
  it("every number has one definition with a version, and keys are unique per tab", () => {
    for (const tab of ["daily", "monthly", "efficiency", "marketing", "money"] as const) {
      const defs = definitionsFor(tab);
      expect(new Set(defs.map((d) => d.key)).size, tab).toBe(defs.length);
      for (const d of defs) {
        expect(d.version, d.key).toBeGreaterThanOrEqual(1);
        expect(d.definition.length, d.key).toBeGreaterThan(40);
        expect(d.definition, d.key).not.toMatch(/—/); // no em dashes
      }
    }
    for (const m of DAILY_METRICS) expect(definitionsFor("daily").some((d) => d.key === m.key), m.key).toBe(true);
    // At-risk reuses the retention module's definition rather than restating one.
    expect(DAILY_METRICS.find((m) => m.key === "at_risk")!.definition).toMatch(/radar's own result/);
    expect(TARGET_KEYS).not.toContain("net_growth");
  });
});
