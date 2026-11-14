import { redirect } from "next/navigation";
import { db } from "@/db";
import { EventCard } from "@/components/events/family";
import { ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { listFamilyEvents } from "@/lib/events/queries";
import { releaseExpiredHolds } from "@/lib/events/registration";

export const metadata = { title: "Camps and clinics" };

export default async function CampsPage() {
  const v = await requireViewer();
  if (v.role !== "guardian" && v.role !== "athlete") redirect("/events");
  // Spots whose unpaid hold ran out are released before the list is shown.
  await db.transaction((tx) => releaseExpiredHolds(tx, v.orgId));
  const list = await listFamilyEvents(db, v);
  return (
    <>
      <PageHeader
        kicker="Shop"
        title="Camps and clinics"
        description="Upcoming camps, clinics and events. Pick one to see the dates and register your athletes."
        actions={
          <ButtonLink href="/shop" variant="secondary">
            Back to the shop
          </ButtonLink>
        }
      />
      {list.length === 0 ? (
        <EmptyState title="No camps or clinics are open right now">New dates are posted here as soon as they are announced. The front desk can tell you what is planned.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((e) => (
            <EventCard key={e.id} e={e} />
          ))}
        </ul>
      )}
      <p className="mt-5 max-w-3xl text-xs text-ink-3">Registering holds a spot and creates a bill on your billing account. Nothing is charged on this page. A spot is confirmed once the bill is paid.</p>
    </>
  );
}
