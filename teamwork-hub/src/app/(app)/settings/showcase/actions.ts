"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { saveShowcaseSettings } from "@/lib/showcase/settings";

export const saveShowcaseSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveShowcaseSettings(tx, v, { ...formToObject(fd), enabled: fd.get("enabled") === "on", recapEnabled: fd.get("recapEnabled") === "on" }));
  revalidatePath("/settings/showcase");
  revalidatePath("/showcase");
  revalidatePath("/today");
  return { ok: true, message: "Showcase and recap settings saved." };
});
