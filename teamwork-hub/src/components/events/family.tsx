import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Card, CardBody, CardHeader } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { EVENT_KIND_LABEL } from "@/lib/events/events";
import { listFamilyEvents, type FamilyEvent } from "@/lib/events/queries";
import { formatMoney } from "@/lib/money";
import { fmtDate, fmtTime } from "@/lib/time";

export const priceLabel = (e: Pick<FamilyEvent, "priceMinor" | "currency">) => (e.priceMinor === 0 ? "Free" : formatMoney(e.priceMinor, e.currency));

export function SpotsBadge({ e }: { e: Pick<FamilyEvent, "spotsLeft" | "closedReason"> }) {
  if (e.spotsLeft === 0) return <Badge variant="red">Full</Badge>;
  return <Badge variant={e.spotsLeft <= 5 ? "yellow" : "green"}>{e.spotsLeft === 1 ? "1 spot left" : `${e.spotsLeft} spots left`}</Badge>;
}

export function MineBadges({ e }: { e: Pick<FamilyEvent, "mine"> }) {
  return (
    <>
      {e.mine.map((m) => (
        <Badge key={m.athleteId} variant={m.status === "confirmed" ? "green" : "yellow"}>
          {m.first}: {m.status === "confirmed" ? "registered" : "awaiting payment"}
        </Badge>
      ))}
    </>
  );
}

/** One event in the family list. The whole card is a link target with a clear button. */
export function EventCard({ e }: { e: FamilyEvent }) {
  const first = e.sessions[0];
  return (
    <li className="flex min-w-0 flex-col rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="flex-1 space-y-2 px-4 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="brand">{EVENT_KIND_LABEL[e.kind]}</Badge>
          <SpotsBadge e={e} />
          <MineBadges e={e} />
        </div>
        <h2 className="text-base leading-snug font-semibold">
          <Link href={`/shop/camps/${e.id}`} className="hover:underline">
            {e.name}
          </Link>
        </h2>
        <p className="text-sm font-medium text-ink-2">
          {e.dates}
          {first ? `, ${fmtTime(first.startsAt, e.tz)} to ${fmtTime(first.endsAt, e.tz)}` : ""}
        </p>
        {e.ages ? <p className="text-sm text-ink-2">{e.ages}</p> : null}
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[26px] leading-none font-bold tabular">{priceLabel(e)}</span>
          {e.earlyBird ? (
            <span className="text-xs text-ink-2">
              early bird through {fmtDate(e.earlyBirdUntil)}, then {formatMoney(e.regularPriceMinor, e.currency)}
            </span>
          ) : (
            <span className="text-xs text-ink-3">per athlete</span>
          )}
        </p>
      </div>
      <div className="mt-4 border-t border-edge bg-th px-4 py-3">
        <ButtonLink href={`/shop/camps/${e.id}`} className="w-full" variant={e.closedReason || e.spotsLeft === 0 ? "secondary" : "primary"}>
          {e.mine.length ? "View registration" : e.closedReason || e.spotsLeft === 0 ? "View details" : "Details and registration"}
        </ButtonLink>
      </div>
    </li>
  );
}

/** Athlete Home and Shop: the next few camps and clinics. Renders nothing when there are none. */
export async function UpcomingEventsCard({ v, className }: { v: Viewer; className?: string }) {
  const list = (await listFamilyEvents(db, v)).slice(0, 3);
  if (!list.length) return null;
  return (
    <Card className={className}>
      <CardHeader
        title="Camps and clinics"
        kicker="Coming up"
        action={
          <Link href="/shop/camps" className="text-sm font-semibold text-brand underline">
            See all
          </Link>
        }
      />
      <CardBody>
        <ul className="divide-y divide-edge">
          {list.map((e) => (
            <li key={e.id} className="py-2.5 first:pt-0 last:pb-0">
              <Link href={`/shop/camps/${e.id}`} className="flex min-h-11 items-center justify-between gap-3 hover:underline">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{e.name}</span>
                  <span className="block text-xs text-ink-2">
                    {e.dates}
                    {e.ages ? `, ${e.ages.toLowerCase()}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular">{priceLabel(e)}</span>
                  <span className="block text-[11px] text-ink-2">{e.mine.length ? "You are signed up" : e.spotsLeft === 0 ? "Full" : e.spotsLeft === 1 ? "1 spot left" : `${e.spotsLeft} spots left`}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
