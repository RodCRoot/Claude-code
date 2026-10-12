import { notFound } from "next/navigation";
import Link from "next/link";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { formRequests, formTemplateVersions, users } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { isAdmin } from "@/lib/authz/policy";
import { athleteOptions, groupOptions, listTemplates } from "@/lib/forms/queries";
import { TEMPLATE_KINDS } from "@/lib/forms/templates";
import { SIGNER_ROLE_LABEL } from "@/lib/forms/fields";
import { fmt } from "@/lib/time";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { approveTextAction, discardDraftAction, issueAction, newDraftAction, publishAction, saveDraftAction, updateTemplateAction } from "../../actions";
import { FieldBuilder } from "../../_components/field-builder";
import { FormMarkdown, Hash, SampleBadge, SampleTextBanner } from "../../_components/markdown";

export const metadata = { title: "Form template" };

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const viewer = await requireCap("forms.manage");
  const { id } = await params;
  const { v: viewVersionId } = await searchParams;
  const t = (await listTemplates(db, viewer.orgId)).find((x) => x.id === id);
  if (!t) notFound();
  const [athletes, groups] = await Promise.all([athleteOptions(db, viewer.orgId), groupOptions(db, viewer.orgId)]);
  const publisherIds = [...new Set(t.versions.map((v) => v.publishedBy).filter(Boolean) as string[])];
  const publishers = publisherIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, publisherIds)) : [];
  const preview = t.versions.find((v) => v.id === viewVersionId) ?? t.current ?? t.draft ?? t.versions[0];
  const draft = t.draft;
  const admin = isAdmin(viewer);
  // Open requests that "require re-signing" would supersede.
  const openOnOlder = draft
    ? (
        await db
          .select({ id: formRequests.id })
          .from(formRequests)
          .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
          .where(and(eq(formTemplateVersions.templateId, t.id), lt(formTemplateVersions.version, draft.version), inArray(formRequests.status, ["pending", "partially_signed"])))
      ).length
    : 0;

  return (
    <>
      <PageHeader
        kicker="Form template"
        title={t.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge>{t.kind.replace("_", " ")}</Badge>
            {t.requiredForBooking ? <Badge variant="blue">required for booking</Badge> : null}
            {!t.active ? <Badge variant="red">inactive</Badge> : null}
            <span>
              {t.open} open · {t.completed} completed · renewal {t.renewalMonths ? `every ${t.renewalMonths} months` : "never"}
            </span>
          </span>
        }
        actions={
          <ButtonLink href="/documents?tab=templates" variant="outline">
            All templates
          </ButtonLink>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {draft ? (
            <Card id="draft">
              <CardHeader title={`Draft v${draft.version}`} kicker="Editing" action={<SampleBadge isSample={draft.isSampleText} />} />
              <CardBody className="space-y-5">
                <ActionForm action={saveDraftAction} className="space-y-4">
                  <input type="hidden" name="versionId" value={draft.id} />
                  <Field label="Title shown to signers" htmlFor="d-title" required>
                    <Input id="d-title" name="title" defaultValue={draft.title} required maxLength={200} />
                  </Field>
                  <Field label="Body (Markdown)" htmlFor="d-body" required hint="Headings (#, ##), **bold**, *italic*, lists (- or 1.). HTML is shown as plain text, never rendered.">
                    <Textarea id="d-body" name="bodyMarkdown" defaultValue={draft.bodyMarkdown} required className="min-h-72 font-mono text-xs" />
                  </Field>
                  <FieldBuilder initialFields={draft.fields} initialSigners={draft.signers} />
                  <SubmitButton pendingText="Saving…">Save draft</SubmitButton>
                </ActionForm>

                <div className="grid gap-4 border-t border-edge pt-4 md:grid-cols-2">
                  <ActionForm action={publishAction} className="space-y-3">
                    <input type="hidden" name="versionId" value={draft.id} />
                    <p className="text-sm font-semibold">Publish v{draft.version}</p>
                    <p className="text-xs text-ink-3">Publishing freezes this exact text, fields, and signer list (SHA-256 content hash). It can never be edited afterwards — changes need a new draft. Save first.</p>
                    {t.current ? (
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" name="requireResign" className="mt-0.5 size-4 shrink-0" />
                        <span>
                          Require re-signing: supersede the <strong>{openOnOlder}</strong> open request(s) on older versions and issue new ones on v{draft.version}. Completed forms stay as the record of what was signed.
                        </span>
                      </label>
                    ) : null}
                    <SubmitButton pendingText="Publishing…" confirm={`Publish v${draft.version}? Published versions are permanent.`}>
                      Publish v{draft.version}
                    </SubmitButton>
                  </ActionForm>
                  <div className="space-y-3">
                    {admin ? (
                      <ActionForm action={approveTextAction}>
                        <input type="hidden" name="versionId" value={draft.id} />
                        <input type="hidden" name="approved" value={draft.isSampleText ? "true" : "false"} />
                        <SubmitButton variant="outline" pendingText="Saving…">
                          {draft.isSampleText ? "Mark text as Teamwork-approved" : "Mark as SAMPLE text"}
                        </SubmitButton>
                      </ActionForm>
                    ) : (
                      <p className="text-xs text-ink-3">Only an owner or admin can mark text as Teamwork-approved.</p>
                    )}
                    <ActionForm action={discardDraftAction}>
                      <input type="hidden" name="versionId" value={draft.id} />
                      <SubmitButton variant="ghost" pendingText="Discarding…" confirm="Discard this draft?">
                        Discard draft
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-3 pt-5">
                <p className="text-sm text-ink-3">Published versions can’t be edited. Start a new draft (a copy of the latest version) to make changes.</p>
                <ActionForm action={newDraftAction}>
                  <input type="hidden" name="templateId" value={t.id} />
                  <SubmitButton pendingText="Creating…">Start new draft</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          )}

          {preview ? (
            <Card>
              <CardHeader
                title={`Preview: v${preview.version} — ${preview.title}`}
                kicker={preview.status === "draft" ? "Draft (last saved)" : preview.id === t.current?.id ? "Current published version" : "Earlier published version"}
              />
              <CardBody className="space-y-4">
                <SampleTextBanner isSample={preview.isSampleText} />
                <FormMarkdown source={preview.bodyMarkdown} />
                {preview.fields.length ? (
                  <div>
                    <p className="mb-1 text-sm font-semibold">Fields</p>
                    <ul className="list-disc pl-5 text-sm">
                      {preview.fields.map((f) => (
                        <li key={f.key}>
                          {f.label} <span className="text-xs text-ink-3">({f.type}{f.required ? ", required" : ""}{f.options?.length ? `: ${f.options.join(" / ")}` : ""})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div>
                  <p className="mb-1 text-sm font-semibold">Signers</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {preview.signers.map((s) => (
                      <li key={s.role}>
                        <Badge variant={s.required ? "blue" : "neutral"}>
                          {SIGNER_ROLE_LABEL[s.role]} · {s.required ? "required" : "optional"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-5">
          {t.current ? (
            <Card>
              <CardHeader title="Issue requests" kicker={`v${t.current.version}`} />
              <CardBody>
                <ActionForm action={issueAction} className="space-y-3">
                  <input type="hidden" name="templateId" value={t.id} />
                  <Field label="Send to" htmlFor="is-target">
                    <Select id="is-target" name="target" defaultValue="athlete">
                      <option value="athlete">One athlete</option>
                      <option value="group">A group</option>
                      <option value="missing">Everyone missing this form</option>
                    </Select>
                  </Field>
                  <Field label="Athlete" htmlFor="is-athlete" hint="Used when sending to one athlete.">
                    <Select id="is-athlete" name="athleteId" defaultValue="">
                      <option value="">Choose…</option>
                      {athletes.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.active ? "" : " (inactive)"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Group" htmlFor="is-group" hint="Used when sending to a group (active members).">
                    <Select id="is-group" name="groupId" defaultValue="">
                      <option value="">Choose…</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Due date (optional)" htmlFor="is-due">
                    <Input id="is-due" name="dueDate" type="date" />
                  </Field>
                  <SubmitButton pendingText="Issuing…" className="w-full">
                    Issue requests
                  </SubmitButton>
                  <p className="text-xs text-ink-3">Athletes with an open request for this form are skipped. Families get a <code>forms.reminder</code> notification via messaging.</p>
                </ActionForm>
              </CardBody>
            </Card>
          ) : (
            <Callout tone="warn" title="Not published yet">
              Publish a version before issuing requests.
            </Callout>
          )}

          {t.current && admin ? (
            <Card>
              <CardHeader title="Approved language" />
              <CardBody>
                <p className="mb-2 text-xs text-ink-3">
                  Attest that v{t.current.version}’s wording is Teamwork-approved (removes the SAMPLE TEXT label). This doesn’t change the signed content or its hash.
                </p>
                <ActionForm action={approveTextAction}>
                  <input type="hidden" name="versionId" value={t.current.id} />
                  <input type="hidden" name="approved" value={t.current.isSampleText ? "true" : "false"} />
                  <SubmitButton variant="outline" pendingText="Saving…" confirm={t.current.isSampleText ? "Confirm this wording has been approved by Teamwork?" : undefined}>
                    {t.current.isSampleText ? `Mark v${t.current.version} as approved` : `Mark v${t.current.version} as SAMPLE text`}
                  </SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Settings" />
            <CardBody>
              <ActionForm action={updateTemplateAction} className="space-y-3">
                <input type="hidden" name="templateId" value={t.id} />
                <Field label="Name" htmlFor="ts-name" required>
                  <Input id="ts-name" name="name" defaultValue={t.name} required />
                </Field>
                <Field label="Kind" htmlFor="ts-kind">
                  <Select id="ts-kind" name="kind" defaultValue={t.kind}>
                    {TEMPLATE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k.replace("_", " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Renewal period (months)" htmlFor="ts-renew" hint="Blank = never expires. Applies to forms completed from now on.">
                  <Input id="ts-renew" name="renewalMonths" type="number" min={1} max={120} defaultValue={t.renewalMonths ?? ""} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="requiredForBooking" defaultChecked={t.requiredForBooking} className="size-4" /> Required for booking
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="active" defaultChecked={t.active} className="size-4" /> Active
                </label>
                <SubmitButton variant="secondary" pendingText="Saving…">
                  Save settings
                </SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Versions" />
            <Table caption="Versions" className="[&_table]:min-w-0">
              <thead>
                <tr>
                  <Th>Ver.</Th>
                  <Th>Status</Th>
                  <Th>Hash</Th>
                </tr>
              </thead>
              <tbody>
                {t.versions.map((ver) => (
                  <tr key={ver.id}>
                    <Td>
                      <Link className="font-medium text-brand hover:underline" href={`/documents/templates/${t.id}?v=${ver.id}`}>
                        v{ver.version}
                      </Link>
                    </Td>
                    <Td>
                      {ver.id === t.current?.id ? <Badge variant="green">current</Badge> : <StatusBadge status={ver.status === "published" ? "previous" : ver.status} />}
                      <div className="text-[11px] text-ink-3">
                        {ver.publishedAt ? `${fmt(ver.publishedAt, "MMM d, yyyy")} · ${publishers.find((p) => p.id === ver.publishedBy)?.name ?? ""}` : "not published"}
                      </div>
                    </Td>
                    <Td>
                      <Hash value={ver.contentHash} short />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </aside>
      </div>
    </>
  );
}
