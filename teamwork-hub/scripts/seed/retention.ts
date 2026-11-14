import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  athletes,
  bookings,
  coachAssignments,
  formRequests,
  formTemplates,
  formTemplateVersions,
  guardianships,
  memberRequestAthletes,
  memberRequests,
  membershipHolds,
  memberships,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  paymentMethods,
  people,
  retentionActions,
  scheduleSessions,
  serviceTypes,
  transactions,
  users,
} from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { submitFeedback } from "../../src/lib/retention/feedback";
import { addDaysYmd, isoWeekday, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic retention demo data (all is_demo, invented names): one member shaped to trigger each
 * radar signal, a healthy control, two ended members for the winback list, a few session-feedback
 * responses from the existing demo families (one low rating → follow-up task), and logged outcomes.
 * Needs the scheduling + billing seeds; does nothing without them. Sends nothing.
 */
export async function seedRetention(ctx: SeedCtx) {
  const { tx, orgId, today: T, tz } = ctx;
  const sched = ctx.extra.scheduling;
  const bill = ctx.extra.billing;
  if (!sched?.gpt || !bill?.unlimitedVersionId) return;
  const ex: Record<string, string> = {};
  ctx.extra.retention = ex;

  // --- People -----------------------------------------------------------------------
  const lastYear = (ymd: string, years: number) => {
    const y = Number(ymd.slice(0, 4)) - years;
    return ymd.slice(5) === "02-29" ? `${y}-02-28` : `${y}${ymd.slice(4)}`;
  };
  async function member(key: string, first: string, last: string, age: number, opts: { dob?: string; adult?: boolean } = {}) {
    const [p] = await tx
      .insert(people)
      .values({ orgId, firstName: first, lastName: last, dateOfBirth: opts.dob ?? addDaysYmd(lastYear(T, age), -100 - age * 7), isDemo: true })
      .returning();
    const [a] = await tx.insert(athletes).values({ orgId, personId: p.id, sport: "Multi-sport", level: "Level 2", isDemo: true }).returning();
    ctx.people[`ret_${key}`] = p.id;
    ctx.athletes[`ret_${key}`] = a.id;
    const [pa] = await tx.insert(payerAccounts).values({ orgId, name: `${first} ${last} family`, isDemo: true }).returning();
    ctx.payers[`ret_${key}`] = pa.id;
    await tx.insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: a.id });
    if (!opts.adult) {
      const [g] = await tx.insert(people).values({ orgId, firstName: `Guardian of ${first}`, lastName: last, email: `${key}.guardian@example.test`, isDemo: true }).returning();
      ctx.people[`ret_${key}_guardian`] = g.id;
      await tx.insert(guardianships).values({ orgId, guardianPersonId: g.id, athleteId: a.id });
      await tx.insert(payerAuthorizations).values({ payerAccountId: pa.id, personId: g.id });
    } else {
      await tx.insert(payerAuthorizations).values({ payerAccountId: pa.id, personId: p.id });
    }
    return a.id;
  }

  type M = Partial<typeof memberships.$inferInsert> & { start: number; version: string };
  async function membership(key: string, m: M) {
    const { start, version, ...rest } = m;
    const [row] = await tx
      .insert(memberships)
      .values({
        orgId,
        athleteId: ctx.athletes[`ret_${key}`],
        payerAccountId: ctx.payers[`ret_${key}`],
        productVersionId: version,
        status: "active",
        startDate: addDaysYmd(T, -start),
        billingAnchorDay: 1,
        nextBillDate: `${addDaysYmd(`${T.slice(0, 7)}-01`, 32).slice(0, 7)}-01`,
        billingProvider: "manual",
        source: "seed_retention",
        createdBy: ctx.users.rod,
        isDemo: true,
        ...rest,
      })
      .returning();
    ex[`${key}Membership`] = row.id;
    return row;
  }

  // --- A small evening class (Mon/Wed/Sat) so there is history older than the main seed --
  const [svc] = await tx.select().from(serviceTypes).where(eq(serviceTypes.id, sched.gpt));
  const sessions: { id: string; date: string; startsAt: Date }[] = [];
  for (let d = -126; d <= 14; d++) {
    const date = addDaysYmd(T, d);
    if (![1, 3, 6].includes(isoWeekday(date))) continue;
    const time = isoWeekday(date) === 6 ? "11:00" : "19:15";
    const startsAt = localToUtc(date, time, tz);
    const [s] = await tx
      .insert(scheduleSessions)
      .values({
        orgId,
        serviceTypeId: svc.id,
        title: "Evening Performance Group",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        timezone: tz,
        coachUserId: ctx.users.marcus,
        resourceId: sched.turf ?? null,
        capacity: 16,
        waitlistCapacity: 0,
        status: date < T ? "completed" : "scheduled",
        isDemo: true,
      })
      .returning({ id: scheduleSessions.id });
    sessions.push({ id: s.id, date, startsAt });
  }
  ex.firstSession = sessions[0].id;
  const past = sessions.filter((s) => s.date < T);
  const upcoming = sessions.filter((s) => s.date >= T);
  const book = async (key: string, s: (typeof sessions)[number], status: "attended" | "no_show" | "late_cancelled" | "booked") =>
    tx.insert(bookings).values({
      orgId,
      sessionId: s.id,
      athleteId: ctx.athletes[`ret_${key}`],
      bookedByUserId: ctx.users.erin,
      status,
      entitlementSource: "membership",
      membershipId: ex[`${key}Membership`],
      checkedInAt: status === "attended" ? new Date(s.startsAt.getTime() - 4 * 60_000) : null,
      checkInMethod: status === "attended" ? "kiosk" : null,
      cancelledAt: status === "late_cancelled" ? new Date(s.startsAt.getTime() - 3_600_000) : null,
      isDemo: true,
      createdAt: new Date(s.startsAt.getTime() - 3 * 86_400_000),
    });
  /** Attend `pick`ed past sessions between `fromDays` and `toDays` ago (inclusive). */
  const attend = async (key: string, fromDays: number, toDays: number, pick: (i: number) => boolean = () => true) => {
    let i = 0;
    for (const s of past) {
      if (s.date < addDaysYmd(T, -fromDays) || s.date > addDaysYmd(T, -toDays)) continue;
      if (pick(i++)) await book(key, s, "attended");
    }
  };
  const steady = (i: number) => i % 3 !== 0;
  const bookNext = async (key: string, n = 1) => {
    for (const s of upcoming.slice(0, n)) await book(key, s, "booked");
  };

  // --- One member per signal ------------------------------------------------------------
  // 1. No recent visit (and nothing booked) → at risk.
  await member("rowan", "Rowan", "Adeyemi", 16);
  await membership("rowan", { start: 200, version: bill.unlimitedVersionId });
  await attend("rowan", 126, 30, steady);

  // 2. Attendance drop vs own baseline.
  await member("priya", "Priya", "Nakamura", 15);
  await membership("priya", { start: 300, version: bill.twiceVersionId });
  await attend("priya", 126, 29, steady);
  const recentOne = [...past].reverse().find((s) => s.date <= addDaysYmd(T, -4));
  if (recentOne) await book("priya", recentOne, "attended");
  await bookNext("priya");

  // 3. No-shows / late cancels rising.
  await member("felix", "Felix", "Oyelaran", 17);
  await membership("felix", { start: 150, version: bill.twiceVersionId });
  await attend("felix", 126, 29, (i) => i % 2 === 0);
  {
    const recent = past.filter((s) => s.date > addDaysYmd(T, -28));
    const plan: ("attended" | "no_show" | "late_cancelled")[] = ["attended", "no_show", "attended", "late_cancelled", "attended", "no_show", "attended", "attended", "no_show", "attended", "attended", "attended", "attended"];
    for (let i = 0; i < recent.length; i++) await book("felix", recent[i], plan[i] ?? "attended");
  }
  await bookNext("felix");

  // 4. Failed payment + card about to expire (synthetic rows; no provider was contacted).
  await member("greta", "Greta", "Solberg", 14);
  await membership("greta", { start: 240, version: bill.unlimitedVersionId, status: "past_due" });
  await attend("greta", 126, 1, steady);
  await bookNext("greta", 2);
  await tx.insert(transactions).values({
    orgId,
    payerAccountId: ctx.payers.ret_greta,
    kind: "charge",
    status: "failed",
    amountMinor: 19900,
    currency: "USD",
    provider: "stripe",
    providerTxnId: `pi_demo_ret_failed_${orgId}`,
    methodType: "card",
    occurredAt: new Date(Date.now() - 3 * 86_400_000),
    verification: "provider_verified",
    notes: "SYNTHETIC demo row: card declined (no provider was contacted)",
    isDemo: true,
  });
  await tx.insert(paymentMethods).values({
    payerAccountId: ctx.payers.ret_greta,
    provider: "stripe",
    providerMethodId: `pm_demo_ret_${orgId}`,
    type: "card",
    brand: "Visa",
    last4: "4242",
    expMonth: Number(T.slice(5, 7)),
    expYear: Number(T.slice(0, 4)),
    isDefault: true,
  });

  // 5. Hold ended recently, not back yet.
  await member("mateo", "Mateo", "Varga", 16);
  const mateo = await membership("mateo", { start: 260, version: bill.unlimitedVersionId });
  await attend("mateo", 126, 52, steady);
  await tx.insert(membershipHolds).values({ membershipId: mateo.id, startDate: addDaysYmd(T, -50), endDate: addDaysYmd(T, -10), reason: "Basketball season (sample)", requestedOn: addDaysYmd(T, -55), requestChannel: "email", createdBy: ctx.users.erin });

  // 6. Hold ending soon.
  await member("imani", "Imani", "Kowalczyk", 13);
  const imani = await membership("imani", { start: 180, version: bill.twiceVersionId, status: "on_hold" });
  await attend("imani", 126, 23, steady);
  await tx.insert(membershipHolds).values({ membershipId: imani.id, startDate: addDaysYmd(T, -21), endDate: addDaysYmd(T, 7), reason: "Family travel (sample)", requestedOn: addDaysYmd(T, -24), requestChannel: "sms", createdBy: ctx.users.erin });

  // 7. Commitment ending (birthday this week for the milestones card).
  await member("tobias", "Tobias", "Lindgren", 15, { dob: lastYear(T, 15) });
  await membership("tobias", { start: 160, version: bill.ref_perf_3x_6mo ?? bill.twiceVersionId, commitmentStartsOn: addDaysYmd(T, -160), commitmentEndsOn: addDaysYmd(T, 20) });
  await attend("tobias", 126, 1, steady);
  await bookNext("tobias", 2);

  // 8. In Season term ending.
  await member("nia", "Nia", "Fairweather", 16);
  await membership("nia", { start: 50, version: bill.ref_in_season_1x ?? bill.twiceVersionId, kind: "in_season", endDate: addDaysYmd(T, 10), cancelAt: addDaysYmd(T, 10) });
  await attend("nia", 50, 1, (i) => i % 3 === 1);
  await bookNext("nia");

  // 9. Cancel requested, still open → at risk.
  await member("caleb", "Caleb", "Ostrowski", 17);
  await membership("caleb", { start: 400, version: bill.unlimitedVersionId });
  await attend("caleb", 126, 1, steady);
  await bookNext("caleb");
  {
    const [r] = await tx
      .insert(memberRequests)
      .values({ orgId, isDemo: true, type: "cancel", channel: "email_direct", requesterPersonId: ctx.people.ret_caleb_guardian, sentOn: addDaysYmd(T, -4), receivedOn: addDaysYmd(T, -3), summary: "Wants to cancel after the fall season (sample)", ownerUserId: ctx.users.erin, createdByUserId: ctx.users.erin })
      .returning();
    await tx.insert(memberRequestAthletes).values({ requestId: r.id, athleteId: ctx.athletes.ret_caleb });
  }

  // 10. Open (non-cancel) member request.
  await member("quinn", "Quinn", "Brannigan", 14);
  await membership("quinn", { start: 220, version: bill.twiceVersionId });
  await attend("quinn", 126, 1, steady);
  await bookNext("quinn");
  {
    const [r] = await tx
      .insert(memberRequests)
      .values({ orgId, isDemo: true, type: "plan_change", channel: "in_person", requesterPersonId: ctx.people.ret_quinn_guardian, sentOn: addDaysYmd(T, -9), receivedOn: addDaysYmd(T, -9), summary: "Asked about dropping to 1x per week (sample)", createdByUserId: ctx.users.erin })
      .returning();
    await tx.insert(memberRequestAthletes).values({ requestId: r.id, athleteId: ctx.athletes.ret_quinn });
  }

  // 11. Onboarding: day 30 with one visit ("first 30 days complete" today on the milestones card).
  await member("hugo", "Hugo", "Calloway", 13);
  await membership("hugo", { start: 30, version: bill.twiceVersionId });
  await attend("hugo", 12, 5, (i) => i === 0);
  await bookNext("hugo");

  // 12. Required forms missing (left without the completed forms the others get below).
  await member("sage", "Sage", "Achterberg", 15);
  await membership("sage", { start: 120, version: bill.twiceVersionId });
  await attend("sage", 120, 1, steady);
  await bookNext("sage");

  // 13. Healthy control: steady attendance, booked ahead, 48 sessions (2 away from 50), 1-year anniversary today.
  await member("ines", "Ines", "Marchetti", 16);
  await membership("ines", { start: 0, version: bill.unlimitedVersionId, startDate: lastYear(T, 1) });
  for (const s of past.slice(-48)) await book("ines", s, "attended");
  await bookNext("ines", 3);

  // Completed required forms for everyone but Sage, so only Sage shows "forms block booking".
  {
    const required = await tx.select({ id: formTemplates.id }).from(formTemplates).where(and(eq(formTemplates.orgId, orgId), eq(formTemplates.active, true), eq(formTemplates.requiredForBooking, true)));
    for (const t of required) {
      const [v] = await tx.select({ id: formTemplateVersions.id }).from(formTemplateVersions).where(and(eq(formTemplateVersions.templateId, t.id), eq(formTemplateVersions.status, "published"))).orderBy(desc(formTemplateVersions.version)).limit(1);
      if (!v) continue;
      for (const key of ["rowan", "priya", "felix", "greta", "mateo", "imani", "tobias", "nia", "caleb", "quinn", "hugo", "ines"]) {
        await tx.insert(formRequests).values({ orgId, templateVersionId: v.id, subjectPersonId: ctx.people[`ret_${key}`], athleteId: ctx.athletes[`ret_${key}`], status: "completed", completedAt: new Date(Date.now() - 20 * 86_400_000), source: "imported_archive", isDemo: true });
      }
    }
  }

  // Coach scope for the demo: Marcus coaches the evening group regulars.
  await tx.insert(coachAssignments).values(["rowan", "priya", "felix", "tobias", "hugo", "ines"].map((k) => ({ orgId, coachUserId: ctx.users.marcus, athleteId: ctx.athletes[`ret_${k}`] })));

  // --- Winback: two ended members --------------------------------------------------------
  await member("kofi", "Kofi", "Hartmann", 17);
  await membership("kofi", { start: 420, version: bill.unlimitedVersionId, status: "cancelled", endDate: addDaysYmd(T, -60), cancelAt: addDaysYmd(T, -60), cancelReason: "Football season; may return in spring (sample)", nextBillDate: null });
  await member("selma", "Selma", "Drury", 15);
  await membership("selma", { start: 330, version: bill.twiceVersionId, status: "expired", endDate: addDaysYmd(T, -150), nextBillDate: null });

  // --- Save log: one save, one loss (snapshots are synthetic) -----------------------------
  await tx.insert(retentionActions).values([
    {
      orgId,
      athleteId: ctx.athletes.ret_quinn,
      level: "watch",
      signals: [{ key: "attendance_drop", label: "Attendance drop", weight: "medium", evidence: "Sample: 1 visit in 28 days vs 8 in the 56 days before." }],
      valueAtRiskMinor: 14900,
      action: "offered_makeup",
      outcome: "saved",
      notes: "Offered two makeup sessions after a busy month; back on schedule (sample).",
      staffUserId: ctx.users.erin,
      createdAt: new Date(Date.now() - 6 * 86_400_000),
      isDemo: true,
    },
    {
      orgId,
      athleteId: ctx.athletes.ret_selma,
      level: "at_risk",
      signals: [{ key: "attendance_gap", label: "No recent visit", weight: "high", evidence: "Sample: last visit 40 days before the membership ended." }],
      valueAtRiskMinor: 14900,
      action: "called",
      outcome: "lost",
      reasonCode: "schedule",
      notes: "Could not make evening classes work with club soccer (sample).",
      staffUserId: ctx.users.rod,
      createdAt: new Date(Date.now() - 150 * 86_400_000),
      isDemo: true,
    },
  ]);

  // --- Session feedback from the existing demo families (through the real rules) ----------
  const viewer = async (userKey: string): Promise<Viewer> => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.users[userKey]));
    return { userId: u.id, orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
  };
  const attendedFor = async (athleteKey: string, n: number) =>
    tx
      .select({ id: bookings.id, endsAt: scheduleSessions.endsAt })
      .from(bookings)
      .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
      .where(and(eq(bookings.athleteId, ctx.athletes[athleteKey]), eq(bookings.status, "attended"), lt(scheduleSessions.endsAt, new Date(Date.now() - 4 * 86_400_000))))
      .orderBy(desc(scheduleSessions.startsAt))
      .limit(n);
  const leave = async (userKey: string, athleteKey: string, entries: { rating: number; comment?: string; tellCoach?: boolean }[]) => {
    const v = await viewer(userKey);
    const bs = await attendedFor(athleteKey, entries.length);
    for (let i = 0; i < bs.length; i++) {
      const fb = await submitFeedback(tx, v, { bookingId: bs[i].id, ...entries[i] }, new Date(bs[i].endsAt.getTime() + 3 * 3_600_000));
      ex[`${athleteKey}Feedback${i}`] = fb.id;
    }
  };
  // Older sessions only (4+ days ago), so the newest attended sessions stay open on the family schedule card.
  await leave("alex", "maya", [
    { rating: 5, comment: "Maya loved the jump work. Great energy. (sample)", tellCoach: true },
    { rating: 4 },
    { rating: 5, tellCoach: true },
  ]);
  await leave("alex", "eli", [{ rating: 4, comment: "Good session, a little crowded. (sample)" }]);
  await leave("sam", "leo", [{ rating: 2, comment: "Leo felt lost in the bigger group and did not get much coaching. (sample)" }, { rating: 4 }]);
  await leave("dana", "dana", [{ rating: 5 }, { rating: 4, comment: "Early slot works well for me. (sample)", tellCoach: true }]);
  await tx.execute(sql`update session_feedback set is_demo = true where org_id = ${orgId}`);
  await tx.execute(sql`update tasks set is_demo = true where org_id = ${orgId} and source = 'session_feedback'`);
}
