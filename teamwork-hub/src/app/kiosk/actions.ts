"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { cookies } from "next/headers";
import { destroySession, SESSION_COOKIE, sha256, STAFF_ROLES, verifyCredentials } from "@/lib/auth/session";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { kioskCheckIn } from "@/lib/scheduling/kiosk";
import { kioskPinCheckIn } from "@/lib/scheduling/kiosk-pin";
import { DEFAULT_TZ, fmtTime } from "@/lib/time";

export async function kioskCheckInAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const v = await requireViewer();
    const id = z.string().uuid().safeParse(fd.get("bookingId"));
    if (!id.success) throw new UserError("Please try again.");
    const r = await db.transaction((tx) => kioskCheckIn(tx, v, { bookingId: id.data }));
    revalidatePath("/kiosk");
    return { ok: true, message: r.changed === false ? "Already checked in." : "You're checked in. Have a great session!" };
  })();
}

/** PIN check-in. Rate limited per kiosk login session (keyed by the session token hash, never the token). */
export async function kioskPinCheckInAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const v = await requireViewer();
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) throw new UserError("Please sign the kiosk in again.");
    const r = await db.transaction((tx) => kioskPinCheckIn(tx, v, { pin: String(fd.get("pin") ?? ""), sessionKey: sha256(token) }));
    if (!r.ok) {
      const error =
        r.reason === "invalid_format"
          ? "Enter your 4–6 digit PIN."
          : r.reason === "locked"
            ? `Too many tries. Please wait ${Math.ceil(r.retryAfterSeconds / 60)} minute(s) or see the front desk.`
            : `That PIN didn't match. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? "try" : "tries"} left.`;
      return { ok: false, error };
    }
    revalidatePath("/kiosk");
    const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
    const checkedIn = r.sessions.filter((s) => s.result === "checked_in").length;
    const message = !r.sessions.length
      ? `Hi ${r.displayName}! You're not booked for a session today. Please see the front desk.`
      : checkedIn
        ? `You're checked in, ${r.displayName}. Have a great session!`
        : `Hi ${r.displayName}!`;
    return {
      ok: true,
      message,
      data: {
        name: r.displayName,
        alerts: r.alerts,
        sessions: r.sessions.map((s) => ({ title: s.title, time: `${fmtTime(s.startsAt, tz)} – ${fmtTime(s.endsAt, tz)}`, result: s.result })),
      },
    };
  })();
}

/** Leaving kiosk mode requires a staff member's credentials (same org). */
export async function kioskExitAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const v = await requireViewer();
  if (v.role !== "kiosk") redirect("/schedule");
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Enter a staff email and password." };
  const res = await verifyCredentials(email, password);
  if (!res.ok) return { ok: false, error: res.error };
  const [u] = await db.select({ id: users.id, role: users.role, orgId: users.orgId }).from(users).where(eq(users.id, res.userId));
  if (!u || u.orgId !== v.orgId || !STAFF_ROLES.includes(u.role)) {
    await audit(db, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "kiosk.exit_denied", "user", u?.id ?? null, { summary: "Non-staff credentials used to exit kiosk" });
    return { ok: false, error: "Only staff can exit the kiosk." };
  }
  await audit(db, { orgId: v.orgId, actorUserId: u.id, actorRole: u.role }, "kiosk.exit", "user", v.userId, { summary: "Kiosk signed out by staff" });
  await destroySession();
  redirect("/login");
}
