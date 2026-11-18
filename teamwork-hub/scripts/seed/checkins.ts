import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { activitySessions, athletes, bodyRegionReports, bookings, scheduleSessions, sessionCheckins, sessionFeedback, tasks, users } from "../../src/db/schema";
import { DEFAULT_DISLIKED_CHIPS, DEFAULT_LIKED_CHIPS } from "../../src/lib/checkins/questions";
import { DISLIKE_TASK_TITLE, REVIEW_TASK_TITLE } from "../../src/lib/checkins/core";
import { localToUtc, localYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic session check-ins for the demo database: about eight weeks of ready checks and after
 * checks on the demo athletes' attended bookings, so trends, baselines, the coach strip and the
 * class view have content. Opt-in (HISTORY_SEEDS): it adds load rows and ratings, so the default
 * test seed leaves it out. Every row is invented and flagged is_demo. Sample notes are sample text.
 */
const SAMPLE_NOTES = ["Big game yesterday (sample)", "Long school day (sample)", "New shoes today (sample)", "Did not sleep much (sample)"];
const SAMPLE_LIKES = ["Sled races at the end (sample)", "Got to pick my partner (sample)"];
const SAMPLE_DISLIKE = "Waited a long time for a rack (sample)";

/** Small deterministic hash so the demo data is the same on every seed. */
function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0) / 4294967296;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export async function seedCheckins(ctx: SeedCtx): Promise<void> {
  const { tx, orgId, today, tz } = ctx;
  const keys = ["maya", "eli", "leo", "dana", "ava", "ethan", "sofia", "liam", "zoe", "harper"].filter((k) => ctx.athletes[k]);
  const ids = keys.map((k) => ctx.athletes[k]);
  if (!ids.length) return;
  const now = localToUtc(today, "12:00", tz);
  const rows = await tx
    .select({ bookingId: bookings.id, athleteId: bookings.athleteId, sessionId: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, coachUserId: scheduleSessions.coachUserId })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, orgId), inArray(bookings.athleteId, ids), eq(bookings.status, "attended"), gte(scheduleSessions.startsAt, new Date(now.getTime() - 56 * 86_400_000)), lte(scheduleSessions.endsAt, now)))
    .orderBy(asc(scheduleSessions.startsAt));
  if (!rows.length) return;
  const people = new Map((await tx.select({ id: athletes.id, personId: athletes.personId }).from(athletes).where(inArray(athletes.id, ids))).map((a) => [a.id, a.personId]));
  const rated = new Set((await tx.select({ b: sessionFeedback.bookingId }).from(sessionFeedback).where(eq(sessionFeedback.orgId, orgId))).map((r) => r.b));
  // Who "submitted": the athlete's own login where one exists, else a parent login.
  const submitter: Record<string, { userId: string; role: "athlete" | "guardian" }> = {};
  for (const [k, u, role] of [["maya", "maya", "athlete"], ["dana", "dana", "athlete"], ["eli", "alex", "guardian"], ["ava", "chris", "guardian"], ["leo", "sam", "guardian"]] as const) {
    if (ctx.athletes[k] && ctx.users[u]) submitter[ctx.athletes[k]] = { userId: ctx.users[u], role };
  }
  const [owner] = await tx.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "owner"))).limit(1);

  // Planned intensity on the sessions involved, so "reported vs planned" has something to show.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  for (const sid of sessionIds) await tx.update(scheduleSessions).set({ intendedRpe: 5 + Math.floor(h(`plan${sid}`) * 3) }).where(eq(scheduleSessions.id, sid));

  const lastOf = new Map<string, string>();
  for (const r of rows) lastOf.set(r.athleteId, r.bookingId);
  const prevAttended = new Map<string, string>();
  for (const r of rows) {
    const k = keys[ids.indexOf(r.athleteId)];
    const seed = `${k}|${localYmd(r.startsAt, tz)}|${r.title}`;
    const base = { ready: 3 + Math.round(h(`r${k}`) * 2), sore: 1 + Math.round(h(`s${k}`) * 3), rpe: 5 + Math.round(h(`e${k}`) * 2) };
    const who = submitter[r.athleteId];
    const by = (section: string, at: Date) => ({ [section]: { userId: who?.userId ?? null, role: who?.role ?? "athlete", at: at.toISOString() } });
    const isLast = lastOf.get(r.athleteId) === r.bookingId;
    const minutes = Math.max(1, Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000));
    const prior = prevAttended.get(r.athleteId) ?? null;
    prevAttended.set(r.athleteId, r.bookingId);

    if (h(`pre${seed}`) < 0.82 || isLast) {
      const at = new Date(r.startsAt.getTime() - 50 * 60_000);
      // Story for the strip: Maya arrives much sorer than her usual on her latest session.
      const spike = isLast && k === "maya";
      const soreness = spike ? 8 : clamp(base.sore + (h(`so${seed}`) - 0.5) * 3, 0, 10);
      const readiness = spike ? 2 : clamp(base.ready + (h(`re${seed}`) - 0.5) * 2, 1, 5);
      const ache = isLast && k === "leo";
      const [c] = await tx
        .insert(sessionCheckins)
        .values({
          orgId,
          bookingId: r.bookingId,
          sessionId: r.sessionId,
          athleteId: r.athleteId,
          phase: "pre",
          questionSetVersion: "1.1",
          readiness,
          sleepQuality: clamp(3.4 + (h(`sl${seed}`) - 0.5) * 3, 1, 5),
          sleepHours: Math.round((7.5 + (h(`sh${seed}`) - 0.5) * 3) * 2) / 2,
          fatigue: clamp(2.5 + (h(`fa${seed}`) - 0.5) * 3, 1, 5),
          mood: clamp(3.8 + (h(`mo${seed}`) - 0.5) * 2, 1, 5),
          soreness,
          priorSoreness: prior && h(`ps${seed}`) < 0.7 ? clamp(base.sore + 1 + (h(`pv${seed}`) - 0.5) * 4, 0, 10) : null,
          priorBookingId: prior && h(`ps${seed}`) < 0.7 ? prior : null,
          hurt: ache,
          note: spike ? "Legs are really heavy after the tournament (sample)" : h(`no${seed}`) < 0.12 ? SAMPLE_NOTES[Math.floor(h(`nn${seed}`) * SAMPLE_NOTES.length)] : null,
          answeredBy: by("ready", at),
          loggedByParent: who?.role === "guardian",
          source: h(`ki${seed}`) < 0.3 && who?.role !== "guardian" ? "kiosk" : "app",
          alertReasons: spike ? ["soreness_above_baseline", "readiness_below_baseline"] : [],
          isDemo: true,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (ache) await tx.insert(bodyRegionReports).values({ orgId, athleteId: r.athleteId, region: "hamstring", side: "right", view: "back", kind: "soreness", severity: 3, reportedAt: at, reviewStatus: "reviewed", reviewNote: "Below review threshold (auto)", sourceCheckinId: c.id, isDemo: true });
      if (spike) {
        const [t] = await tx
          .insert(tasks)
          .values({ orgId, title: REVIEW_TASK_TITLE, description: `An athlete's check-in answers need a look before or after training. Open /check-ins/responses/${c.id} (details are shown to staff with health access for this athlete). Self-reported, not a diagnosis. Nothing was sent to the family.`, dueAt: new Date(now.getTime() + 86_400_000), assigneeUserId: r.coachUserId, relatedPersonId: people.get(r.athleteId) ?? null, relatedType: "session_checkin", relatedId: c.id, priority: "high", source: "session_checkin", dedupeKey: `checkin_review:${c.id}`, isDemo: true })
          .returning();
        await tx.update(sessionCheckins).set({ reviewTaskId: t.id }).where(eq(sessionCheckins.id, c.id));
      }
    }

    // Eli's latest session is left without an after check so a parent login has one to answer in the demo.
    if ((h(`post${seed}`) < 0.72 || isLast) && !(isLast && k === "eli")) {
      const at = new Date(r.endsAt.getTime() + 40 * 60_000);
      const rpe = clamp(base.rpe + (h(`rp${seed}`) - 0.5) * 4, 1, 10);
      const complaint = isLast && k === "dana";
      const liked = DEFAULT_LIKED_CHIPS.filter((c, i) => h(`lk${seed}${i}`) < 0.28).slice(0, 3);
      const disliked = complaint ? [DEFAULT_DISLIKED_CHIPS[3]] : h(`dk${seed}`) < 0.12 ? [DEFAULT_DISLIKED_CHIPS[Math.floor(h(`dd${seed}`) * DEFAULT_DISLIKED_CHIPS.length)]] : [];
      const [act] = await tx
        .insert(activitySessions)
        .values({ orgId, athleteId: r.athleteId, activityDate: localYmd(r.startsAt, tz), kind: "training", durationMinutes: minutes, sessionRpe: rpe, notes: `Session check-in: ${r.title}`, source: "session_checkin", isDemo: true })
        .returning({ id: activitySessions.id });
      const [c] = await tx
        .insert(sessionCheckins)
        .values({
          orgId,
          bookingId: r.bookingId,
          sessionId: r.sessionId,
          athleteId: r.athleteId,
          phase: "post",
          questionSetVersion: "1.1",
          rpe,
          durationMinutes: minutes,
          soreness: clamp(base.sore + 1 + (h(`ap${seed}`) - 0.5) * 3, 0, 10),
          hurt: false,
          likedChips: liked,
          likedText: h(`lt${seed}`) < 0.08 ? SAMPLE_LIKES[Math.floor(h(`ln${seed}`) * SAMPLE_LIKES.length)] : null,
          dislikedChips: disliked,
          dislikedText: complaint ? SAMPLE_DISLIKE : null,
          nothingToChange: disliked.length ? false : h(`nt${seed}`) < 0.7 ? true : null,
          tellCoach: h(`tc${seed}`) < 0.5,
          answeredBy: { ...by("effort", at), ...by("body", at), ...by("experience", at) },
          loggedByParent: who?.role === "guardian",
          source: "app",
          activitySessionId: act.id,
          alertReasons: complaint ? ["disliked_comment"] : [],
          isDemo: true,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (who && !rated.has(r.bookingId) && h(`rt${seed}`) < 0.85) {
        await tx.insert(sessionFeedback).values({ orgId, bookingId: r.bookingId, sessionId: r.sessionId, athleteId: r.athleteId, rating: complaint ? 3 : clamp(4.3 + (h(`rv${seed}`) - 0.5) * 2, 3, 5), tellCoach: c.tellCoach, submittedByUserId: who.userId, submittedByRole: who.role, isDemo: true, createdAt: at, updatedAt: at });
        rated.add(r.bookingId);
      }
      if (complaint && owner) {
        const [t] = await tx
          .insert(tasks)
          .values({ orgId, title: DISLIKE_TASK_TITLE, description: `Someone said there was something they did not like or wanted changed after a session. Open /check-ins/responses/${c.id} to read it (visible to roles allowed). Nothing was sent to the family.`, dueAt: new Date(now.getTime() + 2 * 86_400_000), assigneeUserId: owner.id, relatedType: "session_checkin", relatedId: c.id, source: "session_checkin", dedupeKey: `checkin_dislike:${c.id}`, isDemo: true })
          .returning();
        await tx.update(sessionCheckins).set({ experienceTaskId: t.id }).where(eq(sessionCheckins.id, c.id));
      }
    }
  }
}
