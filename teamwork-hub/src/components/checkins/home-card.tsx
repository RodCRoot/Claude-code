import Link from "next/link";
import { db } from "@/db";
import { buttonClass } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { pendingCheckins } from "@/lib/checkins/views";
import { fmt } from "@/lib/time";

/**
 * Family-facing card: the ready checks and after checks this person can answer right now.
 * Renders nothing when there is nothing to do. Server component; mounted on Athlete Home, the
 * family schedule and the reservations page. It replaces the old "How was the session?" card.
 * Sends nothing.
 */
export async function SessionCheckinCard({ viewer, athleteId }: { viewer: Viewer; athleteId?: string }) {
  if (viewer.role !== "guardian" && viewer.role !== "athlete") return null;
  const items = await db.transaction((tx) => pendingCheckins(tx, viewer, new Date(), { athleteId, limit: 4 }));
  if (!items.length) return null;
  const named = viewer.role === "guardian";
  return (
    <section aria-labelledby="session-checkins-h" className="overflow-hidden rounded-md border border-brand/30 bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="flex items-center justify-between gap-2 border-b border-edge bg-th px-4 py-2">
        <h2 id="session-checkins-h" className="text-[13px] font-bold uppercase tracking-wide text-ink-2">
          Session check-ins
        </h2>
        <Link href="/check-ins" className="text-xs font-semibold text-brand underline">
          History
        </Link>
      </div>
      <ul className="divide-y divide-edge">
        {items.map((i) => (
          <li key={`${i.kind}-${i.bookingId}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{i.kind === "ready" ? "Ready check" : "How was your session?"}</div>
              <div className="text-xs text-ink-3">
                {named ? `${i.athleteFirst} · ` : ""}
                {i.title} · {fmt(i.startsAt, "EEE MMM d, h:mm a", i.timezone)}
              </div>
            </div>
            <Link href={i.href} className={buttonClass(i.state === "open" ? "primary" : "secondary", "md", "min-h-11")}>
              {i.state === "editable" ? "Change answers" : i.kind === "ready" ? "Start ready check" : "Start after check"}
              <span className="sr-only">
                : {named ? `${i.athleteFirst}, ` : ""}
                {i.title}, {fmt(i.startsAt, "MMM d", i.timezone)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">Under 30 seconds each. They help your coach plan the session and make the next one better.</p>
    </section>
  );
}
