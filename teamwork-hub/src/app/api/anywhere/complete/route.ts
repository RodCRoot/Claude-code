import { z } from "zod";
import { db } from "@/db";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { completeSession, completionInput } from "@/lib/anywhere/sessions";
import { reportError } from "@/lib/observability";
import { json, withViewer } from "@/lib/training/http";

const body = z.object({ items: z.array(z.unknown()).min(1).max(25) });

type Result = { clientKey: string; status: "applied" | "duplicate" | "rejected" | "error"; error?: string };

/**
 * Save-and-retry endpoint for finished On Your Own sessions. Each item is applied in its own
 * transaction and is idempotent by clientKey, so a retry after a lost response never creates a
 * second completion. Per-item results let the device drop what was saved (or refused for good)
 * and keep retrying only temporary failures. Scope is re-checked per item in completeSession.
 */
export async function POST(req: Request) {
  return withViewer(req, async (v) => {
    const parsed = body.parse(await req.json().catch(() => ({})));
    const results: Result[] = [];
    for (const raw of parsed.items) {
      const cid = (raw as { clientKey?: unknown })?.clientKey;
      const clientKey = typeof cid === "string" ? cid : "";
      const m = completionInput.safeParse(raw);
      if (!m.success) {
        results.push({ clientKey, status: "rejected", error: m.error.issues[0]?.message ?? "Invalid entry" });
        continue;
      }
      try {
        const r = await db.transaction((tx) => completeSession(tx, v, m.data));
        results.push({ clientKey, status: r.status });
      } catch (e) {
        const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
        if (code === "23505") results.push({ clientKey, status: "duplicate" });
        else if (e instanceof AuthzError || e instanceof UserError) results.push({ clientKey, status: "rejected", error: e.message });
        else {
          reportError(e, { where: "route:/api/anywhere/complete", op: "complete" });
          results.push({ clientKey, status: "error", error: "Temporary server error" });
        }
      }
    }
    return json({ results });
  });
}
