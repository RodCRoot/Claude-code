import { eq } from "drizzle-orm";
import {
  bookings,
  busyBlocks,
  cancellationPolicies,
  classSeries,
  coachAvailability,
  resources,
  scheduleSessions,
  serviceTypes,
} from "../../src/db/schema";
import { grantCredits, reserveCredits, settleReservation } from "../../src/lib/credits";
import { seriesOccurrences } from "../../src/lib/scheduling/recurrence";
import { addDaysYmd, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/** Deterministic PRNG so the demo data is stable between runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic scheduling data: resources, a clearly labeled SAMPLE cancellation policy, service
 * types, weekly series for Coach Marcus (HS) and Coach Tess (Youth), sessions from today−28 to
 * today+21, realistic bookings/attendance (with no-shows and late cancels) on a consistent credit
 * ledger, coach availability, time off, and staff-granted demo credits.
 */
export async function seedScheduling(ctx: SeedCtx) {
  const { tx, orgId, today, tz } = ctx;
  const rand = rng(20260302);
  const ex: Record<string, string> = {};
  ctx.extra.scheduling = ex;

  // --- Resources -------------------------------------------------------------------
  const [turf] = await tx.insert(resources).values({ orgId, name: "Turf", kind: "area", capacity: 30 }).returning();
  const [weights] = await tx.insert(resources).values({ orgId, name: "Weight Room", kind: "room", capacity: 16 }).returning();
  const [assessRoom] = await tx.insert(resources).values({ orgId, name: "Assessment Room", kind: "room", capacity: 2, exclusive: true }).returning();
  Object.assign(ex, { turf: turf.id, weightRoom: weights.id, assessmentRoom: assessRoom.id });

  // --- Cancellation policy (sample values, clearly labeled) --------------------------
  const [policy] = await tx
    .insert(cancellationPolicies)
    .values({
      orgId,
      name: "SAMPLE policy — replace with Teamwork's approved policy",
      lateCancelWindowMinutes: 12 * 60,
      lateCancelPenalty: "forfeit_credit",
      noShowPenalty: "forfeit_credit",
      feeMinor: 0,
      description: "Demonstration values only (12-hour late-cancel window; late cancels and no-shows use the session credit). Not an approved Teamwork policy.",
    })
    .returning();
  ex.policy = policy.id;

  // --- Service types ---------------------------------------------------------------
  const [gpt] = await tx
    .insert(serviceTypes)
    .values({ orgId, name: "Group Performance Training", kind: "class", description: "Small-group speed, strength, and movement training.", defaultDurationMinutes: 60, defaultCapacity: 12, creditCost: 1, cancellationPolicyId: policy.id, color: "#2563eb" })
    .returning();
  const [priv] = await tx
    .insert(serviceTypes)
    .values({ orgId, name: "Private Session", kind: "private", description: "One-on-one coaching.", defaultDurationMinutes: 60, defaultCapacity: 1, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, creditCost: 1, cancellationPolicyId: policy.id, exclusiveCoach: true, color: "#7c3aed" })
    .returning();
  const [assess] = await tx
    .insert(serviceTypes)
    .values({ orgId, name: "Athletic Assessment", kind: "assessment", description: "Baseline movement and performance assessment.", defaultDurationMinutes: 60, defaultCapacity: 1, bufferBeforeMinutes: 0, bufferAfterMinutes: 15, creditCost: 1, cancellationPolicyId: policy.id, publicBookable: true, exclusiveCoach: true, color: "#0891b2" })
    .returning();
  const [camp] = await tx
    .insert(serviceTypes)
    .values({ orgId, name: "Speed Camp", kind: "camp", description: "Multi-day speed camp (sample).", defaultDurationMinutes: 90, defaultCapacity: 20, creditCost: 1, cancellationPolicyId: policy.id, color: "#ea580c" })
    .returning();
  Object.assign(ex, { gpt: gpt.id, private: priv.id, assessment: assess.id, camp: camp.id });

  // --- Weekly series -------------------------------------------------------------------
  const from = addDaysYmd(today, -28);
  const to = addDaysYmd(today, 21);
  type SeriesDef = { key: string; title: string; st: typeof gpt; weekdays: number[]; time: string; dur: number; coach: string; resource: string; cap: number; wl: number; startsOn: string; endsOn: string | null; group: string[] };
  // ethan, sofia, liam and harper are deliberately left without bookings/credits: the credit-ledger
  // tests use them as clean slates. Ava has no credits either (shows the "needs credits" path).
  const hs = ["maya", "leo", "mason", "zoe", "jackson"];
  const youth = ["eli", "ella", "owen", "aria"];
  const defs: SeriesDef[] = [
    { key: "hsAm", title: "HS Speed & Strength (6 AM)", st: gpt, weekdays: [1, 3, 5], time: "06:00", dur: 60, coach: "marcus", resource: weights.id, cap: 12, wl: 5, startsOn: from, endsOn: null, group: [...hs, "dana"] },
    { key: "hsPm", title: "HS Performance — Turf", st: gpt, weekdays: [2, 4], time: "16:30", dur: 60, coach: "marcus", resource: turf.id, cap: 12, wl: 5, startsOn: from, endsOn: null, group: hs },
    { key: "youthPm", title: "Youth Athletic Development", st: gpt, weekdays: [2, 4], time: "17:30", dur: 60, coach: "tess", resource: turf.id, cap: 10, wl: 4, startsOn: from, endsOn: null, group: youth },
    { key: "youthSat", title: "Youth Saturday Skills", st: gpt, weekdays: [6], time: "09:00", dur: 75, coach: "tess", resource: turf.id, cap: 10, wl: 4, startsOn: from, endsOn: null, group: youth },
    { key: "camp", title: "Fall Speed Camp (sample)", st: camp, weekdays: [1, 2, 3, 4, 5, 6, 7], time: "10:00", dur: 90, coach: "marcus", resource: turf.id, cap: 20, wl: 0, startsOn: addDaysYmd(today, 7), endsOn: addDaysYmd(today, 10), group: [...hs.slice(0, 4), ...youth.slice(0, 2)] },
  ];

  type SeededSession = { id: string; date: string; startsAt: Date; group: string[]; capacity: number; st: typeof gpt };
  const all: SeededSession[] = [];
  for (const d of defs) {
    const [s] = await tx
      .insert(classSeries)
      .values({
        orgId,
        serviceTypeId: d.st.id,
        title: d.title,
        weekdays: d.weekdays,
        startTimeLocal: d.time,
        durationMinutes: d.dur,
        timezone: tz,
        startsOn: d.startsOn,
        endsOn: d.endsOn,
        coachUserId: ctx.users[d.coach],
        resourceId: d.resource,
        capacity: d.cap,
        waitlistCapacity: d.wl,
        isDemo: true,
      })
      .returning();
    ex[`series_${d.key}`] = s.id;
    const occ = seriesOccurrences({ weekdays: d.weekdays, startTimeLocal: d.time, durationMinutes: d.dur, timezone: tz, startsOn: d.startsOn, endsOn: d.endsOn }, from, to);
    if (!occ.length) continue;
    const rows = await tx
      .insert(scheduleSessions)
      .values(
        occ.map((o) => ({
          orgId,
          serviceTypeId: d.st.id,
          seriesId: s.id,
          title: d.title,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          timezone: tz,
          coachUserId: ctx.users[d.coach],
          resourceId: d.resource,
          capacity: d.cap,
          waitlistCapacity: d.wl,
          visibility: d.st.kind === "camp" ? ("public" as const) : ("members" as const),
          isDemo: true,
        })),
      )
      .returning({ id: scheduleSessions.id, startsAt: scheduleSessions.startsAt });
    rows.forEach((r, i) => all.push({ id: r.id, date: occ[i].date, startsAt: r.startsAt, group: d.group, capacity: d.cap, st: d.st }));
  }

  // One-off evening session today so the kiosk always has something to check in.
  const [tonight] = await tx
    .insert(scheduleSessions)
    .values({
      orgId,
      serviceTypeId: gpt.id,
      title: "Evening Open Training",
      startsAt: localToUtc(today, "18:00", tz),
      endsAt: localToUtc(today, "19:00", tz),
      timezone: tz,
      coachUserId: ctx.users.tess,
      resourceId: weights.id,
      capacity: 10,
      waitlistCapacity: 3,
      isDemo: true,
    })
    .returning();
  ex.tonightSession = tonight.id;
  all.push({ id: tonight.id, date: today, startsAt: tonight.startsAt, group: ["eli", "maya", "ella", "leo", "dana"], capacity: 10, st: gpt });

  // A past session cancelled by staff (no bookings) to show the cancelled state.
  const cancelled = all.find((s) => s.date < today && s.date >= addDaysYmd(today, -10) && s.group === youth);
  if (cancelled) {
    await tx.update(scheduleSessions).set({ status: "cancelled", cancelReason: "Coach illness (demo)" }).where(eq(scheduleSessions.id, cancelled.id));
    all.splice(all.indexOf(cancelled), 1);
  }

  // --- Demo credits (staff grants; Ava intentionally has none) ---------------------
  const creditAthletes = [...hs, ...youth, "dana"];
  for (const k of creditAthletes) {
    await grantCredits(tx, {
      orgId,
      athleteId: ctx.athletes[k],
      amount: k === "dana" ? 24 : 32,
      sourceKind: "staff_grant",
      actorUserId: ctx.users.erin,
      reason: "Demo credits (synthetic)",
      idempotencyKey: `seed-grant:${orgId}:${k}`,
      isDemo: true,
    });
  }

  // --- Bookings & attendance ---------------------------------------------------------
  const nextHsAm = all.find((s) => s.date > today && s.group.includes("dana") && s.st.id === gpt.id);
  if (nextHsAm) {
    // A full upcoming class with a waitlist.
    await tx.update(scheduleSessions).set({ capacity: 4, waitlistCapacity: 3 }).where(eq(scheduleSessions.id, nextHsAm.id));
    nextHsAm.capacity = 4;
    ex.fullSession = nextHsAm.id;
  }

  let i = 0;
  for (const s of all.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    const past = s.date < today;
    const isFull = s.id === nextHsAm?.id;
    const roster = isFull ? s.group.slice(0, 6) : s.group.filter(() => rand() < (past ? 0.72 : s.id === tonight.id ? 1 : 0.45));
    let booked = 0;
    let waitPos = 0;
    for (const k of roster) {
      const athleteId = ctx.athletes[k];
      if (booked >= s.capacity) {
        waitPos += 1;
        await tx.insert(bookings).values({ orgId, sessionId: s.id, athleteId, bookedByUserId: ctx.users.erin, status: "waitlisted", waitlistPosition: waitPos, isDemo: true });
        continue;
      }
      booked += 1;
      const [b] = await tx
        .insert(bookings)
        .values({ orgId, sessionId: s.id, athleteId, bookedByUserId: ctx.users.erin, status: "booked", entitlementSource: "credit", isDemo: true, createdAt: new Date(s.startsAt.getTime() - 3 * 86_400_000) })
        .returning();
      const r = await reserveCredits(tx, { orgId, athleteId, bookingId: b.id, serviceTypeId: s.st.id, cost: s.st.creditCost, sessionStartsAt: s.startsAt, actorUserId: ctx.users.erin });
      await tx.update(bookings).set({ creditBucketId: r.bucketId }).where(eq(bookings.id, b.id));
      if (!past) continue;
      const roll = rand();
      i += 1;
      if (roll < 0.08) {
        await settleReservation(tx, { bookingId: b.id, outcome: "forfeit", actorUserId: ctx.users[k === "dana" || hs.includes(k) ? "marcus" : "tess"], reason: "No-show" });
        await tx.update(bookings).set({ status: "no_show" }).where(eq(bookings.id, b.id));
      } else if (roll < 0.13) {
        await settleReservation(tx, { bookingId: b.id, outcome: "forfeit", actorUserId: ctx.users.alex, reason: "Late cancellation" });
        await tx.update(bookings).set({ status: "late_cancelled", cancelledAt: new Date(s.startsAt.getTime() - 2 * 3_600_000) }).where(eq(bookings.id, b.id));
      } else if (roll < 0.18) {
        await settleReservation(tx, { bookingId: b.id, outcome: "release", actorUserId: ctx.users.erin, reason: "Cancelled in time" });
        await tx.update(bookings).set({ status: "cancelled", cancelledAt: new Date(s.startsAt.getTime() - 2 * 86_400_000) }).where(eq(bookings.id, b.id));
      } else {
        await settleReservation(tx, { bookingId: b.id, outcome: "consume", actorUserId: ctx.users.erin, reason: "Attended" });
        await tx
          .update(bookings)
          .set({ status: "attended", checkedInAt: new Date(s.startsAt.getTime() - (2 + (i % 9)) * 60_000), checkInMethod: i % 3 === 0 ? "staff" : "kiosk" })
          .where(eq(bookings.id, b.id));
      }
    }
  }

  // --- Private sessions & an assessment ------------------------------------------------
  const privates: { athlete: string; coach: string; date: string; time: string; st: typeof gpt; resource: string | null; status: "attended" | "booked"; comp?: string }[] = [
    { athlete: "leo", coach: "marcus", date: addDaysYmd(today, -14), time: "13:00", st: priv, resource: null, status: "attended" },
    { athlete: "leo", coach: "marcus", date: addDaysYmd(today, -7), time: "13:00", st: priv, resource: null, status: "attended" },
    { athlete: "leo", coach: "marcus", date: addDaysYmd(today, 3), time: "13:00", st: priv, resource: null, status: "booked" },
    { athlete: "dana", coach: "marcus", date: addDaysYmd(today, 2), time: "09:00", st: priv, resource: null, status: "booked" },
    { athlete: "ava", coach: "tess", date: addDaysYmd(today, 5), time: "14:00", st: assess, resource: assessRoom.id, status: "booked", comp: "Complimentary intro assessment (demo)" },
  ];
  for (const p of privates) {
    const startsAt = localToUtc(p.date, p.time, tz);
    const [s] = await tx
      .insert(scheduleSessions)
      .values({
        orgId,
        serviceTypeId: p.st.id,
        title: p.st.name,
        startsAt,
        endsAt: new Date(startsAt.getTime() + p.st.defaultDurationMinutes * 60_000),
        timezone: tz,
        coachUserId: ctx.users[p.coach],
        resourceId: p.resource,
        capacity: 1,
        bufferBeforeMinutes: p.st.bufferBeforeMinutes,
        bufferAfterMinutes: p.st.bufferAfterMinutes,
        exclusiveCoach: true,
        exclusiveResource: !!p.resource,
        visibility: "private",
        isDemo: true,
      })
      .returning();
    const [b] = await tx
      .insert(bookings)
      .values({ orgId, sessionId: s.id, athleteId: ctx.athletes[p.athlete], bookedByUserId: ctx.users.erin, status: "booked", entitlementSource: p.comp ? "comp" : "credit", isDemo: true })
      .returning();
    if (!p.comp) {
      const r = await reserveCredits(tx, { orgId, athleteId: ctx.athletes[p.athlete], bookingId: b.id, serviceTypeId: p.st.id, cost: 1, sessionStartsAt: startsAt, actorUserId: ctx.users.erin });
      await tx.update(bookings).set({ creditBucketId: r.bucketId }).where(eq(bookings.id, b.id));
    }
    if (p.status === "attended") {
      await settleReservation(tx, { bookingId: b.id, outcome: "consume", actorUserId: ctx.users[p.coach], reason: "Attended" });
      await tx.update(bookings).set({ status: "attended", checkedInAt: startsAt, checkInMethod: "staff" }).where(eq(bookings.id, b.id));
    }
  }

  // --- Coach availability & time off ----------------------------------------------------
  await tx.insert(coachAvailability).values([
    ...[1, 2, 3, 4, 5].map((weekday) => ({ orgId, coachUserId: ctx.users.marcus, weekday, startLocal: "08:00", endLocal: "15:00" })),
    ...[1, 3, 5].map((weekday) => ({ orgId, coachUserId: ctx.users.tess, weekday, startLocal: "12:00", endLocal: "17:00" })),
    { orgId, coachUserId: ctx.users.tess, weekday: 6, startLocal: "10:30", endLocal: "13:00" },
  ]);
  const offDay = addDaysYmd(today, 4);
  await tx.insert(busyBlocks).values({ orgId, coachUserId: ctx.users.tess, startsAt: localToUtc(offDay, "00:00", tz), endsAt: localToUtc(addDaysYmd(offDay, 1), "00:00", tz), source: "time_off", reason: "Personal day (demo)" });
}
