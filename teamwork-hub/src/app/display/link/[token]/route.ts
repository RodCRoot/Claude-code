import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { DISPLAY_COOKIE, resolveDisplayToken } from "@/lib/community/board";

/**
 * One-time setup link for a facility TV (Settings → Community). A valid token is moved out of the
 * URL into an httpOnly cookie and the TV lands on /display. The cookie is only ever read by the
 * board page and its data endpoint. An unknown or revoked token clears the cookie.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jar = await cookies();
  const ok = await resolveDisplayToken(db, token, { touch: true });
  if (ok) {
    jar.set(DISPLAY_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  } else {
    jar.delete(DISPLAY_COOKIE);
  }
  redirect("/display");
}
