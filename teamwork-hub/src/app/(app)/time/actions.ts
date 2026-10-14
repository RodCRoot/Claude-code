"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { safeAction, type ActionState } from "@/lib/actions";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { clock, setStaffClockPin } from "@/lib/payroll/service";
import { DEFAULT_TZ, fmtTime } from "@/lib/time";

/** The signed-in staff member clocks themselves in or out (Today card, My time, or the kiosk in a staff session). */
export const clockToggleAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const source = fd.get("source") === "kiosk" ? "kiosk" : "staff";
  const r = await db.transaction((tx) => clock(tx, v, { op: "toggle", source }));
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  revalidatePath("/today");
  revalidatePath("/time");
  revalidatePath("/kiosk/clock");
  return {
    ok: true,
    message: r.action === "in" ? `Clocked in at ${fmtTime(r.at, tz)}.` : `Clocked out at ${fmtTime(r.at, tz)} (${((r.shiftMs ?? 0) / 3_600_000).toFixed(2)} h).`,
  };
});

export const setMyClockPinAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireStaff();
  const clear = fd.get("clear") === "1";
  await db.transaction((tx) => setStaffClockPin(tx, v, { userId: v.userId, pin: clear ? null : String(fd.get("pin") ?? "") }));
  revalidatePath("/time");
  return { ok: true, message: clear ? "Time-clock PIN removed." : "Time-clock PIN saved. Use it on the kiosk's Staff time clock." };
});
