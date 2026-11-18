import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { authorizeExportDownload } from "@/lib/exports/bundle";

/**
 * Download a stored export bundle. Org-wide exports: imports.manage only. Per-athlete exports:
 * imports.manage, or staff with profile access to that athlete AND at least the health/billing
 * access the export was generated with. Every download is audited.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in required", { status: 401 });
  try {
    const { object, bytes } = await db.transaction((tx) => authorizeExportDownload(tx, v, id));
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${object.filename.replace(/"/g, "")}"`,
        "x-content-sha256": object.sha256,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return new NextResponse("Not found or not permitted", { status: 404 });
    throw e;
  }
}
