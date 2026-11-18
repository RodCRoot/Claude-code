import { createHash } from "node:crypto";
import type { FormField, SignerRequirement } from "@/db/schema";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, `undefined`
 * members dropped. Two semantically identical values always serialize to the
 * same string, so their hashes are comparable across time and processes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = normalize(val);
    }
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export type VersionContent = {
  title: string;
  bodyMarkdown: string;
  fields: FormField[];
  signers: SignerRequirement[];
};

/** SHA-256 over the canonical JSON of exactly what a signer is shown and asked to sign. */
export function contentHash(v: VersionContent): string {
  return sha256Hex(
    canonicalJson({
      schema: "teamwork.form-version.v1",
      title: v.title,
      body: v.bodyMarkdown,
      fields: v.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options ?? [] })),
      signers: v.signers.map((s) => ({ role: s.role, required: s.required })),
    }),
  );
}

/** Hash of submitted field values (the data every signer signs over). */
export function dataHash(data: Record<string, unknown> | null | undefined): string {
  return sha256Hex(canonicalJson({ schema: "teamwork.form-data.v1", data: data ?? {} }));
}

export type SignatureEvidence = {
  signerRole: string;
  signerPersonId: string;
  signerUserId: string | null;
  relationship: string | null;
  typedName: string;
  consentText: string;
  consentGiven: boolean;
  templateContentHash: string;
  dataHash: string;
  authMethod: string;
  ip: string | null;
  userAgent: string | null;
  signedAt: Date;
};

/**
 * Integrity hash for a completed request: version content hash + submitted data +
 * every signature's evidence (ordered by role so the result is order-independent).
 */
export function integrityHash(input: {
  requestId: string;
  subjectPersonId: string;
  templateContentHash: string;
  data: Record<string, unknown> | null;
  signatures: SignatureEvidence[];
}): string {
  const sigs = [...input.signatures]
    .sort((a, b) => a.signerRole.localeCompare(b.signerRole))
    .map((s) => ({
      role: s.signerRole,
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
      signedAt: s.signedAt.toISOString(),
    }));
  return sha256Hex(
    canonicalJson({
      schema: "teamwork.form-integrity.v1",
      requestId: input.requestId,
      subjectPersonId: input.subjectPersonId,
      templateContentHash: input.templateContentHash,
      dataHash: dataHash(input.data),
      signatures: sigs,
    }),
  );
}
