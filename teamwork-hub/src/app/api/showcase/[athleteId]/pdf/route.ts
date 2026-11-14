import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { renderShowcasePdf } from "@/lib/showcase/pdf";
import { privateShowcaseData } from "@/lib/showcase/showcase";

/**
 * Download the Showcase as a one-page PDF. Family only: the athlete or a guardian with profile
 * access (a minor athlete only once a guardian has published). Built from the same allowlisted
 * payload as the public page; the SHA-256 of that payload is in the footer and the response
 * headers. Never cached; every download is audited.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ athleteId: string }> }) {
  const { athleteId } = await params;
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in required", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(athleteId)) return new NextResponse("Not found or not permitted", { status: 404 });
  try {
    const { bytes, contentHash } = await db.transaction(async (tx) => {
      const { data, row } = await privateShowcaseData(tx, v, athleteId, { forPdf: true });
      const out = await renderShowcasePdf(data, { draft: row?.status !== "published" });
      await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "showcase.pdf.download", "showcase", row?.id ?? null, { summary: `Showcase PDF downloaded (content ${out.contentHash.slice(0, 12)})` });
      return out;
    });
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": 'attachment; filename="athlete-showcase.pdf"',
        "x-content-sha256": contentHash,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return new NextResponse("Not found or not permitted", { status: 404 });
    throw e;
  }
}
