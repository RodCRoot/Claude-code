import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { stepUpSettingsOf } from "@/lib/forms/step-up";
import { emailConfig } from "@/lib/messaging/channels/email";
import { requireViewer } from "@/lib/auth/viewer";
import { accessibleAthleteIds, can, coachAthleteIds, isStaff, type Viewer } from "@/lib/authz/policy";
import { missingForms } from "@/lib/forms/status";
import { athleteOptions, listRequests, listTemplates } from "@/lib/forms/queries";
import { listArchive } from "@/lib/forms/archive";
import { IDENTITY_NOTICE, PILOT_NOTICE } from "@/lib/forms/consent";
import { isAdultAt } from "@/lib/forms/context";
import { TEMPLATE_KINDS } from "@/lib/forms/templates";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
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
  NotConfigured,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Td,
  Th,
} from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { createTemplateAction, issueAction, remindOverdueAction, renewalsAction, stepUpSettingsAction } from "./actions";
import { SampleBadge } from "./_components/markdown";

export const metadata = { title: "Documents" };

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DocumentsPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const sp = await searchParams;
  return isStaff(v) ? <StaffDocuments v={v} sp={sp} /> : <FamilyDocuments v={v} sp={sp} />;
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

async function StaffDocuments({ v, sp }: { v: Viewer; sp: Awaited<SP> }) {
  const manage = can(v, "forms.manage");
  const tabs = manage
    ? [
        { key: "requests", label: "Requests", href: "/documents?tab=requests" },
        { key: "missing", label: "Missing forms", href: "/documents?tab=missing" },
        { key: "templates", label: "Templates", href: "/documents?tab=templates" },
        { key: "archive", label: "Archive", href: "/documents/archive" },
      ]
    : [
        { key: "missing", label: "Missing forms", href: "/documents?tab=missing" },
        { key: "requests", label: "Form status", href: "/documents?tab=requests" },
      ];
  const tab = tabs.some((t) => t.key === one(sp.tab)) ? one(sp.tab)! : manage ? "requests" : "missing";
  // Coaches: assigned athletes only, status only.
  const scope: string[] | "all" = manage ? "all" : await coachAthleteIds(db, v);

  return (
    <>
      <PageHeader
        kicker="Documents"
        title="Forms & signatures"
        description="Waivers, agreements, and intake forms: issue requests, track who still needs to sign, and keep a verifiable record of exactly what was signed."
        actions={manage ? <ButtonLink href="/documents?tab=templates#new-template" variant="outline">New template</ButtonLink> : null}
      />
      {!manage ? (
        <Callout className="mb-5" title="Coach view">
          You can see form status for your assigned athletes. Submitted answers and signed PDFs stay with front-desk staff and families because they can contain health information.
        </Callout>
      ) : null}
      <Tabs tabs={tabs} current={tab} />
      {tab === "requests" ? <RequestsTab v={v} scope={scope} manage={manage} status={one(sp.status)} /> : null}
      {tab === "missing" ? <MissingTab v={v} scope={scope} manage={manage} /> : null}
      {tab === "templates" && manage ? <TemplatesTab v={v} /> : null}
    </>
  );
}

const STATUS_FILTERS = [
  { key: "open", label: "Open", statuses: ["pending", "partially_signed"] },
  { key: "completed", label: "Completed", statuses: ["completed"] },
  { key: "closed", label: "Expired / superseded / voided", statuses: ["expired", "superseded", "voided"] },
  { key: "all", label: "All", statuses: [] as string[] },
];

async function RequestsTab({ v, scope, manage, status }: { v: Viewer; scope: string[] | "all"; manage: boolean; status?: string }) {
  const filter = STATUS_FILTERS.find((f) => f.key === status) ?? STATUS_FILTERS[0];
  const [rows, all] = await Promise.all([
    listRequests(db, v.orgId, { athleteIds: scope, statuses: filter.statuses }),
    listRequests(db, v.orgId, { athleteIds: scope, statuses: ["pending", "partially_signed"] }),
  ]);
  const today = todayLocal();
  const overdue = all.filter((r) => r.dueDate && r.dueDate < today).length;
  const partial = all.filter((r) => r.status === "partially_signed").length;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Open requests" value={all.length} />
        <Stat label="Overdue" value={overdue} tone={overdue ? "bad" : undefined} />
        <Stat label="Waiting on 2nd signer" value={partial} tone={partial ? "warn" : undefined} />
        <Stat label="Showing" value={rows.length} hint={filter.label} />
      </div>
      {manage ? (
        <Card>
          <CardBody className="flex flex-wrap items-start gap-4 pt-4">
            <ActionForm action={remindOverdueAction}>
              <SubmitButton variant="outline" pendingText="Queuing…">
                Remind all overdue
              </SubmitButton>
            </ActionForm>
            <ActionForm action={renewalsAction}>
              <SubmitButton variant="outline" pendingText="Checking…">
                Run renewal check
              </SubmitButton>
            </ActionForm>
            <p className="max-w-md text-xs text-ink-3">
              Reminders are queued as <code>forms.reminder</code> jobs for the messaging service (at most one per request per day). The renewal check expires forms past their renewal period and issues new requests.
            </p>
          </CardBody>
        </Card>
      ) : null}
      <nav aria-label="Filter requests" className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/documents?tab=requests&status=${f.key}`}
            aria-current={f.key === filter.key ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${f.key === filter.key ? "border-brand bg-brand/10 text-brand" : "border-edge text-ink-3 hover:text-ink"}`}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title="No requests here">{manage ? "Issue requests from a template’s page." : "None of your assigned athletes have requests in this state."}</EmptyState>
      ) : (
        <Card>
          <Table caption="Form requests">
            <thead>
              <tr>
                <Th>Athlete</Th>
                <Th>Form</Th>
                <Th>Status</Th>
                <Th>Due</Th>
                <Th>Completed</Th>
                {manage ? <Th align="right">Open</Th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.subjectName}</Td>
                  <Td>
                    {r.templateName} <span className="text-xs text-ink-3">v{r.version}</span>
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                    {r.dueDate && r.dueDate < today && (r.status === "pending" || r.status === "partially_signed") ? (
                      <Badge variant="red" className="ml-1">
                        overdue
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{fmtDate(r.dueDate)}</Td>
                  <Td>{r.completedAt ? fmtDate(r.completedAt) : "—"}</Td>
                  {manage ? (
                    <Td align="right">
                      <Link className="text-sm font-medium text-brand underline-offset-2 hover:underline" href={`/documents/requests/${r.id}`}>
                        View<span className="sr-only"> {r.templateName} for {r.subjectName}</span>
                      </Link>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, { label: string; variant: "red" | "yellow" | "neutral" }> = {
  missing: { label: "missing", variant: "red" },
  expired: { label: "expired", variant: "red" },
  pending: { label: "pending", variant: "yellow" },
  partially_signed: { label: "partially signed", variant: "yellow" },
};

async function MissingTab({ v, scope, manage }: { v: Viewer; scope: string[] | "all"; manage: boolean }) {
  const [rows, templates] = await Promise.all([
    missingForms(db, v.orgId, scope === "all" ? {} : { athleteIds: scope }),
    manage ? listTemplates(db, v.orgId) : Promise.resolve([]),
  ]);
  const required = templates.filter((t) => t.active && t.requiredForBooking && t.current);
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-3">
        Required forms are active templates marked <strong>required for booking</strong>. An athlete appears here when a required form is missing, still waiting for signatures, or expired.
      </p>
      {manage && required.length ? (
        <Card>
          <CardHeader title="Issue to everyone missing a form" />
          <CardBody>
            <ActionForm action={issueAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="target" value="missing" />
              <Field label="Form" htmlFor="mf-template">
                <Select id="mf-template" name="templateId" required>
                  {required.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.current!.version})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due date (optional)" htmlFor="mf-due">
                <Input id="mf-due" type="date" name="dueDate" />
              </Field>
              <SubmitButton pendingText="Issuing…">Issue requests</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="Everyone is up to date">No active athlete{scope === "all" ? "" : " assigned to you"} is missing a required form.</EmptyState>
      ) : (
        <Card>
          <Table caption="Athletes missing required forms">
            <thead>
              <tr>
                <Th>Athlete</Th>
                <Th>Needs attention</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.athleteId}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td>
                    <ul className="flex flex-wrap gap-2">
                      {r.items.map((i) => {
                        const s = STATE_LABEL[i.state];
                        const label = (
                          <>
                            {i.templateName}: <Badge variant={s.variant}>{s.label}</Badge>
                            {i.dueDate ? <span className="text-xs text-ink-3"> due {fmtDate(i.dueDate)}</span> : null}
                          </>
                        );
                        return (
                          <li key={i.templateId} className="text-sm">
                            {manage && i.requestId ? (
                              <Link href={`/documents/requests/${i.requestId}`} className="hover:underline">
                                {label}
                              </Link>
                            ) : (
                              label
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

async function StepUpSettingsCard({ v }: { v: Viewer }) {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId));
  const s = stepUpSettingsOf(org?.settings);
  const editable = can(v, "settings.manage");
  const email = emailConfig();
  return (
    <Card id="identity-verification">
      <CardHeader title="Signer identity verification" kicker="Step-up before signing" />
      <CardBody className="space-y-3">
        <p className="text-sm text-ink-3">
          For the form kinds checked below, a signature is accepted only after the signer enters a one-time code emailed to the address on file (6 digits, 10 minutes, 5 attempts),
          or completed MFA this session if allowed. Staff can instead verify identity in person and record the signature as witness (<code>staff_witnessed_in_person</code>). The method is
          stored with each signature and printed on the PDF.
        </p>
        {!email.configured ? (
          <NotConfigured provider="Email delivery" envVars={email.missing}>
            Verification codes cannot be emailed, so families cannot self-sign forms that require identity verification. Nothing is skipped: staff must verify identity in person and record those signatures.
          </NotConfigured>
        ) : null}
        <ActionForm action={stepUpSettingsAction} className="space-y-3">
          <fieldset disabled={!editable} className="space-y-3">
            <legend className="text-sm font-medium">Require identity verification for</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {TEMPLATE_KINDS.map((k) => (
                <label key={k} className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" name="requireForKinds" value={k} defaultChecked={(s.requireForKinds as string[]).includes(k)} className="size-4" />
                  {k.replace("_", " ")}
                </label>
              ))}
            </div>
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="allowSessionMfa" defaultChecked={s.allowSessionMfa} className="size-4" />
              Accept a session that completed multi-factor sign-in (users with MFA enabled) instead of an emailed code
            </label>
          </fieldset>
          {editable ? <SubmitButton pendingText="Saving…">Save verification settings</SubmitButton> : <p className="text-xs text-ink-3">Only owners and admins can change this.</p>}
        </ActionForm>
      </CardBody>
    </Card>
  );
}

async function TemplatesTab({ v }: { v: Viewer }) {
  const templates = await listTemplates(db, v.orgId);
  return (
    <div className="space-y-5">
      <StepUpSettingsCard v={v} />
      {templates.length === 0 ? (
        <EmptyState title="No templates yet">Create the first form template below.</EmptyState>
      ) : (
        <Card>
          <Table caption="Form templates">
            <thead>
              <tr>
                <Th>Template</Th>
                <Th>Current version</Th>
                <Th>Renewal</Th>
                <Th>Open / completed</Th>
                <Th align="right">Manage</Th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <div className="font-medium">{t.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <Badge>{t.kind.replace("_", " ")}</Badge>
                      {t.requiredForBooking ? <Badge variant="blue">required for booking</Badge> : null}
                      {!t.active ? <Badge variant="red">inactive</Badge> : null}
                    </div>
                  </Td>
                  <Td>
                    {t.current ? (
                      <span className="flex flex-wrap items-center gap-1">
                        v{t.current.version} <SampleBadge isSample={t.current.isSampleText} />
                      </span>
                    ) : (
                      <Badge variant="yellow">not published</Badge>
                    )}
                    {t.draft ? <div className="text-xs text-ink-3">Draft v{t.draft.version} in progress</div> : null}
                  </Td>
                  <Td>{t.renewalMonths ? `${t.renewalMonths} months` : "Never"}</Td>
                  <Td className="tabular">
                    {t.open} / {t.completed}
                  </Td>
                  <Td align="right">
                    <Link className="font-medium text-brand hover:underline" href={`/documents/templates/${t.id}`}>
                      Open<span className="sr-only"> {t.name}</span>
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card id="new-template">
        <CardHeader title="New template" kicker="Create" />
        <CardBody>
          <p className="mb-3 text-sm text-ink-3">New templates start with a draft v1 containing SAMPLE text. Write the form, then publish it.</p>
          <ActionForm action={createTemplateAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="nt-name" required>
              <Input id="nt-name" name="name" required minLength={2} maxLength={120} />
            </Field>
            <Field label="Kind" htmlFor="nt-kind">
              <Select id="nt-kind" name="kind" defaultValue="waiver">
                {TEMPLATE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Renewal period (months)" htmlFor="nt-renew" hint="Leave blank if the form never expires.">
              <Input id="nt-renew" name="renewalMonths" type="number" min={1} max={120} />
            </Field>
            <div className="flex items-end">
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input type="checkbox" name="requiredForBooking" className="size-4" /> Required for booking
              </label>
            </div>
            <div className="sm:col-span-2">
              <SubmitButton pendingText="Creating…">Create template</SubmitButton>
            </div>
          </ActionForm>
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Families & athletes
// ---------------------------------------------------------------------------

async function FamilyDocuments({ v, sp }: { v: Viewer; sp: Awaited<SP> }) {
  const ids = await accessibleAthleteIds(db, v, "profile.read");
  const athleteIds = ids === "all" ? [] : ids;
  const kids = await athleteOptions(db, v.orgId, athleteIds);
  const selected = kids.find((k) => k.id === one(sp.athlete)) ?? kids[0];
  const signable = new Set(((await accessibleAthleteIds(db, v, "forms.sign")) as string[]) ?? []);

  return (
    <>
      <PageHeader kicker="Documents" title="Forms" description="Review and sign forms for your family, and download copies of everything you’ve signed." />
      <Callout className="mb-5" title="About electronic signing">
        {PILOT_NOTICE}
        <span className="mt-2 block">{IDENTITY_NOTICE}</span>
      </Callout>
      {kids.length === 0 ? (
        <EmptyState title="No athletes linked to your account">If you expected to see your child here, contact Teamwork staff to link your account.</EmptyState>
      ) : (
        <>
          {kids.length > 1 ? (
            <nav aria-label="Choose athlete" className="mb-5 flex flex-wrap gap-2">
              {kids.map((k) => (
                <Link
                  key={k.id}
                  href={`/documents?athlete=${k.id}`}
                  aria-current={k.id === selected.id ? "page" : undefined}
                  className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium ${k.id === selected.id ? "border-brand bg-brand text-brand-ink" : "border-edge hover:bg-surface-2"}`}
                >
                  {k.name}
                </Link>
              ))}
            </nav>
          ) : null}
          <AthleteForms v={v} athlete={selected} canSign={signable.has(selected.id) && (v.personId !== selected.personId || isAdultAt(selected.dob, new Date()))} />
        </>
      )}
    </>
  );
}

async function AthleteForms({ v, athlete, canSign }: { v: Viewer; athlete: { id: string; personId: string; name: string }; canSign: boolean }) {
  const rows = await listRequests(db, v.orgId, { athleteIds: [athlete.id] });
  const open = rows.filter((r) => r.status === "pending" || r.status === "partially_signed");
  const done = rows.filter((r) => r.status === "completed");
  const history = rows.filter((r) => ["expired", "superseded", "voided"].includes(r.status));
  const archive = (await listArchive(db, v.orgId, { personIds: [athlete.personId] })).filter((a) => a.obj.accessLevel === "subject_and_guardians");
  const today = todayLocal();
  const self = v.personId === athlete.personId;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title={`To sign for ${athlete.name}`} kicker={`${open.length} open`} />
        <CardBody>
          {!canSign && open.length ? (
            <Callout tone="warn" className="mb-3">
              {self
                ? "Athletes under 18 can’t sign for themselves — a parent or guardian signs. Once they have, you may be asked to add your assent."
                : `Your account can view ${athlete.name}’s forms but doesn’t have permission to sign them. Ask the primary guardian or Teamwork staff.`}
            </Callout>
          ) : null}
          {open.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing to sign right now.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {open.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {r.title} <span className="text-xs text-ink-3">v{r.version}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                      <StatusBadge status={r.status} />
                      {r.isSampleText ? <SampleBadge isSample /> : null}
                      {r.dueDate ? <span className={r.dueDate < today ? "font-semibold text-bad" : ""}>Due {fmtDate(r.dueDate)}</span> : null}
                    </div>
                  </div>
                  <ButtonLink href={`/documents/requests/${r.id}`} variant={canSign ? "primary" : "outline"} size="md">
                    {canSign ? (r.status === "partially_signed" ? "Review & add signature" : "Review & sign") : "View"}
                    <span className="sr-only"> {r.title}</span>
                  </ButtonLink>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Completed forms" kicker={`${done.length} on file`} />
        <CardBody>
          {done.length === 0 ? (
            <p className="text-sm text-ink-3">No completed forms yet.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {done.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {r.title} <span className="text-xs text-ink-3">v{r.version}</span>
                    </div>
                    <div className="text-xs text-ink-3">
                      Completed {fmt(r.completedAt)}
                      {r.expiresAt ? ` · renew by ${fmtDate(r.expiresAt)}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink href={`/documents/requests/${r.id}`} variant="ghost" size="sm">
                      Details<span className="sr-only"> for {r.title}</span>
                    </ButtonLink>
                    {r.pdfObjectId ? (
                      <a className="inline-flex h-8 items-center rounded-lg border border-edge px-3 text-xs font-medium hover:bg-surface-2" href={`/api/files/${r.pdfObjectId}`}>
                        Download PDF<span className="sr-only"> of {r.title}</span>
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {archive.length ? (
        <Card>
          <CardHeader title="Imported archive — original evidence only" kicker="Historical documents" />
          <CardBody>
            <p className="mb-2 text-xs text-ink-3">Documents signed before Teamwork Hub, stored exactly as received. They were not re-signed here.</p>
            <ul className="divide-y divide-edge">
              {archive.map((a) => (
                <li key={a.doc.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {a.doc.title} <span className="text-xs text-ink-3">· {a.doc.originalSystem} · signed {fmtDate(a.doc.originalSignedAt)}</span>
                  </span>
                  <a className="text-xs font-medium text-brand hover:underline" href={`/api/files/${a.obj.id}`}>
                    Download<span className="sr-only"> {a.doc.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {history.length ? (
        <details className="rounded-xl border border-edge bg-surface px-5 py-3">
          <summary className="cursor-pointer text-sm font-medium">Older requests ({history.length})</summary>
          <ul className="mt-2 divide-y divide-edge text-sm">
            {history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {r.title} v{r.version}
                </span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {self ? null : <p className="text-xs text-ink-3">You see forms for athletes linked to your account. Each guardian signs independently.</p>}
    </div>
  );
}
