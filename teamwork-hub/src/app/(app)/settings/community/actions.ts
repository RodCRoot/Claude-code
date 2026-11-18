"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { safeAction, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { createDisplayToken, displayLinkPath, revokeDisplayToken } from "@/lib/community/board";
import { saveCommunitySettings } from "@/lib/community/settings";
import { env } from "@/lib/env";

const str = (fd: FormData, key: string) => {
  const x = fd.get(key);
  return typeof x === "string" ? x : "";
};

export const saveCommunitySettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) =>
    saveCommunitySettings(tx, v, {
      enabled: fd.get("enabled") === "on",
      defaultDisplayMode: str(fd, "defaultDisplayMode"),
      panels: fd.getAll("panels").filter((x): x is string => typeof x === "string"),
      rotationSeconds: str(fd, "rotationSeconds"),
      shoutoutDailyLimit: str(fd, "shoutoutDailyLimit"),
      orgMessage: str(fd, "orgMessage"),
    }),
  );
  for (const p of ["/settings/community", "/leaderboards", "/today"]) revalidatePath(p);
  return { ok: true, message: "Community settings saved." };
});

/** Returns the one-time setup link. The token is shown once and never stored in plain form. */
export const createDisplayAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const { token } = await db.transaction((tx) => createDisplayToken(tx, v, { label: str(fd, "label") }));
  revalidatePath("/settings/community");
  return { ok: true, message: "Screen added. Open this link once in the TV's browser (shown only now):", data: { link: `${env().APP_URL}${displayLinkPath(token)}` } };
});

export const revokeDisplayAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => revokeDisplayToken(tx, v, str(fd, "id")));
  revalidatePath("/settings/community");
  return { ok: true, message: "Screen revoked. It stops showing the board within a minute." };
});
