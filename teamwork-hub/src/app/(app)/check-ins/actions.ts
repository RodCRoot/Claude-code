"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { formToObject, safeAction, UserError, type ActionState } from "@/lib/actions";
import { submitAfter, submitReady } from "@/lib/checkins/core";
import { HURT } from "@/lib/checkins/questions";
import { resetCheckinSettings, saveCheckinSettings } from "@/lib/checkins/settings";
import { closeExperienceFollowUp, reviewCheckin, setIntendedRpe } from "@/lib/checkins/views";

const s = (fd: FormData, k: string) => {
  const x = fd.get(k);
  return typeof x === "string" ? x : "";
};

/** The marked spot, or null when no body part was picked (the "something hurts" answer still counts). */
function spotFrom(fd: FormData) {
  if (s(fd, "hurt") !== "yes" || !s(fd, "spotRegion") || !s(fd, "spotSide") || !s(fd, "spotType")) return null;
  return { view: s(fd, "spotView"), region: s(fd, "spotRegion"), side: s(fd, "spotSide"), type: s(fd, "spotType"), level: s(fd, "spotLevel") || "3" };
}

export const submitReadyAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const bookingId = s(fd, "bookingId");
  const r = await db.transaction((tx) =>
    submitReady(tx, v, {
      bookingId,
      readiness: s(fd, "readiness") || undefined,
      sleepQuality: s(fd, "sleepQuality"),
      sleepHours: s(fd, "sleepHours"),
      soreness: s(fd, "soreness") || undefined,
      fatigue: s(fd, "fatigue"),
      mood: s(fd, "mood"),
      stress: s(fd, "stress"),
      priorSoreness: s(fd, "priorSoreness"),
      hurt: s(fd, "hurt"),
      spot: spotFrom(fd),
      note: s(fd, "note"),
    }),
  );
  revalidatePath(`/check-ins/${bookingId}/ready`);
  revalidatePath("/check-ins");
  revalidatePath("/today");
  const sharp = r.reasons.includes("sharp_pain");
  return { ok: true, message: sharp ? `Saved. ${HURT.sharpNote}` : "Saved. Your coach can see this before the session. Have a great one!" };
});

export const submitAfterAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const bookingId = s(fd, "bookingId");
  const r = await db.transaction((tx) =>
    submitAfter(tx, v, {
      bookingId,
      rpe: s(fd, "rpe"),
      liked: fd.getAll("liked").filter((x): x is string => typeof x === "string"),
      likedText: s(fd, "likedText"),
      disliked: fd.getAll("disliked").filter((x): x is string => typeof x === "string"),
      dislikedText: s(fd, "dislikedText"),
      nothingToChange: s(fd, "nothingToChange"),
      hurt: s(fd, "hurt"),
      spot: spotFrom(fd),
      hurtStartedInSession: s(fd, "hurtStartedInSession"),
      soreness: s(fd, "soreness"),
      rating: s(fd, "rating"),
      note: s(fd, "note"),
      tellCoach: s(fd, "tellCoach"),
    }),
  );
  revalidatePath(`/check-ins/${bookingId}/after`);
  revalidatePath("/check-ins");
  revalidatePath("/today");
  revalidatePath("/schedule");
  return { ok: true, message: r.sharp ? `Thank you. Your answers were saved. ${HURT.sharpNote}` : "Thank you. Your answers were saved." };
});

export const setIntendedRpeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const sessionId = z.string().uuid().parse(s(fd, "sessionId"));
  const raw = s(fd, "intendedRpe").trim();
  const n = raw === "" ? null : Number(raw);
  if (n !== null && !Number.isFinite(n)) throw new UserError("Planned intensity is a whole number from 0 to 10.");
  await db.transaction((tx) => setIntendedRpe(tx, v, { sessionId, intendedRpe: n }));
  revalidatePath(`/schedule/sessions/${sessionId}`);
  return { ok: true, message: n === null ? "Planned intensity cleared." : `Planned intensity saved: ${n} of 10.` };
});

export const reviewCheckinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = z.string().uuid().parse(s(fd, "checkinId"));
  await db.transaction((tx) => reviewCheckin(tx, v, id));
  revalidatePath(`/check-ins/responses/${id}`);
  revalidatePath("/check-ins");
  revalidatePath("/follow-ups");
  return { ok: true, message: "Marked as reviewed." };
});

export const closeExperienceFollowUpAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = z.string().uuid().parse(s(fd, "checkinId"));
  await db.transaction((tx) => closeExperienceFollowUp(tx, v, id));
  revalidatePath(`/check-ins/responses/${id}`);
  revalidatePath("/check-ins");
  revalidatePath("/follow-ups");
  return { ok: true, message: "Follow-up marked done." };
});

export const saveCheckinSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const s2 = await db.transaction((tx) => saveCheckinSettings(tx, v, formToObject(fd)));
  revalidatePath("/settings/check-ins");
  revalidatePath("/check-ins");
  return { ok: true, message: `Saved. Question set ${s2.revision === 1 ? "1.1" : `1.${s2.revision}`}.` };
});

export const resetCheckinSettingsAction = safeAction(async () => {
  const v = await requireViewer();
  await db.transaction((tx) => resetCheckinSettings(tx, v));
  revalidatePath("/settings/check-ins");
  return { ok: true, message: "Reset to the defaults." };
});
