// Team feed: system-generated PR posts + coach announcements.
import { prisma } from "./db";

async function createPR(athleteId: string, label: string, value: number, unit: string) {
  const athlete = await prisma.athlete.findUnique({
    where: { id: athleteId },
    select: { orgId: true, firstName: true, lastName: true },
  });
  if (!athlete) return;
  await prisma.feedPost.create({
    data: {
      orgId: athlete.orgId,
      kind: "PR",
      athleteId,
      title: `${athlete.firstName} ${athlete.lastName} set a new PR`,
      metricLabel: label,
      value,
      unit,
    },
  });
}

// Post a PR if `value` beats the athlete's prior best for this metric. The first
// ever result is not treated as a PR (no prior to beat).
export async function maybeMetricPR(
  athleteId: string,
  metric: { id: string; name: string; unit: string; higherIsBetter: boolean },
  value: number,
  excludeRecordId?: string
) {
  const priors = await prisma.metricRecord.findMany({
    where: { athleteId, metricTypeId: metric.id, ...(excludeRecordId ? { id: { not: excludeRecordId } } : {}) },
    select: { value: true },
  });
  if (priors.length === 0) return;
  const prevBest = priors.reduce((b, r) => (metric.higherIsBetter ? Math.max(b, r.value) : Math.min(b, r.value)), priors[0].value);
  const isBetter = metric.higherIsBetter ? value > prevBest : value < prevBest;
  if (isBetter) await createPR(athleteId, metric.name, value, metric.unit);
}

// Post a PR if a new e1RM beats the athlete's prior best for the exercise.
export async function maybeE1rmPR(
  athleteId: string,
  exercise: { id: string; name: string },
  e1rmKg: number,
  excludeMaxId?: string
) {
  const priors = await prisma.maxProfile.findMany({
    where: { athleteId, exerciseId: exercise.id, ...(excludeMaxId ? { id: { not: excludeMaxId } } : {}) },
    select: { e1rmKg: true },
  });
  if (priors.length === 0) return;
  const prevBest = Math.max(...priors.map((p) => p.e1rmKg));
  if (e1rmKg > prevBest) await createPR(athleteId, `${exercise.name} e1RM`, e1rmKg, "kg");
}
