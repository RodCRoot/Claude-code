import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { athletes, auditEvents, memberRequestAthletes, memberRequests, membershipHolds, organizations, paymentMethods, people, retentionActions, tasks, transactions } from "@/db/schema";
import { AuthzError, can } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { DEFAULT_RETENTION_SETTINGS, parseRetentionSettings, retentionSettingsFrom, saveRetentionSettings, SIGNAL_KEYS, type SignalKey } from "@/lib/retention/common";
import { submitFeedback } from "@/lib/retention/feedback";
import { filterRadar, retentionRadar, type RadarResult } from "@/lib/retention/radar";
import { createFollowUpTask, logOutcome } from "@/lib/retention/save-log";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

/**
 * One synthetic fixture per signal plus a healthy control. Core-only org; every member gets the
 * same healthy baseline (steady 2x/week attendance, one upcoming booking, completed required form)
 * and then deviates in exactly one way. "Today" is Monday 2026-10-12 (facility time).
 */
const TODAY = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let w: Awaited<ReturnType<typeof retentionWorld>>;
let radar: RadarResult;
let zedId = "";
const db = () => testDb();
const day = (n: number) => addDaysYmd(TODAY, n);
const run = async (userKey = "rod") => retentionRadar(db(), await viewerFor(ctx, userKey), { today: TODAY });
const keysOf = (r: RadarResult, athleteKey: string) => r.rows.find((x) => x.athleteId === (ctx.athletes[athleteKey] ?? athleteKey))?.signals.map((s) => s.key);
const rowOf = (r: RadarResult, athleteKey: string) => r.rows.find((x) => x.athleteId === (ctx.athletes[athleteKey] ?? athleteKey))!;

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  w = await retentionWorld(ctx, TODAY);
  const form = await w.requiredForm();
  const A = ctx.athletes;
  const steady = w.steadyDays();
  const healthy = async (key: string, payer: string | null, opts: { visits?: number[]; upcoming?: boolean; start?: number; extra?: Parameters<typeof w.membership>[3]; form?: boolean } = {}) => {
    const m = await w.membership(A[key], payer, opts.start ?? 200, opts.extra);
    await w.attend(A[key], opts.visits ?? steady);
    if (opts.upcoming !== false) await w.booking(A[key], 2, "booked");
    if (opts.form !== false) {
      const [a] = await db().select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, A[key]));
      await form.complete(A[key], a.personId);
    }
    return m;
  };

  // Control.
  await healthy("maya", "parker");
  // attendance_gap (+ the drop that necessarily comes with it): nothing in the last 22 days.
  await healthy("leo", "rivera", { visits: steady.filter((d) => d >= 22) });
  // attendance_drop: baseline 2/week, two visits in the recent 28 days.
  await healthy("ethan", "ethan", { visits: steady.filter((d) => d >= 28 || d === 2 || d === 9) });
  // no_show_rate: 4 misses on top of 8 attended in 28 days (33%), none before.
  await healthy("sofia", "sofia");
  for (const [d, st] of [[3, "no_show"], [6, "no_show"], [10, "late_cancelled"], [13, "no_show"]] as const) await w.booking(A.sofia, -d, st);
  // no_upcoming.
  await healthy("liam", "liam", { upcoming: false });
  // payment_failed: a failed charge 5 days ago, nothing successful since.
  await healthy("mason", "mason");
  await db().insert(transactions).values({ orgId: ctx.orgId, payerAccountId: ctx.payers.mason, kind: "charge", status: "failed", amountMinor: 19900, currency: "USD", provider: "stripe", providerTxnId: `f-${ctx.orgId}`, occurredAt: new Date(Date.parse(`${day(-5)}T15:00:00Z`)), verification: "provider_verified", notes: "card_declined" });
  // card_expiring: default card expires this month. An earlier failed charge was followed by a success → no payment signal.
  await healthy("zoe", "zoe");
  await db().insert(paymentMethods).values({ payerAccountId: ctx.payers.zoe, provider: "stripe", providerMethodId: "pm_t", type: "card", brand: "Visa", last4: "4242", expMonth: 10, expYear: 2026, isDefault: true });
  await db().insert(transactions).values([
    { orgId: ctx.orgId, payerAccountId: ctx.payers.zoe, kind: "charge", status: "failed", amountMinor: 19900, currency: "USD", provider: "stripe", providerTxnId: `zf-${ctx.orgId}`, occurredAt: new Date(Date.parse(`${day(-9)}T15:00:00Z`)), verification: "provider_verified" },
    { orgId: ctx.orgId, payerAccountId: ctx.payers.zoe, kind: "charge", status: "settled", amountMinor: 19900, currency: "USD", provider: "stripe", providerTxnId: `zs-${ctx.orgId}`, occurredAt: new Date(Date.parse(`${day(-7)}T15:00:00Z`)), settledAt: new Date(Date.parse(`${day(-7)}T15:00:00Z`)), verification: "provider_verified" },
  ]);
  // hold_ending: on hold until +5 days; attendance rules are suspended while paused.
  const jackson = await healthy("jackson", "jackson", { visits: steady.filter((d) => d >= 11), upcoming: false, extra: { status: "on_hold" } });
  await db().insert(membershipHolds).values({ membershipId: jackson.id, startDate: day(-10), endDate: day(5) });
  // hold_restart: hold ended 8 days ago, no visit since (a booking exists, so only this signal).
  const ella = await healthy("ella", "ella", { visits: steady.filter((d) => d >= 41) });
  await db().insert(membershipHolds).values({ membershipId: ella.id, startDate: day(-40), endDate: day(-8) });
  // commitment_ending.
  await healthy("owen", "owen", { extra: { commitmentStartsOn: day(-150), commitmentEndsOn: day(30) } });
  // in_season_ending (fixed term always carries cancel_at; that must not read as a cancel request).
  await healthy("aria", "aria", { extra: { kind: "in_season", endDate: day(10), cancelAt: day(10) } });
  // open_request: an open hold request. A keyword SUGGESTION staff never confirmed must not count.
  await healthy("harper", "harper");
  const [req] = await db().insert(memberRequests).values({ orgId: ctx.orgId, type: "hold", channel: "sms", sentOn: day(-6) }).returning();
  const [sug] = await db().insert(memberRequests).values({ orgId: ctx.orgId, type: "cancel", channel: "sms", sentOn: day(-2), suggested: true, matchedKeyword: "cancel" }).returning();
  await db().insert(memberRequestAthletes).values([{ requestId: req.id, athleteId: A.harper }, { requestId: sug.id, athleteId: A.harper }]);
  // cancel_requested: cancellation scheduled on a regular plan.
  await healthy("ava", "chris_parker", { extra: { cancelAt: day(20), cancelReason: "moving" } });
  // low_feedback: Dana (adult athlete) rated her last session 2 and did NOT tick "tell my coach".
  await healthy("dana", "dana");
  const [danaBooking] = (await db().execute(sql`select b.id from bookings b join schedule_sessions s on s.id = b.session_id where b.athlete_id = ${A.dana} and b.status = 'attended' order by s.starts_at desc limit 1`)).rows as { id: string }[];
  await db().transaction(async (tx) => submitFeedback(tx, await viewerFor(ctx, "dana"), { bookingId: danaBooking.id, rating: 2, comment: "Too crowded" }, new Date(Date.parse(`${day(-1)}T12:00:00Z`))));
  // onboarding: day 45 of a first membership, no visit in the first 30 days (one last week).
  await healthy("eli", "parker", { start: 45, visits: [5] });
  // missing_forms: a new athlete without the required form.
  const [zp] = await db().insert(people).values({ orgId: ctx.orgId, firstName: "Zed", lastName: "Formless" }).returning();
  const [za] = await db().insert(athletes).values({ orgId: ctx.orgId, personId: zp.id }).returning();
  zedId = za.id;
  await w.membership(za.id, null, 200);
  await w.attend(za.id, steady);
  await w.booking(za.id, 2, "booked");

  radar = await run();
});

afterAll(closeTestDb);

describe("retention radar: one fixture per signal", () => {
  const expected: [string, SignalKey[]][] = [
    ["maya", []],
    ["leo", ["attendance_gap", "attendance_drop"]],
    ["ethan", ["attendance_drop"]],
    ["sofia", ["no_show_rate"]],
    ["liam", ["no_upcoming"]],
    ["mason", ["payment_failed"]],
    ["zoe", ["card_expiring"]],
    ["jackson", ["hold_ending"]],
    ["ella", ["hold_restart"]],
    ["owen", ["commitment_ending"]],
    ["aria", ["in_season_ending"]],
    ["harper", ["open_request"]],
    ["ava", ["cancel_requested"]],
    ["dana", ["low_feedback"]],
    ["eli", ["onboarding"]],
  ];
  for (const [key, signals] of expected) {
    it(`${key}: ${signals.length ? signals.join(" + ") : "healthy control has no signals"}`, () => {
      expect(keysOf(radar, key)).toEqual(signals);
    });
  }
  it("missing required form blocks booking", () => {
    expect(keysOf(radar, zedId)).toEqual(["missing_forms"]);
    expect(rowOf(radar, zedId).signals[0].evidence).toContain("Test Waiver");
  });

  it("every signal is covered by a fixture and carries plain-language evidence", () => {
    const seen = new Set(radar.rows.flatMap((r) => r.signals.map((s) => s.key)));
    expect([...seen].sort()).toEqual([...SIGNAL_KEYS].sort());
    for (const r of radar.rows) for (const s of r.signals) expect(s.evidence.length).toBeGreaterThan(15);
    expect(rowOf(radar, "leo").signals[0].evidence).toMatch(/Last visit Sep 19, 2026: 23 days ago \(threshold 21 days\)/);
    expect(rowOf(radar, "ethan").signals[0].evidence).toBe("2 visits in the last 28 days (0.5/week) vs 16 in the 56 days before (2.0/week): down 75% (threshold 40%).");
    expect(rowOf(radar, "sofia").signals[0].evidence).toContain("4 of 12 bookings in the last 28 days were no-shows or late cancels (33%)");
    expect(rowOf(radar, "eli").signals[0].evidence).toBe("New member (day 45): 0 visits in the first 30 days, expected at least 3.");
  });

  it("levels: none → low, one watch-weight signal → watch, a high-weight signal or two together → at risk", () => {
    expect(rowOf(radar, "maya").level).toBe("low");
    expect(rowOf(radar, "ethan").level).toBe("watch");
    expect(rowOf(radar, "liam").level).toBe("watch");
    expect(rowOf(radar, "leo").level).toBe("at_risk");
    expect(rowOf(radar, "mason").level).toBe("at_risk");
    expect(rowOf(radar, "ava").level).toBe("at_risk");
  });

  it("value at risk is the plan's monthly price in minor units and the header sums at-risk members only", () => {
    expect(rowOf(radar, "maya").valueAtRiskMinor).toBe(19900);
    const atRisk = radar.rows.filter((r) => r.level === "at_risk");
    expect(atRisk.map((r) => r.name).sort()).toEqual(["Ava Parker", "Leo Rivera", "Mason Patel"]);
    expect(radar.summary).toMatchObject({ members: 16, atRisk: 3, revenueAtRiskMinor: 3 * 19900, savesThisMonth: 0, currency: "USD" });
    expect(radar.summary.avgTenureMonths).toBeGreaterThan(5);
  });

  it("recommends a next action from the signals and addresses the right person", () => {
    expect(rowOf(radar, "mason").recommendation.label).toBe("Send a card update request");
    expect(rowOf(radar, "leo").recommendation.label).toBe("Call the parent and offer a makeup session");
    expect(rowOf(radar, "dana").recommendation.label).toBe("Call the athlete to follow up on session feedback");
    expect(rowOf(radar, "owen").recommendation.label).toMatch(/goal review/);
    expect(rowOf(radar, "maya").recommendation.key).toBe("none");
  });

  it("the feedback signal never quotes the comment", () => {
    expect(JSON.stringify(radar.rows)).not.toContain("Too crowded");
  });

  it("filters by level, plan, coach and signal; default view hides low; sorts by value", () => {
    expect(filterRadar(radar.rows, {}).every((r) => r.level !== "low")).toBe(true);
    expect(filterRadar(radar.rows, { level: "low" }).map((r) => r.name)).toEqual(["Maya Parker"]);
    expect(filterRadar(radar.rows, { signal: "no_show_rate" }).map((r) => r.name)).toEqual(["Sofia Reyes"]);
    expect(filterRadar(radar.rows, { level: "all", coach: ctx.users.tess }).map((r) => r.name).sort()).toEqual(["Aria Castellanos", "Ava Parker", "Eli Parker", "Ella Novak", "Harper Lindqvist", "Owen Fitzgerald"]);
    expect(filterRadar(radar.rows, { level: "all", plan: "Nope" })).toEqual([]);
    const byValue = filterRadar(radar.rows, { level: "all", sort: "value" }).map((r) => r.valueAtRiskMinor ?? 0);
    expect(byValue).toEqual([...byValue].sort((a, b) => b - a));
  });
});

// Counted for this test's own org only: other test files write to the same database in parallel.
const countOwnRows = () =>
  sql`select (select count(*) from tasks where org_id = ${ctx.orgId}) + (select count(*) from audit_events where org_id = ${ctx.orgId}) + (select count(*) from retention_actions where org_id = ${ctx.orgId}) as n`;

describe("retention radar: rules of the road", () => {
  it("is read-only: the whole computation runs inside a READ ONLY transaction", async () => {
    const v = await viewerFor(ctx, "rod");
    const before = await db().execute(countOwnRows());
    const res = await db().transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return retentionRadar(tx, v, { today: TODAY });
    });
    expect(res.rows).toHaveLength(16);
    const after = await db().execute(countOwnRows());
    expect(after.rows[0].n).toEqual(before.rows[0].n);
  });

  it("never reads health or wellness data", () => {
    const src = ["radar.ts", "milestones.ts", "winback.ts", "save-log.ts", "reports.ts"].map((f) => fs.readFileSync(path.join(__dirname, "../src/lib/retention", f), "utf8")).join("\n");
    expect(src).not.toMatch(/questionnaire|body_region|bodyRegion|habit|metric_values|metricValues|wearable|activity_sessions|raw_signals|test_sessions|submitted_data|canViewHealth|health\./i);
  });

  it("coach scope: assigned athletes only, with no billing signals and no dollar values", async () => {
    const marcus = await run("marcus");
    expect(marcus.rows.map((r) => r.name).sort()).toEqual(["Dana Brooks", "Ethan Cole", "Jackson Mbeki", "Leo Rivera", "Liam Okafor", "Mason Patel", "Maya Parker", "Sofia Reyes", "Zoe Whitaker"]);
    expect(marcus.showBilling).toBe(false);
    expect(marcus.rows.every((r) => r.valueAtRiskMinor === null)).toBe(true);
    expect(marcus.summary.revenueAtRiskMinor).toBeNull();
    expect(keysOf(marcus, "mason")).toEqual([]);
    expect(keysOf(marcus, "zoe")).toEqual([]);
    expect(rowOf(marcus, "mason").level).toBe("low");
    // Feedback that was not shared with the coach is not a signal for the coach.
    expect(keysOf(marcus, "dana")).toEqual([]);
    const tess = await run("tess");
    expect(tess.rows.map((r) => r.name)).not.toContain("Leo Rivera");
    expect(tess.rows).toHaveLength(6);
  });

  it("is staff-only: guardians, athletes and kiosks are refused", async () => {
    for (const k of ["alex", "maya", "kiosk"]) await expect(run(k)).rejects.toBeInstanceOf(AuthzError);
    expect(can(await viewerFor(ctx, "marcus"), "retention.manage")).toBe(false);
    expect(can(await viewerFor(ctx, "erin"), "retention.manage")).toBe(true);
  });

  it("does not leak across organizations", async () => {
    const other = await seedOrg(TODAY, { modules: [] });
    const res = await retentionRadar(db(), await viewerFor(other, "rod"), { today: TODAY });
    expect(res.rows).toEqual([]);
    await expect(db().transaction(async (tx) => logOutcome(tx, await viewerFor(other, "rod"), { athleteId: ctx.athletes.leo, action: "called", outcome: "saved" }))).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("thresholds come from organization settings", () => {
  it("defaults apply when nothing is saved and invalid saved values are ignored", () => {
    expect(retentionSettingsFrom(null)).toEqual(DEFAULT_RETENTION_SETTINGS);
    expect(retentionSettingsFrom({ retention: { attendanceDropPercent: 60, lowRatingThreshold: 99, noShowMinMisses: "x" } })).toMatchObject({ attendanceDropPercent: 60, lowRatingThreshold: 2, noShowMinMisses: 2 });
    const bad = parseRetentionSettings({ ...DEFAULT_RETENTION_SETTINGS, attendanceDropPercent: "200", onboardingVisits60: 1 }, DEFAULT_RETENTION_SETTINGS);
    expect(Object.keys(bad.errors).sort()).toEqual(["attendanceDropPercent", "onboardingVisits60"]);
  });

  it("only owner/admin can save; the save is validated and audited; signals follow the saved numbers", async () => {
    await expect(db().transaction(async (tx) => saveRetentionSettings(tx, await viewerFor(ctx, "erin"), { ...DEFAULT_RETENTION_SETTINGS }))).rejects.toBeInstanceOf(AuthzError);
    const rod = await viewerFor(ctx, "rod");
    const [original] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const raw = { ...DEFAULT_RETENTION_SETTINGS, attendanceDropPercent: 80, noShowRatePercent: 50, commitmentEndingDays: 14 };
    const saved = await db().transaction((tx) => saveRetentionSettings(tx, rod, raw));
    expect(saved.ok).toBe(true);
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db().update(organizations).set({ settings: { ...org.settings, membershipPolicy: { attendanceGapDays: 40 } } }).where(eq(organizations.id, ctx.orgId));
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "org.retention_settings_update")));
    expect((a.after as { attendanceDropPercent: number }).attendanceDropPercent).toBe(80);
    try {
      const r = await run();
      expect(keysOf(r, "ethan")).toEqual([]); // 75% drop < 80%
      expect(keysOf(r, "leo")).toEqual([]); // 23-day gap < 40 (membership policy attendanceGapDays); 75% drop < 80%
      expect(keysOf(r, "sofia")).toEqual([]); // 33% < 50%
      expect(keysOf(r, "owen")).toEqual([]); // 30 days out > 14
      expect(keysOf(r, "maya")).toEqual([]);
    } finally {
      await db().update(organizations).set({ settings: original.settings }).where(eq(organizations.id, ctx.orgId));
    }
    expect(keysOf(await run(), "ethan")).toEqual(["attendance_drop"]);
  });
});

describe("save log and follow-up tasks", () => {
  it("logs an outcome with a snapshot of the signals, audited; a loss needs a reason", async () => {
    const rod = await viewerFor(ctx, "rod");
    await expect(db().transaction((tx) => logOutcome(tx, rod, { athleteId: ctx.athletes.leo, action: "called", outcome: "lost" }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    const r = await db().transaction((tx) => logOutcome(tx, rod, { athleteId: ctx.athletes.leo, action: "offered_makeup", outcome: "saved", notes: "Back Thursday" }, { today: TODAY }));
    expect(r).toMatchObject({ level: "at_risk", outcome: "saved", valueAtRiskMinor: 19900, staffUserId: rod.userId, reasonCode: null });
    expect(r.signals.map((s) => s.key)).toEqual(["attendance_gap", "attendance_drop"]);
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityType, "retention_action"), eq(auditEvents.entityId, r.id)));
    expect(a.action).toBe("retention.outcome_log");
    const lost = await db().transaction((tx) => logOutcome(tx, rod, { athleteId: ctx.athletes.ava, action: "called", outcome: "lost", reasonCode: "moved" }, { today: TODAY }));
    expect(lost.reasonCode).toBe("moved");
    // The database itself refuses a loss without a reason.
    await expect(db().insert(retentionActions).values({ orgId: ctx.orgId, athleteId: ctx.athletes.ava, level: "low", action: "called", outcome: "lost", staffUserId: rod.userId })).rejects.toThrow();
    const after = await run();
    expect(rowOf(after, "leo").lastContact).toMatchObject({ kind: "outcome" });
    expect(rowOf(after, "leo").lastOutcome?.outcome).toBe("saved");
  });

  it("a coach can log for an assigned athlete (no billing data in the snapshot) but not for anyone else", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const r = await db().transaction((tx) => logOutcome(tx, marcus, { athleteId: ctx.athletes.mason, action: "in_person", outcome: "still_at_risk" }, { today: TODAY }));
    expect(r.valueAtRiskMinor).toBeNull();
    expect(r.signals).toEqual([]);
    await expect(db().transaction((tx) => logOutcome(tx, marcus, { athleteId: ctx.athletes.ella, action: "called", outcome: "saved" }, { today: TODAY }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction(async (tx) => logOutcome(tx, await viewerFor(ctx, "alex"), { athleteId: ctx.athletes.maya, action: "called", outcome: "saved" }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("creates one follow-up task per athlete per day in the existing tasks table, with the evidence", async () => {
    const erin = await viewerFor(ctx, "erin");
    const first = await db().transaction((tx) => createFollowUpTask(tx, erin, { athleteId: ctx.athletes.sofia, kind: "follow_up" }, { today: TODAY }));
    expect(first.created).toBe(true);
    const again = await db().transaction((tx) => createFollowUpTask(tx, erin, { athleteId: ctx.athletes.sofia, kind: "follow_up" }, { today: TODAY }));
    expect(again.created).toBe(false);
    const rows = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "retention")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Retention follow-up: Sofia Reyes", assigneeUserId: erin.userId, relatedPersonId: ctx.people.sofia_reyes, status: "open" });
    expect(rows[0].description).toContain("No-shows rising");
    expect(rowOf(await run(), "sofia").lastContact).toMatchObject({ kind: "task" });
    const tess = await viewerFor(ctx, "tess");
    await expect(db().transaction((tx) => createFollowUpTask(tx, tess, { athleteId: ctx.athletes.sofia, kind: "follow_up" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction(async (tx) => createFollowUpTask(tx, await viewerFor(ctx, "marcus"), { athleteId: ctx.athletes.sofia, kind: "winback" }))).rejects.toBeInstanceOf(AuthzError);
  });
});
