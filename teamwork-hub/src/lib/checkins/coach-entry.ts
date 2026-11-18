import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { sessionCheckins, type CheckinAnsweredBy, type CheckinReplacement, type CheckinSection } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { athleteCapabilities, AuthzError, type Viewer } from "@/lib/authz/policy";
import { retentionContext } from "@/lib/retention/common";
import { todayLocal } from "@/lib/time";
import { afterSchema, checkinSpot, loadBooking, postWindows, preWindow, readySchema, saveAfter, saveReady, wellnessPrefill, type SectionState, type Writer } from "./core";
import { checkinSettings } from "./settings";

/**
 * Coach-entered check-ins: a coach types in what an athlete told them out loud.
 *
 * WHO: a coach, owner or admin with `training.write` on that athlete (coaches: assigned athletes
 * only). The health parts (the whole ready check, and the body questions of the after check)
 * additionally need `health.write`. Operations has neither, so it can enter nothing.
 *
 * WHAT IS RECORDED: every section a coach enters is stamped `role: "coach"` with the coach's user
 * id and display name, and shown as "entered by coach <name>" wherever the check-in shows. The
 * entry is audited (no answers in the audit text).
 *
 * WHAT IT NEVER DOES:
 * - It never silently overwrites an answer the athlete, a parent or the kiosk already gave. To
 *   replace one the coach must say so and give a reason, and the earlier answer is kept on the
 *   check-in in `replacements`, which every view of the check-in shows.
 * - It never replaces the family's likes and dislikes, never enters the 1 to 5 rating, and never
 *   sets "show my coach my name": those are the family's own. What a coach typed in is visible to
 *   the coach by definition, so the privacy promise is not involved (see `sharedWithCoach`).
 * - It awards nothing extra: XP for a check-in is one award per booking and phase whoever answered.
 */
const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
const ENTRY_ROLES = ["coach", "owner", "admin"];
/** The name shown after "entered by coach": the display name without a leading "Coach", so it never reads "coach Coach ...". */
export const entryName = (v: Pick<Viewer, "displayName">) => v.displayName.replace(/^coach\s+/i, "").trim() || v.displayName;

export type CoachEntryAccess = { any: boolean; ready: boolean; effort: boolean; body: boolean; experience: boolean };

export async function coachEntryAccess(tx: Tx, v: Viewer, athleteId: string): Promise<CoachEntryAccess> {
  const none = { any: false, ready: false, effort: false, body: false, experience: false };
  if (!ENTRY_ROLES.includes(v.role)) return none;
  const caps = await athleteCapabilities(tx, v, athleteId);
  const training = caps.has("training.write");
  if (!training) return none;
  const health = caps.has("health.write");
  return { any: true, ready: health, body: health, effort: true, experience: true };
}

/**
 * open      = nobody has answered this part; the coach may enter it
 * editable  = a coach entered it; a coach may correct it while the window is open
 * answered  = the athlete, a parent or the kiosk answered it; replacing needs an explicit yes and a reason
 * family    = the family's own likes and dislikes; a coach cannot replace these
 * closed    = the window for this part is over (or has not opened)
 * not_allowed = this staff member may not enter this part for this athlete
 */
export type CoachSectionState = "open" | "editable" | "answered" | "family" | "closed" | "not_allowed";

function coachSection(section: CheckinSection, allowed: boolean, by: CheckinAnsweredBy, windowOpen: boolean): CoachSectionState {
  if (!allowed) return "not_allowed";
  if (!windowOpen) return "closed";
  const a = by[section];
  if (!a) return "open";
  if (a.role === "coach") return "editable";
  return section === "experience" ? "family" : "answered";
}

const whoLabel = (a: NonNullable<CheckinAnsweredBy[CheckinSection]>) => (a.role === "coach" ? `coach ${a.name ?? ""}`.trim() : a.role === "guardian" ? "a parent" : a.role === "kiosk" ? "the athlete at the kiosk" : "the athlete");

async function staffBooking(tx: Tx, v: Viewer, bookingId: string) {
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) throw new AuthzError();
  const row = await loadBooking(tx, v.orgId, bookingId);
  if (!row) throw new AuthzError();
  const access = await coachEntryAccess(tx, v, row.booking.athleteId);
  if (!access.any) throw new AuthzError("You can enter a check-in only for athletes you coach.");
  return { row, access };
}

/** Everything the coach-entry page needs for one booking, and the gate both submits re-check. */
export async function coachEntryTarget(tx: Tx, v: Viewer, bookingId: string, now = new Date()) {
  const { row, access } = await staffBooking(tx, v, bookingId);
  const settings = await checkinSettings(tx, v.orgId);
  const { settings: retention } = await retentionContext(tx, v.orgId);
  const live = (row.booking.status === "booked" || row.booking.status === "attended") && row.session.status !== "cancelled";
  const rows = await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, bookingId), eq(sessionCheckins.orgId, v.orgId)));
  const pre = rows.find((r) => r.phase === "pre") ?? null;
  const post = rows.find((r) => r.phase === "post") ?? null;

  // Ready check: a coach asks at the start of class and may type it in until the session ends.
  const pw = preWindow(row.session, settings, now);
  const readyOpen = settings.preEnabled && live && now >= pw.opensAt && now <= row.session.endsAt;
  const ready = coachSection("ready", access.ready, pre?.answeredBy ?? {}, readyOpen);

  const win = postWindows(row.session, settings, retention.feedbackEntryDays, now);
  const afterLive = settings.postEnabled && row.booking.status === "attended" && row.session.status !== "cancelled";
  const by = post?.answeredBy ?? {};
  const after = {
    effort: coachSection("effort", access.effort, by, afterLive && win.trainingOpen),
    body: coachSection("body", access.body, by, afterLive && win.trainingOpen),
    experience: coachSection("experience", access.experience, by, afterLive && win.experienceOpen),
  };
  const today = todayLocal(row.session.timezone, now);
  const writableReady = ready === "open" || ready === "editable" || ready === "answered";
  return {
    row,
    access,
    settings,
    athleteName: `${row.preferred ?? row.first} ${row.last}`,
    firstName: row.preferred ?? row.first,
    ready,
    after,
    readyWhy: !access.ready ? "You do not have health access for this athlete, so you cannot enter the ready check." : !settings.preEnabled ? "Ready checks are turned off." : !live ? "The ready check is for a booked session." : now < pw.opensAt ? "The ready check opens a few hours before the session." : now > row.session.endsAt ? "The session has ended, so the ready check can no longer be entered." : null,
    afterWhy: !settings.postEnabled ? "After checks are turned off." : row.booking.status !== "attended" ? "The after check opens once the athlete has been checked in to the session." : !win.started ? "The after check opens when the session ends." : null,
    // Earlier answers are health or training data: returned only for the parts this coach may enter.
    pre: pre && access.ready ? pre : null,
    post: post
      ? {
          id: post.id,
          rpe: access.effort ? post.rpe : null,
          soreness: access.body ? post.soreness : null,
          hurt: access.body ? post.hurt : null,
          hurtStartedInSession: access.body ? post.hurtStartedInSession : null,
          // The family's own likes and dislikes are prefilled only when a coach entered them.
          experience: by.experience?.role === "coach" ? { liked: post.likedChips, likedText: post.likedText, disliked: post.dislikedChips, dislikedText: post.dislikedText, nothingToChange: post.nothingToChange, note: post.note } : null,
        }
      : null,
    readyBy: pre?.answeredBy.ready ? { label: whoLabel(pre.answeredBy.ready), at: pre.answeredBy.ready.at } : null,
    afterBy: Object.fromEntries((["effort", "body", "experience"] as const).map((s) => [s, by[s] ? { label: whoLabel(by[s]!), at: by[s]!.at } : null])) as Record<"effort" | "body" | "experience", { label: string; at: string } | null>,
    prefill: writableReady ? await wellnessPrefill(tx, v.orgId, row.booking.athleteId, today) : {},
    readySpot: pre && access.ready && writableReady ? await checkinSpot(tx, pre.id) : null,
    rawPre: pre,
    rawPost: post,
    window: win,
    durationMinutes: Math.max(1, Math.round((row.session.endsAt.getTime() - row.session.startsAt.getTime()) / 60_000)),
  };
}

const yes = z.preprocess((x) => x === true || x === "on" || x === "true" || x === "yes", z.boolean());
const reason = z.preprocess((x) => (typeof x === "string" && x.trim() ? x.trim() : null), z.string().max(200, "Keep the reason under 200 characters").nullable());

function replacementFor(v: Viewer, section: CheckinSection, by: CheckinAnsweredBy, why: string, values: Record<string, unknown>, now: Date): CheckinReplacement {
  const prev = by[section]!;
  return { section, at: now.toISOString(), byUserId: v.userId, byName: entryName(v), reason: why, previous: { role: prev.role, userId: prev.userId, at: prev.at }, values };
}

const NEEDS_REPLACE = "The athlete (or a parent) already answered this. Tick the box to replace their answer and say why. Their answer is kept on the record.";

export const coachReadySchema = readySchema.extend({ replace: yes, replaceReason: reason });

/** A coach enters (or corrects) the ready check for an athlete who told them the answers. */
export async function coachSubmitReady(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  const input = coachReadySchema.parse(raw);
  const t = await coachEntryTarget(tx, v, input.bookingId, now);
  if (t.ready === "not_allowed") throw new AuthzError(t.readyWhy ?? undefined);
  if (t.ready === "closed" || t.ready === "family") throw new UserError(t.readyWhy ?? "The ready check cannot be entered right now.");
  let replacement: CheckinReplacement | null = null;
  if (t.ready === "answered") {
    if (!input.replace) throw new UserError(NEEDS_REPLACE, { replace: "Required to replace an existing answer" });
    if (!input.replaceReason) throw new UserError("Say why you are replacing the athlete's own answer.", { replaceReason: "Required" });
    const p = t.rawPre!;
    replacement = replacementFor(v, "ready", p.answeredBy, input.replaceReason, { readiness: p.readiness, sleepQuality: p.sleepQuality, sleepHours: p.sleepHours, soreness: p.soreness, fatigue: p.fatigue, mood: p.mood, stress: p.stress, hurt: p.hurt, note: p.note }, now);
  }
  const w: Writer = { userId: v.userId, role: "coach", source: "app", auditActor: actor(v), name: entryName(v) };
  // The next-day soreness question is not part of a coach entry; an earlier answer to it is kept.
  const r = await saveReady(tx, v.orgId, t.row, t.settings, input, w, { prefill: t.prefill, prior: null, existing: t.rawPre, replacement }, now);
  if (!r.created && !t.rawPre) throw new UserError("Someone answered this ready check a moment ago. Reload the page to see it.");
  await audit(tx, actor(v), replacement ? "checkin.coach_replace" : "checkin.coach_entry", "session_checkin", r.checkin.id, {
    summary: replacement
      ? `Ready check entered by coach ${entryName(v)} for ${t.athleteName}, replacing the answer given by ${whoLabel({ ...replacement.previous })}. Reason: ${replacement.reason}`
      : `Ready check entered by coach ${entryName(v)} on behalf of ${t.athleteName}`,
  });
  return { checkin: r.checkin, replaced: !!replacement, reasons: r.reasons };
}

export const coachAfterSchema = afterSchema.extend({ replace: yes, replaceReason: reason });

/** A coach enters (or corrects) the parts of the after check the athlete told them. Never the rating. */
export async function coachSubmitAfter(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  const input = coachAfterSchema.parse(raw);
  const t = await coachEntryTarget(tx, v, input.bookingId, now);
  if (t.afterWhy) throw new UserError(t.afterWhy);
  const hurt = input.hurt ?? (input.spot ? true : null);
  const gave = {
    effort: input.rpe !== null,
    body: hurt !== null || input.soreness !== null,
    experience: input.liked.length > 0 || input.disliked.length > 0 || !!input.likedText || !!input.dislikedText || input.nothingToChange || !!input.note,
  };
  const replacements: CheckinReplacement[] = [];
  const sections = {} as Record<"effort" | "body" | "experience", SectionState>;
  for (const s of ["effort", "body", "experience"] as const) {
    const st = t.after[s];
    if (gave[s] && st === "not_allowed") throw new AuthzError(s === "body" ? "You do not have health access for this athlete, so you cannot enter the body questions." : undefined);
    if (gave[s] && st === "family") throw new UserError("The family already answered what they liked and did not like. Those are their own words and cannot be replaced.");
    if (gave[s] && st === "closed") throw new UserError("The window for part of this after check has closed.");
    if (gave[s] && st === "answered") {
      if (!input.replace) throw new UserError(NEEDS_REPLACE, { replace: "Required to replace an existing answer" });
      if (!input.replaceReason) throw new UserError("Say why you are replacing the athlete's own answer.", { replaceReason: "Required" });
      const p = t.rawPost!;
      replacements.push(replacementFor(v, s, p.answeredBy, input.replaceReason, s === "effort" ? { rpe: p.rpe, durationMinutes: p.durationMinutes } : { hurt: p.hurt, soreness: p.soreness, hurtStartedInSession: p.hurtStartedInSession }, now));
    }
    sections[s] = !gave[s] ? "locked" : st === "open" ? "open" : st === "editable" || st === "answered" ? "editable" : "locked";
  }
  const w: Writer = { userId: v.userId, role: "coach", source: "app", auditActor: actor(v), name: entryName(v) };
  const out = await saveAfter(
    tx,
    v.orgId,
    { settings: t.settings, raw: t.rawPost, durationMinutes: t.durationMinutes, booking: t.row.booking, session: t.row.session, personId: t.row.personId },
    { ...input, rating: null, tellCoach: false },
    w,
    { sections, rating: "closed", replacements },
    now,
  );
  await audit(tx, actor(v), replacements.length ? "checkin.coach_replace" : "checkin.coach_entry", "session_checkin", out.checkin.id, {
    summary: `After check (${out.wrote.join(", ")}) entered by coach ${entryName(v)} on behalf of ${t.athleteName}${replacements.length ? `, replacing the earlier answer for ${replacements.map((x) => x.section).join(", ")}. Reason: ${replacements[0].reason}` : ""}`,
  });
  return { checkin: out.checkin, wrote: out.wrote, replaced: replacements.map((x) => x.section), sharp: out.sharp };
}
