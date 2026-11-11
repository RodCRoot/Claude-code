"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { archiveChallenge, createChallenge } from "@/lib/community/challenges";
import { setDisplayMode } from "@/lib/community/display-name";
import { postShoutout, removeShoutout } from "@/lib/community/shoutouts";

const str = (fd: FormData, key: string) => {
  const x = fd.get(key);
  return typeof x === "string" ? x : "";
};

function refresh() {
  revalidatePath("/leaderboards");
  revalidatePath("/today");
  revalidatePath("/people/[personId]", "page");
}

/** Every permission check lives in the domain function; ids from the form are re-checked there. */
export const setDisplayModeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setDisplayMode(tx, v, { athleteId: str(fd, "athleteId"), mode: str(fd, "mode"), requestedBy: str(fd, "requestedBy") || null }));
  refresh();
  return { ok: true, message: "Saved. Boards and the gym TV use this from now on." };
});

export const postShoutoutAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => postShoutout(tx, v, { athleteId: str(fd, "athleteId"), template: str(fd, "template"), note: str(fd, "note") }));
  refresh();
  return { ok: true, message: "Shoutout posted." };
});

export const removeShoutoutAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => removeShoutout(tx, v, str(fd, "shoutoutId"), { reason: str(fd, "reason") || null }));
  refresh();
  return { ok: true, message: "Shoutout removed." };
});

export const createChallengeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => createChallenge(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: "Challenge started." };
});

export const archiveChallengeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => archiveChallenge(tx, v, str(fd, "challengeId")));
  refresh();
  return { ok: true, message: "Challenge archived." };
});
