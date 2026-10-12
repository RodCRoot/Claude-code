import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { assertCanConnect } from "@/lib/calendar/connect";
import { CALLBACK_PATH, createAuthRequest, googleOAuthConfig, OAUTH_COOKIE, STATE_TTL_MS } from "@/lib/calendar/oauth";

export const dynamic = "force-dynamic";

const SETTINGS = "/schedule/settings?tab=availability";

/**
 * Starts Google Calendar consent for the SIGNED-IN staff member (never for another user id).
 * Sets a short-lived httpOnly cookie holding the flow nonce; `state` is signed and bound to the user.
 */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  try {
    assertCanConnect(viewer);
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const cfg = googleOAuthConfig();
  if (!cfg) redirect(`${SETTINGS}&calendar=not_configured`);
  const { url, nonce } = createAuthRequest(cfg, { userId: viewer.userId, orgId: viewer.orgId });
  const jar = await cookies();
  jar.set(OAUTH_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // must survive the top-level redirect back from accounts.google.com
    path: CALLBACK_PATH,
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  redirect(url);
}
