"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { assertCan } from "@/lib/authz/policy";
import { createRule, deleteRule, setRuleEnabled, updateRule } from "@/lib/automation/rules";
import { createTemplate, deleteTemplate, updateTemplate } from "@/lib/automation/templates";
import { enqueue } from "@/lib/jobs";
import { bool, domainAction, str, strs } from "@/lib/messaging/action-helpers";
import { cancelJob, retryJob } from "@/lib/messaging/outbox";
import { assignThread, postMessage, setThreadStatus, startFamilyThread, startStaffThread } from "@/lib/messaging/threads";

const ext = (fd: FormData) => strs(fd, "channels").filter((c): c is "email" | "sms" => c === "email" || c === "sms");
const cmid = (fd: FormData) => str(fd, "clientMutationId") || undefined;

export const replyAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const threadId = str(fd, "threadId");
  const internal = str(fd, "kind") === "internal";
  const r = await db.transaction((tx) => postMessage(tx, v, { threadId, body: str(fd, "body"), internal, channels: internal ? [] : ext(fd), clientMutationId: cmid(fd) }));
  revalidatePath(`/messages/${threadId}`);
  revalidatePath("/messages");
  return { ok: true, message: r.duplicate ? "Already sent." : internal ? "Internal note saved (never sent to families)." : "Sent." };
});

export const startStaffThreadAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const r = await db.transaction((tx) =>
    startStaffThread(tx, v, {
      athleteId: str(fd, "athleteId"),
      subject: str(fd, "subject"),
      body: str(fd, "body"),
      channels: ext(fd),
      mode: str(fd, "mode") === "group" ? "group" : "separate",
      clientMutationId: cmid(fd),
    }),
  );
  revalidatePath("/messages");
  redirect(r.threadIds.length === 1 ? `/messages/${r.threadIds[0]}` : `/messages?started=${r.threadIds.length}`);
});

export const startFamilyThreadAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => startFamilyThread(tx, v, { athleteId: str(fd, "athleteId"), subject: str(fd, "subject"), body: str(fd, "body"), clientMutationId: cmid(fd) }));
  revalidatePath("/messages");
  redirect(`/messages/${r.threadId}`);
});

export const assignAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const threadId = str(fd, "threadId");
  const userId = str(fd, "userId") === "me" ? v.userId : str(fd, "userId") || null;
  await db.transaction((tx) => assignThread(tx, v, threadId, userId));
  revalidatePath(`/messages/${threadId}`);
  return { ok: true, message: "Assignment updated." };
});

export const statusAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const threadId = str(fd, "threadId");
  await db.transaction((tx) => setThreadStatus(tx, v, threadId, str(fd, "status") === "closed" ? "closed" : "open"));
  revalidatePath(`/messages/${threadId}`);
  revalidatePath("/messages");
  return { ok: true };
});

// --- Templates ------------------------------------------------------------------------------

const templateInput = (fd: FormData) => ({
  name: str(fd, "name"),
  channel: (["in_app", "email", "sms"].includes(str(fd, "channel")) ? str(fd, "channel") : "in_app") as "in_app" | "email" | "sms",
  subject: str(fd, "subject"),
  body: str(fd, "body"),
  isSample: bool(fd, "isSample"),
});

export const createTemplateAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => createTemplate(tx, v, templateInput(fd)));
  revalidatePath("/messages/templates");
  redirect("/messages/templates");
});

export const updateTemplateAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => updateTemplate(tx, v, str(fd, "templateId"), templateInput(fd)));
  revalidatePath("/messages/templates");
  return { ok: true, message: "Template saved." };
});

export const deleteTemplateAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteTemplate(tx, v, str(fd, "templateId")));
  revalidatePath("/messages/templates");
  redirect("/messages/templates");
});

// --- Automation rules -----------------------------------------------------------------------

const ruleInput = (fd: FormData) => ({
  name: str(fd, "name"),
  trigger: str(fd, "trigger") as never,
  templateId: str(fd, "templateId"),
  channels: strs(fd, "channels").filter((c): c is "in_app" | "email" | "sms" => ["in_app", "email", "sms"].includes(c)),
  delayMinutes: str(fd, "delayMinutes") || "0",
  createTask: bool(fd, "createTask"),
  days: str(fd, "days"),
  sport: str(fd, "sport"),
  serviceKind: str(fd, "serviceKind"),
});

export const createRuleAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => createRule(tx, v, ruleInput(fd)));
  revalidatePath("/messages/automations");
  redirect(`/messages/automations/${r.id}`);
});

export const updateRuleAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => updateRule(tx, v, str(fd, "ruleId"), ruleInput(fd)));
  revalidatePath("/messages/automations");
  return { ok: true, message: "Rule saved." };
});

export const toggleRuleAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const ruleId = str(fd, "ruleId");
  const enabled = str(fd, "enabled") === "1";
  await db.transaction((tx) => setRuleEnabled(tx, v, ruleId, enabled));
  revalidatePath("/messages/automations");
  revalidatePath(`/messages/automations/${ruleId}`);
  return { ok: true, message: enabled ? "Enabled. It will act on new events and the next scan." : "Disabled. Queued sends for this rule will be skipped." };
});

export const deleteRuleAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteRule(tx, v, str(fd, "ruleId")));
  revalidatePath("/messages/automations");
  redirect("/messages/automations");
});

export const evaluateNowAction = domainAction(async (): Promise<ActionState> => {
  const v = await requireViewer();
  assertCan(v, "crm.manage");
  const minute = new Date().toISOString().slice(0, 16);
  const id = await enqueue(db, { type: "automation.evaluate", orgId: v.orgId, payload: { orgId: v.orgId }, dedupeKey: `automation.evaluate:manual:${v.orgId}:${minute}` });
  revalidatePath("/messages/outbox");
  return { ok: true, message: id ? "Scan queued. The job worker (pnpm jobs:work) will evaluate enabled rules." : "A scan was already queued this minute." };
});

// --- Outbox ---------------------------------------------------------------------------------

export const retryJobAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => retryJob(tx, v, str(fd, "jobId")));
  revalidatePath("/messages/outbox");
  return { ok: true, message: "Re-queued." };
});

export const cancelJobAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => cancelJob(tx, v, str(fd, "jobId")));
  revalidatePath("/messages/outbox");
  return { ok: true, message: "Cancelled." };
});
