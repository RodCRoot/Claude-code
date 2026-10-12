import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer, getOrg } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { reportByKey, toCsv } from "@/lib/reports";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { audit } from "@/lib/audit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const v = await getViewer();
  if (!v || !isStaff(v)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { key } = await params;
  const def = reportByKey(key);
  if (!def) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!can(v, def.cap)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const tz = (await getOrg(v.orgId))?.timezone ?? "America/Indiana/Indianapolis";
  const valid = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const to = valid(req.nextUrl.searchParams.get("to")) ?? todayLocal(tz);
  const from = valid(req.nextUrl.searchParams.get("from")) ?? addDaysYmd(to, -29);
  const result = await def.run(db, v.orgId, { from, to, tz });
  await audit(db, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "report.export", "report", def.key, { summary: `${from}..${to}` });
  return new NextResponse(toCsv(def.columns, result.rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="teamwork-${def.key}-${from}-to-${to}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
