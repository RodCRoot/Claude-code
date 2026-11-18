/**
 * Level curve (pure). Total XP needed to REACH level n (n >= 1):
 *
 *   threshold(n) = 50 * n * (n - 1)      → L1 0, L2 100, L3 300, L4 600, L5 1000, L6 1500 …
 *
 * so each level costs 100 XP more than the one before (level n → n+1 needs 100 * n XP).
 * Documented in docs/modules/engagement.md; change both together.
 */
export const LEVEL_CURVE = "tw_levels_v1";

export function levelThreshold(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return 50 * n * (n - 1);
}

const TITLES = ["Rookie", "Starter", "Grinder", "Competitor", "Varsity", "Captain", "All-Conference", "All-State", "All-American", "Legend"];

export function levelTitle(level: number): string {
  return TITLES[Math.min(TITLES.length, Math.max(1, level)) - 1];
}

export type LevelInfo = {
  level: number;
  title: string;
  xp: number;
  /** XP earned inside the current level and the size of the level. */
  into: number;
  span: number;
  /** XP still needed for the next level. */
  toNext: number;
  /** 0–100, whole number. */
  pct: number;
};

export function levelFor(totalXp: number): LevelInfo {
  const xp = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
  let level = 1;
  while (levelThreshold(level + 1) <= xp) level++;
  const floor = levelThreshold(level);
  const span = levelThreshold(level + 1) - floor;
  const into = xp - floor;
  return { level, title: levelTitle(level), xp, into, span, toNext: span - into, pct: Math.floor((into / span) * 100) };
}
