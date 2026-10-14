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
import { CommunicationCard } from "../../messages/_components/staff-consent";
import { CustomFieldsCard } from "./custom-fields-card";
import { customFieldsForView } from "@/lib/people/custom-fields";
import { attendanceHistory } from "@/lib/scheduling";
import { AttendanceHistoryPanel } from "@/lib/scheduling/components/attendance-history";
import { listMemberships } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { ProfileHeader } from "@/components/profile/profile-header";
import { InfoList, InfoSection, MemberAvatar } from "@/components/profile/studio";

export const metadata = { title: "Person" };

const TIMELINE_KINDS = ["booking", "form", "membership", "invoice", "workout", "max", "test", "wellness", "body", "message"];
const LIVE_MEMBERSHIP = ["active", "trialing", "pending", "past_due", "on_hold"];

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
  const staff = isStaff(v);
  const manage = can(v, "people.manage");
  const canGuardians = d.caps.includes("guardians.manage");
  const name = `${person.preferredName ?? person.firstName} ${person.lastName}`;
  const age = ageFrom(person.dateOfBirth);

  const tabs = [
    { key: "overview", href: `/people/${personId}`, label: "Overview" },
    ...(athlete ? [{ key: "attendance", href: `/people/${personId}?tab=attendance`, label: "Attendance" }] : []),
    { key: "family", href: `/people/${personId}?tab=family`, label: "Family & billing" },
    ...(athlete ? [{ key: "timeline", href: `/people/${personId}?tab=timeline`, label: "Timeline" }] : []),
    ...(staff ? [{ key: "notes", href: `/people/${personId}?tab=notes`, label: `Notes (${d.notes.length})` }] : []),
  ];
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : "overview";

  const staffUsers = staff
    ? await db.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]))).orderBy(asc(users.displayName))
    : [];
  // Same query and checks the overview tab always used (attendanceHistory enforces profile.read).
  const attendance = athlete ? await attendanceHistory(db, v, athlete.id) : null;
  const lastVisit = attendance?.history.find((h) => h.status === "attended")?.startsAt ?? null;
  // Membership summary only for staff who can already see every membership (/billing/memberships).
  const memberships = athlete && can(v, "billing.view_all") ? (await listMemberships(db, v)).filter((r) => r.m.athleteId === athlete.id) : null;
  const currentMembership = memberships ? (memberships.find((r) => LIVE_MEMBERSHIP.includes(r.m.status)) ?? memberships[0] ?? null) : null;

  const actions = (
    <>
      {athlete && d.caps.includes("booking.create") ? (
        <ButtonLink href={`/schedule?athlete=${athlete.id}`} size="sm">
          Book
        </ButtonLink>
      ) : null}
      {athlete && can(v, "billing.manage") ? (
        <ButtonLink href="/billing/pos" variant="secondary" size="sm">
          Sell
        </ButtonLink>
      ) : null}
      {athlete && d.caps.includes("messages.send") ? (
        <ButtonLink href={`/messages?athlete=${athlete.id}`} variant="secondary" size="sm">
          Message
        </ButtonLink>
      ) : null}
      {athlete && d.caps.includes("training.read") ? (
        <ButtonLink href={`/performance/${athlete.id}`} variant="secondary" size="sm">
          Performance
        </ButtonLink>
      ) : null}
      {athlete && can(v, "billing.view_all") ? (
        <ButtonLink href={`/people/${personId}/membership-status`} variant="secondary" size="sm">
          Membership status
        </ButtonLink>
      ) : null}
      {manage ? (
        <ButtonLink href={`/people/${personId}#edit-contact`} variant="secondary" size="sm">
          Edit
        </ButtonLink>
      ) : null}
    </>
  );

  return (
    <>
      <ProfileHeader
        name={name}
        kicker={athlete ? "Athlete" : d.wards.length ? "Guardian" : "Person"}
        subtitle={
          [
            age != null ? `Age ${age}` : null,
            athlete?.position ?? null,
            athlete?.school ?? null,
            athlete?.gradYear ? `Class of ${athlete.gradYear}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || null
        }
        badges={
          <>
            <StatusBadge status={athlete && !athlete.active ? "inactive" : person.status} />
            {currentMembership && currentMembership.m.status !== "active" ? <StatusBadge status={currentMembership.m.status} /> : null}
            {person.isDemo ? <DemoBadge /> : null}
            {athlete?.sport ? <Badge>{athlete.sport}</Badge> : null}
            {athlete?.level ? <Badge variant="brand">{athlete.level}</Badge> : null}
            {d.groups.map((g) => (
              <Badge key={g.id} variant="blue">
                {g.name}
              </Badge>
            ))}
          </>
        }
        actions={actions}
        stats={
          athlete && attendance
            ? [
                ...(memberships
                  ? [
                      {
                        label: "Membership",
                        value: currentMembership ? currentMembership.productName : "None",
                        hint: currentMembership ? (
                          <>
                            {formatMoney(currentMembership.priceMinor, currentMembership.currency)}/{currentMembership.interval}
                            {currentMembership.m.billingProvider !== "external_zenplanner" && currentMembership.m.nextBillDate ? ` · next bill ${fmtDate(currentMembership.m.nextBillDate)}` : ""}
                          </>
                        ) : undefined,
                        tone: currentMembership?.m.status === "past_due" ? ("bad" as const) : currentMembership?.m.status === "on_hold" ? ("warn" as const) : undefined,
                      },
                    ]
                  : [{ label: "Upcoming", value: attendance.counts.upcoming, hint: "booked sessions" }]),
                { label: "Last visit", value: lastVisit ? fmt(lastVisit, "MMM d, yyyy") : "Never", hint: lastVisit ? fmt(lastVisit, "EEE h:mm a") : undefined },
                { label: "Visits", value: attendance.counts.attended, hint: attendance.nextMilestone ? `${attendance.nextMilestone - attendance.counts.attended} to ${attendance.nextMilestone}` : undefined, tone: attendance.counts.attended ? ("ok" as const) : undefined },
                {
                  label: "Attendance rate",
                  value: attendance.attendanceRate == null ? "—" : `${Math.round(attendance.attendanceRate * 100)}%`,
                  hint: attendance.counts.noShow ? `${attendance.counts.noShow} no-show${attendance.counts.noShow === 1 ? "" : "s"}` : "no no-shows",
                },
              ]
            : undefined
        }
      >
        {d.alerts.length ? (
          <div className="space-y-2 border-t border-edge px-4 py-3 sm:px-5">
            {d.alerts.map((a) => (
              <Callout key={a.id} tone={a.level === "critical" ? "bad" : a.level === "warning" ? "warn" : "info"} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong className="mr-1 uppercase text-[11px] tracking-wide">{a.level}</strong> {a.message} {a.showAtKiosk ? <Badge>shown at kiosk</Badge> : null}
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
      </ProfileHeader>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
        {/* Left: info card column */}
        <aside aria-label="Member details" className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
            <h2 className="border-b border-edge bg-th px-4 py-2 text-[13px] font-bold uppercase tracking-wide text-ink-2">Member info</h2>
            <InfoSection title="Contact">
              <InfoList
                items={[
                  ["Email", person.email ? <a href={`mailto:${person.email}`} className="text-brand hover:underline">{person.email}</a> : "—"],
                  ["Phone", person.phone ? <a href={`tel:${person.phone}`} className="tabular text-brand hover:underline">{person.phone}</a> : "—"],
                  ["Birthday", person.dateOfBirth ? `${fmtDate(person.dateOfBirth)}${age != null ? ` (${age})` : ""}` : "—"],
                ]}
              />
            </InfoSection>
            {athlete ? (
              <InfoSection title="Athlete">
                <InfoList
                  items={[
                    ["Sport", athlete.sport ?? "—"],
                    ["Position", athlete.position ?? "—"],
                    ["Level", athlete.level ?? "—"],
                    ["School", athlete.school ?? "—"],
                    ["Grad year", athlete.gradYear ?? "—"],
                    ["Coaches", d.coaches.length ? d.coaches.map((c) => c.name).join(", ") : "none assigned"],
                  ]}
                />
              </InfoSection>
            ) : null}
            {athlete ? (
              <InfoSection title="Family / guardians" action={<Link href={`/people/${personId}?tab=family`} className="text-xs font-semibold text-brand hover:underline">Manage<span className="sr-only"> family</span></Link>}>
                {d.guardians.length === 0 ? (
                  <p className="text-ink-3">No guardians linked{age != null && age >= 18 ? " (adult athlete)" : ""}.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {d.guardians.map((g) => (
                      <li key={g.id} className="flex items-center gap-2">
                        <MemberAvatar name={`${g.guardian.firstName} ${g.guardian.lastName}`} size="sm" />
                        <span className="min-w-0">
                          <Link href={`/people/${g.guardian.id}`} className="block truncate font-medium hover:underline">
                            {g.guardian.firstName} {g.guardian.lastName}
                          </Link>
                          <span className="block truncate text-xs text-ink-3">
                            {g.relationship}
                            {g.isEmergencyContact ? " · emergency contact" : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </InfoSection>
            ) : null}
            {d.wards.length ? (
              <InfoSection title="Guardian of">
                <ul className="space-y-1.5">
                  {d.wards.map((w) => (
                    <li key={w.g.id} className="flex items-center gap-2">
                      <MemberAvatar name={`${w.child.firstName} ${w.child.lastName}`} size="sm" />
                      <Link className="min-w-0 truncate font-medium hover:underline" href={`/people/${w.child.id}`}>
                        {w.child.firstName} {w.child.lastName}
                      </Link>
                      <span className="ml-auto shrink-0 text-xs text-ink-3">{w.g.relationship}</span>
                    </li>
                  ))}
                </ul>
              </InfoSection>
            ) : null}
            {d.payers.length ? (
              <InfoSection title="Payer">
                <ul className="space-y-1">
                  {d.payers.map(({ payer, auth }) => (
                    <li key={payer.id} className="flex flex-wrap items-center justify-between gap-1">
                      {can(v, "billing.view_all") ? (
                        <Link href={`/billing?payer=${payer.id}`} className="font-medium hover:underline">
                          {payer.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{payer.name}</span>
                      )}
                      {auth ? <Badge variant={auth.canPay ? "green" : "neutral"}>{auth.canPay ? "can pay" : "view only"}</Badge> : null}
                    </li>
                  ))}
                </ul>
              </InfoSection>
            ) : null}
            <InfoSection title="Tags">
              {d.tags.length === 0 && !manage ? <p className="text-ink-3">No tags.</p> : null}
              {d.tags.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {d.tags.map((t) => (
                    <li key={t.id}>
                      {manage ? (
                        <ActionForm action={tagAction}>
                          <input type="hidden" name="personId" value={personId} />
                          <input type="hidden" name="tag" value={t.name} />
                          <input type="hidden" name="op" value="remove" />
                          <button type="submit" className="min-h-8 rounded-full border border-edge bg-surface-2 px-2.5 text-xs font-medium hover:border-bad/50" aria-label={`Remove tag ${t.name}`}>
                            #{t.name} <span aria-hidden>✕</span>
                          </button>
                        </ActionForm>
                      ) : (
                        <Badge>#{t.name}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {manage ? (
                <ActionForm action={tagAction} className="mt-2 flex gap-2">
                  <input type="hidden" name="personId" value={personId} />
                  <label className="sr-only" htmlFor="tag-name">
                    Tag
                  </label>
                  <Input id="tag-name" name="tag" placeholder="Add tag" required className="h-9" />
                  <SubmitButton size="sm" variant="secondary">
                    Add
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </InfoSection>
            {manage ? (
              <InfoSection title="Check-in alerts">
                {d.alerts.length ? <p className="mb-1 text-xs text-ink-3">{d.alerts.length} active — shown above.</p> : <p className="mb-1 text-xs text-ink-3">No active alerts.</p>}
                <details>
                  <summary className="min-h-9 cursor-pointer py-1 text-sm font-medium text-brand">New alert</summary>
                  <ActionForm action={createAlertAction} className="mt-2 space-y-2" resetOnSuccess>
                    <input type="hidden" name="personId" value={personId} />
                    <Field label="Alert text" htmlFor="al-msg" hint="Kiosk alerts show only this text — keep it non-sensitive.">
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
                </details>
              </InfoSection>
            ) : null}
            {d.login ? (
              <InfoSection title="Login">
                <div className="break-words">{d.login.email}</div>
                <div className="text-xs text-ink-3">
                  {ROLE_LABEL[d.login.role]} · last sign-in {d.login.lastLoginAt ? fmt(d.login.lastLoginAt) : "never"} · MFA {d.login.mfaEnabled ? "on" : "off"}
                </div>
                <Link href="/settings/users" className="mt-1 inline-block text-xs text-brand underline">
                  Manage in Settings → Users
                </Link>
              </InfoSection>
            ) : null}
          </section>
        </aside>

        {/* Right: tabbed main area */}
        <div className="min-w-0">
          <Tabs tabs={tabs} current={tab} />

      {tab === "overview" ? (
        <div className="space-y-4">
          {staff ? (
            <Card>
              <CardHeader title="Follow-ups" kicker={`${d.tasks.length} open task${d.tasks.length === 1 ? "" : "s"}`} />
              <CardBody>
                {d.tasks.length === 0 ? <p className="text-sm text-ink-3">No open tasks.</p> : null}
                <ul className="divide-y divide-edge">
                  {d.tasks.map(({ t, assignee }) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="font-medium">
                          {t.title} {t.priority === "high" ? <Badge variant="red">high</Badge> : null}
                        </div>
                        <div className="text-xs text-ink-3">
                          {assignee ?? "Unassigned"} · due {t.dueAt ? fmt(t.dueAt, "MMM d") : "—"}
                        </div>
                      </div>
                      <form action={setTaskStatusAction}>
                        <input type="hidden" name="taskId" value={t.id} />
                        <input type="hidden" name="status" value="done" />
                        <input type="hidden" name="personId" value={personId} />
                        <button className="min-h-8 rounded-md border border-edge px-2.5 text-xs font-semibold hover:bg-surface-2" type="submit">
                          Mark done
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
                <details className="mt-2">
                  <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium text-brand">New task</summary>
                  <ActionForm action={createTaskAction} className="mt-2 grid gap-3 sm:grid-cols-2" resetOnSuccess>
                    <input type="hidden" name="relatedPersonId" value={personId} />
                    <Field label="Title" htmlFor="t-title" className="sm:col-span-2">
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
                    <div className="self-end">
                      <SubmitButton size="sm">Create task</SubmitButton>
                    </div>
                  </ActionForm>
                </details>
              </CardBody>
            </Card>
          ) : null}

          {manage ? (
            <Card id="edit-contact">
              <CardHeader title="Contact details" kicker="Edit" />
              <CardBody>
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
              </CardBody>
            </Card>
          ) : null}

          {athlete && d.caps.includes("profile.write") ? (
            <Card>
              <CardHeader title="Athlete profile" kicker="Training identity" />
              <CardBody>
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
              </CardBody>
            </Card>
          ) : null}

          <CustomFieldsCard personId={personId} items={await customFieldsForView(db, v, personId)} editable={manage} settingsLink={can(v, "settings.manage")} />

          {can(v, "crm.manage") ? <CommunicationCard v={v} personId={personId} /> : null}

          {attendance && attendance.history.length ? (
            <Card>
              <CardHeader title="Recent visits" action={<Link href={`/people/${personId}?tab=attendance`} className="text-xs font-semibold text-brand hover:underline">View all<span className="sr-only"> attendance</span> ›</Link>} />
              <ul className="divide-y divide-edge text-sm">
                {attendance.history.slice(0, 5).map((h) => (
                  <li key={h.bookingId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                    <span className="min-w-0">
                      <span className="font-medium">{h.title}</span>
                      <span className="block text-xs text-ink-3">
                        {fmt(h.startsAt, "EEE MMM d · h:mm a")}
                        {h.coachName ? ` · ${h.coachName}` : ""}
                      </span>
                    </span>
                    <StatusBadge status={h.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "attendance" && attendance ? <AttendanceHistoryPanel data={attendance} limit={50} /> : null}

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
        </div>
      </div>
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
