"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users, type FormField, type SignerRequirement } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, UserError, zEmptyToUndef, type ActionState } from "@/lib/actions";
import { assertCan } from "@/lib/authz/policy";
import { createDraftVersion, createTemplate, discardDraft, publishVersion, saveDraft, setApprovedText, updateTemplate, TEMPLATE_KINDS } from "@/lib/forms/templates";
import { issueRequests, processRenewals, remindOverdue, sendReminder, voidRequest, type IssueTarget } from "@/lib/forms/requests";
import { signRequest } from "@/lib/forms/signing";

const refresh = () => revalidatePath("/documents", "layout");
const uuid = z.string().uuid();

const templateForm = z.object({
  name: z.string(),
  kind: z.enum(TEMPLATE_KINDS),
  renewalMonths: zEmptyToUndef(z.coerce.number().int().min(1, "At least 1 month").max(120).optional()),
  requiredForBooking: z.string().optional(),
  active: z.string().optional(),
});

function templateInput(fd: FormData) {
  const f = templateForm.parse(formToObject(fd));
  return { name: f.name, kind: f.kind, renewalMonths: f.renewalMonths ?? null, requiredForBooking: f.requiredForBooking === "on", active: f.active === "on" };
}

export const createTemplateAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const t = await db.transaction((tx) => createTemplate(tx, v, templateInput(fd)));
  refresh();
  redirect(`/documents/templates/${t.id}`);
});

export const updateTemplateAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = uuid.parse(fd.get("templateId"));
  await db.transaction((tx) => updateTemplate(tx, v, id, templateInput(fd)));
  refresh();
  return { ok: true, message: "Template settings saved." };
});

export const newDraftAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = uuid.parse(fd.get("templateId"));
  const res = await db.transaction((tx) => createDraftVersion(tx, v, id));
  refresh();
  return { ok: true, message: res.created ? `Draft v${res.version.version} created from the latest version.` : "A draft already exists — continue editing it below." };
});

function parseJson<T>(raw: FormDataEntryValue | null, label: string): T {
  try {
    return JSON.parse(String(raw ?? "")) as T;
  } catch {
    throw new UserError(`${label} could not be read. Reload the page and try again.`);
  }
}

export const saveDraftAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const versionId = uuid.parse(fd.get("versionId"));
  const fields = parseJson<FormField[]>(fd.get("fieldsJson"), "Field list");
  const signers = parseJson<SignerRequirement[]>(fd.get("signersJson"), "Signer list");
  await db.transaction((tx) =>
    saveDraft(tx, v, versionId, { title: String(fd.get("title") ?? ""), bodyMarkdown: String(fd.get("bodyMarkdown") ?? ""), fields, signers }),
  );
  refresh();
  return { ok: true, message: "Draft saved." };
});

export const discardDraftAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => discardDraft(tx, v, uuid.parse(fd.get("versionId"))));
  refresh();
  return { ok: true, message: "Draft discarded." };
});

export const publishAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const res = await db.transaction((tx) => publishVersion(tx, v, uuid.parse(fd.get("versionId")), { requireResign: fd.get("requireResign") === "on" }));
  refresh();
  return {
    ok: true,
    message: `Published. Content hash ${res.contentHash.slice(0, 12)}…${fd.get("requireResign") === "on" ? ` ${res.superseded} open request(s) superseded and re-issued.` : ""}`,
  };
});

export const approveTextAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const approved = fd.get("approved") === "true";
  await db.transaction((tx) => setApprovedText(tx, v, uuid.parse(fd.get("versionId")), approved));
  refresh();
  return { ok: true, message: approved ? "Marked as approved Teamwork language." : "Marked as SAMPLE text." };
});

const issueForm = z.object({
  templateId: z.string().uuid(),
  target: z.enum(["athlete", "group", "missing"]),
  athleteId: zEmptyToUndef(z.string().uuid().optional()),
  groupId: zEmptyToUndef(z.string().uuid().optional()),
  dueDate: zEmptyToUndef(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").optional()),
});

export const issueAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const f = issueForm.parse(formToObject(fd));
  let target: IssueTarget;
  if (f.target === "athlete") {
    if (!f.athleteId) throw new UserError("Choose an athlete.", { athleteId: "Required" });
    target = { kind: "athlete", athleteId: f.athleteId };
  } else if (f.target === "group") {
    if (!f.groupId) throw new UserError("Choose a group.", { groupId: "Required" });
    target = { kind: "group", groupId: f.groupId };
  } else target = { kind: "missing" };
  const res = await db.transaction((tx) => issueRequests(tx, v, { templateId: f.templateId, target, dueDate: f.dueDate ?? null }));
  refresh();
  return { ok: true, message: `Issued ${res.created} request(s).${res.skipped ? ` Skipped ${res.skipped} that already had an open or valid form.` : ""}` };
});

export const remindAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const res = await db.transaction((tx) => sendReminder(tx, v, uuid.parse(fd.get("requestId"))));
  refresh();
  return {
    ok: true,
    message: res.queued
      ? "Reminder queued for the messaging service (delivered according to messaging settings)."
      : "A reminder for this request was already queued today.",
  };
});

export const remindOverdueAction = safeAction(async () => {
  const v = await requireViewer();
  const res = await db.transaction((tx) => remindOverdue(tx, v));
  refresh();
  return { ok: true, message: `Queued ${res.queued} reminder(s) for ${res.considered} overdue request(s).` };
});

export const renewalsAction = safeAction(async () => {
  const v = await requireViewer();
  assertCan(v, "forms.manage");
  const res = await db.transaction((tx) => processRenewals(tx, v.orgId, { actorUserId: v.userId }));
  refresh();
  return { ok: true, message: `Renewal check done: ${res.expired} form(s) expired, ${res.renewed} renewal request(s) issued.` };
});

export const voidAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = uuid.parse(fd.get("requestId"));
  const reissue = fd.get("mode") === "reissue";
  const res = await db.transaction((tx) => voidRequest(tx, v, id, String(fd.get("reason") ?? ""), { reissue }));
  refresh();
  if (res.newId) redirect(`/documents/requests/${res.newId}`);
  return { ok: true, message: "Request voided." };
});

export const signAction = safeAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const h = await headers();
  const [u] = await db.select({ mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, v.userId));
  const evidence = {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
    authMethod: u?.mfaEnabled && v.mfaVerified ? "session_password_mfa" : "session_password",
  };
  const values = formToObject(fd);
  // In-person signing posts "personId|role" from a single picker.
  const pick = typeof values.inPersonPick === "string" ? values.inPersonPick.split("|") : null;
  const inPerson = pick ? pick[0] : null;
  if (pick) values.role = pick[1] ?? "";
  const res = await db.transaction((tx) =>
    signRequest(
      tx,
      v,
      {
        requestId: uuid.parse(values.requestId),
        role: String(values.role ?? ""),
        typedName: String(values.typedName ?? ""),
        consent: values.consent === "on",
        values,
        inPersonSignerPersonId: inPerson,
      },
      evidence,
    ),
  );
  refresh();
  // The signing card disappears once this signer is done, so confirm on the page itself.
  redirect(`/documents/requests/${values.requestId}?signed=${res.status === "completed" ? "complete" : "partial"}#top`);
});
