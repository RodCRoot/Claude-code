import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { toCsv } from "@/lib/reports";
import { scoreboardContext } from "@/lib/scoreboard/core";
import { exportTable } from "@/lib/scoreboard/tables";

/** CSV export of any scoreboard table. Same permission and same filter as the page it came from. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ table: string }> }) {
  const v = await getViewer();
  if (!v) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(v, "scoreboard.view")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { table } = await params;
  const sp = req.nextUrl.searchParams;
  const marketing = table.startsWith("marketing");
  const c = await scoreboardContext(db, v, marketing ? {} : { locationId: sp.get("location"), productId: sp.get("program") });
  const months = [6, 12, 24].includes(Number(sp.get("months"))) ? Number(sp.get("months")) : 6;
  const weeks = [4, 8, 12, 26].includes(Number(sp.get("weeks"))) ? Number(sp.get("weeks")) : 8;
  const t = await exportTable(db, v, c, table, { months, weeks });
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  await audit(db, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "scoreboard.export", "scoreboard", null, {
    summary: `${t.name} as of ${c.today}${c.filter.locationId ? ` location=${c.filter.locationId}` : ""}${c.filter.productId ? ` program=${c.filter.productId}` : ""}`,
  });
  return new NextResponse(toCsv(t.columns, t.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="teamwork-scoreboard-${t.name}-${c.today}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
