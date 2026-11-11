/**
 * Team challenges: staff set a time-boxed target; progress is computed read-only from rows other
 * modules already write (attendance, logged workouts, active training weeks), in the facility
 * timezone. Completing one awards a badge (engagement catalog) and writes an audit entry.
 * No prizes, no money, no messages.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athleteBadges, athletes, communityChallengeCompletions, communityChallenges, groups, type ChallengeMetric } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { engagementSettingsOf } from "@/lib/engagement/settings";
import { lintBlockMessage, lintFamilyMessage } from "@/lib/messaging/family-style";
import { manageableGroupIds } from "@/lib/training/assignments";
import { addDaysYmd, daysBetween, todayLocal } from "@/lib/time";
import { communityRoster, type RosterEntry } from "./display-name";
import { rankBoard } from "./leaderboards";
import { actorOf, communityOrg } from "./settings";
import { type ChallengeView } from "./shared";
import { activeWeeksInWindow, countInWindow, loadActivityDates, type ActivityDates } from "./stats";

export type Challenge = typeof communityChallenges.$inferSelect;

export const CHALLENGE_MAX_DAYS = 120;
/** An ended challenge stays on Athlete Home, the leaderboards page and the TV this many days. */
export const CHALLENGE_LINGER_DAYS = 7;
export const BADGE_FIRST = "challenge_complete_v1";
export const BADGE_THREE = "challenge_3_v1";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");
export const challengeInput = z.object({
  title: z.string().trim().min(3, "Give the challenge a name").max(80),
  mode: z.enum(["individual", "group_total"]),
  metric: z.enum(["attendance", "workouts", "streak_weeks"]),
  target: z.coerce.number().int("Whole numbers only").min(1).max(100000),
  startsOn: ymd,
  endsOn: ymd,
  groupId: z.preprocess((x) => (x === "" || x == null ? null : x), z.string().uuid().nullable()),
});

/** One athlete's count for a challenge. Pure. Dates are facility-local; the window is inclusive. */
export function challengeValue(metric: ChallengeMetric, a: ActivityDates | undefined, startsOn: string, endsOn: string): number {
  if (!a) return 0;
  if (metric === "attendance") return countInWindow(a.attended, startsOn, endsOn);
  if (metric === "workouts") return countInWindow(a.workouts, startsOn, endsOn);
  return activeWeeksInWindow([...a.attended, ...a.workouts, ...a.onYourOwn], startsOn, endsOn);
}

export type ChallengeProgress = { values: Map<string, number>; total: number; active: number; finishers: string[]; met: boolean };

/** Progress for one challenge over the athletes taking part (a group's members, or everyone). Pure. */
export function challengeProgress(c: Pick<Challenge, "mode" | "metric" | "target" | "startsOn" | "endsOn" | "groupId">, roster: ReadonlyMap<string, RosterEntry>, activity: ReadonlyMap<string, ActivityDates>): ChallengeProgress {
  const values = new Map<string, number>();
  let total = 0;
  for (const r of roster.values()) {
    if (c.groupId && !r.groupIds.includes(c.groupId)) continue;
    const n = challengeValue(c.metric, activity.get(r.athleteId), c.startsOn, c.endsOn);
    values.set(r.athleteId, n);
    total += n;
  }
  const contributors = [...values].filter(([, n]) => n > 0).map(([id]) => id);
  const met = c.mode === "group_total" && total >= c.target;
  const finishers = c.mode === "individual" ? [...values].filter(([, n]) => n >= c.target).map(([id]) => id) : met ? contributors : [];
  return { values, total, active: contributors.length, finishers, met };
}

/** Staff create a challenge. Coaches only for a group they coach; gym-wide needs owner, admin or operations. */
export async function createChallenge(tx: Tx, v: Viewer, raw: unknown, opts: { today?: string } = {}): Promise<Challenge> {
  if (!isStaff(v)) throw new AuthzError("Only staff can create challenges.");
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) throw new UserError("Community features are turned off for this organization.");
  const input = challengeInput.parse(raw);
  const today = opts.today ?? todayLocal(org.tz);
  if (input.endsOn < input.startsOn) throw new UserError("The end date must be on or after the start date.", { endsOn: "On or after the start" });
  if (input.endsOn < today) throw new UserError("The end date is already in the past.", { endsOn: "Choose today or later" });
  if (daysBetween(input.startsOn, input.endsOn) > CHALLENGE_MAX_DAYS) throw new UserError(`A challenge can run up to ${CHALLENGE_MAX_DAYS} days.`, { endsOn: "Too long" });
  const lint = lintFamilyMessage(input.title, { requireSignOff: false });
  if (lint.blocks.length) throw new UserError(lintBlockMessage(lint, "The challenge name").replace("can't be sent to families yet", "can't be saved yet"), { title: lint.blocks[0].message });
  const manageable = await manageableGroupIds(tx, v);
  if (input.groupId) {
    const [g] = await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.id, input.groupId), eq(groups.orgId, v.orgId), eq(groups.active, true)));
    if (!g) throw new UserError("Group not found.", { groupId: "Pick a group" });
    if (manageable !== "all" && !manageable.includes(input.groupId)) throw new AuthzError("You can only start a challenge for a group you coach.");
  } else if (manageable !== "all") {
    throw new AuthzError("Pick one of your groups. A gym-wide challenge is set up by the front desk or an admin.");
  }
  const [row] = await tx.insert(communityChallenges).values({ orgId: v.orgId, ...input, createdBy: v.userId }).returning();
  await audit(tx, actorOf(v), "community.challenge.create", "community_challenge", row.id, { summary: `Challenge created: ${row.title}`, after: input });
  return row;
}

/** End a challenge early and take it off the boards. Completions already earned stay. */
export async function archiveChallenge(tx: Tx, v: Viewer, challengeId: string): Promise<Challenge> {
  if (!isStaff(v)) throw new AuthzError();
  const [row] = await tx.select().from(communityChallenges).where(and(eq(communityChallenges.id, challengeId), eq(communityChallenges.orgId, v.orgId))).for("update");
  if (!row) throw new AuthzError();
  const manageable = await manageableGroupIds(tx, v);
  if (manageable !== "all" && row.createdBy !== v.userId && !(row.groupId && manageable.includes(row.groupId))) throw new AuthzError("You can only archive challenges for groups you coach.");
  if (row.status === "archived") return row;
  const [after] = await tx.update(communityChallenges).set({ status: "archived", updatedAt: new Date() }).where(eq(communityChallenges.id, row.id)).returning();
  await audit(tx, actorOf(v), "community.challenge.archive", "community_challenge", row.id, { summary: `Challenge archived: ${row.title}`, before: { status: row.status }, after: { status: "archived" } });
  return after;
}

/** Active challenges that have started and ended no more than CHALLENGE_LINGER_DAYS ago. */
export async function currentChallenges(tx: Tx, orgId: string, today: string): Promise<Challenge[]> {
  const rows = await tx
    .select()
    .from(communityChallenges)
    .where(and(eq(communityChallenges.orgId, orgId), eq(communityChallenges.status, "active"), gte(communityChallenges.endsOn, addDaysYmd(today, -CHALLENGE_LINGER_DAYS))))
    .orderBy(communityChallenges.endsOn, communityChallenges.createdAt);
  return rows.filter((c) => c.startsOn <= today);
}

export function challengeView(c: Challenge, roster: ReadonlyMap<string, RosterEntry>, activity: ReadonlyMap<string, ActivityDates>, today: string, ownIds: ReadonlySet<string>, groupName: string | null, opts: { leaders?: number } = {}): ChallengeView {
  const p = challengeProgress(c, roster, activity);
  const ranked = rankBoard(
    [...p.values]
      .filter(([, n]) => n > 0)
      .map(([id, n]) => {
        const r = roster.get(id)!;
        return { athleteId: id, score: n, name: r.displayName, firstName: r.firstName, value: `${n}`, detail: c.mode === "individual" && n >= c.target ? "Done" : null };
      }),
    ownIds,
    { limit: opts.leaders ?? 5 },
  );
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    metric: c.metric,
    target: c.target,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    daysLeft: Math.max(0, daysBetween(today, c.endsOn) + 1),
    ended: c.endsOn < today,
    groupName,
    total: p.total,
    active: p.active,
    finishers: c.mode === "individual" ? p.finishers.length : p.met ? 1 : 0,
    pct: c.mode === "group_total" ? Math.min(100, Math.floor((p.total / c.target) * 100)) : null,
    leaders: ranked.rows,
    you: [...ownIds].flatMap((id) => (p.values.has(id) ? [{ athleteId: id, firstName: roster.get(id)!.firstName, value: p.values.get(id)!, done: p.finishers.includes(id) }] : [])),
  };
}

type Loaded = { today: string; roster: Map<string, RosterEntry>; activity: Map<string, ActivityDates>; challenges: Challenge[]; groupNames: Map<string, string> };

async function load(tx: Tx, orgId: string, today?: string): Promise<Loaded | null> {
  const org = await communityOrg(tx, orgId);
  if (!org.settings.enabled) return null;
  const day = today ?? todayLocal(org.tz);
  const challenges = await currentChallenges(tx, orgId, day);
  if (!challenges.length) return { today: day, roster: new Map(), activity: new Map(), challenges, groupNames: new Map() };
  const [roster, activity] = await Promise.all([communityRoster(tx, orgId, { today: day, defaultMode: org.settings.defaultDisplayMode }), loadActivityDates(tx, orgId, org.tz)]);
  const gids = [...new Set(challenges.flatMap((c) => (c.groupId ? [c.groupId] : [])))];
  const gs = gids.length ? await tx.select({ id: groups.id, name: groups.name }).from(groups).where(and(eq(groups.orgId, orgId), inArray(groups.id, gids))) : [];
  return { today: day, roster, activity, challenges, groupNames: new Map(gs.map((g) => [g.id, g.name])) };
}

/**
 * Record completions for current challenges: one row per finisher, the badge (when badges are on)
 * and an audit entry. Idempotent (unique per challenge and athlete); safe to run on every page
 * load. Never called from the TV board, which only reads.
 */
export async function syncChallengeCompletions(tx: Tx, orgId: string, opts: { today?: string } = {}): Promise<number> {
  const l = await load(tx, orgId, opts.today);
  if (!l || !l.challenges.length) return 0;
  const org = await communityOrg(tx, orgId);
  const badgesOn = engagementSettingsOf(org.orgSettings).badgesEnabled;
  let added = 0;
  for (const c of l.challenges) {
    const p = challengeProgress(c, l.roster, l.activity);
    if (!p.finishers.length) continue;
    const have = new Set((await tx.select({ id: communityChallengeCompletions.athleteId }).from(communityChallengeCompletions).where(eq(communityChallengeCompletions.challengeId, c.id))).map((r) => r.id));
    const missing = p.finishers.filter((id) => !have.has(id));
    if (!missing.length) continue;
    const demo = new Map((await tx.select({ id: athletes.id, isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.orgId, orgId), inArray(athletes.id, missing)))).map((a) => [a.id, a.isDemo]));
    const now = new Date();
    const inserted = await tx
      .insert(communityChallengeCompletions)
      .values(missing.map((id) => ({ orgId, challengeId: c.id, athleteId: id, value: p.values.get(id) ?? 0, completedAt: now, isDemo: demo.get(id) ?? false })))
      .onConflictDoNothing({ target: [communityChallengeCompletions.challengeId, communityChallengeCompletions.athleteId] })
      .returning({ athleteId: communityChallengeCompletions.athleteId });
    for (const { athleteId } of inserted) {
      added++;
      let badges: string[] = [];
      if (badgesOn) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(communityChallengeCompletions).where(and(eq(communityChallengeCompletions.orgId, orgId), eq(communityChallengeCompletions.athleteId, athleteId)));
        const keys = [BADGE_FIRST, ...(n >= 3 ? [BADGE_THREE] : [])];
        const awarded = await tx
          .insert(athleteBadges)
          .values(keys.map((key) => ({ orgId, athleteId, badgeKey: key, earnedAt: now, source: { rule: "challenge", challengeId: c.id, count: n }, isDemo: demo.get(athleteId) ?? false })))
          .onConflictDoNothing({ target: [athleteBadges.athleteId, athleteBadges.badgeKey] })
          .returning({ key: athleteBadges.badgeKey });
        badges = awarded.map((b) => b.key);
      }
      await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "community.challenge.complete", "community_challenge", c.id, {
        summary: `Challenge completed: ${c.title}`,
        after: { athleteId, value: p.values.get(athleteId) ?? 0, target: c.target, mode: c.mode, metric: c.metric, badges },
      });
    }
  }
  return added;
}

/** Current challenges as display-safe views. `ownIds` adds the viewer's own athletes' counts. */
export async function challengeViews(tx: Tx, orgId: string, opts: { today?: string; ownIds?: ReadonlySet<string>; leaders?: number } = {}): Promise<ChallengeView[]> {
  const l = await load(tx, orgId, opts.today);
  if (!l) return [];
  return l.challenges.map((c) => challengeView(c, l.roster, l.activity, l.today, opts.ownIds ?? new Set(), c.groupId ? (l.groupNames.get(c.groupId) ?? null) : null, { leaders: opts.leaders }));
}

/** Staff list: every challenge (newest first) with who may archive it. */
export async function listChallengesForStaff(tx: Tx, v: Viewer) {
  if (!isStaff(v)) throw new AuthzError();
  const manageable = await manageableGroupIds(tx, v);
  const rows = await tx.select({ c: communityChallenges, groupName: groups.name }).from(communityChallenges).leftJoin(groups, eq(groups.id, communityChallenges.groupId)).where(eq(communityChallenges.orgId, v.orgId)).orderBy(desc(communityChallenges.createdAt)).limit(50);
  const groupOptions = await tx.select({ id: groups.id, name: groups.name }).from(groups).where(and(eq(groups.orgId, v.orgId), eq(groups.active, true))).orderBy(groups.name);
  return {
    challenges: rows.map(({ c, groupName }) => ({ ...c, groupName, canArchive: c.status === "active" && (manageable === "all" || c.createdBy === v.userId || (!!c.groupId && manageable.includes(c.groupId))) })),
    groups: manageable === "all" ? groupOptions : groupOptions.filter((g) => manageable.includes(g.id)),
    canGymWide: manageable === "all",
  };
}
