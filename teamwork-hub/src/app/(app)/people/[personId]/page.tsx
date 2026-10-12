import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { people, users } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError, can, isStaff } from "@/lib/authz/policy";
import { getPersonDetail } from "@/lib/people/queries";
import { athleteTimeline } from "@/lib/people/timeline";
import { ActionForm, SubmitButton } from "@/components/forms";
import {
  Avatar,
  Badge,
  ButtonLink,
  Callout,
  Card,
  CardBody,
  CardHeader,
  DemoBadge,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
} from "@/components/ui";
import { fmt, fmtDate } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/nav";
import {
  addNoteAction,
  createAlertAction,
  createTaskAction,
  deactivateAlertAction,
  setTaskStatusAction,
  tagAction,
  updateAthleteAction,
  updatePersonAction,
} from "../actions";
import { AddGuardianForm, GuardianEditor } from "./guardian-forms";

export const metadata = { title: "Person" };

const TIMELINE_KINDS = ["booking", "form", "membership", "invoice", "workout", "max", "test", "wellness", "body", "message"];

function ageFrom(dob: string | null) {
  if (!dob) return null;
  const d = new Date(dob + "T12:00:00Z");
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

export default async function PersonPage({ params, searchParams }: { params: Promise<{ personId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const v = await requireViewer();
  const { personId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(personId)) notFound();

  let d;
  try {
    d = await getPersonDetail(db, v, personId);
  } catch (e) {
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  if (!d) notFound();
  const { person, athlete } = d;
  const tab = sp.tab ?? "overview";
  const staff = isStaff(v);
  const manage = can(v, "people.manage");
  const canGuardians = d.caps.includes("guardians.manage");
  const name = `${person.preferredName ?? person.firstName} ${person.lastName}`;
  const age = ageFrom(person.dateOfBirth);

  const tabs = [
    { key: "overview", href: `/people/${personId}`, label: "Overview" },
    ...(athlete ? [{ key: "timeline", href: `/people/${personId}?tab=timeline`, label: "Timeline" }] : []),
    { key: "family", href: `/people/${personId}?tab=family`, label: "Family & billing" },
    ...(staff ? [{ key: "notes", href: `/people/${personId}?tab=notes`, label: `Notes (${d.notes.length})` }] : []),
  ];

  const staffUsers = staff
    ? await db.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]))).orderBy(asc(users.displayName))
    : [];

  return (
    <>
      <PageHeader
        kicker={athlete ? "Athlete" : d.wards.length ? "Guardian" : "Person"}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={name} className="size-11 text-sm" />
            {name}
            {age != null ? <span className="text-base font-normal text-ink-3">age {age}</span> : null}
            {person.isDemo ? <DemoBadge /> : null}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={athlete && !athlete.active ? "inactive" : person.status} />
            {athlete?.sport ? <Badge>{athlete.sport}</Badge> : null}
            {athlete?.level ? <Badge variant="brand">{athlete.level}</Badge> : null}
            {d.groups.map((g) => (
              <Badge key={g.id} variant="blue">
                {g.name}
              </Badge>
            ))}
            {d.tags.map((t) => (
              <Badge key={t.id}>#{t.name}</Badge>
            ))}
          </span>
        }
        actions={
          athlete ? (
            <>
              {d.caps.includes("booking.create") ? (
                <ButtonLink href={`/schedule?athlete=${athlete.id}`} variant="secondary">
                  Book session
                </ButtonLink>
              ) : null}
              {d.caps.includes("messages.send") ? (
                <ButtonLink href={`/messages?athlete=${athlete.id}`} variant="secondary">
                  Message
                </ButtonLink>
              ) : null}
              {d.caps.includes("training.read") ? (
                <ButtonLink href={`/performance/${athlete.id}`} variant="secondary">
                  Performance
                </ButtonLink>
              ) : null}
            </>
          ) : null
        }
      />

      {d.alerts.length ? (
        <div className="mb-4 space-y-2">
          {d.alerts.map((a) => (
            <Callout key={a.id} tone={a.level === "critical" ? "bad" : a.level === "warning" ? "warn" : "info"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {a.message} {a.showAtKiosk ? <Badge>shown at kiosk</Badge> : null}
                </span>
                {manage ? (
                  <form action={deactivateAlertAction}>
                    <input type="hidden" name="alertId" value={a.id} />
                    <input type="hidden" name="personId" value={personId} />
                    <button className="min-h-9 text-xs font-medium underline" type="submit">
                      Clear alert
                    </button>
                  </form>
                ) : null}
              </div>
            </Callout>
          ))}
        </div>
      ) : null}

      <Tabs tabs={tabs} current={tab} />

      {tab === "overview" ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Card>
              <CardHeader title="Contact" kicker="Person" />
              <CardBody>
                {manage ? (
                  <ActionForm action={updatePersonAction} className="grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="personId" value={personId} />
                    <Field label="First name" htmlFor="p-first">
                      <Input id="p-first" name="firstName" defaultValue={person.firstName} required />
                    </Field>
                    <Field label="Last name" htmlFor="p-last">
                      <Input id="p-last" name="lastName" defaultValue={person.lastName} required />
                    </Field>
                    <Field label="Preferred name" htmlFor="p-pref">
                      <Input id="p-pref" name="preferredName" defaultValue={person.preferredName ?? ""} />
                    </Field>
                    <Field label="Date of birth" htmlFor="p-dob">
                      <Input id="p-dob" name="dateOfBirth" type="date" defaultValue={person.dateOfBirth ?? ""} />
                    </Field>
                    <Field label="Email" htmlFor="p-email">
                      <Input id="p-email" name="email" type="email" defaultValue={person.email ?? ""} />
                    </Field>
                    <Field label="Phone" htmlFor="p-phone">
                      <Input id="p-phone" name="phone" type="tel" defaultValue={person.phone ?? ""} />
                    </Field>
                    <div className="sm:col-span-2">
                      <SubmitButton size="sm">Save contact</SubmitButton>
                    </div>
                  </ActionForm>
                ) : (
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-ink-3">Email</dt>
                      <dd>{person.email ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">Phone</dt>
                      <dd>{person.phone ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">Date of birth</dt>
                      <dd>{fmtDate(person.dateOfBirth)}</dd>
                    </div>
                  </dl>
                )}
              </CardBody>
            </Card>

            {athlete ? (
              <Card>
                <CardHeader title="Athlete profile" kicker="Training identity" />
                <CardBody>
                  {d.caps.includes("profile.write") ? (
                    <ActionForm action={updateAthleteAction} className="grid gap-3 sm:grid-cols-3">
                      <input type="hidden" name="athleteId" value={athlete.id} />
                      <input type="hidden" name="personId" value={personId} />
                      <Field label="Sport" htmlFor="a-sport">
                        <Input id="a-sport" name="sport" defaultValue={athlete.sport ?? ""} />
                      </Field>
                      <Field label="Position" htmlFor="a-pos">
                        <Input id="a-pos" name="position" defaultValue={athlete.position ?? ""} />
                      </Field>
                      <Field label="Level / rank" htmlFor="a-level">
                        <Input id="a-level" name="level" defaultValue={athlete.level ?? ""} />
                      </Field>
                      <Field label="School" htmlFor="a-school">
                        <Input id="a-school" name="school" defaultValue={athlete.school ?? ""} />
                      </Field>
                      <Field label="Grad year" htmlFor="a-grad">
                        <Input id="a-grad" name="gradYear" inputMode="numeric" defaultValue={athlete.gradYear ?? ""} />
                      </Field>
                      <Field label="Status" htmlFor="a-active">
                        <Select id="a-active" name="active" defaultValue={String(athlete.active)}>
                          <option value="true">Active</option>
                          <option value="false">Inactive</option>
                        </Select>
                      </Field>
                      <Field label="Inactive reason" htmlFor="a-reason" className="sm:col-span-2">
                        <Input id="a-reason" name="inactiveReason" defaultValue={athlete.inactiveReason ?? ""} />
                      </Field>
                      <div className="self-end">
                        <SubmitButton size="sm">Save profile</SubmitButton>
                      </div>
                    </ActionForm>
                  ) : (
                    <dl className="grid gap-2 text-sm sm:grid-cols-3">
                      {[
                        ["Sport", athlete.sport],
                        ["Position", athlete.position],
                        ["Level", athlete.level],
                        ["School", athlete.school],
                        ["Grad year", athlete.gradYear],
                      ].map(([k, val]) => (
                        <div key={String(k)}>
                          <dt className="text-ink-3">{k}</dt>
                          <dd>{val ?? "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <div className="mt-4 text-sm text-ink-3">
                    Coaches: {d.coaches.length ? d.coaches.map((c) => c.name).join(", ") : "none assigned"}
                  </div>
                </CardBody>
              </Card>
            ) : null}

            {d.wards.length ? (
              <Card>
                <CardHeader title="Guardian of" />
                <CardBody>
                  <ul className="divide-y divide-edge">
                    {d.wards.map((w) => (
                      <li key={w.g.id} className="flex items-center justify-between py-2 text-sm">
                        <Link className="font-medium hover:underline" href={`/people/${w.child.id}`}>
                          {w.child.firstName} {w.child.lastName}
                        </Link>
                        <span className="text-ink-3">{w.g.relationship}</span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ) : null}
          </div>

          <div className="space-y-5">
            {staff ? (
              <Card>
                <CardHeader title="Tasks" kicker="Follow-ups" />
                <CardBody>
                  {d.tasks.length === 0 ? <p className="text-sm text-ink-3">No open tasks.</p> : null}
                  <ul className="space-y-2">
                    {d.tasks.map(({ t, assignee }) => (
                      <li key={t.id} className="rounded-lg border border-edge p-3 text-sm">
                        <div className="font-medium">{t.title}</div>
                        <div className="text-xs text-ink-3">
                          {assignee ?? "Unassigned"} · due {t.dueAt ? fmt(t.dueAt, "MMM d") : "—"} {t.priority === "high" ? <Badge variant="red">high</Badge> : null}
                        </div>
                        <form action={setTaskStatusAction} className="mt-2">
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="status" value="done" />
                          <input type="hidden" name="personId" value={personId} />
                          <button className="min-h-9 text-xs font-medium text-brand underline" type="submit">
                            Mark done
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                  <details className="mt-3">
                    <summary className="min-h-10 cursor-pointer text-sm font-medium text-brand">New task</summary>
                    <ActionForm action={createTaskAction} className="mt-2 space-y-2" resetOnSuccess>
                      <input type="hidden" name="relatedPersonId" value={personId} />
                      <Field label="Title" htmlFor="t-title">
                        <Input id="t-title" name="title" required />
                      </Field>
                      <Field label="Due" htmlFor="t-due">
                        <Input id="t-due" name="dueAt" type="datetime-local" />
                      </Field>
                      <Field label="Assign to" htmlFor="t-assignee">
                        <Select id="t-assignee" name="assigneeUserId" defaultValue={v.userId}>
                          {staffUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Priority" htmlFor="t-priority">
                        <Select id="t-priority" name="priority" defaultValue="normal">
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                        </Select>
                      </Field>
                      <SubmitButton size="sm">Create task</SubmitButton>
                    </ActionForm>
                  </details>
                </CardBody>
              </Card>
            ) : null}

            {manage ? (
              <Card>
                <CardHeader title="Tags & alerts" />
                <CardBody className="space-y-4">
                  <ActionForm action={tagAction} className="flex gap-2">
                    <input type="hidden" name="personId" value={personId} />
                    <label className="sr-only" htmlFor="tag-name">
                      Tag
                    </label>
                    <Input id="tag-name" name="tag" placeholder="Add tag" required />
                    <SubmitButton size="sm" variant="secondary">
                      Add
                    </SubmitButton>
                  </ActionForm>
                  {d.tags.length ? (
                    <div className="flex flex-wrap gap-2">
                      {d.tags.map((t) => (
                        <ActionForm key={t.id} action={tagAction}>
                          <input type="hidden" name="personId" value={personId} />
                          <input type="hidden" name="tag" value={t.name} />
                          <input type="hidden" name="op" value="remove" />
                          <button type="submit" className="min-h-9 rounded-full border border-edge px-3 text-xs" aria-label={`Remove tag ${t.name}`}>
                            #{t.name} ✕
                          </button>
                        </ActionForm>
                      ))}
                    </div>
                  ) : null}
                  <ActionForm action={createAlertAction} className="space-y-2 border-t border-edge pt-3" resetOnSuccess>
                    <input type="hidden" name="personId" value={personId} />
                    <Field label="New check-in alert" htmlFor="al-msg" hint="Kiosk alerts show only this text — keep it non-sensitive.">
                      <Input id="al-msg" name="message" required maxLength={200} />
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="sr-only" htmlFor="al-level">
                        Level
                      </label>
                      <Select id="al-level" name="level" defaultValue="info" className="w-32">
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="critical">Critical</option>
                      </Select>
                      <label className="flex min-h-10 items-center gap-2 text-sm">
                        <input type="checkbox" name="showAtKiosk" /> Show at kiosk
                      </label>
                    </div>
                    <SubmitButton size="sm" variant="secondary">
                      Add alert
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            ) : null}

            {d.login ? (
              <Card>
                <CardHeader title="Login" />
                <CardBody className="text-sm">
                  <div>{d.login.email}</div>
                  <div className="text-ink-3">
                    {ROLE_LABEL[d.login.role]} · last sign-in {d.login.lastLoginAt ? fmt(d.login.lastLoginAt) : "never"} · MFA {d.login.mfaEnabled ? "on" : "off"}
                  </div>
                  <Link href="/settings/users" className="mt-2 inline-block text-brand underline">
                    Manage in Settings → Users
                  </Link>
                </CardBody>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "timeline" && athlete ? <TimelineTab athleteId={athlete.id} kind={sp.kind} personId={personId} /> : null}

      {tab === "family" ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {athlete ? (
            <Card>
              <CardHeader title="Guardians" kicker="Each guardian's access is independent" />
              <CardBody>
                {d.guardians.length === 0 ? <p className="text-sm text-ink-3">No guardians linked{ageFrom(person.dateOfBirth) != null && ageFrom(person.dateOfBirth)! >= 18 ? " (adult athlete)." : "."}</p> : null}
                <ul className="space-y-3">
                  {d.guardians.map((g) => (
                    <li key={g.id} className="rounded-lg border border-edge p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/people/${g.guardian.id}`} className="font-medium hover:underline">
                          {g.guardian.firstName} {g.guardian.lastName}
                        </Link>
                        <span className="text-xs text-ink-3">{g.relationship}</span>
                      </div>
                      {g.guardian.email ? <div className="text-xs text-ink-3">{g.guardian.email}</div> : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Badge variant={g.canViewTraining ? "green" : "neutral"}>{g.canViewTraining ? "training ✓" : "no training"}</Badge>
                        <Badge variant={g.canViewHealth ? "green" : "neutral"}>{g.canViewHealth ? "health ✓" : "no health"}</Badge>
                        <Badge variant={g.canBook ? "green" : "neutral"}>{g.canBook ? "booking ✓" : "no booking"}</Badge>
                        <Badge variant={g.canSignForms ? "green" : "neutral"}>{g.canSignForms ? "forms ✓" : "no forms"}</Badge>
                        <Badge variant={g.canMessageStaff ? "green" : "neutral"}>{g.canMessageStaff ? "messaging ✓" : "no messaging"}</Badge>
                        {g.isEmergencyContact ? <Badge variant="blue">emergency contact</Badge> : null}
                      </div>
                      {canGuardians ? (
                        <div className="mt-2">
                          <GuardianEditor
                            guardianshipId={g.id}
                            personId={personId}
                            flags={{
                              relationship: g.relationship,
                              canViewTraining: g.canViewTraining,
                              canViewHealth: g.canViewHealth,
                              canBook: g.canBook,
                              canSignForms: g.canSignForms,
                              canMessageStaff: g.canMessageStaff,
                              isEmergencyContact: g.isEmergencyContact,
                            }}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {canGuardians ? (
                  <details className="mt-4">
                    <summary className="min-h-10 cursor-pointer text-sm font-medium text-brand">Add another guardian</summary>
                    <div className="mt-3">
                      <AddGuardianForm athleteId={athlete.id} personId={personId} candidates={await guardianCandidates(v.orgId, personId)} />
                    </div>
                  </details>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Households" kicker="Where someone lives — not who can see what" />
            <CardBody>
              {d.households.length === 0 ? <EmptyState title="Not in a household" /> : null}
              <ul className="space-y-3">
                {d.households.map((h) => (
                  <li key={h.id} className="rounded-lg border border-edge p-3 text-sm">
                    <div className="font-medium">{h.name}</div>
                    <ul className="mt-1 text-ink-2">
                      {h.members.map((m) => (
                        <li key={m.person.id}>
                          <Link className="hover:underline" href={`/people/${m.person.id}`}>
                            {m.person.firstName} {m.person.lastName}
                          </Link>{" "}
                          <span className="text-xs text-ink-3">({m.role})</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Payer accounts" kicker="Who pays — separate from guardianship" />
            <CardBody>
              {d.payers.length === 0 ? <p className="text-sm text-ink-3">No payer accounts visible to you.</p> : null}
              <ul className="space-y-2 text-sm">
                {d.payers.map(({ payer, auth }) => (
                  <li key={payer.id} className="rounded-lg border border-edge p-3">
                    <div className="font-medium">{payer.name}</div>
                    {auth ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant={auth.canViewInvoices ? "green" : "neutral"}>view invoices</Badge>
                        <Badge variant={auth.canPay ? "green" : "neutral"}>{auth.canPay ? "can pay" : "cannot pay"}</Badge>
                        <Badge variant={auth.canManageMethods ? "green" : "neutral"}>payment methods</Badge>
                      </div>
                    ) : (
                      <div className="text-xs text-ink-3">Pays for this athlete</div>
                    )}
                    {can(v, "billing.view_all") ? (
                      <Link href={`/billing?payer=${payer.id}`} className="mt-1 inline-block text-xs text-brand underline">
                        Open billing
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {tab === "notes" && staff ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Notes" kicker="Visibility-controlled" />
            <CardBody>
              {d.notes.length === 0 ? <p className="text-sm text-ink-3">No notes you can see.</p> : null}
              <ul className="space-y-3">
                {d.notes.map((n) => (
                  <li key={n.id} className="rounded-lg border border-edge p-3 text-sm">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                      {n.authorName ?? "Unknown"} · {fmt(n.createdAt)} · <Badge variant={n.visibility === "sensitive" || n.visibility === "owner_only" ? "red" : "neutral"}>{n.visibility.replace("_", " ")}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Add note" />
            <CardBody>
              <ActionForm action={addNoteAction} className="space-y-3" resetOnSuccess>
                <input type="hidden" name="personId" value={personId} />
                <Field label="Note" htmlFor="n-body">
                  <Textarea id="n-body" name="body" required rows={5} />
                </Field>
                <Field label="Who can see it" htmlFor="n-vis">
                  <Select id="n-vis" name="visibility" defaultValue="staff">
                    <option value="staff">All staff</option>
                    <option value="coaches_assigned">Admins, operations & assigned coaches</option>
                    {["owner", "admin"].includes(v.role) ? <option value="sensitive">Sensitive (owner & admins only)</option> : null}
                    {v.role === "owner" ? <option value="owner_only">Owner only</option> : null}
                  </Select>
                </Field>
                <Field label="Category" htmlFor="n-cat">
                  <Input id="n-cat" name="category" defaultValue="general" />
                </Field>
                <SubmitButton size="sm">Save note</SubmitButton>
              </ActionForm>
              <p className="mt-3 text-xs text-ink-3">Notes are never visible to families.</p>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}

async function guardianCandidates(orgId: string, excludePersonId: string) {
  const rows = await db
    .select({ id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email })
    .from(people)
    .where(and(eq(people.orgId, orgId), sql`${people.id} <> ${excludePersonId}`, sql`not exists (select 1 from athletes a where a.person_id = ${people.id} and a.active)`))
    .orderBy(asc(people.lastName))
    .limit(500);
  return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}${r.email ? ` — ${r.email}` : ""}` }));
}

async function TimelineTab({ athleteId, kind, personId }: { athleteId: string; kind?: string; personId: string }) {
  const v = await requireViewer();
  const events = await athleteTimeline(db, v, athleteId, { kinds: kind ? [kind] : undefined });
  return (
    <Card>
      <CardHeader title="Unified timeline" kicker="Everything you're allowed to see, newest first" />
      <CardBody>
        <nav aria-label="Filter timeline" className="mb-4 flex flex-wrap gap-2">
          <Link href={`/people/${personId}?tab=timeline`} className={`min-h-9 rounded-full border px-3 py-1.5 text-xs ${!kind ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}>
            All
          </Link>
          {TIMELINE_KINDS.map((k) => (
            <Link key={k} href={`/people/${personId}?tab=timeline&kind=${k}`} className={`min-h-9 rounded-full border px-3 py-1.5 text-xs ${kind === k ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}>
              {k}
            </Link>
          ))}
        </nav>
        {events.length === 0 ? (
          <EmptyState title="Nothing here yet">Bookings, forms, payments, workouts, tests, and check-ins appear here as they happen (subject to your permissions).</EmptyState>
        ) : (
          <ol className="relative space-y-3 border-l border-edge pl-5">
            {events.map((e, i) => (
              <li key={i} className="relative">
                <span aria-hidden className="absolute -left-[26px] top-1.5 size-2.5 rounded-full bg-brand" />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="kicker">{e.kind}</span>
                  {e.href ? (
                    <Link href={e.href} className="font-medium hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{e.title}</span>
                  )}
                  {e.status ? <StatusBadge status={e.status} /> : null}
                </div>
                <div className="text-xs text-ink-3">
                  {fmt(e.at)}
                  {e.detail ? ` · ${e.detail}` : ""}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
