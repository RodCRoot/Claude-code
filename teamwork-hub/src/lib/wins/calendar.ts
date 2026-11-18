/**
 * Competition calendar: who competes when. Built from two sources and nothing else:
 *  1. My Season events the family entered (games and tournaments; `anywhere_season_events`);
 *  2. team schedules staff entered once and attached to several athletes.
 * No load logic lives here: the staff views link to the existing load page.
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { anywhereSeasonEvents, anywhereSeasons, athletes, competitionTeamAthletes, competitionTeamEvents, competitionTeams, people, TEAM_EVENT_KINDS, TEAM_KINDS } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { eventOccurrences } from "@/lib/anywhere/season";
import { accessibleAthleteIds, assertCan, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { communityRoster } from "@/lib/community/display-name";
import { communityOrg } from "@/lib/community/settings";
import { addDaysYmd, daysBetween, fmt, localToUtc, localYmd, todayLocal } from "@/lib/time";
import { actorOf } from "./access";
import { COMPETITION_KIND_LABEL, oneLine, parseScheduleLines } from "./shared";

export type Team = typeof competitionTeams.$inferSelect;
export type CompetitionKind = "game" | "meet" | "tournament";

const uuid = z.string().uuid();
const MAX_TEAM_EVENTS = 200;
const MAX_TEAM_ATHLETES = 200;

// ---------------------------------------------------------------------------
// Team schedules (staff)
// ---------------------------------------------------------------------------

export const teamInput = z.object({
  name: z.preprocess(oneLine, z.string().min(2, "Add the team name").max(80)),
  sport: z.preprocess(oneLine, z.string().min(1, "Add the sport").max(40)),
  kind: z.enum(TEAM_KINDS),
  seasonLabel: z.preprocess((x) => oneLine(x) || null, z.string().max(40).nullable()).optional(),
});

async function teamForStaff(tx: Tx, v: Viewer, teamId: string): Promise<Team> {
  assertCan(v, "wins.review");
  if (!uuid.safeParse(teamId).success) throw new AuthzError("Team not found.");
  const [t] = await tx.select().from(competitionTeams).where(and(eq(competitionTeams.id, teamId), eq(competitionTeams.orgId, v.orgId))).for("update");
  if (!t) throw new AuthzError("Team not found.");
  return t;
}

export async function createTeam(tx: Tx, v: Viewer, raw: unknown): Promise<Team> {
  assertCan(v, "wins.review");
  const input = teamInput.parse(raw);
  const [t] = await tx.insert(competitionTeams).values({ orgId: v.orgId, name: input.name, sport: input.sport, kind: input.kind, seasonLabel: input.seasonLabel ?? null, createdBy: v.userId }).returning();
  await audit(tx, actorOf(v), "wins.team.create", "competition_team", t.id, { summary: `Team schedule added: ${t.name} (${t.sport})`, after: input });
  return t;
}

export async function archiveTeam(tx: Tx, v: Viewer, teamId: string): Promise<void> {
  const t = await teamForStaff(tx, v, teamId);
  if (t.archivedAt) return;
  await tx.update(competitionTeams).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(competitionTeams.id, t.id));
  await audit(tx, actorOf(v), "wins.team.archive", "competition_team", t.id, { summary: `Team schedule archived: ${t.name}` });
}

/** Add several dates at once from pasted lines (see `parseScheduleLines`). Duplicate date and time lines are skipped. */
export async function addTeamEvents(tx: Tx, v: Viewer, input: { teamId: string; kind: string; lines: string }): Promise<{ added: number; skipped: number }> {
  const t = await teamForStaff(tx, v, input.teamId);
  if (t.archivedAt) throw new UserError("This team schedule is archived.");
  if (!TEAM_EVENT_KINDS.includes(input.kind as CompetitionKind)) throw new UserError("Choose game, meet or tournament.", { kind: "Required" });
  const { rows, errors } = parseScheduleLines(input.lines ?? "");
  if (errors.length) throw new UserError(errors.slice(0, 3).join(" "), { lines: errors[0] });
  if (!rows.length) throw new UserError("Add at least one date, one per line.", { lines: "Required" });
  const today = todayLocal((await communityOrg(tx, v.orgId)).tz);
  for (const r of rows) if (Math.abs(daysBetween(today, r.eventDate)) > 730) throw new UserError(`${r.eventDate} is more than two years away. Check the year.`, { lines: "Check the dates" });
  const existing = await tx.select({ d: competitionTeamEvents.eventDate, t: competitionTeamEvents.startTimeLocal }).from(competitionTeamEvents).where(eq(competitionTeamEvents.teamId, t.id));
  if (existing.length + rows.length > MAX_TEAM_EVENTS) throw new UserError(`A team schedule holds up to ${MAX_TEAM_EVENTS} dates.`);
  const seen = new Set(existing.map((e) => `${e.d}|${e.t ?? ""}`));
  const fresh = rows.filter((r) => {
    const k = `${r.eventDate}|${r.startTimeLocal ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length) await tx.insert(competitionTeamEvents).values(fresh.map((r) => ({ orgId: v.orgId, teamId: t.id, kind: input.kind as CompetitionKind, ...r, createdBy: v.userId })));
  await audit(tx, actorOf(v), "wins.team.events_add", "competition_team", t.id, { summary: `${fresh.length} date${fresh.length === 1 ? "" : "s"} added to ${t.name}`, after: { added: fresh.length, skipped: rows.length - fresh.length } });
  return { added: fresh.length, skipped: rows.length - fresh.length };
}

export async function removeTeamEvent(tx: Tx, v: Viewer, eventId: string): Promise<void> {
  assertCan(v, "wins.review");
  if (!uuid.safeParse(eventId).success) throw new AuthzError("Date not found.");
  const [e] = await tx.select().from(competitionTeamEvents).where(and(eq(competitionTeamEvents.id, eventId), eq(competitionTeamEvents.orgId, v.orgId)));
  if (!e) throw new AuthzError("Date not found.");
  await tx.delete(competitionTeamEvents).where(eq(competitionTeamEvents.id, e.id));
  await audit(tx, actorOf(v), "wins.team.event_remove", "competition_team", e.teamId, { summary: `Date ${e.eventDate} removed from a team schedule` });
}

/**
 * Set which athletes are on a team schedule, several at once. Staff can only add or remove
 * athletes in their own scope (`profile.read`): a coach's save never touches athletes they do
 * not coach, whatever ids are posted.
 */
export async function setTeamAthletes(tx: Tx, v: Viewer, teamId: string, athleteIds: string[]): Promise<{ added: number; removed: number }> {
  const t = await teamForStaff(tx, v, teamId);
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const inScope = (id: string) => scope === "all" || scope.includes(id);
  const wanted = [...new Set(athleteIds.filter((id) => uuid.safeParse(id).success))];
  if (wanted.some((id) => !inScope(id))) throw new AuthzError("One of those athletes is not on your roster.");
  if (wanted.length > MAX_TEAM_ATHLETES) throw new UserError(`A team schedule holds up to ${MAX_TEAM_ATHLETES} athletes.`);
  const valid = wanted.length ? (await tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, wanted)))).map((r) => r.id) : [];
  if (valid.length !== wanted.length) throw new AuthzError("One of those athletes was not found.");
  const current = (await tx.select({ id: competitionTeamAthletes.athleteId }).from(competitionTeamAthletes).where(eq(competitionTeamAthletes.teamId, t.id))).map((r) => r.id);
  const add = valid.filter((id) => !current.includes(id));
  const remove = current.filter((id) => inScope(id) && !valid.includes(id));
  if (add.length) await tx.insert(competitionTeamAthletes).values(add.map((athleteId) => ({ orgId: v.orgId, teamId: t.id, athleteId, addedBy: v.userId }))).onConflictDoNothing();
  if (remove.length) await tx.delete(competitionTeamAthletes).where(and(eq(competitionTeamAthletes.teamId, t.id), inArray(competitionTeamAthletes.athleteId, remove)));
  if (add.length || remove.length) await audit(tx, actorOf(v), "wins.team.athletes_set", "competition_team", t.id, { summary: `${t.name}: ${add.length} athlete${add.length === 1 ? "" : "s"} added, ${remove.length} removed`, after: { added: add, removed: remove } });
  return { added: add.length, removed: remove.length };
}

export type TeamView = Team & {
  events: { id: string; kind: CompetitionKind; eventDate: string; startTimeLocal: string | null; opponent: string | null; location: string | null }[];
  /** Athletes on the schedule the viewer may see (a coach: assigned athletes only). */
  athleteIds: string[];
  /** Athletes on the schedule outside the viewer's scope: a count only. */
  otherAthletes: number;
};

export async function listTeams(tx: Tx, v: Viewer): Promise<TeamView[]> {
  assertCan(v, "wins.review");
  const teams = await tx.select().from(competitionTeams).where(and(eq(competitionTeams.orgId, v.orgId), isNull(competitionTeams.archivedAt))).orderBy(asc(competitionTeams.name));
  if (!teams.length) return [];
  const ids = teams.map((t) => t.id);
  const events = await tx.select().from(competitionTeamEvents).where(inArray(competitionTeamEvents.teamId, ids)).orderBy(asc(competitionTeamEvents.eventDate), asc(competitionTeamEvents.startTimeLocal));
  const members = await tx.select().from(competitionTeamAthletes).where(inArray(competitionTeamAthletes.teamId, ids));
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const inScope = (id: string) => scope === "all" || scope.includes(id);
  return teams.map((t) => {
    const m = members.filter((x) => x.teamId === t.id);
    return {
      ...t,
      events: events.filter((e) => e.teamId === t.id).map((e) => ({ id: e.id, kind: e.kind, eventDate: e.eventDate, startTimeLocal: e.startTimeLocal, opponent: e.opponent, location: e.location })),
      athleteIds: m.filter((x) => inScope(x.athleteId)).map((x) => x.athleteId),
      otherAthletes: m.filter((x) => !inScope(x.athleteId)).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar entries
// ---------------------------------------------------------------------------

export type RawEntry = {
  athleteId: string;
  date: string;
  startsAt: Date | null;
  kind: CompetitionKind;
  teamName: string;
  sport: string;
  opponent: string | null;
  location: string | null;
  source: "my_season" | "team_schedule";
};

/**
 * Every competition day of active athletes between two facility-local dates (inclusive), from
 * both sources. One entry per athlete per day: when the family's My Season and a staff team
 * schedule both have that day, the family's own entry is kept.
 */
export async function competitionEntries(tx: Tx, orgId: string, fromYmd: string, toYmd: string, tz: string): Promise<RawEntry[]> {
  const season = await tx
    .select({ e: anywhereSeasonEvents, team: anywhereSeasons.teamName, sport: anywhereSeasons.sport })
    .from(anywhereSeasonEvents)
    .innerJoin(anywhereSeasons, eq(anywhereSeasons.id, anywhereSeasonEvents.seasonId))
    .innerJoin(athletes, eq(athletes.id, anywhereSeasonEvents.athleteId))
    .where(and(eq(anywhereSeasonEvents.orgId, orgId), eq(athletes.active, true), inArray(anywhereSeasonEvents.kind, ["game", "tournament"]), lte(anywhereSeasonEvents.startsOn, toYmd), gte(anywhereSeasonEvents.endsOn, fromYmd)));
  const out = new Map<string, RawEntry>();
  for (const r of season) {
    for (const o of eventOccurrences(r.e, fromYmd, toYmd)) {
      const key = `${r.e.athleteId}|${o.date}`;
      const prev = out.get(key);
      if (prev && (prev.startsAt?.getTime() ?? Infinity) <= (o.startsAt?.getTime() ?? Infinity)) continue;
      out.set(key, { athleteId: r.e.athleteId, date: o.date, startsAt: o.startsAt, kind: o.kind === "tournament" ? "tournament" : "game", teamName: r.team, sport: r.sport, opponent: o.opponent, location: o.location, source: "my_season" });
    }
  }
  const team = await tx
    .select({ e: competitionTeamEvents, team: competitionTeams.name, sport: competitionTeams.sport, athleteId: competitionTeamAthletes.athleteId })
    .from(competitionTeamEvents)
    .innerJoin(competitionTeams, eq(competitionTeams.id, competitionTeamEvents.teamId))
    .innerJoin(competitionTeamAthletes, eq(competitionTeamAthletes.teamId, competitionTeams.id))
    .innerJoin(athletes, eq(athletes.id, competitionTeamAthletes.athleteId))
    .where(and(eq(competitionTeamEvents.orgId, orgId), eq(athletes.active, true), isNull(competitionTeams.archivedAt), gte(competitionTeamEvents.eventDate, fromYmd), lte(competitionTeamEvents.eventDate, toYmd)));
  for (const r of team) {
    const key = `${r.athleteId}|${r.e.eventDate}`;
    if (out.has(key)) continue;
    out.set(key, { athleteId: r.athleteId, date: r.e.eventDate, startsAt: r.e.startTimeLocal ? localToUtc(r.e.eventDate, r.e.startTimeLocal, tz) : null, kind: r.e.kind, teamName: r.team, sport: r.sport, opponent: r.e.opponent, location: r.e.location, source: "team_schedule" });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0) || a.athleteId.localeCompare(b.athleteId));
}

export type StaffEntry = RawEntry & { athleteName: string; personId: string; kindLabel: string; groupIds: string[]; canSeeLoad: boolean };
export type StaffCalendar = {
  from: string;
  to: string;
  today: string;
  tz: string;
  entries: StaffEntry[];
  /** Filter choices, built from what is on the calendar in this range (before filtering). */
  sports: string[];
  teams: string[];
  groups: { id: string; name: string }[];
  locations: { id: string; name: string }[];
};

export type CalendarFilter = { sport?: string | null; team?: string | null; groupId?: string | null; locationId?: string | null };

/**
 * Staff calendar for a date range. Scope is `profile.read`: owner, admin and operations see every
 * athlete, a coach only assigned athletes. "Location" means the athlete booked or attended a
 * session at that location in the last 90 days (athletes have no home location on file).
 */
export async function staffCalendar(tx: Tx, v: Viewer, range: { from: string; to: string }, filter: CalendarFilter = {}, opts: { today?: string } = {}): Promise<StaffCalendar> {
  if (!isStaff(v)) throw new AuthzError();
  assertCan(v, "wins.review");
  const org = await communityOrg(tx, v.orgId);
  const today = opts.today ?? todayLocal(org.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) || range.to < range.from || daysBetween(range.from, range.to) > 62) throw new UserError("Choose a range of up to two months.");
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const loadScope = await accessibleAthleteIds(tx, v, "training.read");
  const raw = (await competitionEntries(tx, v.orgId, range.from, range.to, org.tz)).filter((e) => scope === "all" || scope.includes(e.athleteId));
  const ids = [...new Set(raw.map((e) => e.athleteId))];
  const who = ids.length
    ? await tx.select({ id: athletes.id, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, ids)))
    : [];
  const whoBy = new Map(who.map((w) => [w.id, w]));
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const groupRows = ids.length
    ? ((await tx.execute(sql`select gm.athlete_id, g.id, g.name from group_members gm join groups g on g.id = gm.group_id where g.org_id = ${v.orgId} and g.active and gm.athlete_id in (${idList})`)).rows as { athlete_id: string; id: string; name: string }[])
    : [];
  const locRows = ids.length
    ? ((
        await tx.execute(sql`select distinct b.athlete_id, l.id, l.name from bookings b join schedule_sessions s on s.id = b.session_id join locations l on l.id = s.location_id
          where b.org_id = ${v.orgId} and b.status in ('booked','attended') and s.starts_at >= ${new Date(Date.now() - 90 * 86_400_000).toISOString()} and b.athlete_id in (${idList})`)
      ).rows as { athlete_id: string; id: string; name: string }[])
    : [];
  const groupsOf = (id: string) => groupRows.filter((g) => g.athlete_id === id).map((g) => g.id);
  const uniq = <T extends { id: string; name: string }>(rows: T[]) => [...new Map(rows.map((r) => [r.id, { id: r.id, name: r.name }])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const entries = raw
    .filter((e) => !filter.sport || e.sport.toLowerCase() === filter.sport.toLowerCase())
    .filter((e) => !filter.team || e.teamName.toLowerCase() === filter.team.toLowerCase())
    .filter((e) => !filter.groupId || groupsOf(e.athleteId).includes(filter.groupId))
    .filter((e) => !filter.locationId || locRows.some((l) => l.athlete_id === e.athleteId && l.id === filter.locationId))
    .map((e) => {
      const w = whoBy.get(e.athleteId);
      return { ...e, athleteName: w ? `${w.preferred ?? w.first} ${w.last}` : "Athlete", personId: w?.personId ?? "", kindLabel: COMPETITION_KIND_LABEL[e.kind], groupIds: groupsOf(e.athleteId), canSeeLoad: loadScope === "all" || loadScope.includes(e.athleteId) };
    });
  const sortU = (xs: string[]) => [...new Map(xs.map((x) => [x.toLowerCase(), x])).values()].sort((a, b) => a.localeCompare(b));
  return { from: range.from, to: range.to, today, tz: org.tz, entries, sports: sortU(raw.map((e) => e.sport)), teams: sortU(raw.map((e) => e.teamName)), groups: uniq(groupRows), locations: uniq(locRows) };
}

export type CompetingDay = { date: string; label: string; isToday: boolean; isTomorrow: boolean; entries: StaffEntry[] };

/** Staff Today widget: the next seven days (today included), grouped by day, tomorrow flagged. */
export async function competingThisWeekStaff(tx: Tx, v: Viewer, opts: { now?: Date } = {}): Promise<{ days: CompetingDay[]; tomorrow: number; total: number }> {
  const org = await communityOrg(tx, v.orgId);
  const today = localYmd(opts.now ?? new Date(), org.tz);
  const cal = await staffCalendar(tx, v, { from: today, to: addDaysYmd(today, 6) }, {}, { today });
  const tomorrowYmd = addDaysYmd(today, 1);
  const days: CompetingDay[] = [];
  for (const e of cal.entries) {
    let d = days.find((x) => x.date === e.date);
    if (!d) {
      d = { date: e.date, label: e.date === today ? "Today" : e.date === tomorrowYmd ? "Tomorrow" : fmt(localToUtc(e.date, "12:00", org.tz), "EEEE, MMM d", org.tz), isToday: e.date === today, isTomorrow: e.date === tomorrowYmd, entries: [] };
      days.push(d);
    }
    d.entries.push(e);
  }
  return { days, tomorrow: days.find((d) => d.isTomorrow)?.entries.length ?? 0, total: cal.entries.length };
}

/** One line of the family card. No ids, no last names, no team, opponent, place or time. */
export type FamilyCompetingItem = { name: string; sport: string; kindLabel: string; day: string; date: string };

/**
 * Family card "Teamwork athletes competing this week": display names only, through
 * `communityRoster`, so hidden athletes are dropped. It deliberately leaves out the team or
 * school, the opponent, the place and the time: other families learn that a teammate competes
 * this week, not where a child will be. Empty when community features are off.
 */
export async function competingThisWeekFamily(tx: Tx, v: Viewer, opts: { now?: Date; limit?: number } = {}): Promise<{ items: FamilyCompetingItem[]; more: number }> {
  if (v.role === "kiosk") throw new AuthzError();
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) return { items: [], more: 0 };
  const today = localYmd(opts.now ?? new Date(), org.tz);
  const roster = await communityRoster(tx, v.orgId, { today, defaultMode: org.settings.defaultDisplayMode });
  const raw = await competitionEntries(tx, v.orgId, today, addDaysYmd(today, 6), org.tz);
  const items: FamilyCompetingItem[] = [];
  for (const e of raw) {
    const name = roster.get(e.athleteId)?.displayName ?? null;
    if (!name) continue;
    items.push({ name, sport: e.sport, kindLabel: COMPETITION_KIND_LABEL[e.kind], day: e.date === today ? "Today" : e.date === addDaysYmd(today, 1) ? "Tomorrow" : fmt(localToUtc(e.date, "12:00", org.tz), "EEEE", org.tz), date: e.date });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const limit = opts.limit ?? 10;
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}
