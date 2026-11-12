import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { CompetingFamilyCard, FamilyWinItem, WinSubmitForm, WinsFeedList } from "@/components/wins/family";
import { WinsStaffTabs } from "@/components/wins/staff";
import { Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { athletes, people } from "@/db/schema";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter, can, isStaff } from "@/lib/authz/policy";
import { communityOrg } from "@/lib/community/settings";
import { winsAccess } from "@/lib/wins/access";
import { winsFeed, winsForAthlete } from "@/lib/wins/wins";
import { ModuleHero } from "../training/_components/tb";

export const metadata = { title: "Wins" };

export default async function WinsPage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  if (!isStaff(v) && v.role !== "guardian" && v.role !== "athlete") redirect("/denied");
  const sp = await searchParams;
  const staff = isStaff(v);
  const org = await getOrg(v.orgId);
  const tz = org?.timezone;
  const community = await communityOrg(db, v.orgId);
  const feed = await winsFeed(db, v, { limit: 30 });

  // Athletes the viewer may add a win for.
  const scope = await accessibleAthleteIds(db, v, "profile.read");
  const roster = await db
    .select({ id: athletes.id, first: people.firstName, preferred: people.preferredName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)))
    .orderBy(asc(people.firstName), asc(people.lastName));

  // Families: each linked athlete's own wins with the choices this viewer may make.
  const mine = [];
  if (!staff) for (const a of roster) mine.push(await winsForAthlete(db, v, a.id));
  const submitFor: { id: string; label: string; displayName: string | null }[] = [];
  if (staff) {
    if (can(v, "wins.review")) for (const a of roster) submitFor.push({ id: a.id, label: `${a.preferred ?? a.first} ${a.last}`, displayName: null });
  } else {
    for (const m of mine) if (m.access.canSubmit) submitFor.push({ id: m.access.athleteId, label: m.access.firstName, displayName: m.access.displayName });
  }
  // A staff link from a profile ("Add a win") preselects nothing: the id is only used to order the list.
  const preferred = sp.athlete && submitFor.some((a) => a.id === sp.athlete) ? sp.athlete : null;
  if (preferred) submitFor.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const blocked = !staff && mine.length > 0 && submitFor.length === 0 ? await winsAccess(db, v, mine[0].access.athleteId) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <ModuleHero
        kicker="Community"
        title="Wins"
        description={
          staff
            ? "What our athletes achieve outside the gym. The feed below is exactly what families see: display names only, approved wins only, hidden athletes never."
            : "Made a team, set a personal best, won a game? Tell us. Staff review every win, and you choose where it is shown."
        }
      />
      <WinsStaffTabs v={v} current="feed" />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {!staff
            ? mine.map(({ access, wins }) => (
                <Card key={access.athleteId} id={`wins-${access.athleteId}`}>
                  <CardHeader title={v.role === "athlete" ? "Your wins" : `${access.firstName}'s wins`} kicker={access.displayName ? `Shown to other families as ${access.displayName}` : "Name hidden from other families"} />
                  <CardBody>
                    {wins.length === 0 ? (
                      <p className="text-sm text-ink-3">Nothing here yet. Add the first one with the form on this page.</p>
                    ) : (
                      <ul className="divide-y divide-edge">
                        {wins.map((w) => (
                          <FamilyWinItem key={w.id} w={w} access={access} tz={tz} />
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              ))
            : null}
          {!staff && mine.length === 0 ? <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState> : null}

          <Card id="wins-feed">
            <CardHeader title="Gym wins" kicker={staff ? "What families see" : "From athletes across the gym"} />
            <CardBody>
              {community.settings.enabled ? (
                <WinsFeedList items={feed} empty="No wins to show yet. The first approved one will appear here." />
              ) : (
                <p className="text-sm text-ink-3">Community features are turned off at this gym right now, so wins are not shown to other families.</p>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {submitFor.length ? (
            <Card id="add-win">
              <CardHeader title="Add a win" kicker={staff ? "Staff entry, reviewed before display" : "Tell us about it"} />
              <CardBody>
                <WinSubmitForm athletes={submitFor} staff={staff} tz={tz} />
              </CardBody>
            </Card>
          ) : blocked ? (
            <Callout tone="info" title="Adding wins">
              Your account can see these wins but is not set up to add them. A parent or guardian who manages bookings for this athlete can, or ask the front desk.
            </Callout>
          ) : null}
          <CompetingFamilyCard v={v} orgName={community.name} />
          {!staff ? (
            <Card>
              <CardBody className="space-y-2 text-sm text-ink-2">
                <h2 className="text-[15px] font-semibold text-ink">How sharing works</h2>
                <p>
                  <strong>1. In the app.</strong> Other gym families see approved wins under a display name. <Link href="/leaderboards#display-names" className="font-semibold text-brand underline">Choose how names appear</Link>, or hide the name completely.
                </p>
                <p>
                  <strong>2. Gym TV.</strong> The same display name on the screen in the gym. You can switch it off for any win.
                </p>
                <p>
                  <strong>3. Public marketing.</strong> Off unless a parent or guardian (or an adult athlete) says yes for that win. It can be withdrawn at any time.
                </p>
                <p className="text-xs text-ink-3">Wins never include last names, ages, health, injuries, body weight or school grades.</p>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
