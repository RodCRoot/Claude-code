import { db } from "@/db";
import { exportCsv } from "@/lib/training/reports";
import { withViewer } from "@/lib/training/http";

const ymd = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
const uuid = (s: string | null) => (s && /^[0-9a-f-]{36}$/i.test(s) ? s : undefined);

/** CSV export of workouts or set logs. Scope: staff see their athletes; families see their own. */
export async function GET(req: Request) {
  return withViewer(req, async (v) => {
    const u = new URL(req.url);
    const kind = u.searchParams.get("kind") === "sets" ? "sets" : "workouts";
    const f = { athleteId: uuid(u.searchParams.get("athleteId")), groupId: uuid(u.searchParams.get("groupId")), from: ymd(u.searchParams.get("from")), to: ymd(u.searchParams.get("to")) };
    const csv = await db.transaction((tx) => exportCsv(tx, v, kind, f));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="training-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
