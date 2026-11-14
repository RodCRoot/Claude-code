"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { assignSession, cancelAssignment } from "@/lib/anywhere/assignments";
import { saveAnywhereSettings } from "@/lib/anywhere/common";
import { addStep, createSession, markCompletionReviewed, moveStep, removeStep, updateSession } from "@/lib/anywhere/sessions";

function refresh() {
  revalidatePath("/training/anywhere", "layout");
  revalidatePath("/anywhere", "layout");
  revalidatePath("/today");
}

const sessionFields = (fd: FormData) => ({ ...formToObject(fd), equipment: fd.getAll("equipment").map(String), suitableUnder13: fd.get("suitableUnder13") === "on" });

export const createSessionAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const s = await db.transaction((tx) => createSession(tx, v, { ...sessionFields(fd), status: "draft" }));
  refresh();
  redirect(`/training/anywhere/${s.id}`);
});

export const updateSessionAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const s = await db.transaction((tx) => updateSession(tx, v, String(fd.get("sessionId") ?? ""), sessionFields(fd)));
  refresh();
  return { ok: true, message: s.status === "published" ? "Saved. Athletes can see it." : s.status === "archived" ? "Saved and archived. Athletes no longer see it." : "Saved as a draft. Athletes cannot see it yet." };
});

export const addStepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addStep(tx, v, String(fd.get("sessionId") ?? ""), formToObject(fd)));
  refresh();
  return { ok: true, message: "Step added." };
});

export const stepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const stepId = String(fd.get("stepId") ?? "");
  const what = String(fd.get("do") ?? "");
  if (what === "remove") await db.transaction((tx) => removeStep(tx, v, stepId));
  else if (what === "up" || what === "down") await db.transaction((tx) => moveStep(tx, v, stepId, what));
  else return { ok: false, error: "Unknown action." };
  refresh();
  return { ok: true };
});

export const assignAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const o = formToObject(fd);
  const who = String(o.who ?? "");
  await db.transaction((tx) => assignSession(tx, v, { ...o, athleteId: who.startsWith("athlete:") ? who.slice(8) : null, groupId: who.startsWith("group:") ? who.slice(6) : null }));
  refresh();
  return { ok: true, message: "Assigned. It shows on Athlete Home for those dates." };
});

export const cancelAssignmentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => cancelAssignment(tx, v, String(fd.get("assignmentId") ?? "")));
  refresh();
  return { ok: true, message: "Assignment cancelled." };
});

export const reviewCompletionAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => markCompletionReviewed(tx, v, String(fd.get("completionId") ?? "")));
  refresh();
  return { ok: true };
});

export const anywhereSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveAnywhereSettings(tx, v, { showInSeasonOption: fd.get("showInSeasonOption") === "on" }));
  refresh();
  return { ok: true, message: "Saved." };
});
