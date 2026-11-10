"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { createGoal, setGoalStatus, type GoalAction } from "@/lib/engagement/goals";

function refresh(athleteId: string) {
  revalidatePath("/goals");
  revalidatePath("/today");
  revalidatePath(`/performance/${athleteId}`);
}

export const createGoalAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  // createGoal re-checks the viewer's scope over the submitted athlete id.
  const g = await db.transaction((tx) => createGoal(tx, v, formToObject(fd)));
  refresh(g.athleteId);
  return { ok: true, message: `Goal added: ${g.title}` };
});

export const goalStatusAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const action = String(fd.get("do") ?? "");
  if (!["achieve", "archive", "reopen"].includes(action)) return { ok: false, error: "Unknown action." };
  const g = await db.transaction((tx) => setGoalStatus(tx, v, String(fd.get("goalId") ?? ""), action as GoalAction));
  refresh(g.athleteId);
  return { ok: true, message: action === "achieve" ? "Goal reached. Nice work." : action === "archive" ? "Goal archived." : "Goal reopened." };
});
