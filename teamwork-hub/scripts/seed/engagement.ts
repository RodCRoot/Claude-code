import { and, asc, desc, eq } from "drizzle-orm";
import { athleteGoals, athletes, exercises, maxes } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { createGoal, setGoalStatus } from "../../src/lib/engagement/goals";
import { refreshEngagement } from "../../src/lib/engagement/sync";
import { athleteMetricSeries } from "../../src/lib/science/kpis";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic engagement demo data: a few goals for demo athletes, then XP and badges derived from
 * whatever the other module seeds created (attendance, workouts, check-ins, maxes, forms).
 * Safe when those modules were not seeded: every step is skipped if its source rows are missing.
 */
export async function seedEngagement(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const owner: Viewer = { userId: ctx.users.rod, orgId, role: "owner", personId: ctx.people.rod ?? null, displayName: "Rod (Owner)", mfaVerified: true };

  /** A max goal a little above the athlete's best, with the older max as the starting value. */
  async function maxGoal(athleteKey: string, lift: string, add: number, title: (target: number, unit: string) => string, dueInDays: number) {
    const athleteId = ctx.athletes[athleteKey];
    if (!athleteId) return;
    const [ex] = await tx.select().from(exercises).where(and(eq(exercises.orgId, orgId), eq(exercises.name, lift)));
    if (!ex) return;
    const rows = await tx.select().from(maxes).where(and(eq(maxes.athleteId, athleteId), eq(maxes.exerciseId, ex.id))).orderBy(asc(maxes.recordedOn));
    if (!rows.length) return;
    const best = Math.max(...rows.map((r) => Number(r.value)));
    const g = await createGoal(tx, owner, { athleteId, title: title(best + add, rows[0].unit), link: `exercise:${ex.id}`, targetValue: best + add, targetUnit: rows[0].unit, targetDate: addDaysYmd(today, dueInDays) }, today);
    // Demo only: start the goal from the athlete's earlier max so the progress bar has something to show.
    if (Number(rows[0].value) < best) await tx.update(athleteGoals).set({ baselineValue: Number(rows[0].value) }).where(eq(athleteGoals.id, g.id));
  }

  /** A goal on the first test metric the athlete has a comparable trend for. */
  async function metricGoal(athleteKey: string, dueInDays: number) {
    const athleteId = ctx.athletes[athleteKey];
    if (!athleteId) return;
    const series = await athleteMetricSeries(tx, owner, athleteId);
    const s = series.find((x) => x.latest && x.metric.higherIsBetter !== null && x.latest.value! > 0 && x.points.filter((p) => p.value !== null).length >= 2);
    if (!s?.latest) return;
    const up = s.metric.higherIsBetter!;
    const factor = up ? 1.05 : 0.97;
    const digits = Math.min(3, s.metric.precision);
    const target = Number((s.latest.value! * factor).toFixed(digits));
    if (target === s.latest.value) return;
    const g = await createGoal(tx, owner, { athleteId, title: `${up ? "Raise" : "Lower"} ${s.metric.name} to ${target} ${s.metric.unit}`, link: `metric:${s.metric.id}`, targetValue: target, targetDate: addDaysYmd(today, dueInDays) }, today);
    // Demo only: use the first comparable session of the same trend as the starting value.
    const first = s.points.find((p) => p.value !== null);
    if (first && first.value !== s.latest.value) await tx.update(athleteGoals).set({ baselineValue: first.value }).where(eq(athleteGoals.id, g.id));
  }

  async function manualGoal(athleteKey: string, title: string, dueInDays: number | null, done = false) {
    const athleteId = ctx.athletes[athleteKey];
    if (!athleteId) return;
    const g = await createGoal(tx, owner, { athleteId, title, targetDate: dueInDays === null ? undefined : addDaysYmd(today, dueInDays) }, today);
    if (done) await setGoalStatus(tx, owner, g.id, "achieve");
  }

  await maxGoal("maya", "Back Squat", 15, (t, u) => `Squat ${t} ${u}`, 45);
  await metricGoal("maya", 60);
  await manualGoal("maya", "Make the varsity roster (sample goal)", 75);
  await manualGoal("maya", "Three sessions a week for a month (sample goal)", null, true);
  await manualGoal("eli", "Learn the hang clean with good form (sample goal)", 30);
  await maxGoal("leo", "Power Clean", 10, (t, u) => `Power clean ${t} ${u}`, 40);
  await metricGoal("dana", 50);

  // Derive XP and badges for every athlete from the rows the other seeds created.
  const all = await tx.select({ id: athletes.id }).from(athletes).where(eq(athletes.orgId, orgId)).orderBy(desc(athletes.createdAt));
  for (const a of all) await refreshEngagement(tx, orgId, a.id, { today });
}
