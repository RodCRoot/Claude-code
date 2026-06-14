import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, AuthedRequest } from "../auth";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

// Who the caller can message: everyone else in the org with a login.
messagesRouter.get("/recipients", async (req: AuthedRequest, res) => {
  const users = await prisma.user.findMany({
    where: { orgId: req.auth!.orgId, id: { not: req.auth!.userId } },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
  res.json({ recipients: users });
});

// Threads the caller participates in, with the other participants, a preview,
// and an unread count.
messagesRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.auth!.userId;
  const threads = await prisma.messageThread.findMany({
    where: { participants: { some: { userId } } },
    include: {
      participants: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { lastMessageAt: "desc" },
  });
  const userIds = [...new Set(threads.flatMap((t) => t.participants.map((p) => p.userId)))];
  const names = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

  const out = await Promise.all(threads.map(async (t) => {
    const me = t.participants.find((p) => p.userId === userId);
    const others = t.participants.filter((p) => p.userId !== userId).map((p) => names.get(p.userId) ?? "Unknown");
    const unread = await prisma.message.count({
      where: { threadId: t.id, authorUserId: { not: userId }, ...(me?.lastReadAt ? { createdAt: { gt: me.lastReadAt } } : {}) },
    });
    const last = t.messages[0];
    return { id: t.id, with: others.join(", "), preview: last?.body ?? "", lastMessageAt: t.lastMessageAt, unread };
  }));
  res.json({ threads: out });
});

// Find or create a 1:1 thread with another org user, then return its id.
messagesRouter.post("/start", async (req: AuthedRequest, res) => {
  const toUserId = String(req.body?.toUserId || "");
  const me = req.auth!.userId;
  if (!toUserId || toUserId === me) return res.status(400).json({ error: "Invalid recipient" });
  const other = await prisma.user.findUnique({ where: { id: toUserId } });
  if (!other || other.orgId !== req.auth!.orgId) return res.status(404).json({ error: "Recipient not found" });

  // Existing 1:1 thread?
  const mine = await prisma.messageThread.findMany({
    where: { participants: { some: { userId: me } } },
    include: { participants: true },
  });
  const existing = mine.find((t) => t.participants.length === 2 && t.participants.some((p) => p.userId === toUserId));
  if (existing) return res.json({ threadId: existing.id });

  const thread = await prisma.messageThread.create({
    data: {
      orgId: req.auth!.orgId,
      participants: { create: [{ userId: me }, { userId: toUserId }] },
    },
  });
  res.status(201).json({ threadId: thread.id });
});

// Messages in a thread (marks the caller's copy read).
messagesRouter.get("/:id", async (req: AuthedRequest, res) => {
  const part = await prisma.threadParticipant.findUnique({
    where: { threadId_userId: { threadId: req.params.id, userId: req.auth!.userId } },
  });
  if (!part) return res.status(404).json({ error: "Thread not found" });
  const messages = await prisma.message.findMany({
    where: { threadId: req.params.id },
    orderBy: { createdAt: "asc" },
  });
  await prisma.threadParticipant.update({ where: { id: part.id }, data: { lastReadAt: new Date() } });
  res.json({ messages: messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, mine: m.authorUserId === req.auth!.userId })) });
});

const sendSchema = z.object({ body: z.string().min(1) });

messagesRouter.post("/:id", async (req: AuthedRequest, res) => {
  const part = await prisma.threadParticipant.findUnique({
    where: { threadId_userId: { threadId: req.params.id, userId: req.auth!.userId } },
  });
  if (!part) return res.status(404).json({ error: "Thread not found" });
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const msg = await prisma.message.create({
    data: { threadId: req.params.id, authorUserId: req.auth!.userId, body: parsed.data.body },
  });
  await prisma.messageThread.update({ where: { id: req.params.id }, data: { lastMessageAt: new Date() } });
  res.status(201).json({ message: { id: msg.id, body: msg.body, createdAt: msg.createdAt, mine: true } });
});
