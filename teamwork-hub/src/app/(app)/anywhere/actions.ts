"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, UserError, type ActionState } from "@/lib/actions";
import { ICS_MAX_BYTES, discardStaged, importStaged, stageIcs } from "@/lib/anywhere/ics";
import { addEvent, createSeason, deleteSeason, logSport, removeEvent } from "@/lib/anywhere/season";
import { checkinHabit } from "@/lib/science/habits";
import { todayLocal } from "@/lib/time";

function refresh() {
  revalidatePath("/anywhere", "layout");
  revalidatePath("/today");
  revalidatePath("/training", "layout");
  revalidatePath("/science", "layout");
}

// Every function below re-checks the viewer's scope over the submitted ids (lib functions do it).

export const createSeasonAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const s = await db.transaction((tx) => createSeason(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: `Season added: ${s.teamName}. Now add practices and games.` };
});

export const deleteSeasonAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteSeason(tx, v, String(fd.get("seasonId") ?? "")));
  refresh();
  return { ok: true, message: "Season removed." };
});

export const addEventAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addEvent(tx, v, { ...formToObject(fd), weekdays: fd.getAll("weekdays").map(String) }));
  refresh();
  return { ok: true, message: "Added to the season." };
});

export const removeEventAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const date = String(fd.get("date") ?? "") || null;
  await db.transaction((tx) => removeEvent(tx, v, String(fd.get("eventId") ?? ""), date));
  refresh();
  return { ok: true, message: "Removed." };
});

export const logSportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => logSport(tx, v, formToObject(fd)));
  refresh();
  return { ok: true, message: r.status === "updated" ? "Updated. Thanks." : "Logged. Thanks, your coach can see it now." };
});

export const uploadIcsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) throw new UserError("Choose a calendar file (.ics) to upload.");
  // Checked before the file is read into memory.
  if (file.size > ICS_MAX_BYTES) throw new UserError("That file is too large. Calendar files can be up to 256 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await db.transaction((tx) => stageIcs(tx, v, String(fd.get("seasonId") ?? ""), file.name, bytes));
  refresh();
  return { ok: true, message: `Found ${row.events.length} event${row.events.length === 1 ? "" : "s"}. Check the preview below, then import.` };
});

export const importIcsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("importId") ?? "");
  if (fd.get("do") === "discard") {
    await db.transaction((tx) => discardStaged(tx, v, id));
    refresh();
    return { ok: true, message: "Upload discarded. Nothing was added." };
  }
  const r = await db.transaction((tx) => importStaged(tx, v, id));
  refresh();
  return { ok: true, message: `Imported: ${r.added} added, ${r.updated} updated.` };
});

/** Daily 3: one tap marks an assigned habit done for today, using the existing habit check-in. */
export const habitDoneAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => checkinHabit(tx, v, { habitId: String(fd.get("habitId") ?? ""), athleteId: String(fd.get("athleteId") ?? ""), forDate: todayLocal(), status: "done" }));
  refresh();
  return { ok: true };
});
