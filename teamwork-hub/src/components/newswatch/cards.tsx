import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { can, type Viewer } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { alumniNewsFeed, pendingClipCount } from "@/lib/newswatch/clips";
import { NEWS_WATCH_POLICY_TEXT } from "@/lib/newswatch/shared";
import { alumnusForAthlete, newsWatchAccess } from "@/lib/newswatch/watch";
import { markAsAlumniAction, setNewsOptInAction } from "@/app/(app)/wins/news-actions";

/** Family: the news watch switch for one athlete, with the exact wording that is recorded. */
export async function NewsWatchFamilyCard({ v, athleteId, tz }: { v: Viewer; athleteId: string; tz?: string }) {
  const a = await newsWatchAccess(db, v, athleteId);
  if (!a || (a.relationship !== "guardian" && a.relationship !== "self")) return null;
  const whose = a.relationship === "self" ? "you" : a.firstName;
  return (
    <Card id={`news-watch-${athleteId}`}>
      <CardHeader title={a.relationship === "self" ? "News watch" : `News watch for ${a.firstName}`} kicker={a.optedIn ? "On" : a.requested ? "The gym asked: your choice" : "Off"} />
      <CardBody className="space-y-3 text-sm text-ink-2">
        <p>
          When this is on, the gym looks for {whose === "you" ? "your" : `${a.firstName}'s`} name in local news headlines. A person at the gym checks and approves every clip before anyone else sees it. It is off unless you switch it on.
        </p>
        {a.optedIn ? (
          <p className="text-xs text-ink-3">
            Switched on{a.decidedByName ? ` by ${a.decidedByName}` : ""}
            {a.decidedAt ? ` on ${fmt(a.decidedAt, "MMM d, yyyy", tz)}` : ""}.
          </p>
        ) : null}
        <details>
          <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand underline">Read exactly what you agree to</summary>
          <p className="rounded-md border border-edge bg-surface-2 px-3 py-2">{NEWS_WATCH_POLICY_TEXT}</p>
        </details>
        {a.optedIn ? (
          a.canOptOut ? (
            <ActionForm action={setNewsOptInAction}>
              <input type="hidden" name="athleteId" value={athleteId} />
              <input type="hidden" name="optIn" value="off" />
              <SubmitButton variant="secondary" size="sm">
                Switch news watch off<span className="sr-only"> for {a.firstName}</span>
              </SubmitButton>
            </ActionForm>
          ) : null
        ) : a.canOptIn ? (
          <div className="flex flex-wrap gap-2">
            <ActionForm action={setNewsOptInAction}>
              <input type="hidden" name="athleteId" value={athleteId} />
              <input type="hidden" name="optIn" value="on" />
              <SubmitButton size="sm">
                I agree, switch news watch on<span className="sr-only"> for {a.firstName}</span>
              </SubmitButton>
            </ActionForm>
            {a.requested ? (
              <ActionForm action={setNewsOptInAction}>
                <input type="hidden" name="athleteId" value={athleteId} />
                <input type="hidden" name="optIn" value="off" />
                <SubmitButton variant="ghost" size="sm">
                  No thanks<span className="sr-only">, no news watch for {a.firstName}</span>
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        ) : (
          <p className="text-ink-3">{a.blockedReason}</p>
        )}
      </CardBody>
    </Card>
  );
}

/** "Teamwork alumni in college": approved alumni clips. Headline, publication, date and a link out. */
export async function AlumniNewsCard({ v, orgName }: { v: Viewer; orgName: string }) {
  const items = await alumniNewsFeed(db, v, { limit: 8 });
  if (!items.length) return null;
  return (
    <Card id="alumni-news">
      <CardHeader title={`${orgName} alumni in college`} kicker="In the news" />
      <CardBody>
        <ul className="divide-y divide-edge">
          {items.map((i) => (
            <li key={i.id} className="py-3 first:pt-0 last:pb-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-bold">{i.name}</span>
                {i.detail ? <span className="text-xs text-ink-3">{i.detail}</span> : null}
              </p>
              <p className="mt-0.5 font-medium text-ink">{i.headline}</p>
              <p className="mt-0.5 text-xs text-ink-3">
                {i.source} · {i.when} ·{" "}
                <a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
                  Read it at {i.source}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/** Staff Today: how many news clips wait for this person's approval. Shown only to people who can approve. */
export async function NewsClipsTodayCard({ v, className }: { v: Viewer; className?: string }) {
  const { canApprove, pending } = await pendingClipCount(db, v);
  if (!canApprove || pending === 0) return null;
  return (
    <Card id="news-clips-pending" className={className}>
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          <Badge variant="blue">{pending}</Badge>{" "}
          <span className="font-semibold">
            news clip{pending === 1 ? "" : "s"} waiting for your approval
          </span>
          <span className="block text-ink-3">Nothing is shown to families or on the gym TV until you approve it.</span>
        </p>
        <ButtonLink href="/wins/news" variant="secondary" size="sm">
          Review news clips
        </ButtonLink>
      </CardBody>
    </Card>
  );
}

/** Staff profile: start an alumni record for a departing athlete, or show the one that exists. */
export async function AlumniProfileCard({ v, athleteId, firstName }: { v: Viewer; athleteId: string; firstName: string }) {
  if (!can(v, "wins.review")) return null;
  const existing = await alumnusForAthlete(db, v, athleteId);
  if (!existing && !can(v, "people.manage")) return null;
  return (
    <Card id="alumni-card">
      <CardHeader title="Alumni" kicker={existing ? "Alumni record on file" : "When they move on"} />
      <CardBody className="space-y-2 text-sm text-ink-2">
        {existing ? (
          <p>
            {[existing.sport, existing.college].filter(Boolean).join(" · ") || "No college recorded yet"}. {existing.watch ? "On the news watch list." : "Not on the news watch list."}{" "}
            <Link href="/wins/watch#watch-alumni" className="font-semibold text-brand underline">
              Open the alumni list
            </Link>
          </p>
        ) : (
          <>
            <p>Heading to college? Start an alumni record for {firstName}. It copies the name, sport and graduation year. It does not change this profile and does not start any news watch.</p>
            <ActionForm action={markAsAlumniAction} className="space-y-2">
              <input type="hidden" name="athleteId" value={athleteId} />
              <Field label="College or team (optional)" htmlFor="alumni-college">
                <Input id="alumni-college" name="college" maxLength={100} autoComplete="off" />
              </Field>
              <SubmitButton size="sm" variant="secondary">
                Mark as alumni
              </SubmitButton>
            </ActionForm>
          </>
        )}
      </CardBody>
    </Card>
  );
}
