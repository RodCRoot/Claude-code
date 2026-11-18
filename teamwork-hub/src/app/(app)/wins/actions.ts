"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { addTeamEvents, archiveTeam, createTeam, removeTeamEvent, setTeamAthletes } from "@/lib/wins/calendar";
import { answerMarketingConsent, requestMarketingConsent, revokeMarketingConsent } from "@/lib/wins/consent";
import { addLead, convertLead, dismissLead } from "@/lib/wins/leads";
import { markPosted, markTakenDown } from "@/lib/wins/marketing";
import { answerDraft, approveWin, editWin, removeWin, setPhotoApproval, setSharing, submitWin } from "@/lib/wins/wins";

const str = (fd: FormData, key: string) => {
  const x = fd.get(key);
  return typeof x === "string" ? x : "";
};
const on = (fd: FormData, key: string) => fd.get(key) === "on";

function refresh() {
  revalidatePath("/wins", "layout");
  revalidatePath("/today");
  revalidatePath("/people/[personId]", "page");
}

/** Every permission check lives in the domain function; ids from the form are re-checked there. */
export const submitWinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => submitWin(tx, v, { ...formToObject(fd), showInApp: on(fd, "showInApp"), showOnTv: on(fd, "showOnTv") }));
  refresh();
  return { ok: true, message: "Sent. A staff member reviews every win before anyone else sees it." };
});

export const answerDraftAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const answer = str(fd, "answer") === "confirm" ? "confirm" : "decline";
  await db.transaction((tx) => answerDraft(tx, v, str(fd, "winId"), answer));
  refresh();
  return { ok: true, message: answer === "confirm" ? "Thanks. Staff will review it next." : "Removed. Nothing was shared." };
});

export const setSharingAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setSharing(tx, v, { winId: str(fd, "winId"), showInApp: on(fd, "showInApp"), showOnTv: on(fd, "showOnTv") }));
  refresh();
  return { ok: true, message: "Saved." };
});

export const answerConsentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const answer = str(fd, "answer") === "grant" ? "grant" : "decline";
  await db.transaction((tx) => answerMarketingConsent(tx, v, str(fd, "winId"), answer));
  refresh();
  return { ok: true, message: answer === "grant" ? "Saved. You can withdraw this at any time." : "Saved. This win will not be used for public marketing." };
});

export const revokeConsentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => revokeMarketingConsent(tx, v, str(fd, "winId")));
  refresh();
  return { ok: true, message: "Withdrawn. The gym has been told to stop using it." };
});

export const withdrawWinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => removeWin(tx, v, str(fd, "winId"), { reason: str(fd, "reason") || null }));
  refresh();
  return { ok: true, message: "Removed." };
});

export const approveWinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => approveWin(tx, v, { winId: str(fd, "winId"), headline: str(fd, "headline"), detail: str(fd, "detail"), approvePhoto: on(fd, "approvePhoto") }));
  refresh();
  return { ok: true, message: "Approved." };
});

export const editWinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => editWin(tx, v, { winId: str(fd, "winId"), headline: str(fd, "headline"), detail: str(fd, "detail") }));
  refresh();
  return { ok: true, message: "Saved." };
});

export const photoApprovalAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setPhotoApproval(tx, v, str(fd, "winId"), str(fd, "approved") === "yes"));
  refresh();
  return { ok: true, message: "Saved." };
});

export const requestConsentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => requestMarketingConsent(tx, v, str(fd, "winId")));
  refresh();
  return { ok: true, message: "The family will see the request in the app. No message was sent." };
});

export const markPostedAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => markPosted(tx, v, { winId: str(fd, "winId"), channel: str(fd, "channel"), postedOn: str(fd, "postedOn") }));
  refresh();
  return { ok: true, message: "Noted." };
});

export const markTakenDownAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => markTakenDown(tx, v, str(fd, "winId")));
  refresh();
  return { ok: true, message: "Noted." };
});

export const addLeadAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addLead(tx, v, { note: str(fd, "note"), sourceUrl: str(fd, "sourceUrl"), athleteId: str(fd, "athleteId") || null }));
  refresh();
  return { ok: true, message: "Lead added." };
});

export const convertLeadAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => convertLead(tx, v, str(fd, "leadId"), formToObject(fd)));
  refresh();
  return { ok: true, message: "Draft created. The family will see it in the app and can confirm it. No message was sent." };
});

export const dismissLeadAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => dismissLead(tx, v, str(fd, "leadId")));
  refresh();
  return { ok: true, message: "Dismissed." };
});

export const createTeamAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => createTeam(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: "Team added. Add its dates and athletes below." };
});

export const addTeamEventsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => addTeamEvents(tx, v, { teamId: str(fd, "teamId"), kind: str(fd, "kind"), lines: str(fd, "lines") }));
  refresh();
  return { ok: true, message: `${r.added} date${r.added === 1 ? "" : "s"} added${r.skipped ? `, ${r.skipped} already on the schedule` : ""}.` };
});

export const removeTeamEventAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => removeTeamEvent(tx, v, str(fd, "eventId")));
  refresh();
  return { ok: true, message: "Removed." };
});

export const setTeamAthletesAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const ids = fd.getAll("athleteIds").filter((x): x is string => typeof x === "string");
  const r = await db.transaction((tx) => setTeamAthletes(tx, v, str(fd, "teamId"), ids));
  refresh();
  return { ok: true, message: `Saved: ${r.added} added, ${r.removed} removed.` };
});

export const archiveTeamAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => archiveTeam(tx, v, str(fd, "teamId")));
  refresh();
  return { ok: true, message: "Archived." };
});
