import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Select, Textarea } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { loadThread, markRead, staffDirectory, type ThreadView } from "@/lib/messaging/threads";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/time";
import { assignAction, replyAction, statusAction } from "../actions";
import { StableForm, StableSubmit } from "../_components/stable-form";
import { ChannelStatus, DeliveryBadge } from "../_components/shared";

export const metadata = { title: "Conversation" };

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const v = await requireViewer();
  const { threadId } = await params;
  let view: ThreadView;
  try {
    view = await loadThread(db, v, threadId);
    await db.transaction((tx) => markRead(tx, v, threadId));
  } catch (e) {
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  const staff = view.mode === "staff";
  const t = view.thread;
  const staffList = staff ? await staffDirectory(db, v.orgId) : [];
  const family = view.participants.filter((p) => p.role !== "staff");

  return (
    <>
      <div className="mb-4">
        <Link href="/messages" className="text-sm text-ink-3 underline underline-offset-2">
          ← All messages
        </Link>
      </div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{t.subject}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-3">
            {view.athlete ? <span>About {view.athlete.name}</span> : null}
            {staff && view.lead ? (
              <Link href={`/people/leads/${view.lead.id}`} className="underline">
                Lead: {view.lead.name}
              </Link>
            ) : null}
            {t.status === "closed" ? <Badge>closed</Badge> : <Badge variant="green">open</Badge>}
          </p>
        </div>
      </header>

      <div className={cn("grid gap-5", staff && "lg:grid-cols-[1fr_300px]")}>
        <div className="min-w-0 space-y-4">
          <ol className="space-y-3" aria-label="Messages">
            {view.messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "rounded-xl border px-4 py-3",
                  m.isInternalNote ? "border-warn/40 bg-warn/5" : m.mine ? "border-brand/30 bg-brand/5 sm:ml-10" : "border-edge bg-surface sm:mr-10",
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-3">
                  <span className="font-semibold text-ink-2">
                    {m.isInternalNote ? "Internal note · " : ""}
                    {m.senderName}
                    {m.automationRuleId ? " · automated" : ""}
                    {m.campaignId ? " · announcement" : ""}
                    {m.inboundChannel ? ` · replied by ${m.inboundChannel === "sms" ? "text" : "email"}` : ""}
                  </span>
                  <time dateTime={m.createdAt.toISOString()}>{fmt(m.createdAt, "EEE MMM d, h:mm a")}</time>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                {m.isInternalNote ? <p className="mt-1 text-[11px] font-medium text-warn">Staff only — never shown to or sent to families.</p> : null}
                {staff && m.deliveries.length ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-ink-3">Delivery ({m.deliveries.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {groupByRecipient(m.deliveries).map(([name, ds]) => (
                        <li key={name} className="flex flex-wrap items-center gap-1 text-xs">
                          <span className="mr-1 text-ink-2">{name}</span>
                          {ds.map((d) => (
                            <DeliveryBadge key={d.id} channel={d.channel} status={d.status} reason={d.statusReason} />
                          ))}
                          {ds.filter((d) => d.statusReason).map((d) => (
                            <span key={`${d.id}-r`} className="w-full pl-2 text-ink-3">
                              {d.channel}: {d.statusReason}
                            </span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>

          <Card>
            <CardBody className="pt-4">
              {staff ? <ChannelStatus /> : null}
              {!staff && t.status === "closed" ? (
                <Callout tone="info" className="mb-3">
                  This conversation was closed. Replying will reopen it.
                </Callout>
              ) : null}
              <StableForm action={replyAction} withMutationId resetOnSuccess className="space-y-3">
                <input type="hidden" name="threadId" value={t.id} />
                {staff ? (
                  <fieldset className="flex flex-wrap gap-4 text-sm">
                    <legend className="sr-only">Message type</legend>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="radio" name="kind" value="reply" defaultChecked className="size-4" /> Reply to {family.length ? family.map((p) => p.name).join(", ") : "participants"}
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="radio" name="kind" value="internal" className="size-4" /> Internal note (staff only)
                    </label>
                  </fieldset>
                ) : null}
                <Field label={staff ? "Message" : "Reply"} htmlFor="reply-body">
                  <Textarea id="reply-body" name="body" required maxLength={5000} rows={4} />
                </Field>
                {staff ? (
                  <fieldset className="flex flex-wrap items-center gap-4 text-sm">
                    <legend className="mb-1 text-xs text-ink-3">Also send a copy by (replies only; consent & quiet hours apply):</legend>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="channels" value="email" className="size-4" /> Email
                    </label>
                    <label className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="channels" value="sms" className="size-4" /> SMS
                    </label>
                  </fieldset>
                ) : (
                  <p className="text-xs text-ink-3">Your reply goes to the Teamwork staff only.</p>
                )}
                <StableSubmit pendingText="Sending…">{staff ? "Send" : "Send reply"}</StableSubmit>
              </StableForm>
            </CardBody>
          </Card>
        </div>

        {staff ? (
          <aside aria-label="Conversation details" className="space-y-4">
            <Card>
              <CardHeader title="Participants" />
              <CardBody>
                <ul className="space-y-1 text-sm">
                  {view.participants.map((p) => (
                    <li key={p.id} className="flex justify-between gap-2">
                      <span>{p.name}</span>
                      <span className="text-xs text-ink-3">{p.role.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
                {view.athlete?.sport ? <p className="mt-3 text-xs text-ink-3">Athlete sport: {view.athlete.sport}</p> : null}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Assignment" />
              <CardBody className="space-y-3">
                <ActionForm action={assignAction} className="space-y-2">
                  <input type="hidden" name="threadId" value={t.id} />
                  <Field label="Assigned to" htmlFor="assignee">
                    <Select id="assignee" name="userId" defaultValue={t.assignedUserId ?? ""}>
                      <option value="">Unassigned</option>
                      {staffList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton variant="secondary" size="sm">
                    Save assignment
                  </SubmitButton>
                </ActionForm>
                {t.assignedUserId !== v.userId ? (
                  <ActionForm action={assignAction}>
                    <input type="hidden" name="threadId" value={t.id} />
                    <input type="hidden" name="userId" value="me" />
                    <SubmitButton variant="ghost" size="sm">
                      Assign to me
                    </SubmitButton>
                  </ActionForm>
                ) : null}
                <ActionForm action={statusAction}>
                  <input type="hidden" name="threadId" value={t.id} />
                  <input type="hidden" name="status" value={t.status === "closed" ? "open" : "closed"} />
                  <SubmitButton variant="outline" size="sm">
                    {t.status === "closed" ? "Reopen conversation" : "Close conversation"}
                  </SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          </aside>
        ) : null}
      </div>
    </>
  );
}

function groupByRecipient<T extends { recipientName: string | null }>(ds: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const d of ds) {
    const k = d.recipientName ?? "Unknown";
    m.set(k, [...(m.get(k) ?? []), d]);
  }
  return [...m.entries()];
}
