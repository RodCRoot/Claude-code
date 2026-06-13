import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);
groupsRouter.use(requireRole("ADMIN", "COACH"));

// List groups in the org with member counts.
groupsRouter.get("/", async (req: AuthedRequest, res) => {
  const groups = await prisma.group.findMany({
    where: { orgId: req.auth!.orgId },
    include: { _count: { select: { memberships: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ groups });
});

const groupSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["TEAM", "PRIVATE", "SQUAD"]).default("TEAM"),
});

groupsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const group = await prisma.group.create({ data: { orgId: req.auth!.orgId, ...parsed.data } });
  res.status(201).json({ group });
});

// Group detail with members.
groupsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const group = await prisma.group.findUnique({
    where: { id: req.params.id },
    include: {
      memberships: {
        include: { athlete: { select: { id: true, firstName: true, lastName: true, sport: true, sex: true } } },
      },
    },
  });
  if (!group || group.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Group not found" });
  res.json({
    group: { id: group.id, name: group.name, type: group.type },
    members: group.memberships.map((m) => m.athlete),
  });
});

groupsRouter.post("/:id/members", async (req: AuthedRequest, res) => {
  const athleteId = String(req.body?.athleteId || "");
  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group || group.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Group not found" });
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete || athlete.orgId !== req.auth!.orgId) return res.status(400).json({ error: "Unknown athlete" });
  await prisma.athleteGroup.upsert({
    where: { groupId_athleteId: { groupId: group.id, athleteId } },
    create: { groupId: group.id, athleteId },
    update: {},
  });
  res.status(201).json({ ok: true });
});

groupsRouter.delete("/:id/members/:athleteId", async (req: AuthedRequest, res) => {
  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group || group.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Group not found" });
  await prisma.athleteGroup.deleteMany({ where: { groupId: group.id, athleteId: req.params.athleteId } });
  res.status(204).end();
});

groupsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const group = await prisma.group.findUnique({ where: { id: req.params.id } });
  if (!group || group.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Group not found" });
  await prisma.group.delete({ where: { id: group.id } });
  res.status(204).end();
});
