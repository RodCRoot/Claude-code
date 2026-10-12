"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { requireViewer } from "@/lib/auth/viewer";
import { disconnectCalendar } from "@/lib/calendar/tokens";

/** Disconnect a Google Calendar: own calendar for any staff member; anyone's for owner/admin (checked in the domain function). */
export async function disconnectCalendarAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const v = await requireViewer();
    const id = z.string().uuid().safeParse(fd.get("connectionId"));
    if (!id.success) throw new UserError("Missing or invalid reference. Reload the page and try again.");
    const { revoked } = await disconnectCalendar(db, v, { connectionId: id.data });
    revalidatePath("/schedule/settings");
    return {
      ok: true,
      message:
        revoked === false
          ? "Disconnected. Google didn't confirm the revocation — remove “Teamwork Hub” under Google Account → Security → Third-party access."
          : "Disconnected. Stored Google tokens were deleted.",
    };
  })();
}
