import Link from "next/link";
import { db } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { goLiveReadiness } from "@/lib/golive/readiness";

/**
 * Owner and admin only: "Go-live: N blocking items". Renders nothing once no item blocks, so it
 * disappears by itself. The count comes from the same computation as /settings/go-live.
 */
export async function GoLiveTodayCard({ v, className }: { v: Viewer; className?: string }) {
  if (v.role !== "owner" && v.role !== "admin") return null;
  const report = await goLiveReadiness(db, v);
  if (!report.blocking) return null;
  return (
    <Link
      href="/settings/go-live"
      data-testid="golive-today-card"
      className={`flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/40 bg-warn/5 px-4 py-2.5 text-sm hover:bg-warn/10 ${className ?? ""}`}
    >
      <span className="font-semibold">
        Go-live: {report.blocking} blocking {report.blocking === 1 ? "item" : "items"}
      </span>
      <span className="text-xs text-ink-2">
        {report.done} of {report.total} done. <span className="underline">Open the checklist</span>
      </span>
    </Link>
  );
}
