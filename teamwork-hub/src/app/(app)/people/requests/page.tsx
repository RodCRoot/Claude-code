import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { MemberRequestType } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { BILL_AFFECTING_TYPES, channelLabel, REQUEST_CHANNELS, REQUEST_STATUSES, REQUEST_TYPES, typeLabel } from "@/lib/member-ops/common";
import { canManageRequests, listRequests, requestFormOptions, type RequestFilter, type RequestRow } from "@/lib/member-ops/requests";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { PeopleTabs } from "@/components/people-tabs";
import { confirmSuggestionAction, createRequestAction, dismissSuggestionAction, scanSuggestionsAction, updateRequestAction } from "./actions";

export const metadata = { title: "Member requests" };

const VIEWS: { key: NonNullable<RequestFilter["view"]>; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "suggested", label: "Suggested (confirm)" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

function SlaBadge({ r }: { r: RequestRow }) {
  if (r.sla === "closed") return <Badge>{`closed in ${r.daysUnprocessed}d`}</Badge>;
  const v = r.sla === "breach" ? "red" : r.sla === "warn" ? "yellow" : "green";
  const label = r.sla === "breach" ? "SLA breached" : r.sla === "warn" ? "SLA at risk" : "within SLA";
  return (
    <Badge variant={v} title="Days since the family sent it">
      {r.daysUnprocessed}d unprocessed · {label}
    </Badge>
  );
}

function RequestItem({ r, today, opts }: { r: RequestRow; today: string; opts: Awaited<ReturnType<typeof requestFormOptions>> }) {
  const open = r.status === "new" || r.status === "in_progress";
  return (
    <li className="space-y-2 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="brand">{typeLabel(r.type)}</Badge>
        <StatusBadge status={r.status} />
        {r.suggested ? (
          <Badge variant="yellow" title={`Matched keyword "${r.matchedKeyword}" — staff must confirm`}>
            suggested · “{r.matchedKeyword}”
          </Badge>
        ) : null}
        <SlaBadge r={r} />
        {r.asks > 1 ? (
          <Badge variant="red" title="Same athlete + same kind of request within the repeat window">
            asked {r.asks}× since {fmtDate(r.firstAskedOn)} — apology owed
          </Badge>
        ) : null}
        {r.reply ? (
          <Link href={`/messages/${r.reply.threadId}`} className="text-xs font-medium text-ok underline-offset-2 hover:underline">
            replied {fmt(r.reply.at, "MMM d")}
          </Link>
        ) : (
          <Badge variant={open ? "yellow" : "neutral"}>no staff reply found</Badge>
        )}
        {BILL_AFFECTING_TYPES.includes(r.type) && r.billedSince.count ? (
          <Badge variant="red" title="Membership invoices with a bill date after the family asked (and before resolution)">
            billed {r.billedSince.count}× since asked · {formatMoney(r.billedSince.totalMinor)}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">
          {r.athletes.length
            ? r.athletes.map((a, i) => (
                <span key={a.athleteId}>
                  {i ? ", " : ""}
                  <Link href={`/people/${a.personId}/membership-status`} className="hover:underline">
                    {a.name}
                  </Link>
                </span>
              ))
            : <span className="text-bad">No athlete linked</span>}
        </span>
        <span className="text-ink-3">
          Sent <strong className="text-ink">{fmtDate(r.sentOn)}</strong>
          {r.receivedOn ? <> · seen {fmtDate(r.receivedOn)}{r.daysBeforeSeen ? ` (${r.daysBeforeSeen}d later)` : ""}</> : null} · {channelLabel(r.channel)}
          {r.requesterName ? <> · from {r.requesterPersonId ? <Link className="hover:underline" href={`/people/${r.requesterPersonId}`}>{r.requesterName}</Link> : r.requesterName}</> : null}
          {r.requestedEffectiveOn ? <> · wants effective {fmtDate(r.requestedEffectiveOn)}</> : null}
        </span>
        <span className="text-ink-3">Owner: {r.ownerName ?? "unassigned"}</span>
      </div>
      {r.summary ? <p className="text-sm text-ink-2">{r.summary}</p> : null}
      {r.threadId ? (
        <Link href={`/messages/${r.threadId}`} className="text-xs text-brand underline-offset-2 hover:underline">
          Conversation: {r.threadSubject ?? "open thread"}
        </Link>
      ) : null}
      {r.resolutionNotes && !open ? <p className="text-xs text-ink-3">Resolution: {r.resolutionNotes}</p> : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-brand">{r.suggested ? "Review suggestion" : "Work this request"}</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {r.pastedText ? (
            <div className="lg:col-span-2">
              <div className="kicker mb-1">Pasted message</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs">{r.pastedText}</pre>
            </div>
          ) : null}
          {r.suggested && r.status === "new" ? (
            <>
              <ActionForm action={confirmSuggestionAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <Field label="Type" htmlFor={`ct-${r.id}`}>
                  <Select id={`ct-${r.id}`} name="type" defaultValue={r.type}>
                    {REQUEST_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton size="sm">Confirm request</SubmitButton>
              </ActionForm>
              <ActionForm action={dismissSuggestionAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <Field label="Why dismiss?" htmlFor={`dr-${r.id}`}>
                  <Input id={`dr-${r.id}`} name="reason" placeholder="Not a membership request" />
                </Field>
                <SubmitButton size="sm" variant="secondary">
                  Dismiss
                </SubmitButton>
              </ActionForm>
            </>
          ) : null}
          {r.status !== "dismissed" ? (
            <ActionForm action={updateRequestAction} className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
              <input type="hidden" name="requestId" value={r.id} />
              <Field label="Status" htmlFor={`st-${r.id}`}>
                <Select id={`st-${r.id}`} name="status" defaultValue={r.status}>
                  {REQUEST_STATUSES.filter((s) => s.key !== "dismissed").map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner" htmlFor={`ow-${r.id}`}>
                <Select id={`ow-${r.id}`} name="ownerUserId" defaultValue={r.ownerUserId ?? ""}>
                  <option value="">Unassigned</option>
                  {opts.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sent by family on" htmlFor={`so-${r.id}`} hint="The date the family sent it — not when staff saw it.">
                <Input id={`so-${r.id}`} name="sentOn" type="date" max={today} defaultValue={r.sentOn} />
              </Field>
              <Field label="Received / seen by staff" htmlFor={`ro-${r.id}`}>
                <Input id={`ro-${r.id}`} name="receivedOn" type="date" max={today} defaultValue={r.receivedOn ?? ""} />
              </Field>
              <Field label="Linked conversation" htmlFor={`th-${r.id}`}>
                <Select id={`th-${r.id}`} name="threadId" defaultValue={r.threadId ?? ""}>
                  <option value="">None</option>
                  {r.threadId && !opts.threads.some((t) => t.id === r.threadId) ? <option value={r.threadId}>{r.threadSubject ?? "Current thread"}</option> : null}
                  {opts.threads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.subject}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Athletes" htmlFor={`at-${r.id}`} hint="Ctrl/Cmd-click to choose several.">
                <Select id={`at-${r.id}`} name="athleteIds" multiple defaultValue={r.athletes.map((a) => a.athleteId)} className="h-24">
                  {opts.athletes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resolution notes" htmlFor={`rn-${r.id}`} className="sm:col-span-2" hint="Required to resolve or decline. Say what was done and the effective date used.">
                <Textarea id={`rn-${r.id}`} name="resolutionNotes" defaultValue={r.resolutionNotes ?? ""} />
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton size="sm">Save</SubmitButton>
                <span className="ml-3 text-xs text-ink-3">Recording only — billing changes are made in Memberships & Billing.</span>
              </div>
            </ActionForm>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireStaff();
  if (!canManageRequests(v)) redirect("/denied");
  const sp = await searchParams;
  const view = VIEWS.find((x) => x.key === sp.view)?.key ?? "open";
  const type = REQUEST_TYPES.find((t) => t.key === sp.type)?.key as MemberRequestType | undefined;
  const [{ rows, settings, today }, opts, suggested] = await Promise.all([
    listRequests(db, v, { view, type, ownerUserId: sp.owner === "me" ? v.userId : undefined }),
    requestFormOptions(db, v),
    listRequests(db, v, { view: "suggested" }),
  ]);
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries({ view, type, owner: sp.owner, ...patch })) if (val) p.set(k, val);
    return `/people/requests?${p}`;
  };
  const breached = rows.filter((r) => r.sla === "breach").length;

  return (
    <>
      <PageHeader
        kicker="People"
        title="Member requests"
        description="Every hold, pause, cancel, in-season, plan-change, card and billing request from any channel — dated to when the family sent it. Suggestions from inbound messages are never acted on until staff confirm them."
      />
      <PeopleTabs current="requests" showLeads={can(v, "crm.manage")} showRequests />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <nav aria-label="Request views" className="flex flex-wrap gap-2">
            {VIEWS.map((x) => (
              <Link
                key={x.key}
                href={qs({ view: x.key })}
                aria-current={view === x.key ? "true" : undefined}
                className={`min-h-9 rounded-full border px-3 py-1.5 text-sm ${view === x.key ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink-2 hover:bg-surface-2"}`}
              >
                {x.label}
                {x.key === "suggested" && suggested.rows.length ? ` · ${suggested.rows.length}` : ""}
              </Link>
            ))}
            <Link href={qs({ owner: sp.owner === "me" ? undefined : "me" })} className="min-h-9 rounded-full border border-edge px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
              {sp.owner === "me" ? "Everyone's" : "Mine only"}
            </Link>
          </nav>
          <form action="/people/requests" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="view" value={view} />
            {sp.owner ? <input type="hidden" name="owner" value={sp.owner} /> : null}
            <label htmlFor="type-filter" className="sr-only">
              Type
            </label>
            <Select id="type-filter" name="type" defaultValue={type ?? ""} className="w-48">
              <option value="">All types</option>
              {REQUEST_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
            <button className="h-10 rounded-lg border border-edge px-4 text-sm font-medium" type="submit">
              Filter
            </button>
            <span className="text-xs text-ink-3">
              SLA: at risk after {settings.slaWarnDays}d, breached after {settings.slaBreachDays}d · repeat asks within {settings.repeatWindowDays}d
              {breached ? <strong className="ml-1 text-bad">· {breached} breached</strong> : null}
            </span>
          </form>
          <Card>
            {rows.length === 0 ? (
              <div className="p-5">
                <EmptyState title={view === "suggested" ? "No suggestions to review" : "No requests here"}>
                  {view === "open" ? "Log requests that arrive by email, text, Messenger, phone (AI Call Recap) or the website so none sit unanswered." : null}
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-edge">
                {rows.map((r) => (
                  <RequestItem key={r.id} r={r} today={today} opts={opts} />
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Log a request" kicker="Any channel" />
            <CardBody>
              <ActionForm action={createRequestAction} className="space-y-3" resetOnSuccess>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type" htmlFor="nr-type" required>
                    <Select id="nr-type" name="type" defaultValue="hold" required>
                      {REQUEST_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Channel" htmlFor="nr-channel" required>
                    <Select id="nr-channel" name="channel" defaultValue="email_direct" required>
                      {REQUEST_CHANNELS.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Athlete(s)" htmlFor="nr-athletes" hint="Ctrl/Cmd-click to choose siblings." required>
                  <Select id="nr-athletes" name="athleteIds" multiple required className="h-28">
                    {opts.athletes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Requested by" htmlFor="nr-requester">
                  <Select id="nr-requester" name="requesterPersonId" defaultValue="">
                    <option value="">Unknown / not on file</option>
                    {opts.requesters.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Family sent it on" htmlFor="nr-sent" hint="Check the original email/text date." required>
                    <Input id="nr-sent" name="sentOn" type="date" max={today} defaultValue={today} required />
                  </Field>
                  <Field label="Staff saw it on" htmlFor="nr-recv">
                    <Input id="nr-recv" name="receivedOn" type="date" max={today} defaultValue={today} />
                  </Field>
                </div>
                <Field label="Effective date they asked for" htmlFor="nr-eff">
                  <Input id="nr-eff" name="requestedEffectiveOn" type="date" />
                </Field>
                <Field label="Summary" htmlFor="nr-summary">
                  <Input id="nr-summary" name="summary" placeholder="e.g. Hold Sep–Oct for school soccer" maxLength={2000} />
                </Field>
                <Field label="Linked conversation" htmlFor="nr-thread">
                  <Select id="nr-thread" name="threadId" defaultValue="">
                    <option value="">None — paste the message below</option>
                    {opts.threads.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.subject}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Pasted message" htmlFor="nr-paste" hint="Forwarded email, AI Call Recap, Messenger or web-form text.">
                  <Textarea id="nr-paste" name="pastedText" maxLength={20000} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Owner" htmlFor="nr-owner">
                    <Select id="nr-owner" name="ownerUserId" defaultValue={v.userId}>
                      <option value="">Unassigned</option>
                      {opts.staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Status" htmlFor="nr-status">
                    <Select id="nr-status" name="status" defaultValue="new">
                      <option value="new">New</option>
                      <option value="in_progress">In progress</option>
                    </Select>
                  </Field>
                </div>
                <SubmitButton size="sm">Log request</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Find requests in messages" kicker="Suggestions" />
            <CardBody>
              <p className="mb-3 text-sm text-ink-3">
                New family messages are screened automatically for hold, pause, cancel, in season and card. Run a scan to catch older Hub messages and unmatched email/SMS. Matches appear under “Suggested” for staff to confirm or dismiss — nothing is changed automatically.
              </p>
              <ActionForm action={scanSuggestionsAction} className="flex items-end gap-2">
                <Field label="Look back (days)" htmlFor="scan-days">
                  <Input id="scan-days" name="days" type="number" min={1} max={365} defaultValue={30} className="w-28" />
                </Field>
                <SubmitButton size="sm" variant="secondary" pendingText="Scanning…">
                  Scan messages
                </SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
