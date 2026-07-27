import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, AuthedRequest } from "../auth";
import { leaderboard, LeaderKind } from "../leaderboards";
import { AGE_GROUPS } from "../prescription";

export const leaderboardsRouter = Router();
leaderboardsRouter.use(requireAuth);

// What can be ranked: the test metrics, plus exercises that have any e1RM data.
leaderboardsRouter.get("/options", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.orgId;
  const metrics = await prisma.metricType.findMany({
    orderBy: { name: "asc" },
    select: { key: true, name: true, unit: true },
  });
  const maxed = await prisma.maxProfile.findMany({
    where: { athlete: { orgId } },
    distinct: ["exerciseId"],
    select: { exercise: { select: { id: true, name: true } } },
  });
  res.json({
    metrics: metrics.map((m) => ({ kind: "METRIC", key: m.key, label: m.name, unit: m.unit })),
    exercises: maxed.map((m) => ({ kind: "E1RM", key: m.exercise.id, label: `${m.exercise.name} e1RM`, unit: "kg" })),
    ageGroups: AGE_GROUPS,
    sexes: ["M", "F"],
  });
});

// A ranked board, optionally filtered to an age group and/or sex.
leaderboardsRouter.get("/", async (req: AuthedRequest, res) => {
  const kind = (String(req.query.kind || "METRIC").toUpperCase() === "E1RM" ? "E1RM" : "METRIC") as LeaderKind;
  const key = String(req.query.key || "");
  if (!key) return res.status(400).json({ error: "key is required" });
  const ageGroup = req.query.ageGroup ? String(req.query.ageGroup) : undefined;
  const sex = req.query.sex ? String(req.query.sex) : undefined;
  try {
    const board = await leaderboard(req.auth!.orgId, kind, key, { ageGroup, sex });
    res.json(board);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
