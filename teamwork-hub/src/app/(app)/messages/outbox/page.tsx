import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listOutbox, type OutboxFilter } from "@/lib/messaging/outbox";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/time";
import { cancelJobAction, retryJobAction } from "../actions";
import { ChannelStatus, StaffTabs } from "../_components/shared";

export const metadata = { title: "Outbox" };

const FILTERS: [OutboxFilter, string][] = [
  ["attention", "Needs attention"],
  ["pending", "Pending"],
  ["done", "Done"],
  ["all", "All"],
];

export default async function OutboxPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const v = await requireCap("settings.manage");
  const sp = await searchParams;
  const filter = (FILTERS.find(([k]) => k === sp.f)?.[0] ?? "attention") as OutboxFilter;
  const { rows, counts } = await listOutbox(db, v, filter);
  return (
    <>
      <PageHeader title="Messages" description="Background jobs: deliveries, automations and notifications from every module. Failed jobs retry with exponential backoff, then land here as dead." />
      <StaffTabs v={v} current="outbox" />
      <ChannelStatus />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Dead" value={counts.dead ?? 0} tone={counts.dead ? "bad" : undefined} />
        <Stat label="Pending" value={(counts.pending ?? 0) + (counts.running ?? 0)} hint="Run pnpm jobs:work to process" />
        <Stat label="Done" value={counts.done ?? 0} />
        <Stat label="Cancelled" value={counts.cancelled ?? 0} />
      </div>
      <nav className="mb-3 flex flex-wrap gap-1" aria-label="Job filter">
        {FILTERS.map(([k, label]) => (
          <Link
            key={k}
            href={`/messages/outbox?f=${k}`}
            aria-current={filter === k ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1.5 text-sm", filter === k ? "border-brand bg-brand/10 font-medium text-brand" : "border-edge text-ink-2")}
          >
            {label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={filter === "attention" ? "Nothing needs attention" : "No jobs"}>{filter === "attention" ? "No dead or failed jobs." : null}</EmptyState>
      ) : (
        <Card>
          <Table caption="Jobs">
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th align="right">Attempts</Th>
                <Th>Next run / finished</Th>
                <Th>Last error</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id}>
                  <Td>
                    <code className="text-xs">{j.type}</code>
                    <div className="max-w-56 truncate text-[11px] text-ink-3" title={JSON.stringify(j.payload)}>
                      {Object.entries(j.payload)
                        .filter(([k]) => k !== "orgId" && k !== "scope")
                        .map(([k, val]) => `${k}=${String(val).slice(0, 12)}`)
                        .join(" ")}
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge status={j.status} />
                  </Td>
                  <Td align="right">
                    {j.attempts}/{j.maxAttempts}
                  </Td>
                  <Td className="text-xs">{j.finishedAt ? fmt(j.finishedAt, "MMM d, h:mm a") : fmt(j.runAt, "MMM d, h:mm a")}</Td>
                  <Td className="max-w-64 text-xs text-bad">
                    <span className="line-clamp-2" title={j.lastError ?? undefined}>
                      {j.lastError ?? ""}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      {["dead", "failed", "cancelled"].includes(j.status) ? (
                        <ActionForm action={retryJobAction}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <SubmitButton size="sm" variant="secondary" pendingText="…">
                            Retry
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                      {["pending", "dead", "failed"].includes(j.status) ? (
                        <ActionForm action={cancelJobAction}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <SubmitButton size="sm" variant="ghost" pendingText="…" confirm="Cancel this job?">
                            Cancel
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
