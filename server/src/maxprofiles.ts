// Prisma-backed helpers for athlete max/e1RM profiles. Kept separate from the
// pure-math prescription.ts so that module stays dependency-free and testable.
import { prisma } from "./db";

// Most-recent estimated 1RM per exercise for an athlete → { exerciseId: e1rmKg }.
export async function latestMaxesByExercise(athleteId: string): Promise<Record<string, number>> {
  const maxes = await prisma.maxProfile.findMany({
    where: { athleteId },
    orderBy: { recordedAt: "desc" },
    select: { exerciseId: true, e1rmKg: true },
  });
  const out: Record<string, number> = {};
  for (const m of maxes) {
    if (!(m.exerciseId in out)) out[m.exerciseId] = m.e1rmKg; // first = most recent
  }
  return out;
}
