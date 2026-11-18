"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, type ActionState } from "@/lib/actions";
import { saveTargets, saveThresholds } from "@/lib/scoreboard/core";
import { deleteSpend, saveSpend } from "@/lib/scoreboard/marketing";
import { deleteExpense, saveExpense } from "@/lib/scoreboard/money";
import { TARGET_KEYS } from "@/lib/scoreboard/monthly";

// Each function re-checks `scoreboard.manage` in the domain layer; ids from the form are never trusted.
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export const saveTargetsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveTargets(tx, v, formToObject(fd), TARGET_KEYS));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Ideal targets saved." };
});

export const saveThresholdsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveThresholds(tx, v, formToObject(fd)));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Thresholds saved." };
});

export const saveSpendAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveSpend(tx, v, { month: str(fd, "month"), channel: str(fd, "channel"), amount: str(fd, "amount"), note: str(fd, "note") }));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Marketing spend saved." };
});

export const deleteSpendAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteSpend(tx, v, str(fd, "id")));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Entry removed." };
});

export const saveExpenseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => saveExpense(tx, v, { month: str(fd, "month"), category: str(fd, "category"), label: str(fd, "label"), amount: str(fd, "amount") }));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Expense saved." };
});

export const deleteExpenseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => deleteExpense(tx, v, str(fd, "id")));
  revalidatePath("/scoreboard", "layout");
  return { ok: true, message: "Entry removed." };
});
