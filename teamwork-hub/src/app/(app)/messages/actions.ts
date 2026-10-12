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
import { approveCampaign, cancelCampaign, createCampaign, rejectCampaign, submitCampaign, updateCampaign } from "@/lib/messaging/campaigns";
import { DomainError } from "@/lib/messaging/errors";
import { attachInbound, dismissInbound } from "@/lib/messaging/inbound";
import { cancelJob, retryJob } from "@/lib/messaging/outbox";
import { clearUndeliverable, staffRecordConsent, updateMyPreferences } from "@/lib/messaging/preferences";
import { archiveSegment, createSegment, filtersFromFields, updateSegment } from "@/lib/messaging/segments";
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

// --- Communication preferences --------------------------------------------------------------

export const updatePreferencesAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const r = await db.transaction((tx) =>
    updateMyPreferences(tx, v, {
      email: str(fd, "email") || undefined,
      sms: str(fd, "sms") || undefined,
      quietMode: str(fd, "quietMode") === "custom" ? "custom" : "facility",
      quietStart: str(fd, "quietStart"),
      quietEnd: str(fd, "quietEnd"),
    } as Parameters<typeof updateMyPreferences>[2]),
  );
  revalidatePath("/messages/preferences");
  return { ok: true, message: r.changes.length ? `Saved: ${r.changes.join(" · ")}` : "No changes." };
});

export const staffRecordConsentAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const personId = str(fd, "personId");
  const r = await db.transaction((tx) =>
    staffRecordConsent(tx, v, {
      personId,
      channel: str(fd, "channel") === "sms" ? "sms" : "email",
      consent: str(fd, "consent") === "opted_in" ? "opted_in" : "opted_out",
      note: str(fd, "note"),
    }),
  );
  revalidatePath(`/people/${personId}`);
  return { ok: true, message: r.changed ? "Consent recorded." : "That was already on file." };
});

export const clearUndeliverableAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => clearUndeliverable(tx, v, str(fd, "id")));
  revalidatePath(`/people/${str(fd, "personId")}`);
  return { ok: true, message: "Flag cleared. Email will be attempted again." };
});

// --- Segments & campaigns -------------------------------------------------------------------

const segmentInput = (fd: FormData) => ({
  name: str(fd, "name"),
  description: str(fd, "description"),
  filters: filtersFromFields((k) => str(fd, k) || undefined),
});

export const saveSegmentAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const id = str(fd, "segmentId");
  if (id) {
    await db.transaction((tx) => updateSegment(tx, v, id, segmentInput(fd)));
    revalidatePath("/messages/segments");
    return { ok: true, message: "Segment saved." };
  }
  const row = await db.transaction((tx) => createSegment(tx, v, segmentInput(fd)));
  revalidatePath("/messages/segments");
  redirect(`/messages/segments/${row.id}`);
});

export const archiveSegmentAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => archiveSegment(tx, v, str(fd, "segmentId")));
  revalidatePath("/messages/segments");
  redirect("/messages/segments");
});

const campaignInput = (fd: FormData) => ({
  name: str(fd, "name"),
  templateId: str(fd, "templateId"),
  segmentId: str(fd, "segmentId"),
  channels: ext(fd),
  scheduledLocal: str(fd, "scheduledLocal"),
});

export const saveCampaignAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const id = str(fd, "campaignId");
  if (id) {
    await db.transaction((tx) => updateCampaign(tx, v, id, campaignInput(fd)));
    revalidatePath(`/messages/campaigns/${id}`);
    revalidatePath("/messages/campaigns");
    return { ok: true, message: "Saved as draft." };
  }
  const row = await db.transaction((tx) => createCampaign(tx, v, campaignInput(fd)));
  revalidatePath("/messages/campaigns");
  redirect(`/messages/campaigns/${row.id}`);
});

export const campaignStepAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const id = str(fd, "campaignId");
  const step = str(fd, "step");
  const messages: Record<string, string> = {
    submit: "Submitted. An owner or admin must approve it before anything is sent.",
    approve: "Approved. The job worker sends it at the scheduled time (or now) — consent and quiet hours are re-checked per recipient.",
    reject: "Returned to draft with your note.",
    cancel: "Cancelled. Nothing more will be sent.",
  };
  await db.transaction(async (tx) => {
    if (step === "submit") await submitCampaign(tx, v, id);
    else if (step === "approve") await approveCampaign(tx, v, id);
    else if (step === "reject") await rejectCampaign(tx, v, id, str(fd, "note"));
    else if (step === "cancel") await cancelCampaign(tx, v, id);
    else throw new DomainError("Unknown step.");
  });
  revalidatePath(`/messages/campaigns/${id}`);
  revalidatePath("/messages/campaigns");
  return { ok: true, message: messages[step] };
});

// --- Unmatched inbound ----------------------------------------------------------------------

export const attachInboundAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => attachInbound(tx, v, str(fd, "inboundId"), str(fd, "threadId")));
  revalidatePath("/messages/unmatched");
  redirect(`/messages/${r.threadId}`);
});

export const dismissInboundAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => dismissInbound(tx, v, str(fd, "inboundId")));
  revalidatePath("/messages/unmatched");
  return { ok: true, message: "Dismissed." };
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
