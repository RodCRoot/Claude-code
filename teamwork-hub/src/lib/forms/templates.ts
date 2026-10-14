import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { formRequests, formTemplates, formTemplateVersions, type FormField, type SignerRequirement } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { assertCan, isAdmin, AuthzError, type Viewer } from "@/lib/authz/policy";
import { fieldListSchema, normalizeFields, signerListSchema } from "./fields";
import { contentHash } from "./hash";
import { createRequest, formEvent } from "./requests";
import { OPEN_STATUSES } from "./context";

export const TEMPLATE_KINDS = ["waiver", "agreement", "intake", "medical", "media_release", "policy"] as const;

export const templateInputSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(120),
  kind: z.enum(TEMPLATE_KINDS),
  renewalMonths: z.number().int().min(1).max(120).nullable(),
  requiredForBooking: z.boolean(),
});
export type TemplateInput = z.infer<typeof templateInputSchema>;

export const STARTER_BODY = `# Sample form

**SAMPLE TEXT — replace with Teamwork-approved language before using this form with families.**

Describe what the signer is agreeing to here. Use short paragraphs and lists:

- First point
- Second point
`;

const DEFAULT_SIGNERS: SignerRequirement[] = [
  { role: "guardian", required: true },
  { role: "adult_athlete", required: true },
];

async function getTemplate(tx: Tx, v: Viewer, id: string) {
  const [t] = await tx.select().from(formTemplates).where(and(eq(formTemplates.id, id), eq(formTemplates.orgId, v.orgId)));
  if (!t) throw new UserError("Template not found.");
  return t;
}

async function getVersion(tx: Tx, v: Viewer, versionId: string, lock = false) {
  const q = tx
    .select({ ver: formTemplateVersions, orgId: formTemplates.orgId, name: formTemplates.name })
    .from(formTemplateVersions)
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .where(eq(formTemplateVersions.id, versionId));
  const [row] = lock ? await q.for("update", { of: formTemplateVersions }) : await q;
  if (!row || row.orgId !== v.orgId) throw new UserError("Version not found.");
  return row;
}

export async function createTemplate(tx: Tx, v: Viewer, input: TemplateInput) {
  assertCan(v, "forms.manage");
  const data = templateInputSchema.parse(input);
  const [t] = await tx.insert(formTemplates).values({ orgId: v.orgId, ...data }).returning();
  const content = { title: data.name, bodyMarkdown: STARTER_BODY, fields: [] as FormField[], signers: DEFAULT_SIGNERS };
  await tx.insert(formTemplateVersions).values({ templateId: t.id, version: 1, ...content, contentHash: contentHash(content), isSampleText: true, status: "draft" });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.template_create", "form_template", t.id, { summary: `Created form template ${t.name}`, after: data });
  return t;
}

export async function updateTemplate(tx: Tx, v: Viewer, id: string, input: TemplateInput & { active?: boolean }) {
  assertCan(v, "forms.manage");
  const before = await getTemplate(tx, v, id);
  const data = templateInputSchema.parse(input);
  const active = input.active ?? before.active;
  await tx.update(formTemplates).set({ ...data, active }).where(eq(formTemplates.id, id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.template_update", "form_template", id, {
    summary: `Updated form template ${data.name}`,
    before: { name: before.name, kind: before.kind, renewalMonths: before.renewalMonths, requiredForBooking: before.requiredForBooking, active: before.active },
    after: { ...data, active },
  });
}

/** Returns the template's open draft, or creates one by copying the latest version. */
export async function createDraftVersion(tx: Tx, v: Viewer, templateId: string) {
  assertCan(v, "forms.manage");
  await getTemplate(tx, v, templateId);
  await tx.select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.id, templateId)).for("update");
  const [existing] = await tx
    .select()
    .from(formTemplateVersions)
    .where(and(eq(formTemplateVersions.templateId, templateId), eq(formTemplateVersions.status, "draft")));
  if (existing) return { version: existing, created: false };
  const [latest] = await tx
    .select()
    .from(formTemplateVersions)
    .where(eq(formTemplateVersions.templateId, templateId))
    .orderBy(desc(formTemplateVersions.version))
    .limit(1);
  const content = latest
    ? { title: latest.title, bodyMarkdown: latest.bodyMarkdown, fields: latest.fields, signers: latest.signers }
    : { title: "Untitled form", bodyMarkdown: STARTER_BODY, fields: [] as FormField[], signers: DEFAULT_SIGNERS };
  const [draft] = await tx
    .insert(formTemplateVersions)
    .values({
      templateId,
      version: (latest?.version ?? 0) + 1,
      ...content,
      contentHash: contentHash(content),
      // Edited text must be re-approved: new drafts start as sample text.
      isSampleText: true,
      status: "draft",
    })
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.version_draft", "form_template_version", draft.id, {
    summary: `Started draft v${draft.version}`,
  });
  return { version: draft, created: true };
}

export const draftInputSchema = z.object({
  title: z.string().trim().min(2, "Title is required.").max(200),
  bodyMarkdown: z.string().trim().min(10, "Body text is required.").max(60_000),
  fields: fieldListSchema,
  signers: signerListSchema,
});

export async function saveDraft(tx: Tx, v: Viewer, versionId: string, input: { title: string; bodyMarkdown: string; fields: FormField[]; signers: SignerRequirement[] }) {
  assertCan(v, "forms.manage");
  const { ver } = await getVersion(tx, v, versionId, true);
  if (ver.status !== "draft") throw new UserError("Published versions cannot be edited. Start a new draft instead.");
  const parsed = draftInputSchema.parse(input);
  const content = { title: parsed.title, bodyMarkdown: parsed.bodyMarkdown, fields: normalizeFields(parsed.fields as FormField[]), signers: parsed.signers };
  await tx.update(formTemplateVersions).set({ ...content, contentHash: contentHash(content) }).where(eq(formTemplateVersions.id, versionId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.version_save", "form_template_version", versionId, {
    summary: `Saved draft v${ver.version}`,
    after: { title: content.title, fieldCount: content.fields.length, signers: content.signers },
  });
}

export async function discardDraft(tx: Tx, v: Viewer, versionId: string) {
  assertCan(v, "forms.manage");
  const { ver } = await getVersion(tx, v, versionId, true);
  if (ver.status !== "draft") throw new UserError("Only drafts can be discarded.");
  await tx.delete(formTemplateVersions).where(eq(formTemplateVersions.id, versionId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.version_discard", "form_template_version", versionId, {
    summary: `Discarded draft v${ver.version}`,
  });
}

/**
 * Publish a draft. Its content hash is recomputed and frozen (DB trigger blocks
 * later edits). Earlier published versions stay published (and immutable); the
 * highest published version is the current one. With `requireResign`, open
 * requests on older versions become "superseded" and new requests are issued on
 * this version; completed requests always stay as the record of what was signed.
 */
export async function publishVersion(tx: Tx, v: Viewer, versionId: string, opts: { requireResign: boolean }) {
  assertCan(v, "forms.manage");
  const { ver, name } = await getVersion(tx, v, versionId, true);
  await tx.select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.id, ver.templateId)).for("update");
  if (ver.status !== "draft") throw new UserError("Only drafts can be published.");
  const parsed = draftInputSchema.safeParse({ title: ver.title, bodyMarkdown: ver.bodyMarkdown, fields: ver.fields, signers: ver.signers });
  if (!parsed.success) throw new UserError(`Fix the draft before publishing: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (!ver.signers.some((s) => s.required)) throw new UserError("At least one signer role must be required.");
  const hash = contentHash({ title: ver.title, bodyMarkdown: ver.bodyMarkdown, fields: ver.fields, signers: ver.signers });
  const now = new Date();
  // Earlier versions deliberately stay "published": the immutability trigger only
  // guards published rows, so moving them to another status would make them editable.
  // The current version is the highest published version number.
  await tx
    .update(formTemplateVersions)
    .set({ contentHash: hash, status: "published", publishedAt: now, publishedBy: v.userId })
    .where(eq(formTemplateVersions.id, ver.id));

  let superseded = 0;
  if (opts.requireResign) {
    const older = await tx
      .select({ id: formTemplateVersions.id })
      .from(formTemplateVersions)
      .where(and(eq(formTemplateVersions.templateId, ver.templateId), lt(formTemplateVersions.version, ver.version)));
    const olderIds = older.map((o) => o.id);
    if (olderIds.length) {
      const open = await tx
        .select()
        .from(formRequests)
        .where(and(eq(formRequests.orgId, v.orgId), inArray(formRequests.templateVersionId, olderIds), inArray(formRequests.status, [...OPEN_STATUSES])))
        .for("update");
      for (const r of open) {
        const n = await createRequest(tx, {
          orgId: r.orgId,
          versionId: ver.id,
          athleteId: r.athleteId!,
          subjectPersonId: r.subjectPersonId,
          requestedBy: v.userId,
          dueDate: r.dueDate,
          isDemo: r.isDemo,
          reason: "resign_required",
        });
        await tx.update(formRequests).set({ status: "superseded", supersededById: n.id }).where(eq(formRequests.id, r.id));
        await formEvent(tx, r.id, "superseded", v.userId, { from: r.status, newRequestId: n.id, newVersion: ver.version });
        superseded++;
      }
    }
  }
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.version_publish", "form_template_version", ver.id, {
    summary: `Published ${name} v${ver.version}${opts.requireResign ? ` (re-signing required; ${superseded} open request(s) superseded)` : ""}`,
    after: { contentHash: hash, requireResign: opts.requireResign, superseded },
  });
  return { contentHash: hash, superseded };
}

/** Admin attestation that a version's text is Teamwork-approved language (or revert to sample). */
export async function setApprovedText(tx: Tx, v: Viewer, versionId: string, approved: boolean) {
  if (!isAdmin(v)) throw new AuthzError("Only an owner or admin can mark form text as approved.");
  const { ver, name } = await getVersion(tx, v, versionId, true);
  await tx.update(formTemplateVersions).set({ isSampleText: !approved }).where(eq(formTemplateVersions.id, versionId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.version_text_approval", "form_template_version", versionId, {
    summary: `${approved ? "Marked approved Teamwork language" : "Reverted to SAMPLE text"}: ${name} v${ver.version}`,
    before: { isSampleText: ver.isSampleText },
    after: { isSampleText: !approved },
  });
}
