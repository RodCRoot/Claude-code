import Link from "next/link";
import { FamilyStyleHint } from "@/app/(app)/messages/_components/family-style-hint";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { messageTemplates } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/forms";
import { StableForm, StableSubmit } from "../../_components/stable-form";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { requireCap } from "@/lib/auth/viewer";
import { renderTemplate, TEMPLATE_VARIABLES } from "@/lib/automation/templates";
import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "../../actions";

export const metadata = { title: "Template" };

const EXAMPLE: Record<string, string> = {
  recipient_first_name: "Jamie",
  guardian_first_name: "Jamie",
  athlete_first_name: "Riley",
  athlete_name: "Riley Example",
  lead_first_name: "Riley",
  session_title: "HS Speed & Strength",
  session_time: "Tue Mar 3, 6:00 PM",
  form_name: "Participation Waiver",
  invoice_number: "INV-0001",
  invoice_amount: "$0.00 (example)",
  renewal_date: "Apr 1, 2026",
  last_attended_date: "Feb 10, 2026",
  days_since_attended: "21",
  org_name: "Teamwork",
};

export default async function TemplateEditor({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireCap("crm.manage");
  const { id } = await params;
  const isNew = id === "new";
  let t: typeof messageTemplates.$inferSelect | undefined;
  if (!isNew) {
    if (!z.string().uuid().safeParse(id).success) notFound();
    [t] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, v.orgId)));
    if (!t) notFound();
  }
  const preview = t ? { subject: renderTemplate(t.subject ?? "", EXAMPLE).text, body: renderTemplate(t.body, EXAMPLE).text } : null;

  return (
    <>
      <PageHeader kicker="Templates" title={isNew ? "New template" : t!.name} />
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardBody className="pt-5">
            {t?.isSample ? (
              <Callout tone="warn" title="SAMPLE text" className="mb-4">
                This wording is a placeholder, not approved Teamwork policy. Replace it and untick &quot;sample&quot; before enabling automations that use it.
              </Callout>
            ) : null}
            <StableForm action={isNew ? createTemplateAction : updateTemplateAction} className="space-y-4">
              {t ? <input type="hidden" name="templateId" value={t.id} /> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="name" required>
                  <Input id="name" name="name" required maxLength={120} defaultValue={t?.name} />
                </Field>
                <Field label="Intended channel" htmlFor="channel" hint="Rules decide where it's actually sent">
                  <Select id="channel" name="channel" defaultValue={t?.channel ?? "email"}>
                    <option value="in_app">In-app</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS (short)</option>
                  </Select>
                </Field>
              </div>
              <Field label="Subject" htmlFor="subject" hint="Used as the conversation subject and email subject">
                <Input id="subject" name="subject" maxLength={200} defaultValue={t?.subject ?? ""} />
              </Field>
              <Field label="Body" htmlFor="body" required>
                <Textarea id="body" name="body" required maxLength={5000} rows={8} defaultValue={t?.body} />
              </Field>
              <FamilyStyleHint target="body" subjectTarget="subject" />
              <Field label="If the text has em dashes when you save" htmlFor="fixDashes" hint="Family messages never use em dashes; saving is refused unless they are replaced.">
                <Select id="fixDashes" name="fixDashes" defaultValue="">
                  <option value="">Don&apos;t change my text (save will be refused)</option>
                  <option value="comma">Replace them with commas</option>
                  <option value="period">Replace them with periods</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isSample" defaultChecked={t?.isSample ?? false} className="size-4" /> This is SAMPLE text (not yet approved wording)
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <StableSubmit>{isNew ? "Create template" : "Save template"}</StableSubmit>
                <Link href="/messages/templates" className="text-sm text-ink-3 underline">
                  Back
                </Link>
              </div>
            </StableForm>
            {t ? (
              <ActionForm action={deleteTemplateAction} className="mt-6 border-t border-edge pt-4">
                <input type="hidden" name="templateId" value={t.id} />
                <SubmitButton variant="ghost" confirm="Delete this template?">
                  Delete template
                </SubmitButton>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>
        <div className="space-y-5">
          {preview ? (
            <Card>
              <CardHeader title="Rendered with example values" kicker="Preview (saved version)" />
              <CardBody>
                <p className="text-sm font-semibold">{preview.subject || "(no subject)"}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm">{preview.body}</p>
                <p className="mt-3 text-xs text-ink-3">To see real recipients, preview an automation rule that uses this template.</p>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Variables" />
            <CardBody>
              <ul className="space-y-1.5 text-sm">
                {Object.entries(TEMPLATE_VARIABLES).map(([k, d]) => (
                  <li key={k}>
                    <code className="rounded bg-surface-2 px-1 text-xs">{`{{${k}}}`}</code> <span className="text-ink-3">— {d}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-3">Each trigger fills the variables that apply to it; anything missing renders empty and is flagged in previews.</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
