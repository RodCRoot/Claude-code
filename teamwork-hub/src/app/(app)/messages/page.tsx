import Link from "next/link";
import { db } from "@/db";
import { Badge, ButtonLink, Callout, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { listThreadsForFamily, listThreadsForStaff, messageableAthletes, type ThreadFilters, type ThreadListRow } from "@/lib/messaging/threads";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/time";
import { ChannelStatus, StaffTabs } from "./_components/shared";

export const metadata = { title: "Messages" };

type SP = Record<string, string | undefined>;

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const v = await requireViewer();
  const sp = await searchParams;
  const staff = can(v, "messages.inbox");

  if (!staff) {
    const [rows, athletes] = await Promise.all([listThreadsForFamily(db, v), messageableAthletes(db, v)]);
    return (
      <>
        <PageHeader
          title="Messages"
          description="Conversations with the Teamwork staff about your athletes."
          actions={
            <>
              <ButtonLink href="/messages/preferences" variant="outline">
                Email &amp; text preferences
              </ButtonLink>
              {athletes.length ? <ButtonLink href="/messages/new">Message the team</ButtonLink> : null}
            </>
          }
        />
        {!athletes.length ? (
          <Callout tone="info" className="mb-4">
            {v.role === "athlete" ? "Messages about minors go through a parent or guardian." : "Your account doesn't currently have messaging permission for any athlete. Contact the front desk if this seems wrong."}
          </Callout>
        ) : null}
        {rows.length ? <ThreadList rows={rows} staff={false} /> : <EmptyState title="No messages yet">When staff message you, or you message them, conversations appear here.</EmptyState>}
      </>
    );
  }

  const filters: ThreadFilters = {
    view: sp.view === "mine" ? "mine" : sp.view === "unassigned" ? "unassigned" : "all",
    status: sp.status === "closed" ? "closed" : sp.status === "all" ? "all" : "open",
    kind: (["family", "athlete", "lead", "staff"].includes(sp.kind ?? "") ? sp.kind : "all") as ThreadFilters["kind"],
    athleteId: sp.athlete || undefined,
    q: sp.q || undefined,
  };
  const rows = await listThreadsForStaff(db, v, filters);
  const athleteOptions = await messageableAthletes(db, v);
  const unread = rows.filter((r) => r.unread > 0).length;
  const viewLink = (view: string) => {
    const p = new URLSearchParams(Object.entries({ ...sp, view }).filter(([, x]) => x) as [string, string][]);
    return `/messages?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Messages"
        description="Shared inbox for family and lead conversations. Internal notes are visible to staff only and never sent."
        actions={<ButtonLink href="/messages/new">New message</ButtonLink>}
      />
      <StaffTabs v={v} current="inbox" />
      <ChannelStatus />
      {sp.started ? (
        <Callout tone="ok" className="mb-4">
          Started {sp.started} separate conversations — one per recipient — so each family member replies privately.
        </Callout>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Assignment">
        {[
          ["all", "All"],
          ["mine", "Assigned to me"],
          ["unassigned", "Unassigned"],
        ].map(([k, label]) => (
          <Link
            key={k}
            href={viewLink(k)}
            aria-current={filters.view === k ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1.5 text-sm", filters.view === k ? "border-brand bg-brand/10 font-medium text-brand" : "border-edge text-ink-2")}
          >
            {label}
          </Link>
        ))}
        <span className="ml-auto self-center text-xs text-ink-3">{unread ? `${unread} with unread messages` : "All caught up"}</span>
      </div>

      <form method="get" className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-edge bg-surface p-4 sm:grid-cols-5" aria-label="Filter conversations">
        <input type="hidden" name="view" value={filters.view} />
        <Field label="Search subject" htmlFor="m-q" className="col-span-2 sm:col-span-1">
          <Input id="m-q" name="q" defaultValue={sp.q} />
        </Field>
        <Field label="Status" htmlFor="m-status">
          <Select id="m-status" name="status" defaultValue={filters.status}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </Select>
        </Field>
        <Field label="Kind" htmlFor="m-kind">
          <Select id="m-kind" name="kind" defaultValue={filters.kind}>
            <option value="all">All</option>
            <option value="family">Family (minor)</option>
            <option value="athlete">Adult athlete</option>
            <option value="lead">Lead</option>
          </Select>
        </Field>
        <Field label="Athlete" htmlFor="m-athlete">
          <Select id="m-athlete" name="athlete" defaultValue={sp.athlete ?? ""}>
            <option value="">Any</option>
            {athleteOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <button type="submit" className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink">
            Apply
          </button>
        </div>
      </form>

      {rows.length ? (
        <ThreadList rows={rows} staff />
      ) : (
        <EmptyState title="No conversations match" action={<ButtonLink href="/messages/new">New message</ButtonLink>}>
          Try another filter{filters.status === "open" ? ", or include closed conversations" : ""}.
        </EmptyState>
      )}
    </>
  );
}

function ThreadList({ rows, staff }: { rows: ThreadListRow[]; staff: boolean }) {
  return (
    <Card>
      <ul className="divide-y divide-edge">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/messages/${r.id}`} className="flex gap-3 px-4 py-3 hover:bg-surface-2 focus-visible:bg-surface-2">
              <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", r.unread ? "bg-brand" : "bg-transparent")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("truncate", r.unread ? "font-semibold" : "font-medium")}>{r.subject}</span>
                  {r.unread ? <Badge variant="brand">{r.unread} new</Badge> : null}
                  {r.status === "closed" ? <Badge>closed</Badge> : null}
                  {staff ? <Badge variant="neutral">{r.kind === "family" ? "family" : r.kind === "athlete" ? "adult athlete" : r.kind}</Badge> : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-3">
                  {[r.athleteName ? `About ${r.athleteName}` : null, staff ? r.participantNames : null, staff ? (r.assignedName ? `→ ${r.assignedName}` : "Unassigned") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {r.lastBody ? (
                  <p className="mt-0.5 truncate text-sm text-ink-2">
                    {r.lastIsInternal ? <span className="font-medium text-warn">Internal note: </span> : null}
                    {r.lastBody}
                  </p>
                ) : null}
              </div>
              <time className="shrink-0 text-xs text-ink-3" dateTime={(r.lastMessageAt ?? r.createdAt).toISOString()}>
                {fmt(r.lastMessageAt ?? r.createdAt, "MMM d, h:mm a")}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
