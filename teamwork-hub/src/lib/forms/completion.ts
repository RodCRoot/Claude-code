import { addMonths } from "date-fns";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { formRequests } from "@/db/schema";
import { renderCompletedFormPdf } from "@/lib/pdf/completed-form";
import { displayValue, SIGNER_ROLE_LABEL, type SignerRole } from "./fields";
import { integrityHash, type SignatureEvidence } from "./hash";
import type { RequestContext } from "./context";
import { formEvent } from "./requests";

export function evidenceOf(s: RequestContext["signatures"][number]): SignatureEvidence {
  return {
    signerRole: s.signerRole,
    signerPersonId: s.signerPersonId,
    signerUserId: s.signerUserId,
    relationship: s.relationship,
    typedName: s.typedName,
    consentText: s.consentText,
    consentGiven: s.consentGiven,
    templateContentHash: s.templateContentHash,
    dataHash: s.dataHash,
    authMethod: s.authMethod,
    ip: s.ip,
    userAgent: s.userAgent,
    signedAt: s.signedAt,
  };
}

export function computeIntegrity(ctx: Pick<RequestContext, "req" | "version" | "signatures">) {
  return integrityHash({
    requestId: ctx.req.id,
    subjectPersonId: ctx.req.subjectPersonId,
    templateContentHash: ctx.version.contentHash,
    data: ctx.req.submittedData ?? {},
    signatures: ctx.signatures.map(evidenceOf),
  });
}

export function describeAuthMethod(m: string): string {
  if (m.startsWith("in_person_staff_witnessed")) {
    const witness = /witness=(.*)$/.exec(m)?.[1];
    return `In person at Teamwork, witnessed by staff${witness ? ` ${witness}` : ""}`;
  }
  if (m === "session_password_mfa") return "Signed-in account (password + MFA)";
  if (m === "session_password") return "Signed-in account session";
  return m;
}

export async function buildPdf(ctx: RequestContext, completedAt: Date, integrity: string) {
  const fields = ctx.version.fields ?? [];
  const values: Record<string, string> = {};
  for (const f of fields) values[f.key] = displayValue(f, ctx.req.submittedData?.[f.key]);
  return renderCompletedFormPdf({
    orgName: ctx.org?.name ?? "Teamwork",
    timezone: ctx.org?.timezone ?? "America/Indiana/Indianapolis",
    requestId: ctx.req.id,
    templateName: ctx.template.name,
    title: ctx.version.title,
    version: ctx.version.version,
    contentHash: ctx.version.contentHash,
    isSampleText: ctx.version.isSampleText,
    bodyMarkdown: ctx.version.bodyMarkdown,
    subjectName: `${ctx.subject.firstName} ${ctx.subject.lastName}`,
    fields: fields.map((f) => ({ key: f.key, label: f.label })),
    values,
    signatures: ctx.signatures.map((s) => ({
      roleLabel: SIGNER_ROLE_LABEL[s.signerRole as SignerRole] ?? s.signerRole,
      signerName: s.signerName,
      relationship: s.relationship,
      typedName: s.typedName,
      consentText: s.consentText,
      signedAt: s.signedAt,
      ip: s.ip,
      userAgent: s.userAgent,
      authMethod: describeAuthMethod(s.authMethod),
    })),
    completedAt,
    integrityHash: integrity,
  });
}

/**
 * Seal a fully signed request: integrity hash, PDF (stored via saveObject as
 * completed_form_pdf / subject_and_guardians), expiry from the renewal period.
 * Must be called inside the signing transaction with the request row locked.
 */
export async function completeRequest(tx: Tx, ctx: RequestContext, actorUserId: string | null, completedAt = new Date()) {
  const integrity = computeIntegrity(ctx);
  const bytes = await buildPdf(ctx, completedAt, integrity);
  // Imported lazily so non-Next callers (seed scripts) can load this module.
  const { saveObject } = await import("@/lib/storage");
  const safeTitle = ctx.version.title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "form";
  const obj = await saveObject(tx, {
    orgId: ctx.req.orgId,
    bytes,
    filename: `${safeTitle}-v${ctx.version.version}-${ctx.subject.lastName}-${ctx.req.id.slice(0, 8)}.pdf`,
    mimeType: "application/pdf",
    kind: "completed_form_pdf",
    ownerPersonId: ctx.req.subjectPersonId,
    accessLevel: "subject_and_guardians",
    uploadedBy: actorUserId,
  });
  const expiresAt = ctx.template.renewalMonths ? addMonths(completedAt, ctx.template.renewalMonths) : null;
  await tx
    .update(formRequests)
    .set({ status: "completed", completedAt, expiresAt, integrityHash: integrity, completedPdfObjectId: obj.id })
    .where(eq(formRequests.id, ctx.req.id));
  await formEvent(tx, ctx.req.id, "completed", actorUserId, {
    from: ctx.req.status,
    integrityHash: integrity,
    pdfObjectId: obj.id,
    pdfSha256: obj.sha256,
    expiresAt: expiresAt?.toISOString() ?? null,
  });
  return { integrity, pdfObjectId: obj.id, pdfSha256: obj.sha256, expiresAt };
}
