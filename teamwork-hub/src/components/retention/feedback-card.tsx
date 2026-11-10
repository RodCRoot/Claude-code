import Link from "next/link";
import { db } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { pendingFeedback } from "@/lib/retention/feedback";
import { Badge, buttonClass } from "@/components/ui";

/**
 * Family-facing "How was the session?" card: recent attended sessions the viewer may rate.
 * Renders nothing when there is nothing to rate. Server component; mount anywhere a guardian
 * or athlete lands (currently the family schedule page). Sends nothing.
 */
export async function SessionFeedbackCard({ viewer, athleteId }: { viewer: Viewer; athleteId?: string }) {
  const all = await pendingFeedback(db, viewer);
  const items = (athleteId ? all.filter((i) => i.athleteId === athleteId) : all).slice(0, 3);
  if (!items.length) return null;
  const several = new Set(all.map((i) => i.athleteId)).size > 1 || viewer.role === "guardian";
  return (
    <section aria-labelledby="session-feedback-h" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="border-b border-edge bg-th px-4 py-2">
        <h2 id="session-feedback-h" className="text-[13px] font-bold uppercase tracking-wide text-ink-2">
          How was the session?
        </h2>
      </div>
      <ul className="divide-y divide-edge">
        {items.map((i) => (
          <li key={i.bookingId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium">{i.title}</div>
              <div className="text-xs text-ink-3">
                {several ? `${i.athleteFirst} · ` : ""}
                {fmt(i.startsAt, "EEE MMM d, h:mm a", i.timezone)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {i.rating != null ? <Badge variant="green">Rated {i.rating} of 5</Badge> : null}
              {i.state === "locked" ? null : (
                <Link href={`/feedback/${i.bookingId}`} className={buttonClass(i.state === "open" ? "primary" : "secondary", "md", "min-h-11")}>
                  {i.state === "open" ? "Rate it" : "Change"}
                  <span className="sr-only">
                    : {i.title}, {fmt(i.startsAt, "MMM d", i.timezone)}
                  </span>
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">A quick 1 to 5 rating helps us coach better. Coaches see only averages unless you choose “tell my coach”.</p>
    </section>
  );
}
