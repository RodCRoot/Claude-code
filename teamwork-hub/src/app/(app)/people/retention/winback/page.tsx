import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { fmt, fmtDate } from "@/lib/time";
import { tenureLabel } from "@/lib/retention/common";
import { winbackList } from "@/lib/retention/winback";
import { ActionForm, SubmitButton } from "@/components/forms";
import { EmptyState, PageHeader } from "@/components/ui";
import { MemberAvatar, Widget } from "@/components/profile/studio";
import { PeopleTabs } from "@/components/people-tabs";
import { RetentionNav } from "@/components/retention/parts";
import { createFollowUpTaskAction } from "../actions";

export const metadata = { title: "Winback list" };

export default async function WinbackPage() {
  const v = await requireCap("retention.manage");
  const { rows, since } = await winbackList(db, v);
  return (
    <>
      <PageHeader
        kicker="People"
        title="Winback list"
        description={`Members whose last membership ended since ${fmtDate(since)} and who have no membership now. For personal outreach: the only action is a staff task. Nothing is sent.`}
      />
      <PeopleTabs current="retention" showLeads={can(v, "crm.manage")} showRequests={can(v, "people.manage") || can(v, "crm.manage")} />
      <div className="mb-4">
        <RetentionNav current="winback" manager />
      </div>
      <Widget title="Ended in the last 12 months" count={rows.length} icon="people" flush>
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No one to win back">No memberships ended in the last 12 months.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-edge">
            {rows.map((r) => (
              <li key={r.athleteId} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <MemberAvatar name={r.name} />
                  <div className="min-w-0">
                    <Link href={`/people/${r.personId}`} className="text-sm font-semibold hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-ink-3">{r.lastPlan}</div>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-ink-3">Ended</dt>
                    <dd className="font-medium text-ink-2">{fmtDate(r.endedOn)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Tenure</dt>
                    <dd className="font-medium text-ink-2">{tenureLabel(r.tenureMonths)}</dd>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <dt className="text-ink-3">End reason{r.reasonSource !== "none" ? ` (${r.reasonSource})` : ""}</dt>
                    <dd className="font-medium text-ink-2">{r.endReason}</dd>
                  </div>
                  {r.lastTask ? (
                    <div className="col-span-2 sm:col-span-3">
                      <dt className="sr-only">Latest task</dt>
                      <dd className="text-ink-3">
                        Latest task: {r.lastTask.title} · {fmt(r.lastTask.at, "MMM d, yyyy")}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <ActionForm action={createFollowUpTaskAction}>
                  <input type="hidden" name="athleteId" value={r.athleteId} />
                  <input type="hidden" name="kind" value="winback" />
                  <SubmitButton size="sm" variant="secondary" pendingText="Creating…">
                    Create follow-up task<span className="sr-only"> for {r.name}</span>
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Widget>
    </>
  );
}
