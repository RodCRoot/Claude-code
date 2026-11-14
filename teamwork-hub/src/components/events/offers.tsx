import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/db";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { familyLiveOffers, staffLiveOffers } from "@/lib/events/offers";
import { onlinePaymentAvailable } from "@/lib/growth/shop";
import { fmt } from "@/lib/time";
import { AcceptOfferForm, LeaveWaitlistForm } from "./waitlist-family";

const UNTIL = "EEE, MMM d 'at' h:mm a";

/**
 * Family Home (guardian and athlete logins): one callout per live waitlist offer on the viewer's own
 * athletes. Accept and decline go through the same server actions as the camp page. Renders nothing
 * when there is no live offer; an offer whose time has run out is never listed.
 */
export async function WaitlistOffersHomeCard({ v, className }: { v: Viewer; className?: string }) {
  const { offers, tz } = await familyLiveOffers(db, v);
  if (!offers.length) return null;
  const online = onlinePaymentAvailable();
  return (
    <section aria-label="Spots offered from a waitlist" className={`space-y-3 ${className ?? ""}`} data-testid="home-waitlist-offers">
      {offers.map((o) => (
        <Callout key={o.entryId} tone="ok" title={`A spot has opened for ${o.first}`}>
          <p data-testid="home-waitlist-offer">
            <Link href={`/shop/camps/${o.eventId}`} className="font-semibold underline">
              {o.eventName}
            </Link>
            . The spot is held for {o.first} until {fmt(o.offerExpiresAt, UNTIL, tz)}. Nothing has been charged. Taking the spot creates a bill, and the spot is confirmed once the bill is paid.
          </p>
          {o.canAct ? (
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <AcceptOfferForm entryId={o.entryId} formKey={randomUUID()} first={o.first} online={online} />
              <LeaveWaitlistForm entryId={o.entryId} label="No thanks" confirm={`Pass on this spot for ${o.first}? It will be offered to the next family in line.`} />
            </div>
          ) : (
            <p className="mt-1">The adult who pays on the billing account can take the spot, or the front desk can help.</p>
          )}
        </Callout>
      ))}
    </section>
  );
}

/**
 * Staff Today (owner, admin, operations): who holds a waitlist offer and until when, so the front
 * desk can call the family. No message is sent by the app. Renders nothing when there are none.
 */
export async function WaitlistOffersTodayCard({ v, className }: { v: Viewer; className?: string }) {
  const { offers, tz } = await staffLiveOffers(db, v);
  if (!offers.length) return null;
  return (
    <Card className={className} id="today-waitlist-offers">
      <CardHeader title="Waitlist offers waiting on a family" kicker={`${offers.length} live`} />
      <CardBody>
        <p className="mb-2 text-xs text-ink-2">The app does not message families about an offer yet. Please call them before it runs out.</p>
        <ul className="divide-y divide-edge text-sm">
          {offers.map((o) => (
            <li key={o.entryId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <span className="min-w-0">
                <Link href={`/people/${o.personId}`} className="font-semibold hover:underline">
                  {o.athleteName}
                </Link>{" "}
                <span className="text-ink-2">({o.payerName})</span>
                <span className="block text-xs text-ink-2">
                  <Link href={`/events/${o.eventId}#waitlist`} className="underline">
                    {o.eventName}
                  </Link>
                </span>
              </span>
              <span className="text-xs font-semibold tabular">Offer runs out {fmt(o.offerExpiresAt, UNTIL, tz)}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
