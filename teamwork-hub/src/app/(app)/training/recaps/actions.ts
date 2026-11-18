"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, type ActionState } from "@/lib/actions";
import { finalizeRecapByStaff, saveCoachNote } from "@/lib/showcase/recap";

/** saveCoachNote re-checks coach scope (training.write) over the submitted athlete id. */
export const saveCoachNoteAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveCoachNote(tx, v, { athleteId: String(fd.get("athleteId") ?? ""), month: String(fd.get("month") ?? ""), note: String(fd.get("note") ?? "") }));
  revalidatePath("/training/recaps");
  revalidatePath("/recap");
  return { ok: true, message: "Note saved." };
});

export const finalizeRecapAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => finalizeRecapByStaff(tx, v, String(fd.get("athleteId") ?? ""), String(fd.get("month") ?? "")));
  revalidatePath("/training/recaps");
  revalidatePath("/recap");
  revalidatePath("/today");
  return { ok: true, message: "Recap finalized. The family can see it now." };
});
