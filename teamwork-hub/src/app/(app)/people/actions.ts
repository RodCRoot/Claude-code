"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import {
  addGuardian,
  addNote,
  createAlert,
  createAthleteFamily,
  createTask,
  deactivateAlert,
  revokeGuardianship,
  setTag,
  setTaskStatus,
  updateAthleteProfile,
  updateGuardianship,
  updatePerson,
} from "@/lib/people/mutations";

const checkbox = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

export const createFamilyAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const o = formToObject(fd);
  const res = await db.transaction((tx) =>
    createAthleteFamily(tx, v, {
      athlete: { firstName: o.firstName, lastName: o.lastName, email: o.email, phone: o.phone, dateOfBirth: o.dateOfBirth, sport: o.sport, school: o.school, gradYear: o.gradYear },
      guardianMode: o.guardianMode,
      existingGuardianId: o.existingGuardianId || undefined,
      guardian: { firstName: o.gFirstName, lastName: o.gLastName, email: o.gEmail, phone: o.gPhone },
      relationship: o.relationship || "parent",
      canViewHealth: checkbox(fd, "canViewHealth"),
      confirmDuplicates: checkbox(fd, "confirmDuplicates"),
      groupId: o.groupId,
    }),
  );
  revalidatePath("/people");
  redirect(`/people/${res.personId}`);
});

export const updatePersonAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("personId"));
  await db.transaction((tx) => updatePerson(tx, v, id, formToObject(fd)));
  revalidatePath(`/people/${id}`);
  return { ok: true, message: "Saved." };
});

export const updateAthleteAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("athleteId"));
  await db.transaction((tx) => updateAthleteProfile(tx, v, id, formToObject(fd)));
  revalidatePath(`/people/${fd.get("personId")}`);
  return { ok: true, message: "Athlete profile saved." };
});

function flags(fd: FormData) {
  return {
    relationship: String(fd.get("relationship") ?? "parent"),
    canViewTraining: checkbox(fd, "canViewTraining"),
    canViewHealth: checkbox(fd, "canViewHealth"),
    canBook: checkbox(fd, "canBook"),
    canSignForms: checkbox(fd, "canSignForms"),
    canMessageStaff: checkbox(fd, "canMessageStaff"),
    isEmergencyContact: checkbox(fd, "isEmergencyContact"),
  };
}

export const addGuardianAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const o = formToObject(fd);
  await db.transaction((tx) =>
    addGuardian(tx, v, String(o.athleteId), {
      mode: o.mode,
      existingPersonId: o.existingPersonId || undefined,
      guardian: { firstName: o.gFirstName, lastName: o.gLastName, email: o.gEmail, phone: o.gPhone },
      ...flags(fd),
    }),
  );
  revalidatePath(`/people/${o.personId}`);
  return { ok: true, message: "Guardian added with the permissions shown." };
});

export const updateGuardianshipAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => updateGuardianship(tx, v, String(fd.get("guardianshipId")), flags(fd)));
  revalidatePath(`/people/${fd.get("personId")}`);
  return { ok: true, message: "Permissions updated." };
});

export const revokeGuardianshipAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => revokeGuardianship(tx, v, String(fd.get("guardianshipId")), String(fd.get("reason") ?? "")));
  revalidatePath(`/people/${fd.get("personId")}`);
  return { ok: true, message: "Guardian access removed." };
});

export const addNoteAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("personId"));
  await db.transaction((tx) => addNote(tx, v, id, formToObject(fd)));
  revalidatePath(`/people/${id}`);
  return { ok: true, message: "Note added." };
});

export const createTaskAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => createTask(tx, v, formToObject(fd)));
  const back = fd.get("relatedPersonId");
  revalidatePath(back ? `/people/${back}` : "/people/tasks");
  revalidatePath("/today");
  return { ok: true, message: "Task created." };
});

export async function setTaskStatusAction(fd: FormData) {
  const v = await requireViewer();
  await db.transaction((tx) => setTaskStatus(tx, v, String(fd.get("taskId")), String(fd.get("status")) as "done"));
  revalidatePath("/people/tasks");
  revalidatePath("/today");
  const back = fd.get("personId");
  if (back) revalidatePath(`/people/${back}`);
}

export const createAlertAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("personId"));
  await db.transaction((tx) => createAlert(tx, v, id, { message: fd.get("message"), level: fd.get("level"), showAtKiosk: checkbox(fd, "showAtKiosk") }));
  revalidatePath(`/people/${id}`);
  return { ok: true, message: "Alert added." };
});

export async function deactivateAlertAction(fd: FormData) {
  const v = await requireViewer();
  await db.transaction((tx) => deactivateAlert(tx, v, String(fd.get("alertId"))));
  revalidatePath(`/people/${fd.get("personId")}`);
}

export const tagAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = String(fd.get("personId"));
  await db.transaction((tx) => setTag(tx, v, id, String(fd.get("tag") ?? ""), fd.get("op") !== "remove"));
  revalidatePath(`/people/${id}`);
  return { ok: true };
});
