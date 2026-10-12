import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { formAuditEvents, users, type FormField } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { loadRequestContext } from "@/lib/forms/context";
import { requestAccess } from "@/lib/forms/access";
import { signingState, type SignOption } from "@/lib/forms/signing";
import { verifyRequest } from "@/lib/forms/verify";
import { describeAuthMethod } from "@/lib/forms/completion";
import { displayValue, SIGNER_ROLE_LABEL, type SignerRole } from "@/lib/forms/fields";
import { ESIGN_CONSENT_TEXT, IDENTITY_NOTICE, PILOT_NOTICE } from "@/lib/forms/consent";
import { esignProvider } from "@/lib/forms/esign-provider";
import { stepUpStatus, type StepUpStatus } from "@/lib/forms/step-up";
import { fmt, fmtDate } from "@/lib/time";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, Field, Input, NotConfigured, PageHeader, Select, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { remindAction, sendStepUpCodeAction, signAction, voidAction } from "../../actions";
import { FormMarkdown, Hash, SampleBadge, SampleTextBanner } from "../../_components/markdown";

export const metadata = { title: "Form request" };

export default async function RequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ verify?: string; signed?: string }> }) {
  const v = await requireViewer();
  const { id } = await params;
  const { verify, signed } = await searchParams;
  const ctx = await loadRequestContext(db, v.orgId, id);
  if (!ctx) notFound();
  const access = await requestAccess(db, v, { orgId: ctx.req.orgId, athleteId: ctx.req.athleteId, subjectPersonId: ctx.req.subjectPersonId, templateKind: ctx.template.kind });
  if (!access.view) notFound();
  const st = await signingState(db, v, ctx);
  const tz = ctx.org?.timezone ?? "America/Indiana/Indianapolis";
  const subjectName = `${ctx.subject.firstName} ${ctx.subject.lastName}`;
  const report = verify === "1" && access.viewData ? await verifyRequest(db, ctx, { checkPdfBytes: true }) : null;
  const events = access.viewData
    ? await db.select().from(formAuditEvents).where(eq(formAuditEvents.formRequestId, ctx.req.id)).orderBy(asc(formAuditEvents.createdAt))
    : [];
  const actorIds = [...new Set(events.map((e) => e.actorUserId).filter(Boolean) as string[])];
  const actors = actorIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, actorIds)) : [];
  const actorName = (uid: string | null) => (uid ? (actors.find((a) => a.id === uid)?.name ?? "Unknown user") : "System");
  const fields = (ctx.version.fields ?? []) as FormField[];
  const provider = esignProvider();
  const stepUp = st.mine.length ? await stepUpStatus(db, v, ctx) : null;

  return (
    <>
      <PageHeader
        kicker={`${ctx.template.name} · v${ctx.version.version}`}
        title={ctx.version.title}
        description={
          <>
            For <strong>{subjectName}</strong>
            {ctx.req.dueDate ? <> · due {fmtDate(ctx.req.dueDate)}</> : null}
            {ctx.req.completedAt ? <> · completed {fmt(ctx.req.completedAt, "MMM d, yyyy h:mm a zzz", tz)}</> : null}
          </>
        }
        actions={
          <ButtonLink href={access.manage ? "/documents?tab=requests" : `/documents?athlete=${ctx.req.athleteId ?? ""}`} variant="outline">
            Back to documents
          </ButtonLink>
        }
      />
      {signed ? (
        <Callout tone="ok" className="mb-5" title="Your signature was recorded">
          {ctx.req.status === "completed"
            ? "All required signatures are in. The completed PDF is ready to download."
            : "This form is now waiting for the remaining required signer(s). They can sign from their own account."}
        </Callout>
      ) : null}
      <div id="top" className="mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge status={ctx.req.status} />
        <SampleBadge isSample={ctx.version.isSampleText} />
        <Badge title={ctx.version.contentHash}>content {ctx.version.contentHash.slice(0, 10)}…</Badge>
        {ctx.req.status === "superseded" || (ctx.req.status === "voided" && ctx.req.supersededById) ? (
          <Link className="text-sm font-medium text-brand hover:underline" href={`/documents/requests/${ctx.req.supersededById}`}>
            Go to the replacement request →
          </Link>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <SampleTextBanner isSample={ctx.version.isSampleText} />
          <Card>
            <CardHeader title="Document" kicker="Exactly as published" />
            <CardBody>
              <FormMarkdown source={ctx.version.bodyMarkdown} />
            </CardBody>
          </Card>

          {access.viewData && ctx.req.submittedData && fields.length ? (
            <Card>
              <CardHeader title="Submitted information" kicker="Frozen at first signature" />
              <CardBody>
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.key} className="min-w-0">
                      <dt className="text-xs font-medium text-ink-3">{f.label}</dt>
                      <dd className="whitespace-pre-wrap break-words text-sm">{displayValue(f, ctx.req.submittedData?.[f.key])}</dd>
                    </div>
                  ))}
                </dl>
                {st.open ? (
                  <p className="mt-3 text-xs text-ink-3">
                    Signed answers can’t be edited. If something is wrong, ask Teamwork staff to void this request and issue a new one.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {st.mine.length && stepUp ? <SignCard requestId={ctx.req.id} options={st.mine} fields={fields} mode="self" stepUp={stepUp} tz={tz} /> : null}
          {st.open && !st.mine.length && st.blockedReason && !access.manage ? <Callout tone="warn">{st.blockedReason}</Callout> : null}
          {access.manage && st.inPerson.length ? <SignCard requestId={ctx.req.id} options={st.inPerson} fields={fields} mode="in_person" /> : null}

          <Card>
            <CardHeader title="Signature evidence" kicker={`${ctx.signatures.length} signature${ctx.signatures.length === 1 ? "" : "s"}`} />
            <CardBody>
              {ctx.signatures.length === 0 ? (
                <p className="text-sm text-ink-3">No signatures yet.</p>
              ) : access.viewData ? (
                <Table caption="Signature evidence">
                  <thead>
                    <tr>
                      <Th>Signer</Th>
                      <Th>Typed name</Th>
                      <Th>Signed</Th>
                      <Th>IP / method</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ctx.signatures.map((s) => (
                      <tr key={s.id}>
                        <Td>
                          <div className="font-medium">{s.signerName}</div>
                          <div className="text-xs text-ink-3">
                            {SIGNER_ROLE_LABEL[s.signerRole as SignerRole] ?? s.signerRole}
                            {s.relationship ? ` · ${s.relationship}` : ""}
                          </div>
                        </Td>
                        <Td>{s.typedName}</Td>
                        <Td>
                          <div>{fmt(s.signedAt, "MMM d, yyyy h:mm:ss a zzz", tz)}</div>
                          <div className="text-xs text-ink-3">{s.signedAt.toISOString()}</div>
                        </Td>
                        <Td>
                          <div>{s.ip ?? "not recorded"}</div>
                          <div className="text-xs text-ink-3">{describeAuthMethod(s.authMethod)}</div>
                          <details className="text-xs text-ink-3">
                            <summary className="cursor-pointer">Consent &amp; device</summary>
                            <p className="mt-1">{s.consentText}</p>
                            <p className="mt-1 break-all">
                              auth_method: <code>{s.authMethod}</code>
                            </p>
                            <p className="mt-1 break-all">User agent: {s.userAgent ?? "not recorded"}</p>
                            <p className="mt-1">
                              Data hash <Hash value={s.dataHash} short />
                            </p>
                          </details>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <ul className="text-sm">
                  {ctx.signatures.map((s) => (
                    <li key={s.id}>
                      {SIGNER_ROLE_LABEL[s.signerRole as SignerRole] ?? s.signerRole} signed {fmtDate(s.signedAt)}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {access.viewData && ctx.req.integrityHash ? (
            <Card id="verify">
              <CardHeader
                title="Integrity verification"
                kicker="SHA-256"
                action={
                  <ButtonLink href={`/documents/requests/${ctx.req.id}?verify=1#verify`} variant="outline" size="sm">
                    {report ? "Re-run verification" : "Verify now"}
                  </ButtonLink>
                }
              />
              <CardBody className="space-y-3">
                <p className="text-sm">
                  Stored integrity hash: <Hash value={ctx.req.integrityHash} />
                </p>
                {report ? (
                  <>
                    <Callout tone={report.ok ? "ok" : "bad"} title={report.ok ? "Match — nothing has changed since signing" : "MISMATCH — this record has changed since it was signed"}>
                      Every hash below was recomputed from the stored version, submitted data, signature evidence, and PDF bytes just now.
                    </Callout>
                    <ul className="space-y-2 text-sm">
                      {report.checks.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <Badge variant={c.ok ? "green" : "red"}>{c.ok ? "match" : "mismatch"}</Badge>
                          <span className="min-w-0">
                            {c.label}
                            {c.note ? <span className="block text-xs text-ink-3">{c.note}</span> : null}
                            {!c.ok && c.expected ? (
                              <span className="block text-xs text-ink-3">
                                expected <Hash value={c.expected} short /> got <Hash value={c.actual} short />
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-ink-3">Recompute every hash from the stored records to confirm nothing changed after signing.</p>
                )}
              </CardBody>
            </Card>
          ) : null}

          {events.length ? (
            <Card>
              <CardHeader title="Audit trail" kicker="Every state change" />
              <CardBody>
                <ol className="space-y-2 text-sm">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-wrap gap-x-3">
                      <span className="tabular text-ink-3">{fmt(e.createdAt, "MMM d, yyyy h:mm:ss a zzz", tz)}</span>
                      <span className="font-medium">{e.event.replaceAll("_", " ")}</span>
                      <span className="text-ink-3">by {actorName(e.actorUserId)}</span>
                      {(e.details as { reason?: string } | null)?.reason ? <span className="text-ink-3">({(e.details as { reason: string }).reason})</span> : null}
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-5">
          <Card>
            <CardHeader title="Signers" />
            <CardBody>
              <ul className="space-y-2 text-sm">
                {st.applicable.map((r) => {
                  const done = st.signed.includes(r);
                  const required = st.required.includes(r);
                  return (
                    <li key={r} className="flex items-center justify-between gap-2">
                      <span>
                        {SIGNER_ROLE_LABEL[r]}
                        <span className="block text-xs text-ink-3">{required ? "required" : "optional"}</span>
                      </span>
                      <Badge variant={done ? "green" : required ? "yellow" : "neutral"}>{done ? "signed" : "waiting"}</Badge>
                    </li>
                  );
                })}
              </ul>
              {st.subjectIsAdult ? <p className="mt-3 text-xs text-ink-3">{subjectName} is 18 or older and signs for themself.</p> : null}
            </CardBody>
          </Card>

          {ctx.req.status === "completed" && access.viewData && ctx.req.completedPdfObjectId ? (
            <Card>
              <CardHeader title="Completed PDF" />
              <CardBody className="space-y-2">
                <a className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink hover:brightness-110" href={`/api/files/${ctx.req.completedPdfObjectId}`}>
                  Download PDF
                </a>
                <a className="block text-center text-xs text-brand hover:underline" href={`/api/files/${ctx.req.completedPdfObjectId}?inline=1`} target="_blank" rel="noopener">
                  Open in browser
                </a>
                {ctx.req.expiresAt ? <p className="text-xs text-ink-3">Renew by {fmtDate(ctx.req.expiresAt)}.</p> : null}
              </CardBody>
            </Card>
          ) : null}

          {access.manage && st.open ? (
            <Card>
              <CardHeader title="Staff actions" />
              <CardBody className="space-y-4">
                <ActionForm action={remindAction}>
                  <input type="hidden" name="requestId" value={ctx.req.id} />
                  <SubmitButton variant="outline" className="w-full" pendingText="Queuing…">
                    Send reminder
                  </SubmitButton>
                  <p className="mt-1 text-xs text-ink-3">
                    {ctx.req.reminderCount} sent{ctx.req.lastReminderAt ? `, last ${fmt(ctx.req.lastReminderAt)}` : ""}. Delivered by the messaging service.
                  </p>
                </ActionForm>
                <ActionForm action={voidAction} className="space-y-2">
                  <input type="hidden" name="requestId" value={ctx.req.id} />
                  <Field label="Reason (required)" htmlFor="void-reason">
                    <Textarea id="void-reason" name="reason" required minLength={3} className="min-h-16" />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton name="mode" value="reissue" variant="secondary" pendingText="Working…" confirm="Void this request and issue a fresh one on the current version?">
                      Void &amp; reissue
                    </SubmitButton>
                    <SubmitButton name="mode" value="void" variant="danger" pendingText="Voiding…" confirm="Void this request? Existing signatures stay on record.">
                      Void
                    </SubmitButton>
                  </div>
                  <p className="text-xs text-ink-3">Use “void &amp; reissue” to correct answers: signed data is never edited.</p>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}

          <Callout title="Pilot e-signature">{PILOT_NOTICE}</Callout>
          {st.open ? <Callout title="Identity verification">{IDENTITY_NOTICE}</Callout> : null}
          {access.manage ? (
            <NotConfigured provider={provider.displayName} envVars={provider.requiredEnv()}>
              An established e-signature provider can replace the pilot typed-name workflow. The adapter interface is ready; no provider is connected, so nothing is sent externally.
            </NotConfigured>
          ) : null}
        </aside>
      </div>
    </>
  );
}

/**
 * Identity step-up for self-signing. Returns whether the signature form can be used now
 * and whether it needs the code field. Never hides the requirement: when email can't be
 * used, the signer is sent to staff for in-person verification.
 */
function StepUpPanel({ requestId, s, tz }: { requestId: string; s: StepUpStatus; tz: string }) {
  if (s.satisfiedByMfa) {
    return (
      <Callout tone="ok" className="mb-4" title="Identity verified">
        You completed multi-factor sign-in this session, which this organization accepts as identity verification for signing.
      </Callout>
    );
  }
  if (!s.emailOnFile) {
    return (
      <Callout tone="warn" className="mb-4" title="Identity verification needed">
        This form requires a verification code sent to your email, but Teamwork has no email address on file for you. Ask Teamwork staff to verify your identity in person and record your signature.
      </Callout>
    );
  }
  if (!s.emailConfigured) {
    return (
      <Callout tone="warn" className="mb-4" title="Identity verification needed">
        This form requires a verification code sent to your email, but email delivery is not configured for Teamwork Hub yet, so no code can be sent. Ask Teamwork staff to verify your identity in person and record your signature.
      </Callout>
    );
  }
  const l = s.latest;
  const statusLine = !l
    ? null
    : s.verified
      ? "Code accepted. Finish signing below before it expires."
      : l.status === "undeliverable"
        ? `The last code could not be delivered (${l.deliveryStatus === "not_configured" ? "email not configured" : (l.deliveryReason ?? "delivery failed")}). Request a new code or ask staff to verify you in person.`
        : l.status === "locked"
          ? "Too many incorrect codes. Request a new code."
          : l.status === "expired"
            ? "Your last code expired. Request a new code."
            : l.status === "pending"
              ? `Code sent ${fmt(l.createdAt, "h:mm a", tz)}${l.deliveryStatus === "test_redirected" ? " (test mode: redirected to the test recipient)" : ""}; valid until ${fmt(l.expiresAt, "h:mm a", tz)}. ${l.attemptsLeft} attempt${l.attemptsLeft === 1 ? "" : "s"} left.`
              : null;
  return (
    <div className="mb-4 rounded-lg border border-edge p-4">
      <p className="text-sm font-semibold">Step 1 — verify your identity</p>
      <p className="mt-1 text-sm text-ink-3">
        We’ll email a 6-digit code to <strong>{s.emailOnFile}</strong> (the address Teamwork has on file). Enter it below with your signature. Wrong address? Ask Teamwork staff to update it or to verify you in person.
      </p>
      {statusLine ? <p className="mt-2 text-sm">{statusLine}</p> : null}
      {!s.verified ? (
        <ActionForm action={sendStepUpCodeAction} className="mt-3">
          <input type="hidden" name="requestId" value={requestId} />
          <SubmitButton variant="outline" pendingText="Sending…">
            {l ? "Email me a new code" : "Email me a code"}
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}

function SignCard({
  requestId,
  options,
  fields,
  mode,
  stepUp,
  tz,
}: {
  requestId: string;
  options: SignOption[];
  fields: FormField[];
  mode: "self" | "in_person";
  stepUp?: StepUpStatus;
  tz?: string;
}) {
  const needsData = options.some((o) => o.submitsData);
  const prefix = mode === "self" ? "s" : "ip";
  const gated = mode === "self" && stepUp?.required && !stepUp.satisfiedByMfa;
  const blocked = gated && (!stepUp!.emailOnFile || !stepUp!.emailConfigured);
  const needsCode = gated && !blocked && !stepUp!.verified;
  return (
    <Card id={mode === "self" ? "sign" : "sign-in-person"}>
      <CardHeader
        title={mode === "self" ? "Sign this form" : "Record an in-person signature"}
        kicker={mode === "self" ? `Signing as ${options[0].signerName}` : "Staff-assisted, you are the witness"}
      />
      <CardBody>
        {mode === "in_person" ? (
          <p className="mb-3 text-sm text-ink-3">
            Check the signer’s identity in person (for example a photo ID), then hand them the device. They read the document, type their own full legal name, and check the consent box. Your account is recorded as the witness who attested their identity (<code>staff_witnessed_in_person</code>).
          </p>
        ) : null}
        {mode === "self" && stepUp?.required ? <StepUpPanel requestId={requestId} s={stepUp} tz={tz ?? "America/Indiana/Indianapolis"} /> : null}
        {blocked ? null : (
        <ActionForm action={signAction} className="space-y-4">
          <input type="hidden" name="requestId" value={requestId} />
          {mode === "self" ? (
            options.length === 1 ? (
              <>
                <input type="hidden" name="role" value={options[0].role} />
                <p className="text-sm">
                  Role: <strong>{options[0].label}</strong>
                  {options[0].relationship ? ` (${options[0].relationship})` : ""}
                </p>
              </>
            ) : (
              <Field label="Sign as" htmlFor={`${prefix}-role`}>
                <Select id={`${prefix}-role`} name="role">
                  {options.map((o) => (
                    <option key={o.role} value={o.role}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : (
            <Field label="Signer and role" htmlFor={`${prefix}-pick`} required>
              <Select id={`${prefix}-pick`} name="inPersonPick" required>
                {options.map((o) => (
                  <option key={`${o.signerPersonId}|${o.role}`} value={`${o.signerPersonId}|${o.role}`}>
                    {o.signerName} — {o.label}
                    {o.relationship ? ` (${o.relationship})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {needsData && fields.length ? (
            <fieldset className="space-y-3 rounded-lg border border-edge p-4">
              <legend className="px-1 text-sm font-semibold">Form information</legend>
              {fields.map((f) => (
                <FieldInput key={f.key} f={f} prefix={prefix} />
              ))}
            </fieldset>
          ) : null}

          <div className="rounded-lg border border-edge bg-surface-2 p-3 text-sm" id={`${prefix}-consent-text`}>
            {ESIGN_CONSENT_TEXT}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-0.5 size-5 shrink-0" aria-describedby={`${prefix}-consent-text`} />
            <span>I agree to the statement above and to sign electronically.</span>
          </label>
          <Field label="Type your full legal name" htmlFor={`${prefix}-name`} required hint="First and last name, as your signature.">
            <Input id={`${prefix}-name`} name="typedName" required autoComplete="name" minLength={3} maxLength={120} />
          </Field>
          {needsCode ? (
            <Field label="Verification code" htmlFor={`${prefix}-code`} required hint="The 6-digit code from the email (step 1).">
              <Input
                id={`${prefix}-code`}
                name="stepUpCode"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                className="max-w-40 tabular"
              />
            </Field>
          ) : null}
          {mode === "in_person" ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="identityAttested" required className="mt-0.5 size-5 shrink-0" />
              <span>I checked this signer’s identity in person and attest that they are the person selected above. My name is recorded as the witness.</span>
            </label>
          ) : null}
          <SubmitButton size="lg" pendingText="Signing…">
            {mode === "self" ? "Sign" : "Record signature"}
          </SubmitButton>
        </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

function FieldInput({ f, prefix }: { f: FormField; prefix: string }) {
  const id = `${prefix}-f-${f.key}`;
  const name = `field_${f.key}`;
  if (f.type === "checkbox") {
    return (
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" id={id} name={name} required={f.required} className="mt-0.5 size-5 shrink-0" />
        <span>
          {f.label}
          {f.required ? <span className="text-bad"> *</span> : null}
        </span>
      </label>
    );
  }
  return (
    <Field label={f.label} htmlFor={id} required={f.required}>
      {f.type === "textarea" ? (
        <Textarea id={id} name={name} required={f.required} maxLength={4000} />
      ) : f.type === "select" ? (
        <Select id={id} name={name} required={f.required} defaultValue="">
          <option value="" disabled={f.required}>
            Choose…
          </option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          name={name}
          required={f.required}
          type={f.type === "phone" ? "tel" : f.type === "email" ? "email" : f.type === "date" ? "date" : "text"}
          autoComplete={f.type === "phone" ? "tel" : f.type === "email" ? "email" : "off"}
          maxLength={300}
        />
      )}
    </Field>
  );
}
