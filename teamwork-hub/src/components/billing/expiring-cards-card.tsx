import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, CardBody, CardHeader, buttonClass } from "@/components/ui";
import { can, type Viewer } from "@/lib/authz/policy";
import { expiringCards } from "@/lib/billing/payment-methods";
import { CARDS_EXPIRING_DAYS } from "@/lib/scoreboard/daily";
import { daysBetween, fmtDate, todayLocal } from "@/lib/time";

/** Same window as the scoreboard tile "Saved cards expiring within 60 days". */
const EXPIRING_CARDS_DAYS = CARDS_EXPIRING_DAYS;

/**
 * Saved cards about to expire, for the front desk's follow-ups queue. Not a journey step: it is a
 * read of `expiringCards()` (the same list as the scoreboard tile), shown only to staff who may see
 * billing (owner, admin, operations), never to coaches. Renders nothing when there are none.
 */
export async function ExpiringCardsCard({ viewer, className }: { viewer: Viewer; className?: string }) {
  if (!can(viewer, "billing.view_all")) return null;
  const today = todayLocal();
  const cards = await expiringCards(db, viewer.orgId, { today, withinDays: EXPIRING_CARDS_DAYS });
  if (!cards.length) return null;
  return (
    <Card className={className} id="expiring-cards">
      <CardHeader title="Saved cards about to expire" kicker={`${cards.length} within ${EXPIRING_CARDS_DAYS} days`} />
      <CardBody>
        <ul className="divide-y divide-edge">
          {cards.map((c) => {
            const days = daysBetween(today, c.expiresOn);
            return (
              <li key={c.methodId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{c.payerName}</div>
                  <div className="text-xs text-ink-3">
                    {c.label} · good through {fmtDate(c.expiresOn)} ({days < 0 ? "expired" : days === 0 ? "last day today" : `${days} day${days === 1 ? "" : "s"} left`})
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.autopayMemberships ? <Badge variant="yellow">Autopay for {c.autopayMemberships} membership{c.autopayMemberships === 1 ? "" : "s"}</Badge> : <Badge>Not used for autopay</Badge>}
                    {c.isDefault ? <Badge>Default method</Badge> : null}
                  </div>
                </div>
                <Link href={`/billing/payment-methods?payer=${c.payerAccountId}`} className={buttonClass("secondary", "md", "min-h-11")}>
                  Open<span className="sr-only">: payment methods for {c.payerName}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-ink-3">A card works through the last day of its expiry month. The family adds the new card themselves; staff never enter it. Nothing is sent to the family from here.</p>
      </CardBody>
    </Card>
  );
}
