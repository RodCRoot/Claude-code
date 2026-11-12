import Link from "next/link";
import { db } from "@/db";
import { can, type Viewer } from "@/lib/authz/policy";
import { followUpQueue, reachOutLists } from "@/lib/journey/steps";
import { Badge } from "@/components/ui";
import { Widget, WidgetEmpty } from "@/components/profile/studio";

/**
 * Today's follow-ups on the staff dashboard: counts by type, the most overdue few, and how many
 * no-shows and absent members are waiting for a reach-out. Read-only here (the queue page runs the
 * generator and has the actions). Scope and billing rules are those of followUpQueue.
 */
export async function FollowUpsTodayCard({ v, className }: { v: Viewer; className?: string }) {
  if (!can(v, "journey.view")) return null;
  const [queue, lists] = await Promise.all([followUpQueue(db, v), reachOutLists(db, v)]);
  const top = queue.steps.slice(0, 5);
  return (
    <Widget title="Today's follow-ups" icon="today" count={queue.steps.length} href="/follow-ups" linkLabel="Open queue" className={className} flush>
      {queue.steps.length === 0 ? (
        <div className="px-4 py-3">
          <WidgetEmpty>No journey step is due or overdue.</WidgetEmpty>
        </div>
      ) : (
        <>
          <ul className="flex flex-wrap gap-2 border-b border-edge px-4 py-2.5" aria-label="Due by type">
            {queue.groups.map((g) => (
              <li key={g.kind}>
                <Link href={`/follow-ups?kind=${g.kind}`} className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-edge px-2.5 text-xs font-semibold hover:bg-surface-2">
                  {g.label}
                  <span className="tabular text-ink-3">{g.steps.length}</span>
                </Link>
              </li>
            ))}
          </ul>
          <ul className="divide-y divide-edge">
            {top.map((s) => (
              <li key={s.taskId} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{s.name}</span>
                  <Link href={`/people/${s.personId}`} className="text-xs text-ink-2 underline">
                    {s.athleteName}
                  </Link>
                </span>
                {s.overdueDays > 0 ? <Badge variant="red">{s.overdueDays}d overdue</Badge> : <Badge variant="yellow">Today</Badge>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">
        {lists.noShows.length} no-show{lists.noShows.length === 1 ? "" : "s"} yesterday and {lists.absent.length} absent member{lists.absent.length === 1 ? "" : "s"} to reach out to.{" "}
        <Link href="/follow-ups" className="font-semibold text-brand underline">
          Log a reach-out
        </Link>
      </p>
    </Widget>
  );
}
