import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bookings, people, retentionActions, scheduleSessions, sessionFeedback, tasks } from "@/db/schema";
import { AuthzError, can } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { tenureLabel, tenureMonths } from "@/lib/retention/common";
import { createShoutoutTask, milestonesFor, milestonesThisWeek, recurrenceIn, weekOf } from "@/lib/retention/milestones";
import { retentionRadar } from "@/lib/retention/radar";
import { createFollowUpTask } from "@/lib/retention/save-log";
import { winbackList } from "@/lib/retention/winback";
import { reportByKey, toCsv } from "@/lib/reports";
import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

const TODAY = "2026-10-12"; // Monday
const TZ = "America/Indiana/Indianapolis";
const db = () => testDb();
afterAll(closeTestDb);

describe("milestone math (pure)", () => {
  const base = { athleteId: "a", personId: "p", name: "Test Athlete", dateOfBirth: null as string | null, firstStart: null as string | null, attendedDays: [] as string[] };
  const WED = "2026-10-14"; // week Mon 2026-10-12 … Sun 2026-10-18
  const days = (n: number, last: string) => Array.from({ length: n }, (_, i) => addDaysYmd(last, i - (n - 1)));

  it("weeks run Monday to Sunday in local dates", () => {
    expect(weekOf(WED)).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekOf("2026-10-18")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekOf("2026-10-19").start).toBe("2026-10-19");
  });

  it("membership anniversaries: whole years only, recent / today / upcoming", () => {
    expect(milestonesFor({ ...base, firstStart: "2025-10-16" }, WED)).toEqual([{ athleteId: "a", personId: "p", name: "Test Athlete", key: "anniversary:2026", kind: "anniversary", label: "1-year membership anniversary", date: "2026-10-16", when: "upcoming" }]);
    expect(milestonesFor({ ...base, firstStart: "2024-10-12" }, WED)[0]).toMatchObject({ label: "2-year membership anniversary", when: "recent" });
    expect(milestonesFor({ ...base, firstStart: "2023-10-14" }, WED)[0]).toMatchObject({ label: "3-year membership anniversary", when: "today" });
    expect(milestonesFor({ ...base, firstStart: "2026-10-13" }, WED)).toEqual([]); // joined this week: not an anniversary
    expect(milestonesFor({ ...base, firstStart: "2025-10-19" }, WED)).toEqual([]); // next Monday
  });

  it("first 30 days complete", () => {
    expect(milestonesFor({ ...base, firstStart: "2026-09-14" }, WED)).toEqual([expect.objectContaining({ key: "first_30_days", label: "First 30 days complete", date: "2026-10-14", when: "today" })]);
    expect(milestonesFor({ ...base, firstStart: "2026-09-01" }, WED)).toEqual([]);
  });

  it("birthdays this week, never an age; Feb 29 is observed on Feb 28 outside leap years; weeks can span New Year", () => {
    const m = milestonesFor({ ...base, dateOfBirth: "2011-10-18" }, WED);
    expect(m).toEqual([expect.objectContaining({ kind: "birthday", label: "Birthday", date: "2026-10-18", when: "upcoming" })]);
    expect(JSON.stringify(m)).not.toMatch(/2011|15/);
    expect(milestonesFor({ ...base, dateOfBirth: "2011-10-19" }, WED)).toEqual([]);
    expect(recurrenceIn(2027, "2012-02-29")).toBe("2027-02-28");
    expect(recurrenceIn(2028, "2012-02-29")).toBe("2028-02-29");
    expect(milestonesFor({ ...base, dateOfBirth: "2012-02-29" }, "2027-02-24")[0]).toMatchObject({ date: "2027-02-28" });
    expect(milestonesFor({ ...base, dateOfBirth: "2010-01-02" }, "2026-12-30")[0]).toMatchObject({ key: "birthday:2027", date: "2027-01-02", when: "upcoming" });
  });

  it("25 / 50 / 100 / 250 sessions: reached this week, or within two sessions", () => {
    expect(milestonesFor({ ...base, attendedDays: days(25, "2026-10-13") }, WED)).toEqual([expect.objectContaining({ key: "sessions:25", label: "25 sessions attended", date: "2026-10-13", when: "recent" })]);
    expect(milestonesFor({ ...base, attendedDays: days(25, "2026-10-09") }, WED)).toEqual([]); // reached last week
    expect(milestonesFor({ ...base, attendedDays: days(24, "2026-10-13") }, WED)).toEqual([expect.objectContaining({ key: "sessions:25", label: "1 session away from 25", date: null, when: "upcoming" })]);
    expect(milestonesFor({ ...base, attendedDays: days(48, "2026-10-13") }, WED)[0]).toMatchObject({ key: "sessions:50", label: "2 sessions away from 50" });
    expect(milestonesFor({ ...base, attendedDays: days(47, "2026-10-13") }, WED)).toEqual([]);
    expect(milestonesFor({ ...base, attendedDays: days(100, WED) }, WED)[0]).toMatchObject({ key: "sessions:100", when: "today" });
    expect(milestonesFor({ ...base, attendedDays: days(250, "2026-10-12") }, WED)[0]).toMatchObject({ label: "250 sessions attended" });
  });

  it("tenure helpers count whole months", () => {
    expect(tenureMonths("2026-07-15", "2026-09-20")).toBe(2);
    expect(tenureMonths("2026-07-15", "2026-09-14")).toBe(1);
    expect(tenureMonths("2025-01-10", "2026-09-30")).toBe(20);
    expect(tenureMonths("2026-10-01", "2026-09-01")).toBe(0);
    expect([tenureLabel(0), tenureLabel(1), tenureLabel(11), tenureLabel(12), tenureLabel(26)]).toEqual(["under 1 month", "1 month", "11 months", "1 yr", "2 yrs 2 mo"]);
  });
});

describe("milestones this week (database, facility timezone, scope)", () => {
  let ctx: Awaited<ReturnType<typeof seedOrg>>;
  beforeAll(async () => {
    ctx = await seedOrg(TODAY, { modules: [] });
    const w = await retentionWorld(ctx, TODAY);
    const A = ctx.athletes;
    await w.membership(A.maya, "parker", 0, { startDate: "2025-10-12" }); // 1-year anniversary today
    await w.membership(A.leo, "rivera", 100);
    await w.membership(A.ella, "ella", 100);
    await db().update(people).set({ dateOfBirth: "2010-10-15" }).where(eq(people.id, ctx.people.leo_rivera));
    await db().update(people).set({ dateOfBirth: "2012-10-13" }).where(eq(people.id, ctx.people.ella_novak));
    // Ethan has a birthday this week but no membership: not a member, not listed.
    await db().update(people).set({ dateOfBirth: "2010-10-14" }).where(eq(people.id, ctx.people.ethan_cole));
    // Maya: 24 sessions weeks ago, then her 25th on SUNDAY 11:30 PM local = Monday 03:30 UTC.
    for (let d = 40; d > 16; d--) await w.booking(A.maya, -d, "attended");
    const startsAt = localToUtc("2026-10-11", "23:30", TZ);
    expect(startsAt.toISOString()).toBe("2026-10-12T03:30:00.000Z");
    const [s] = await db().insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId: w.svc.id, title: "Late Class", startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), timezone: TZ, capacity: 10 }).returning();
    await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: A.maya, status: "attended" });
  });

  it("lists anniversaries and birthdays for members in the local week", async () => {
    const { items, week } = await milestonesThisWeek(db(), await viewerFor(ctx, "rod"), { today: TODAY });
    expect(week).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(items.map((m) => `${m.name}|${m.key}|${m.date}|${m.when}`)).toEqual([
      "Maya Parker|anniversary:2026|2026-10-12|today",
      "Ella Novak|birthday:2026|2026-10-13|upcoming",
      "Leo Rivera|birthday:2026|2026-10-15|upcoming",
    ]);
  });

  it("uses the facility-local date of a session, not UTC: the 25th session late Sunday belongs to last week", async () => {
    const rod = await viewerFor(ctx, "rod");
    const monday = await milestonesThisWeek(db(), rod, { today: TODAY });
    expect(monday.items.some((m) => m.kind === "sessions")).toBe(false);
    const sunday = await milestonesThisWeek(db(), rod, { today: "2026-10-11" });
    expect(sunday.items.find((m) => m.kind === "sessions")).toMatchObject({ name: "Maya Parker", key: "sessions:25", date: "2026-10-11", when: "today" });
  });

  it("coaches see their assigned athletes only; families are refused", async () => {
    const marcus = await milestonesThisWeek(db(), await viewerFor(ctx, "marcus"), { today: TODAY });
    expect(marcus.items.map((m) => m.name)).toEqual(["Maya Parker", "Leo Rivera"]);
    const tess = await milestonesThisWeek(db(), await viewerFor(ctx, "tess"), { today: TODAY });
    expect(tess.items.map((m) => m.name)).toEqual(["Ella Novak"]);
    for (const k of ["alex", "maya", "kiosk"]) await expect(milestonesThisWeek(db(), await viewerFor(ctx, k), { today: TODAY })).rejects.toBeInstanceOf(AuthzError);
  });

  it("'Create shoutout task' re-derives the milestone server-side, dedupes, and sends nothing", async () => {
    const rod = await viewerFor(ctx, "rod");
    const r = await db().transaction((tx) => createShoutoutTask(tx, rod, { athleteId: ctx.athletes.maya, key: "anniversary:2026" }, { today: TODAY }));
    expect(r.created).toBe(true);
    const again = await db().transaction((tx) => createShoutoutTask(tx, rod, { athleteId: ctx.athletes.maya, key: "anniversary:2026" }, { today: TODAY }));
    expect(again.created).toBe(false);
    const rows = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "retention")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Shoutout: Maya Parker: 1-year membership anniversary", assigneeUserId: rod.userId, relatedPersonId: ctx.people.maya_parker });
    await expect(db().transaction((tx) => createShoutoutTask(tx, rod, { athleteId: ctx.athletes.maya, key: "sessions:250" }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    const tess = await viewerFor(ctx, "tess");
    await expect(db().transaction((tx) => createShoutoutTask(tx, tess, { athleteId: ctx.athletes.maya, key: "anniversary:2026" }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await expect(db().transaction(async (tx) => createShoutoutTask(tx, await viewerFor(ctx, "alex"), { athleteId: ctx.athletes.maya, key: "anniversary:2026" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("retention report and winback list", () => {
  let ctx: Awaited<ReturnType<typeof seedOrg>>;
  const range = { from: "2026-09-01", to: "2026-09-30", tz: TZ };
  beforeAll(async () => {
    ctx = await seedOrg(TODAY, { modules: [] });
    const w = await retentionWorld(ctx, TODAY);
    const A = ctx.athletes;
    const m = (key: string, payer: string, startDate: string, extra: Parameters<typeof w.membership>[3] = {}) => w.membership(A[key], payer, 0, { startDate, ...extra });
    await m("maya", "parker", "2025-01-10"); // 12+ months, stays
    await m("leo", "rivera", "2026-07-15", { status: "cancelled", endDate: "2026-09-20", cancelAt: "2026-09-20", cancelReason: "too expensive" }); // 0–2 months, churns in range
    await m("ethan", "ethan", "2026-04-01", { productVersionId: w.version2.id }); // 3–5 months, stays
    await m("owen", "owen", "2026-02-01", { status: "cancelled", endDate: "2026-06-01" }); // ended in the last 12 months…
    await m("owen", "owen", "2026-10-01"); // …but rejoined, so never on the winback list
    await m("sofia", "sofia", "2026-01-15", { status: "cancelled", endDate: "2026-10-05", cancelAt: "2026-10-05", cancelReason: "moving away" }); // 6–11 months, ends AFTER the range
    await m("liam", "liam", "2026-09-10"); // joined during the range: not in the base
    await m("mason", "mason", "2025-06-01", { status: "cancelled", endDate: "2026-08-15", cancelReason: "Summer only" }); // ended before the range
    await m("harper", "harper", "2026-01-01", { status: "expired", endDate: "2026-06-01" });
    await m("jackson", "jackson", "2025-03-01", { status: "cancelled", endDate: "2025-09-01", cancelReason: "old" }); // more than 12 months ago
    await m("zoe", "zoe", "2026-08-01", { status: "pending" }); // never started
    const at = (d: string) => new Date(`${d}T16:00:00Z`);
    const act = (key: string, outcome: "saved" | "still_at_risk" | "lost", d: string, value: number | null, reasonCode?: string) => ({ orgId: ctx.orgId, athleteId: A[key], level: "at_risk", action: "called", outcome, reasonCode: reasonCode ?? null, valueAtRiskMinor: value, staffUserId: ctx.users.erin, createdAt: at(d) });
    await db().insert(retentionActions).values([
      act("maya", "saved", "2026-09-03", 19900),
      act("ethan", "saved", "2026-09-30", 14900),
      act("ethan", "still_at_risk", "2026-09-12", null),
      act("leo", "lost", "2026-09-18", 19900, "cost"),
      act("sofia", "lost", "2026-10-02", 19900, "moved"), // outside the range
      act("maya", "saved", "2026-08-31", 19900), // outside the range
    ]);
  });

  it("saves, losses by reason, churn by tenure cohort and plan, and average tenure are exact", async () => {
    const def = reportByKey("retention-saves")!;
    const res = await def.run(db(), ctx.orgId, range);
    const row = (section: string, group: string) => res.rows.find((r) => r.section === section && r.group === group);
    expect(row("Outcomes logged", "Saved")).toMatchObject({ count: 2, value_minor: 34800 });
    expect(row("Outcomes logged", "Still at risk")).toMatchObject({ count: 1, value_minor: null });
    expect(row("Outcomes logged", "Lost")).toMatchObject({ count: 1, value_minor: 19900 });
    expect(res.rows.filter((r) => r.section === "Losses by reason").map((r) => [r.group, r.count])).toEqual([["Cost", 1]]);
    expect(row("Churn", "All members")).toMatchObject({ members_start: 4, ended: 1, churn_rate: 0.25 });
    expect(res.rows.filter((r) => r.section === "Churn by tenure cohort").map((r) => [r.group, r.members_start, r.ended, r.churn_rate])).toEqual([
      ["0–2 months", 1, 1, 1],
      ["3–5 months", 1, 0, 0],
      ["6–11 months", 1, 0, 0],
      ["12+ months", 1, 0, 0],
    ]);
    expect(res.rows.filter((r) => r.section === "Churn by plan").map((r) => [r.group, r.members_start, r.ended])).toEqual([
      ["Test 2x Week", 1, 0],
      ["Test Unlimited", 3, 1],
    ]);
    // Current members on Sep 30: Maya 20, Ethan 5, Sofia 8, Liam 0 months → 8.3. Leo churned after 2.
    expect(row("Average tenure", "Current members")).toMatchObject({ count: 4, avg_tenure_months: 8.3 });
    expect(row("Average tenure", "Churned in range")).toMatchObject({ count: 1, avg_tenure_months: 2 });
    expect(res.summary).toEqual([
      { label: "Saves logged", value: 2 },
      { label: "Losses logged", value: 1 },
      { label: "Athlete churn", value: "25% (1 of 4)" },
      { label: "Avg tenure, current members", value: "8.3 months" },
    ]);
    for (const r of res.rows) expect(String(r.how).length).toBeGreaterThan(40); // every row says how it is computed
  });

  it("a churned athlete with no logged loss is counted as 'No outcome logged'; an empty base is 'not calculable'", async () => {
    const def = reportByKey("retention-saves")!;
    const oct = await def.run(db(), ctx.orgId, { from: "2026-10-01", to: "2026-10-12", tz: TZ });
    expect(oct.rows.filter((r) => r.section === "Losses by reason").map((r) => [r.group, r.count])).toEqual([["Moved away", 1]]);
    const aug = await def.run(db(), ctx.orgId, { from: "2026-08-01", to: "2026-08-31", tz: TZ });
    expect(aug.rows.find((r) => r.group === "No outcome logged")).toMatchObject({ count: 1 }); // Mason
    const none = await def.run(db(), ctx.orgId, { from: "2020-01-01", to: "2020-01-31", tz: TZ });
    expect(none.summary?.[2].value).toBe("not calculable");
    expect(none.rows.find((r) => r.section === "Churn")).toMatchObject({ members_start: 0, churn_rate: null });
  });

  it("exports through the existing CSV writer with money in dollars, and is limited to owner/admin/operations", async () => {
    const def = reportByKey("retention-saves")!;
    const csv = toCsv(def.columns, (await def.run(db(), ctx.orgId, range)).rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Section,Group,Count,Members at start,Ended,Churn,Avg tenure (months),Est. monthly value (USD),How it is computed");
    expect(lines[1].startsWith("Outcomes logged,Saved,2,,,,,348.00,")).toBe(true);
    expect(def.definition).toMatch(/estimates/);
    for (const k of ["rod", "erin"]) expect(can(await viewerFor(ctx, k), def.cap)).toBe(true);
    for (const k of ["marcus", "alex", "maya"]) expect(can(await viewerFor(ctx, k), def.cap)).toBe(false);
  });

  it("winback list: ended in the last 12 months, no membership now, with reason, last plan and tenure", async () => {
    const { rows, since } = await winbackList(db(), await viewerFor(ctx, "erin"), { today: TODAY });
    expect(since).toBe("2025-10-12");
    expect(rows.map((r) => [r.name, r.endedOn, r.lastPlan, r.endReason, r.reasonSource, r.tenureMonths])).toEqual([
      ["Sofia Reyes", "2026-10-05", "Test Unlimited", "Moved away", "save log", 8],
      ["Leo Rivera", "2026-09-20", "Test Unlimited", "Cost", "save log", 2],
      ["Mason Patel", "2026-08-15", "Test Unlimited", "Summer only", "cancellation", 14],
      ["Harper Lindqvist", "2026-06-01", "Test Unlimited", "Not recorded", "none", 5],
    ]);
    await expect(winbackList(db(), await viewerFor(ctx, "marcus"))).rejects.toBeInstanceOf(AuthzError);
    await expect(winbackList(db(), await viewerFor(ctx, "alex"))).rejects.toBeInstanceOf(AuthzError);
  });

  it("the only winback action is a staff follow-up task", async () => {
    const erin = await viewerFor(ctx, "erin");
    const r = await db().transaction((tx) => createFollowUpTask(tx, erin, { athleteId: ctx.athletes.leo, kind: "winback" }, { today: TODAY }));
    expect(r.created && r.task.title).toBe("Winback outreach: Leo Rivera");
    const { rows } = await winbackList(db(), erin, { today: TODAY });
    expect(rows.find((x) => x.name === "Leo Rivera")?.lastTask?.title).toBe("Winback outreach: Leo Rivera");
  });
});

describe("demo seed (scripts/seed/retention.ts)", () => {
  it("shapes one synthetic member per signal, a healthy control, feedback, a follow-up task and a logged save", async () => {
    const today = todayLocal(TZ);
    const ctx = await seedOrg(today);
    const rod = await viewerFor(ctx, "rod");
    const radar = await retentionRadar(db(), rod, { today });
    const keys = (k: string) => radar.rows.find((r) => r.athleteId === ctx.athletes[`ret_${k}`])?.signals.map((s) => s.key);
    expect(keys("ines")).toEqual([]);
    expect(keys("rowan")).toEqual(expect.arrayContaining(["attendance_gap", "no_upcoming"]));
    expect(keys("priya")).toEqual(["attendance_drop"]);
    expect(keys("felix")).toEqual(["no_show_rate"]);
    expect(keys("greta")).toEqual(["payment_failed", "card_expiring"]);
    expect(keys("mateo")).toEqual(["hold_restart", "no_upcoming"]);
    expect(keys("imani")).toEqual(["hold_ending"]);
    expect(keys("tobias")).toEqual(["commitment_ending"]);
    expect(keys("nia")).toEqual(["in_season_ending"]);
    expect(keys("caleb")).toEqual(["cancel_requested"]);
    expect(keys("quinn")).toEqual(["open_request"]);
    expect(keys("hugo")).toEqual(["onboarding"]);
    expect(keys("sage")).toEqual(["missing_forms"]);
    expect(radar.rows.find((r) => r.name === "Leo Rivera")?.signals.map((s) => s.key)).toContain("low_feedback");
    expect(radar.summary.savesThisMonth).toBeGreaterThanOrEqual(0);
    const fb = await db().select().from(sessionFeedback).where(eq(sessionFeedback.orgId, ctx.orgId));
    expect(fb.length).toBeGreaterThanOrEqual(6);
    expect(fb.every((f) => f.isDemo)).toBe(true);
    expect(await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "session_feedback")))).toHaveLength(1);
    expect((await db().select().from(retentionActions).where(eq(retentionActions.orgId, ctx.orgId))).map((a) => a.outcome).sort()).toEqual(["lost", "saved"]);
    expect((await winbackList(db(), rod, { today })).rows.map((r) => r.name).sort()).toEqual(expect.arrayContaining(["Kofi Hartmann", "Selma Drury"]));
    const ms = await milestonesThisWeek(db(), rod, { today });
    expect(ms.items.map((m) => `${m.name}: ${m.kind}`)).toEqual(expect.arrayContaining(["Ines Marchetti: anniversary", "Tobias Lindgren: birthday", "Hugo Calloway: first_30_days", "Ines Marchetti: sessions"]));
  });
});
