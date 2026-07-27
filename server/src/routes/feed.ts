import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRole, AuthedRequest } from "../auth";

export const feedRouter = Router();
feedRouter.use(requireAuth);

// Recent team feed (PRs + announcements) for the caller's org.
feedRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const posts = await prisma.feedPost.findMany({
    where: { orgId: req.auth!.orgId },
    include: {
      athlete: { select: { firstName: true, lastName: true } },
      reactions: { select: { userId: true, emoji: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  res.json({
    posts: posts.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.title,
      body: p.body,
      metricLabel: p.metricLabel,
      value: p.value,
      unit: p.unit,
      athleteName: p.athlete ? `${p.athlete.firstName} ${p.athlete.lastName}` : null,
      createdAt: p.createdAt,
      reactions: p.reactions.length,
      reacted: p.reactions.some((r) => r.userId === userId),
    })),
  });
});

const announceSchema = z.object({ title: z.string().min(1), body: z.string().optional() });

// Coaches post announcements to the org feed.
feedRouter.post("/", requireRole("ADMIN", "COACH"), async (req: AuthedRequest, res) => {
  const parsed = announceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const post = await prisma.feedPost.create({
    data: {
      orgId: req.auth!.orgId,
      kind: "ANNOUNCEMENT",
      authorUserId: req.auth!.userId,
      title: parsed.data.title,
      body: parsed.data.body,
    },
  });
  res.status(201).json({ post });
});

// Toggle a "fist bump" on a post.
feedRouter.post("/:id/react", async (req: AuthedRequest, res) => {
  const post = await prisma.feedPost.findUnique({ where: { id: req.params.id }, select: { orgId: true } });
  if (!post || post.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Post not found" });
  const where = { postId_userId_emoji: { postId: req.params.id, userId: req.auth!.userId, emoji: "👊" } };
  const existing = await prisma.feedReaction.findUnique({ where });
  if (existing) {
    await prisma.feedReaction.delete({ where });
    res.json({ reacted: false });
  } else {
    await prisma.feedReaction.create({ data: { postId: req.params.id, userId: req.auth!.userId, emoji: "👊" } });
    res.json({ reacted: true });
  }
});
