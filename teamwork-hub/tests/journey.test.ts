import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  athletes,
  auditEvents,
  coachAssignments,
  communityShoutouts,
  groupMembers,
  invoices,
  jobs,
  journeySteps,
  journeys,
  membershipHolds,
  memberships,
  messageDeliveries,
  messages,
  notes,
  paymentMethods,
  people,
  programAssignments,
  programs,
  sessionFeedback,
  tasks,
  threads,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { jobHandlers } from "@/lib/jobs-registry";
import { journeyCompletionReport, onboardingCompletionByMonth, touchpointTimelinessByMonth, milestoneRecognitionByMonth } from "@/lib/journey/reports";
import { resetJourneyTemplate, saveJourneyNumbers, saveJourneyTemplate } from "@/lib/journey/settings";
import { assignStep, completeStep, followUpQueue, journeyPanel, logReachOut, reachOutLists, skipStep, snoozeStep } from "@/lib/journey/steps";
import { syncJourneys } from "@/lib/journey/sync";
import { DEFAULT_TEMPLATES, journeySettingsFrom } from "@/lib/journey/templates";
import { createShoutoutTask } from "@/lib/retention/milestones";
import { JOURNEY_NIGHTLY_JOB, NIGHTLY_JOB_TYPES, SCHEDULED_JOBS, runJourneyNightly } from "@/lib/scheduled/jobs";
import { organizations } from "@/db/schema";
import { addDaysYmd } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { retentionWorld } from "./retention-helpers";

/**
 * Core-only org, "today" is Monday 2026-10-12 (facility time, America/Indiana/Indianapolis).
 * Each scenario uses its own athletes so the checks do not depend on each other's order more
 * than stated. marcus coaches the HS group (maya, leo, ethan, sofia, liam, mason, zoe, jackson)
 * and dana; tess coaches the youth group (eli, ava, harper, ella, owen, aria).
 */
const TODAY = "2026-10-12";
const NOW = new Date("2026-10-12T16:00:00Z");
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let w: Awaited<ReturnType<typeof retentionWorld>>;
const db = () => testDb();
const day = (n: number) => addDaysYmd(TODAY, n);
const sync = (athleteIds?: string[]) => db().transaction((tx) => syncJourneys(tx, ctx.orgId, { today: TODAY, now: NOW, athleteIds }));
const viewer = (k: string) => viewerFor(ctx, k);

type StepInfo = { taskId: string; stepKey: string; status: string; dueOn: string; originalDueOn: string | null; completedVia: string | null; suppressed: boolean; dedupeKey: string | null; assignee: string | null; billing: boolean; skipReason: string | null };
async function stepsOf(athleteKey: string, kind: string): Promise<StepInfo[]> {
  const rows = await db()
    .select({ taskId: journeySteps.taskId, stepKey: journeySteps.stepKey, status: tasks.status, dueOn: journeySteps.dueOn, originalDueOn: journeySteps.originalDueOn, completedVia: journeySteps.completedVia, suppressed: journeySteps.suppressed, dedupeKey: tasks.dedupeKey, assignee: tasks.assigneeUserId, billing: journeySteps.billing, skipReason: journeySteps.skipReason })
    .from(journeySteps)
    .innerJoin(tasks, eq(tasks.id, journeySteps.taskId))
    .where(and(eq(journeySteps.orgId, ctx.orgId), eq(journeySteps.athleteId, ctx.athletes[athleteKey]), eq(journeySteps.kind, kind as "hold")));
  return rows;
}
const stepOf = async (athleteKey: string, kind: string, key: string) => (await stepsOf(athleteKey, kind)).find((s) => s.stepKey === key);
const journeyOf = async (athleteKey: string, kind: string) => (await db().select().from(journeys).where(and(eq(journeys.orgId, ctx.orgId), eq(journeys.athleteId, ctx.athletes[athleteKey]), eq(journeys.kind, kind as "hold"))))[0];
const personOf = async (athleteKey: string) => (await db().select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, ctx.athletes[athleteKey])))[0].personId;
const counts = async () => ({
  journeys: (await db().select({ n: sql<number>`count(*)::int` }).from(journeys).where(eq(journeys.orgId, ctx.orgId)))[0].n,
  steps: (await db().select({ n: sql<number>`count(*)::int` }).from(journeySteps).where(eq(journeySteps.orgId, ctx.orgId)))[0].n,
  tasks: (await db().select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.orgId, ctx.orgId)))[0].n,
});

async function newAthlete(key: string, first: string) {
  const [p] = await db().insert(people).values({ orgId: ctx.orgId, firstName: first, lastName: "Sample" }).returning();
  const [a] = await db().insert(athletes).values({ orgId: ctx.orgId, personId: p.id }).returning();
  ctx.athletes[key] = a.id;
  ctx.people[key] = p.id;
  return a.id;
}
/** Healthy baseline for the radar: steady attendance, one upcoming booking, required form done. */
async function healthy(key: string, payer: string | null, opts: { start?: number; extra?: Parameters<typeof w.membership>[3]; visits?: number[] } = {}) {
  const m = await w.membership(ctx.athletes[key], payer, opts.start ?? 200, opts.extra);
  await w.attend(ctx.athletes[key], opts.visits ?? w.steadyDays());
  await w.booking(ctx.athletes[key], 2, "booked");
  await form.complete(ctx.athletes[key], await personOf(key));
  return m;
}
async function fiveStar(key: string, daysAgo: number) {
  const { booking, session } = await w.booking(ctx.athletes[key], -daysAgo, "attended", { time: "07:00" });
  await db().insert(sessionFeedback).values({ orgId: ctx.orgId, bookingId: booking.id, sessionId: session.id, athleteId: ctx.athletes[key], rating: 5, submittedByUserId: ctx.users.alex, submittedByRole: "guardian", createdAt: new Date(Date.parse(`${day(-daysAgo)}T20:00:00Z`)) });
}
let form: Awaited<ReturnType<typeof w.requiredForm>>;

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  w = await retentionWorld(ctx, TODAY);
  form = await w.requiredForm();
});
afterAll(closeTestDb);

describe("facility-local dates", () => {
  it("uses the facility's calendar day, not UTC, for 'today' and for due times", async () => {
    // 03:30 UTC on Oct 12 is still 11:30 PM on Oct 11 in Indianapolis.
    await w.membership(ctx.athletes.dana, "dana", 0, { startDate: "2026-10-11" });
    const r = await db().transaction((tx) => syncJourneys(tx, ctx.orgId, { now: new Date("2026-10-12T03:30:00Z"), athleteIds: [ctx.athletes.dana] }));
    expect(r.date).toBe("2026-10-11");
    const j = await journeyOf("dana", "onboarding");
    expect(j.startedOn).toBe("2026-10-11");
    const welcome = (await stepOf("dana", "onboarding", "welcome_message"))!;
    expect(welcome.dueOn).toBe("2026-10-11");
    const [t] = await db().select().from(tasks).where(eq(tasks.id, welcome.taskId));
    expect(t.dueAt!.toISOString()).toBe("2026-10-12T04:00:00.000Z"); // end of Oct 11, Eastern Daylight Time
    expect((await stepOf("dana", "onboarding", "bring_a_friend"))!.dueOn).toBe("2026-11-01");
    // A membership that starts tomorrow (facility time) has not begun.
    await newAthlete("future", "Future");
    await w.membership(ctx.athletes.future, null, 0, { startDate: "2026-10-12" });
    await db().transaction((tx) => syncJourneys(tx, ctx.orgId, { now: new Date("2026-10-12T03:30:00Z"), athleteIds: [ctx.athletes.future] }));
    expect(await journeyOf("future", "onboarding")).toBeUndefined();
  });
});

describe("generation is idempotent", () => {
  it("starts onboarding for a new member and creates nothing the second time", async () => {
    await w.membership(ctx.athletes.maya, "parker", 3);
    const first = await sync();
    expect(first.journeysCreated).toBeGreaterThan(0);
    const onboarding = await stepsOf("maya", "onboarding");
    expect(onboarding.map((s) => s.stepKey).sort()).toEqual(DEFAULT_TEMPLATES.onboarding.map((s) => s.key).sort());
    expect((await stepOf("maya", "onboarding", "first_session_attended"))!.dueOn).toBe(day(4));
    // No touchpoint yet: the first one is six weeks out, beyond the 14-day look-ahead.
    expect(await stepsOf("maya", "touchpoints")).toEqual([]);
    const before = await counts();
    const second = await sync();
    expect(second).toMatchObject({ journeysCreated: 0, stepsCreated: 0, autoCompleted: 0, moved: 0, closed: 0, journeysCompleted: 0 });
    expect(await counts()).toEqual(before);
    // Two passes at the same moment (job + page) also create nothing extra.
    await Promise.all([sync(), sync(), sync([ctx.athletes.maya])]);
    expect(await counts()).toEqual(before);
  });

  it("does not build a backlog for a long-standing member", async () => {
    await w.membership(ctx.athletes.leo, "rivera", 400);
    await sync([ctx.athletes.leo]);
    expect(await journeyOf("leo", "onboarding")).toBeUndefined();
    expect(await stepsOf("leo", "touchpoints")).toEqual([]);
  });

  it("is registered as a nightly job and can be run on demand", async () => {
    expect(NIGHTLY_JOB_TYPES).toContain(JOURNEY_NIGHTLY_JOB);
    expect(SCHEDULED_JOBS.find((j) => j.type === JOURNEY_NIGHTLY_JOB)?.manual).toBe(true);
    expect(typeof jobHandlers[JOURNEY_NIGHTLY_JOB]).toBe("function");
    const before = await counts();
    const a = await runJourneyNightly(db(), ctx.orgId, { now: NOW });
    const b = await runJourneyNightly(db(), ctx.orgId, { now: NOW });
    expect(a).toMatchObject({ date: TODAY, stepsCreated: 0 });
    expect(b).toMatchObject({ date: TODAY, stepsCreated: 0, journeysCreated: 0 });
    expect(await counts()).toEqual(before);
    // Nothing in the module sends anything.
    expect((await db().select({ n: sql<number>`count(*)::int` }).from(messageDeliveries))[0].n).toBe(0);
    expect((await db().select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.type, "messaging.deliver")))).length).toBe(0);
  });
});

describe("auto-completion from detectable events", () => {
  const status = async (key: string) => (await stepOf("maya", "onboarding", key))!;

  it("ticks 'assigned coach set' from the coach assignment, with an audit entry", async () => {
    const s = await status("coach_assigned"); // maya is in marcus's group
    expect(s).toMatchObject({ status: "done", completedVia: "auto" });
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "journey.step_auto_complete"), eq(auditEvents.entityId, s.taskId)));
    expect(a.actorUserId).toBeNull();
    // A member with no coach stays open until one is assigned.
    await newAthlete("solo", "Solo");
    await w.membership(ctx.athletes.solo, null, 1);
    await sync([ctx.athletes.solo]);
    expect((await stepOf("solo", "onboarding", "coach_assigned"))!.status).toBe("open");
    await db().insert(coachAssignments).values({ orgId: ctx.orgId, coachUserId: ctx.users.tess, athleteId: ctx.athletes.solo });
    await sync([ctx.athletes.solo]);
    expect((await stepOf("solo", "onboarding", "coach_assigned"))!.status).toBe("done");
  });

  it("ticks first session booked, then attended", async () => {
    expect((await status("first_session_booked")).status).toBe("open");
    await w.booking(ctx.athletes.maya, 1, "booked");
    await sync();
    expect((await status("first_session_booked")).status).toBe("done");
    expect((await status("first_session_attended")).status).toBe("open");
    const { session } = await w.booking(ctx.athletes.maya, -1, "attended");
    await sync();
    const s = await status("first_session_attended");
    expect(s).toMatchObject({ status: "done", completedVia: "auto" });
    // Completed at the moment the session happened, so "time to complete" is honest.
    const [t] = await db().select().from(tasks).where(eq(tasks.id, s.taskId));
    expect(t.completedAt!.toISOString()).toBe(session.startsAt.toISOString());
    expect(t.completedBy).toBeNull();
  });

  it("ticks documents signed only when a form is completed and none is pending", async () => {
    expect((await status("documents_signed")).status).toBe("open");
    await form.complete(ctx.athletes.maya, await personOf("maya"));
    await sync();
    expect((await status("documents_signed")).status).toBe("done");
  });

  it("ticks payment method on file from a stored card", async () => {
    expect((await status("payment_method")).status).toBe("open");
    await db().insert(paymentMethods).values({ payerAccountId: ctx.payers.parker, provider: "stripe", providerMethodId: "pm_j", type: "card", brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030, isDefault: true });
    await sync();
    expect((await status("payment_method")).status).toBe("done");
  });

  it("ticks added to training program from a program assignment", async () => {
    expect((await status("program_assigned")).status).toBe("open");
    const [p] = await db().insert(programs).values({ orgId: ctx.orgId, name: "Sample block", status: "active" }).returning();
    await db().insert(programAssignments).values({ orgId: ctx.orgId, programId: p.id, programVersion: 1, athleteId: ctx.athletes.maya, startDate: TODAY, daysOfWeek: [1, 3] });
    await sync();
    expect((await status("program_assigned")).status).toBe("done");
  });

  it("ticks welcome message sent when staff write in Messages (not for an internal note)", async () => {
    const [th] = await db().insert(threads).values({ orgId: ctx.orgId, subject: "Welcome", athleteId: ctx.athletes.maya, kind: "family" }).returning();
    await db().insert(messages).values({ threadId: th.id, senderUserId: ctx.users.erin, body: "Internal", isInternalNote: true });
    await sync();
    expect((await status("welcome_message")).status).toBe("open");
    await db().insert(messages).values({ threadId: th.id, senderUserId: ctx.users.erin, body: "Welcome to the gym (sample)." });
    await sync();
    expect((await status("welcome_message")).status).toBe("done");
  });

  it("leaves steps only a person can know about open", async () => {
    for (const k of ["day_one_contact", "next_day_checkin", "thank_you_card", "bring_a_friend"]) expect((await status(k)).status).toBe("open");
    expect((await journeyOf("maya", "onboarding")).status).toBe("active");
  });

  it("hold: return date and reason tick themselves; the reminder ticks from the restart automation", async () => {
    const m = await w.membership(ctx.athletes.jackson, "jackson", 200, { status: "on_hold" });
    const [h] = await db().insert(membershipHolds).values({ membershipId: m.id, startDate: day(-10), endDate: day(10) }).returning();
    await sync([ctx.athletes.jackson]);
    const get = async (k: string) => (await stepOf("jackson", "hold", k))!;
    expect(await get("hold_return_date")).toMatchObject({ status: "done", completedVia: "auto" });
    expect(await get("hold_reason")).toMatchObject({ status: "open", dueOn: day(-10) });
    expect(await get("hold_miss_you")).toMatchObject({ status: "open", dueOn: day(0) });
    expect(await get("hold_return_reminder")).toMatchObject({ status: "open", dueOn: day(3) });
    await db().update(membershipHolds).set({ reason: "Family travel (sample)" }).where(eq(membershipHolds.id, h.id));
    await db().insert(jobs).values({ orgId: ctx.orgId, type: "automation.dispatch", payload: { period: `restart:${h.id}`, entityType: "membership" }, status: "done" });
    await sync([ctx.athletes.jackson]);
    expect((await get("hold_reason")).status).toBe("done");
    expect((await get("hold_return_reminder")).status).toBe("done");
    // The hold is extended: open steps follow the new dates.
    await db().update(membershipHolds).set({ endDate: day(20) }).where(eq(membershipHolds.id, h.id));
    const r = await sync([ctx.athletes.jackson]);
    expect(r.moved).toBe(1);
    expect((await get("hold_miss_you")).dueOn).toBe(day(5));
  });

  it("offboarding: reason, final bill and removal tick themselves; a withdrawn cancellation closes the checklist", async () => {
    const m = await w.membership(ctx.athletes.liam, "liam", 300, { cancelAt: day(10) });
    const [inv] = await db().insert(invoices).values({ orgId: ctx.orgId, payerAccountId: ctx.payers.liam, number: `J-${ctx.orgId.slice(0, 8)}`, status: "open", totalMinor: 19900, membershipId: m.id }).returning();
    await sync([ctx.athletes.liam]);
    const get = async (k: string) => (await stepOf("liam", "offboarding", k))!;
    expect((await stepsOf("liam", "offboarding")).length).toBe(DEFAULT_TEMPLATES.offboarding.length);
    for (const k of ["off_reason", "off_final_bill", "off_removed", "off_save_conversation", "off_winback"]) expect((await get(k)).status).toBe("open");
    expect((await get("off_final_bill")).billing).toBe(true);
    await db().update(memberships).set({ cancelReason: "Moving away (sample)" }).where(eq(memberships.id, m.id));
    await sync([ctx.athletes.liam]);
    expect((await get("off_reason")).status).toBe("done");
    expect((await get("off_final_bill")).status).toBe("open");
    await db().update(invoices).set({ status: "paid" }).where(eq(invoices.id, inv.id));
    await sync([ctx.athletes.liam]);
    expect((await get("off_final_bill")).status).toBe("done");
    expect((await get("off_removed")).status).toBe("open"); // still in the HS group
    await db().delete(groupMembers).where(eq(groupMembers.athleteId, ctx.athletes.liam));
    await sync([ctx.athletes.liam]);
    expect((await get("off_removed")).status).toBe("done");

    // mason asks to cancel, then changes his mind.
    const m2 = await w.membership(ctx.athletes.mason, "mason", 300, { cancelAt: day(20) });
    await sync([ctx.athletes.mason]);
    expect((await journeyOf("mason", "offboarding")).status).toBe("active");
    await db().update(memberships).set({ cancelAt: null }).where(eq(memberships.id, m2.id));
    const r = await sync([ctx.athletes.mason]);
    expect(r.closed).toBe(1);
    expect(await journeyOf("mason", "offboarding")).toMatchObject({ status: "closed", closedReason: "Cancellation withdrawn" });
    const left = await stepsOf("mason", "offboarding");
    expect(left.filter((s) => s.status === "open")).toEqual([]);
    expect(left.some((s) => s.status === "cancelled" && s.skipReason === "Cancellation withdrawn")).toBe(true);
  });
});

describe("touchpoints and holds", () => {
  // Started 2026-04-17: the 6-month check-in is due 2026-10-17 (five days from "today").
  it("creates a touchpoint inside the look-ahead with a facility-local due date", async () => {
    await w.membership(ctx.athletes.owen, "owen", 0, { startDate: "2026-04-17" });
    await sync([ctx.athletes.owen]);
    const steps = await stepsOf("owen", "touchpoints");
    expect(steps.map((s) => s.stepKey)).toEqual(["touch_6_months"]); // 6 weeks and the goal review are older than the backfill window
    expect(steps[0]).toMatchObject({ dueOn: "2026-10-17", originalDueOn: null, status: "open" });
    expect(steps[0].assignee).toBeNull(); // owen is in tess's GROUP, not directly assigned: unassigned
  });

  it("a hold that covers the due date moves it to 7 days after the hold ends, and back if the hold goes away", async () => {
    const [m] = await db().select().from(memberships).where(eq(memberships.athleteId, ctx.athletes.owen));
    const [h] = await db().insert(membershipHolds).values({ membershipId: m.id, startDate: day(1), endDate: day(7) }).returning();
    const r = await sync([ctx.athletes.owen]);
    expect(r.moved).toBe(1);
    let s = (await stepOf("owen", "touchpoints", "touch_6_months"))!;
    expect(s).toMatchObject({ dueOn: day(14), originalDueOn: "2026-10-17" });
    const [t] = await db().select().from(tasks).where(eq(tasks.id, s.taskId));
    expect(t.dueAt!.toISOString()).toBe("2026-10-27T04:00:00.000Z");
    // Running again does not move it again.
    expect((await sync([ctx.athletes.owen])).moved).toBe(0);
    await db().delete(journeys).where(and(eq(journeys.orgId, ctx.orgId), eq(journeys.anchorKey, `hold:${h.id}`)));
    await db().delete(membershipHolds).where(eq(membershipHolds.id, h.id));
    await sync([ctx.athletes.owen]);
    s = (await stepOf("owen", "touchpoints", "touch_6_months"))!;
    expect(s).toMatchObject({ dueOn: "2026-10-17", originalDueOn: null });
  });

  it("a member already on hold gets the touchpoint after they are back, not during the hold", async () => {
    const m = await w.membership(ctx.athletes.ella, "ella", 0, { startDate: "2026-04-17", status: "on_hold" });
    await db().insert(membershipHolds).values({ membershipId: m.id, startDate: day(-2), endDate: day(6), reason: "Injury (sample)" });
    await sync([ctx.athletes.ella]);
    expect(await stepOf("ella", "touchpoints", "touch_6_months")).toMatchObject({ dueOn: day(13), originalDueOn: "2026-10-17" });
    const panel = (await journeyPanel(db(), await viewer("rod"), ctx.athletes.ella, { today: TODAY, now: NOW }))!;
    expect(panel.upcoming.map((u) => u.key)).toEqual(["touch_12_months", "touch_18_months", "touch_24_months"]);
    expect(panel.upcoming[0]).toMatchObject({ dueOn: "2027-04-17", moved: false });
  });
});

describe("visit milestones feed the existing shoutout machinery", () => {
  it("creates one 'recognise this' step when the count is reached and ticks it when a shoutout is posted", async () => {
    await w.membership(ctx.athletes.sofia, "sofia", 100);
    await w.attend(ctx.athletes.sofia, [30, 27, 24, 21, 18, 15, 12, 9, 6, 2]);
    await sync([ctx.athletes.sofia]);
    const steps = await stepsOf("sofia", "visit_milestones");
    expect(steps.map((s) => s.stepKey)).toEqual(["visits_10"]);
    expect(steps[0]).toMatchObject({ status: "open", dueOn: day(5), dedupeKey: `milestone:${ctx.athletes.sofia}:sessions:10` });
    await db().insert(communityShoutouts).values({ orgId: ctx.orgId, athleteId: ctx.athletes.sofia, authorUserId: ctx.users.marcus, template: "consistency", localDate: day(-5) });
    await sync([ctx.athletes.sofia]);
    expect((await stepOf("sofia", "visit_milestones", "visits_10"))!.status).toBe("open"); // a shoutout from before the milestone does not count
    await db().insert(communityShoutouts).values({ orgId: ctx.orgId, athleteId: ctx.athletes.sofia, authorUserId: ctx.users.marcus, template: "consistency", localDate: TODAY });
    await sync([ctx.athletes.sofia]);
    expect((await stepOf("sofia", "visit_milestones", "visits_10"))!).toMatchObject({ status: "done", completedVia: "auto" });
    const panel = (await journeyPanel(db(), await viewer("marcus"), ctx.athletes.sofia, { today: TODAY, now: NOW }))!;
    expect(panel.visits).toBe(10);
    expect(panel.milestones.find((m) => m.visits === 10)).toMatchObject({ reachedOn: day(-2), recognised: "recognised" });
    expect(panel.milestones.find((m) => m.visits === 25)).toMatchObject({ reachedOn: null, recognised: null });
  });

  it("adopts a shoutout task made from 'Milestones this week' instead of creating a second one", async () => {
    await w.membership(ctx.athletes.zoe, "zoe", 200);
    await w.attend(ctx.athletes.zoe, [...Array.from({ length: 24 }, (_, i) => 80 - i * 3), 0]);
    const rod = await viewer("rod");
    const made = await db().transaction((tx) => createShoutoutTask(tx, rod, { athleteId: ctx.athletes.zoe, key: "sessions:25" }, { today: TODAY }));
    expect(made.created).toBe(true);
    await sync([ctx.athletes.zoe]);
    const step = (await stepOf("zoe", "visit_milestones", "visits_25"))!;
    expect(step.taskId).toBe(made.created ? made.task.id : "");
    expect((await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), like(tasks.dedupeKey, `milestone:${ctx.athletes.zoe}:%`)))).length).toBe(1);
    // And the card's button is now a no-op.
    expect((await db().transaction((tx) => createShoutoutTask(tx, rod, { athleteId: ctx.athletes.zoe, key: "sessions:25" }, { today: TODAY }))).created).toBe(false);
  });
});

describe("review and referral asks", () => {
  it("are suggested once after a 5-star rating for a member in good standing", async () => {
    await healthy("ethan", "ethan");
    await fiveStar("ethan", 3);
    await sync([ctx.athletes.ethan]);
    const steps = await stepsOf("ethan", "review_referral");
    expect(steps.map((s) => s.stepKey).sort()).toEqual(["referral_ask", "review_ask"]);
    expect(steps.every((s) => !s.suppressed && s.dueOn === day(3))).toBe(true);
    await fiveStar("ethan", 1);
    await sync([ctx.athletes.ethan]);
    expect((await stepsOf("ethan", "review_referral")).length).toBe(2);
    expect((await db().select().from(journeys).where(and(eq(journeys.athleteId, ctx.athletes.ethan), eq(journeys.kind, "review_referral")))).length).toBe(1);
  });

  it("are never suggested while the member is past due", async () => {
    await healthy("harper", "harper", { extra: { status: "past_due" } });
    await fiveStar("harper", 2);
    await sync([ctx.athletes.harper]);
    expect(await stepsOf("harper", "review_referral")).toEqual([]);
    // Once the account is settled the moment is still recent, so the ask appears.
    await db().update(memberships).set({ status: "active" }).where(eq(memberships.athleteId, ctx.athletes.harper));
    await sync([ctx.athletes.harper]);
    expect((await stepsOf("harper", "review_referral")).length).toBe(2);
  });

  it("are never suggested while the member is at risk", async () => {
    // No visit for 25 days (the retention radar's high-weight "No recent visit" signal), apart from the rated session itself being older.
    await healthy("aria", "aria", { visits: w.steadyDays().filter((d) => d >= 25) });
    const { booking, session } = await w.booking(ctx.athletes.aria, -26, "attended", { time: "07:00" });
    await db().insert(sessionFeedback).values({ orgId: ctx.orgId, bookingId: booking.id, sessionId: session.id, athleteId: ctx.athletes.aria, rating: 5, submittedByUserId: ctx.users.alex, submittedByRole: "guardian", createdAt: new Date(Date.parse(`${day(-3)}T20:00:00Z`)) });
    await sync([ctx.athletes.aria]);
    expect(await stepsOf("aria", "review_referral")).toEqual([]);
  });

  it("an open ask is held back (hidden from the queue) if the member becomes past due, and returns after", async () => {
    const rod = await viewer("rod");
    const inQueue = async () => (await followUpQueue(db(), rod, { kind: "review_referral" }, { today: day(3) })).steps.filter((s) => s.athleteId === ctx.athletes.ethan).length;
    expect(await inQueue()).toBe(2);
    await db().update(memberships).set({ status: "past_due" }).where(eq(memberships.athleteId, ctx.athletes.ethan));
    await sync([ctx.athletes.ethan]);
    expect((await stepsOf("ethan", "review_referral")).every((s) => s.suppressed)).toBe(true);
    expect(await inQueue()).toBe(0);
    await db().update(memberships).set({ status: "active" }).where(eq(memberships.athleteId, ctx.athletes.ethan));
    await sync([ctx.athletes.ethan]);
    expect(await inQueue()).toBe(2);
  });

  it("records asked / reviewed / declined", async () => {
    const erin = await viewer("erin");
    const ask = (await stepOf("ethan", "review_referral", "review_ask"))!;
    await expect(db().transaction((tx) => completeStep(tx, erin, { taskId: ask.taskId }, { now: NOW, today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await expect(db().transaction((tx) => completeStep(tx, erin, { taskId: ask.taskId, outcome: "bribed" }, { now: NOW, today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => completeStep(tx, erin, { taskId: ask.taskId, outcome: "reviewed" }, { now: NOW, today: TODAY }));
    const [row] = await db().select().from(journeySteps).where(eq(journeySteps.taskId, ask.taskId));
    expect(row).toMatchObject({ outcome: "reviewed", completedVia: "staff" });
  });
});

describe("permissions and scope", () => {
  it("coaches see only steps for their athletes and never billing steps", async () => {
    const [rod, erin, marcus, tess] = await Promise.all(["rod", "erin", "marcus", "tess"].map(viewer));
    const far = day(30);
    const q = async (v: typeof rod) => (await followUpQueue(db(), v, {}, { today: far })).steps;
    const all = await q(rod);
    expect(all.some((s) => s.billing)).toBe(true);
    expect((await q(erin)).some((s) => s.billing)).toBe(true); // front desk handles billing
    const mine = await q(marcus);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((s) => s.billing)).toBe(false);
    const marcusAthletes = new Set(["maya", "leo", "ethan", "sofia", "mason", "zoe", "jackson", "dana"].map((k) => ctx.athletes[k]));
    expect(mine.every((s) => marcusAthletes.has(s.athleteId))).toBe(true);
    const hers = await q(tess);
    expect(hers.some((s) => marcusAthletes.has(s.athleteId))).toBe(false);
    expect(hers.some((s) => s.athleteId === ctx.athletes.owen)).toBe(true);
    // The profile panel applies the same rules.
    expect(await journeyPanel(db(), tess, ctx.athletes.maya, { today: TODAY, now: NOW })).toBeNull();
    const panel = (await journeyPanel(db(), marcus, ctx.athletes.maya, { today: TODAY, now: NOW }))!;
    expect(panel.journeys.flatMap((j) => j.steps).some((s) => s.billing)).toBe(false);
    expect((await journeyPanel(db(), rod, ctx.athletes.maya, { today: TODAY, now: NOW }))!.journeys.flatMap((j) => j.steps).some((s) => s.stepKey === "payment_method")).toBe(true);
  });

  it("a coach cannot act on a billing step or on another coach's athlete; families cannot act at all", async () => {
    const [marcus, tess, alex] = await Promise.all(["marcus", "tess", "alex"].map(viewer));
    const billing = (await stepOf("liam", "offboarding", "off_final_bill"))!;
    // dana is marcus's athlete; her payment step is still open.
    const danaPay = (await stepOf("dana", "onboarding", "payment_method"))!;
    expect(danaPay.status).toBe("open");
    await expect(db().transaction((tx) => completeStep(tx, marcus, { taskId: danaPay.taskId }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => skipStep(tx, marcus, { taskId: danaPay.taskId, reason: "not mine" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => snoozeStep(tx, marcus, { taskId: danaPay.taskId, days: 2 }))).rejects.toBeInstanceOf(AuthzError);
    expect(billing.billing).toBe(true);
    const danaCard = (await stepOf("dana", "onboarding", "thank_you_card"))!;
    await expect(db().transaction((tx) => completeStep(tx, tess, { taskId: danaCard.taskId }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => completeStep(tx, alex, { taskId: danaCard.taskId }))).rejects.toBeInstanceOf(AuthzError);
    await expect(followUpQueue(db(), alex)).rejects.toBeInstanceOf(AuthzError);
    await expect(db().transaction((tx) => logReachOut(tx, tess, { athleteId: ctx.athletes.dana, note: "Called", reason: "other" }))).rejects.toBeInstanceOf(AuthzError);
    expect((await db().select().from(tasks).where(eq(tasks.id, danaCard.taskId)))[0].status).toBe("open");
  });

  it("steps from another organization cannot be opened", async () => {
    const other = await seedOrg(TODAY, { modules: [] });
    const outsider = await viewerFor(other, "rod");
    const s = (await stepOf("dana", "onboarding", "thank_you_card"))!;
    await expect(db().transaction((tx) => completeStep(tx, outsider, { taskId: s.taskId }))).rejects.toBeInstanceOf(UserError);
    expect((await followUpQueue(db(), outsider, {}, { today: day(30) })).steps).toEqual([]);
    expect(await journeyPanel(db(), outsider, ctx.athletes.dana, { today: TODAY })).toBeNull();
  });

  it("assignment: a billing step never goes to a coach; a coach can only take a step for themselves", async () => {
    const [rod, marcus] = await Promise.all(["rod", "marcus"].map(viewer));
    const danaPay = (await stepOf("dana", "onboarding", "payment_method"))!;
    await expect(db().transaction((tx) => assignStep(tx, rod, { taskId: danaPay.taskId, userId: ctx.users.marcus }))).rejects.toBeInstanceOf(UserError);
    const card = (await stepOf("dana", "onboarding", "thank_you_card"))!;
    await expect(db().transaction((tx) => assignStep(tx, rod, { taskId: card.taskId, userId: ctx.users.tess }))).rejects.toBeInstanceOf(UserError); // tess could not open it
    await expect(db().transaction((tx) => assignStep(tx, marcus, { taskId: card.taskId, userId: ctx.users.erin }))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => assignStep(tx, marcus, { taskId: card.taskId, userId: ctx.users.marcus }));
    expect((await followUpQueue(db(), marcus, { owner: "me" }, { today: day(30) })).steps.some((s) => s.taskId === card.taskId)).toBe(true);
    expect((await followUpQueue(db(), rod, { owner: ctx.users.marcus }, { today: day(30) })).steps.some((s) => s.taskId === card.taskId)).toBe(true);
    expect((await followUpQueue(db(), rod, { owner: "unassigned" }, { today: day(30) })).steps.some((s) => s.taskId === card.taskId)).toBe(false);
    // Coach-owned steps for a directly assigned athlete start with that coach.
    expect((await stepOf("dana", "onboarding", "day_one_contact"))!.assignee).toBe(ctx.users.marcus);
  });
});

describe("step actions are audited", () => {
  const audited = async (action: string, taskId: string) => (await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, action), eq(auditEvents.entityId, taskId)))).length;

  it("complete with a note writes the staff note and the audit entry", async () => {
    const marcus = await viewer("marcus");
    const s = (await stepOf("dana", "onboarding", "day_one_contact"))!;
    await expect(db().transaction((tx) => completeStep(tx, marcus, { taskId: s.taskId }, { now: NOW, today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => completeStep(tx, marcus, { taskId: s.taskId, note: "Called after the first session, all good (sample)." }, { now: NOW, today: TODAY }));
    expect((await stepOf("dana", "onboarding", "day_one_contact"))!).toMatchObject({ status: "done", completedVia: "staff" });
    expect(await audited("journey.step_complete", s.taskId)).toBe(1);
    const n = await db().select().from(notes).where(and(eq(notes.subjectPersonId, await personOf("dana")), eq(notes.category, "reach_out")));
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ authorUserId: ctx.users.marcus, visibility: "coaches_assigned" });
    await expect(db().transaction((tx) => completeStep(tx, marcus, { taskId: s.taskId, note: "again" }))).rejects.toBeInstanceOf(UserError);
  });

  it("skip needs a reason; snooze hides the step until the date without changing the due date", async () => {
    const erin = await viewer("erin");
    const card = (await stepOf("dana", "onboarding", "thank_you_card"))!;
    await expect(db().transaction((tx) => skipStep(tx, erin, { taskId: card.taskId, reason: " " }))).rejects.toBeTruthy();
    await db().transaction((tx) => snoozeStep(tx, erin, { taskId: card.taskId, days: 5 }, { today: day(8) }));
    const inQueue = async (today: string) => (await followUpQueue(db(), erin, {}, { today })).steps.some((x) => x.taskId === card.taskId);
    expect(await inQueue(day(10))).toBe(false);
    expect(await inQueue(day(13))).toBe(true);
    expect((await stepOf("dana", "onboarding", "thank_you_card"))!.dueOn).toBe(card.dueOn);
    await expect(db().transaction((tx) => snoozeStep(tx, erin, { taskId: card.taskId, until: day(-1) }, { today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => skipStep(tx, erin, { taskId: card.taskId, reason: "Joined with a sibling, one card sent" }));
    expect((await stepOf("dana", "onboarding", "thank_you_card"))!).toMatchObject({ status: "cancelled", skipReason: "Joined with a sibling, one card sent" });
    expect(await audited("journey.step_snooze", card.taskId)).toBe(1);
    expect(await audited("journey.step_skip", card.taskId)).toBe(1);
    expect(await audited("journey.step_assign", card.taskId)).toBe(1);
  });

  it("the win-back step needs a date and creates the task the win-back list shows", async () => {
    const rod = await viewer("rod");
    const s = (await stepOf("liam", "offboarding", "off_winback"))!;
    await expect(db().transaction((tx) => completeStep(tx, rod, { taskId: s.taskId }, { now: NOW, today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await expect(db().transaction((tx) => completeStep(tx, rod, { taskId: s.taskId, date: day(-1) }, { now: NOW, today: TODAY }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => completeStep(tx, rod, { taskId: s.taskId, date: day(60) }, { now: NOW, today: TODAY }));
    const j = await journeyOf("liam", "offboarding");
    const [t] = await db().select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.dedupeKey, `journey:winback:${j.id}`)));
    expect(t).toMatchObject({ source: "retention", relatedPersonId: await personOf("liam"), assigneeUserId: ctx.users.rod });
    expect(t.title).toMatch(/^Winback outreach: /);
  });

  it("a checklist completes when its last step is resolved", async () => {
    const rod = await viewer("rod");
    for (const s of (await stepsOf("liam", "offboarding")).filter((x) => x.status === "open")) {
      if (s.stepKey === "off_save_conversation" || s.stepKey === "off_exit_survey") await db().transaction((tx) => completeStep(tx, rod, { taskId: s.taskId, note: "Spoke with the family (sample)." }, { now: NOW, today: TODAY }));
      else await db().transaction((tx) => completeStep(tx, rod, { taskId: s.taskId }, { now: NOW, today: TODAY }));
    }
    const j = await journeyOf("liam", "offboarding");
    expect(j.status).toBe("completed");
    expect(j.completedAt).not.toBeNull();
  });
});

describe("no-shows and absent members", () => {
  it("lists yesterday's no-shows and members absent inside the actionable window, in scope, with log-a-reach-out", async () => {
    const [rod, marcus, tess] = await Promise.all(["rod", "marcus", "tess"].map(viewer));
    await w.booking(ctx.athletes.maya, -1, "no_show", { time: "06:00" });
    await w.booking(ctx.athletes.harper, -2, "no_show", { time: "06:00" }); // two days ago: not listed
    const lists = await reachOutLists(db(), rod, { today: TODAY });
    expect(lists.noShows.map((r) => r.athleteId)).toEqual([ctx.athletes.maya]);
    expect(lists.window).toEqual({ from: 21, to: 60 });
    expect(lists.absent.map((r) => r.athleteId)).toContain(ctx.athletes.aria); // 25 days
    expect(lists.absent.map((r) => r.athleteId)).not.toContain(ctx.athletes.leo); // 400 days, never attended: beyond the window
    expect(lists.absent.map((r) => r.athleteId)).not.toContain(ctx.athletes.jackson); // on hold
    expect((await reachOutLists(db(), tess, { today: TODAY })).noShows).toEqual([]);
    expect((await reachOutLists(db(), marcus, { today: TODAY })).absent.map((r) => r.athleteId)).not.toContain(ctx.athletes.aria);
    await db().transaction((tx) => logReachOut(tx, marcus, { athleteId: ctx.athletes.maya, note: "Texted mum, back Thursday (sample).", reason: "no_show" }));
    const again = await reachOutLists(db(), rod, { today: TODAY });
    expect(again.noShows[0].lastReachOut?.by).toBe(marcus.displayName);
    expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "journey.reach_out_log")))).length).toBe(1);
  });
});

describe("templates are editable", () => {
  it("owner edits a template; new journeys use it; coaches cannot edit", async () => {
    const [rod, marcus] = await Promise.all(["rod", "marcus"].map(viewer));
    const steps = DEFAULT_TEMPLATES.hold.map((s) => ({ ...s, offset: String(s.offset), enabled: s.key !== "hold_miss_you" })) as unknown as Record<string, unknown>[];
    steps.push({ name: "Freeze the door fob", ownerRole: "operations", offset: "1", unit: "days", anchor: "start", autoRule: "", enabled: true });
    await expect(db().transaction((tx) => saveJourneyTemplate(tx, marcus, "hold", steps))).rejects.toBeInstanceOf(AuthzError);
    await db().transaction((tx) => saveJourneyTemplate(tx, rod, "hold", steps));
    const [org] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const saved = journeySettingsFrom(org.settings).templates.hold;
    expect(saved.length).toBe(5);
    expect(saved.find((s) => s.key === "hold_miss_you")!.enabled).toBe(false);
    const m = await w.membership(ctx.athletes.eli, "parker", 100, { status: "on_hold" });
    await db().insert(membershipHolds).values({ membershipId: m.id, startDate: day(-1), endDate: day(20), reason: "Sample" });
    await sync([ctx.athletes.eli]);
    const keys = (await stepsOf("eli", "hold")).map((s) => s.stepKey);
    expect(keys).not.toContain("hold_miss_you");
    expect(keys.some((k) => k.startsWith("custom_"))).toBe(true);
    // jackson's earlier hold keeps the steps it started with.
    expect((await stepsOf("jackson", "hold")).map((s) => s.stepKey)).toContain("hold_miss_you");
    await expect(db().transaction((tx) => saveJourneyNumbers(tx, rod, { lookaheadDays: "x" }))).rejects.toBeInstanceOf(UserError);
    await db().transaction((tx) => resetJourneyTemplate(tx, rod, "hold"));
    const [org2] = await db().select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(journeySettingsFrom(org2.settings).templates.hold).toEqual(DEFAULT_TEMPLATES.hold);
    expect((await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), inArray(auditEvents.action, ["org.journey_template_update", "org.journey_template_reset"])))).length).toBe(2);
  });
});

describe("completion reporting", () => {
  it("is limited to owner and admin and counts by month", async () => {
    const [rod, erin, marcus] = await Promise.all(["rod", "erin", "marcus"].map(viewer));
    await expect(journeyCompletionReport(db(), erin, { today: TODAY })).rejects.toBeInstanceOf(AuthzError);
    await expect(journeyCompletionReport(db(), marcus, { today: TODAY })).rejects.toBeInstanceOf(AuthzError);
    const r = await journeyCompletionReport(db(), rod, { today: day(20) });
    expect(r.onboarding.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    const oct = r.onboarding.find((m) => m.month === "2026-10")!;
    expect(oct.started).toBe(4); // dana, maya, solo, future
    expect(oct.completed).toBe(0);
    expect(oct.completionRatePercent).toBe(0);
    expect(oct.avgDaysToComplete).toBeNull();
    expect(r.onboarding[0]).toMatchObject({ started: 0, completionRatePercent: null });
    const ms = r.milestones.find((m) => m.month === "2026-10")!;
    expect(ms).toMatchObject({ reached: 2, recognised: 1, missed: 1, recognisedPercent: 50 }); // sofia recognised; zoe still open after its due date
    const tp = r.touchpoints.find((m) => m.month === "2026-10")!;
    expect(tp).toMatchObject({ due: 2, onTime: 0, late: 0, overdue: 2, onTimePercent: 0 }); // owen and ella, both past due by Nov 1
    // The same functions without a viewer, for another page to call after its own permission check.
    const o = { today: day(20), tz: ctx.tz, months: 2 };
    expect((await onboardingCompletionByMonth(db(), ctx.orgId, o)).length).toBe(2);
    expect((await touchpointTimelinessByMonth(db(), ctx.orgId, o)).length).toBe(2);
    expect((await milestoneRecognitionByMonth(db(), ctx.orgId, o)).length).toBe(2);
  });

  it("measures onboarding completion and time, and on-time touchpoints", async () => {
    const rod = await viewer("rod");
    // Finish solo's onboarding four days after it started (started 1 day ago).
    const done = new Date(Date.parse(`${day(3)}T18:00:00Z`));
    for (const s of (await stepsOf("solo", "onboarding")).filter((x) => x.status === "open")) {
      await db().transaction((tx) => skipStep(tx, rod, { taskId: s.taskId, reason: "Test: resolved" }, { now: done }));
    }
    expect((await journeyOf("solo", "onboarding")).status).toBe("completed");
    const owen = (await stepOf("owen", "touchpoints", "touch_6_months"))!;
    await db().transaction((tx) => completeStep(tx, rod, { taskId: owen.taskId, note: "Six-month chat done (sample)." }, { now: new Date(Date.parse(`${day(4)}T18:00:00Z`)), today: day(4) }));
    const r = await journeyCompletionReport(db(), rod, { today: day(20) });
    expect(r.onboarding.find((m) => m.month === "2026-10")).toMatchObject({ started: 4, completed: 1, completionRatePercent: 25, avgDaysToComplete: 4 });
    expect(r.touchpoints.find((m) => m.month === "2026-10")).toMatchObject({ due: 2, onTime: 1, overdue: 1, onTimePercent: 50 });
    expect((await db().select().from(notes).where(and(eq(notes.subjectPersonId, await personOf("owen")), eq(notes.category, "check_in")))).length).toBe(1);
  });
});
