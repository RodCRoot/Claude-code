import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { actorOf } from "@/lib/billing/util";
import { eventRosterCsv } from "@/lib/events/queries";

/** Roster CSV for one event (staff with schedule.manage). The export is audited. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const v = await getViewer();
  if (!v) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const out = await db.transaction(async (tx) => {
      const r = await eventRosterCsv(tx, v, id);
      if (r) await audit(tx, actorOf(v), "events.roster.export", "event", id, { summary: `Exported roster CSV (${r.filename})` });
      return r;
    });
    if (!out) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new NextResponse(out.csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    throw e;
  }
}
