import Link from "next/link";
import { db } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { sessionFeedbackSummary } from "@/lib/retention/feedback";
import { Badge } from "@/components/ui";

/**
 * Small staff-only line on the session page: average rating + count, and the responses this
 * viewer may read (all for owner/admin/operations; only "tell my coach" ones for the session's
 * coach). Renders nothing for anyone else or when there are no responses.
 */
export async function SessionFeedbackSummaryLine({ viewer, sessionId }: { viewer: Viewer; sessionId: string }) {
  const s = await sessionFeedbackSummary(db, viewer, sessionId);
  if (!s || s.count === 0) return null;
  return (
    <section aria-label="Session feedback" className="mb-4 rounded-md border border-edge bg-surface px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="kicker">Session feedback</span>
        {s.average != null ? (
          <span>
            <strong className="tabular">{s.average.toFixed(1)}</strong> of 5 average from {s.count} response{s.count === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-ink-3">
            {s.count} response{s.count === 1 ? "" : "s"}. The average shows from {s.minResponses} responses so no family is identifiable.
          </span>
        )}
      </div>
      {s.responses.length ? (
        <ul className="mt-1.5 space-y-1 border-t border-edge pt-1.5 text-xs">
          {s.responses.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2">
              <Link href={`/people/retention/feedback/${r.id}`} className="font-medium text-brand underline">
                {r.athleteName}: {r.rating} of 5
              </Link>
              {r.tellCoach ? <Badge variant="blue">shared with coach</Badge> : null}
              {r.comment ? <span className="text-ink-3">comment left</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
