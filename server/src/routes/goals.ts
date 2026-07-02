import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, AuthedRequest } from "../auth";
import { pureDate, isDayString } from "../daytime";

export const goalsRouter = Router();
goalsRouter.use(requireAuth);

// Current value for a goal's measure. METRIC → the athlete's best record
// (direction-aware); E1RM → the latest max profile for the exercise.
async function currentValue(goal: { kind: string; athleteId: string; metricTypeId: string | null; exerciseId: string | null }, higherIsBetter: boolean): Promise<number | null> {
  if (goal.kind === "METRIC" && goal.metricTypeId) {
    const agg = await prisma.metricRecord.aggregate({
      where: { athleteId: goal.athleteId, metricTypeId: goal.metricTypeId },
      _max: { value: true },
      _min: { value: true },
    });
    return (higherIsBetter ? agg._max.value : agg._min.value) ?? null;
  }
  if (goal.kind === "E1RM" && goal.exerciseId) {
    const latest = await prisma.maxProfile.findFirst({
      where: { athleteId: goal.athleteId, exerciseId: goal.exerciseId },
      orderBy: { recordedAt: "desc" },
    });
    return latest?.e1rmKg ?? null;
  }
  return null;
}

function crossed(current: number, target: number, higherIsBetter: boolean): boolean {
  return higherIsBetter ? current >= target : current <= target;
}

// Progress toward the target from the captured baseline, clamped to [0, 100].
function progressPct(baseline: number | null, current: number | null, target: number): number | null {
  if (current == null) return null;
  if (baseline == null || baseline === target) return crossed(current, target, target >= (baseline ?? target)) ? 100 : 0;
  const p = ((current - baseline) / (target - baseline)) * 100;
  return Math.max(0, Math.min(100, Math.round(p)));
}

const createSchema = z.object({
  athleteId: z.string().optional(), // athletes may only set their own
  kind: z.enum(["METRIC", "E1RM"]),
  metricTypeId: z.string().optional(),
  exerciseId: z.string().optional(),
  targetValue: z.number().finite(),
  deadline: z.string().refine(isDayString, "yyyy-mm-dd expected").optional(),
  notes: z.string().max(500).optional(),
}).refine((d) => (d.kind === "METRIC" ? !!d.metricTypeId : !!d.exerciseId), {
  message: "metricTypeId required for METRIC goals, exerciseId for E1RM goals",
});

goalsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const athleteId = req.auth!.role === "ATHLETE" ? req.auth!.athleteId! : d.athleteId;
  if (!athleteId) return res.status(400).json({ error: "athleteId required" });
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Athlete not found" });

  let higherIsBetter = true;
  if (d.kind === "METRIC") {
    const mt = await prisma.metricType.findUnique({ where: { id: d.metricTypeId! } });
    if (!mt) return res.status(404).json({ error: "Metric not found" });
    higherIsBetter = mt.higherIsBetter;
  } else {
    const ex = await prisma.exercise.findUnique({ where: { id: d.exerciseId! } });
    if (!ex || ex.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Exercise not found" });
  }

  const baseline = await currentValue({ kind: d.kind, athleteId, metricTypeId: d.metricTypeId ?? null, exerciseId: d.exerciseId ?? null }, higherIsBetter);
  const goal = await prisma.goal.create({
    data: {
      athleteId,
      createdById: req.auth!.userId,
      kind: d.kind,
      metricTypeId: d.metricTypeId,
      exerciseId: d.exerciseId,
      targetValue: d.targetValue,
      baselineValue: baseline,
      deadline: d.deadline ? pureDate(d.deadline) : null,
      notes: d.notes,
    },
  });
  res.status(201).json({ goal });
});

// List goals with live progress. Athletes see their own; staff can filter by
// athlete or see all. Crossing the target auto-achieves + posts to the feed.
goalsRouter.get("/", async (req: AuthedRequest, res) => {
  const isStaff = req.auth!.role === "COACH" || req.auth!.role === "ADMIN";
  const athleteId = isStaff ? (req.query.athleteId ? String(req.query.athleteId) : undefined) : req.auth!.athleteId!;
  const includeArchived = req.query.all === "1";

  const goals = await prisma.goal.findMany({
    where: {
      athlete: { orgId: req.auth!.orgId },
      ...(athleteId ? { athleteId } : {}),
      ...(includeArchived ? {} : { status: { not: "ARCHIVED" } }),
    },
    include: {
      metricType: { select: { name: true, unit: true, higherIsBetter: true } },
      exercise: { select: { name: true } },
      athlete: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  const rows = await Promise.all(goals.map(async (g) => {
    const higherIsBetter = g.metricType?.higherIsBetter ?? true; // e1RM: higher is better
    const current = await currentValue(g, higherIsBetter);
    let status = g.status;
    let achievedAt = g.achievedAt;

    // Auto-achieve the moment the data crosses the target.
    if (status === "ACTIVE" && current != null && crossed(current, g.targetValue, higherIsBetter)) {
      status = "ACHIEVED";
      achievedAt = new Date();
      await prisma.goal.update({ where: { id: g.id }, data: { status, achievedAt } });
      const label = g.kind === "METRIC" ? g.metricType!.name : `${g.exercise!.name} e1RM`;
      const unit = g.kind === "METRIC" ? g.metricType!.unit : "kg";
      await prisma.feedPost.create({
        data: {
          orgId: req.auth!.orgId,
          kind: "GOAL",
          athleteId: g.athleteId,
          title: `${g.athlete.firstName} ${g.athlete.lastName} hit a goal! 🎯`,
          body: `${label}: reached ${current}${unit} (target ${g.targetValue}${unit})`,
          metricLabel: label,
          value: current,
          unit,
        },
      });
    }

    return {
      id: g.id,
      athlete: { id: g.athlete.id, name: `${g.athlete.firstName} ${g.athlete.lastName}` },
      kind: g.kind,
      label: g.kind === "METRIC" ? g.metricType!.name : `${g.exercise!.name} e1RM`,
      unit: g.kind === "METRIC" ? g.metricType!.unit : "kg",
      higherIsBetter,
      baseline: g.baselineValue,
      current,
      target: g.targetValue,
      progressPct: progressPct(g.baselineValue, current, g.targetValue),
      deadline: g.deadline,
      status,
      achievedAt,
      notes: g.notes,
    };
  }));

  res.json({ goals: rows });
});

goalsRouter.post("/:id/archive", async (req: AuthedRequest, res) => {
  const goal = await prisma.goal.findUnique({ where: { id: req.params.id }, include: { athlete: true } });
  if (!goal || goal.athlete.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Goal not found" });
  const isStaff = req.auth!.role === "COACH" || req.auth!.role === "ADMIN";
  if (!isStaff && req.auth!.athleteId !== goal.athleteId) return res.status(403).json({ error: "Forbidden" });
  await prisma.goal.update({ where: { id: goal.id }, data: { status: "ARCHIVED" } });
  res.json({ ok: true });
});
