import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listLocations, parseLocationParam } from "@/lib/locations";
import { followUpQueue, reachOutLists, staffOptions } from "@/lib/journey/steps";
import { syncJourneys } from "@/lib/journey/sync";
import { JOURNEY_KIND_LABEL, OWNER_ROLE_LABEL } from "@/lib/journey/templates";
import { JOURNEY_KINDS, type JourneyKind } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardHeader, EmptyState, PageHeader, Select, buttonClass } from "@/components/ui";
import { FollowUpTabs } from "@/components/journey/tabs";
import { StepRow } from "@/components/journey/step-row";
import { ReachOutItem } from "@/components/journey/reach-out";
import { fmtDate } from "@/lib/time";
import { syncJourneysAction } from "./actions";

export const metadata = { title: "Today's follow-ups" };

export default async function FollowUpsPage({ searchParams }: { searchParams: Promise<{ owner?: string; location?: string; kind?: string }> }) {
  const v = await requireCap("journey.view");
  const sp = await searchParams;
  // Same generator as the nightly job, so the queue is right even when no worker is running.
  await db.transaction((tx) => syncJourneys(tx, v.orgId));
  const location = parseLocationParam(sp.location);
  const kind = JOURNEY_KINDS.includes(sp.kind as JourneyKind) ? (sp.kind as JourneyKind) : undefined;
  const owner = sp.owner || "all";
  const [queue, lists, staff, locations] = await Promise.all([followUpQueue(db, v, { owner, location, kind }), reachOutLists(db, v), staffOptions(db, v), listLocations(db, v.orgId, { activeOnly: true })]);
  const coach = v.role === "coach";

  return (
    <>
      <PageHeader
        kicker="Front desk"
        title="Today's follow-ups"
        description={`Everything due or overdue across members as of ${fmtDate(queue.today)}, plus yesterday's no-shows and members who have been away. Steps are created from memberships, holds, cancellations and visit counts, and tick themselves where the system can see the answer. Nothing here sends a message.`}
        actions={
          <ActionForm action={syncJourneysAction}>
            <SubmitButton variant="secondary" pendingText="Refreshing…">
              Refresh now
            </SubmitButton>
          </ActionForm>
        }
      />
      <FollowUpTabs current="queue" showReport={can(v, "journey.report")} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-edge bg-surface px-4 py-3">
        <div className="min-w-40 flex-1 sm:flex-none">
          <label htmlFor="f-owner" className="mb-1 block text-xs font-semibold text-ink-2">
            Owner
          </label>
          <Select id="f-owner" name="owner" defaultValue={owner}>
            <option value="all">Everyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            {(["owner", "operations", "coach"] as const).map((r) => (
              <option key={r} value={r}>
                Role: {OWNER_ROLE_LABEL[r]}
              </option>
            ))}
            {coach
              ? null
              : staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
          </Select>
        </div>
        {locations.length ? (
          <div className="min-w-40 flex-1 sm:flex-none">
            <label htmlFor="f-location" className="mb-1 block text-xs font-semibold text-ink-2">
              Location
            </label>
            <Select id="f-location" name="location" defaultValue={location ?? ""}>
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="min-w-40 flex-1 sm:flex-none">
          <label htmlFor="f-kind" className="mb-1 block text-xs font-semibold text-ink-2">
            Type
          </label>
          <Select id="f-kind" name="kind" defaultValue={kind ?? ""}>
            <option value="">All types</option>
            {JOURNEY_KINDS.map((k) => (
              <option key={k} value={k}>
                {JOURNEY_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonClass("secondary", "md")}>
          Apply filters
        </button>
      </form>

      {coach ? (
        <Callout className="mb-4">You see steps for athletes assigned to you. Billing steps are handled by the front desk and are not listed here.</Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {queue.groups.length === 0 ? (
            <Card>
              <EmptyState title="Nothing due">No journey step is due or overdue for this filter.</EmptyState>
            </Card>
          ) : null}
          {queue.groups.map((g) => (
            <Card key={g.kind}>
              <CardHeader title={g.label} kicker={`${g.steps.length} due`} />
              <ul className="divide-y divide-edge" aria-label={`${g.label} steps`}>
                {g.steps.map((s) => (
                  <StepRow key={s.taskId} s={s} staff={staff} coachView={coach} />
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card id="no-shows">
            <CardHeader title="Yesterday's no-shows" kicker={`${lists.noShows.length}`} />
            {lists.noShows.length ? (
              <ul className="divide-y divide-edge">
                {lists.noShows.map((r) => (
                  <ReachOutItem key={r.athleteId} r={r} reason="no_show" />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-3">No no-shows yesterday.</p>
            )}
          </Card>
          <Card id="absent">
            <CardHeader title="Absent members" kicker={`${lists.absent.length}`} />
            <p className="border-b border-edge px-4 py-2 text-xs text-ink-3">
              No visit for {lists.window.from} to {lists.window.to} days, not counting time on hold. Same rule as the retention radar.
            </p>
            {lists.absent.length ? (
              <ul className="divide-y divide-edge">
                {lists.absent.map((r) => (
                  <ReachOutItem key={r.athleteId} r={r} reason="absent" />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-3">Nobody is in the window.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
