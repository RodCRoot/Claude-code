import type { Tx } from "@/db";
import { canOnAthlete, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { scopedAthletes } from "./access";
import { bodyHistory } from "./bodymap";
import { isNum, mean } from "./formulas";
import { habitSummaries } from "./habits";
import { athleteMetricSeries, attendanceKpi, strengthPrs } from "./kpis";
import { sharedReportsFor } from "./reports";
import { readinessByDate } from "./wellness";

/** Athletes whose progress the viewer may see (training.read). */
export async function performanceAthletes(tx: Tx, v: Viewer) {
  return scopedAthletes(tx, v, "training.read");
}

/**
 * Family/athlete progress view. Health sections (wellness, body map) are only assembled
 * when the viewer holds health.read on the athlete — e.g. Jordan never receives Maya's body map,
 * and operations staff never receive health data.
 */
export async function performanceSummary(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const from90 = addDaysYmd(today, -89);
  const from28 = addDaysYmd(today, -27);
  const [series, prs, habits, attendance, reports] = await Promise.all([
    athleteMetricSeries(tx, v, athleteId, { from: addDaysYmd(today, -364), to: today }),
    strengthPrs(tx, v, athleteId, { from: from90, to: today }),
    habitSummaries(tx, v, athleteId, from28, today),
    attendanceKpi(tx, v, athleteId, from90, today),
    sharedReportsFor(tx, v, [athleteId]),
  ]);
  let health: null | { readinessMean: number | null; checkins: number; days: number; recentBody: Awaited<ReturnType<typeof bodyHistory>> } = null;
  if (await canOnAthlete(tx, v, athleteId, "health.read")) {
    const r = await readinessByDate(tx, v, athleteId, from28, today);
    const body = await bodyHistory(tx, v, athleteId, 28);
    health = { readinessMean: r ? mean([...r.values()]) : null, checkins: r ? [...r.values()].filter((x) => x !== undefined).length : 0, days: 28, recentBody: body };
  }
  return {
    kpis: series.filter((s) => s.points.some((p) => isNum(p.value)) || s.excludedPoints.length),
    strength: prs,
    habits,
    attendance,
    reports,
    health,
  };
}
