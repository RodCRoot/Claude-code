import { db } from "@/db";
import { boardPayload } from "@/lib/community/board";
import { displayAccess } from "@/lib/community/display-access";
import { reportError } from "@/lib/observability";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

/**
 * The gym TV board payload: the only data a display device can read. GET only, read-only.
 * 401 for a missing, unknown or revoked display token (the board then blanks itself).
 */
export async function GET() {
  const access = await displayAccess();
  if (!access) return Response.json({ error: "This screen is not connected." }, { status: 401, headers: HEADERS });
  try {
    return Response.json(await boardPayload(db, access.orgId), { headers: HEADERS });
  } catch (e) {
    reportError(e, { where: "route:/api/display/board" });
    return Response.json({ error: "Temporary server error." }, { status: 500, headers: HEADERS });
  }
}
