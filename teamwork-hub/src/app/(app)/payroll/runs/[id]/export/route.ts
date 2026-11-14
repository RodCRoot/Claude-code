import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { UserError } from "@/lib/actions";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { exportRun } from "@/lib/payroll/service";

/** CSV export of an approved payroll run (marks it exported; audited). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const v = await getViewer();
  if (!v) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const { csv, filename } = await db.transaction((tx) => exportRun(tx, v, id));
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
