"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { approveClip, approveClips, rejectClip, removeClip, triageClip } from "@/lib/newswatch/clips";
import { addSource, deleteSource, saveNewsSettings, setSourceEnabled, updateSource } from "@/lib/newswatch/settings";
import { createAlumnus, markAthleteAsAlumni, requestNewsOptIn, setAlumniActive, setAlumniWatch, setNewsOptIn, setWatchTerms, updateAlumnus } from "@/lib/newswatch/watch";

const str = (fd: FormData, key: string) => {
  const x = fd.get(key);
  return typeof x === "string" ? x : "";
};

function refresh() {
  revalidatePath("/wins", "layout");
  revalidatePath("/today");
  revalidatePath("/settings/newswatch");
  revalidatePath("/people/[personId]", "page");
}

/** Every permission check lives in the domain function; ids from the form are re-checked there. */
export const triageClipAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const raw = str(fd, "decision");
  const decision = raw === "ours" ? "ours" : raw === "not_ours" ? "not_ours" : "ignore";
  await db.transaction((tx) => triageClip(tx, v, str(fd, "clipId"), decision, { term: str(fd, "term") }));
  refresh();
  return {
    ok: true,
    message: decision === "ours" ? "Marked as our athlete. It is still shown to nobody until it is approved." : decision === "not_ours" ? "Thanks. This article will not be suggested for this person again." : "Ignored.",
  };
});

export const approveClipAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => approveClip(tx, v, str(fd, "clipId")));
  refresh();
  return { ok: true, message: "Approved. It now shows in the app and on the gym TV." };
});

export const bulkApproveClipsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const ids = fd.getAll("clipIds").filter((x): x is string => typeof x === "string");
  const res = await db.transaction((tx) => approveClips(tx, v, ids));
  refresh();
  const skipped = res.skipped.length ? ` ${res.skipped.length} could not be approved: ${res.skipped[0].reason}` : "";
  return { ok: true, message: `${res.approved} clip${res.approved === 1 ? "" : "s"} approved.${skipped}` };
});

export const rejectClipAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => rejectClip(tx, v, str(fd, "clipId")));
  refresh();
  return { ok: true, message: "Rejected. Nothing was shared." };
});

export const removeClipAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => removeClip(tx, v, str(fd, "clipId")));
  refresh();
  return { ok: true, message: "Taken down." };
});

// --- Who is watched -----------------------------------------------------------------------

export const setNewsOptInAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const on = str(fd, "optIn") === "on";
  await db.transaction((tx) => setNewsOptIn(tx, v, str(fd, "athleteId"), on));
  refresh();
  return { ok: true, message: on ? "News watch is on. You can switch it off at any time." : "News watch is off. Nothing more will be looked for, and any news clips were taken down." };
});

export const requestNewsOptInAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => requestNewsOptIn(tx, v, str(fd, "athleteId")));
  refresh();
  return { ok: true, message: "The family will see the question in the app. No message was sent." };
});

export const setWatchTermsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setWatchTerms(tx, v, str(fd, "athleteId"), formToObject(fd)));
  refresh();
  return { ok: true, message: "Saved." };
});

export const createAlumnusAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => createAlumnus(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: "Added. Record a basis to put them on the watch list." };
});

export const updateAlumnusAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => updateAlumnus(tx, v, str(fd, "alumniId"), formToObject(fd)));
  refresh();
  return { ok: true, message: "Saved." };
});

export const setAlumniWatchAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const watch = str(fd, "watch") === "on";
  await db.transaction((tx) => setAlumniWatch(tx, v, str(fd, "alumniId"), { watch, basis: str(fd, "basis") }));
  refresh();
  return { ok: true, message: watch ? "On the watch list." : "Taken off the watch list. Their clips were closed or taken down." };
});

export const setAlumniActiveAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setAlumniActive(tx, v, str(fd, "alumniId"), str(fd, "active") === "on"));
  refresh();
  return { ok: true, message: "Saved." };
});

export const markAsAlumniAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => markAthleteAsAlumni(tx, v, str(fd, "athleteId"), { college: str(fd, "college") }));
  refresh();
  return { ok: true, message: "Alumni record created. It is not on the news watch list yet." };
});

// --- Settings (owner and admin) -----------------------------------------------------------

export const saveNewsSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveNewsSettings(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: "Saved." };
});

export const addSourceAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addSource(tx, v, { ...formToObject(fd), enabled: true }));
  refresh();
  return { ok: true, message: "Source added. It is read on the next run." };
});

export const updateSourceAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => updateSource(tx, v, str(fd, "sourceId"), { ...formToObject(fd), enabled: str(fd, "enabled") === "on" }));
  refresh();
  return { ok: true, message: "Saved." };
});

export const toggleSourceAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const on = str(fd, "enabled") === "on";
  await db.transaction((tx) => setSourceEnabled(tx, v, str(fd, "sourceId"), on));
  refresh();
  return { ok: true, message: on ? "Switched on." : "Switched off. It will not be read." };
});

export const deleteSourceAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteSource(tx, v, str(fd, "sourceId")));
  refresh();
  return { ok: true, message: "Deleted." };
});
