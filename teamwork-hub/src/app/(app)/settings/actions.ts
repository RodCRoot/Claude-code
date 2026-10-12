"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { Role } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { recheckIntegrations, updateOrgSettings } from "@/lib/settings";
import { beginMfaEnrollment, changeRole, confirmMfaEnrollment, createResetToken, disableMfa, inviteUser, setUserDisabled } from "@/lib/auth/accounts";
import { env } from "@/lib/env";
import { createFieldDef, setFieldDefArchived, updateFieldDef } from "@/lib/people/custom-fields";

const on = (fd: FormData, k: string) => fd.get(k) === "on";

export const saveOrgSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const o = formToObject(fd);
  await db.transaction((tx) => updateOrgSettings(tx, v, { ...o, requireStaffMfa: on(fd, "requireStaffMfa"), minorsReceiveDirectMessages: on(fd, "minorsReceiveDirectMessages"), kioskPinOnly: on(fd, "kioskPinOnly") }));
  revalidatePath("/", "layout");
  return { ok: true, message: "Settings saved." };
});

export const inviteUserAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const { token } = await db.transaction((tx) => inviteUser(tx, v, formToObject(fd)));
  revalidatePath("/settings/users");
  return {
    ok: true,
    message: "Invite created. Email delivery isn't configured, so copy this one-time link and send it yourself. It expires in 72 hours and won't be shown again.",
    data: { link: `${env().APP_URL}/invite/${token}` },
  };
});

export const resetLinkAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const token = await db.transaction((tx) => createResetToken(tx, v, String(fd.get("userId"))));
  return { ok: true, message: "One-time reset link (expires in 2 hours, shown once):", data: { link: `${env().APP_URL}/reset/${token}` } };
});

export async function toggleUserAction(fd: FormData) {
  const v = await requireViewer();
  await db.transaction((tx) => setUserDisabled(tx, v, String(fd.get("userId")), fd.get("disable") === "true"));
  revalidatePath("/settings/users");
}

export const changeRoleAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => changeRole(tx, v, String(fd.get("userId")), String(fd.get("role")) as Role));
  revalidatePath("/settings/users");
  return { ok: true, message: "Role updated; their sessions were signed out." };
});

export const beginMfaAction = safeAction(async () => {
  const v = await requireViewer();
  const res = await db.transaction((tx) => beginMfaEnrollment(tx, v));
  const QR = await import("qrcode");
  const svg = await QR.toString(res.uri, { type: "svg", margin: 1, width: 200 });
  return { ok: true, data: { secret: res.secret, svg } };
});

export const confirmMfaAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => confirmMfaEnrollment(tx, v, String(fd.get("code") ?? "")));
  revalidatePath("/settings/security");
  return { ok: true, message: "Two-step verification is on. You'll be asked for a code at sign-in." };
});

export async function disableMfaAction(fd: FormData) {
  const v = await requireViewer();
  await db.transaction((tx) => disableMfa(tx, v, String(fd.get("userId") ?? v.userId)));
  revalidatePath("/settings/security");
  revalidatePath("/settings/users");
}

export async function recheckIntegrationsAction() {
  const v = await requireViewer();
  await db.transaction((tx) => recheckIntegrations(tx, v));
  revalidatePath("/settings/integrations");
}

export const createCustomFieldAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const row = await db.transaction((tx) => createFieldDef(tx, v, formToObject(fd)));
  revalidatePath("/settings/custom-fields");
  revalidatePath("/people");
  return { ok: true, message: `Field "${row.label}" created (key ${row.key}).` };
});

export const updateCustomFieldAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => updateFieldDef(tx, v, String(fd.get("id")), formToObject(fd)));
  revalidatePath("/settings/custom-fields");
  revalidatePath("/people");
  return { ok: true, message: "Field saved." };
});

export async function archiveCustomFieldAction(fd: FormData) {
  const v = await requireViewer();
  await db.transaction((tx) => setFieldDefArchived(tx, v, String(fd.get("id")), fd.get("archive") === "true"));
  revalidatePath("/settings/custom-fields");
  revalidatePath("/people");
}
