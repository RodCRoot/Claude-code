import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { canOnAthlete, type Viewer } from "@/lib/authz/policy";
import { challengeViews, syncChallengeCompletions } from "@/lib/community/challenges";
import { communityOrg } from "@/lib/community/settings";
import { shoutoutsForAthlete } from "@/lib/community/shoutouts";
import { fmt } from "@/lib/time";
import { ChallengeProgress } from "./cards";

/**
 * Athlete Home (family view of /today): the athlete's coach shoutouts and current team
 * challenges. Renders nothing when community features are off, when the viewer has no profile
 * access to this athlete, or when there is nothing to show.
 */
export async function CommunityHomeCards({ v, athleteId, firstName, tz }: { v: Viewer; athleteId: string; firstName: string; tz?: string }) {
  const org = await communityOrg(db, v.orgId);
  if (!org.settings.enabled || !(await canOnAthlete(db, v, athleteId, "profile.read"))) return null;
  const isAthlete = v.role === "athlete";
  const shoutouts = await shoutoutsForAthlete(db, v, athleteId, { limit: 3 });
  // The athlete's own counts are training data: only with training access.
  const seeCounts = await canOnAthlete(db, v, athleteId, "training.read");
  const challenges = await db.transaction(async (tx) => {
    await syncChallengeCompletions(tx, v.orgId);
    return challengeViews(tx, v.orgId, { ownIds: seeCounts ? new Set([athleteId]) : new Set() });
  });
  // Only challenges this athlete is part of (their group, or gym-wide).
  const mine = seeCounts ? challenges.filter((c) => c.you.length) : challenges.filter((c) => !c.groupName);
  if (!shoutouts.length && !mine.length) return null;
  return (
    <>
      {shoutouts.length ? (
        <Card id="community-shoutouts">
          <CardHeader title="Shoutouts" kicker="From your coaches" />
          <CardBody>
            <ul className="space-y-3">
              {shoutouts.map((s) => (
                <li key={s.id} className="text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge variant="yellow">{s.headline}</Badge>
                    <span className="text-xs text-ink-3">{fmt(s.createdAt, "MMM d", tz)}</span>
                  </p>
                  {s.note ? <p className="mt-1 font-medium text-ink">&ldquo;{s.note}&rdquo;</p> : null}
                  <p className="mt-0.5 text-xs text-ink-3">{s.coach}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">{isAthlete ? "Only you, your family and the coaching staff see these here." : `Only ${firstName}, your family and the coaching staff see these here.`}</p>
          </CardBody>
        </Card>
      ) : null}
      {mine.length ? (
        <Card id="community-challenges">
          <CardHeader title="Team challenge" kicker={mine.length > 1 ? `${mine.length} running` : "Running now"} action={<Link href="/leaderboards" className="text-sm font-semibold text-brand underline">Leaderboards</Link>} />
          <CardBody className="space-y-4 divide-y divide-edge *:pt-4 *:first:pt-0">
            {mine.slice(0, 2).map((c) => (
              <ChallengeProgress key={c.id} c={c} isAthlete={isAthlete} compact />
            ))}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
