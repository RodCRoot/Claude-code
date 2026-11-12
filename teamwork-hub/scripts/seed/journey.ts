import { and, eq, inArray } from "drizzle-orm";
import {
  athletes,
  bookings,
  coachAssignments,
  coachReflections,
  communityShoutouts,
  formRequests,
  formTemplateVersions,
  guardianships,
  journeySteps,
  journeys,
  membershipHolds,
  memberships,
  notes,
  opsChecklistItems,
  opsChecklistTicks,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  paymentMethods,
  people,
  scheduleSessions,
  sessionFeedback,
  tasks,
} from "../../src/db/schema";
import { SAMPLE_OPS_ITEMS } from "../../src/lib/journey/ops";
import { completeStep, skipStep } from "../../src/lib/journey/steps";
import { syncJourneys } from "../../src/lib/journey/sync";
import type { Viewer } from "../../src/lib/authz/policy";
import { addDaysYmd, localToUtc, startOfWeekYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic member journeys at various stages (all is_demo, invented names): two members in
 * onboarding (one brand new, one nearly through), touchpoints due soon and overdue, a visit
 * milestone waiting to be recognised and one already recognised, a member on hold, a scheduled
 * cancellation, a no-show yesterday, plus a sample operations checklist with a few ticks and one
 * coach reflection. The journeys themselves are produced by the real generator (`syncJourneys`),
 * limited to these members so other modules' fixtures are untouched. Sends nothing.
 */
export async function seedJourney(ctx: SeedCtx) {
  const { tx, orgId, today: T, tz } = ctx;
  const sched = ctx.extra.scheduling;
  const bill = ctx.extra.billing;
  if (!sched?.gpt || !bill?.unlimitedVersionId) return;
  const ex: Record<string, string> = {};
  ctx.extra.journey = ex;
  const day = (n: number) => addDaysYmd(T, n);
  const at = (n: number, time = "12:00") => localToUtc(day(n), time, tz);
  const now = at(0, "12:00");

  async function member(key: string, first: string, last: string, startDaysAgo: number, extra: Partial<typeof memberships.$inferInsert> = {}) {
    const [p] = await tx.insert(people).values({ orgId, firstName: first, lastName: last, dateOfBirth: addDaysYmd(T, -15 * 365 - startDaysAgo), isDemo: true }).returning();
    const [a] = await tx.insert(athletes).values({ orgId, personId: p.id, sport: "Multi-sport", isDemo: true }).returning();
    const [g] = await tx.insert(people).values({ orgId, firstName: `Guardian of ${first}`, lastName: last, email: `journey.${key}.guardian@example.test`, isDemo: true }).returning();
    await tx.insert(guardianships).values({ orgId, guardianPersonId: g.id, athleteId: a.id });
    const [pa] = await tx.insert(payerAccounts).values({ orgId, name: `${first} ${last} family`, isDemo: true }).returning();
    await tx.insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: a.id });
    await tx.insert(payerAuthorizations).values({ payerAccountId: pa.id, personId: g.id });
    const [m] = await tx
      .insert(memberships)
      .values({ orgId, athleteId: a.id, payerAccountId: pa.id, productVersionId: bill.unlimitedVersionId, status: "active", startDate: day(-startDaysAgo), billingProvider: "manual", source: "seed_journey", createdBy: ctx.users.rod, isDemo: true, ...extra })
      .returning();
    ctx.people[`jr_${key}`] = p.id;
    ctx.athletes[`jr_${key}`] = a.id;
    ctx.payers[`jr_${key}`] = pa.id;
    ex[`${key}Membership`] = m.id;
    return { athleteId: a.id, personId: p.id, payerId: pa.id, membershipId: m.id };
  }

  // One early session per day so attendance, a no-show yesterday and visit counts are real rows.
  const sessions = new Map<number, { id: string; startsAt: Date }>();
  for (let d = -75; d <= 6; d++) {
    const startsAt = at(d, "06:15");
    const [s] = await tx
      .insert(scheduleSessions)
      .values({ orgId, serviceTypeId: sched.gpt, title: "Sunrise Group (sample)", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: tz, coachUserId: ctx.users.tess, capacity: 12, status: d < 0 ? "completed" : "scheduled", isDemo: true })
      .returning({ id: scheduleSessions.id });
    sessions.set(d, { id: s.id, startsAt });
  }
  const book = async (athleteId: string, d: number, status: "attended" | "no_show" | "booked") => {
    const s = sessions.get(d)!;
    const [b] = await tx
      .insert(bookings)
      .values({ orgId, sessionId: s.id, athleteId, bookedByUserId: ctx.users.erin, status, entitlementSource: "membership", checkedInAt: status === "attended" ? s.startsAt : null, checkInMethod: status === "attended" ? "kiosk" : null, isDemo: true })
      .returning();
    return { booking: b, session: s };
  };
  const signForm = async (m: { athleteId: string; personId: string }) => {
    const [v] = await tx.select({ id: formTemplateVersions.id }).from(formTemplateVersions).limit(1);
    if (v) await tx.insert(formRequests).values({ orgId, templateVersionId: v.id, subjectPersonId: m.personId, athleteId: m.athleteId, status: "completed", completedAt: at(-1), isDemo: true });
  };
  const card = (payerId: string) => tx.insert(paymentMethods).values({ payerAccountId: payerId, provider: "stripe", providerMethodId: `pm_seed_${payerId.slice(0, 8)}`, type: "card", brand: "Visa", last4: "4242", expMonth: 12, expYear: Number(T.slice(0, 4)) + 3, isDefault: true });

  // 1. Brand new: joined two days ago, card on file, first session booked.
  const nora = await member("nora", "Nora", "Quill", 2);
  await card(nora.payerId);
  await book(nora.athleteId, 1, "booked");
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.tess, athleteId: nora.athleteId });

  // 2. Nearly through onboarding: joined nine days ago, forms signed, three visits, a no-show yesterday.
  const theo = await member("theo", "Theo", "Marsh", 9);
  await card(theo.payerId);
  await signForm(theo);
  for (const d of [-8, -6, -3]) await book(theo.athleteId, d, "attended");
  await book(theo.athleteId, -1, "no_show");
  await book(theo.athleteId, 2, "booked");
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.marcus, athleteId: theo.athleteId });

  // 3. Six-week check-in due in three days.
  const ivy = await member("ivy", "Ivy", "Sandoval", 39);
  for (let d = -38; d <= -2; d += 3) await book(ivy.athleteId, d, "attended");
  await book(ivy.athleteId, 1, "booked");
  await signForm(ivy);
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.marcus, athleteId: ivy.athleteId });

  // 4. Six-week check-in five days overdue.
  const cal = await member("cal", "Cal", "Ortega", 47);
  for (let d = -46; d <= -1; d += 4) await book(cal.athleteId, d, "attended");
  await book(cal.athleteId, 2, "booked");
  await signForm(cal);
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.tess, athleteId: cal.athleteId });

  // 5. Tenth visit three days ago (waiting to be recognised) and a 5-star rating: a review ask appears.
  const remy = await member("remy", "Remy", "Castillo", 60);
  const remyDays = [-40, -36, -32, -28, -24, -20, -16, -12, -8, -3];
  let lastRemy: Awaited<ReturnType<typeof book>> | null = null;
  for (const d of remyDays) lastRemy = await book(remy.athleteId, d, "attended");
  await book(remy.athleteId, 1, "booked");
  await signForm(remy);
  await card(remy.payerId);
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.marcus, athleteId: remy.athleteId });
  await tx.insert(sessionFeedback).values({ orgId, bookingId: lastRemy!.booking.id, sessionId: lastRemy!.session.id, athleteId: remy.athleteId, rating: 5, submittedByUserId: ctx.users.alex, submittedByRole: "guardian", createdAt: at(-3, "19:00"), isDemo: true });

  // 6. Twenty-fifth visit eight days ago, already recognised with a shoutout.
  const sage = await member("sage", "Sage", "Whitlock", 74);
  for (let i = 0; i < 25; i++) await book(sage.athleteId, -74 + i * 2 + (i >= 12 ? 18 : 0), "attended");
  await book(sage.athleteId, 1, "booked");
  await signForm(sage);
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.tess, athleteId: sage.athleteId });
  await tx.insert(communityShoutouts).values({ orgId, athleteId: sage.athleteId, authorUserId: ctx.users.tess, template: "consistency", localDate: day(-6), isDemo: true, createdAt: at(-6) });

  // 7. On hold: started ten days ago, back in eight (the mid-hold check-in was due yesterday).
  const june = await member("june", "June", "Abara", 150, { status: "on_hold" });
  for (let d = -60; d <= -12; d += 4) await book(june.athleteId, d, "attended");
  await tx.insert(membershipHolds).values({ membershipId: june.membershipId, startDate: day(-10), endDate: day(8), reason: "Family travel (sample)", requestedOn: day(-12), requestChannel: "email", createdBy: ctx.users.erin });
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.marcus, athleteId: june.athleteId });

  // 8. Cancellation scheduled for ten days from now, no reason recorded yet.
  const dex = await member("dex", "Dex", "Moreno", 210, { cancelAt: day(10) });
  for (let d = -40; d <= -9; d += 5) await book(dex.athleteId, d, "attended");
  await tx.insert(coachAssignments).values({ orgId, coachUserId: ctx.users.marcus, athleteId: dex.athleteId });

  const ids = [nora, theo, ivy, cal, remy, sage, june, dex].map((m) => m.athleteId);
  await syncJourneys(tx, orgId, { today: T, now, athleteIds: ids });

  // A few steps a person ticked, so the panels are not all "open".
  const viewer = (key: "rod" | "erin" | "marcus", role: Viewer["role"], name: string): Viewer => ({ userId: ctx.users[key], orgId, role, personId: null, displayName: name, mfaVerified: true });
  const erin = viewer("erin", "operations", "Erin");
  const marcus = viewer("marcus", "coach", "Coach Marcus");
  const step = async (athleteId: string, key: string) =>
    (
      await tx
        .select({ taskId: journeySteps.taskId, status: tasks.status })
        .from(journeySteps)
        .innerJoin(tasks, eq(tasks.id, journeySteps.taskId))
        .where(and(eq(journeySteps.orgId, orgId), eq(journeySteps.athleteId, athleteId), eq(journeySteps.stepKey, key)))
    )[0];
  const done = async (v: Viewer, athleteId: string, key: string, note?: string, daysAgo = 1) => {
    const s = await step(athleteId, key);
    if (s?.status === "open") await completeStep(tx, v, { taskId: s.taskId, note }, { now: at(-daysAgo, "15:00"), today: day(-daysAgo) });
  };
  await done(erin, theo.athleteId, "welcome_message", undefined, 8);
  await done(marcus, theo.athleteId, "day_one_contact", "Called after the first session. Enjoyed it, a little sore (sample note).", 8);
  await done(marcus, theo.athleteId, "next_day_checkin", "Quick text the next morning, all good (sample note).", 7);
  const thanks = await step(theo.athleteId, "thank_you_card");
  if (thanks?.status === "open") await skipStep(tx, erin, { taskId: thanks.taskId, reason: "Out of cards this week (sample reason)" }, { now: at(-1) });
  await tx.insert(notes).values({ orgId, subjectPersonId: june.personId, authorUserId: ctx.users.marcus, body: "Reach-out: wished them a good trip before the hold started (sample note).", category: "reach_out", visibility: "coaches_assigned", createdAt: at(-11) });

  // Sample operations checklist (invented wording) with a week of ticks.
  const items = await tx.insert(opsChecklistItems).values(SAMPLE_OPS_ITEMS.map(([section, label], i) => ({ orgId, section, label, sortOrder: i * 10, isDemo: true }))).returning();
  const daily = items.filter((i) => i.section !== "weekly");
  const ticks: (typeof opsChecklistTicks.$inferInsert)[] = [];
  for (let d = -9; d <= -1; d++) {
    // Most days complete; two days with gaps so the month grid shows all three states.
    const skip = d === -4 ? 3 : d === -7 ? daily.length : 0;
    for (const item of daily.slice(0, daily.length - skip)) ticks.push({ orgId, itemId: item.id, localDate: day(d), tickedBy: ctx.users.erin, tickedAt: at(d, "08:00"), isDemo: true });
  }
  for (const item of daily.filter((i) => i.section === "opening")) ticks.push({ orgId, itemId: item.id, localDate: T, tickedBy: ctx.users.erin, tickedAt: at(0, "06:00"), isDemo: true });
  const lastWeek = startOfWeekYmd(day(-7));
  for (const item of items.filter((i) => i.section === "weekly").slice(0, 2)) ticks.push({ orgId, itemId: item.id, localDate: lastWeek, tickedBy: ctx.users.erin, tickedAt: at(-7, "16:00"), isDemo: true });
  await tx.insert(opsChecklistTicks).values(ticks).onConflictDoNothing();

  // One reflection for last week.
  await tx.insert(coachReflections).values({
    orgId,
    coachUserId: ctx.users.marcus,
    weekStart: lastWeek,
    wentWell: "Evening groups were full and two new athletes came back for a second week (sample).",
    stuck: "Hard to fit the six-week check-ins in around back-to-back sessions (sample).",
    helpNeeded: "Fifteen minutes blocked after the Wednesday group for check-in calls (sample).",
    isDemo: true,
  });

  // Flag everything the generator made for these members as demo rows.
  const js = await tx.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.orgId, orgId), inArray(journeys.athleteId, ids)));
  if (js.length) {
    await tx.update(journeys).set({ isDemo: true }).where(inArray(journeys.id, js.map((j) => j.id)));
    const st = await tx.select({ taskId: journeySteps.taskId }).from(journeySteps).where(inArray(journeySteps.journeyId, js.map((j) => j.id)));
    await tx.update(journeySteps).set({ isDemo: true }).where(inArray(journeySteps.journeyId, js.map((j) => j.id)));
    if (st.length) await tx.update(tasks).set({ isDemo: true }).where(inArray(tasks.id, st.map((s) => s.taskId)));
  }
}
