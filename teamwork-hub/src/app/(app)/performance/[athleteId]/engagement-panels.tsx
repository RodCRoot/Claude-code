import { db } from "@/db";
import { GoalForm, GoalList } from "@/components/engagement/goals";
import { EngagementStripCard } from "@/components/engagement/strip";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getOrg } from "@/lib/auth/viewer";
import type { Viewer } from "@/lib/authz/policy";
import { engagementAccess } from "@/lib/engagement/access";
import { goalLinkOptions, listGoals } from "@/lib/engagement/goals";
import { engagementStrip } from "@/lib/engagement/home";

/**
 * Engagement strip + Goals panel on the athlete performance page. The page has already required
 * training.read; each piece still checks its own access (goals need profile.read, edits need
 * goal-write access) so nothing leaks if this is reused elsewhere.
 */
export async function EngagementPanels({ v, athleteId }: { v: Viewer; athleteId: string }) {
  const access = await engagementAccess(db, v, athleteId);
  if (!access.canSeeTraining && !access.canSeeGoals) return null;
  const tz = (await getOrg(v.orgId))?.timezone;
  const strip = access.canSeeTraining ? await db.transaction((tx) => engagementStrip(tx, v, athleteId)) : null;
  const goals = access.canSeeGoals ? (await listGoals(db, v, athleteId)).filter((g) => g.status !== "archived") : null;
  const options = access.canWriteGoals ? await goalLinkOptions(db, v, athleteId) : null;
  const active = goals?.filter((g) => g.status === "active").length ?? 0;
  return (
    <div className="mb-6 grid gap-6 lg:grid-cols-2">
      {strip ? <EngagementStripCard strip={strip} tz={tz} className="lg:col-span-2" /> : null}
      {goals ? (
        <Card className="lg:col-span-2">
          <CardHeader title="Goals" kicker={`${active} active`} />
          <CardBody className="grid gap-6 lg:grid-cols-[1fr_22rem]">
            <GoalList goals={goals} canWrite={access.canWriteGoals} empty="No goals yet." />
            {options ? (
              <details className="self-start rounded-lg border border-edge p-3">
                <summary className="cursor-pointer text-sm font-semibold">Add a goal</summary>
                <div className="mt-3">
                  <GoalForm athleteId={athleteId} options={options} idPrefix="perf-goal" />
                </div>
              </details>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
