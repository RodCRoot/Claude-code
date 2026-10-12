import "server-only";
import { z } from "zod";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { TrainingError } from "./common";

const NO_STORE = { "Cache-Control": "no-store" };

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** Reject cross-site POSTs (route handlers don't get Server Actions' built-in origin check). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Authenticated JSON handler with consistent error mapping (401/403/400/422/500). */
export async function withViewer(req: Request, fn: (v: Viewer) => Promise<Response>): Promise<Response> {
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "Cross-origin request rejected." }, 403);
  const v = await getViewer();
  if (!v) return json({ error: "Not signed in." }, 401);
  try {
    return await fn(v);
  } catch (e) {
    if (e instanceof AuthzError) return json({ error: e.message }, 403);
    if (e instanceof z.ZodError) return json({ error: "Invalid input.", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    if (e instanceof TrainingError) return json({ error: e.message }, 422);
    console.error(JSON.stringify({ level: "error", msg: "training_api_failed", name: (e as Error)?.name, message: (e as Error)?.message }));
    return json({ error: "Server error. Your entries are kept and will be retried." }, 500);
  }
}
