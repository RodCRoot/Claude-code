import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Card, CardBody, CardHeader, Field, Input, Tabs } from "@/components/ui";
import { can, isStaff, type Viewer } from "@/lib/authz/policy";
import { pendingClipCount } from "@/lib/newswatch/clips";
import { fmt, fmtDate, fmtTime } from "@/lib/time";
import { competingThisWeekStaff, type StaffEntry } from "@/lib/wins/calendar";
import { CONSENT_LABEL, WIN_STATUS_LABEL } from "@/lib/wins/shared";
import { recentWinsForOutreach, winCounts, winsForAthlete } from "@/lib/wins/wins";
import { withdrawWinAction } from "@/app/(app)/wins/actions";
import { STATUS_VARIANT } from "./family";

/** Section tabs for the staff side of Wins. Marketing only for roles that may open it. */
export async function WinsStaffTabs({ v, current }: { v: Viewer; current: string }) {
  if (!isStaff(v)) return null;
  const counts = await winCounts(db, v);
  const news = await pendingClipCount(db, v);
  const tabs = [
    { key: "feed", href: "/wins", label: "Wins" },
    { key: "review", href: "/wins/review", label: `Review${counts.pending ? ` (${counts.pending})` : ""}` },
    { key: "calendar", href: "/wins/calendar", label: "Competition calendar" },
    { key: "teams", href: "/wins/teams", label: "Team schedules" },
    { key: "leads", href: "/wins/leads", label: "Leads to check" },
    { key: "news", href: "/wins/news", label: `News clips${news.canApprove && news.pending ? ` (${news.pending})` : ""}` },
    { key: "watch", href: "/wins/watch", label: "News watch list" },
    ...(can(v, "wins.marketing") ? [{ key: "marketing", href: "/wins/marketing", label: "Marketing queue" }] : []),
  ];
  return <Tabs tabs={tabs} current={current} />;
}

/** One competition line for staff: who, what, when, and a link to the existing load view. */
export function CompetitionLine({ e, tz, showDate }: { e: StaffEntry; tz?: string; showDate?: boolean }) {
  return (
    <li className="py-2 text-sm first:pt-0 last:pb-0">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0">
          {e.personId ? (
            <Link href={`/people/${e.personId}`} className="font-semibold hover:underline">
              {e.athleteName}
            </Link>
          ) : (
            <span className="font-semibold">{e.athleteName}</span>
          )}{" "}
          <span className="text-ink-2">
            {e.kindLabel}
            {e.opponent ? ` vs ${e.opponent}` : ""} · {e.teamName}
          </span>
        </span>
        <span className="tabular text-ink-2">
          {showDate ? `${fmt(new Date(`${e.date}T12:00:00Z`), "EEE MMM d", "UTC")}${e.startsAt ? ", " : ""}` : ""}
          {e.startsAt ? fmtTime(e.startsAt, tz) : showDate ? "" : "Time not given"}
        </span>
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
        <span>{e.sport}</span>
        {e.location ? <span>{e.location}</span> : null}
        <span>{e.source === "my_season" ? "From the family's My Season" : "From a team schedule"}</span>
        {e.canSeeLoad ? (
          <Link href={`/science/load?athlete=${e.athleteId}`} className="font-semibold text-brand underline">
            Load<span className="sr-only"> for {e.athleteName}</span>
          </Link>
        ) : null}
      </p>
    </li>
  );
}

/** Staff Today: who competes in the next seven days, with tomorrow called out. */
export async function CompetingThisWeekCard({ v, tz, className }: { v: Viewer; tz?: string; className?: string }) {
  if (!can(v, "wins.review")) return null;
  const week = await competingThisWeekStaff(db, v);
  return (
    <Card id="competing-this-week" className={className}>
      <CardHeader
        title="Competing this week"
        kicker={week.total ? `${week.total} competition day${week.total === 1 ? "" : "s"} in the next 7 days` : "Next 7 days"}
        action={
          <Link href="/wins/calendar" className="text-sm font-semibold text-brand underline">
            Calendar
          </Link>
        }
      />
      <CardBody>
        {week.tomorrow ? (
          <p className="mb-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm font-semibold text-ink">
            {week.tomorrow} athlete{week.tomorrow === 1 ? " competes" : "s compete"} tomorrow. Check their load before today&apos;s session.
          </p>
        ) : null}
        {week.days.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing on any season calendar or team schedule for the next 7 days. Families add games under My Season; staff add team schedules under Wins.</p>
        ) : (
          <div className="space-y-3">
            {week.days.map((d) => (
              <section key={d.date} aria-label={d.label}>
                <h3 className="flex items-center gap-2 text-xs font-bold tracking-wide text-ink-2 uppercase">
                  {d.label}
                  {d.isTomorrow ? <Badge variant="yellow">Game tomorrow</Badge> : d.isToday ? <Badge variant="green">Today</Badge> : null}
                </h3>
                <ul className="mt-1 divide-y divide-edge">
                  {d.entries.map((e) => (
                    <CompetitionLine key={`${e.athleteId}-${e.date}`} e={e} tz={tz} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Staff profile: the athlete's wins with status, sharing and consent at a glance. */
export async function WinsProfileCard({ v, athleteId }: { v: Viewer; athleteId: string }) {
  if (!isStaff(v)) return null;
  let data: Awaited<ReturnType<typeof winsForAthlete>>;
  try {
    data = await winsForAthlete(db, v, athleteId, { limit: 8 });
  } catch {
    return null;
  }
  const { access, wins } = data;
  return (
    <Card id="wins-profile">
      <CardHeader
        title="Wins outside the gym"
        kicker={access.displayName ? `Shown to others as ${access.displayName}` : "Hidden from other families"}
        action={
          access.canReview ? (
            <Link href={`/wins?athlete=${athleteId}#add-win`} className="text-sm font-semibold text-brand underline">
              Add a win
            </Link>
          ) : null
        }
      />
      <CardBody>
        {wins.length === 0 ? <p className="text-sm text-ink-3">No wins recorded yet.</p> : null}
        <ul className="divide-y divide-edge">
          {wins.map((w) => (
            <li key={w.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="yellow">{w.typeLabel}</Badge>
                  <Badge variant={STATUS_VARIANT[w.status]}>{WIN_STATUS_LABEL[w.status]}</Badge>
                  <span className="text-xs text-ink-3">{fmtDate(w.occurredOn)}</span>
                </span>
                <span className="mt-1 block font-medium">{w.headline}</span>
                <span className="block text-xs text-ink-3">
                  App feed {w.showInApp ? "on" : "off"} · TV {w.showOnTv ? "on" : "off"} · Marketing consent: {CONSENT_LABEL[w.marketingConsent].toLowerCase()}
                </span>
              </span>
              {access.canReview ? (
                w.status === "pending" ? (
                  <ButtonLink href="/wins/review" variant="secondary" size="sm">
                    Review<span className="sr-only">: {w.headline}</span>
                  </ButtonLink>
                ) : w.status === "approved" ? (
                  <details className="text-right">
                    <summary className="min-h-9 cursor-pointer py-1 text-xs font-semibold text-ink-2 underline">
                      Remove<span className="sr-only">: {w.headline}</span>
                    </summary>
                    <ActionForm action={withdrawWinAction} className="mt-1 space-y-2 text-left">
                      <input type="hidden" name="winId" value={w.id} />
                      <Field label="Reason (kept in the audit log)" htmlFor={`rm-${w.id}`} required>
                        <Input id={`rm-${w.id}`} name="reason" required maxLength={200} autoComplete="off" />
                      </Field>
                      <SubmitButton variant="secondary" size="sm" pendingText="Removing…">
                        Remove win
                      </SubmitButton>
                    </ActionForm>
                  </details>
                ) : null
              ) : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Retention page: recent approved wins as a reason to reach out with congratulations. This is
 * not a risk signal and does not feed the risk level.
 */
export async function RecentWinsOutreachCard({ v, tz }: { v: Viewer; tz?: string }) {
  if (!can(v, "retention.view")) return null;
  const rows = await recentWinsForOutreach(db, v, { days: 14, limit: 8 });
  if (!rows.length) return null;
  return (
    <Card id="retention-wins" className="mb-5">
      <CardHeader title="Recent wins: a reason to say congratulations" kicker="Last 14 days · not a risk signal" action={<Link href="/wins" className="text-sm font-semibold text-brand underline">All wins</Link>} />
      <CardBody>
        <ul className="divide-y divide-edge">
          {rows.map((r) => (
            <li key={r.winId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
              <span className="min-w-0">
                <Link href={`/people/${r.personId}`} className="font-semibold hover:underline">
                  {r.athleteName}
                </Link>{" "}
                <Badge variant="yellow">{r.typeLabel}</Badge>
                <span className="block text-ink-2">{r.headline}</span>
                <span className="block text-xs text-ink-3">Approved {fmt(r.approvedAt, "MMM d", tz)}</span>
              </span>
              <ButtonLink href={`/messages/new?athlete=${r.athleteId}`} variant="secondary" size="sm">
                Open conversation<span className="sr-only"> about {r.athleteName}</span>
              </ButtonLink>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-3">A quick note after a win is one of the easiest ways to show a family the gym is paying attention. You write and send the message yourself; nothing is sent automatically.</p>
      </CardBody>
    </Card>
  );
}
