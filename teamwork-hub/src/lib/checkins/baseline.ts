/**
 * Pure calculations for session check-ins. Each has a method key and version that the UI shows,
 * in the style of src/lib/science/formulas.ts. Missing answers are null and are skipped, never 0.
 */

export const CHECKIN_METHODS = {
  checkin_baseline_v1:
    "The athlete's own rolling baseline: the mean of their earlier answers to the same question inside the look-back window (default 42 days), not counting the answer being judged. Null until the minimum number of earlier answers exists (default 5). No fixed good or bad cutoff is used.",
  checkin_deviation_v1:
    "An answer is flagged when it is at least the configured number of points on the unfavourable side of checkin_baseline_v1 (soreness above, readiness below). No flag without a baseline.",
  srpe_load_v1: "Session minutes × session RPE (0 to 10), in arbitrary units. The same calculation and the same stored row as Sports Science → Load.",
  intensity_gap_v1: "Mean reported session RPE minus the RPE the coach planned for that session. Only sessions with a planned RPE and at least one reported RPE count.",
  checkin_completion_v1: "Check-ins answered ÷ attended bookings for sessions in the range. Ready checks left by athletes who were then marked absent are not counted.",
  soreness_response_v1: "Next-day soreness (asked in the following ready check) shown beside the srpe_load_v1 of the session it is about. A pairing only, not a prediction.",
  checkin_pain_level_v1: "The three choices for how much a spot bothers the athlete are stored on the body map's 0 to 10 scale as 3, 6 and 9.",
} as const;
export type CheckinMethod = keyof typeof CHECKIN_METHODS;

export type Dated = { at: Date; value: number | null };
export type Baseline = { method: "checkin_baseline_v1"; mean: number | null; n: number; needed: number; windowDays: number };

const DAY = 86_400_000;

/** checkin_baseline_v1 for the answer given at `asOf` (answers at or after `asOf` are ignored). */
export function baselineV1(series: readonly Dated[], asOf: Date, opts: { windowDays: number; minAnswers: number }): Baseline {
  const from = asOf.getTime() - opts.windowDays * DAY;
  const vals = series.filter((p) => p.value !== null && p.at.getTime() < asOf.getTime() && p.at.getTime() >= from).map((p) => p.value as number);
  const mean = vals.length >= opts.minAnswers ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  return { method: "checkin_baseline_v1", mean, n: vals.length, needed: opts.minAnswers, windowDays: opts.windowDays };
}

/** checkin_deviation_v1. `direction` is the unfavourable side. */
export function farFromBaseline(value: number | null, baseline: Baseline, delta: number, direction: "above" | "below"): boolean {
  if (value === null || baseline.mean === null) return false;
  return direction === "above" ? value - baseline.mean >= delta : baseline.mean - value >= delta;
}

export function meanOrNull(values: readonly (number | null | undefined)[], digits = 1): number | null {
  const xs = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!xs.length) return null;
  const f = 10 ** digits;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * f) / f;
}

/** intensity_gap_v1 over sessions; each session contributes its own mean reported RPE. */
export function intensityGapV1(sessions: readonly { intended: number | null; reported: readonly (number | null)[] }[]): { gap: number | null; sessions: number } {
  const gaps: number[] = [];
  for (const s of sessions) {
    const m = meanOrNull(s.reported, 2);
    if (s.intended !== null && m !== null) gaps.push(m - s.intended);
  }
  return { gap: meanOrNull(gaps, 1), sessions: gaps.length };
}

/** checkin_completion_v1. Null (not 0) when nothing was attended. */
export function completionV1(answered: number, attended: number): number | null {
  return attended > 0 ? answered / attended : null;
}

/** Chip tallies, most tapped first. */
export function chipCounts(rows: readonly (readonly { key: string; label: string }[])[]): { key: string; label: string; count: number }[] {
  const m = new Map<string, { key: string; label: string; count: number }>();
  for (const chips of rows)
    for (const c of chips) {
      const e = m.get(c.key);
      if (e) e.count++;
      else m.set(c.key, { key: c.key, label: c.label, count: 1 });
    }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
