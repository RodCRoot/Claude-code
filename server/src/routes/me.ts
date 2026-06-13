import { Router } from "express";
import { requireAuth, AuthedRequest } from "../auth";
import { buildToday } from "../today";

export const meRouter = Router();
meRouter.use(requireAuth);

// The signed-in athlete's "Today" view (plan + targets + PBs + ranks).
meRouter.get("/today", async (req: AuthedRequest, res) => {
  if (!req.auth!.athleteId) return res.status(400).json({ error: "Not an athlete account" });
  const data = await buildToday(req.auth!.athleteId);
  if (!data) return res.status(404).json({ error: "Athlete not found" });
  res.json(data);
});
