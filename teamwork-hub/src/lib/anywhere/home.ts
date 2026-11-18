/**
 * Read model for the Anywhere cards on Athlete Home (/today for athletes and guardians).
 * Every section is gated by the viewer's capabilities on the athlete (./common.ts, which defers to
 * policy.ts). A section the viewer may not see is null, never an empty or zero value.
 *
 * Nothing in this file reads wellness answers, pain or soreness reports, or injury notes. The
 * warm-up suggestion on a game day is simply the first published "pre-game warm-up" session.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { anywhereSessions } from "@/db/schema";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { habitSummaries } from "@/lib/science/habits";
import { isoWeekdayPure } from "@/lib/science/formulas";
import { DEFAULT_TZ, addDaysYmd, todayLocal } from "@/lib/time";
import { assignmentsForAthlete, type AthleteAssignment } from "./assignments";
import { anywhereAccess, orgAnywhere, type AnywhereAccess } from "./common";
import { activeSeason, calendarForAthlete, type CalendarItem } from "./season";

export type Daily3Habit = {
  habitId: string;
  name: string;
  /** "8 h", "2.5 L"; null when the habit has no target. */
  target: string | null;
  /** This period's status. Null = not checked in yet (never treated as missed). */
  status: "done" | "partial" | "missed" | null;
  streak: number;
  weekly: boolean;
};

export type AnywhereHome = {
  athleteId: string;
  firstName: string;
  today: string;
  access: AnywhereAccess;
  /** A game or tournament today. Null on other days. */
  gameDay: {
    item: CalendarItem;
    /** Has the start time passed (or was no time given)? Decides between "get ready" and "log it". */
    started: boolean;
    /** From the library's pre-game warm-up category. Null without training access or when none is published. */
    warmup: { id: string; title: string; durationMinutes: number } | null;
  } | null;
  /** Practices and games from today (already started) or yesterday that have no log yet. Null when the viewer cannot log. */
  toLog: CalendarItem[] | null;
  /** Open and finished assignments for this week. Null without training access. */
  assignments: AthleteAssignment[] | null;
  /** Up to three coach-assigned habits due today. Null without training access; empty = none assigned. */
  daily3: Daily3Habit[] | null;
  /** Set only when the organization turned the In Season link on AND a season is active today. */
  inSeason: { teamName: string } | null;
};

const fmtTarget = (v: number | null, unit: string | null) => (v == null ? null : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ` ${unit}` : ""}`);

export async function anywhereHome(tx: Tx, v: Viewer, athleteId: string, opts: { tz?: string; today?: string; now?: Date } = {}): Promise<AnywhereHome> {
  const org = await orgAnywhere(tx, v.orgId);
  const tz = opts.tz ?? org.tz ?? DEFAULT_TZ;
  const now = opts.now ?? new Date();
  const today = opts.today ?? todayLocal(tz, now);
  const access = await anywhereAccess(tx, v, athleteId, today);
  if (!access || (!access.canSeeSeason && !access.canSeeTraining)) throw new AuthzError();

  const items = access.canSeeSeason ? await calendarForAthlete(tx, v, athleteId, addDaysYmd(today, -1), today) : [];
  const todays = items.filter((i) => i.date === today);
  const game = todays.find((i) => i.kind === "game" || i.kind === "tournament") ?? null;
  const started = (i: CalendarItem) => i.date < today || !i.startsAt || i.startsAt <= now;

  let warmup: NonNullable<AnywhereHome["gameDay"]>["warmup"] = null;
  if (game && access.canSeeTraining) {
    const [w] = await tx
      .select({ id: anywhereSessions.id, title: anywhereSessions.title, durationMinutes: anywhereSessions.durationMinutes })
      .from(anywhereSessions)
      .where(and(eq(anywhereSessions.orgId, v.orgId), eq(anywhereSessions.status, "published"), eq(anywhereSessions.category, "pre_game_warmup"), access.restricted ? eq(anywhereSessions.suitableUnder13, true) : undefined))
      .orderBy(asc(anywhereSessions.durationMinutes), asc(anywhereSessions.title))
      .limit(1);
    warmup = w ?? null;
  }

  const toLog = access.canLog && access.canSeeSeason ? items.filter((i) => i.loggable && i.log === null && started(i) && i !== game) : null;

  let daily3: AnywhereHome["daily3"] = null;
  if (access.canSeeTraining) {
    const weekday = isoWeekdayPure(today);
    daily3 = (await habitSummaries(tx, v, athleteId, addDaysYmd(today, -27), today))
      .filter((h) => h.habit.frequency !== "weekdays" || weekday <= 5)
      .slice(0, 3)
      .map((h) => {
        const weekly = h.habit.frequency === "weekly";
        const period = h.calendar[h.calendar.length - 1];
        return { habitId: h.habit.id, name: h.habit.name, target: fmtTarget(h.habit.targetValue, h.habit.targetUnit), status: weekly ? period?.status ?? null : h.todayStatus, streak: h.streak, weekly };
      });
  }

  let inSeason: AnywhereHome["inSeason"] = null;
  if (org.settings.showInSeasonOption && access.canSeeSeason) {
    const s = await activeSeason(tx, v, athleteId, today);
    if (s) inSeason = { teamName: s.teamName };
  }

  return {
    athleteId,
    firstName: access.firstName,
    today,
    access,
    gameDay: game ? { item: game, started: started(game), warmup } : null,
    toLog,
    assignments: access.canSeeTraining ? await assignmentsForAthlete(tx, v, athleteId, today) : null,
    daily3,
    inSeason,
  };
}
