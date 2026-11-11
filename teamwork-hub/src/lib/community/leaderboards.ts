/**
 * Leaderboards by age band (and optionally one training group). Rules:
 *  - athletes are only ever ranked inside their own age band, so a 12-year-old is never ranked
 *    against an adult; an athlete with no birthday on file is not ranked;
 *  - exercise boards use measured maxes only (tested, coach-entered, imported), never estimates;
 *  - names come from `communityRoster` (publicName): hidden athletes are never in `rows`;
 *  - the viewer's own athletes always get a `you` line, hidden or not;
 *  - on a board with fewer than five visible athletes, ranks are counted among visible athletes
 *    and totals are withheld, so nobody can work out who is hidden or where they stand;
 *  - body mass orders the relative-strength board but no ratio or weight is ever output.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { groups } from "@/db/schema";
import { accessibleAthleteIds, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, fmt, localToUtc, todayLocal } from "@/lib/time";
import { communityRoster, type RosterEntry } from "./display-name";
import { communityOrg } from "./settings";
import { AGE_BANDS, type AgeBand, type Board, type BoardKind, type BoardRow, type YouLine } from "./shared";
import { bestMaxes, countInWindow, fmtLoad, improvements, loadActivityDates, loadHolds, loadMeasuredMaxes, streakOf, type ActivityDates, type MeasuredMax } from "./stats";

export const SMALL_BOARD = 5;
export const BOARD_ROWS = 10;

export type RankEntry = {
  athleteId: string;
  /** Higher is better. */
  score: number;
  /** Resolved display name; null = hidden. */
  name: string | null;
  firstName: string;
  value: string | null;
  detail?: string | null;
  /** Show `value` to other families (false on the relative-strength board). */
  publicValue?: boolean;
};

/**
 * Pure ranking. Competition ranking (ties share a rank). `rows` never contains a hidden athlete.
 * See the file comment for the small-board rule.
 */
export function rankBoard(entries: readonly RankEntry[], ownIds: ReadonlySet<string>, opts: { limit?: number; smallBelow?: number } = {}): { rows: BoardRow[]; you: YouLine[]; small: boolean; total: number | null } {
  const sorted = [...entries].sort((a, b) => b.score - a.score || (a.name ?? "￿").localeCompare(b.name ?? "￿") || a.athleteId.localeCompare(b.athleteId));
  const visible = sorted.filter((e) => e.name !== null);
  const small = visible.length < (opts.smallBelow ?? SMALL_BOARD);
  const rankIn = (pool: readonly RankEntry[], e: RankEntry) => 1 + pool.filter((x) => x.score > e.score).length;
  const rows: BoardRow[] = visible.slice(0, opts.limit ?? BOARD_ROWS).map((e) => ({
    rank: rankIn(small ? visible : sorted, e),
    name: e.name!,
    value: e.publicValue === false ? null : e.value,
    detail: e.detail ?? null,
    you: ownIds.has(e.athleteId),
  }));
  const you: YouLine[] = sorted
    .filter((e) => ownIds.has(e.athleteId))
    .map((e) => {
      const hidden = e.name === null;
      // Small board: rank among visible athletes (plus yourself when hidden), never among other hidden athletes.
      const pool = small ? (hidden ? [...visible, e] : visible) : sorted;
      return { athleteId: e.athleteId, firstName: e.firstName, rank: rankIn(pool, e), of: small ? null : sorted.length, hidden, value: e.value };
    });
  return { rows, you, small, total: small ? null : sorted.length };
}

export type CommunityStats = {
  today: string;
  tz: string;
  activity: Map<string, ActivityDates>;
  streaks: Map<string, number>;
  maxesByAthlete: Map<string, MeasuredMax[]>;
  exerciseNames: Map<string, string>;
};

export async function loadCommunityStats(tx: Tx, orgId: string, opts: { today: string; tz: string }): Promise<CommunityStats> {
  const [activity, holds, maxes] = await Promise.all([loadActivityDates(tx, orgId, opts.tz), loadHolds(tx, orgId), loadMeasuredMaxes(tx, orgId)]);
  const streaks = new Map<string, number>();
  for (const [id, a] of activity) streaks.set(id, streakOf(a, holds.get(id), opts.today));
  const maxesByAthlete = new Map<string, MeasuredMax[]>();
  for (const m of maxes.rows) maxesByAthlete.set(m.athleteId, [...(maxesByAthlete.get(m.athleteId) ?? []), m]);
  return { today: opts.today, tz: opts.tz, activity, streaks, maxesByAthlete, exerciseNames: maxes.exerciseNames };
}

const LB_PER_KG = 2.2046226218;
const MAX_EXERCISE_BOARDS = 6;

type Cohort = { band: AgeBand; groupId: string | null; groupName: string | null };

/** Every board for one cohort (an age band, optionally narrowed to one training group). Pure given the stats. */
export function buildBoards(roster: ReadonlyMap<string, RosterEntry>, stats: CommunityStats, cohort: Cohort, ownIds: ReadonlySet<string>, opts: { limit?: number } = {}): Board[] {
  const members = [...roster.values()].filter((r) => r.band === cohort.band && (!cohort.groupId || r.groupIds.includes(cohort.groupId)));
  const base = (r: RosterEntry) => ({ athleteId: r.athleteId, name: r.displayName, firstName: r.firstName });
  const out: Board[] = [];
  const push = (key: string, kind: BoardKind, title: string, label: string, entries: RankEntry[]) => {
    if (!entries.length) return;
    out.push({ key: `${cohort.band}:${cohort.groupId ?? "all"}:${key}`, kind, title, label, band: cohort.band, groupName: cohort.groupName, ...rankBoard(entries, ownIds, opts) });
  };

  const monthStart = `${stats.today.slice(0, 7)}-01`;
  const monthName = fmt(localToUtc(stats.today, "12:00", stats.tz), "MMMM", stats.tz);
  push(
    "sessions",
    "sessions_month",
    `Sessions in ${monthName}`,
    "Sessions attended this month",
    members.flatMap((r) => {
      const n = countInWindow(stats.activity.get(r.athleteId)?.attended ?? [], monthStart, stats.today);
      return n > 0 ? [{ ...base(r), score: n, value: `${n}` }] : [];
    }),
  );
  push(
    "streak",
    "streak",
    "Weekly streaks",
    "Weeks in a row with at least one session or workout",
    members.flatMap((r) => {
      const n = stats.streaks.get(r.athleteId) ?? 0;
      return n > 0 ? [{ ...base(r), score: n, value: `${n} wk` }] : [];
    }),
  );

  const best = new Map(members.map((r) => [r.athleteId, bestMaxes(stats.maxesByAthlete.get(r.athleteId) ?? [])]));
  const improved: RankEntry[] = [];
  for (const r of members) {
    const top = improvements(stats.maxesByAthlete.get(r.athleteId) ?? [], stats.today)[0];
    if (top) improved.push({ ...base(r), score: top.pct, value: `+${Math.round(top.pct)}%`, detail: stats.exerciseNames.get(top.exerciseId) ?? null });
  }
  push("improved", "improved", "Most improved", "Percent gained on a measured max in the last 90 days", improved);

  const counts = new Map<string, number>();
  for (const b of best.values()) for (const id of b.keys()) counts.set(id, (counts.get(id) ?? 0) + 1);
  const exerciseIds = [...counts.entries()].sort((a, b) => b[1] - a[1] || (stats.exerciseNames.get(a[0]) ?? "").localeCompare(stats.exerciseNames.get(b[0]) ?? "")).slice(0, MAX_EXERCISE_BOARDS).map(([id]) => id);
  for (const exId of exerciseIds) {
    const name = stats.exerciseNames.get(exId) ?? "Exercise";
    const entries: RankEntry[] = [];
    const relative: RankEntry[] = [];
    for (const r of members) {
      const m = best.get(r.athleteId)?.get(exId);
      if (!m) continue;
      entries.push({ ...base(r), score: m.lb, value: fmtLoad(m.value, m.unit) });
      // Ordered by max divided by body mass; the ratio and the mass are never output.
      if (r.bodyMassKg) relative.push({ ...base(r), score: m.lb / (r.bodyMassKg * LB_PER_KG), value: null, publicValue: false });
    }
    push(`max:${exId}`, "max", name, "Measured maxes only", entries);
    if (relative.length >= 2) push(`rel:${exId}`, "relative", `${name}, pound for pound`, "Measured max relative to body weight. Order only: no weights or ratios are shown", relative);
  }
  return out;
}

export type LeaderboardsView = {
  enabled: boolean;
  bands: AgeBand[];
  band: AgeBand | null;
  groups: { id: string; name: string }[];
  groupId: string | null;
  boards: Board[];
  /** The viewer's own athletes that have no birthday on file and so are not ranked. */
  unbanded: string[];
};

/**
 * Leaderboards for athletes, guardians and staff. Families see the age bands their own athletes
 * are in (and the groups those athletes train with); staff see every band. Staff get the same
 * public rows families do: hidden athletes stay hidden here for everyone.
 */
export async function leaderboardsFor(tx: Tx, v: Viewer, opts: { band?: string | null; groupId?: string | null; today?: string } = {}): Promise<LeaderboardsView> {
  if (!isStaff(v) && v.role !== "guardian" && v.role !== "athlete") throw new AuthzError();
  const org = await communityOrg(tx, v.orgId);
  const empty: LeaderboardsView = { enabled: org.settings.enabled, bands: [], band: null, groups: [], groupId: null, boards: [], unbanded: [] };
  if (!org.settings.enabled) return empty;
  const today = opts.today ?? todayLocal(org.tz);
  const roster = await communityRoster(tx, v.orgId, { today, defaultMode: org.settings.defaultDisplayMode });
  const staff = isStaff(v);
  // "You" lines carry the athlete's own numbers, so they need training access, not just a link.
  const own = staff ? [] : await accessibleAthleteIds(tx, v, "training.read");
  const linked = staff ? [] : await accessibleAthleteIds(tx, v, "profile.read");
  const ownIds = new Set(own === "all" ? [] : own);
  const linkedEntries = (linked === "all" ? [] : linked).flatMap((id) => (roster.get(id) ? [roster.get(id)!] : []));
  const bands = staff ? AGE_BANDS.filter((b) => [...roster.values()].some((r) => r.band === b)) : AGE_BANDS.filter((b) => linkedEntries.some((r) => r.band === b));
  const unbanded = linkedEntries.filter((r) => r.band === null).map((r) => r.firstName);
  const band = bands.find((b) => b === opts.band) ?? bands[0] ?? null;
  if (!band) return { ...empty, unbanded };
  const groupIds = new Set((staff ? [...roster.values()] : linkedEntries).filter((r) => r.band === band).flatMap((r) => r.groupIds));
  const groupRows = groupIds.size ? await tx.select({ id: groups.id, name: groups.name }).from(groups).where(and(eq(groups.orgId, v.orgId), eq(groups.active, true), inArray(groups.id, [...groupIds]))) : [];
  const groupList = groupRows.sort((a, b) => a.name.localeCompare(b.name));
  const group = groupList.find((g) => g.id === opts.groupId) ?? null;
  const stats = await loadCommunityStats(tx, v.orgId, { today, tz: org.tz });
  const boards = buildBoards(roster, stats, { band, groupId: group?.id ?? null, groupName: group?.name ?? null }, ownIds);
  return { enabled: true, bands, band, groups: groupList, groupId: group?.id ?? null, boards, unbanded };
}
