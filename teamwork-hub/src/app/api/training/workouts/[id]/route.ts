import { db } from "@/db";
import { canOnAthlete } from "@/lib/authz/policy";
import { workoutDetail } from "@/lib/training/logging";
import { json, withViewer } from "@/lib/training/http";

/** Workout detail for the logger / weight-room panel (training.read on the athlete). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withViewer(req, async (v) => {
    const w = await workoutDetail(db, v, id);
    const canLog = await canOnAthlete(db, v, w.athleteId, "training.log");
    return json({ workout: w, canLog });
  });
}
