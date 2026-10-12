import { db } from "@/db";
import { json, withViewer } from "@/lib/training/http";
import { offlineTodayPayload } from "@/lib/training/offline";

/**
 * Today's workouts for the signed-in athlete, minimized for the offline logger. This is the only
 * response the training service worker stores (see public/training-sw.js); other roles get 403.
 */
export async function GET(req: Request) {
  return withViewer(req, async (v) => {
    const payload = await offlineTodayPayload(db, v);
    if (!payload) return json({ error: "Offline logging is only available to athletes on their own device." }, 403);
    return json(payload);
  });
}
