"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireStaff, requireViewer } from "@/lib/auth/viewer";
import { assertCan } from "@/lib/authz/policy";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { addOpsItem, addSampleOpsItems, setOpsTick, updateOpsItem } from "@/lib/journey/ops";
import { saveReflection } from "@/lib/journey/scorecard";
import { resetJourneyTemplate, saveJourneyNumbers, saveJourneyTemplate } from "@/lib/journey/settings";
import { assignStep, completeStep, logReachOut, skipStep, snoozeStep } from "@/lib/journey/steps";
import { syncJourneys } from "@/lib/journey/sync";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

function refresh() {
  revalidatePath("/follow-ups", "layout");
  revalidatePath("/today");
  revalidatePath("/people", "layout");
}

export const completeStepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => completeStep(tx, v, { taskId: str(fd, "taskId"), note: str(fd, "note") || undefined, outcome: str(fd, "outcome") || undefined, date: str(fd, "date") || undefined }));
  refresh();
  return { ok: true, message: "Done." };
});

export const skipStepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => skipStep(tx, v, { taskId: str(fd, "taskId"), reason: str(fd, "reason") }));
  refresh();
  return { ok: true, message: "Skipped." };
});

export const snoozeStepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const r = await db.transaction((tx) => snoozeStep(tx, v, { taskId: str(fd, "taskId"), days: Number(str(fd, "days") || 3) }));
  refresh();
  return { ok: true, message: `Snoozed until ${r.until}.` };
});

export const assignStepAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => assignStep(tx, v, { taskId: str(fd, "taskId"), userId: str(fd, "userId") || null }));
  refresh();
  return { ok: true, message: "Assigned." };
});

export const logReachOutAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => logReachOut(tx, v, { athleteId: str(fd, "athleteId"), note: str(fd, "note"), reason: str(fd, "reason") || "other" }));
  refresh();
  return { ok: true, message: "Reach-out logged." };
});

/** "Refresh now": the same generator the nightly job runs, for this organization. */
export const syncJourneysAction = safeAction(async () => {
  const v = await requireStaff();
  assertCan(v, "journey.view");
  const r = await db.transaction((tx) => syncJourneys(tx, v.orgId));
  refresh();
  return { ok: true, message: `Up to date: ${r.stepsCreated} new step${r.stepsCreated === 1 ? "" : "s"}, ${r.autoCompleted} ticked automatically.` };
});

// --- Operations checklist ---------------------------------------------------------------------

export const setOpsTickAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setOpsTick(tx, v, { itemId: str(fd, "itemId"), day: str(fd, "day"), done: str(fd, "done") === "1" }));
  revalidatePath("/follow-ups/checklist");
  return { ok: true };
});

export const addOpsItemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addOpsItem(tx, v, formToObject(fd)));
  revalidatePath("/settings/journey");
  revalidatePath("/follow-ups/checklist");
  return { ok: true, message: "Added." };
});

export const updateOpsItemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => updateOpsItem(tx, v, { ...formToObject(fd), active: str(fd, "active") === "on" }));
  revalidatePath("/settings/journey");
  revalidatePath("/follow-ups/checklist");
  return { ok: true, message: "Saved." };
});

export const addSampleOpsItemsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => addSampleOpsItems(tx, v, str(fd, "locationId") || null));
  revalidatePath("/settings/journey");
  revalidatePath("/follow-ups/checklist");
  return { ok: true, message: "Sample list added. Edit it to match how you run the floor." };
});

// --- Scorecard --------------------------------------------------------------------------------

export const saveReflectionAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveReflection(tx, v, { weekStart: str(fd, "weekStart"), wentWell: str(fd, "wentWell"), stuck: str(fd, "stuck"), helpNeeded: str(fd, "helpNeeded") }));
  revalidatePath("/follow-ups/scorecard");
  return { ok: true, message: "Reflection saved." };
});

// --- Settings ---------------------------------------------------------------------------------

/** Template form: one row per step, fields named `<field>.<index>`. */
export const saveJourneyTemplateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const n = Math.min(Number(str(fd, "rows")) || 0, 60);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      key: str(fd, `key.${i}`) || undefined,
      name: str(fd, `name.${i}`),
      ownerRole: str(fd, `ownerRole.${i}`),
      offset: str(fd, `offset.${i}`),
      unit: str(fd, `unit.${i}`),
      anchor: str(fd, `anchor.${i}`) || "start",
      autoRule: str(fd, `autoRule.${i}`) || null,
      billing: str(fd, `billing.${i}`) === "on",
      enabled: str(fd, `enabled.${i}`) === "on",
      visits: str(fd, `visits.${i}`) || undefined,
    });
  }
  if (str(fd, "intent") === "reset") await db.transaction((tx) => resetJourneyTemplate(tx, v, str(fd, "kind")));
  else await db.transaction((tx) => saveJourneyTemplate(tx, v, str(fd, "kind"), rows));
  revalidatePath("/settings/journey");
  return { ok: true, message: str(fd, "intent") === "reset" ? "Back to the defaults." : "Checklist saved. Journeys already under way keep their steps." };
});

export const saveJourneyNumbersAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveJourneyNumbers(tx, v, formToObject(fd)));
  revalidatePath("/settings/journey");
  revalidatePath("/follow-ups", "layout");
  return { ok: true, message: "Saved." };
});
