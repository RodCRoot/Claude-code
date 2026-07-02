import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";
import { pureDate, isDayString, today, addDays, tzOffsetFromReq } from "../daytime";

export const wellnessRouter = Router();
wellnessRouter.use(requireAuth);

// Readiness 0-100 from the available inputs. Soreness/stress are inverted (high
// = worse); sleep hours map 4h→0 … 8h+→100. Averages whatever was provided.
export function computeReadiness(i: {
  sleepHours?: number | null; sleepQuality?: number | null; soreness?: number | null;
  mood?: number | null; energy?: number | null; stress?: number | null;
}): number | null {
  const parts: number[] = [];
  const up = (v?: number | null) => { if (v != null) parts.push(((v - 1) / 4) * 100); };
  const down = (v?: number | null) => { if (v != null) parts.push(((5 - v) / 4) * 100); };
  up(i.sleepQuality); up(i.mood); up(i.energy); down(i.soreness); down(i.stress);
  if (i.sleepHours != null) parts.push(Math.max(0, Math.min(100, ((i.sleepHours - 4) / 4) * 100)));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

const checkinSchema = z.object({
  athleteId: z.string().optional(), // coaches may submit for an athlete
  date: z.string().refine(isDayString, "yyyy-mm-dd expected").optional(),
  sleepHours: z.number().min(0).max(24).optional(),
  sleepQuality: z.number().int().min(1).max(5).optional(),
  soreness: z.number().int().min(1).max(5).optional(),
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  stress: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),
});

// Submit (upsert) a check-in for a day. Athletes submit their own.
wellnessRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = checkinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  let athleteId = req.auth!.athleteId || "";
  if (req.auth!.role !== "ATHLETE") {
    if (!d.athleteId) return res.status(400).json({ error: "athleteId required" });
    athleteId = d.athleteId;
  }
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Athlete not found" });

  // The check-in day is the client's calendar day, stored as a pure date
  // (UTC midnight) so per-day uniqueness is viewer-independent.
  const date = pureDate(d.date ?? today(tzOffsetFromReq(req)));
  const readiness = computeReadiness(d);
  const fields = { sleepHours: d.sleepHours, sleepQuality: d.sleepQuality, soreness: d.soreness, mood: d.mood, energy: d.energy, stress: d.stress, notes: d.notes, readiness };

  const checkin = await prisma.wellnessCheckin.upsert({
    where: { athleteId_date: { athleteId, date } },
    create: { athleteId, date, ...fields },
    update: fields,
  });
  res.status(201).json({ checkin });
});

// The signed-in athlete's recent check-ins (+ whether today is done).
wellnessRouter.get("/me", async (req: AuthedRequest, res) => {
  if (!req.auth!.athleteId) return res.status(400).json({ error: "Not an athlete account" });
  const days = Math.min(Number(req.query.days) || 30, 120);
  const todayStr = today(tzOffsetFromReq(req));
  const checkins = await prisma.wellnessCheckin.findMany({
    where: { athleteId: req.auth!.athleteId, date: { gte: pureDate(addDays(todayStr, -days)) } },
    orderBy: { date: "asc" },
  });
  res.json({
    checkins,
    submittedToday: checkins.some((c) => c.date.toISOString().slice(0, 10) === todayStr),
  });
});

// Coach readiness board: each athlete's latest check-in, lowest readiness first.
wellnessRouter.get("/flags", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const athletes = await prisma.athlete.findMany({
    where: { orgId: req.auth!.orgId },
    select: { id: true, firstName: true, lastName: true, sport: true },
  });
  // Latest check-in per athlete in a single query (distinct keeps the first
  // row per athleteId under the date-desc ordering).
  const latests = await prisma.wellnessCheckin.findMany({
    where: { athleteId: { in: athletes.map((a) => a.id) } },
    orderBy: [{ athleteId: "asc" }, { date: "desc" }],
    distinct: ["athleteId"],
  });
  const latestBy = new Map(latests.map((c) => [c.athleteId, c]));
  const rows = athletes.map((a) => {
    const latest = latestBy.get(a.id);
    return {
      athleteId: a.id, name: `${a.firstName} ${a.lastName}`, sport: a.sport,
      readiness: latest?.readiness ?? null, soreness: latest?.soreness ?? null,
      date: latest?.date ?? null, notes: latest?.notes ?? null,
    };
  });
  rows.sort((x, y) => (x.readiness ?? 999) - (y.readiness ?? 999));
  res.json({ rows });
});

// Coach view of one athlete's history.
wellnessRouter.get("/athlete/:id", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const athlete = await prisma.athlete.findUnique({ where: { id: req.params.id } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Athlete not found" });
  const checkins = await prisma.wellnessCheckin.findMany({ where: { athleteId: req.params.id }, orderBy: { date: "asc" }, take: 60 });
  res.json({ checkins });
});
