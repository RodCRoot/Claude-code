import Link from "next/link";
import { db } from "@/db";
import { can, type Viewer } from "@/lib/authz/policy";
import { fmtDate } from "@/lib/time";
import { milestonesThisWeek, type Milestone } from "@/lib/retention/milestones";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge } from "@/components/ui";
import { MemberAvatar, Widget, WidgetEmpty } from "@/components/profile/studio";
import { createShoutoutTaskAction } from "@/app/(app)/people/retention/actions";

const WHEN: Record<Milestone["when"], { label: string; variant: "green" | "blue" | "neutral" }> = {
  today: { label: "Today", variant: "green" },
  upcoming: { label: "Coming up", variant: "blue" },
  recent: { label: "This week", variant: "neutral" },
};

const weekday = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * Staff dashboard card: this week's membership anniversaries, session-count milestones, birthdays
 * (staff only) and "first 30 days" marks, each with a "Create shoutout task" action. Nothing is
 * sent to families.
 */
export async function MilestonesCard({ v, className }: { v: Viewer; className?: string }) {
  if (!can(v, "retention.view")) return null;
  const { items, week } = await milestonesThisWeek(db, v);
  const shown = items.slice(0, 8);
  return (
    <Widget title="Milestones this week" icon="performance" count={items.length} href="/people/retention" linkLabel="Retention" className={className} flush>
      {items.length === 0 ? (
        <div className="px-4 py-3">
          <WidgetEmpty>
            No anniversaries, session milestones or birthdays between {fmtDate(week.start)} and {fmtDate(week.end)}.
          </WidgetEmpty>
        </div>
      ) : (
        <ul className="divide-y divide-edge">
          {shown.map((m) => (
            <li key={`${m.athleteId}:${m.key}`} className="px-4 py-2.5">
              <div className="flex items-start gap-3">
                <MemberAvatar name={m.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <Link href={`/people/${m.personId}`} className="block truncate text-sm font-medium hover:underline">
                    {m.name}
                  </Link>
                  <span className="block text-xs text-ink-2">
                    {m.label}
                    {m.date ? <span className="text-ink-3"> · {weekday(m.date)}</span> : null}
                  </span>
                </span>
                <Badge variant={WHEN[m.when].variant}>{WHEN[m.when].label}</Badge>
              </div>
              <ActionForm action={createShoutoutTaskAction} className="mt-1.5 pl-10">
                <input type="hidden" name="athleteId" value={m.athleteId} />
                <input type="hidden" name="key" value={m.key} />
                <SubmitButton size="sm" variant="secondary" pendingText="Creating…">
                  Create shoutout task<span className="sr-only"> for {m.name}: {m.label}</span>
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      {items.length > shown.length ? <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">+ {items.length - shown.length} more this week</p> : null}
      <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">Birthdays are shown to staff only. Shoutouts are personal: nothing is sent automatically.</p>
    </Widget>
  );
}
