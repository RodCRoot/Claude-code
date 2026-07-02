import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { today, mondayOf, addDays, dayOf, dayLabel, tzOffsetFromReq } from "../daytime";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);
// All analytics are staff-only (team-wide views across athletes).
analyticsRouter.use(requireRole("ADMIN", "COACH"));

// Athletes in the caller's org, optionally filtered by sport.
async function orgAthletes(orgId: string, sport?: string) {
  return prisma.athlete.findMany({
    where: { orgId, ...(sport ? { sport } : {}) },
    select: { id: true, firstName: true, lastName: true, sport: true, position: true, weightKg: true },
  });
}

function isBetter(a: number, b: number, higherIsBetter: boolean) {
  return higherIsBetter ? a > b : a < b;
}

// ---------------------------------------------------------------------------
// Overview: headline counts + activity for the coach landing analytics view.
// ---------------------------------------------------------------------------
analyticsRouter.get("/overview", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const since30 = new Date(Date.now() - 30 * 864e5);

  const athletes = await orgAthletes(orgId);
  const athleteIds = athletes.map((a) => a.id);

  const [recordsTotal, records30, assignments, completed30] = await Promise.all([
    prisma.metricRecord.count({ where: { athleteId: { in: athleteIds } } }),
    prisma.metricRecord.count({ where: { athleteId: { in: athleteIds }, recordedAt: { gte: since30 } } }),
    prisma.workoutAssignment.groupBy({
      by: ["status"],
      where: { athleteId: { in: athleteIds } },
      _count: { _all: true },
    }),
    prisma.workoutAssignment.count({
      where: { athleteId: { in: athleteIds }, status: "COMPLETED", completedAt: { gte: since30 } },
    }),
  ]);

  const byStatus = Object.fromEntries(assignments.map((g) => [g.status, g._count._all]));
  const totalAssigned = (byStatus.ASSIGNED || 0) + (byStatus.IN_PROGRESS || 0) + (byStatus.COMPLETED || 0);
  const completionRate = totalAssigned ? Math.round(((byStatus.COMPLETED || 0) / totalAssigned) * 100) : 0;

  // Sport distribution for a quick roster breakdown.
  const sportCounts: Record<string, number> = {};
  for (const a of athletes) sportCounts[a.sport] = (sportCounts[a.sport] || 0) + 1;

  res.json({
    athleteCount: athletes.length,
    sports: Object.entries(sportCounts).map(([sport, count]) => ({ sport, count })).sort((a, b) => b.count - a.count),
    records: { total: recordsTotal, last30Days: records30 },
    assignments: {
      assigned: byStatus.ASSIGNED || 0,
      inProgress: byStatus.IN_PROGRESS || 0,
      completed: byStatus.COMPLETED || 0,
      completionRate,
      completedLast30Days: completed30,
    },
  });
});

// ---------------------------------------------------------------------------
// Leaderboard: rank athletes by their best value for a metric (direction-aware).
// ---------------------------------------------------------------------------
analyticsRouter.get("/leaderboard", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const metricKey = String(req.query.metricKey || "");
  const sport = req.query.sport ? String(req.query.sport) : undefined;
  const limit = Math.min(Number(req.query.limit) || 25, 100);

  const metric = await prisma.metricType.findUnique({ where: { key: metricKey } });
  if (!metric) return res.status(400).json({ error: "Unknown metric key" });

  const athletes = await orgAthletes(orgId, sport);
  const byId = new Map(athletes.map((a) => [a.id, a]));
  const records = await prisma.metricRecord.findMany({
    where: { athleteId: { in: [...byId.keys()] }, metricTypeId: metric.id },
    select: { athleteId: true, value: true, recordedAt: true },
  });

  // Best (representative) record per athlete.
  const best = new Map<string, { value: number; recordedAt: Date }>();
  for (const r of records) {
    const cur = best.get(r.athleteId);
    if (!cur || isBetter(r.value, cur.value, metric.higherIsBetter)) {
      best.set(r.athleteId, { value: r.value, recordedAt: r.recordedAt });
    }
  }

  const rows = [...best.entries()].map(([athleteId, b]) => {
    const a = byId.get(athleteId)!;
    // Relative-to-bodyweight metrics are ranked per kg so size is fair.
    const ranked = metric.relativeToBw && a.weightKg ? b.value / a.weightKg : b.value;
    return {
      athleteId,
      name: `${a.firstName} ${a.lastName}`,
      sport: a.sport,
      position: a.position,
      value: b.value,
      rankedValue: ranked,
      recordedAt: b.recordedAt,
    };
  });
  rows.sort((x, y) => (metric.higherIsBetter ? y.rankedValue - x.rankedValue : x.rankedValue - y.rankedValue));

  res.json({ metric, rows: rows.slice(0, limit) });
});

// ---------------------------------------------------------------------------
// Trends: team average for a metric, bucketed by month.
// ---------------------------------------------------------------------------
analyticsRouter.get("/trends", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const metricKey = String(req.query.metricKey || "");
  const sport = req.query.sport ? String(req.query.sport) : undefined;
  const months = Math.min(Number(req.query.months) || 12, 36);

  const metric = await prisma.metricType.findUnique({ where: { key: metricKey } });
  if (!metric) return res.status(400).json({ error: "Unknown metric key" });

  const athletes = await orgAthletes(orgId, sport);
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const records = await prisma.metricRecord.findMany({
    where: { athleteId: { in: athletes.map((a) => a.id) }, metricTypeId: metric.id, recordedAt: { gte: since } },
    select: { value: true, recordedAt: true },
  });

  const buckets = new Map<string, { sum: number; n: number }>();
  for (const r of records) {
    const d = r.recordedAt;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const b = buckets.get(key) || { sum: 0, n: 0 };
    b.sum += r.value;
    b.n += 1;
    buckets.set(key, b);
  }
  const points = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, b]) => ({ month, average: Math.round((b.sum / b.n) * 100) / 100, n: b.n }));

  res.json({ metric, points });
});

// ---------------------------------------------------------------------------
// Movers: who's improving / declining on a metric (latest vs earliest in window).
// ---------------------------------------------------------------------------
analyticsRouter.get("/movers", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const metricKey = String(req.query.metricKey || "");
  const sport = req.query.sport ? String(req.query.sport) : undefined;
  const windowDays = Math.min(Number(req.query.windowDays) || 90, 365);

  const metric = await prisma.metricType.findUnique({ where: { key: metricKey } });
  if (!metric) return res.status(400).json({ error: "Unknown metric key" });

  const athletes = await orgAthletes(orgId, sport);
  const byId = new Map(athletes.map((a) => [a.id, a]));
  const since = new Date(Date.now() - windowDays * 864e5);
  const records = await prisma.metricRecord.findMany({
    where: { athleteId: { in: [...byId.keys()] }, metricTypeId: metric.id, recordedAt: { gte: since } },
    orderBy: { recordedAt: "asc" },
    select: { athleteId: true, value: true, recordedAt: true },
  });

  const grouped = new Map<string, { value: number; recordedAt: Date }[]>();
  for (const r of records) {
    const arr = grouped.get(r.athleteId) || [];
    arr.push(r);
    grouped.set(r.athleteId, arr);
  }

  const movers = [...grouped.entries()]
    .filter(([, arr]) => arr.length >= 2)
    .map(([athleteId, arr]) => {
      const first = arr[0];
      const last = arr[arr.length - 1];
      const delta = last.value - first.value;
      const pct = first.value !== 0 ? (delta / Math.abs(first.value)) * 100 : 0;
      // Positive "improvement" respects metric direction (faster sprint = better).
      const improvement = metric.higherIsBetter ? delta : -delta;
      const a = byId.get(athleteId)!;
      return {
        athleteId,
        name: `${a.firstName} ${a.lastName}`,
        sport: a.sport,
        from: first.value,
        to: last.value,
        delta: Math.round(delta * 100) / 100,
        pct: Math.round(pct * 10) / 10,
        improvement,
        samples: arr.length,
      };
    })
    .sort((a, b) => b.improvement - a.improvement);

  res.json({ metric, improving: movers.filter((m) => m.improvement > 0), declining: movers.filter((m) => m.improvement < 0).reverse() });
});

// ---------------------------------------------------------------------------
// Adherence: the coach landing board — "who's training and who's fallen off?".
// Per athlete: workouts completed in each of the last N weeks (Mon–Sun), days
// since their last completed session, and a rolling completion rate.
// ---------------------------------------------------------------------------
analyticsRouter.get("/adherence", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const sport = req.query.sport ? String(req.query.sport) : undefined;
  const weeks = Math.min(Math.max(Number(req.query.weeks) || 4, 1), 8);
  const offset = tzOffsetFromReq(req);

  const athletes = await orgAthletes(orgId, sport);
  const byId = new Map(athletes.map((a) => [a.id, a]));

  // Week starts as day strings in the CLIENT's calendar (Mon–Sun). All
  // bucketing below compares ISO day strings, which order lexically.
  const todayStr = today(offset);
  const mondayStr = mondayOf(todayStr);
  const weekStartStrs: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) weekStartStrs.push(addDays(mondayStr, -i * 7));
  const windowStartStr = weekStartStrs[0];

  const assignments = await prisma.workoutAssignment.findMany({
    where: { athleteId: { in: [...byId.keys()] } },
    select: { athleteId: true, status: true, completedAt: true, assignedDate: true },
  });

  const rows = athletes.map((a) => {
    const mine = assignments.filter((x) => x.athleteId === a.id);
    const buckets = new Array(weeks).fill(0);
    let lastCompletedDay: string | null = null;
    let assignedInWindow = 0;
    let completedOfAssigned = 0;

    for (const x of mine) {
      // assignedDate is a pure date → its day label is offset-independent.
      const assignedDay = x.assignedDate.toISOString().slice(0, 10);
      // Completion rate is coherent: of sessions scheduled in the window (up to
      // today), how many are done? Can never exceed 100%.
      if (assignedDay >= windowStartStr && assignedDay <= todayStr) {
        assignedInWindow += 1;
        if (x.status === "COMPLETED") completedOfAssigned += 1;
      }
      if (x.status === "COMPLETED" && x.completedAt) {
        // completedAt is an instant → convert to the client's calendar day.
        const day = dayOf(x.completedAt, offset);
        if (!lastCompletedDay || day > lastCompletedDay) lastCompletedDay = day;
        if (day >= windowStartStr) {
          for (let w = weeks - 1; w >= 0; w--) {
            if (day >= weekStartStrs[w]) { buckets[w] += 1; break; }
          }
        }
      }
    }

    // Whole-day difference ("trained yesterday evening" = 1d ago).
    const daysSinceLast = lastCompletedDay
      ? Math.round((Date.parse(todayStr) - Date.parse(lastCompletedDay)) / 864e5)
      : null;
    return {
      athleteId: a.id,
      name: `${a.firstName} ${a.lastName}`,
      sport: a.sport,
      weeks: buckets,
      completedInWindow: buckets.reduce((s: number, n: number) => s + n, 0),
      assignedInWindow,
      completionRate: assignedInWindow ? Math.round((completedOfAssigned / assignedInWindow) * 100) : null,
      daysSinceLast,
      // Flag athletes who've gone quiet: no completion in 7+ days (or never).
      atRisk: daysSinceLast === null || daysSinceLast >= 7,
    };
  });

  // Most concerning first: never-trained, then longest since last session.
  rows.sort((x, y) => (y.daysSinceLast ?? 1e9) - (x.daysSinceLast ?? 1e9));

  res.json({
    weekLabels: weekStartStrs.map(dayLabel),
    weekCount: weeks,
    atRiskCount: rows.filter((r) => r.atRisk).length,
    rows,
  });
});

// ---------------------------------------------------------------------------
// Compliance: per-athlete workout completion (covers the coach side of logging).
// ---------------------------------------------------------------------------
analyticsRouter.get("/compliance", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const athletes = await orgAthletes(orgId);
  const byId = new Map(athletes.map((a) => [a.id, a]));

  const assignments = await prisma.workoutAssignment.findMany({
    where: { athleteId: { in: [...byId.keys()] } },
    select: { athleteId: true, status: true, completedAt: true, assignedDate: true },
  });

  const stats = new Map<string, { assigned: number; inProgress: number; completed: number; lastActivity: Date | null }>();
  for (const id of byId.keys()) stats.set(id, { assigned: 0, inProgress: 0, completed: 0, lastActivity: null });
  for (const a of assignments) {
    const s = stats.get(a.athleteId);
    if (!s) continue;
    if (a.status === "COMPLETED") s.completed += 1;
    else if (a.status === "IN_PROGRESS") s.inProgress += 1;
    else s.assigned += 1;
    const activity = a.completedAt || a.assignedDate;
    if (activity && (!s.lastActivity || activity > s.lastActivity)) s.lastActivity = activity;
  }

  const rows = [...stats.entries()]
    .map(([athleteId, s]) => {
      const total = s.assigned + s.inProgress + s.completed;
      const a = byId.get(athleteId)!;
      return {
        athleteId,
        name: `${a.firstName} ${a.lastName}`,
        sport: a.sport,
        total,
        completed: s.completed,
        inProgress: s.inProgress,
        notStarted: s.assigned,
        completionRate: total ? Math.round((s.completed / total) * 100) : 0,
        lastActivity: s.lastActivity,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => a.completionRate - b.completionRate); // lowest compliance first (needs attention)

  res.json({ rows });
});
