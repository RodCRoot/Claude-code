import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { SEASON_EVENT_KINDS, activitySessions, anywhereSeasonEvents, anywhereSeasons, anywhereSportLogs, athletes, type SeasonEventKind } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { seriesOccurrences } from "@/lib/scheduling/recurrence";
import { addDaysYmd, daysBetween, isoWeekday, localYmd, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { actorOf, anywhereAccess, EVENT_KIND_LABEL, optText, orgAnywhere, ymd } from "./common";

export type Season = typeof anywhereSeasons.$inferSelect;
export type SeasonEvent = typeof anywhereSeasonEvents.$inferSelect;

const MAX_SEASON_DAYS = 400;
const MAX_EVENTS_PER_SEASON = 300;

export const seasonInput = z
  .object({
    athleteId: z.string().uuid(),
    teamName: z.string().trim().min(1, "Add the team name").max(80),
    sport: z.string().trim().min(1, "Add the sport").max(40),
    startsOn: ymd,
    endsOn: ymd,
  })
  .refine((x) => x.endsOn >= x.startsOn, { message: "The season must end on or after its start date", path: ["endsOn"] })
  .refine((x) => daysBetween(x.startsOn, x.endsOn) <= MAX_SEASON_DAYS, { message: "A season can be up to 400 days long", path: ["endsOn"] });

async function requireSeasonEdit(tx: Tx, v: Viewer, athleteId: string) {
  const access = await anywhereAccess(tx, v, athleteId);
  if (!access?.canEditSeason) throw new AuthzError();
  return access;
}

async function seasonForEdit(tx: Tx, v: Viewer, seasonId: string): Promise<Season> {
  const [s] = await tx.select().from(anywhereSeasons).where(and(eq(anywhereSeasons.id, seasonId), eq(anywhereSeasons.orgId, v.orgId)));
  if (!s) throw new AuthzError("Season not found.");
  await requireSeasonEdit(tx, v, s.athleteId);
  return s;
}

export async function createSeason(tx: Tx, v: Viewer, raw: unknown): Promise<Season> {
  const input = seasonInput.parse(raw);
  await requireSeasonEdit(tx, v, input.athleteId);
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(eq(athletes.id, input.athleteId));
  const [s] = await tx.insert(anywhereSeasons).values({ orgId: v.orgId, ...input, createdBy: v.userId, isDemo: a?.isDemo ?? false }).returning();
  await audit(tx, actorOf(v), "anywhere.season.create", "anywhere_season", s.id, { summary: `Added season ${s.teamName} (${s.sport})`, after: input });
  return s;
}

export async function deleteSeason(tx: Tx, v: Viewer, seasonId: string): Promise<Season> {
  const s = await seasonForEdit(tx, v, seasonId);
  // Logged practices and games keep their load rows; they just lose the link to the event.
  await tx.delete(anywhereSeasons).where(eq(anywhereSeasons.id, s.id));
  await audit(tx, actorOf(v), "anywhere.season.delete", "anywhere_season", s.id, { summary: `Removed season ${s.teamName}`, before: s });
  return s;
}

const hhmm = z.preprocess((x) => (x === "" || x == null ? null : x), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 16:30").nullable());

export const eventInput = z
  .object({
    seasonId: z.string().uuid(),
    kind: z.enum(SEASON_EVENT_KINDS),
    title: optText(80),
    opponent: optText(80),
    location: optText(120),
    repeat: z.enum(["once", "weekly"]).default("once"),
    date: z.preprocess((x) => (x === "" || x == null ? null : x), ymd.nullable()).optional(),
    weekdays: z.preprocess((x) => (x == null || x === "" ? [] : Array.isArray(x) ? x : [x]), z.array(z.coerce.number().int().min(1).max(7)).max(7)),
    startTime: hhmm.optional(),
    durationMinutes: z.preprocess((x) => (x === "" || x == null ? null : x), z.coerce.number().int().min(5).max(720).nullable()).optional(),
  })
  .refine((x) => x.repeat === "weekly" || !!x.date, { message: "Choose a date", path: ["date"] })
  .refine((x) => x.repeat === "once" || x.weekdays.length > 0, { message: "Choose at least one day of the week", path: ["weekdays"] });

/** Add a one-off event, or a weekly one that repeats for the rest of the season. */
export async function addEvent(tx: Tx, v: Viewer, raw: unknown): Promise<SeasonEvent> {
  const input = eventInput.parse(raw);
  const season = await seasonForEdit(tx, v, input.seasonId);
  const { tz } = await orgAnywhere(tx, v.orgId);
  const weekly = input.repeat === "weekly";
  const startsOn = weekly ? (input.date && input.date > season.startsOn ? input.date : season.startsOn) : input.date!;
  const endsOn = weekly ? season.endsOn : input.date!;
  if (startsOn < season.startsOn || endsOn > season.endsOn || startsOn > endsOn) throw new UserError(`Pick a date inside the season (${season.startsOn} to ${season.endsOn}).`, { date: "Outside the season" });
  const existing = await tx.select({ id: anywhereSeasonEvents.id }).from(anywhereSeasonEvents).where(eq(anywhereSeasonEvents.seasonId, season.id));
  if (existing.length >= MAX_EVENTS_PER_SEASON) throw new UserError("This season already has the most events it can hold.");
  const [e] = await tx
    .insert(anywhereSeasonEvents)
    .values({
      orgId: v.orgId,
      seasonId: season.id,
      athleteId: season.athleteId,
      kind: input.kind,
      title: input.title ?? null,
      opponent: input.opponent ?? null,
      location: input.location ?? null,
      weekdays: weekly ? [...new Set(input.weekdays)].sort() : null,
      startsOn,
      endsOn,
      startTimeLocal: input.startTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      timezone: tz,
      createdBy: v.userId,
      isDemo: season.isDemo,
    })
    .returning();
  await audit(tx, actorOf(v), "anywhere.season.event_add", "anywhere_season_event", e.id, { summary: `Added ${weekly ? "weekly " : ""}${EVENT_KIND_LABEL[e.kind].toLowerCase()} to ${season.teamName}` });
  return e;
}

/** Remove a whole event, or (with `date`) one day of a weekly event. */
export async function removeEvent(tx: Tx, v: Viewer, eventId: string, date?: string | null): Promise<Season> {
  const [e] = await tx.select().from(anywhereSeasonEvents).where(and(eq(anywhereSeasonEvents.id, eventId), eq(anywhereSeasonEvents.orgId, v.orgId)));
  if (!e) throw new AuthzError("Event not found.");
  const season = await seasonForEdit(tx, v, e.seasonId);
  if (date && e.weekdays) {
    if (!ymd.safeParse(date).success) throw new UserError("Use a valid date.");
    await tx.update(anywhereSeasonEvents).set({ skipDates: [...new Set([...e.skipDates, date])].sort().slice(-200) }).where(eq(anywhereSeasonEvents.id, e.id));
  } else {
    await tx.delete(anywhereSeasonEvents).where(eq(anywhereSeasonEvents.id, e.id));
  }
  await audit(tx, actorOf(v), "anywhere.season.event_remove", "anywhere_season_event", e.id, { summary: `Removed ${EVENT_KIND_LABEL[e.kind].toLowerCase()}${date && e.weekdays ? ` on ${date}` : ""} from ${season.teamName}` });
  return season;
}

export type Occurrence = {
  eventId: string;
  seasonId: string;
  kind: SeasonEventKind;
  title: string | null;
  opponent: string | null;
  location: string | null;
  /** Local calendar date in the event's timezone. */
  date: string;
  /** Null when the family gave no time. */
  startsAt: Date | null;
  endsAt: Date | null;
  durationMinutes: number | null;
  weekly: boolean;
};

type EventShape = Pick<SeasonEvent, "id" | "seasonId" | "kind" | "title" | "opponent" | "location" | "weekdays" | "startsOn" | "endsOn" | "startTimeLocal" | "durationMinutes" | "timezone" | "skipDates">;

/**
 * Pure: the occurrences of one event between two local dates (inclusive). Timed events go through
 * the scheduling module's `seriesOccurrences`, so each occurrence is converted from local date and
 * time on its own and a 4:00 PM practice stays 4:00 PM on both sides of a DST change.
 */
export function eventOccurrences(e: EventShape, fromYmd: string, toYmd: string): Occurrence[] {
  const weekdays = e.weekdays ?? [isoWeekday(e.startsOn)];
  const skip = new Set(e.skipDates);
  const base = { eventId: e.id, seasonId: e.seasonId, kind: e.kind, title: e.title, opponent: e.opponent, location: e.location, durationMinutes: e.durationMinutes, weekly: !!e.weekdays };
  if (e.startTimeLocal) {
    return seriesOccurrences({ weekdays, startTimeLocal: e.startTimeLocal, durationMinutes: e.durationMinutes ?? 0, timezone: e.timezone, startsOn: e.startsOn, endsOn: e.endsOn }, fromYmd, toYmd)
      .filter((o) => !skip.has(o.date))
      .map((o) => ({ ...base, date: o.date, startsAt: o.startsAt, endsAt: e.durationMinutes ? o.endsAt : null }));
  }
  const out: Occurrence[] = [];
  const start = e.startsOn > fromYmd ? e.startsOn : fromYmd;
  const end = e.endsOn < toYmd ? e.endsOn : toYmd;
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) if (weekdays.includes(isoWeekday(d)) && !skip.has(d)) out.push({ ...base, date: d, startsAt: null, endsAt: null });
  return out;
}

export const sortOccurrences = (list: Occurrence[]) =>
  [...list].sort((a, b) => a.date.localeCompare(b.date) || (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0) || a.eventId.localeCompare(b.eventId));

export type SeasonView = Season & { events: SeasonEvent[] };

/** Seasons (newest first) with their events. Needs profile.read on the athlete. */
export async function seasonsForAthlete(tx: Tx, v: Viewer, athleteId: string): Promise<SeasonView[]> {
  const access = await anywhereAccess(tx, v, athleteId);
  if (!access?.canSeeSeason) throw new AuthzError();
  const seasons = await tx.select().from(anywhereSeasons).where(and(eq(anywhereSeasons.orgId, v.orgId), eq(anywhereSeasons.athleteId, athleteId))).orderBy(desc(anywhereSeasons.endsOn));
  if (!seasons.length) return [];
  const events = await tx.select().from(anywhereSeasonEvents).where(inArray(anywhereSeasonEvents.seasonId, seasons.map((s) => s.id))).orderBy(asc(anywhereSeasonEvents.startsOn), asc(anywhereSeasonEvents.startTimeLocal));
  return seasons.map((s) => ({ ...s, events: events.filter((e) => e.seasonId === s.id) }));
}

export type SportLogView = { durationMinutes: number | null; rpe: number | null };
export type CalendarItem = Occurrence & {
  teamName: string;
  /** Can this occurrence take a duration + RPE log (practice, game, tournament)? */
  loggable: boolean;
  /** undefined = the viewer may not see load data; null = not logged; otherwise the log. */
  log: SportLogView | null | undefined;
};

/** Every occurrence for one athlete between two local dates, with log status the viewer may see. */
export async function calendarForAthlete(tx: Tx, v: Viewer, athleteId: string, fromYmd: string, toYmd: string): Promise<CalendarItem[]> {
  const access = await anywhereAccess(tx, v, athleteId);
  if (!access?.canSeeSeason) throw new AuthzError();
  const rows = await tx
    .select({ e: anywhereSeasonEvents, team: anywhereSeasons.teamName })
    .from(anywhereSeasonEvents)
    .innerJoin(anywhereSeasons, eq(anywhereSeasons.id, anywhereSeasonEvents.seasonId))
    .where(and(eq(anywhereSeasonEvents.orgId, v.orgId), eq(anywhereSeasonEvents.athleteId, athleteId), lte(anywhereSeasonEvents.startsOn, toYmd), gte(anywhereSeasonEvents.endsOn, fromYmd)));
  const teams = new Map(rows.map((r) => [r.e.id, r.team]));
  const occ = sortOccurrences(rows.flatMap((r) => eventOccurrences(r.e, fromYmd, toYmd)));
  const logs = new Map<string, SportLogView>();
  if (access.canSeeTraining && occ.length) {
    const lr = await tx
      .select({ eventId: anywhereSportLogs.eventId, date: anywhereSportLogs.occurrenceDate, min: activitySessions.durationMinutes, rpe: activitySessions.sessionRpe })
      .from(anywhereSportLogs)
      .innerJoin(activitySessions, eq(activitySessions.id, anywhereSportLogs.activitySessionId))
      .where(and(eq(anywhereSportLogs.orgId, v.orgId), eq(anywhereSportLogs.athleteId, athleteId), gte(anywhereSportLogs.occurrenceDate, fromYmd), lte(anywhereSportLogs.occurrenceDate, toYmd)));
    for (const l of lr) if (l.eventId) logs.set(`${l.eventId}:${l.date}`, { durationMinutes: l.min, rpe: l.rpe });
  }
  return occ.map((o) => ({ ...o, teamName: teams.get(o.eventId) ?? "", loggable: LOGGABLE.includes(o.kind), log: access.canSeeTraining ? logs.get(`${o.eventId}:${o.date}`) ?? null : undefined }));
}

const LOGGABLE: SeasonEventKind[] = ["practice", "game", "tournament"];

/** The season that covers `today`, if any (the one ending soonest when seasons overlap). */
export async function activeSeason(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()): Promise<Season | null> {
  const access = await anywhereAccess(tx, v, athleteId, today);
  if (!access?.canSeeSeason) throw new AuthzError();
  const [s] = await tx
    .select()
    .from(anywhereSeasons)
    .where(and(eq(anywhereSeasons.orgId, v.orgId), eq(anywhereSeasons.athleteId, athleteId), lte(anywhereSeasons.startsOn, today), gte(anywhereSeasons.endsOn, today)))
    .orderBy(asc(anywhereSeasons.endsOn))
    .limit(1);
  return s ?? null;
}

export const sportLogInput = z.object({
  athleteId: z.string().uuid(),
  eventId: z.preprocess((x) => (x === "" || x == null ? null : x), z.string().uuid().nullable()).optional(),
  occurrenceDate: ymd,
  /** Only used without an event. */
  kind: z.enum(["practice", "game"]).optional(),
  durationMinutes: z.coerce.number({ message: "Enter the minutes" }).int("Whole minutes").min(1, "Enter the minutes").max(600),
  rpe: z.coerce.number({ message: "Choose how hard it felt" }).int().min(0).max(10),
  /** Only used without an event: made once per form so a double submit cannot log twice. */
  clientKey: z.preprocess((x) => (x === "" || x == null ? undefined : x), z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_:-]+$/).optional()),
});

export type SportLogResult = { status: "applied" | "updated" | "duplicate"; activitySessionId: string; load: number };

/**
 * Log duration + RPE for an outside practice or game. Writes ONE activity_sessions row with
 * source "sport" (srpe_load_v1 = minutes x RPE), which the existing load and ACWR views read.
 * Same access as existing load logging (training.log). Logging again for the same event day
 * updates that row. Days nobody logs stay unknown: nothing here ever writes a zero.
 */
export async function logSport(tx: Tx, v: Viewer, raw: unknown, now = new Date()): Promise<SportLogResult> {
  const input = sportLogInput.parse(raw);
  const { tz } = await orgAnywhere(tx, v.orgId);
  const today = localYmd(now, tz);
  const access = await anywhereAccess(tx, v, input.athleteId, today);
  if (!access?.canLog) throw new AuthzError();
  if (input.occurrenceDate > today) throw new UserError("You can log it once it has happened.");
  if (input.occurrenceDate < addDaysYmd(today, -30)) throw new UserError("Sessions can be logged for up to 30 days back.");
  const load = input.durationMinutes * input.rpe;
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(eq(athletes.id, input.athleteId));

  let kind: "practice" | "game";
  let label: string;
  let key: string;
  if (input.eventId) {
    const [e] = await tx.select().from(anywhereSeasonEvents).where(and(eq(anywhereSeasonEvents.id, input.eventId), eq(anywhereSeasonEvents.orgId, v.orgId), eq(anywhereSeasonEvents.athleteId, input.athleteId)));
    if (!e) throw new AuthzError("Event not found.");
    if (!LOGGABLE.includes(e.kind)) throw new UserError("Only practices, games and tournaments can be logged.");
    if (!eventOccurrences(e, input.occurrenceDate, input.occurrenceDate).length) throw new UserError("That event is not on that day.");
    kind = e.kind === "practice" ? "practice" : "game";
    label = e.title ?? (e.opponent ? `${EVENT_KIND_LABEL[e.kind]} vs ${e.opponent}` : EVENT_KIND_LABEL[e.kind]);
    key = `event:${e.id}:${input.occurrenceDate}`;
    const [existing] = await tx.select().from(anywhereSportLogs).where(and(eq(anywhereSportLogs.eventId, e.id), eq(anywhereSportLogs.occurrenceDate, input.occurrenceDate)));
    if (existing) {
      await tx.update(activitySessions).set({ durationMinutes: input.durationMinutes, sessionRpe: input.rpe }).where(and(eq(activitySessions.id, existing.activitySessionId), eq(activitySessions.orgId, v.orgId)));
      await audit(tx, actorOf(v), "anywhere.sport.log_update", "activity_session", existing.activitySessionId, { summary: `Updated ${kind} log: ${input.durationMinutes} min at RPE ${input.rpe} = ${load} AU` });
      return { status: "updated", activitySessionId: existing.activitySessionId, load };
    }
  } else {
    if (!input.kind || !input.clientKey) throw new UserError("Choose practice or game.");
    kind = input.kind;
    label = kind === "practice" ? "Practice" : "Game";
    key = input.clientKey;
    const [existing] = await tx.select().from(anywhereSportLogs).where(and(eq(anywhereSportLogs.orgId, v.orgId), eq(anywhereSportLogs.clientKey, key)));
    if (existing) {
      if (existing.athleteId !== input.athleteId) throw new AuthzError();
      return { status: "duplicate", activitySessionId: existing.activitySessionId, load };
    }
  }
  const [act] = await tx
    .insert(activitySessions)
    .values({ orgId: v.orgId, athleteId: input.athleteId, activityDate: input.occurrenceDate, kind, durationMinutes: input.durationMinutes, sessionRpe: input.rpe, notes: `Sport: ${label}`.slice(0, 300), enteredBy: v.userId, source: "sport", isDemo: a?.isDemo ?? false })
    .returning({ id: activitySessions.id });
  await tx.insert(anywhereSportLogs).values({ orgId: v.orgId, athleteId: input.athleteId, eventId: input.eventId ?? null, occurrenceDate: input.occurrenceDate, kind, clientKey: key, activitySessionId: act.id, loggedBy: v.userId, isDemo: a?.isDemo ?? false });
  await audit(tx, actorOf(v), "anywhere.sport.log", "activity_session", act.id, { summary: `Logged ${kind}: ${input.durationMinutes} min at RPE ${input.rpe} = ${load} AU (source sport)` });
  return { status: "applied", activitySessionId: act.id, load };
}

export type UpcomingGame = { athleteId: string; athleteName: string; teamName: string; kind: SeasonEventKind; date: string; startsAt: Date | null; opponent: string | null; location: string | null };

/**
 * Staff: athletes in the viewer's training scope with a game or tournament in the next 48 hours,
 * so a coach can adjust the plan. Events with no time count when their day is today, tomorrow or
 * the day after.
 */
export async function gamesInNext48h(tx: Tx, v: Viewer, now = new Date()): Promise<UpcomingGame[]> {
  if (!isStaff(v)) throw new AuthzError();
  const { tz } = await orgAnywhere(tx, v.orgId);
  const today = localYmd(now, tz);
  const until = new Date(now.getTime() + 48 * 3_600_000);
  const toYmd = localYmd(until, tz);
  const scope = await accessibleAthleteIds(tx, v, "training.read");
  const rows = await tx
    .select({ e: anywhereSeasonEvents, team: anywhereSeasons.teamName })
    .from(anywhereSeasonEvents)
    .innerJoin(anywhereSeasons, eq(anywhereSeasons.id, anywhereSeasonEvents.seasonId))
    .innerJoin(athletes, eq(athletes.id, anywhereSeasonEvents.athleteId))
    .where(
      and(
        eq(anywhereSeasonEvents.orgId, v.orgId),
        eq(athletes.active, true),
        athleteScopeFilter(scope, anywhereSeasonEvents.athleteId),
        inArray(anywhereSeasonEvents.kind, ["game", "tournament"]),
        lte(anywhereSeasonEvents.startsOn, toYmd),
        gte(anywhereSeasonEvents.endsOn, today),
      ),
    );
  const names = await athleteNames(tx, v.orgId, rows.map((r) => r.e.athleteId));
  const out: UpcomingGame[] = [];
  for (const r of rows) {
    for (const o of eventOccurrences(r.e, today, toYmd)) {
      if (o.startsAt && (o.startsAt < now || o.startsAt > until)) continue;
      out.push({ athleteId: r.e.athleteId, athleteName: names.get(r.e.athleteId) ?? "Athlete", teamName: r.team, kind: o.kind, date: o.date, startsAt: o.startsAt, opponent: o.opponent, location: o.location });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0) || a.athleteName.localeCompare(b.athleteName));
}
