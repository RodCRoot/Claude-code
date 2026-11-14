import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { EVENT_KIND_LABEL } from "@/lib/events/events";
import { listStaffEvents } from "@/lib/events/queries";
import { releaseExpiredHolds } from "@/lib/events/registration";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Camps & clinics" };

export default async function EventsPage() {
  const v = await requireCap("schedule.manage");
  await db.transaction((tx) => releaseExpiredHolds(tx, v.orgId));
  const { rows } = await listStaffEvents(db, v);
  const money = can(v, "billing.view_all");
  const upcoming = rows.filter((r) => r.upcoming);
  const sum = (f: (r: (typeof rows)[number]) => number) => upcoming.reduce((a, r) => a + f(r), 0);
  return (
    <>
      <PageHeader
        kicker="Front desk"
        title="Camps & clinics"
        description="Events families register and pay for as a whole. A registration holds a spot; it is confirmed when its invoice is paid."
        actions={<ButtonLink href="/events/new">New event</ButtonLink>}
      />
      {rows.length === 0 ? (
        <EmptyState title="No events yet" action={<ButtonLink href="/events/new">Create the first one</ButtonLink>}>
          Set up a camp or clinic with its dates, capacity and price. Families can register online once you publish it.
        </EmptyState>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Upcoming events" value={upcoming.length} />
            <Stat label="Confirmed (paid)" value={sum((r) => r.counts.confirmed)} hint="Upcoming events" tone="ok" />
            <Stat label="Holding a spot, unpaid" value={sum((r) => r.counts.held)} hint={money ? `${formatMoney(sum((r) => r.counts.heldMinor))} awaiting payment` : undefined} tone={sum((r) => r.counts.held) ? "warn" : undefined} />
            {money ? <Stat label="Revenue, upcoming events" value={formatMoney(sum((r) => r.netRevenueMinor))} hint="Paid registrations less refunds" /> : null}
          </div>
          <Card>
            <Table caption="Events">
              <thead>
                <tr>
                  <Th>Event</Th>
                  <Th>Dates</Th>
                  <Th>Status</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right">Unpaid</Th>
                  <Th align="right">Spots left</Th>
                  {money ? <Th align="right">Revenue</Th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.event.id}>
                    <Td>
                      <Link href={`/events/${r.event.id}`} className="font-semibold text-brand underline">
                        {r.event.name}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        {EVENT_KIND_LABEL[r.event.kind]}
                        {r.event.isDemo ? <Badge variant="yellow">Sample</Badge> : null}
                      </div>
                    </Td>
                    <Td>{r.dates}</Td>
                    <Td>
                      <StatusBadge status={r.event.status} />
                    </Td>
                    <Td align="right">{r.counts.confirmed}</Td>
                    <Td align="right">{r.counts.held}</Td>
                    <Td align="right">
                      {r.spotsLeft} of {r.event.capacity}
                    </Td>
                    {money ? (
                      <Td align="right">
                        {formatMoney(r.netRevenueMinor, r.event.currency)}
                        {r.refundedMinor ? <div className="text-xs text-ink-3">{formatMoney(r.refundedMinor, r.event.currency)} refunded</div> : null}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
