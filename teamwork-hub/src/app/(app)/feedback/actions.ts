"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, type ActionState } from "@/lib/actions";
import { submitFeedback } from "@/lib/retention/feedback";

export const submitFeedbackAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const s = (k: string) => {
    const x = fd.get(k);
    return typeof x === "string" ? x : "";
  };
  const bookingId = s("bookingId");
  await db.transaction((tx) => submitFeedback(tx, v, { bookingId, rating: s("rating"), comment: s("comment"), tellCoach: fd.get("tellCoach") === "on" }));
  revalidatePath(`/feedback/${bookingId}`);
  revalidatePath("/schedule");
  return { ok: true, message: "Thank you. Your feedback was saved. You can change it for the next 24 hours." };
});
