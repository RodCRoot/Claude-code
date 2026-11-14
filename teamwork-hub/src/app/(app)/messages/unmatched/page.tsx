import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { listInbound, suggestedThreads } from "@/lib/messaging/inbound";
import { fmt } from "@/lib/time";
import { attachInboundAction, dismissInboundAction } from "../actions";
import { StaffTabs } from "../_components/shared";

export const metadata = { title: "Unmatched replies" };

export default async function UnmatchedPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const v = await requireCap("crm.manage");
  const sp = await searchParams;
  const resolved = sp.view === "resolved";
  const rows = await listInbound(db, v, resolved ? "resolved" : "unmatched");
  const suggestions = new Map<string, Awaited<ReturnType<typeof suggestedThreads>>>();
  if (!resolved) {
    for (const r of rows) if (r.matchedPersonId && !suggestions.has(r.matchedPersonId)) suggestions.set(r.matchedPersonId, await suggestedThreads(db, v, r.matchedPersonId));
  }
  return (
    <>
      <PageHeader
        title="Messages"
        description="Email and text replies that couldn't be matched to a conversation. Staff only — nothing here is visible to families or sent anywhere."
      />
      <StaffTabs v={v} current="unmatched" />
      <div className="mb-3 flex gap-3 text-sm">
        <Link href="/messages/unmatched" aria-current={!resolved ? "page" : undefined} className={!resolved ? "font-semibold" : "text-ink-3 underline"}>
          Waiting
        </Link>
        <Link href="/messages/unmatched?view=resolved" aria-current={resolved ? "page" : undefined} className={resolved ? "font-semibold" : "text-ink-3 underline"}>
          Handled &amp; auto-threaded
        </Link>
      </div>
      {!resolved ? (
        <Callout tone="info" className="mb-4">
          Replies are threaded automatically when the sender is a known participant who can still message about that athlete. Everything else waits here. Attaching credits the sender only if they are an
          eligible participant of the conversation you choose.
        </Callout>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={resolved ? "Nothing handled yet" : "No unmatched replies"} />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardBody>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={r.channel === "sms" ? "blue" : "neutral"}>{r.channel === "sms" ? "Text" : "Email"}</Badge>
                  <span className="font-medium">{r.fromAddress}</span>
                  {r.matchedName ? <span className="text-sm text-ink-3">— looks like {r.matchedName}</span> : null}
                  <span className="ml-auto text-xs text-ink-3">{fmt(r.receivedAt)}</span>
                </div>
                {r.subject ? <p className="mt-1 text-sm font-semibold">{r.subject}</p> : null}
                <p className="mt-1 whitespace-pre-wrap text-sm">{r.body}</p>
                {r.reason ? <p className="mt-1 text-xs text-ink-3">Why it&apos;s here: {r.reason}</p> : null}
                {resolved ? (
                  <p className="mt-2 text-xs text-ink-3">
                    {r.status}
                    {r.threadId ? (
                      <>
                        {" "}
                        ·{" "}
                        <Link href={`/messages/${r.threadId}`} className="underline">
                          open conversation
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <ActionForm action={attachInboundAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="inboundId" value={r.id} />
                      {r.matchedPersonId && suggestions.get(r.matchedPersonId)?.length ? (
                        <Field label="Attach to conversation" htmlFor={`t-${r.id}`}>
                          <Select id={`t-${r.id}`} name="threadId" required defaultValue="">
                            <option value="" disabled>
                              Choose…
                            </option>
                            {suggestions.get(r.matchedPersonId)!.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.subject}
                                {t.lastMessageAt ? ` · ${fmt(t.lastMessageAt, "MMM d")}` : ""}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ) : (
                        <Field label="Conversation id" htmlFor={`t-${r.id}`} hint="Open the conversation and copy the id from its address.">
                          <Input id={`t-${r.id}`} name="threadId" required placeholder="00000000-…" />
                        </Field>
                      )}
                      <SubmitButton size="sm">Attach</SubmitButton>
                    </ActionForm>
                    <ActionForm action={dismissInboundAction}>
                      <input type="hidden" name="inboundId" value={r.id} />
                      <SubmitButton size="sm" variant="ghost">
                        Dismiss
                      </SubmitButton>
                    </ActionForm>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
