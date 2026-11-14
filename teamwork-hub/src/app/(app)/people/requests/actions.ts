"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { MemberRequestType } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import type { ActionState } from "@/lib/actions";
import { domainAction, str, strs } from "@/lib/messaging/action-helpers";
import { confirmSuggestion, createRequest, dismissSuggestion, scanForSuggestions, setRequestAthletes, updateRequest } from "@/lib/member-ops/requests";

const opt = (fd: FormData, k: string) => (fd.has(k) ? str(fd, k) : undefined);

export const createRequestAction = domainAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) =>
    createRequest(tx, v, {
      type: str(fd, "type") as MemberRequestType,
      channel: str(fd, "channel") as never,
      athleteIds: strs(fd, "athleteIds").filter(Boolean),
      requesterPersonId: str(fd, "requesterPersonId"),
      sentOn: str(fd, "sentOn"),
      receivedOn: str(fd, "receivedOn"),
      summary: str(fd, "summary"),
      requestedEffectiveOn: str(fd, "requestedEffectiveOn"),
      threadId: str(fd, "threadId"),
      pastedText: str(fd, "pastedText"),
      ownerUserId: str(fd, "ownerUserId"),
      status: (str(fd, "status") || "new") as "new" | "in_progress",
    }),
  );
  revalidatePath("/people/requests");
  return { ok: true, message: "Request logged." };
});

export const updateRequestAction = domainAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const id = str(fd, "requestId");
  await db.transaction(async (tx) => {
    await updateRequest(tx, v, id, {
      status: (opt(fd, "status") || undefined) as never,
      ownerUserId: opt(fd, "ownerUserId"),
      resolutionNotes: opt(fd, "resolutionNotes"),
      sentOn: opt(fd, "sentOn") || undefined,
      receivedOn: opt(fd, "receivedOn"),
      threadId: opt(fd, "threadId"),
      type: (opt(fd, "type") || undefined) as MemberRequestType | undefined,
    });
    const athleteIds = strs(fd, "athleteIds").filter(Boolean);
    if (athleteIds.length) await setRequestAthletes(tx, v, id, athleteIds);
  });
  revalidatePath("/people/requests");
  return { ok: true, message: "Request updated." };
});

export const confirmSuggestionAction = domainAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => confirmSuggestion(tx, v, str(fd, "requestId"), { type: (str(fd, "type") || undefined) as MemberRequestType | undefined }));
  revalidatePath("/people/requests");
  return { ok: true, message: "Confirmed — now in the open queue." };
});

export const dismissSuggestionAction = domainAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => dismissSuggestion(tx, v, str(fd, "requestId"), str(fd, "reason") || null));
  revalidatePath("/people/requests");
  return { ok: true, message: "Dismissed." };
});

export const scanSuggestionsAction = domainAction(async (_prev: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const days = Number(str(fd, "days") || 30);
  const r = await db.transaction((tx) => scanForSuggestions(tx, v, Number.isFinite(days) ? days : 30));
  revalidatePath("/people/requests");
  return { ok: true, message: `Scanned ${r.scanned} message(s); ${r.created} new suggestion(s).` };
});
