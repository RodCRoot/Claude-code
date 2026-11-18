import "server-only";
import { cookies } from "next/headers";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { DISPLAY_COOKIE, resolveDisplayToken } from "./board";

export type DisplayAccess = { orgId: string; via: "device" | "preview" };

/**
 * Who may read the gym TV board on this request:
 *  - a display device: the httpOnly display cookie holding a token that is not revoked;
 *  - a signed-in owner or admin previewing the board from Settings.
 * Used by exactly two handlers: the /display page and GET /api/display/board. The display cookie
 * is not a session: `getViewer()` ignores it, so a TV is signed out everywhere else.
 */
export async function displayAccess(): Promise<DisplayAccess | null> {
  const jar = await cookies();
  const device = await resolveDisplayToken(db, jar.get(DISPLAY_COOKIE)?.value, { touch: true });
  if (device) return { orgId: device.orgId, via: "device" };
  const v = await getViewer();
  if (v && can(v, "settings.manage")) return { orgId: v.orgId, via: "preview" };
  return null;
}
