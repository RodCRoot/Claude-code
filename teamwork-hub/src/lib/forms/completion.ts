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

/** Parse `auth_method` evidence: `<method>; key=value; …` (see signing.ts resolveIdentity). */
export function parseAuthMethod(m: string): { method: string; params: Record<string, string> } {
  const [method, ...rest] = m.split(";").map((s) => s.trim());
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i)] = p.slice(i + 1);
  }
  return { method, params };
}

const SESSION_LABEL: Record<string, string> = {
  session_password_mfa: "Signed-in account (password + MFA)",
  session_password: "Signed-in account session",
};

/** Human-readable identity evidence; the raw `auth_method` value is always shown alongside it. */
export function describeAuthMethod(m: string): string {
  const { method, params } = parseAuthMethod(m);
  if (method === "staff_witnessed_in_person") {
    return `In person at Teamwork; staff witness ${params.witness ?? "(unknown)"} attested the signer's identity`;
  }
  if (method === "in_person_staff_witnessed") {
    // Legacy (before identity step-up): witnessed, identity attestation not recorded.
    return `In person at Teamwork, witnessed by staff${params.witness ? ` ${params.witness}` : ""}`;
  }
  const session = SESSION_LABEL[method] ?? method;
  if (params.step_up === "email_otp") return `${session} + one-time code sent to the signer's email on file`;
  if (params.step_up === "session_mfa") return `${session}; identity step-up satisfied by MFA this session`;
  return session;
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
      authMethodLabel: describeAuthMethod(s.authMethod),
      authMethod: s.authMethod,
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
