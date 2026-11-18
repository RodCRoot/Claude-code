import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { todayLocal } from "@/lib/time";
import { discountReview, discountReviewCsv } from "@/lib/zenplanner/discounts";

/** CSV of the discount review (imports.manage only; read-only; the download is audited). */
export async function GET(req: NextRequest) {
  const v = await getViewer();
  if (!v) return new NextResponse("Sign in required", { status: 401 });
  if (!can(v, "imports.manage")) return new NextResponse("Forbidden", { status: 403 });
  const b = req.nextUrl.searchParams.get("batch");
  const batchId = b && /^[0-9a-f-]{36}$/i.test(b) ? b : null;
  const csv = await db.transaction(async (tx) => {
    const r = await discountReview(tx, v, { batchId });
    await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.discount_review_download", "organization", v.orgId, { summary: "Downloaded the Zen Planner discount review CSV" });
    return discountReviewCsv(r);
  });
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="zenplanner-discount-review-${todayLocal()}.csv"`,
      "cache-control": "no-store",
    },
  });
}
