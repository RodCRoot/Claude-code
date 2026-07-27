// Age-group × sex leaderboards over metrics (tests) and exercise e1RMs.
// Used by the athlete "Today" rank snapshots and the Leaderboards page.
import { prisma } from "./db";
import { ageGroup, AgeGroup } from "./prescription";

export type LeaderKind = "METRIC" | "E1RM";

export interface LeaderRow {
  athleteId: string;
  name: string;
  sex: string;
  ageGroup: AgeGroup;
  value: number;
  recordedAt: string;
}

export interface LeaderboardResult {
  kind: LeaderKind;
  key: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  rows: LeaderRow[];
}

interface OrgAthlete { id: string; firstName: string; lastName: string; sex: string; birthDate: Date; }

async function orgAthletes(orgId: string): Promise<Map<string, OrgAthlete>> {
  const list = await prisma.athlete.findMany({
    where: { orgId },
    select: { id: true, firstName: true, lastName: true, sex: true, birthDate: true },
  });
  return new Map(list.map((a) => [a.id, a]));
}

// Best (direction-aware) record per athlete for a metric, or best e1RM per
// athlete for an exercise.
async function bestPerAthlete(
  athleteIds: string[],
  kind: LeaderKind,
  key: string
): Promise<{ best: Map<string, { value: number; recordedAt: Date }>; higherIsBetter: boolean; label: string; unit: string }> {
  if (kind === "E1RM") {
    const exercise = await prisma.exercise.findUnique({ where: { id: key }, select: { name: true } });
    const maxes = await prisma.maxProfile.findMany({
      where: { athleteId: { in: athleteIds }, exerciseId: key },
      orderBy: { recordedAt: "desc" },
      select: { athleteId: true, e1rmKg: true, recordedAt: true },
    });
    const best = new Map<string, { value: number; recordedAt: Date }>();
    for (const m of maxes) {
      const cur = best.get(m.athleteId);
      if (!cur || m.e1rmKg > cur.value) best.set(m.athleteId, { value: m.e1rmKg, recordedAt: m.recordedAt });
    }
    return { best, higherIsBetter: true, label: `${exercise?.name ?? "Exercise"} e1RM`, unit: "kg" };
  }

  const metric = await prisma.metricType.findUnique({ where: { key } });
  if (!metric) throw new Error("Unknown metric key");
  const records = await prisma.metricRecord.findMany({
    where: { athleteId: { in: athleteIds }, metricTypeId: metric.id },
    select: { athleteId: true, value: true, recordedAt: true },
  });
  const best = new Map<string, { value: number; recordedAt: Date }>();
  for (const r of records) {
    const cur = best.get(r.athleteId);
    const better = !cur || (metric.higherIsBetter ? r.value > cur.value : r.value < cur.value);
    if (better) best.set(r.athleteId, { value: r.value, recordedAt: r.recordedAt });
  }
  return { best, higherIsBetter: metric.higherIsBetter, label: metric.name, unit: metric.unit };
}

// Ranked leaderboard, optionally filtered to an age group and/or sex.
export async function leaderboard(
  orgId: string,
  kind: LeaderKind,
  key: string,
  filter: { ageGroup?: string; sex?: string } = {}
): Promise<LeaderboardResult> {
  const athletes = await orgAthletes(orgId);
  const { best, higherIsBetter, label, unit } = await bestPerAthlete([...athletes.keys()], kind, key);

  let rows: LeaderRow[] = [];
  for (const [athleteId, b] of best) {
    const a = athletes.get(athleteId);
    if (!a) continue;
    const ag = ageGroup(a.birthDate);
    if (filter.ageGroup && ag !== filter.ageGroup) continue;
    if (filter.sex && a.sex !== filter.sex) continue;
    rows.push({ athleteId, name: `${a.firstName} ${a.lastName}`, sex: a.sex, ageGroup: ag, value: b.value, recordedAt: b.recordedAt.toISOString() });
  }
  rows.sort((x, y) => (higherIsBetter ? y.value - x.value : x.value - y.value));
  return { kind, key, label, unit, higherIsBetter, rows };
}

// The athlete's rank within their OWN age-group × sex for one metric/exercise.
export async function athleteRank(
  orgId: string,
  athleteId: string,
  kind: LeaderKind,
  key: string
): Promise<{ rank: number; of: number; value: number; unit: string; label: string; ageGroup: AgeGroup; sex: string } | null> {
  const athlete = await prisma.athlete.findUnique({
    where: { id: athleteId },
    select: { sex: true, birthDate: true },
  });
  if (!athlete) return null;
  const ag = ageGroup(athlete.birthDate);
  const board = await leaderboard(orgId, kind, key, { ageGroup: ag, sex: athlete.sex });
  const idx = board.rows.findIndex((r) => r.athleteId === athleteId);
  if (idx === -1) return null;
  return {
    rank: idx + 1,
    of: board.rows.length,
    value: board.rows[idx].value,
    unit: board.unit,
    label: board.label,
    ageGroup: ag,
    sex: athlete.sex,
  };
}
