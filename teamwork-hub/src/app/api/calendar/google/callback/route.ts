import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { CalendarConnectError, completeGoogleConnection } from "@/lib/calendar/connect";
import { CALLBACK_PATH, googleOAuthConfig, OAUTH_COOKIE, OAuthStateError, OAuthTokenError } from "@/lib/calendar/oauth";
import { CalendarProviderError } from "@/lib/calendar/types";

export const dynamic = "force-dynamic";

const SETTINGS = "/schedule/settings?tab=availability";

/**
 * Google redirects here with `code` + `state` (or `error`). Query params are attacker-controlled:
 * the state is verified against the signed-in user and the browser's nonce cookie before the code
 * is exchanged server-side. Only a short result code is put in the redirect — never tokens.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const jar = await cookies();
  const cookieNonce = jar.get(OAUTH_COOKIE)?.value ?? null;
  // One-shot: the nonce cookie is consumed whatever happens next.
  jar.set(OAUTH_COOKIE, "", { httpOnly: true, path: CALLBACK_PATH, maxAge: 0 });

  if (url.searchParams.get("error")) redirect(`${SETTINGS}&calendar=denied`);
  const cfg = googleOAuthConfig();
  if (!cfg) redirect(`${SETTINGS}&calendar=not_configured`);
  const code = url.searchParams.get("code");
  if (!code) redirect(`${SETTINGS}&calendar=error`);

  let result = "connected";
  try {
    await completeGoogleConnection(db, viewer, { code, state: url.searchParams.get("state"), cookieNonce }, { cfg });
  } catch (e) {
    if (e instanceof OAuthStateError) result = e.code === "expired" ? "expired" : "invalid_state";
    else if (e instanceof AuthzError) result = "forbidden";
    else if (e instanceof CalendarConnectError) result = e.code;
    else if (e instanceof OAuthTokenError || e instanceof CalendarProviderError) {
      console.error("[calendar] Google connect failed:", e.name, e.message);
      result = "error";
    } else {
      console.error("[calendar] Google connect failed:", e instanceof Error ? e.name : "unknown");
      result = "error";
    }
  }
  redirect(`${SETTINGS}&calendar=${result}`);
}
