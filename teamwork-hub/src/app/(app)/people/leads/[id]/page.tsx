import Link from "next/link";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { commPreferences } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { StableForm, StableSubmit } from "@/app/(app)/messages/_components/stable-form";
import {
  Badge,
  ButtonLink,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { getLead, upcomingAssessmentSessions } from "@/lib/crm/leads";
import { listStages } from "@/lib/crm/stages";
import { DomainError } from "@/lib/messaging/errors";
import { staffDirectory } from "@/lib/messaging/threads";
import { fmt, fmtDate } from "@/lib/time";
import {
  addNoteAction,
  addTaskAction,
  assignOwnerAction,
  changeStageAction,
  markContactedAction,
  messageLeadAction,
  resolveDuplicateAction,
  scheduleAssessmentAction,
  setTagAction,
  toggleTaskAction,
} from "../actions";

export const metadata = { title: "Lead" };

export default async function LeadDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ converted?: string }> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  const { converted } = await searchParams;
  let d: Awaited<ReturnType<typeof getLead>>;
  try {
    d = await getLead(db, v, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const [stages, staff, sessions] = await Promise.all([listStages(db, v.orgId), staffDirectory(db, v.orgId), upcomingAssessmentSessions(db, v.orgId)]);
  const { lead, person, contact } = d;
  const contactPerson = contact ?? person;
  const prefs = await db.select().from(commPreferences).where(inArray(commPreferences.personId, [contactPerson.id]));
  const consent = (ch: "email" | "sms") => prefs.find((p) => p.channel === ch);
  const stage = stages.find((s) => s.key === lead.stage);
  const inq = lead.inquiry as Record<string, unknown>;
  const closed = !!lead.convertedAt;

  return (
    <>
      <PageHeader
        kicker="Lead"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {person.firstName} {person.lastName}
            <Badge variant={stage?.isWon ? "green" : stage?.isLost ? "red" : "blue"}>{stage?.label ?? lead.stage}</Badge>
          </span>
        }
        description={[d.age != null ? `${d.age} yrs` : null, lead.interest, lead.source ? `via ${lead.source.replaceAll("_", " ")}` : null, `created ${fmtDate(lead.createdAt)}`]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <ButtonLink href="/people/leads" variant="outline">
              All leads
            </ButtonLink>
            {!closed ? <ButtonLink href={`/people/leads/${lead.id}/convert`}>Convert to athlete</ButtonLink> : null}
          </>
        }
      />

      <div className="mb-5 space-y-3">
        {converted || closed ? (
          <Callout tone="ok" title="Converted">
            Converted {fmt(lead.convertedAt)} to an active athlete record. Onboarding follow-up task is created by the background worker.
          </Callout>
        ) : null}
        {stage?.isLost ? (
          <Callout tone="bad" title="Lost">
            Reason: {lead.lostReason ?? "—"}
          </Callout>
        ) : null}
        {d.possibleDuplicates.length && d.duplicateReview !== "resolved" ? (
          <Callout tone="warn" title="Possible duplicate — review before converting">
            <p>
              The inquiry&apos;s email or phone matches existing people:{" "}
              {d.possibleDuplicates.map((p) => `${p.name} (${p.matchedOn})`).join(", ")}. Nothing was merged. At conversion you&apos;ll choose to link the existing person or create a new one.
            </p>
            <ActionForm action={resolveDuplicateAction} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="leadId" value={lead.id} />
              <Field label="These are different people because…" htmlFor="dup-note" className="min-w-60 flex-1">
                <Input id="dup-note" name="note" required maxLength={500} placeholder="e.g. shared family email" />
              </Field>
              <SubmitButton variant="secondary">Mark reviewed</SubmitButton>
            </ActionForm>
          </Callout>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Inquiry" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Item label="Contact">{contact ? `${contact.firstName} ${contact.lastName} (parent/guardian)` : `${person.firstName} ${person.lastName} (self)`}</Item>
                <Item label="Email">{contactPerson.email ?? "—"}</Item>
                <Item label="Phone">{contactPerson.phone ?? "—"}</Item>
                <Item label="Consent">
                  <span className="flex flex-wrap gap-1">
                    <ConsentBadge ch="Email" c={consent("email")?.consent} />
                    <ConsentBadge ch="SMS" c={consent("sms")?.consent} />
                  </span>
                  {consent("email")?.capturedAt ? <span className="mt-0.5 block text-xs text-ink-3">{consent("email")?.consentSource} · {fmt(consent("email")!.capturedAt)}</span> : null}
                </Item>
                <Item label="Sport">{lead.interest ?? "—"}</Item>
                <Item label="Age at inquiry">{typeof inq.athleteAge === "number" ? inq.athleteAge : "—"}</Item>
                <Item label="Preferred times">{Array.isArray(inq.preferredTimes) && inq.preferredTimes.length ? (inq.preferredTimes as string[]).join(", ") : "—"}</Item>
                <Item label="Heard from">{(inq.heardFrom as string) ?? "—"}</Item>
                <Item label="Goals" wide>
                  <span className="whitespace-pre-wrap">{(inq.goals as string) || "—"}</span>
                </Item>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <ActionForm action={addNoteAction} resetOnSuccess className="space-y-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Field label="Add a note (staff only)" htmlFor="note-body">
                  <Textarea id="note-body" name="body" required maxLength={4000} rows={2} />
                </Field>
                <SubmitButton variant="secondary">Add note</SubmitButton>
              </ActionForm>
              <ul className="mt-4 space-y-3">
                {d.notes.length === 0 ? <li className="text-sm text-ink-3">No notes yet.</li> : null}
                {d.notes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-xs text-ink-3">
                      {n.author ?? "Staff"} · {fmt(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Conversations" />
            <CardBody>
              {d.threads.length ? (
                <ul className="mb-4 divide-y divide-edge text-sm">
                  {d.threads.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                      <Link href={`/messages/${t.id}`} className="font-medium hover:underline">
                        {t.subject}
                      </Link>
                      <span className="text-xs text-ink-3">{t.lastMessageAt ? fmt(t.lastMessageAt, "MMM d, h:mm a") : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <StableForm action={messageLeadAction} withMutationId className="space-y-3">
                <input type="hidden" name="leadId" value={lead.id} />
                <Field label="Subject" htmlFor="lm-subject">
                  <Input id="lm-subject" name="subject" required maxLength={200} defaultValue="Scheduling your assessment" />
                </Field>
                <Field label={`Message to ${contactPerson.firstName}`} htmlFor="lm-body">
                  <Textarea id="lm-body" name="body" required maxLength={5000} rows={3} />
                </Field>
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="sr-only">Channels</legend>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="channels" value="email" defaultChecked className="size-4" /> Email
                  </label>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" name="channels" value="sms" className="size-4" /> SMS {consent("sms")?.consent !== "opted_in" ? <span className="text-xs text-ink-3">(no opt-in — will be suppressed)</span> : null}
                  </label>
                </fieldset>
                <p className="text-xs text-ink-3">Consent and quiet hours are applied automatically. External delivery only happens when email/SMS providers are configured.</p>
                <StableSubmit pendingText="Sending…">Send message</StableSubmit>
              </StableForm>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="History" kicker="Audit" />
            <CardBody>
              <ol className="space-y-2 text-sm">
                {d.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap gap-x-2 border-l-2 border-edge pl-3">
                    <span className="font-medium">{h.summary ?? h.action}</span>
                    <span className="text-xs text-ink-3">
                      {h.actorName ?? "—"} · {fmt(h.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Pipeline" />
            <CardBody className="space-y-4">
              {closed ? (
                <p className="text-sm text-ink-3">Converted leads are locked in the Won stage.</p>
              ) : (
                <ActionForm action={changeStageAction} className="space-y-2">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <Field label="Stage" htmlFor="stage">
                    <Select id="stage" name="stage" defaultValue={lead.stage}>
                      {stages
                        .filter((s) => !s.isWon)
                        .map((s) => (
                          <option key={s.id} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Lost reason (required when moving to Lost)" htmlFor="lostReason">
                    <Input id="lostReason" name="lostReason" maxLength={500} defaultValue={lead.lostReason ?? ""} />
                  </Field>
                  <SubmitButton variant="secondary">Update stage</SubmitButton>
                </ActionForm>
              )}
              <ActionForm action={assignOwnerAction} className="flex items-end gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Field label="Owner" htmlFor="owner" className="flex-1">
                  <Select id="owner" name="ownerUserId" defaultValue={lead.ownerUserId ?? ""}>
                    <option value="">Unassigned</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <SubmitButton variant="secondary">Assign</SubmitButton>
              </ActionForm>
              <ActionForm action={markContactedAction} className="flex items-end gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Field label={`Log contact · last: ${lead.lastContactedAt ? fmt(lead.lastContactedAt, "MMM d, h:mm a") : "never"}`} htmlFor="method" className="flex-1">
                  <Select id="method" name="method" defaultValue="phone">
                    <option value="phone">Phone call</option>
                    <option value="email">Email</option>
                    <option value="text">Text</option>
                    <option value="in_person">In person</option>
                  </Select>
                </Field>
                <SubmitButton variant="secondary">Log</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Assessment" />
            <CardBody>
              {d.assessment ? (
                <p className="mb-3 text-sm">
                  Scheduled: <strong>{d.assessment.title}</strong> · {fmt(d.assessment.startsAt)} <StatusBadge status={d.assessment.status} />
                </p>
              ) : null}
              {sessions.length === 0 ? (
                <EmptyState title="No upcoming assessment sessions">
                  Create sessions with a service type of kind <em>assessment</em> in Schedule, then pick one here.
                </EmptyState>
              ) : closed ? null : (
                <ActionForm action={scheduleAssessmentAction} className="space-y-2">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <Field label="Assessment session" htmlFor="sessionId">
                    <Select id="sessionId" name="sessionId" defaultValue={lead.assessmentSessionId ?? ""}>
                      <option value="">— None —</option>
                      {sessions.map((s) => (
                        <option key={s.id} value={s.id} disabled={s.linkedLeads + s.booked >= s.capacity && s.id !== lead.assessmentSessionId}>
                          {s.title} · {fmt(s.startsAt, "EEE MMM d, h:mm a")} · {s.capacity - s.linkedLeads - s.booked} open
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton variant="secondary">Save assessment</SubmitButton>
                </ActionForm>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Tasks" />
            <CardBody>
              <ul className="mb-4 space-y-2">
                {d.tasks.length === 0 ? <li className="text-sm text-ink-3">No tasks.</li> : null}
                {d.tasks.map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-2 text-sm">
                    <div className={t.status === "done" ? "text-ink-3 line-through" : ""}>
                      {t.title}
                      <div className="text-xs text-ink-3 no-underline">
                        {t.assignee ?? "Unassigned"}
                        {t.dueAt ? ` · due ${fmt(t.dueAt, "MMM d")}` : ""}
                      </div>
                    </div>
                    <ActionForm action={toggleTaskAction}>
                      <input type="hidden" name="taskId" value={t.id} />
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="done" value={t.status === "done" ? "0" : "1"} />
                      <SubmitButton size="sm" variant="ghost" pendingText="…">
                        {t.status === "done" ? "Reopen" : "Done"}
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
              <ActionForm action={addTaskAction} resetOnSuccess className="space-y-2">
                <input type="hidden" name="leadId" value={lead.id} />
                <Field label="New task" htmlFor="task-title">
                  <Input id="task-title" name="title" required maxLength={200} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Due" htmlFor="task-due">
                    <Input id="task-due" name="dueDate" type="date" />
                  </Field>
                  <Field label="Assignee" htmlFor="task-assignee">
                    <Select id="task-assignee" name="assigneeUserId" defaultValue="">
                      <option value="">Lead owner</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <SubmitButton variant="secondary">Add task</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Tags" />
            <CardBody>
              {d.allTags.length === 0 ? <p className="text-sm text-ink-3">No tags are defined yet.</p> : null}
              <ul className="flex flex-wrap gap-2">
                {d.allTags.map((t) => {
                  const on = d.tags.some((x) => x.id === t.id);
                  return (
                    <li key={t.id}>
                      <ActionForm action={setTagAction}>
                        <input type="hidden" name="leadId" value={lead.id} />
                        <input type="hidden" name="tagId" value={t.id} />
                        <input type="hidden" name="on" value={on ? "0" : "1"} />
                        <button
                          type="submit"
                          aria-pressed={on}
                          className={`min-h-9 rounded-full border px-3 text-xs font-medium ${on ? "border-brand bg-brand/10 text-brand" : "border-edge text-ink-2"}`}
                        >
                          {on ? "✓ " : "+ "}
                          {t.name}
                        </button>
                      </ActionForm>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Item({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="kicker">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function ConsentBadge({ ch, c }: { ch: string; c?: string }) {
  return (
    <Badge variant={c === "opted_in" ? "green" : c === "opted_out" ? "red" : "neutral"}>
      {ch}: {c === "opted_in" ? "opted in" : c === "opted_out" ? "opted out" : "no consent"}
    </Badge>
  );
}
