"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { configFromForm } from "@/lib/showcase/allowlist";
import { publishShowcase, revokeShowcase, rotateShowcaseLink, saveShowcaseDraft, staffRevokeShowcase } from "@/lib/showcase/showcase";
import { sharePath } from "@/lib/showcase/token";

function refresh() {
  revalidatePath("/showcase");
  revalidatePath("/today");
  revalidatePath("/people/showcases");
}

/**
 * Save draft or publish, chosen by the submit button (`intent`). Only allowlisted field names
 * are read from the form (configFromForm); the lib re-checks the viewer's scope over athleteId.
 */
export const showcaseSaveAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const form = formToObject(fd);
  const athleteId = String(fd.get("athleteId") ?? "");
  const config = configFromForm(form);
  if (fd.get("intent") === "publish") {
    const days = Number(fd.get("expiryDays"));
    const { token } = await db.transaction((tx) => publishShowcase(tx, v, athleteId, { config, consent: fd.get("consent") === "on", expiryDays: Number.isFinite(days) ? days : null }));
    refresh();
    return { ok: true, message: token ? "Published. Copy the link below now: for safety it is shown only once." : "Published. The link you already shared works again with these changes.", data: token ? { sharePath: sharePath(token) } : undefined };
  }
  const { unpublished } = await db.transaction((tx) => saveShowcaseDraft(tx, v, athleteId, config));
  refresh();
  return { ok: true, message: unpublished ? "Draft saved. The shared link is paused until a parent or guardian publishes again." : "Draft saved." };
});

export const showcaseRevokeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => revokeShowcase(tx, v, String(fd.get("athleteId") ?? "")));
  refresh();
  return { ok: true, message: "The link is off. It no longer opens for anyone." };
});

export const showcaseRotateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const { token } = await db.transaction((tx) => rotateShowcaseLink(tx, v, String(fd.get("athleteId") ?? "")));
  refresh();
  return { ok: true, message: "New link created. The old link no longer works. Copy the new one now: it is shown only once.", data: { sharePath: sharePath(token) } };
});

/** Staff list: owner/admin revoke by Showcase id. */
export const staffRevokeShowcaseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => staffRevokeShowcase(tx, v, String(fd.get("showcaseId") ?? "")));
  refresh();
  return { ok: true, message: "Link turned off." };
});
