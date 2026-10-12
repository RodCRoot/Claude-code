import "server-only";
import { z } from "zod";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/billing/errors";
import { ProviderNotConfiguredError } from "@/lib/payments";
import { sameOrigin } from "@/lib/training/http";

export const billingJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Authenticated, same-origin JSON handler for payment route handlers (no Server Action origin check here). */
export async function withBillingViewer(req: Request, fn: (v: Viewer) => Promise<Response>): Promise<Response> {
  if (!sameOrigin(req)) return billingJson({ error: "Cross-origin request rejected." }, 403);
  const v = await getViewer();
  if (!v) return billingJson({ error: "Not signed in." }, 401);
  try {
    return await fn(v);
  } catch (e) {
    if (e instanceof AuthzError) return billingJson({ error: e.message }, 403);
    if (e instanceof z.ZodError) return billingJson({ error: "Invalid input." }, 400);
    if (e instanceof UserError) return billingJson({ error: e.message }, 422);
    if (e instanceof ProviderNotConfiguredError) return billingJson({ error: e.message, notConfigured: true }, 503);
    console.error(JSON.stringify({ level: "error", msg: "payments_api_failed", name: (e as Error)?.name, message: (e as Error)?.message }));
    return billingJson({ error: "The payment provider could not be reached. Nothing was marked paid." }, 502);
  }
}
