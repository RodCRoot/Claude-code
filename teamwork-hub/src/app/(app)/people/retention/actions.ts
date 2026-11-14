"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { saveRetentionSettings } from "@/lib/retention/common";
import { createShoutoutTask } from "@/lib/retention/milestones";
import { createFollowUpTask, logOutcome } from "@/lib/retention/save-log";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export const createFollowUpTaskAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const kind = str(fd, "kind") === "winback" ? "winback" : "follow_up";
  const r = await db.transaction((tx) => createFollowUpTask(tx, v, { athleteId: str(fd, "athleteId"), kind }));
  revalidatePath("/people/retention", "layout");
  revalidatePath("/people/tasks");
  return { ok: true, message: r.created ? "Task created and assigned to you (see Tasks)." : "A follow-up task was already created today." };
});

export const logOutcomeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) =>
    logOutcome(tx, v, {
      athleteId: str(fd, "athleteId"),
      action: str(fd, "action"),
      outcome: str(fd, "outcome"),
      reasonCode: str(fd, "reasonCode") || undefined,
      notes: str(fd, "notes") || undefined,
    }),
  );
  revalidatePath("/people/retention", "layout");
  return { ok: true, message: "Outcome logged." };
});

export const createShoutoutTaskAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => createShoutoutTask(tx, v, { athleteId: str(fd, "athleteId"), key: str(fd, "key") }));
  revalidatePath("/today");
  revalidatePath("/people/tasks");
  return { ok: true, message: r.created ? "Shoutout task created." : "A shoutout task already exists." };
});

export const saveRetentionSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => saveRetentionSettings(tx, v, formToObject(fd)));
  if (!r.ok) return { ok: false, error: "Check the highlighted retention values.", fieldErrors: r.errors };
  revalidatePath("/settings");
  revalidatePath("/people/retention", "layout");
  return { ok: true, message: "Retention thresholds saved." };
});
