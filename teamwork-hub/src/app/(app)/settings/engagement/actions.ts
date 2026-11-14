"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { saveEngagementSettings } from "@/lib/engagement/settings";

export const saveEngagementSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveEngagementSettings(tx, v, { ...formToObject(fd), levelsEnabled: fd.get("levelsEnabled") === "on", badgesEnabled: fd.get("badgesEnabled") === "on" }));
  revalidatePath("/settings/engagement");
  revalidatePath("/today");
  return { ok: true, message: "Engagement settings saved." };
});
