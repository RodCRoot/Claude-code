/**
 * Badge catalog (in code, versioned keys) and the pure rule evaluation.
 *
 * A key never changes meaning: if a rule changes, add a new key with the next version suffix and
 * keep the old one so badges already earned still render. Badges are never taken away.
 * No rule reads a health value.
 */

export type BadgeFamily = "sessions" | "streak" | "pr" | "goal" | "early" | "forms" | "member" | "challenge";
export type BadgeTier = "bronze" | "silver" | "gold" | "platinum";

export type BadgeDef = {
  key: string;
  name: string;
  /** How it is earned, in plain words. */
  description: string;
  family: BadgeFamily;
  tier: BadgeTier;
  /** Short text drawn on the medallion (a number), or null to draw the family glyph only. */
  mark: string | null;
};

export const EARLY_BIRD_BEFORE_HOUR = 7;
export const EARLY_BIRD_SESSIONS = 5;
export const SESSION_MILESTONES = [10, 25, 50, 100] as const;
export const STREAK_MILESTONES = [4, 12, 26, 52] as const;

const TIERS: BadgeTier[] = ["bronze", "silver", "gold", "platinum"];

export const BADGES: BadgeDef[] = [
  { key: "first_session_v1", name: "First Session", description: "Attend your first session.", family: "sessions", tier: "bronze", mark: "1" },
  ...SESSION_MILESTONES.map((n, i): BadgeDef => ({ key: `sessions_${n}_v1`, name: `${n} Sessions`, description: `Attend ${n} sessions.`, family: "sessions", tier: TIERS[i], mark: String(n) })),
  ...STREAK_MILESTONES.map((n, i): BadgeDef => ({ key: `streak_${n}_v1`, name: `${n}-Week Streak`, description: `Train at least once a week for ${n} weeks in a row.`, family: "streak", tier: TIERS[i], mark: String(n) })),
  { key: "first_pr_v1", name: "First PR", description: "Beat one of your own maxes.", family: "pr", tier: "bronze", mark: null },
  { key: "pr_5_v1", name: "5 PRs", description: "Set five personal records.", family: "pr", tier: "gold", mark: "5" },
  { key: "goal_first_v1", name: "Goal Getter", description: "Reach your first goal.", family: "goal", tier: "silver", mark: null },
  { key: "early_bird_v1", name: "Early Bird", description: `Attend ${EARLY_BIRD_SESSIONS} sessions that start before ${EARLY_BIRD_BEFORE_HOUR} AM.`, family: "early", tier: "gold", mark: null },
  { key: "all_forms_signed_v1", name: "Paperwork Pro", description: "Have every required form signed.", family: "forms", tier: "bronze", mark: null },
  { key: "one_year_member_v1", name: "One Year Strong", description: "Be a member for one year.", family: "member", tier: "platinum", mark: "1" },
  // Awarded by the community module (src/lib/community/challenges.ts), not by evaluateBadges.
  { key: "challenge_complete_v1", name: "Challenge Finisher", description: "Complete a team challenge.", family: "challenge", tier: "silver", mark: null },
  { key: "challenge_3_v1", name: "3 Challenges", description: "Complete three team challenges.", family: "challenge", tier: "gold", mark: "3" },
];

const BY_KEY = new Map(BADGES.map((b) => [b.key, b]));
export const badgeDef = (key: string): BadgeDef | null => BY_KEY.get(key) ?? null;

export type BadgeStats = {
  /** Start times of attended sessions, oldest first. */
  sessionTimes: readonly Date[];
  /** Start times of attended sessions that began before EARLY_BIRD_BEFORE_HOUR facility time, oldest first. */
  earlyBirdTimes: readonly Date[];
  /** When the running weekly streak first reached each milestone. */
  streakReached: Readonly<Record<number, Date>>;
  /** When each PR was recorded, oldest first. */
  prTimes: readonly Date[];
  /** When each goal was achieved, oldest first. */
  goalTimes: readonly Date[];
  /** When the last required form was completed, if every required form is currently signed. */
  formsCompleteAt: Date | null;
  /** The first membership anniversary, if it has passed and the athlete is still a member. */
  anniversaryAt: Date | null;
};

export type EarnedBadge = { key: string; earnedAt: Date; source: Record<string, string | number | boolean | null> };

/** Every badge the stats qualify for, with the moment the rule was first met. Pure. */
export function evaluateBadges(s: BadgeStats): EarnedBadge[] {
  const out: EarnedBadge[] = [];
  const nth = (list: readonly Date[], n: number) => (list.length >= n ? list[n - 1] : null);
  const add = (key: string, at: Date | null | undefined, source: EarnedBadge["source"]) => {
    if (at && BY_KEY.has(key)) out.push({ key, earnedAt: at, source });
  };
  add("first_session_v1", nth(s.sessionTimes, 1), { rule: "sessions", count: 1 });
  for (const n of SESSION_MILESTONES) add(`sessions_${n}_v1`, nth(s.sessionTimes, n), { rule: "sessions", count: n });
  for (const n of STREAK_MILESTONES) add(`streak_${n}_v1`, s.streakReached[n], { rule: "streak_weeks", count: n });
  add("first_pr_v1", nth(s.prTimes, 1), { rule: "prs", count: 1 });
  add("pr_5_v1", nth(s.prTimes, 5), { rule: "prs", count: 5 });
  add("goal_first_v1", nth(s.goalTimes, 1), { rule: "goals", count: 1 });
  add("early_bird_v1", nth(s.earlyBirdTimes, EARLY_BIRD_SESSIONS), { rule: "early_sessions", count: EARLY_BIRD_SESSIONS, beforeHour: EARLY_BIRD_BEFORE_HOUR });
  add("all_forms_signed_v1", s.formsCompleteAt, { rule: "required_forms" });
  add("one_year_member_v1", s.anniversaryAt, { rule: "membership_years", count: 1 });
  return out;
}
