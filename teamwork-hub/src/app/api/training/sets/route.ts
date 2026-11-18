import { z } from "zod";
import { db } from "@/db";
import { AuthzError } from "@/lib/authz/policy";
import { TrainingError } from "@/lib/training/common";
import { applySetMutation, setMutationSchema, type SetMutationResult } from "@/lib/training/logging";
import { json, withViewer } from "@/lib/training/http";
import { reportError } from "@/lib/observability";

const body = z.object({
  mutations: z.array(z.unknown()).min(1).max(200),
  via: z.enum(["athlete_app", "weight_room"]).optional(),
});

/**
 * Offline-queue sync endpoint. Each mutation is applied in its own transaction and is
 * idempotent by clientMutationId and by (workout_item, set_index, side). Per-mutation
 * results let the client drop applied/duplicate/stale/rejected entries and retry errors.
 */
export async function POST(req: Request) {
  return withViewer(req, async (v) => {
    const parsed = body.parse(await req.json().catch(() => ({})));
    const via = v.role === "athlete" ? "athlete_app" : parsed.via === "weight_room" ? "weight_room" : "coach";
    const results: (SetMutationResult | { clientMutationId: string; status: "error"; error: string })[] = [];
    for (const raw of parsed.mutations) {
      const m = setMutationSchema.safeParse(raw);
      const cid = (raw as { clientMutationId?: unknown })?.clientMutationId;
      if (!m.success) {
        results.push({ clientMutationId: typeof cid === "string" ? cid : "", status: "rejected", error: m.error.issues[0]?.message ?? "Invalid entry" });
        continue;
      }
      try {
        results.push(await db.transaction((tx) => applySetMutation(tx, v, m.data, via)));
      } catch (e) {
        const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
        if (code === "23505") {
          // Raced with an identical retry: the other request stored it.
          results.push({ clientMutationId: m.data.clientMutationId, status: "duplicate", setLogId: "" });
        } else if (e instanceof AuthzError || e instanceof TrainingError) {
          results.push({ clientMutationId: m.data.clientMutationId, status: "rejected", error: e.message });
        } else {
          reportError(e, { where: "route:/api/training/sets", op: "set_mutation" });
          results.push({ clientMutationId: m.data.clientMutationId, status: "error", error: "Temporary server error" });
        }
      }
    }
    return json({ results });
  });
}
