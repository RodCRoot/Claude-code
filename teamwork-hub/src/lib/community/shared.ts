/**
 * Community module constants and payload types that are safe to import from client components
 * (no database, no zod). See docs/modules/community.md.
 */
import type { ChallengeMetric, ChallengeMode, DisplayNameMode, ShoutoutTemplate } from "@/db/schema/community";

export const DISPLAY_MODE_LABEL: Record<DisplayNameMode, string> = {
  first_last_initial: "First name and last initial",
  first_name_only: "First name only",
  hidden: "Hidden",
};

export const DISPLAY_MODE_HINT: Record<DisplayNameMode, string> = {
  first_last_initial: 'For example "Sam T." on the gym TV, leaderboards and shoutouts.',
  first_name_only: 'For example "Sam", with no initial.',
  hidden: "Never shown to other families. The athlete still sees their own rank.",
};

export const SHOUTOUT_LABEL: Record<ShoutoutTemplate, string> = {
  great_effort: "Great effort",
  leader_today: "Leader today",
  new_pr: "New PR",
  consistency: "Consistency",
};

export const SHOUTOUT_NOTE_MAX = 140;

export const CHALLENGE_METRIC_LABEL: Record<ChallengeMetric, string> = {
  attendance: "Sessions attended",
  workouts: "Workouts logged",
  streak_weeks: "Weeks trained",
};
export const CHALLENGE_METRIC_UNIT: Record<ChallengeMetric, [string, string]> = {
  attendance: ["session", "sessions"],
  workouts: ["workout", "workouts"],
  streak_weeks: ["week", "weeks"],
};
export const CHALLENGE_MODE_LABEL: Record<ChallengeMode, string> = { individual: "Each athlete", group_total: "Team total" };

export type AgeBand = "U12" | "U14" | "U16" | "U18" | "Adult";
export const AGE_BANDS: AgeBand[] = ["U12", "U14", "U16", "U18", "Adult"];

export const PANEL_KEYS = ["pr_bell", "streaks", "level_ups", "leaderboards", "classes", "milestones", "shoutouts", "wins", "challenges", "message"] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];
export const PANEL_LABEL: Record<PanelKey, string> = {
  pr_bell: "PR Bell",
  streaks: "On a streak",
  level_ups: "Level ups and new badges",
  leaderboards: "Leaderboards",
  classes: "Today's classes",
  milestones: "Milestones",
  shoutouts: "Coach shoutouts",
  wins: "Wins outside the gym",
  challenges: "Team challenges",
  message: "Gym message",
};

export const ordinal = (n: number) => {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

export const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export type BoardKind = "max" | "relative" | "streak" | "sessions_month" | "improved";

/** One public row. Never carries an athlete id; `you` marks the viewer's own athlete. */
export type BoardRow = { rank: number; name: string; value: string | null; detail: string | null; you: boolean };

/** The viewer's own athlete on a board, shown even when hidden from everyone else. */
export type YouLine = { athleteId: string; firstName: string; rank: number; of: number | null; hidden: boolean; value: string | null };

export type Board = {
  key: string;
  kind: BoardKind;
  title: string;
  /** How the numbers are measured, e.g. "Measured maxes only". */
  label: string;
  band: AgeBand;
  groupName: string | null;
  rows: BoardRow[];
  you: YouLine[];
  /** Fewer than five visible athletes: totals are withheld so nobody can work out who is hidden. */
  small: boolean;
  /** Athletes on the board, hidden ones included. Null on small boards. */
  total: number | null;
};

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export type ChallengeView = {
  id: string;
  title: string;
  mode: ChallengeMode;
  metric: ChallengeMetric;
  target: number;
  startsOn: string;
  endsOn: string;
  /** Whole days left including today; 0 once it has ended. */
  daysLeft: number;
  ended: boolean;
  groupName: string | null;
  /** Combined count of everyone taking part. */
  total: number;
  /** Athletes with at least one count. */
  active: number;
  /** Athletes who reached the target (individual) or 1/0 for a met team total. */
  finishers: number;
  /** 0 to 100 for a team total; null for individual challenges. */
  pct: number | null;
  /** Top of the challenge by count, display names only. */
  leaders: BoardRow[];
  you: { athleteId: string; firstName: string; value: number; done: boolean }[];
};

// ---------------------------------------------------------------------------
// Gym TV board payload (the only thing a display device can read)
// ---------------------------------------------------------------------------

export type BoardPanel =
  | { key: "pr_bell"; title: string; items: { name: string; lift: string; value: string; delta: string | null; when: string }[] }
  | { key: "streaks"; title: string; items: { name: string; weeks: number }[] }
  | { key: "level_ups"; title: string; items: { name: string; kind: "level" | "badge"; label: string; badgeKey: string | null; level: number | null }[] }
  | { key: "leaderboards"; title: string; board: { title: string; label: string; cohort: string; rows: { rank: number; name: string; value: string | null; detail: string | null }[] } }
  | { key: "classes"; title: string; items: { time: string; title: string; coach: string | null; spotsLeft: number; state: "now" | "next" | "done" }[] }
  | { key: "milestones"; title: string; items: { name: string; label: string }[] }
  | { key: "shoutouts"; title: string; items: { name: string; headline: string; note: string | null; coach: string }[] }
  | { key: "wins"; title: string; items: { name: string; headline: string; label: string; sport: string; when: string }[] }
  | { key: "challenges"; title: string; challenge: Omit<ChallengeView, "you" | "id"> }
  | { key: "message"; title: string; text: string };

export type BoardPayload = {
  generatedAt: string;
  orgName: string;
  /** False when community features are turned off: the board shows a neutral holding screen. */
  enabled: boolean;
  rotationSeconds: number;
  /** Facility timezone (IANA): the board clock shows gym time whatever the TV is set to. */
  timeZone: string;
  dateLabel: string;
  panels: BoardPanel[];
};
