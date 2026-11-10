import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { GoalForm, GoalList } from "@/components/engagement/goals";
import { BadgeMedallion } from "@/components/engagement/medallion";
import { Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { familyAthletes } from "@/lib/dashboards";
import { engagementAccess } from "@/lib/engagement/access";
import { BADGES } from "@/lib/engagement/badges";
import { goalLinkOptions, listGoals } from "@/lib/engagement/goals";
import { engagementStrip } from "@/lib/engagement/home";
import { fmt } from "@/lib/time";
import { ModuleHero } from "../training/_components/tb";

export const metadata = { title: "Goals" };

export default async function GoalsPage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  // Staff manage goals from the athlete's performance page.
  if (isStaff(v)) redirect("/performance");
  const sp = await searchParams;
  const tz = (await getOrg(v.orgId))?.timezone;
  const children = await familyAthletes(db, v);
  // Only athletes this viewer is linked to are ever selectable; an unknown id falls back to the first.
  const child = children.find((c) => c.athleteId === sp.athlete) ?? children[0];
  const isAthlete = v.role === "athlete";

  if (!child) {
    return (
      <>
        <ModuleHero kicker="Goals" title="Goals" />
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
      </>
    );
  }

  const access = await engagementAccess(db, v, child.athleteId);
  const first = child.name.split(" ")[0];
  // The strip refresh runs first: it checks off linked goals that new results have reached.
  const strip = access.canSeeTraining ? await db.transaction((tx) => engagementStrip(tx, v, child.athleteId)) : null;
  const [goals, options] = await Promise.all([listGoals(db, v, child.athleteId), goalLinkOptions(db, v, child.athleteId)]);
  const active = goals.filter((g) => g.status === "active");
  const achieved = goals.filter((g) => g.status === "achieved");
  const archived = goals.filter((g) => g.status === "archived");
  const earned = new Map((strip?.badges ?? []).map((b) => [b.def.key, b.earnedAt]));

  return (
    <div className="mx-auto max-w-5xl">
      <ModuleHero kicker="Goals" title={isAthlete ? "Your goals" : `${first}'s goals`} description={isAthlete ? "Pick something to work toward. Linked goals fill in from your results." : "Goals set with the coaching staff. Linked goals fill in from new results."}>
        {children.length > 1 ? (
          <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
            {children.map((c) => {
              const current = c.athleteId === child.athleteId;
              return (
                <Link
                  key={c.athleteId}
                  href={`/goals?athlete=${c.athleteId}`}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${current ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`}
                >
                  {c.name.split(" ")[0]}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </ModuleHero>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Active goals" kicker={`${active.length} in progress`} />
            <CardBody>
              <GoalList goals={active} canWrite={access.canWriteGoals} empty={isAthlete ? "No active goals yet. Add your first one." : `No active goals yet for ${first}.`} />
            </CardBody>
          </Card>
          {achieved.length ? (
            <Card>
              <CardHeader title="Reached" kicker={`${achieved.length} goal${achieved.length === 1 ? "" : "s"}`} />
              <CardBody>
                <GoalList goals={achieved} canWrite={false} empty="" />
              </CardBody>
            </Card>
          ) : null}
          {archived.length ? (
            <Card>
              <CardBody>
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">Archived goals ({archived.length})</summary>
                  <div className="mt-3">
                    <GoalList goals={archived} canWrite={access.canWriteGoals} empty="" />
                  </div>
                </details>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Add a goal" />
            <CardBody>
              {access.canWriteGoals ? (
                <GoalForm athleteId={child.athleteId} options={options} />
              ) : (
                <p className="text-sm text-ink-2">{access.writeBlockedReason ?? "Your account can view these goals. A coach can add or change them."}</p>
              )}
            </CardBody>
          </Card>
          {!access.canSeeTraining ? <Callout>Test results and progress numbers are not shown because your account does not have training access for {first}.</Callout> : null}
        </div>
      </div>

      {strip?.badges ? (
        <Card className="mt-4" id="badges">
          <CardHeader title="Badges" kicker={`${earned.size} of ${BADGES.length} earned`} />
          <CardBody>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              {BADGES.map((b) => {
                const at = earned.get(b.key);
                return (
                  <li key={b.key} className="flex min-w-0 flex-col items-center gap-1 text-center">
                    <BadgeMedallion def={b} locked={!at} size={72} />
                    <span className="text-sm leading-tight font-semibold">{b.name}</span>
                    <span className="text-xs leading-snug text-ink-3">{at ? `Earned ${fmt(at, "MMM d, yyyy", tz)}` : b.description}</span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
