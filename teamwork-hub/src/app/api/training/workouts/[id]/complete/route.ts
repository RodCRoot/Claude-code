import { db } from "@/db";
import { completeWorkout } from "@/lib/training/logging";
import { json, withViewer } from "@/lib/training/http";

/** Complete a workout with session RPE + duration; upserts the single linked activity session. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withViewer(req, async (v) => {
    const b = (await req.json().catch(() => ({}))) as { sessionRpe?: unknown; durationMinutes?: unknown; comment?: unknown };
    const r = await db.transaction((tx) =>
      completeWorkout(tx, v, id, {
        sessionRpe: Number(b.sessionRpe),
        durationMinutes: Number(b.durationMinutes),
        comment: typeof b.comment === "string" ? b.comment : null,
      }),
    );
    return json({ ok: true, ...r });
  });
}
