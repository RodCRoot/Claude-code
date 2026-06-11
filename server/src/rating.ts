// Rating / comparison engine.
//
// For each metric we compute where an athlete stands relative to several
// cohorts (sport+position peers, sport peers, age+sex, gym-wide) and relative
// to research "elite" norms. Per-metric percentile scores roll up into a
// composite athlete score.
//
// Two wrinkles:
//  - "Lower is better" metrics (sprint times) are inverted so a fast time
//    yields a HIGH score (0-100).
//  - "Relative to bodyweight" metrics (e.g. back squat) are divided by the
//    athlete's weight before any comparison, so a 60 kg and a 90 kg athlete
//    are judged fairly. Benchmarks for these are stored in xBodyweight units.

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
  confidence: string | null; // HIGH | MEDIUM | LOW
  matchedOn: string; // how specific the benchmark match was
  notes: string | null;
}

export interface MetricRating {
  metricKey: string;
  metricName: string;
  unit: string;
  higherIsBetter: boolean;
  relativeToBw: boolean;
  value: number; // athlete's representative (best) RAW value, in native units
  ratingValue: number; // value actually compared (relativized if applicable)
  recordedAt: string;
  score: number; // headline 0-100 score (most-specific peer percentile, elite fallback)
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

function bestRaw(values: number[], higherIsBetter: boolean): number {
  return higherIsBetter ? Math.max(...values) : Math.min(...values);
}

// Convert a raw value into the value used for comparison (bodyweight-relative
// for strength metrics, otherwise unchanged).
function toRatingValue(raw: number, relativeToBw: boolean, weightKg: number | null): number | null {
  if (!relativeToBw) return raw;
  if (!weightKg || weightKg <= 0) return null; // can't rate relative strength without weight
  return raw / weightKg;
}

const AGE_BAND = 1; // +/- years that count as the same age group

type OrgAthlete = Awaited<ReturnType<typeof loadOrgAthletes>>[number];
function loadOrgAthletes(orgId: string) {
  return prisma.athlete.findMany({ where: { orgId }, include: { metrics: true } });
}

export async function getAthleteRating(athleteId: string): Promise<AthleteRating> {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new Error("Athlete not found");
  const age = ageFrom(athlete.birthDate);

  const metricTypes = await prisma.metricType.findMany();
  const orgAthletes = await loadOrgAthletes(athlete.orgId);

  // athleteId -> metricTypeId -> { raw, rating }
  const repByAthlete = new Map<string, Map<string, { raw: number; rating: number }>>();
  for (const a of orgAthletes) {
    const byMetric = new Map<string, number[]>();
    for (const r of a.metrics) {
      const arr = byMetric.get(r.metricTypeId) ?? [];
      arr.push(r.value);
      byMetric.set(r.metricTypeId, arr);
    }
    const rep = new Map<string, { raw: number; rating: number }>();
    for (const [mtId, vals] of byMetric) {
      const mt = metricTypes.find((m) => m.id === mtId);
      const raw = bestRaw(vals, mt?.higherIsBetter ?? true);
      const rating = toRatingValue(raw, mt?.relativeToBw ?? false, a.weightKg);
      if (rating !== null) rep.set(mtId, { raw, rating });
    }
    repByAthlete.set(a.id, rep);
  }

  const benchmarks = await prisma.benchmark.findMany();
  const metrics: MetricRating[] = [];

  for (const mt of metricTypes) {
    const own = repByAthlete.get(athleteId)?.get(mt.id);
    if (own === undefined) continue;

    const latest = await prisma.metricRecord.findFirst({
      where: { athleteId, metricTypeId: mt.id },
      orderBy: { recordedAt: "desc" },
    });

    // Build cohort populations (each athlete contributes their rating value).
    const collect = (pred: (a: OrgAthlete) => boolean) => {
      const out: number[] = [];
      for (const a of orgAthletes) {
        if (!pred(a)) continue;
        const v = repByAthlete.get(a.id)?.get(mt.id);
        if (v !== undefined) out.push(v.rating);
      }
      return out;
    };

    const inAgeBand = (a: OrgAthlete) => Math.abs(ageFrom(a.birthDate) - age) <= AGE_BAND;
    const samePosition = (a: OrgAthlete) =>
      !!athlete.position && a.position === athlete.position;

    const cohorts: CohortResult[] = [];

    // Most specific peer cohort: same sport + position + sex + age band.
    if (athlete.position) {
      const posPeers = collect(
        (a) => a.sport === athlete.sport && samePosition(a) && a.sex === athlete.sex && inAgeBand(a)
      );
      cohorts.push({
        label: `${athlete.sport} ${athlete.position} (${athlete.sex}, age ${age}±${AGE_BAND})`,
        n: posPeers.length,
        percentile: percentileRank(posPeers, own.rating, mt.higherIsBetter),
      });
    }

    const sportPeers = collect(
      (a) => a.sport === athlete.sport && a.sex === athlete.sex && inAgeBand(a)
    );
    const ageSex = collect((a) => a.sex === athlete.sex && inAgeBand(a));
    const gym = collect(() => true);

    cohorts.push(
      {
        label: `${athlete.sport} peers (${athlete.sex}, age ${age}±${AGE_BAND})`,
        n: sportPeers.length,
        percentile: percentileRank(sportPeers, own.rating, mt.higherIsBetter),
      },
      {
        label: `Age + sex (all sports)`,
        n: ageSex.length,
        percentile: percentileRank(ageSex, own.rating, mt.higherIsBetter),
      },
      { label: `Gym-wide`, n: gym.length, percentile: percentileRank(gym, own.rating, mt.higherIsBetter) }
    );

    // Elite benchmark: best position/sport/sex/age match.
    const match = pickBenchmark(benchmarks, mt.id, athlete.sport, athlete.position, athlete.sex, age);
    let eliteResult: EliteResult | null = null;
    if (match) {
      const b = match.benchmark;
      const ratio = mt.higherIsBetter ? own.rating / b.mean : b.mean / own.rating;
      let zScore: number | null = null;
      let pElite: number | null = null;
      if (b.sd && b.sd > 0) {
        const rawZ = (own.rating - b.mean) / b.sd;
        zScore = mt.higherIsBetter ? rawZ : -rawZ;
        pElite = Math.round(normalCdf(zScore) * 1000) / 10;
      }
      eliteResult = {
        level: b.level,
        mean: b.mean,
        sd: b.sd,
        ratio: Math.round(ratio * 1000) / 1000,
        zScore: zScore === null ? null : Math.round(zScore * 100) / 100,
        percentileOfElite: pElite,
        sourceName: b.sourceName,
        confidence: b.confidence,
        matchedOn: match.matchedOn,
        notes: b.notes,
      };
    }

    // Headline score: most-specific cohort with >=3 athletes, else next, else elite.
    const firstUsable = cohorts.find((c) => c.n >= 3 && c.percentile !== null);
    const score =
      firstUsable?.percentile ??
      cohorts.find((c) => c.percentile !== null)?.percentile ??
      eliteResult?.percentileOfElite ??
      50;

    metrics.push({
      metricKey: mt.key,
      metricName: mt.name,
      unit: mt.unit,
      higherIsBetter: mt.higherIsBetter,
      relativeToBw: mt.relativeToBw,
      value: Math.round(own.raw * 1000) / 1000,
      ratingValue: Math.round(own.rating * 1000) / 1000,
      recordedAt: (latest?.recordedAt ?? new Date()).toISOString(),
      score: Math.round(score * 10) / 10,
      cohorts,
      elite: eliteResult,
    });
  }

  const composite =
    metrics.length === 0
      ? null
      : Math.round((metrics.reduce((s, m) => s + m.score, 0) / metrics.length) * 10) / 10;

  return {
    athleteId,
    ageYears: age,
    compositeScore: composite,
    tier: tierForScore(composite),
    metrics,
  };
}

type BenchmarkRow = Awaited<ReturnType<typeof prisma.benchmark.findMany>>[number];

// Pick the most specific ELITE benchmark for this athlete, honoring position.
function pickBenchmark(
  benchmarks: BenchmarkRow[],
  metricTypeId: string,
  sport: string,
  position: string | null,
  sex: string,
  age: number
): { benchmark: BenchmarkRow; matchedOn: string } | undefined {
  const candidates = benchmarks.filter((b) => {
    if (b.metricTypeId !== metricTypeId) return false;
    if (b.level !== "ELITE") return false;
    if (b.sex && b.sex !== sex) return false;
    if (b.sport && b.sport !== sport) return false;
    if (b.position && b.position !== position) return false; // position-specific row must match
    if (b.ageMin != null && age < b.ageMin) return false;
    if (b.ageMax != null && age > b.ageMax) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => specificity(b) - specificity(a));
  const best = candidates[0];
  return { benchmark: best, matchedOn: describeMatch(best) };
}

function specificity(b: BenchmarkRow) {
  return (b.sport ? 4 : 0) + (b.position ? 2 : 0) + (b.sex ? 1 : 0);
}
function describeMatch(b: BenchmarkRow) {
  const parts = [b.sport, b.position, b.sex].filter(Boolean);
  return parts.length ? parts.join(" · ") : "general";
}
