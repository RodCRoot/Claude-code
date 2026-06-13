// Builds the athlete "Today" view: today's plan with per-set targets, personal
// bests, recent PRs, and age-group×sex rank snapshots.
import { prisma } from "./db";
import { computeTargets, ageGroup, ageYears } from "./prescription";
import { latestMaxesByExercise } from "./maxprofiles";
import { athleteRank } from "./leaderboards";

// Tests we surface as rank snapshots / PB highlights on the home screen.
const KEY_METRICS = ["sprint_10m", "cmj_height", "vertical_jump", "dj_rsi"];
const KEY_EXERCISE_NAMES = ["Back Squat"];

function isToday(d: Date | null): boolean {
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export async function buildToday(athleteId: string) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) return null;
  const orgId = athlete.orgId;
  const maxes = await latestMaxesByExercise(athleteId);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5);

  // --- Today's plan (non-completed assignments, with computed targets) ------
  const assignments = await prisma.workoutAssignment.findMany({
    where: { athleteId, status: { not: "COMPLETED" } },
    include: {
      workout: {
        include: {
          blocks: {
            orderBy: { order: "asc" },
            include: { items: { orderBy: { order: "asc" }, include: { exercise: { select: { id: true, name: true, videoUrl: true } } } } },
          },
        },
      },
    },
    orderBy: [{ assignedDate: "desc" }],
  });
  const plan = assignments.map((a) => ({
    id: a.id,
    status: a.status,
    dueDate: a.dueDate,
    dueToday: isToday(a.dueDate) || isToday(a.assignedDate),
    workout: {
      name: a.workout.name,
      description: a.workout.description,
      blocks: a.workout.blocks.map((b) => ({
        name: b.name,
        items: b.items.map((it) => ({
          exercise: it.exercise.name,
          sets: it.sets,
          reps: it.reps,
          targets: computeTargets(it, maxes[it.exerciseId] ?? null),
        })),
      })),
    },
  }));

  // --- Personal bests -------------------------------------------------------
  // Exercise e1RMs (best per exercise).
  const allMaxes = await prisma.maxProfile.findMany({
    where: { athleteId },
    include: { exercise: { select: { name: true } } },
    orderBy: { recordedAt: "desc" },
  });
  const bestE1rm = new Map<string, { name: string; value: number; achievedAt: Date }>();
  for (const m of allMaxes) {
    const cur = bestE1rm.get(m.exerciseId);
    if (!cur || m.e1rmKg > cur.value) bestE1rm.set(m.exerciseId, { name: m.exercise.name, value: m.e1rmKg, achievedAt: m.recordedAt });
  }

  // Metric PBs (direction-aware best per key metric).
  const metricTypes = await prisma.metricType.findMany({ where: { key: { in: KEY_METRICS } } });
  const metricBests: { key: string; label: string; unit: string; value: number; achievedAt: Date; recent: boolean }[] = [];
  for (const mt of metricTypes) {
    const recs = await prisma.metricRecord.findMany({
      where: { athleteId, metricTypeId: mt.id },
      select: { value: true, recordedAt: true },
    });
    if (recs.length === 0) continue;
    let best = recs[0];
    for (const r of recs) if (mt.higherIsBetter ? r.value > best.value : r.value < best.value) best = r;
    metricBests.push({ key: mt.key, label: mt.name, unit: mt.unit, value: best.value, achievedAt: best.recordedAt, recent: best.recordedAt >= thirtyDaysAgo });
  }

  const personalBests = {
    lifts: [...bestE1rm.values()].map((e) => ({ name: e.name, value: e.value, unit: "kg", achievedAt: e.achievedAt })),
    tests: metricBests.map((m) => ({ name: m.label, value: m.value, unit: m.unit, achievedAt: m.achievedAt })),
  };

  // --- Recent PRs (best achieved within the last 30 days) -------------------
  const recentPRs = [
    ...metricBests.filter((m) => m.recent).map((m) => ({ label: m.label, value: m.value, unit: m.unit, achievedAt: m.achievedAt })),
    ...[...bestE1rm.values()].filter((e) => e.achievedAt >= thirtyDaysAgo).map((e) => ({ label: `${e.name} e1RM`, value: e.value, unit: "kg", achievedAt: e.achievedAt })),
  ].sort((a, b) => +new Date(b.achievedAt) - +new Date(a.achievedAt));

  // --- Age-group × sex rank snapshots --------------------------------------
  const ranks: { label: string; rank: number; of: number; value: number; unit: string }[] = [];
  for (const key of KEY_METRICS) {
    const r = await athleteRank(orgId, athleteId, "METRIC", key).catch(() => null);
    if (r) ranks.push({ label: r.label, rank: r.rank, of: r.of, value: r.value, unit: r.unit });
  }
  for (const name of KEY_EXERCISE_NAMES) {
    const ex = await prisma.exercise.findFirst({ where: { orgId, name }, select: { id: true } });
    if (!ex) continue;
    const r = await athleteRank(orgId, athleteId, "E1RM", ex.id).catch(() => null);
    if (r) ranks.push({ label: r.label, rank: r.rank, of: r.of, value: r.value, unit: r.unit });
  }

  return {
    athlete: {
      id: athlete.id,
      firstName: athlete.firstName,
      lastName: athlete.lastName,
      sex: athlete.sex,
      ageYears: ageYears(athlete.birthDate),
      ageGroup: ageGroup(athlete.birthDate),
    },
    plan,
    personalBests,
    recentPRs,
    ranks,
  };
}
