import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { rejectedRowsCsv } from "@/lib/imports/reconcile";
import { UserError } from "@/lib/actions";

/** CSV of rejected + duplicate rows with reasons (imports.manage only). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in required", { status: 401 });
  if (!can(v, "imports.manage")) return new NextResponse("Forbidden", { status: 403 });
  try {
    const csv = await db.transaction(async (tx) => {
      const out = await rejectedRowsCsv(tx, v, id);
      await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "import.rejected_download", "import_batch", id);
      return out;
    });
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="import-${id.slice(0, 8)}-rejected-rows.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof UserError) return new NextResponse(e.message, { status: 404 });
    throw e;
  }
}
