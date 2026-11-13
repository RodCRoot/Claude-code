import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  activitySessions,
  athleteCheckinPins,
  athletes,
  bodyRegionReports,
  bookings,
  checkinKioskPasses,
  people,
  questionnaireResponses,
  questionnaireVersions,
  scheduleSessions,
  sessionCheckins,
  sessionFeedback,
  tasks,
  users,
  type CheckinAlertReason,
  type CheckinAnsweredBy,
  type CheckinChip,
  type CheckinSection,
} from "@/db/schema";
import { UserError } from "@/lib/actions";
import { athleteCapabilities, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { EDIT_WINDOW_MS, feedbackTarget, submitFeedback } from "@/lib/retention/feedback";
import { retentionContext } from "@/lib/retention/common";
import { hashCheckInPin, PIN_PATTERN } from "@/lib/scheduling/pin-hash";
import { responsibleCoach } from "@/lib/science/access";
import { recordBodyReport } from "@/lib/science/bodymap";
import { isValidSpot } from "@/lib/science/body-regions";
import { srpeLoad } from "@/lib/science/formulas";
import { localDayBounds, localYmd, todayLocal } from "@/lib/time";
import { baselineV1, farFromBaseline } from "./baseline";
import { checkinSettings, PRE_GRACE_MINUTES, questionSetVersion, type CheckinSettings } from "./settings";

/**
 * Session check-ins: who may answer what, the windows, and the two submissions.
 *
 * WHO MAY ANSWER (decided here, enforced on every submit):
 * - the athlete: everything, for their own bookings;
 * - a parent / guardian:
 *     · "experience" (rating, likes, dislikes, notes): when they may book for the athlete
 *       (`booking.create`), any age. This is the rule the old session-feedback form used;
 *     · "effort" (session RPE): only with `training.log_at_home`, i.e. the athlete is under 13 and
 *       the link has training + booking access. Same rule as finishing an at-home session;
 *     · "body" and the whole ready check (soreness, pain, sleep, readiness: health data): the
 *       above AND `health.read` on the child. A parent who may not see health data is never
 *       shown or asked health questions;
 * - the kiosk: the ready check only, with a single-use pass issued right after that athlete's PIN;
 * - staff: nobody. Staff read; they do not answer for an athlete.
 * Nothing here sends a message to anyone.
 */

const HOUR = 3_600_000;
const sha256 = (x: string) => createHash("sha256").update(x).digest("hex");
const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
const SYSTEM = (orgId: string) => ({ orgId, actorUserId: null, actorRole: "system" });
export const REVIEW_TASK_TITLE = "Review a session check-in";
export const DISLIKE_TASK_TITLE = "Follow up on session feedback";
export const KIOSK_PASS_MINUTES = 3;
/** Next-day soreness is only asked about a session this recent. */
export const PRIOR_SESSION_MAX_DAYS = 10;

export type SectionState = "open" | "editable" | "locked" | "closed" | "not_allowed";

/** Which sections this viewer may answer for this athlete (see the header comment). */
export async function writableSections(tx: Tx, v: Viewer, athleteId: string, today: string): Promise<Set<CheckinSection>> {
  const out = new Set<CheckinSection>();
  if (v.role !== "athlete" && v.role !== "guardian") return out;
  const caps = await athleteCapabilities(tx, v, athleteId, { today });
  if (v.role === "athlete") {
    if (caps.has("health.write") && caps.has("training.log")) for (const s of ["ready", "effort", "body", "experience"] as const) out.add(s);
    return out;
  }
  if (caps.has("booking.create")) out.add("experience");
  if (caps.has("training.log_at_home")) {
    out.add("effort");
    if (caps.has("health.read")) {
      out.add("body");
      out.add("ready");
    }
  }
  return out;
}

async function loadBooking(tx: Tx, orgId: string, bookingId: string) {
  const [row] = await tx
    .select({ booking: bookings, session: scheduleSessions, first: people.firstName, preferred: people.preferredName, last: people.lastName, personId: athletes.personId, coach: users.displayName })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .innerJoin(athletes, eq(athletes.id, bookings.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(users, eq(users.id, scheduleSessions.coachUserId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.orgId, orgId)));
  return row ?? null;
}

/** Family access to a booking: the athlete or a linked guardian. Same error whether it is missing or someone else's. */
async function familyBooking(tx: Tx, v: Viewer, bookingId: string, today: string) {
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError("Session check-ins are answered by the athlete or their parent / guardian.");
  const row = await loadBooking(tx, v.orgId, bookingId);
  if (!row) throw new AuthzError();
  const caps = await athleteCapabilities(tx, v, row.booking.athleteId, { today });
  if (!caps.has("profile.read")) throw new AuthzError();
  return { ...row, caps, firstName: row.preferred ?? row.first };
}

// ---------------------------------------------------------------------------
// Windows (instants; the session's own start and end decide, so they are facility-local by construction)
// ---------------------------------------------------------------------------

export type PreWindowState = "open" | "not_open_yet" | "closed";
export function preWindow(session: { startsAt: Date }, s: CheckinSettings, now: Date): { state: PreWindowState; opensAt: Date; closesAt: Date } {
  const opensAt = new Date(session.startsAt.getTime() - s.preOpensHoursBefore * HOUR);
  const closesAt = new Date(session.startsAt.getTime() + PRE_GRACE_MINUTES * 60_000);
  return { state: now < opensAt ? "not_open_yet" : now > closesAt ? "closed" : "open", opensAt, closesAt };
}

export function postWindows(session: { endsAt: Date }, s: CheckinSettings, feedbackEntryDays: number, now: Date) {
  const opensAt = session.endsAt;
  const trainingClosesAt = new Date(session.endsAt.getTime() + s.postClosesHoursAfter * HOUR);
  const experienceClosesAt = new Date(session.endsAt.getTime() + feedbackEntryDays * 86_400_000);
  return { opensAt, trainingClosesAt, experienceClosesAt, started: now >= opensAt, trainingOpen: now >= opensAt && now <= trainingClosesAt, experienceOpen: now >= opensAt && now <= experienceClosesAt };
}

// ---------------------------------------------------------------------------
// Ready check
// ---------------------------------------------------------------------------

const PREFILL_KEYS = ["sleep_quality", "sleep_hours", "fatigue", "mood", "stress"] as const;
type PrefillKey = (typeof PREFILL_KEYS)[number];
export type Prefill = Partial<Record<PrefillKey, number>>;

/**
 * Answers the athlete already gave in today's daily wellness (facility-local date), for items
 * that are THE SAME item: same key and, for scales, the same 1 to 5 range. Nothing is converted
 * between scales, so the wellness 1 to 5 soreness never fills the 0 to 10 one here.
 */
export async function wellnessPrefill(tx: Tx, orgId: string, athleteId: string, localDate: string): Promise<Prefill> {
  const rows = await tx
    .select({ answers: questionnaireResponses.answers, questions: questionnaireVersions.questions })
    .from(questionnaireResponses)
    .innerJoin(questionnaireVersions, eq(questionnaireVersions.id, questionnaireResponses.versionId))
    .where(and(eq(questionnaireResponses.orgId, orgId), eq(questionnaireResponses.athleteId, athleteId), eq(questionnaireResponses.forDate, localDate)))
    .orderBy(desc(questionnaireResponses.submittedAt));
  const out: Prefill = {};
  for (const r of rows)
    for (const key of PREFILL_KEYS) {
      if (out[key] !== undefined) continue;
      const q = r.questions.find((x) => x.key === key);
      const val = r.answers[key];
      if (!q || typeof val !== "number") continue;
      if (key === "sleep_hours" ? q.kind === "number" && val >= 0 && val <= 24 : q.kind === "scale" && q.min === 1 && q.max === 5 && Number.isInteger(val) && val >= 1 && val <= 5) out[key] = val;
    }
  return out;
}

/** The athlete's most recent attended session before this one whose next-day soreness has not been asked yet. */
export async function priorSessionToAsk(tx: Tx, orgId: string, athleteId: string, session: { id: string; startsAt: Date }) {
  const [prev] = await tx
    .select({ bookingId: bookings.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, timezone: scheduleSessions.timezone })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.orgId, orgId),
        eq(bookings.athleteId, athleteId),
        eq(bookings.status, "attended"),
        ne(scheduleSessions.id, session.id),
        lt(scheduleSessions.endsAt, session.startsAt),
        gte(scheduleSessions.startsAt, new Date(session.startsAt.getTime() - PRIOR_SESSION_MAX_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(scheduleSessions.startsAt))
    .limit(1);
  if (!prev) return null;
  // Same local day as this session: there has been no "day after" yet.
  if (localYmd(prev.startsAt, prev.timezone) === localYmd(session.startsAt, prev.timezone)) return null;
  const [asked] = await tx
    .select({ id: sessionCheckins.id })
    .from(sessionCheckins)
    .where(and(eq(sessionCheckins.orgId, orgId), eq(sessionCheckins.priorBookingId, prev.bookingId), isNotNull(sessionCheckins.priorSoreness)));
  return asked ? null : prev;
}

export type ReadyState = "open" | "editable" | "done" | "not_open_yet" | "closed" | "disabled" | "not_booked" | "not_allowed";

/** Everything the ready-check page needs, and the gate the submit re-checks. */
export async function readyTarget(tx: Tx, v: Viewer, bookingId: string, now = new Date()) {
  const tzToday = todayLocal(undefined, now);
  const row = await familyBooking(tx, v, bookingId, tzToday);
  const settings = await checkinSettings(tx, v.orgId);
  const today = todayLocal(row.session.timezone, now);
  const sections = await writableSections(tx, v, row.booking.athleteId, today);
  const win = preWindow(row.session, settings, now);
  const [existing] = await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, bookingId), eq(sessionCheckins.phase, "pre")));
  let state: ReadyState;
  if (!sections.has("ready")) state = "not_allowed";
  else if (!settings.preEnabled) state = "disabled";
  else if (row.booking.status !== "booked" && row.booking.status !== "attended") state = "not_booked";
  else if (row.session.status === "cancelled") state = "not_booked";
  else if (existing) state = existing.answeredBy.ready?.userId === v.userId && win.state === "open" ? "editable" : "done";
  else state = win.state;
  const canWrite = state === "open" || state === "editable";
  // Health answers are only loaded for someone who may answer (they hold health access by rule).
  const prefill = canWrite ? await wellnessPrefill(tx, v.orgId, row.booking.athleteId, today) : {};
  const prior = canWrite && settings.askPriorSoreness && existing?.priorSoreness == null ? await priorSessionToAsk(tx, v.orgId, row.booking.athleteId, row.session) : null;
  const spot = canWrite && existing ? await checkinSpot(tx, existing.id) : null;
  return { ...row, settings, state, canWrite, window: win, existing: canWrite ? existing ?? null : null, done: !!existing, prefill, prior, spot, self: v.role === "athlete" };
}

async function checkinSpot(tx: Tx, checkinId: string) {
  const [r] = await tx.select().from(bodyRegionReports).where(eq(bodyRegionReports.sourceCheckinId, checkinId)).orderBy(desc(bodyRegionReports.reportedAt)).limit(1);
  return r ?? null;
}

const optInt = (min: number, max: number) => z.preprocess((x) => (x === "" || x === undefined || x === null ? null : x), z.coerce.number().int().min(min).max(max).nullable());
const bool3 = z.preprocess((x) => (x === "yes" || x === "true" || x === true ? true : x === "no" || x === "false" || x === false ? false : null), z.boolean().nullable());
const text = (max: number) => z.preprocess((x) => (typeof x === "string" && x.trim() ? x.trim() : null), z.string().max(max, `Keep it under ${max} characters`).nullable());

const spotSchema = z
  .object({
    view: z.enum(["front", "back"]),
    region: z.string().min(1).max(40),
    side: z.enum(["left", "right", "center"]),
    type: z.enum(["ache", "sharp"]),
    level: z.coerce.number().int().refine((n) => n === 3 || n === 6 || n === 9, "Choose how much it bothers you"),
  })
  .nullable();
export type SpotInput = z.infer<typeof spotSchema>;

export const readySchema = z.object({
  bookingId: z.string().uuid(),
  readiness: z.coerce.number({ message: "Choose how ready you feel" }).int().min(1, "Choose how ready you feel").max(5),
  sleepQuality: optInt(1, 5),
  sleepHours: z.preprocess((x) => (x === "" || x === undefined || x === null ? null : x), z.coerce.number().min(0).max(24).nullable()),
  soreness: z.coerce.number({ message: "Choose how sore you are" }).int().min(0).max(10),
  fatigue: optInt(1, 5),
  mood: optInt(1, 5),
  stress: optInt(1, 5),
  priorSoreness: optInt(0, 10),
  hurt: bool3,
  spot: spotSchema.optional(),
  note: text(300),
});
export type ReadyInput = z.input<typeof readySchema>;

type Writer = { userId: string | null; role: "athlete" | "guardian" | "kiosk"; source: "app" | "kiosk"; auditActor: { orgId: string; actorUserId: string | null; actorRole: string } };

function stamp(prev: CheckinAnsweredBy, section: CheckinSection, w: Writer, now: Date): CheckinAnsweredBy {
  return { ...prev, [section]: { userId: w.userId, role: w.role, at: now.toISOString() } };
}

/** Keep the body-map row for this check-in in step with the hurt answer. Returns whether the pain is sharp. */
async function syncSpot(tx: Tx, orgId: string, checkinId: string, athleteId: string, hurt: boolean | null, spot: SpotInput | undefined, w: Writer, now: Date): Promise<void> {
  const current = await checkinSpot(tx, checkinId);
  const kind = spot ? (spot.type === "sharp" ? "pain" : "soreness") : null;
  const same = current && spot && current.view === spot.view && current.region === spot.region && current.side === spot.side && current.kind === kind && current.severity === spot.level;
  if (same) return;
  if (current && current.reviewStatus === "new") {
    // Replaced or withdrawn before anyone reviewed it: close it rather than leave a stale report in the queue.
    await tx.update(bodyRegionReports).set({ reviewStatus: "reviewed", reviewedAt: now, reviewNote: "Changed by the athlete in the session check-in (auto)" }).where(eq(bodyRegionReports.id, current.id));
    if (current.reviewTaskId) await tx.update(tasks).set({ status: "cancelled" }).where(and(eq(tasks.id, current.reviewTaskId), eq(tasks.orgId, orgId), inArray(tasks.status, ["open", "in_progress"])));
  }
  if (hurt && spot && kind) {
    if (!isValidSpot(spot.view, spot.region, spot.side)) throw new UserError("Please tap the spot again.", { spot: "That spot is not valid" });
    await recordBodyReport(tx, { orgId, athleteId, view: spot.view, region: spot.region, side: spot.side, kind, severity: spot.level, note: null, reportedBy: w.userId, auditActor: w.auditActor, sourceCheckinId: checkinId }, now);
  }
}

/** Did the athlete say something hurt in the session before this one? ("pain two sessions running") */
async function hurtInPreviousSession(tx: Tx, orgId: string, athleteId: string, session: { id: string; startsAt: Date }): Promise<boolean> {
  const [prev] = await tx
    .select({ sessionId: scheduleSessions.id })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(and(eq(bookings.orgId, orgId), eq(bookings.athleteId, athleteId), eq(bookings.status, "attended"), ne(scheduleSessions.id, session.id), lt(scheduleSessions.startsAt, session.startsAt)))
    .orderBy(desc(scheduleSessions.startsAt))
    .limit(1);
  if (!prev) return false;
  const rows = await tx
    .select({ id: sessionCheckins.id })
    .from(sessionCheckins)
    .where(and(eq(sessionCheckins.orgId, orgId), eq(sessionCheckins.athleteId, athleteId), eq(sessionCheckins.sessionId, prev.sessionId), eq(sessionCheckins.hurt, true)));
  return rows.length > 0;
}

/** The athlete's earlier ready-check answers, for checkin_baseline_v1. */
export async function readyHistory(tx: Tx, orgId: string, athleteId: string, before: Date, windowDays: number) {
  return tx
    .select({ at: scheduleSessions.startsAt, readiness: sessionCheckins.readiness, soreness: sessionCheckins.soreness, sleepQuality: sessionCheckins.sleepQuality })
    .from(sessionCheckins)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, sessionCheckins.sessionId))
    .where(
      and(
        eq(sessionCheckins.orgId, orgId),
        eq(sessionCheckins.athleteId, athleteId),
        eq(sessionCheckins.phase, "pre"),
        lt(scheduleSessions.startsAt, before),
        gte(scheduleSessions.startsAt, new Date(before.getTime() - windowDays * 86_400_000)),
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt));
}

/** Create (once) the coach task for training reasons. Generic text: tasks are visible to staff without health access. */
async function ensureReviewTask(tx: Tx, orgId: string, checkin: typeof sessionCheckins.$inferSelect, personId: string, sessionCoach: string | null, now: Date) {
  if (checkin.reviewTaskId) return;
  const assignee = (await responsibleCoach(tx, orgId, checkin.athleteId)) ?? sessionCoach;
  const [task] = await tx
    .insert(tasks)
    .values({
      orgId,
      title: REVIEW_TASK_TITLE,
      description: `An athlete's check-in answers need a look before or after training. Open /check-ins/responses/${checkin.id} (details are shown to staff with health access for this athlete). Self-reported, not a diagnosis. Nothing was sent to the family.`,
      dueAt: new Date(now.getTime() + 86_400_000),
      assigneeUserId: assignee,
      relatedPersonId: personId,
      relatedType: "session_checkin",
      relatedId: checkin.id,
      priority: "high",
      source: "session_checkin",
      dedupeKey: `checkin_review:${checkin.id}`,
    })
    .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
    .returning();
  if (task) {
    await tx.update(sessionCheckins).set({ reviewTaskId: task.id }).where(eq(sessionCheckins.id, checkin.id));
    await audit(tx, SYSTEM(orgId), "task.create", "task", task.id, { summary: REVIEW_TASK_TITLE });
  }
}

const TRAINING_TASK_REASONS: CheckinAlertReason[] = ["hurt_no_location", "pain_two_sessions", "soreness_above_baseline", "readiness_below_baseline"];

async function saveReady(
  tx: Tx,
  orgId: string,
  row: NonNullable<Awaited<ReturnType<typeof loadBooking>>>,
  settings: CheckinSettings,
  input: z.infer<typeof readySchema>,
  w: Writer,
  opts: { prefill: Prefill; prior: { bookingId: string } | null; existing: typeof sessionCheckins.$inferSelect | null },
  now: Date,
) {
  // An item already answered in today's wellness is not asked again: its stored answer is used.
  const prefilled: string[] = [];
  const pick = (given: number | null, key: PrefillKey, asked: boolean): number | null => {
    if (given !== null) return given;
    if (asked && opts.prefill[key] !== undefined) {
      prefilled.push(key);
      return opts.prefill[key]!;
    }
    return null;
  };
  const sleepQuality = pick(input.sleepQuality, "sleep_quality", true);
  if (sleepQuality === null && w.source === "app") throw new UserError("Please answer the highlighted questions.", { sleepQuality: "Choose how you slept" });
  const hurt = input.hurt ?? (input.spot ? true : null);
  const values = {
    questionSetVersion: questionSetVersion(settings),
    readiness: input.readiness,
    sleepQuality,
    sleepHours: settings.askSleepHours ? pick(input.sleepHours, "sleep_hours", true) : null,
    fatigue: settings.askFatigue ? pick(input.fatigue, "fatigue", true) : null,
    mood: settings.askMood ? pick(input.mood, "mood", true) : null,
    stress: settings.askStress ? pick(input.stress, "stress", true) : null,
    soreness: input.soreness,
    hurt,
    note: input.note,
    prefilled,
    priorSoreness: opts.prior ? input.priorSoreness : (opts.existing?.priorSoreness ?? null),
    priorBookingId: opts.prior ? (input.priorSoreness !== null ? opts.prior.bookingId : null) : (opts.existing?.priorBookingId ?? null),
    loggedByParent: w.role === "guardian",
    source: w.source,
    updatedAt: now,
  };
  let checkin: typeof sessionCheckins.$inferSelect;
  if (opts.existing) {
    [checkin] = await tx
      .update(sessionCheckins)
      .set({ ...values, answeredBy: stamp(opts.existing.answeredBy, "ready", w, now) })
      .where(eq(sessionCheckins.id, opts.existing.id))
      .returning();
  } else {
    const inserted = await tx
      .insert(sessionCheckins)
      .values({ orgId, bookingId: row.booking.id, sessionId: row.session.id, athleteId: row.booking.athleteId, phase: "pre", ...values, answeredBy: stamp({}, "ready", w, now), isDemo: row.booking.isDemo, createdAt: now })
      .onConflictDoNothing({ target: [sessionCheckins.bookingId, sessionCheckins.phase] })
      .returning();
    // Lost a race (double tap, or the kiosk and a phone at once): one ready check per booking.
    if (!inserted.length) {
      const [had] = await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, row.booking.id), eq(sessionCheckins.phase, "pre")));
      return { checkin: had, created: false, reasons: had.alertReasons };
    }
    checkin = inserted[0];
  }
  await syncSpot(tx, orgId, checkin.id, row.booking.athleteId, hurt, input.spot, w, now);

  const reasons: CheckinAlertReason[] = [];
  if (hurt && input.spot?.type === "sharp") reasons.push("sharp_pain");
  if (hurt && !input.spot) reasons.push("hurt_no_location");
  if (hurt && (await hurtInPreviousSession(tx, orgId, row.booking.athleteId, row.session))) reasons.push("pain_two_sessions");
  const history = await readyHistory(tx, orgId, row.booking.athleteId, row.session.startsAt, settings.baselineWindowDays);
  const bopts = { windowDays: settings.baselineWindowDays, minAnswers: settings.baselineMinAnswers };
  if (farFromBaseline(input.soreness, baselineV1(history.map((h) => ({ at: h.at, value: h.soreness })), row.session.startsAt, bopts), settings.sorenessAboveBaseline, "above")) reasons.push("soreness_above_baseline");
  if (farFromBaseline(input.readiness, baselineV1(history.map((h) => ({ at: h.at, value: h.readiness })), row.session.startsAt, bopts), settings.readinessBelowBaseline, "below")) reasons.push("readiness_below_baseline");
  [checkin] = await tx.update(sessionCheckins).set({ alertReasons: reasons }).where(eq(sessionCheckins.id, checkin.id)).returning();
  if (reasons.some((r) => TRAINING_TASK_REASONS.includes(r))) await ensureReviewTask(tx, orgId, checkin, row.personId, row.session.coachUserId, now);
  // The audit trail records that a check-in happened, never the health answers.
  await audit(tx, w.auditActor, opts.existing ? "checkin.ready_update" : "checkin.ready_submit", "session_checkin", checkin.id, {
    summary: `Ready check ${opts.existing ? "updated" : "submitted"}${w.source === "kiosk" ? " at the kiosk" : w.role === "guardian" ? " by a parent / guardian" : ""}`,
  });
  return { checkin, created: !opts.existing, reasons };
}

/** Submit (or, while the window is open, correct) the ready check from the app. */
export async function submitReady(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  const input = readySchema.parse(raw);
  const t = await readyTarget(tx, v, input.bookingId, now);
  if (!t.canWrite) throw t.state === "not_allowed" ? new AuthzError(READY_STATE_TEXT.not_allowed) : new UserError(READY_STATE_TEXT[t.state as Exclude<ReadyState, "open" | "editable">]);
  const w: Writer = { userId: v.userId, role: v.role === "guardian" ? "guardian" : "athlete", source: "app", auditActor: actor(v) };
  return saveReady(tx, v.orgId, t, t.settings, input, w, { prefill: t.prefill, prior: t.prior, existing: t.existing }, now);
}

export const READY_STATE_TEXT: Record<Exclude<ReadyState, "open" | "editable">, string> = {
  done: "The ready check for this session is already done.",
  not_open_yet: "The ready check opens a few hours before the session.",
  closed: "The ready check for this session has closed.",
  disabled: "Ready checks are turned off.",
  not_booked: "The ready check is for a booked session.",
  not_allowed: "The ready check has health questions, so it is answered by the athlete (or by a parent with health access, for athletes under 13).",
};

// ---------------------------------------------------------------------------
// Kiosk
// ---------------------------------------------------------------------------

/**
 * Called by the kiosk action right after a PIN matched: if that athlete has a booking today whose
 * ready-check window is open and not answered yet, mint a single-use pass for it. Returns only a
 * token and the session title; nothing about earlier answers ever reaches the kiosk.
 */
export async function issueKioskReadyPass(tx: Tx, v: Viewer, input: { pin: string; now?: Date }): Promise<{ token: string; sessionTitle: string; expiresInSeconds: number } | null> {
  if (!can(v, "schedule.checkin")) throw new AuthzError();
  const now = input.now ?? new Date();
  const pin = input.pin.trim();
  if (!PIN_PATTERN.test(pin)) return null;
  const settings = await checkinSettings(tx, v.orgId);
  if (!settings.preEnabled || !settings.kioskOffer) return null;
  const [match] = await tx
    .select({ athleteId: athleteCheckinPins.athleteId })
    .from(athleteCheckinPins)
    .innerJoin(athletes, eq(athletes.id, athleteCheckinPins.athleteId))
    .where(and(eq(athleteCheckinPins.orgId, v.orgId), eq(athleteCheckinPins.pinHash, hashCheckInPin(v.orgId, pin)), eq(athletes.active, true)));
  if (!match) return null;
  const todays = await tx
    .select({ bookingId: bookings.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, timezone: scheduleSessions.timezone })
    .from(bookings)
    .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.orgId, v.orgId),
        eq(bookings.athleteId, match.athleteId),
        eq(bookings.status, "attended"),
        ne(scheduleSessions.status, "cancelled"),
        gte(scheduleSessions.startsAt, new Date(now.getTime() - 12 * HOUR)),
        lt(scheduleSessions.startsAt, new Date(now.getTime() + 24 * HOUR)),
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt));
  for (const b of todays) {
    if (preWindow(b, settings, now).state !== "open") continue;
    const { start, end } = localDayBounds(todayLocal(b.timezone, now), b.timezone);
    if (b.startsAt < start || b.startsAt >= end) continue;
    const [done] = await tx.select({ id: sessionCheckins.id }).from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, b.bookingId), eq(sessionCheckins.phase, "pre")));
    if (done) continue;
    const token = randomBytes(24).toString("base64url");
    await tx.insert(checkinKioskPasses).values({ orgId: v.orgId, tokenHash: sha256(token), bookingId: b.bookingId, athleteId: match.athleteId, expiresAt: new Date(now.getTime() + KIOSK_PASS_MINUTES * 60_000) });
    return { token, sessionTitle: b.title, expiresInSeconds: KIOSK_PASS_MINUTES * 60 };
  }
  return null;
}

export const kioskReadySchema = z.object({
  token: z.string().min(10).max(200),
  readiness: z.coerce.number().int().min(1).max(5),
  sleepQuality: optInt(1, 5),
  soreness: z.coerce.number().int().min(0).max(10),
  hurt: bool3,
});

/** Redeem a kiosk pass. The pass is burned whether or not anything else is wrong with the request. */
export async function submitKioskReady(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  if (!can(v, "schedule.checkin")) throw new AuthzError();
  const input = kioskReadySchema.parse(raw);
  const [pass] = await tx
    .select()
    .from(checkinKioskPasses)
    .where(and(eq(checkinKioskPasses.tokenHash, sha256(input.token)), eq(checkinKioskPasses.orgId, v.orgId)))
    .for("update");
  if (!pass || pass.usedAt || pass.expiresAt < now) throw new UserError("That took a little too long. Please check in again, or do the ready check on your phone.");
  await tx.update(checkinKioskPasses).set({ usedAt: now }).where(eq(checkinKioskPasses.id, pass.id));
  const row = await loadBooking(tx, v.orgId, pass.bookingId);
  if (!row) throw new UserError("Please see the front desk.");
  const settings = await checkinSettings(tx, v.orgId);
  if (!settings.preEnabled || !settings.kioskOffer || preWindow(row.session, settings, now).state !== "open") throw new UserError("The ready check for this session has closed.");
  const w: Writer = { userId: null, role: "kiosk", source: "kiosk", auditActor: actor(v) };
  const full = readySchema.parse({ bookingId: pass.bookingId, readiness: input.readiness, sleepQuality: input.sleepQuality, soreness: input.soreness, hurt: input.hurt });
  // No prefill, no prior-session question and no existing answers at the kiosk: it reads nothing back.
  const r = await saveReady(tx, v.orgId, row, settings, full, w, { prefill: {}, prior: null, existing: null }, now);
  return { created: r.created, hurt: full.hurt === true };
}

// ---------------------------------------------------------------------------
// After check
// ---------------------------------------------------------------------------

export type AfterState = "open" | "not_attended" | "not_ended" | "disabled" | "nothing_open";

function sectionState(section: CheckinSection, allowed: Set<CheckinSection>, answeredBy: CheckinAnsweredBy, v: Viewer, windowOpen: boolean, now: Date, editMs: number | null): SectionState {
  if (!allowed.has(section)) return "not_allowed";
  const a = answeredBy[section];
  if (!a) return windowOpen ? "open" : "closed";
  if (a.userId !== v.userId || !windowOpen) return "locked";
  if (editMs !== null && now.getTime() - new Date(a.at).getTime() > editMs) return "locked";
  return "editable";
}

/** Everything the after-check page needs, and the gate the submit re-checks. */
export async function afterTarget(tx: Tx, v: Viewer, bookingId: string, now = new Date()) {
  const row = await familyBooking(tx, v, bookingId, todayLocal(undefined, now));
  const settings = await checkinSettings(tx, v.orgId);
  const { settings: retention } = await retentionContext(tx, v.orgId);
  const today = todayLocal(row.session.timezone, now);
  const allowed = await writableSections(tx, v, row.booking.athleteId, today);
  const win = postWindows(row.session, settings, retention.feedbackEntryDays, now);
  const [existing] = await tx.select().from(sessionCheckins).where(and(eq(sessionCheckins.bookingId, bookingId), eq(sessionCheckins.phase, "post")));
  const [feedback] = await tx.select().from(sessionFeedback).where(eq(sessionFeedback.bookingId, bookingId));
  const by = existing?.answeredBy ?? {};
  const sections: Record<"effort" | "body" | "experience", SectionState> = {
    effort: sectionState("effort", allowed, by, v, win.trainingOpen, now, null),
    body: sectionState("body", allowed, by, v, win.trainingOpen, now, null),
    experience: sectionState("experience", allowed, by, v, win.experienceOpen, now, EDIT_WINDOW_MS),
  };
  // The 1 to 5 rating lives in session_feedback and keeps its own rule (one per booking, 24 hours to change).
  let rating: "open" | "editable" | "locked" | "closed" = "closed";
  if (allowed.has("experience") && row.booking.status === "attended" && win.started) {
    if (feedback) rating = feedback.submittedByUserId === v.userId && now.getTime() - feedback.createdAt.getTime() <= EDIT_WINDOW_MS ? "editable" : "locked";
    else rating = win.experienceOpen ? "open" : "closed";
  }
  const writable = (s: SectionState) => s === "open" || s === "editable";
  let state: AfterState;
  if (!settings.postEnabled) state = "disabled";
  else if (row.booking.status !== "attended") state = "not_attended";
  else if (!win.started) state = "not_ended";
  else state = Object.values(sections).some(writable) || rating === "open" || rating === "editable" ? "open" : "nothing_open";
  const mayBody = allowed.has("body");
  const safeExisting = existing
    ? {
        id: existing.id,
        rpe: allowed.has("effort") ? existing.rpe : null,
        soreness: mayBody ? existing.soreness : null,
        hurt: mayBody ? existing.hurt : null,
        hurtStartedInSession: mayBody ? existing.hurtStartedInSession : null,
        likedChips: existing.likedChips,
        likedText: existing.likedText,
        dislikedChips: existing.dislikedChips,
        dislikedText: existing.dislikedText,
        nothingToChange: existing.nothingToChange,
        note: existing.note,
        tellCoach: existing.tellCoach,
        answeredBy: existing.answeredBy,
      }
    : null;
  const spot = existing && mayBody && writable(sections.body) ? await checkinSpot(tx, existing.id) : null;
  return {
    ...row,
    settings,
    retention,
    state,
    sections,
    rating,
    window: win,
    existing: safeExisting,
    raw: existing ?? null,
    feedback: feedback && allowed.has("experience") ? { rating: feedback.rating, tellCoach: feedback.tellCoach, mine: feedback.submittedByUserId === v.userId } : null,
    spot,
    self: v.role === "athlete",
    durationMinutes: Math.max(1, Math.round((row.session.endsAt.getTime() - row.session.startsAt.getTime()) / 60_000)),
  };
}

export const AFTER_STATE_TEXT: Record<Exclude<AfterState, "open">, string> = {
  not_attended: "The after check opens once the athlete has been checked in to the session.",
  not_ended: "The after check opens when the session ends.",
  disabled: "After checks are turned off.",
  nothing_open: "This after check is complete, or its window has closed. You can always message the front desk.",
};

const chipKeys = z.preprocess((x) => (Array.isArray(x) ? x : typeof x === "string" && x ? [x] : []), z.array(z.string().max(40)).max(12));

export const afterSchema = z.object({
  bookingId: z.string().uuid(),
  rpe: optInt(0, 10),
  liked: chipKeys,
  likedText: text(300),
  disliked: chipKeys,
  dislikedText: text(500),
  nothingToChange: z.preprocess((x) => x === true || x === "on" || x === "true", z.boolean()),
  hurt: bool3,
  spot: spotSchema.optional(),
  hurtStartedInSession: bool3,
  soreness: optInt(0, 10),
  rating: optInt(1, 5),
  note: text(1000),
  tellCoach: z.preprocess((x) => x === true || x === "on" || x === "true", z.boolean()),
});
export type AfterInput = z.input<typeof afterSchema>;

/**
 * The session's sRPE load row (srpe_load_v1 = scheduled minutes × session RPE). ONE row per
 * check-in, updated in place on a correction, so re-submitting never adds load twice. See
 * `loadEntries` in src/lib/science/load.ts for how it is kept from double counting with a
 * workout logged in the workout logger on the same day.
 */
async function syncLoadRow(tx: Tx, orgId: string, checkin: typeof sessionCheckins.$inferSelect, session: { startsAt: Date; timezone: string; title: string }, w: Writer): Promise<string | null> {
  if (checkin.rpe === null || checkin.durationMinutes === null) return checkin.activitySessionId;
  const values = { durationMinutes: checkin.durationMinutes, sessionRpe: checkin.rpe, activityDate: localYmd(session.startsAt, session.timezone) };
  if (checkin.activitySessionId) {
    const upd = await tx.update(activitySessions).set(values).where(and(eq(activitySessions.id, checkin.activitySessionId), eq(activitySessions.orgId, orgId))).returning({ id: activitySessions.id });
    if (upd.length) return checkin.activitySessionId;
  }
  const [row] = await tx
    .insert(activitySessions)
    .values({ orgId, athleteId: checkin.athleteId, kind: "training", ...values, notes: `Session check-in: ${session.title}`.slice(0, 300), enteredBy: w.userId, source: "session_checkin", isDemo: checkin.isDemo })
    .returning({ id: activitySessions.id });
  await tx.update(sessionCheckins).set({ activitySessionId: row.id }).where(eq(sessionCheckins.id, checkin.id));
  return row.id;
}

async function firstOwner(tx: Tx, orgId: string): Promise<string | null> {
  const [o] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, "owner"), sql`${users.disabledAt} is null`))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return o?.id ?? null;
}

/** Submit, complete or correct the after check. Each section is written only if this viewer may write it now. */
export async function submitAfter(tx: Tx, v: Viewer, raw: unknown, now = new Date()) {
  const input = afterSchema.parse(raw);
  const t = await afterTarget(tx, v, input.bookingId, now);
  if (t.state !== "open") throw new UserError(AFTER_STATE_TEXT[t.state]);
  const can_ = (s: "effort" | "body" | "experience") => t.sections[s] === "open" || t.sections[s] === "editable";
  if (can_("effort") && input.rpe === null && t.sections.effort === "open") throw new UserError("Please answer the highlighted questions.", { rpe: "Choose how hard it was" });
  const w: Writer = { userId: v.userId, role: v.role === "guardian" ? "guardian" : "athlete", source: "app", auditActor: actor(v) };

  const set: Partial<typeof sessionCheckins.$inferInsert> = { questionSetVersion: questionSetVersion(t.settings), updatedAt: now };
  let answeredBy: CheckinAnsweredBy = t.raw?.answeredBy ?? {};
  const wrote: CheckinSection[] = [];
  if (can_("effort") && input.rpe !== null) {
    set.rpe = input.rpe;
    set.durationMinutes = t.durationMinutes;
    answeredBy = stamp(answeredBy, "effort", w, now);
    wrote.push("effort");
  }
  const hurt = input.hurt ?? (input.spot ? true : null);
  if (can_("body") && (hurt !== null || input.soreness !== null)) {
    set.hurt = hurt;
    set.soreness = input.soreness;
    set.hurtStartedInSession = hurt ? input.hurtStartedInSession : null;
    answeredBy = stamp(answeredBy, "body", w, now);
    wrote.push("body");
  }
  const pickChips = (keys: string[], defs: CheckinChip[], had: CheckinChip[]): CheckinChip[] => {
    // Keep the label as it read when tapped; a chip removed from Settings since stays on an edit.
    const known = new Map([...had, ...defs].map((c) => [c.key, c]));
    return [...new Set(keys)].map((k) => known.get(k)).filter((c): c is CheckinChip => !!c).map((c) => ({ key: c.key, label: c.label }));
  };
  const hasExperience = input.liked.length > 0 || input.disliked.length > 0 || !!input.likedText || !!input.dislikedText || input.nothingToChange || !!input.note || input.rating !== null;
  if (can_("experience") && (hasExperience || t.sections.experience === "editable")) {
    set.likedChips = pickChips(input.liked, t.settings.likedChips, t.raw?.likedChips ?? []);
    set.likedText = input.likedText;
    set.dislikedChips = input.nothingToChange ? [] : pickChips(input.disliked, t.settings.dislikedChips, t.raw?.dislikedChips ?? []);
    set.dislikedText = input.nothingToChange ? null : input.dislikedText;
    set.nothingToChange = input.nothingToChange ? true : input.disliked.length || input.dislikedText ? false : null;
    set.note = input.note;
    set.tellCoach = input.tellCoach;
    answeredBy = stamp(answeredBy, "experience", w, now);
    wrote.push("experience");
  }
  const ratingWritable = (t.rating === "open" || t.rating === "editable") && input.rating !== null;
  if (!wrote.length && !ratingWritable) throw new UserError("There is nothing to save yet. Answer at least one question.");
  if (v.role === "guardian" && wrote.length) set.loggedByParent = true;
  set.answeredBy = answeredBy;

  let checkin: typeof sessionCheckins.$inferSelect;
  if (t.raw) {
    [checkin] = await tx.update(sessionCheckins).set(set).where(eq(sessionCheckins.id, t.raw.id)).returning();
  } else {
    [checkin] = await tx
      .insert(sessionCheckins)
      .values({ orgId: v.orgId, bookingId: t.booking.id, sessionId: t.session.id, athleteId: t.booking.athleteId, phase: "post", questionSetVersion: questionSetVersion(t.settings), ...set, isDemo: t.booking.isDemo, createdAt: now })
      .onConflictDoUpdate({ target: [sessionCheckins.bookingId, sessionCheckins.phase], set })
      .returning();
  }
  if (wrote.includes("effort")) await syncLoadRow(tx, v.orgId, checkin, t.session, w);
  if (wrote.includes("body")) await syncSpot(tx, v.orgId, checkin.id, checkin.athleteId, hurt, input.spot, w, now);
  // Rating: the existing session-feedback path, so its history, radar signal and low-rating task keep working.
  let feedbackId: string | null = null;
  if (ratingWritable) {
    const ft = await feedbackTarget(tx, v, input.bookingId, now);
    if (ft.state === "open" || ft.state === "editable") feedbackId = (await submitFeedback(tx, v, { bookingId: input.bookingId, rating: input.rating, comment: input.note ?? undefined, tellCoach: input.tellCoach }, now)).id;
  }

  const reasons = new Set<CheckinAlertReason>(checkin.alertReasons);
  if (wrote.includes("body")) {
    for (const r of ["sharp_pain", "hurt_no_location", "pain_two_sessions"] as const) reasons.delete(r);
    if (hurt && input.spot?.type === "sharp") reasons.add("sharp_pain");
    if (hurt && !input.spot) reasons.add("hurt_no_location");
    if (hurt) {
      // "Two sessions running" compares with the session before, not with this session's own ready check.
      if (await hurtInPreviousSession(tx, v.orgId, checkin.athleteId, t.session)) reasons.add("pain_two_sessions");
    }
  }
  if (wrote.includes("experience")) {
    reasons.delete("disliked_comment");
    if (checkin.dislikedText) reasons.add("disliked_comment");
  }
  [checkin] = await tx.update(sessionCheckins).set({ alertReasons: [...reasons] }).where(eq(sessionCheckins.id, checkin.id)).returning();
  if ([...reasons].some((r) => TRAINING_TASK_REASONS.includes(r))) await ensureReviewTask(tx, v.orgId, checkin, t.personId, t.session.coachUserId, now);
  if (reasons.has("disliked_comment") && !checkin.experienceTaskId) {
    // Same routing as a low rating: to the coach only when the family chose to share, otherwise to the owner and not linked to the athlete.
    const shared = checkin.tellCoach && !!t.session.coachUserId;
    const [task] = await tx
      .insert(tasks)
      .values({
        orgId: v.orgId,
        title: DISLIKE_TASK_TITLE,
        description: `Someone said there was something they did not like or wanted changed after a session. Open /check-ins/responses/${checkin.id} to read it (visible to roles allowed). Nothing was sent to the family.`,
        dueAt: new Date(now.getTime() + 2 * 86_400_000),
        assigneeUserId: shared ? t.session.coachUserId : await firstOwner(tx, v.orgId),
        relatedPersonId: shared ? t.personId : null,
        relatedType: "session_checkin",
        relatedId: checkin.id,
        priority: "normal",
        source: "session_checkin",
        dedupeKey: `checkin_dislike:${checkin.id}`,
      })
      .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
      .returning();
    if (task) {
      [checkin] = await tx.update(sessionCheckins).set({ experienceTaskId: task.id }).where(eq(sessionCheckins.id, checkin.id)).returning();
      await audit(tx, SYSTEM(v.orgId), "task.create", "task", task.id, { summary: DISLIKE_TASK_TITLE });
    }
  }
  await audit(tx, actor(v), t.raw ? "checkin.after_update" : "checkin.after_submit", "session_checkin", checkin.id, {
    summary: `After check ${t.raw ? "updated" : "submitted"}: ${[...wrote, ...(feedbackId ? ["rating"] : [])].join(", ")}${v.role === "guardian" ? " (by a parent / guardian)" : ""}`,
  });
  return { checkin, wrote, feedbackId, load: wrote.includes("effort") ? srpeLoad(checkin.durationMinutes, checkin.rpe) : null, sharp: reasons.has("sharp_pain") };
}
