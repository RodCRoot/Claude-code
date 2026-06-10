// Rating / comparison engine.
//
// For each metric we compute where an athlete stands relative to several
// cohorts (sport peers, age+sex, gym-wide) and relative to research "elite"
// norms. Per-metric percentile scores roll up into a composite athlete score.
//
// "Lower is better" metrics (sprint times) are handled by inverting the
// percentile so that a fast time always yields a HIGH score (0-100).

import { prisma } from "./db";

export interface CohortResult {
  label: string;
  n: number; // athletes in the cohort with a value for this metric
  percentile: number | null; // 0-100, athlete's standing within the cohort
}

export interface EliteResult {
  level: string;
  mean: number;
  sd: number | null;
  ratio: number; // athlete value / elite mean (direction-adjusted toward >1 = at/above)
  zScore: number | null;
  percentileOfElite: number | null; // z -> normal CDF, 0-100
  sourceName: string | null;
}

export interface MetricRating {
  metricKey: string;
  metricName: string;
  unit: string;
  higherIsBetter: boolean;
  value: number; // athlete's representative (best) value
  recordedAt: string;
  score: number; // headline 0-100 score for this metric (peer percentile, elite-adjusted)
  cohorts: CohortResult[];
  elite: EliteResult | null;
}

export interface AthleteRating {
  athleteId: string;
  ageYears: number;
  compositeScore: number | null; // mean of metric scores, 0-100
  tier: string; // Elite | Advanced | Proficient | Developing | Foundational
  metrics: MetricRating[];
}

// --- statistics helpers -----------------------------------------------------

// Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// Percentile rank of `value` within `population` (inclusive of value itself).
// Returns 0-100. When higherIsBetter is false, a smaller value ranks higher.
function percentileRank(
  population: number[],
  value: number,
  higherIsBetter: boolean
): number | null {
  if (population.length === 0) return null;
  const better = population.filter((v) =>
    higherIsBetter ? v < value : v > value
  ).length;
  const equal = population.filter((v) => v === value).length;
  // mid-rank for ties
  const rank = (better + 0.5 * equal) / population.length;
  return Math.round(rank * 1000) / 10;
}

function tierForScore(score: number | null): string {
  if (score === null) return "Unrated";
  if (score >= 90) return "Elite";
  if (score >= 75) return "Advanced";
  if (score >= 50) return "Proficient";
  if (score >= 25) return "Developing";
  return "Foundational";
}

function ageFrom(birthDate: Date): number {
  const ms = Date.now() - birthDate.getTime();
  return Math.floor(ms / (365.25 * 24 * 3600 * 1000));
}

// Best (representative) value for an athlete on a metric given direction.
function bestValue(values: number[], higherIsBetter: boolean): number {
  return higherIsBetter ? Math.max(...values) : Math.min(...values);
}

const AGE_BAND = 1; // +/- years that count as the same age group

export async function getAthleteRating(athleteId: string): Promise<AthleteRating> {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new Error("Athlete not found");
  const age = ageFrom(athlete.birthDate);

  const metricTypes = await prisma.metricType.findMany();

  // Pull every record for athletes in this org once, then bucket in memory.
  const orgAthletes = await prisma.athlete.findMany({
    where: { orgId: athlete.orgId },
    include: { metrics: true },
  });

  // athleteId -> metricTypeId -> best value
  const repByAthlete = new Map<string, Map<string, number>>();
  for (const a of orgAthletes) {
    const byMetric = new Map<string, number[]>();
    for (const r of a.metrics) {
      const arr = byMetric.get(r.metricTypeId) ?? [];
      arr.push(r.value);
      byMetric.set(r.metricTypeId, arr);
    }
    const best = new Map<string, number>();
    for (const [mtId, vals] of byMetric) {
      const mt = metricTypes.find((m) => m.id === mtId);
      best.set(mtId, bestValue(vals, mt?.higherIsBetter ?? true));
    }
    repByAthlete.set(a.id, best);
  }

  const benchmarks = await prisma.benchmark.findMany();
  const metrics: MetricRating[] = [];

  for (const mt of metricTypes) {
    const own = repByAthlete.get(athleteId)?.get(mt.id);
    if (own === undefined) continue;

    // most recent record for display timestamp
    const latest = await prisma.metricRecord.findFirst({
      where: { athleteId, metricTypeId: mt.id },
      orderBy: { recordedAt: "desc" },
    });

    // Build cohort populations (each athlete contributes their best value).
    const collect = (pred: (a: (typeof orgAthletes)[number]) => boolean) => {
      const out: number[] = [];
      for (const a of orgAthletes) {
        if (!pred(a)) continue;
        const v = repByAthlete.get(a.id)?.get(mt.id);
        if (v !== undefined) out.push(v);
      }
      return out;
    };

    const inAgeBand = (a: (typeof orgAthletes)[number]) =>
      Math.abs(ageFrom(a.birthDate) - age) <= AGE_BAND;

    const peers = collect(
      (a) => a.sport === athlete.sport && a.sex === athlete.sex && inAgeBand(a)
    );
    const ageSex = collect((a) => a.sex === athlete.sex && inAgeBand(a));
    const gym = collect(() => true);

    const cohorts: CohortResult[] = [
      {
        label: `${athlete.sport} peers (${athlete.sex}, age ${age}±${AGE_BAND})`,
        n: peers.length,
        percentile: percentileRank(peers, own, mt.higherIsBetter),
      },
      {
        label: `Age + sex (all sports)`,
        n: ageSex.length,
        percentile: percentileRank(ageSex, own, mt.higherIsBetter),
      },
      {
        label: `Gym-wide`,
        n: gym.length,
        percentile: percentileRank(gym, own, mt.higherIsBetter),
      },
    ];

    // Elite benchmark: best-matching ELITE row (sport/sex/age aware).
    const elite = pickBenchmark(benchmarks, mt.id, athlete.sport, athlete.sex, age);
    let eliteResult: EliteResult | null = null;
    if (elite) {
      const ratio = mt.higherIsBetter ? own / elite.mean : elite.mean / own;
      let zScore: number | null = null;
      let pElite: number | null = null;
      if (elite.sd && elite.sd > 0) {
        const rawZ = (own - elite.mean) / elite.sd;
        zScore = mt.higherIsBetter ? rawZ : -rawZ;
        pElite = Math.round(normalCdf(zScore) * 1000) / 10;
      }
      eliteResult = {
        level: elite.level,
        mean: elite.mean,
        sd: elite.sd,
        ratio: Math.round(ratio * 1000) / 1000,
        zScore: zScore === null ? null : Math.round(zScore * 100) / 100,
        percentileOfElite: pElite,
        sourceName: elite.sourceName,
      };
    }

    // Headline score: peer percentile when we have a real peer cohort,
    // otherwise fall back to age+sex, then gym, then elite percentile.
    const score =
      (peers.length >= 3 ? cohorts[0].percentile : null) ??
      cohorts[1].percentile ??
      cohorts[2].percentile ??
      eliteResult?.percentileOfElite ??
      50;

    metrics.push({
      metricKey: mt.key,
      metricName: mt.name,
      unit: mt.unit,
      higherIsBetter: mt.higherIsBetter,
      value: own,
      recordedAt: (latest?.recordedAt ?? new Date()).toISOString(),
      score: Math.round(score * 10) / 10,
      cohorts,
      elite: eliteResult,
    });
  }

  const composite =
    metrics.length === 0
      ? null
      : Math.round(
          (metrics.reduce((s, m) => s + m.score, 0) / metrics.length) * 10
        ) / 10;

  return {
    athleteId,
    ageYears: age,
    compositeScore: composite,
    tier: tierForScore(composite),
    metrics,
  };
}

function pickBenchmark(
  benchmarks: Awaited<ReturnType<typeof prisma.benchmark.findMany>>,
  metricTypeId: string,
  sport: string,
  sex: string,
  age: number
) {
  const candidates = benchmarks.filter((b) => {
    if (b.metricTypeId !== metricTypeId) return false;
    if (b.level !== "ELITE") return false;
    if (b.sex && b.sex !== sex) return false;
    if (b.sport && b.sport !== sport) return false;
    if (b.ageMin != null && age < b.ageMin) return false;
    if (b.ageMax != null && age > b.ageMax) return false;
    return true;
  });
  // Prefer the most specific match (sport + sex specified scores higher).
  candidates.sort(
    (a, b) =>
      specificity(b, sport, sex) - specificity(a, sport, sex)
  );
  return candidates[0];
}

function specificity(b: { sport: string | null; sex: string | null }, _s: string, _x: string) {
  return (b.sport ? 2 : 0) + (b.sex ? 1 : 0);
}
