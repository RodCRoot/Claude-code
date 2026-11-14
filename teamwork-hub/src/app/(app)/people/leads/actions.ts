"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { assertCan } from "@/lib/authz/policy";
import { convertLead } from "@/lib/crm/convert";
import { createLeadFromInquiry, PREFERRED_TIMES } from "@/lib/crm/intake";
import {
  addLeadNote,
  addLeadTask,
  assignOwner,
  changeStage,
  completeLeadTask,
  markContacted,
  resolveDuplicateFlag,
  scheduleAssessment,
  setLeadTag,
} from "@/lib/crm/leads";
import { createStage, deleteStage, moveStage, updateStage } from "@/lib/crm/stages";
import { bool, domainAction, str, strs } from "@/lib/messaging/action-helpers";
import { startLeadThread } from "@/lib/messaging/threads";

const refresh = (leadId?: string) => {
  revalidatePath("/people/leads");
  if (leadId) revalidatePath(`/people/leads/${leadId}`);
};

export const createLeadAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  assertCan(v, "crm.manage");
  const source = str(fd, "source") || "staff";
  const r = await db.transaction((tx) =>
    createLeadFromInquiry(
      tx,
      v.orgId,
      {
        inquiringFor: str(fd, "inquiringFor") === "self" ? "self" : "child",
        contactFirstName: str(fd, "contactFirstName"),
        contactLastName: str(fd, "contactLastName"),
        email: str(fd, "email"),
        phone: str(fd, "phone"),
        athleteFirstName: str(fd, "athleteFirstName"),
        athleteLastName: str(fd, "athleteLastName"),
        athleteAge: str(fd, "athleteAge"),
        sport: str(fd, "sport"),
        goals: str(fd, "goals"),
        preferredTimes: strs(fd, "preferredTimes").filter((t): t is (typeof PREFERRED_TIMES)[number] => (PREFERRED_TIMES as readonly string[]).includes(t)),
        consentEmail: bool(fd, "consentEmail"),
        consentSms: bool(fd, "consentSms"),
      },
      { source, actorUserId: v.userId, actorRole: v.role },
    ),
  );
  refresh();
  redirect(`/people/leads/${r.leadId}`);
});

export const changeStageAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => changeStage(tx, v, leadId, { stage: str(fd, "stage"), lostReason: str(fd, "lostReason") || undefined }));
  refresh(leadId);
  return { ok: true, message: "Stage updated." };
});

export const assignOwnerAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => assignOwner(tx, v, leadId, str(fd, "ownerUserId") || null));
  refresh(leadId);
  return { ok: true, message: "Owner updated." };
});

export const addNoteAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => addLeadNote(tx, v, leadId, str(fd, "body")));
  refresh(leadId);
  return { ok: true, message: "Note added." };
});

export const addTaskAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => addLeadTask(tx, v, leadId, { title: str(fd, "title"), dueDate: str(fd, "dueDate"), assigneeUserId: str(fd, "assigneeUserId") }));
  refresh(leadId);
  return { ok: true, message: "Task added." };
});

export const toggleTaskAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => completeLeadTask(tx, v, str(fd, "taskId"), str(fd, "done") === "1"));
  refresh(str(fd, "leadId"));
  return { ok: true };
});

export const markContactedAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => markContacted(tx, v, leadId, str(fd, "method")));
  refresh(leadId);
  return { ok: true, message: "Logged contact." };
});

export const scheduleAssessmentAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => scheduleAssessment(tx, v, leadId, str(fd, "sessionId") || null));
  refresh(leadId);
  return { ok: true, message: str(fd, "sessionId") ? "Assessment scheduled." : "Assessment cleared." };
});

export const setTagAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => setLeadTag(tx, v, leadId, str(fd, "tagId"), str(fd, "on") === "1"));
  refresh(leadId);
  return { ok: true };
});

export const resolveDuplicateAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) => resolveDuplicateFlag(tx, v, leadId, str(fd, "note")));
  refresh(leadId);
  return { ok: true, message: "Marked as reviewed." };
});

export const convertLeadAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  await db.transaction((tx) =>
    convertLead(tx, v, {
      leadId,
      athleteChoice: str(fd, "athleteChoice") || undefined,
      guardianChoice: str(fd, "guardianChoice") || undefined,
      household: str(fd, "household") || "new",
      payer: str(fd, "payer") || "new",
      dateOfBirth: str(fd, "dateOfBirth"),
      sport: str(fd, "sport"),
      relationship: str(fd, "relationship") || "parent",
    }),
  );
  refresh(leadId);
  redirect(`/people/leads/${leadId}?converted=1`);
});

export const messageLeadAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  const leadId = str(fd, "leadId");
  const r = await db.transaction((tx) =>
    startLeadThread(tx, v, {
      leadId,
      subject: str(fd, "subject"),
      body: str(fd, "body"),
      channels: strs(fd, "channels").filter((c): c is "email" | "sms" => c === "email" || c === "sms"),
      clientMutationId: str(fd, "clientMutationId") || randomUUID(),
    }),
  );
  refresh(leadId);
  redirect(`/messages/${r.threadId}`);
});

// --- Stage settings ---------------------------------------------------------------------

const stageKind = (fd: FormData) => (["won", "lost"].includes(str(fd, "kind")) ? (str(fd, "kind") as "won" | "lost") : "open");

export const createStageAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => createStage(tx, v, { label: str(fd, "label"), kind: stageKind(fd) }));
  refresh();
  return { ok: true, message: "Stage added." };
});

export const updateStageAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => updateStage(tx, v, str(fd, "stageId"), { label: str(fd, "label"), kind: stageKind(fd) }));
  refresh();
  return { ok: true, message: "Saved." };
});

export const moveStageAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => moveStage(tx, v, str(fd, "stageId"), str(fd, "dir") === "up" ? "up" : "down"));
  refresh();
  return { ok: true };
});

export const deleteStageAction = domainAction(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteStage(tx, v, str(fd, "stageId")));
  refresh();
  return { ok: true, message: "Stage deleted." };
});
